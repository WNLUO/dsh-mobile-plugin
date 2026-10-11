'use strict';

/**
 * 移动端「Agent 预设管理」（只读查看 / 复制 / 删除）的透传契约。
 *
 * 桌面端 dsh-client-ui-agent-preset 的第 4 个表层是设置页里的管理分区：名单卡片、
 * 随附预设的只读查看器、复制对话框（桌面端**唯一**的创建入口）、以及删除确认。
 * 手机此前只有「即将开跑的这个会话用哪一档」，读不到预设正文也造不出自定义预设。
 *
 * 这条链路每一条都容易写错：
 *
 *  1. 走的是宿主 apiProxy 的 agentPreset 域，不是 Typert Remote——调用形状与
 *     sessions.js 的 callAgentPresets 一致：`{ rpcId, method: 'agentPreset.<x>', payload }`，
 *     回执是 `{ result: { ok, value } }` 信封（与 messageFeedback / references 那两条
 *     完全不同的形状，那两个回的是 decode 后的业务结果本体）；
 *  2. copy 的字段是 `{ from, agentPreset, name? }`——源头叫 from、新 id 叫 agentPreset，
 *     写反了宿主会当成「从新 id 复制到旧 id」；
 *  3. 重名不是单独的码：宿主的 PresetExistsError 与 InvalidPresetIdError 都映射成
 *     `agent-preset-invalid`，所以客户端不能靠码区分「名字被占了」与「标识非法」，
 *     只能把两种可能一起说；
 *  4. 随附预设删不掉：宿主回 `agent-preset-read-only`（403），不是 400/404；
 *  5. 本地能拒的先拒（空标识、非法标识、超长、缺 from），别拿明知会被拒的请求去打扰宿主；
 *  6. 宿主的失败对象只有 code + details，没有给用户看的 message，中文按 code 说，
 *     原文留在 details.hostMessage 里备查。
 *
 * 本测试驱动真实的 handler（不是转写实现）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Readable } = require('node:stream');
const { readWiring } = require('./lib/wiring.cjs')

const {
  handleAgentPresetRead,
  handleAgentPresetCopy,
  handleAgentPresetRemove,
  normalizeId,
  normalizeName,
  normalizeRead,
  failure,
  unwrap,
  statusOf,
  presetMessage,
  PRESET_ID_MAX_CHARS,
  PRESET_NAME_MAX_CHARS,
  PRESET_BODY_MAX_CHARS,
} = require('../lib/mobile/agent-presets.js');

const ROOT = path.join(__dirname, '..');
const readSource = (relative) => {
  try { return fs.readFileSync(path.join(ROOT, relative), 'utf8'); } catch { return ''; }
};

// ---------------------------------------------------------------------------
// 假宿主：复刻 apiProxy.agentPresets[method]({ rpcId, method, payload })
// ---------------------------------------------------------------------------

function makeCtx(impl = {}) {
  const calls = [];
  const agentPresets = {};
  for (const method of ['list', 'select', 'read', 'copy', 'remove']) {
    agentPresets[method] = async (envelope) => {
      calls.push({ method, envelope });
      const fn = impl[method];
      if (!fn) return { result: { ok: true, value: {} } };
      const out = fn(envelope);
      // 直接给信封（用来造失败回执），否则当成成功值包进信封
      if (out && typeof out === 'object' && out.result) return out;
      return { result: { ok: true, value: out } };
    };
  }
  return { calls, apiProxy: { agentPresets } };
}

function makeReq(url, body) {
  const raw = body === undefined ? '{}' : JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw)]);
  req.headers = {};
  req.url = url;
  return req;
}

function makeRes() {
  const res = { status: null, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = JSON.parse(payload); };
  return res;
}

async function call(handler, ctx, body) {
  const res = makeRes();
  await handler(ctx, makeReq('/api/mobile/v1/x', body), res);
  assert.notEqual(res.status, null, 'handler 必须写回响应');
  return res;
}

const fail = (code, details, message) => () => ({
  result: { ok: false, error: { code, ...(message ? { message } : {}), ...(details ? { details } : {}) } },
});

// ---------------------------------------------------------------------------
// 1. 标识与名称的本地收窄
// ---------------------------------------------------------------------------

test('normalizeId 认宿主那条 [a-z0-9][a-z0-9-]* 的规则', () => {
  assert.deepEqual(normalizeId('my-preset'), { value: 'my-preset' });
  assert.deepEqual(normalizeId('  my-preset  '), { value: 'my-preset' });
  assert.deepEqual(normalizeId('a'), { value: 'a' });
  assert.deepEqual(normalizeId('p2-3'), { value: 'p2-3' });
  // 本地就能判死的：空、非字符串、大写、下划线、点、前导连字符、超长
  assert.match(normalizeId(undefined).problem, /需要预设标识/);
  assert.match(normalizeId('   ').problem, /需要预设标识/);
  assert.match(normalizeId(7).problem, /需要预设标识/);
  assert.match(normalizeId('My-Preset').problem, /小写字母、数字和连字符/);
  assert.match(normalizeId('my_preset').problem, /小写字母、数字和连字符/);
  assert.match(normalizeId('my.preset').problem, /小写字母、数字和连字符/);
  assert.match(normalizeId('-lead').problem, /小写字母、数字和连字符/);
  assert.match(normalizeId('a'.repeat(PRESET_ID_MAX_CHARS + 1)).problem, /最长/);
});

test('normalizeName 可缺省、去空白、超长本地拒绝', () => {
  assert.deepEqual(normalizeName(undefined), { value: undefined });
  assert.deepEqual(normalizeName(null), { value: undefined });
  assert.deepEqual(normalizeName(''), { value: undefined });
  assert.deepEqual(normalizeName('   '), { value: undefined });
  assert.deepEqual(normalizeName(42), { value: undefined });
  assert.deepEqual(normalizeName('  我的预设  '), { value: '我的预设' });
  assert.match(normalizeName('x'.repeat(PRESET_NAME_MAX_CHARS + 1)).problem, /名称最长/);
});

test('normalizeRead 缺字段按缺处理，正文超长截断', () => {
  const full = normalizeRead(
    { agentPreset: 'standard', trust: 'system', content: 'a: 1\n', name: '标准模式', description: '内置' },
    'fallback',
  );
  assert.deepEqual(full, { agentPreset: 'standard', trust: 'system', content: 'a: 1\n', name: '标准模式', description: '内置' });
  // 宿主没回 id 时用请求里的那个；正文缺失是空串而不是缺字段
  assert.deepEqual(normalizeRead({ content: '' }, 'probe'), { agentPreset: 'probe', trust: 'system', content: '' });
  assert.deepEqual(normalizeRead(null, 'probe'), { agentPreset: 'probe', trust: 'system', content: '' });
  // trust 只认 user，别的一律当随附（删除按钮据此置灰）
  assert.equal(normalizeRead({ trust: 'user' }, 'p').trust, 'user');
  assert.equal(normalizeRead({ trust: 'system' }, 'p').trust, 'system');
  assert.equal(normalizeRead({ trust: 'yes' }, 'p').trust, 'system');
  const huge = normalizeRead({ content: 'x'.repeat(PRESET_BODY_MAX_CHARS + 10) }, 'p');
  assert.equal(huge.content.length, PRESET_BODY_MAX_CHARS);
});

// ---------------------------------------------------------------------------
// 2. 只读查看：走 agentPreset.read
// ---------------------------------------------------------------------------

test('read 用 agentPreset.read + { agentPreset } 调 apiProxy', async () => {
  const ctx = makeCtx({
    read: () => ({ agentPreset: 'standard', trust: 'system', content: 'name: 标准\n', name: '标准模式' }),
  });
  const res = await call(handleAgentPresetRead, ctx, { agentPreset: 'standard' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, agentPreset: 'standard', trust: 'system', content: 'name: 标准\n', name: '标准模式' });
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].method, 'read');
  // 三跳信封：rpcId 固定 mobile，method 带 agentPreset. 前缀，payload 是宿主请求体
  assert.deepEqual(ctx.calls[0].envelope, { rpcId: 'mobile', method: 'agentPreset.read', payload: { agentPreset: 'standard' } });
});

test('read 未知预设 → 404，保留 available 名单与宿主原文', async () => {
  const ctx = makeCtx({
    read: fail('agent-preset-not-found', { agentPreset: 'nope', available: ['standard'] }, 'unknown preset "nope"'),
  });
  const res = await call(handleAgentPresetRead, ctx, { agentPreset: 'nope' });
  assert.equal(res.status, 404);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, 'agent-preset-not-found');
  assert.equal(res.body.error.message, '这台宿主没有这个 Agent 预设');
  assert.deepEqual(res.body.error.details.available, ['standard']);
  assert.equal(res.body.error.details.hostMessage, 'unknown preset "nope"');
});

test('read 标识非法时本地 400，不打扰宿主', async () => {
  const ctx = makeCtx();
  const res = await call(handleAgentPresetRead, ctx, { agentPreset: 'Bad Id' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'bad-request');
  assert.match(res.body.error.message, /小写字母、数字和连字符/);
  assert.equal(ctx.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 3. 复制：桌面端唯一的创建入口
// ---------------------------------------------------------------------------

test('copy 用 { from, agentPreset, name? } 调 agentPreset.copy', async () => {
  const ctx = makeCtx({ copy: (envelope) => ({ agentPreset: envelope.payload.agentPreset }) });
  const res = await call(handleAgentPresetCopy, ctx, { from: 'standard', agentPreset: 'my-agent', name: '我的预设' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, agentPreset: 'my-agent' });
  assert.deepEqual(ctx.calls[0].envelope, {
    rpcId: 'mobile',
    method: 'agentPreset.copy',
    payload: { from: 'standard', agentPreset: 'my-agent', name: '我的预设' },
  });
});

test('copy 没给名字时不下发 name 字段，宿主的 id 也认（回执里的 agentPreset 优先）', async () => {
  const ctx = makeCtx({ copy: () => ({ agentPreset: 'host-chosen' }) });
  const res = await call(handleAgentPresetCopy, ctx, { from: 'cordis', agentPreset: 'new-one' });
  assert.deepEqual(ctx.calls[0].envelope.payload, { from: 'cordis', agentPreset: 'new-one' });
  assert.equal(res.body.agentPreset, 'host-chosen');
});

test('copy 重名 → 宿主回 agent-preset-invalid（400），文案把两种可能一起说', async () => {
  const ctx = makeCtx({ copy: fail('agent-preset-invalid', { agentPreset: 'taken', reason: 'preset "taken" already exists' }) });
  const res = await call(handleAgentPresetCopy, ctx, { from: 'standard', agentPreset: 'taken' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'agent-preset-invalid');
  assert.equal(res.body.error.message, '预设标识不合法，或者这个标识已经被占用');
  assert.equal(res.body.error.details.reason, 'preset "taken" already exists');
});

test('copy 缺 from 时本地 400，不打扰宿主', async () => {
  const ctx = makeCtx();
  const res = await call(handleAgentPresetCopy, ctx, { agentPreset: 'my-agent' });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /from/);
  assert.equal(ctx.calls.length, 0);
});

test('copy 的新标识非法时本地 400', async () => {
  const ctx = makeCtx();
  const res = await call(handleAgentPresetCopy, ctx, { from: 'standard', agentPreset: '-bad' });
  assert.equal(res.status, 400);
  assert.equal(ctx.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 4. 删除：只对 user 预设有效
// ---------------------------------------------------------------------------

test('remove 成功回 { ok, agentPreset }', async () => {
  const ctx = makeCtx({ remove: () => ({}) });
  const res = await call(handleAgentPresetRemove, ctx, { agentPreset: 'my-agent' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, agentPreset: 'my-agent' });
  assert.deepEqual(ctx.calls[0].envelope, { rpcId: 'mobile', method: 'agentPreset.remove', payload: { agentPreset: 'my-agent' } });
});

test('remove 随附预设 → agent-preset-read-only 是 403，不是 400/404', async () => {
  const ctx = makeCtx({ remove: fail('agent-preset-read-only', { agentPreset: 'standard', reason: 'shipped preset' }) });
  const res = await call(handleAgentPresetRemove, ctx, { agentPreset: 'standard' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'agent-preset-read-only');
  assert.equal(res.body.error.message, '随附预设是安装目录的一部分，不能删除');
  assert.equal(res.body.error.details.reason, 'shipped preset');
});

test('remove 未知预设 → 404', async () => {
  const ctx = makeCtx({ remove: fail('agent-preset-not-found', { available: [] }) });
  const res = await call(handleAgentPresetRemove, ctx, { agentPreset: 'ghost' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.message, '这台宿主没有这个 Agent 预设');
});

// ---------------------------------------------------------------------------
// 5. 码表与信封
// ---------------------------------------------------------------------------

test('statusOf：not-found 404 / read-only 403 / locked 409 / 其余 400', () => {
  assert.equal(statusOf('agent-preset-not-found'), 404);
  assert.equal(statusOf('agent-preset-read-only'), 403);
  assert.equal(statusOf('agent-preset-locked'), 409);
  assert.equal(statusOf('agent-preset-invalid'), 400);
  assert.equal(statusOf(undefined), 400);
  assert.equal(statusOf('something-new'), 400);
});

test('presetMessage 认识的码说中文，没见过的码退回宿主原文', () => {
  assert.equal(presetMessage('agent-preset-locked'), '会话已经开跑，Agent 预设固定为开始时的那一档');
  assert.equal(presetMessage('bad-request'), 'Agent 预设请求不合法');
  assert.equal(presetMessage('weird-code', { message: 'host says no' }), 'host says no');
  assert.equal(presetMessage('weird-code', {}), 'Agent 预设请求失败');
  assert.equal(presetMessage(undefined, null), 'Agent 预设请求失败');
});

test('failure 把 code 与 details 原样带出，宿主原文收进 hostMessage', () => {
  const out = failure({ code: 'agent-preset-invalid', message: 'boom', details: { reason: 'r' } });
  assert.equal(out.code, 'agent-preset-invalid');
  assert.equal(out.details.reason, 'r');
  assert.equal(out.details.hostMessage, 'boom');
  // 没有 details 也没有 message 时不编造空的 details
  const bare = failure({ code: 'internal' });
  assert.deepEqual(bare, { code: 'internal', message: 'Agent 预设请求失败' });
});

test('unwrap：空响应与 ok:false 都变成 error', () => {
  assert.deepEqual(unwrap(null).error.code, 'internal');
  assert.deepEqual(unwrap({}).error.code, 'internal');
  assert.deepEqual(unwrap({ result: { ok: true, value: { a: 1 } } }).value, { a: 1 });
  assert.equal(unwrap({ result: { ok: false, error: { code: 'x' } } }).error.code, 'x');
  // 宿主没给 error 对象也不能让 error 变 undefined
  assert.equal(unwrap({ result: { ok: false } }).error.code, 'unknown');
});

// ---------------------------------------------------------------------------
// 6. 源码契约：路由挂上去了，且走的是 apiProxy 的 agentPreset 域
// ---------------------------------------------------------------------------

test('index.js 挂了三条例路由并 require 了新模块', () => {
  const src = readWiring();
  assert.match(src, /require\('(?:\.\.\/mobile|\.\/mobile)\/agent-presets\.js'\)/);
  assert.match(src, /route\('\/api\/mobile\/v1\/agent-presets\/read', agentPresets\.handleAgentPresetRead\)/);
  assert.match(src, /route\('\/api\/mobile\/v1\/agent-presets\/copy', agentPresets\.handleAgentPresetCopy\)/);
  assert.match(src, /route\('\/api\/mobile\/v1\/agent-presets\/remove', agentPresets\.handleAgentPresetRemove\)/);
  // 名单本身仍由 sessions.js 那条老路由提供，别被顶掉
  assert.match(src, /route\('\/api\/mobile\/v1\/agent-presets', sessions\.handleAgentPresets\)/);
});

test('agent-presets.js 走 apiProxy 的 agentPreset 域，不碰 typertGateway', () => {
  const src = readSource('lib/mobile/agent-presets.js');
  // 调用形状的实现已收敛到 lib/mobile/rpc.js 的 callAgentPresets（此前 sessions.js 与
  // agent-presets.js 各有一份逐字相同的副本）。这里守的是「这一族请求走 apiProxy 的
  // agentPreset 域」这条契约，所以两边都得读；只读 agent-presets.js 会在实现搬家的
  // 那天红，而红的原因跟契约无关。
  const rpc = readSource('lib/mobile/rpc.js');
  assert.match(src, /require\('\.\/rpc\.js'\)/);
  assert.match(src, /callAgentPresets\(/);
  assert.match(rpc, /ctx\.apiProxy\.agentPresets\[method\]/);
  assert.match(rpc, /`agentPreset\.\$\{method\}`/);
  assert.equal(rpc.includes("ctx.get('typertGateway')"), false);
  assert.equal(src.includes("ctx.get('typertGateway')"), false);
  // openDocument 刻意不做：它打开的是宿主机器上的目录，手机点了也看不见
  assert.equal(/agentPreset\.openDocument/.test(src + rpc), false);
  assert.equal(/['"]opendocument['"]/i.test(src + rpc), false);
});

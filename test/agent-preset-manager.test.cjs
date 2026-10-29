'use strict';

/**
 * 移动端「Agent 预设管理」（只读查看 / 复制 / 删除）的透传契约。
 *
 * 手机此前只有「即将开跑的这个会话用哪一档」，读不到预设正文也造不出自定义预设。这条链路
 * 走宿主 apiProxy 的 agentPreset 域（`{ rpcId, method, payload }` → `{ result: { ok, value } }`
 * 信封），不是 Typert Remote。
 *
 * 几条容易写错的地方：copy 的字段是 `{ from, agentPreset, name? }`，写反会变成「从新 id
 * 复制到旧 id」；重名与非法标识共用 `agent-preset-invalid`，客户端要两种可能一起说；随附
 * 预设删不掉（`agent-preset-read-only`，403）；本地能拒的先拒，别拿明知会被拒的请求去打扰宿主。
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
  handleAgentPresetDefault,
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
  const settingsCalls = [];
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
  // 「设为默认」写的是宿主 settings（不是预设自己的属性），单独记一份调用流水。
  const settings = {
    mutate: async (envelope) => {
      settingsCalls.push(envelope);
      const fn = impl.mutate;
      if (!fn) return { result: { ok: true, value: { ns: envelope.payload.ns } } };
      const out = fn(envelope);
      if (out && typeof out === 'object' && out.result) return out;
      return { result: { ok: true, value: out } };
    },
  };
  return { calls, settingsCalls, apiProxy: { agentPresets, settings } };
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
// 4b. 设为默认：写宿主 settings 的 agent-preset-registry.selectedDefault
// ---------------------------------------------------------------------------

test('default 先按名单确认这一档在，再写 settings 那一格', async () => {
  const ctx = makeCtx({ list: () => ({ presets: [{ id: 'standard' }, { id: 'my-agent' }] }) });
  const res = await call(handleAgentPresetDefault, ctx, { agentPreset: 'my-agent' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, agentPreset: 'my-agent' });
  assert.deepEqual(ctx.settingsCalls[0].payload, {
    ns: 'agent-preset-registry',
    ops: [{ op: 'set', path: ['selectedDefault'], value: 'my-agent' }],
  });
});

test('default 已经默认时不再写（省一次 revision 推进）', async () => {
  const ctx = makeCtx({ list: () => ({ presets: [{ id: 'standard', isDefault: true }] }) });
  const res = await call(handleAgentPresetDefault, ctx, { agentPreset: 'standard' });
  assert.equal(res.status, 200);
  assert.equal(ctx.settingsCalls.length, 0);
});

test('default 名单里没有这一档 → 404，一个字都不写', async () => {
  const ctx = makeCtx({ list: () => ({ presets: [{ id: 'standard' }] }) });
  const res = await call(handleAgentPresetDefault, ctx, { agentPreset: 'ghost' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'agent-preset-not-found');
  assert.deepEqual(res.body.error.details.available, ['standard']);
  assert.equal(ctx.settingsCalls.length, 0);
});

test('default 设置写不进去时把宿主原文带出来', async () => {
  const ctx = makeCtx({
    list: () => ({ presets: [{ id: 'standard' }] }),
    mutate: () => ({ result: { ok: false, error: { code: 'settings/conflict', message: 'revision mismatch' } } }),
  });
  const res = await call(handleAgentPresetDefault, ctx, { agentPreset: 'standard' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'settings/conflict');
  assert.match(res.body.error.message, /默认预设没写进去.*revision mismatch/);
});

test('default 标识非法时本地 400，名单都不读', async () => {
  const ctx = makeCtx();
  const res = await call(handleAgentPresetDefault, ctx, { agentPreset: 'Bad Id' });
  assert.equal(res.status, 400);
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.settingsCalls.length, 0);
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

test('index.js 挂了四条路由并 require 了新模块', () => {
  const src = readWiring();
  assert.match(src, /require\('(?:\.\.\/mobile|\.\/mobile)\/agent-presets\.js'\)/);
  assert.match(src, /route\('\/api\/mobile\/v1\/agent-presets\/read', agentPresets\.handleAgentPresetRead\)/);
  assert.match(src, /route\('\/api\/mobile\/v1\/agent-presets\/copy', agentPresets\.handleAgentPresetCopy\)/);
  assert.match(src, /route\('\/api\/mobile\/v1\/agent-presets\/remove', agentPresets\.handleAgentPresetRemove\)/);
  assert.match(src, /route\('\/api\/mobile\/v1\/agent-presets\/default', agentPresets\.handleAgentPresetDefault\)/);
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

'use strict';

/**
 * 过程播报（`lib/mobile/narration.js`）：开关落盘 + 递话判据 + 钩子接线。
 *
 * 这条功能的坏法都很安静：开关读成开（默认必须关，它会往用户对话里塞消息、花 token）、
 * 每一步都开口（一句 90 秒、一轮最多三句）、把提醒造错了来源（`kind: 'user'` 会让它在
 * 手机上冒充成用户自己发的气泡），或者干脆没挂上钩子（界面上开关能拨，但模型一声不吭）。
 * 所以这里两头都钉：纯判据真跑一遍，钩子用假 payload 真调一次。
 *
 * 不钉正文措辞 —— 那句话要跟着用户口味改。钉的是「什么时候说、说几次、说的是什么来源」。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-narration-'));
// 门槛压到 1ms、间隔压到 1ms：要验的是「什么时候说」，不是等 90 秒。必须在 require 之前设。
process.env.DSH_MOBILE_NARRATION_FIRST_MS = '1';
process.env.DSH_MOBILE_NARRATION_INTERVAL_MS = '1';

const {
  installNarration,
  narrationEnabled,
  setNarration,
  narrationDecision,
  handleNarration,
  NARRATION_FIRST_MS,
  NARRATION_INTERVAL_MS,
  NARRATION_MAX_PER_TURN,
  NARRATION_SOURCE_KIND,
} = require('../lib/mobile/narration.js');
const { readRouteTable } = require('./lib/wiring.cjs');

const API_BASE = '/api/mobile/v1';

/** 假 res：只记状态与正文。 */
function fakeRes() {
  const res = { status: 0, raw: '' };
  res.writeHead = (status) => { res.status = status; };
  res.setHeader = () => {};
  res.write = () => true;
  res.end = (chunk) => { res.raw = String(chunk == null ? '' : chunk); };
  res.on = () => res;
  return res;
}

/** 假 req：`body` 给 undefined 表示 GET。 */
function fakeReq(body) {
  const req = {
    method: body === undefined ? 'GET' : 'POST',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  };
  req.on = (event, listener) => {
    if (event === 'data' && body !== undefined) {
      setImmediate(() => listener(Buffer.from(JSON.stringify(body))));
    }
    if (event === 'end') setImmediate(listener);
    return req;
  };
  req.once = req.on;
  req.removeListener = () => req;
  return req;
}

/** 造一个宿主形状的 agent（钩子只读 `session.header`）。 */
function fakeAgent({ id = 'session-narration', origin = null } = {}) {
  return { session: { header: { id, origin } } };
}

test('默认关：设置文件还没写时读出来是关', () => {
  assert.equal(narrationEnabled(), false);
});

test('写进去之后读得出来，关回去也读得出来', () => {
  assert.equal(setNarration(true), true);
  assert.equal(narrationEnabled(), true);
  assert.equal(setNarration(false), false);
  assert.equal(narrationEnabled(), false);
});

test('文件读坏 / 形状不对一律当关', () => {
  const file = require('../lib/mobile/narration.js').settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  assert.equal(narrationEnabled(), false);
  fs.writeFileSync(file, JSON.stringify({ enabled: 'yes' }));
  assert.equal(narrationEnabled(), false);
  setNarration(false);
});

test('判据：不到第一道门槛不说', () => {
  assert.equal(narrationDecision({ elapsedMs: NARRATION_FIRST_MS - 1, said: 0, sinceLastMs: Infinity }), false);
});

test('判据：过了门槛、还没说过，就说', () => {
  assert.equal(narrationDecision({ elapsedMs: NARRATION_FIRST_MS, said: 0, sinceLastMs: Infinity }), true);
});

test('判据：说过之后要等够间隔', () => {
  assert.equal(narrationDecision({ elapsedMs: NARRATION_FIRST_MS * 4, said: 1, sinceLastMs: NARRATION_INTERVAL_MS - 1 }), false);
  assert.equal(narrationDecision({ elapsedMs: NARRATION_FIRST_MS * 4, said: 1, sinceLastMs: NARRATION_INTERVAL_MS }), true);
});

test('判据：一轮有上限，说满了就闭嘴', () => {
  assert.equal(
    narrationDecision({ elapsedMs: NARRATION_FIRST_MS * 20, said: NARRATION_MAX_PER_TURN, sinceLastMs: NARRATION_INTERVAL_MS * 10 }),
    false,
  );
});

test('这条路由挂上了（读与写同一条路径）', () => {
  const table = readRouteTable();
  assert.ok(
    table.includes(`route('/api/mobile/v1/narration', narration.handleNarration)`),
    '没注册 /api/mobile/v1/narration',
  );
  // 两条都要经 `route()`：那里裹着 guarded（鉴权边界），裸挂会被 mobile-routes 判红。
  assert.ok(table.includes(`const narration = require('../mobile/narration.js')`), '路由表没引入 narration 模块');
});

test('GET 回当前值，POST 拨开关，非布尔回 400', async () => {
  setNarration(true);
  let res = fakeRes();
  await handleNarration({}, fakeReq(undefined), res);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.raw).enabled, true);

  res = fakeRes();
  await handleNarration({}, fakeReq({ enabled: false }), res);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.raw).enabled, false);
  assert.equal(narrationEnabled(), false);

  res = fakeRes();
  await handleNarration({}, fakeReq({ enabled: 'yes' }), res);
  assert.equal(res.status, 400);
});

test('钩子：开关关着一个字都不加', async () => {
  setNarration(false);
  let handler = null;
  const dispose = installNarration({ on: (event, fn) => { if (event === 'agent/pre-step') handler = fn; return () => {}; } });
  assert.equal(typeof handler, 'function');
  assert.equal(typeof dispose, 'function');

  const messages = [{ id: 'user-1' }];
  const decision = await handler(
    { agent: fakeAgent(), turn: 1, step: 1 },
    async () => ({ kind: 'enter', messages }),
  );
  assert.equal(decision.messages.length, 1);
});

test('钩子：开关打开、跑够久就追加一条非 user 来源的提醒', async () => {
  setNarration(true);
  let handler = null;
  installNarration({ on: (event, fn) => { if (event === 'agent/pre-step') handler = fn; return () => {}; } });

  const messages = [{ id: 'user-2' }];
  const agent = fakeAgent({ id: 'session-narration-open' });
  const payload = { agent, turn: 7, step: 1 };

  // 第一次调用只记账（这一轮从此刻起算），不该开口。
  let decision = await handler(payload, async () => ({ kind: 'enter', messages }));
  assert.equal(decision.messages.length, 1, '刚开轮不该开口');

  // 门槛压到 1ms：等一下就过了。
  await new Promise((resolve) => setTimeout(resolve, 15));
  decision = await handler(payload, async () => ({ kind: 'enter', messages }));
  assert.equal(decision.messages.length, 2, '过了门槛应该多一句');
  const hint = decision.messages[1];
  assert.notEqual(hint.source.kind, 'user', '来源不能是 user，否则手机上会冒充成用户气泡');
  assert.equal(hint.role, 'user', '宿主契约里这一条替换的必须是 user 消息');
  assert.ok(String(hint.content?.[0]?.text ?? '').includes('进度'), '提醒正文要说清这是进度提醒');

  // 同一轮再说一句 → 超过上限后闭嘴。上限是 3。
  await new Promise((resolve) => setTimeout(resolve, 15));
  decision = await handler(payload, async () => ({ kind: 'enter', messages }));
  assert.equal(decision.messages.length, 2);
  await new Promise((resolve) => setTimeout(resolve, 15));
  decision = await handler(payload, async () => ({ kind: 'enter', messages }));
  assert.equal(decision.messages.length, 2);
  await new Promise((resolve) => setTimeout(resolve, 15));
  decision = await handler(payload, async () => ({ kind: 'enter', messages }));
  assert.equal(decision.messages.length, 1, '一轮说满三句之后不再开口');

  setNarration(false);
});

test('钩子：子代理会话直接跳过', async () => {
  setNarration(true);
  let handler = null;
  installNarration({ on: (event, fn) => { if (event === 'agent/pre-step') handler = fn; return () => {}; } });
  const messages = [{ id: 'user-3' }];
  const decision = await handler(
    { agent: fakeAgent({ id: 'child-1', origin: 'subagent' }), turn: 1, step: 1 },
    async () => ({ kind: 'enter', messages }),
  );
  assert.equal(decision.messages.length, 1);
  setNarration(false);
});

test('钩子：next() 拒收那一档原样放行（没有 messages 可追加）', async () => {
  setNarration(true);
  let handler = null;
  installNarration({ on: (event, fn) => { if (event === 'agent/pre-step') handler = fn; return () => {}; } });
  const decision = await handler(
    { agent: fakeAgent(), turn: 1, step: 1 },
    async () => ({ kind: 'reject' }),
  );
  assert.equal(decision.kind, 'reject');
  setNarration(false);
});

test('提醒的来源不是 user（否则会在手机上冒充成用户气泡）', () => {
  assert.notEqual(NARRATION_SOURCE_KIND, 'user');
});

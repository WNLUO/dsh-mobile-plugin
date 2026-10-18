'use strict';

/**
 * `POST /api/mobile/v1/session/read` 的行为守卫。
 *
 * 这条路由要同时照顾两端：清掉**本设备**那份完成提醒（手机侧栏灭灯），并留一条已读
 * 回执给桌面端的客户端半边（桌面侧栏灭灯）。两份状态是分开的，所以「只清 acknowledging
 * 的设备」和「一定留下回执」是两条独立的断言，谁塌了另一个都还在。
 */

const { Readable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  handleSessionRead,
  completionStateOf,
} = require('../lib/mobile/sessions.js');
const { clearCompletionForAllDevices } = require('../lib/mobile/session-cache.js');

// handleSessionRead 除了清宿主那份完成提醒，还会往 $DSH_HOME/read-receipts.json 记一条
// 已读回执（桌面端的未读绿点只能靠它在页面里清掉）。DSH_HOME 必须在任何 handler 跑之前
// 就指到临时目录，否则测试会往真实的 ~/.dsh 里写文件。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-read-'));
process.env.DSH_HOME = home;
test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const readReceipt = require('../lib/read-receipt.cjs');

function makeReq(body, deviceHeader) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.headers = {};
  if (deviceHeader) req.headers['x-dsh-device'] = deviceHeader;
  return req;
}

function makeRes() {
  const res = { status: null, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = JSON.parse(payload); };
  return res;
}

test('session/read clears the reminder only for the acknowledging device', async () => {
  const ctx = {};
  completionStateOf(ctx, 'phone-a').set('session-1', { completed: true });
  completionStateOf(ctx, 'phone-b').set('session-1', { completed: true });
  completionStateOf(ctx, 'phone-b').set('other', { completed: true });

  const res = makeRes();
  await handleSessionRead(ctx, makeReq({ sessionId: 'session-1' }, 'phone-a'), res, 'legacy');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, accepted: true });
  // The acking device drops the reminder but keeps the watermark that stops the
  // same turn from lighting up again on the next list build...
  const acked = completionStateOf(ctx, 'phone-a').get('session-1');
  assert.ok(acked, '条目要留下：已读水位是「这一轮不再亮」的唯一凭据');
  assert.equal(acked.completed, false);
  assert.equal(typeof acked.clearedAt, 'number');
  // ...while every other device keeps its own state.
  assert.equal(completionStateOf(ctx, 'phone-b').get('session-1').completed, true);
  assert.equal(completionStateOf(ctx, 'phone-b').get('other').completed, true);
});

test('session/read falls back to the legacy scope without x-dsh-device', async () => {
  const ctx = {};
  completionStateOf(ctx, 'legacy').set('session-1', { completed: true });
  completionStateOf(ctx, 'phone-a').set('session-1', { completed: true });

  const res = makeRes();
  await handleSessionRead(ctx, makeReq({ sessionId: 'session-1' }), res, 'legacy');

  assert.equal(res.status, 200);
  assert.equal(completionStateOf(ctx, 'legacy').get('session-1').completed, false);
  assert.ok(completionStateOf(ctx, 'legacy').get('session-1').clearedAt);
  assert.equal(completionStateOf(ctx, 'phone-a').get('session-1').completed, true);
});

test('session/read rejects a missing sessionId', async () => {
  const ctx = {};
  const res = makeRes();
  await handleSessionRead(ctx, makeReq({}, 'phone-a'), res, 'legacy');
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
});

// 手机端点开会话时，桌面端的未读绿点也必须跟着灭掉 —— 而桌面那份状态在浏览器内存里，
// 宿主碰不到，只能留下一条水位等插件的客户端半边来拉。这条守卫钉住「读了就留痕」。
test('session/read records a read receipt for the desktop half to pick up', async () => {
  const ctx = {};
  const res = makeRes();
  await handleSessionRead(ctx, makeReq({ sessionId: 'session-receipt' }, 'phone-a'), res, 'legacy');
  assert.equal(res.status, 200);
  const receipt = readReceipt.snapshot();
  assert.ok(receipt, '读过之后必须留下台账');
  assert.equal(typeof receipt.readAt['session-receipt'], 'number');
  assert.ok(receipt.readAt['session-receipt'] > 0);
});

// 桌面端的客户端半边现在每读一次就报一批 id（不再只报「刚掉出去」的那一下），所以
// 「已经清过」的再报一次必须什么都不做：返回 0，调用方也就不会去抬 generation、
// 不会每 2s 触发一次清单重建与推送。
test('desktop-read 重复上报同一批 id：只有第一次算清掉了东西', () => {
  const ctx = {};
  completionStateOf(ctx, 'phone-a').set('s1', { completed: true });
  completionStateOf(ctx, 'legacy').set('s1', { failure: { turn: 1 } });
  assert.equal(clearCompletionForAllDevices(ctx, 's1'), 2);
  assert.equal(clearCompletionForAllDevices(ctx, 's1'), 0, '已经清过的再报不该算数');
  assert.equal(completionStateOf(ctx, 'phone-a').get('s1').completed, false);
  assert.equal(completionStateOf(ctx, 'legacy').get('s1').failure, undefined);
});

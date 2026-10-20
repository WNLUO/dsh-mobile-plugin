'use strict';

/**
 * 守卫：列表行下发的 `lastTurn` 必须是**设备无关**的一轮事实。
 *
 * 起因（真机）：左侧栏的绿点 / 红点在同一台手机上时好时坏。那份「未读」是宿主按设备
 * 记的提醒，而列表还要喂镜像快照 —— 快照全局一份、给所有设备读，里面按设备算的结论
 * 永远是同一台假设备的，于是点开看过也不灭，绕过镜像的那次读又立刻变干净。
 *
 * 这里钉三件事：
 *   1. 行上要带 `lastTurn`（turn / endedAt / status），而且**与设备键无关**；
 *   2. 它不受已读水位影响：`/session/read` 之后事实照旧在，只是不再算「未读提醒」；
 *   3. 同一轮重复折叠时结束时刻只前进不后退。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSessionsResponse } = require('../lib/mobile/sessions.js');
const { lastTurnOf, settleOutcome, recordLastTurn, recordSessionRead } = require('../lib/mobile/session-last-turn.js');
const { handleSessionRead } = require('../lib/mobile/sessions.js');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// handleSessionRead 会往 $DSH_HOME 写已读回执：指到临时目录，别碰真实的家目录。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-last-turn-'));
process.env.DSH_HOME = home;
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const SID = 'session-last-turn';

function makeCtx() {
  const current = { events: [], running: false, updatedAt: 0 };
  const ctx = {
    apiProxy: {
      sessions: {
        list: async () => ({
          result: {
            ok: true,
            value: {
              items: [{
                sessionId: SID, title: '会话', cwd: '/w', updatedAt: current.updatedAt,
                running: current.running, blank: false,
              }],
            },
          },
        }),
        history: async () => ({ result: { ok: true, value: { events: current.events } } }),
      },
      workspace: { list: async () => ({ result: { ok: true, value: { items: [], archivedSessionIds: [] } } }) },
    },
  };
  ctx.current = current;
  return ctx;
}

const turnStart = (turn) => ({ event: { type: 'turn/start', seq: 1, time: 10, data: { turn } } });
const assistant = (turn, seq = 2) => ({
  event: { type: 'assistant/message', seq, time: 11, data: { turn, message: { role: 'assistant', content: [{ type: 'text', text: '…' }] } } },
});
const turnEnd = (turn, reason, at = 12) => ({ event: { type: 'turn/end', seq: 3, time: at, data: { turn, reason } } });
const SUCCEEDED = [turnStart(7), assistant(7), turnEnd(7, { kind: 'completed' }, 12)];
const FAILED = [turnStart(8), assistant(8), turnEnd(8, { kind: 'error', error: { code: 'AUTH', message: '额度不足' } }, 34)];

async function step(ctx, events, { running, updatedAt }) {
  ctx.current.events = events;
  ctx.current.running = running;
  ctx.current.updatedAt = updatedAt;
  const response = await buildSessionsResponse(ctx, 'phone-a');
  assert.equal(response.status, 200);
  return response.body.items.find((item) => item.sessionId === SID);
}

function readReq(deviceHeader) {
  const req = Readable.from([Buffer.from(JSON.stringify({ sessionId: SID }))]);
  req.headers = deviceHeader ? { 'x-dsh-device': deviceHeader } : {};
  return req;
}
function makeRes() {
  const res = { status: null, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = JSON.parse(payload); };
  return res;
}

test('成功收尾：行上带 lastTurn（turn / endedAt / status）', async () => {
  const ctx = makeCtx();
  await step(ctx, SUCCEEDED, { running: true, updatedAt: 10 });
  const row = await step(ctx, SUCCEEDED, { running: false, updatedAt: 11 });
  assert.deepEqual(row.lastTurn, { turn: 7, endedAt: 12, status: 'completed' });
  assert.equal(row.completed, true, '这台设备没读过，提醒那一份照旧亮着');
});

test('失败收尾：事实里带错误码，行上同时有提醒的 lastTurnError', async () => {
  const ctx = makeCtx();
  await step(ctx, FAILED, { running: true, updatedAt: 20 });
  const row = await step(ctx, FAILED, { running: false, updatedAt: 21 });
  assert.equal(row.lastTurn.status, 'failed');
  assert.equal(row.lastTurn.code, 'AUTH');
  assert.equal(row.lastTurn.endedAt, 34);
  assert.equal(row.lastTurn.message, '额度不足');
});

test('换一台设备读同一份清单：lastTurn 一字不差（它跟谁在问无关）', async () => {
  const ctx = makeCtx();
  await step(ctx, SUCCEEDED, { running: true, updatedAt: 10 });
  await step(ctx, SUCCEEDED, { running: false, updatedAt: 11 });
  ctx.current.events = SUCCEEDED;
  const phoneA = (await buildSessionsResponse(ctx, 'phone-a')).body.items.find((i) => i.sessionId === SID);
  const phoneB = (await buildSessionsResponse(ctx, 'phone-b')).body.items.find((i) => i.sessionId === SID);
  assert.deepEqual(phoneA.lastTurn, phoneB.lastTurn);
});

test('已读之后：事实还在，只是不再算这台设备的未读提醒', async () => {
  const ctx = makeCtx();
  await step(ctx, SUCCEEDED, { running: true, updatedAt: 10 });
  const before = await step(ctx, SUCCEEDED, { running: false, updatedAt: 11 });
  assert.equal(before.completed, true);

  const res = makeRes();
  await handleSessionRead(ctx, readReq('phone-a'), res, 'legacy');
  assert.equal(res.status, 200);

  const after = await step(ctx, SUCCEEDED, { running: false, updatedAt: 11 });
  assert.equal(after.completed, false, '提醒被清掉了');
  assert.deepEqual(
    { turn: after.lastTurn.turn, endedAt: after.lastTurn.endedAt, status: after.lastTurn.status },
    { turn: before.lastTurn.turn, endedAt: before.lastTurn.endedAt, status: before.lastTurn.status },
    '事实不随已读消失 —— App 靠它自己算点',
  );
  assert.ok(after.lastTurn.readAt > 0, '这次读过还会留一条设备无关水位（另一台设备/桌面读也走这条）');
});

test('同一轮重复折叠：结束时刻只前进不后退', () => {
  const ctx = {};
  recordLastTurn(ctx, SID, { turn: 3, endedAt: 100, status: 'completed' });
  recordLastTurn(ctx, SID, { turn: 3, endedAt: 100, status: 'completed' });
  assert.equal(lastTurnOf(ctx, SID).endedAt, 100);
  recordLastTurn(ctx, SID, { turn: 3, endedAt: 90, status: 'completed' });
  assert.equal(lastTurnOf(ctx, SID).endedAt, 100, '更早的结束时刻不许把水位往回拨');
  recordLastTurn(ctx, SID, { turn: 4, endedAt: 200, status: 'canceled' });
  assert.equal(lastTurnOf(ctx, SID).turn, 4);
});

// 真机报的那一步：桌面点开对话，绿点灭了，手机上等一两分钟都不灭。原因是「读过」只落在
// 按设备的提醒里，而镜像快照给所有设备读、进不了那本账 —— 现在补一条设备无关的已读水位，
// 由 App 与它自己那份一起取较大值。
test('桌面读过：设备无关水位进清单，行上带 readAt', async () => {
  const ctx = makeCtx();
  await step(ctx, SUCCEEDED, { running: true, updatedAt: 10 });
  const before = await step(ctx, SUCCEEDED, { running: false, updatedAt: 11 });
  assert.equal(before.lastTurn.readAt, undefined, '还没人读过');

  assert.equal(recordSessionRead(ctx, SID, 900), true);
  const after = await step(ctx, SUCCEEDED, { running: false, updatedAt: 11 });
  assert.equal(after.lastTurn.readAt, 900);
  assert.deepEqual(
    { turn: after.lastTurn.turn, endedAt: after.lastTurn.endedAt, status: after.lastTurn.status },
    { turn: before.lastTurn.turn, endedAt: before.lastTurn.endedAt, status: before.lastTurn.status },
    '其余事实一个字都不该变',
  );
});

test('已读水位只前进，且重复上报返回 false（不许每次都抬列表缓存）', () => {
  const ctx = {};
  recordLastTurn(ctx, SID, { turn: 2, endedAt: 100, status: 'completed' });
  assert.equal(recordSessionRead(ctx, SID, 500), true);
  assert.equal(recordSessionRead(ctx, SID, 500), false, '同一时刻重复上报不算前进');
  assert.equal(recordSessionRead(ctx, SID, 400), false, '更早的时刻不许回拨');
  assert.equal(lastTurnOf(ctx, SID).readAt, 500);
});

test('水位不吞新事实：读过之后又跑完一轮，readAt 留着、事实照样更新', () => {
  const ctx = {};
  recordLastTurn(ctx, SID, { turn: 2, endedAt: 100, status: 'completed' });
  recordSessionRead(ctx, SID, 500);
  recordLastTurn(ctx, SID, { turn: 3, endedAt: 900, status: 'completed' });
  const fact = lastTurnOf(ctx, SID);
  assert.equal(fact.turn, 3);
  assert.equal(fact.endedAt, 900);
  assert.equal(fact.readAt, 500, '换新事实时已读水位必须原样带上，否则刚读过的一轮会重新亮');
});

test('只有一个已读水位、没有轮次事实时不下发（重启后还没折过那轮）', () => {
  const ctx = {};
  recordSessionRead(ctx, SID, 500);
  assert.equal(lastTurnOf(ctx, SID), undefined);
});

test('settleOutcome：assistant 必须是本轮已落定的那条', () => {
  const end = { seq: 5, time: 50, data: { turn: 1, reason: { kind: 'completed' } } };
  assert.equal(settleOutcome({ turn: 1, end, assistant: { seq: 4, data: {} } }).status, 'completed');
  // assistant 落在 turn/end 之后：那是下一轮的开头，不能拿它冒充已完成。
  assert.equal(settleOutcome({ turn: 1, end, assistant: { seq: 9, data: {} } }).status, 'incomplete');
  assert.equal(settleOutcome({ turn: 1, end, assistant: { seq: 4, data: { interrupted: true } } }).status, 'incomplete');
});

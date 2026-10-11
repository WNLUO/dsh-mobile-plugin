'use strict';

/**
 * 失败会话在「列表行」上的最终形状：`completed:false` + `lastTurnError`。
 *
 * 这条链路跨两个模块 —— completion.js 折出 failure，sessions.js 把它下发。单测
 * completion.js 抓不到 sessions.js 里的**时序**问题：行对象是先构造的，history 折叠
 * （也就是 failure 真正被算出来的地方）在后面的预览循环里。所以必须在同一次响应里
 * 断言两者同时到位，否则会出现「completed 已是 false、红点却还缺着」的静默间隔。
 *
 * 注意：完成态挂在 ctx 上（session-cache 的 WeakMap），所以同一条会话的多次列表请求
 * 必须复用同一个 ctx，否则每次都是冷启动、wasRunning 永远置不上位。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSessionsResponse } = require('../lib/mobile/sessions.js');

const SID = 'session-fail';

/** 造一个可反复喂快照的 ctx：list/history 读同一份 current。 */
function makeDriver() {
  const current = { events: [], running: false, updatedAt: 0 };
  const ctx = {
    apiProxy: {
      sessions: {
        list: async () => ({
          result: {
            ok: true,
            value: {
              items: [{
                sessionId: SID,
                title: '失败会话',
                cwd: '/w',
                updatedAt: current.updatedAt,
                running: current.running,
                blank: false,
              }],
            },
          },
        }),
        history: async () => ({ result: { ok: true, value: { events: current.events } } }),
      },
      workspace: { list: async () => ({ result: { ok: true, value: { items: [], archivedSessionIds: [] } } }) },
    },
  };
  return async function step(events, { running, updatedAt }) {
    current.events = events;
    current.running = running;
    current.updatedAt = updatedAt;
    const response = await buildSessionsResponse(ctx);
    assert.equal(response.status, 200);
    return response.body.items.find((item) => item.sessionId === SID);
  };
}

const turnStart = (turn) => ({ event: { type: 'turn/start', seq: 1, time: 10, data: { turn } } });
const assistant = (turn, seq = 2) => ({
  event: { type: 'assistant/message', seq, time: 11, data: { turn, message: { role: 'assistant', content: [{ type: 'text', text: '…' }] } } },
});
const turnEnd = (turn, reason) => ({ event: { type: 'turn/end', seq: 3, time: 12, data: { turn, reason } } });

const FAILED = [turnStart(7), assistant(7), turnEnd(7, { kind: 'error', error: { message: '403: 用户额度不足', code: 'AUTH' } })];
const SUCCEEDED = [turnStart(8), assistant(8), turnEnd(8, { kind: 'completed' })];

test('失败轮：同一次响应里就带 completed:false + lastTurnError', async () => {
  const step = makeDriver();
  // 先建立 running 边沿（wasRunning 只在本次 Host 存活期间观察到的轮次才置位）。
  const runningRow = await step(FAILED, { running: true, updatedAt: 100 });
  assert.equal(runningRow.completed, false);
  assert.equal(runningRow.lastTurnError, undefined, '运行时还没有失败结论');
  // 再喂空闲快照：failure 是在这一次的 history 折叠里才算出来的。
  const idleRow = await step(FAILED, { running: false, updatedAt: 101 });
  assert.equal(idleRow.completed, false, '失败不能算完成');
  assert.equal(idleRow.running, false);
  assert.equal(idleRow.lastTurnError.turn, 7);
  assert.equal(idleRow.lastTurnError.code, 'AUTH');
  assert.equal(idleRow.lastTurnError.message, '403: 用户额度不足');
  assert.equal(idleRow.lastTurnError.at, 12);
});

test('失败之后跑成功一轮：红点被清掉，恢复 completed:true', async () => {
  const step = makeDriver();
  await step(FAILED, { running: true, updatedAt: 100 });             // 先建立 running 边沿
  await step(FAILED, { running: false, updatedAt: 101 });            // 再留下失败标记
  // 成功轮已经在跑：红点要一直挂着，直到这一轮真的成功收尾（失败必须被人看见）。
  const again = await step(SUCCEEDED, { running: true, updatedAt: 200 });
  assert.equal(again.completed, false);
  assert.equal(again.lastTurnError.turn, 7);
  const done = await step(SUCCEEDED, { running: false, updatedAt: 201 });
  assert.equal(done.completed, true);
  assert.equal(done.lastTurnError, undefined);
});

test('失败标记跨下一轮延续：失败后用户又发了一句话，红点还在', async () => {
  const step = makeDriver();
  await step(FAILED, { running: true, updatedAt: 100 });
  await step(FAILED, { running: false, updatedAt: 101 });
  // 新一轮已经开跑（running:true、有新的 turn/start），但用户还没看到红点。
  const nextTurn = [{ event: { type: 'turn/start', seq: 4, time: 20, data: { turn: 10 } } }];
  const row = await step(nextTurn, { running: true, updatedAt: 300 });
  assert.equal(row.running, true);
  assert.equal(row.lastTurnError.turn, 7, '红点必须等到被清掉为止，不能因为新轮开始就消失');
});

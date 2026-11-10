'use strict';

/**
 * 停止交代的出口：`GET /api/mobile/v1/session/stop-summary?sessionId=…[&turn=N]`。
 *
 * 用户点了停止之后，手机上那一轮不该只剩「已停止」三个字。这条路由把**这一轮跑过的步骤**
 * 折成一句句看得懂的话（做了什么 / 看到了什么 / 没做完什么 / 对外发出几次），交给 App 的
 * `StopSummaryCard` 画在被停止的那一轮末尾。
 *
 * 两个数据源，先内存后历史：还在跑（或刚停下）的那一轮在宿主的直播副本里
 *（`live-steps.js`），历史里还没有；已经落定的轮按 `turnProcess.steps` 从会话历史折出来。
 * 两处都是 `{ key, step }`，折叠逻辑只有一份（`stop-summary.js`，纯函数）。
 *
 * **按轮次答**（`?turn=N`，重新打开一条老会话时 App 补那一发用）：
 *  - 不带 `turn`：最近一轮，先直播副本后历史（向后兼容，刚按停止那一刻走的就是这条）；
 *  - 带 `turn`：只要那一轮。直播副本只有在它自己就是那一轮时才算数，否则一律回历史；
 *  - 那一轮在窗口里找不到：回**空交代**（不是报错），App 那边不出卡。
 *
 * 判据（为什么不能按消息上的 turn 号找那一轮）：历史派生的普通消息（user / assistant / wake）
 * **不带 turn 号** —— `history-derive.js` 的 `pushMessage` 收到 `data.turn` 后只拿它归并
 * 产出清单与交付声明，从没写回 `item.turn`；全篇只有压缩行带 `item.turn`（`:754/:764/:786`），
 * `:335` 那个 `turn` 在重试行上、`:660` 在读压缩行的轮号，都不是开轮消息。而
 * `turnProcess.steps` 恰恰挂在**开轮那条消息**上（`openerByTurn`，`:923-932`）。
 * 所以改用两个确实存在的锚点定位：这一轮收口那条结构行的 id 是 `turn-<轮号>`（`:916` 的
 * `turn-aborted`，`turn-error` / `max-tokens` 同形）、带这一轮的收口 `seq`；开轮消息的
 * `turnProcess.startSeq` 就是它自己的 `seq`（`:930`）。取「`startSeq` 最大、且小于那条
 * 收口行的 `seq`」的 `turnProcess`，就是这一轮的过程。
 *
 * 只读、只算展示结构：不碰 shell、不读任意文件，也没有写操作。取不到就回空交代，让 App
 * 不出那张卡，不报错。
 */

const { sendJson } = require('../shared/http-util');
const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');
const { liveStepsOf, liveStepsTurnOf } = require('./live-steps.js');
const { deriveMessages } = require('./history-derive.js');
const { summarize } = require('./stop-summary.js');

/** 回落到历史时取多少条事件：够覆盖最近一轮的步骤与开场消息即可。 */
const HISTORY_WINDOW = 200;

/** 历史里最近一轮的过程清单（`turnProcess.steps` 挂在开轮那条消息上）。 */
function lastTurnSteps(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    const steps = item && item.turnProcess && Array.isArray(item.turnProcess.steps)
      ? item.turnProcess.steps
      : null;
    if (steps && steps.length > 0) return steps;
  }
  return [];
}

/**
 * 历史里**指定那一轮**的过程清单（判据见文件头）。
 *
 * 锚点是这一轮收口那条结构行（`turn-aborted` / `turn-error` / `max-tokens`，id 都是
 * `turn-<轮号>`，带这一轮收口的 `seq`）：它不在窗口里就说明这一轮已经翻出去了，回空。
 * 有了它的 `seq`，再挑 `startSeq` 最大且更早的那份 `turnProcess` —— 那就是开启这一轮的消息。
 */
function turnSteps(messages, turn) {
  const endId = `turn-${turn}`;
  let endSeq = null;
  for (const item of messages) {
    if (!item || item.id !== endId) continue;
    if (typeof item.seq !== 'number') continue;
    endSeq = item.seq;
    break;
  }
  if (endSeq === null) return [];
  let best = null;
  for (const item of messages) {
    const process = item && item.turnProcess;
    if (!process || !Array.isArray(process.steps) || process.steps.length === 0) continue;
    const startSeq = typeof process.startSeq === 'number' ? process.startSeq : item.seq;
    if (typeof startSeq !== 'number' || startSeq >= endSeq) continue;
    if (best === null || startSeq > best.startSeq) best = { startSeq, steps: process.steps };
  }
  return best === null ? [] : best.steps;
}

/** 非负整数查询参数（与 `/session/step`、`/session/run-timeline` 同一套口径）。 */
function intParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return null;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** GET /api/mobile/v1/session/stop-summary?sessionId=…[&turn=N]（token） */
async function handleStopSummary(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 sessionId' } });
  }
  const turn = intParam(url, 'turn');
  const live = liveStepsOf(ctx, sessionId);
  if (live.length > 0) {
    // 直播副本只代表**当前这一轮**：点名了别的轮就老老实实走历史。
    const liveTurn = liveStepsTurnOf(ctx, sessionId);
    if (turn === null || liveTurn === null || liveTurn === turn) {
      return sendJson(res, 200, { ok: true, summary: summarize(live), source: 'live' });
    }
  }
  let steps = [];
  try {
    const { value, error } = unwrap(await callSessions(ctx, 'history', { sessionId, maxMessages: HISTORY_WINDOW }));
    if (!error) {
      const events = (value && Array.isArray(value.events)) ? value.events : [];
      const messages = deriveMessages(events, sessionId);
      steps = turn === null ? lastTurnSteps(messages) : turnSteps(messages, turn);
    }
  } catch {
    // 读不到历史就当没有可交代的东西：卡不出，不把它变成一次报错。
  }
  return sendJson(res, 200, { ok: true, summary: summarize(steps), source: 'history' });
}

module.exports = { handleStopSummary, HISTORY_WINDOW, lastTurnSteps, turnSteps };

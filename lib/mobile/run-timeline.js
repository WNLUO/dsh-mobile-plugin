'use strict';

/**
 * 「运行时间线」：把**一轮**跑过的步骤折成 App 侧 `RunTimelineView`（整页时间线的数据）。
 *
 * 这是什么：手机上那条「过程 · 已跑 N 步」点开是一份清单，这一页是同一份清单的整页版 ——
 * 一步一行，带状态、耗时、发生时刻。数据只有两个来源，都是**已经存在**的：
 *  - 还在跑的那一轮：`live-steps.js` 留在内存里的直播副本（`{ key, step }`）；
 *  - 已经落定的轮：按 `turn` 去宿主回拉一小窗事件，再用 `step-index` 的同一批纯函数重算摘要
 *    与状态（与 `history-derive` 的 `turnProcess.steps` 同源同口径）。
 *
 * 为什么是纯函数、为什么不造后端：宿主从来没有「运行记录」这个后端（它原本随「操作手机」
 * 那批一起长、从没接线）。这一页要的是**回看一份已经发生过的东西**，不需要新存储 —— 直播
 * 副本还有就直接读，落定了就按轮回拉一次。路由层（`routes/mobile-api.js`）只负责取数，
 * 折叠全在这里，守卫可以在裸 Node 里直接加载真实现。
 *
 * 每一步还带着「这一步在哪」的身份字段，与 `history-derive` 的 `TurnProcessStep` 同一套
 * （`kind` / `callId` / `seq` / `index` / `resultSeq`）：整页把一步折成能点开的一行，点开就
 * 拿这组字段去 `/session/step` 回拉详情。口径同样是**读得到才带** —— 直播副本里 `entry.step`
 * 本来有什么就透传什么，历史侧由事件补：工具步的 `seq` 是调用那条事件的、`resultSeq` 是结果
 * 事件的，思考步带块下标 `index` 与事件 `seq`。`kind` 仍然只有 `think` / `tool` 两档，不为
 * 「详情行」另造类型。
 *
 * 历史工具步另补 `durationMs` = 结果事件 `time` − 调用事件 `time`（两端都是数字且 ≥0 才写，
 * 否则那一格不写）。思考步没有可靠的结束时刻，不补；直播副本没有钟，也不补 —— 与 `at` 同一条
 * 「读不到就不写，绝不用『现在』凑」的规矩。
 *
 * 两个字段刻意没有生产者（不是忘了写）：
 *  - `screenshotUrl`：原来靠「操作手机」的读屏截屏留档，那套能力已整块下线。为它另造一条
 *    截屏链路是扩能力面、原生改动也大，不值得；页面本来就按「没有就不画缩略图」处理。
 *  - `tags`（`guard` / `verify` / `confirm` / `takeover`）：同样是那套能力的产物，一起下线了。
 * App 侧的类型把这两格留着，将来真需要时再补生产者；这里**不产出**它们。
 */

const { sendJson } = require('../shared/http-util');
const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');
const { liveStepsOf, liveStepsTurnOf } = require('./live-steps.js');
const { buildToolResultMap, parseBlocks, userVisibleText } = require('./history-derive.js');
const { reasoningText, reasoningStepSummary, toolStepSummary, toolStepState } = require('./step-index.js');

/**
 * 回拉历史时一次读多少条事件。
 *
 * 宿主一步一条 assistant 消息，一轮长回合能到几百条；这个窗口要能兜住「一轮跑完 + 它的工具
 * 结果」，又不是把整份会话搬回手机（回拉本身在电脑本地走 RPC，不占手机流量）。取不到的轮
 * 由路由如实回 404，让 App 落空态，不猜。
 */
const HISTORY_TURN_MAX_MESSAGES = 600;

/** App 侧认的那三档步骤类型里，宿主**真的会产**的只有两档（`say` 没有生产者，见文件头）。 */
const STEP_KIND = { think: 'think', tool: 'tool' };

/** App 侧认的四档步骤状态；宿主的词本来就是这四档，认不出的不写（页面按「没有就不画」处理）。 */
const STEP_STATE = new Set(['running', 'ok', 'error', 'stopped']);

/** 整次运行的结局，与 App 侧 `RunStatus` 同一套词。 */
const RUN_STATUS = new Set(['running', 'done', 'partial', 'failed', 'stopped']);

/** 认不出的 `step.kind` 一律按工具步处理：宿主只会发 `think` / `tool` 两种，这是兜底不是映射。 */
function kindOfStep(step) {
  return STEP_KIND[step && step.kind] || 'tool';
}

/** 一步的主行：思考看摘要，工具看「摘要，没有摘要就用工具名」。 */
function titleOfStep(step, kind) {
  const summary = typeof step.summary === 'string' ? step.summary : '';
  if (summary !== '') return summary;
  if (kind === 'tool' && typeof step.name === 'string') return step.name;
  return '';
}

/** 身份字段只要安全整数，别把 `null` / 字符串 / 小数当 seq 透出去（App 拿它当游标用）。 */
function intField(value) {
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * `{ key, step }` → App 侧的一步。
 *
 * `id` 直接用宿主的 `key`（直播侧是 `tool:<callId>` / `think:<序号>`，历史侧由这里按位置补），
 * 它在一轮内稳定，正好当列表 key。`durationMs` / `at` 是**读得到才带**：直播副本里没有时刻，
 * 历史事件里有 `time`；读不到就不写，绝不用「现在」或「这一轮起点」凑一个出来。
 *
 * 身份字段（`callId` / `seq` / `index` / `resultSeq`）同理只透传：`entry.step` 里本来带着的
 * 那几个照原样带出去，这里既不补也不猜（`durationMs` 也一样 —— 直播副本没有钟，算不出来）。
 */
function stepOfEntry(entry) {
  const step = entry && entry.step ? entry.step : {};
  const kind = kindOfStep(step);
  const callId = typeof step.callId === 'string' && step.callId !== '' ? step.callId : undefined;
  const seq = intField(step.seq);
  const index = intField(step.index);
  const resultSeq = intField(step.resultSeq);
  return {
    id: String(entry.key),
    kind,
    title: titleOfStep(step, kind),
    ...(kind === 'tool' && typeof step.name === 'string' && step.name !== '' ? { tool: step.name } : {}),
    ...(callId ? { callId } : {}),
    ...(seq !== undefined ? { seq } : {}),
    ...(index !== undefined ? { index } : {}),
    ...(resultSeq !== undefined ? { resultSeq } : {}),
    ...(STEP_STATE.has(step.state) ? { state: step.state } : {}),
    ...(typeof step.durationMs === 'number' && Number.isFinite(step.durationMs) && step.durationMs >= 0
      ? { durationMs: step.durationMs } : {}),
    ...(typeof step.at === 'number' && Number.isFinite(step.at) ? { at: step.at } : {}),
  };
}

/**
 * 折成 App 侧的一次运行视图。
 *
 * @param {{ sessionId: string, turn?: number|null, entries: {key: string, step: object}[],
 *   title?: string, startedAt?: number, endedAt?: number, outcome?: string }} input
 * @returns {{ id: string, title: string, status: string, startedAt?: number, endedAt?: number, steps: object[] }}
 */
function buildRunTimeline(input) {
  const { sessionId, turn = null, entries = [], title = '', startedAt, endedAt, outcome } = input || {};
  const steps = entries.map(stepOfEntry);
  const status = RUN_STATUS.has(outcome) ? outcome : 'done';
  return {
    id: `${sessionId}:${turn === null || turn === undefined ? 'latest' : turn}`,
    title: typeof title === 'string' ? title : '',
    status,
    ...(typeof startedAt === 'number' && Number.isFinite(startedAt) ? { startedAt } : {}),
    ...(typeof endedAt === 'number' && Number.isFinite(endedAt) ? { endedAt } : {}),
    steps,
  };
}

/**
 * 直播副本 → 运行视图。
 *
 * 这份副本里没有起止时刻（`live-steps` 只管这一轮的步骤，不管钟），所以 `startedAt` /
 * `endedAt` 不带上 —— 页头就不画时长，比编一个出来诚实。结局只能从步骤状态推：还有
 * `running` 的就在跑，全收口了就当这一轮跑完了（宿主换轮时这份副本会被整份替换）。
 */
function runTimelineFromLiveSteps({ sessionId, turn = null, entries = [] }) {
  const running = entries.some((entry) => entry && entry.step && entry.step.state === 'running');
  return buildRunTimeline({ sessionId, turn, entries, outcome: running ? 'running' : 'done' });
}

/** 一条事件属于哪一轮（没有轮号的一律不算）。 */
function turnOfEvent(event) {
  const turn = event && event.data && event.data.turn;
  return typeof turn === 'number' ? turn : undefined;
}

/**
 * 把这一轮的助手消息折成 `{ key, step }`（与直播副本同一形状，摘要与状态取 `step-index`）。
 *
 * 与 `history-derive` 的 `collectSteps` 同一套判据：空推理块不算一步（点开一行什么都没有
 * 没有意义）；工具步的状态由结果事件反推（没有结果就是还在跑）。
 */
function stepsFromEvents(events, turn) {
  const toolResults = buildToolResultMap(events);
  // 结果事件的时刻：`buildToolResultMap` 只为「按需取详情」留了 `seq`，算耗时还差一个钟，
  // 同一批事件再扫一遍拿 `time`（不新增依赖，也不改那张表的用途）。
  const toolResultTime = new Map();
  for (const item of events) {
    const event = item && item.event ? item.event : item;
    if (!event || event.type !== 'tool/result') continue;
    const source = event.data && event.data.message && event.data.message.source;
    if (!source || typeof source.callId !== 'string') continue;
    if (typeof event.time === 'number' && event.time >= 0) toolResultTime.set(source.callId, event.time);
  }
  const entries = [];
  for (const item of events) {
    const event = item && item.event ? item.event : item;
    if (!event || event.type !== 'assistant/message') continue;
    if (turnOfEvent(event) !== turn) continue;
    const message = event.data && event.data.message;
    const content = message && Array.isArray(message.content) ? message.content : [];
    content.forEach((block, index) => {
      if (!block || typeof block !== 'object') return;
      if (block.type === 'reasoning') {
        const text = reasoningText(block.text);
        // 只剩签名块的那一段等于没有推理，不算一步。
        if (text.trim() === '') return;
        entries.push({
          key: `think:${event.seq}:${index}`,
          step: {
            kind: 'think',
            ...(Number.isSafeInteger(event.seq) ? { seq: event.seq } : {}),
            index,
            summary: reasoningStepSummary(text),
            state: 'ok',
            ...(typeof event.time === 'number' ? { at: event.time } : {}),
          },
        });
        return;
      }
      if (block.type !== 'tool-call') return;
      const callId = block.id != null ? String(block.id) : '';
      const result = callId ? toolResults.get(callId) : undefined;
      const rawArgs = typeof block.arguments === 'string'
        ? block.arguments
        : (block.arguments != null ? JSON.stringify(block.arguments) : '');
      // 耗时只在两端都有可信时刻时才算（`stepOfEntry` 会再挡掉负数）；`result` 在就是跑完了，
      // 否则还在跑，没有结束时刻。
      const endTime = callId ? toolResultTime.get(callId) : undefined;
      const durationMs = typeof event.time === 'number' && event.time >= 0
        && typeof endTime === 'number' && endTime >= 0
        ? endTime - event.time : undefined;
      entries.push({
        key: callId ? `tool:${callId}` : `tool:${event.seq}:${index}`,
        step: {
          kind: 'tool',
          ...(callId ? { callId } : {}),
          ...(typeof block.name === 'string' && block.name !== '' ? { name: block.name } : {}),
          ...(Number.isSafeInteger(event.seq) ? { seq: event.seq } : {}),
          ...(result && Number.isSafeInteger(result.seq) ? { resultSeq: result.seq } : {}),
          summary: toolStepSummary(block.name, rawArgs),
          state: toolStepState(result),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(typeof event.time === 'number' ? { at: event.time } : {}),
        },
      });
    });
  }
  return entries;
}

/**
 * 这一轮的元信息：起止时刻、结局、标题（用户那句话）。
 *
 * 结局按 `turn/end` 的 `reason.kind` 分：`error` → 失败、`aborted` → 已停止、`max-tokens` →
 * 部分完成（输出被上限截断，确实没跑完），其余算正常收口。没有 `turn/end` 就是还在跑。
 */
function turnMetaOf(events, turn) {
  const toolResults = buildToolResultMap(events);
  let startedAt;
  let endedAt;
  let outcome = 'running';
  let title = '';
  for (const item of events) {
    const event = item && item.event ? item.event : item;
    if (!event || turnOfEvent(event) !== turn) continue;
    if (event.type === 'turn/start' && typeof event.time === 'number') startedAt = event.time;
    if (event.type === 'user/message') {
      const content = event.data && Array.isArray(event.data.content) ? event.data.content : [];
      // 轮标题取的是「用户说了什么」：用 `userVisibleText` 而不是裸 `blocksToText` —— 照片说明
      // 那几行是发给模型看的元数据（哨兵见 `app/src/services/viewmodels/photo-caption.ts`），
      // 混进标题就是时间线上一行「[照片 …]」，而用户其实什么都没写。
      const text = userVisibleText(parseBlocks(content, toolResults)).trim();
      if (text !== '' && title === '') title = text.length > 120 ? `${text.slice(0, 119)}…` : text;
    }
    if (event.type === 'turn/end') {
      if (typeof event.time === 'number') endedAt = event.time;
      const reason = event.data && event.data.reason;
      const kind = reason && typeof reason.kind === 'string' ? reason.kind : '';
      outcome = kind === 'error' ? 'failed'
        : kind === 'aborted' ? 'stopped'
          : kind === 'max-tokens' ? 'partial'
            : 'done';
    }
  }
  return { startedAt, endedAt, outcome, title };
}

/** 事件里出现过的最后一轮（调用方没点名轮次时用它）。 */
function latestTurnOf(events) {
  let latest = null;
  for (const item of events) {
    const event = item && item.event ? item.event : item;
    const turn = turnOfEvent(event);
    if (turn !== undefined) latest = turn;
  }
  return latest;
}

/**
 * 历史事件 → 运行视图；这一轮在窗口里一条事件都没有时返回 null（由调用方回 404）。
 */
function runTimelineFromEvents(events, { sessionId, turn = null }) {
  const target = typeof turn === 'number' ? turn : latestTurnOf(events);
  if (target === null) return null;
  const entries = stepsFromEvents(events, target);
  const meta = turnMetaOf(events, target);
  // 窗口里既没有这一轮的步、也没有它的起止：说明这一轮已经在窗口之外了，别回一份空壳。
  if (entries.length === 0 && meta.startedAt === undefined && meta.endedAt === undefined) return null;
  return buildRunTimeline({ sessionId, turn: target, entries, ...meta });
}

function intParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return null;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** 宿主错误 → HTTP 码（与 `session-step` 同一套口径）。 */
function historyStatus(error) {
  switch (error && error.code) {
    case 'bad-request': return 400;
    case 'session-not-found':
    case 'subagent-not-found': return 404;
    case 'subagent-unauthorized': return 403;
    case 'host-unavailable': return 503;
    default: return 502;
  }
}

/**
 * `GET /api/mobile/v1/session/run-timeline?sessionId=…&turn=…`（token）。
 *
 * 只读：先看还在跑的那一轮的直播副本，没有再按轮回拉一小窗历史。**不新增任何读屏 / 截屏 /
 * 执行能力** —— 它读的就是对话页本来就能看到的那些事件与步骤。
 */
async function handleRunTimeline(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 sessionId' } });
  const turn = intParam(url, 'turn');

  const liveEntries = liveStepsOf(ctx, sessionId);
  const liveTurn = liveStepsTurnOf(ctx, sessionId);
  // 直播副本只代表**当前这一轮**：点了上一轮就老老实实走历史。
  if (liveEntries.length > 0 && (turn === null || liveTurn === null || liveTurn === turn)) {
    return sendJson(res, 200, {
      ok: true,
      run: runTimelineFromLiveSteps({ sessionId, turn: liveTurn, entries: liveEntries }),
    });
  }

  let value;
  let error;
  try {
    ({ value, error } = unwrap(await callSessions(ctx, 'history', {
      sessionId,
      maxMessages: HISTORY_TURN_MAX_MESSAGES,
    })));
  } catch (thrown) {
    error = thrown && typeof thrown === 'object' ? thrown : { code: 'host-call-failed', message: String(thrown) };
  }
  if (error) {
    return sendJson(res, historyStatus(error), {
      ok: false,
      error: {
        code: typeof error.code === 'string' ? error.code : 'host-call-failed',
        message: typeof error.message === 'string' && error.message ? error.message : '取这一轮的过程失败',
      },
    });
  }
  const events = (value && Array.isArray(value.events)) ? value.events : [];
  const run = runTimelineFromEvents(events, { sessionId, turn });
  if (!run) {
    return sendJson(res, 404, {
      ok: false,
      error: { code: 'run-not-found', message: '这一轮的过程已经不在电脑上了' },
    });
  }
  return sendJson(res, 200, { ok: true, run });
}

module.exports = {
  HISTORY_TURN_MAX_MESSAGES,
  buildRunTimeline,
  stepOfEntry,
  stepsFromEvents,
  turnMetaOf,
  latestTurnOf,
  runTimelineFromLiveSteps,
  runTimelineFromEvents,
  handleRunTimeline,
};

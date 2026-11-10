'use strict';

/**
 * 回答下面的「来源」：这一轮读过哪些网页 / 文件 / 查询词。
 *
 * **来源由代码挑，不由模型写**（照 Mika `AnswerSources` 的做法）：模型自己列参考链接时，
 * 写了什么就是什么，对不上的也没人核；而这一轮真正读过什么，事件流里本来就有 —— 挑的时候
 * 只认工具调用，模型说了不算。
 *
 * **只给指针，不带正文**：挑出来的是「哪一页 / 哪一个文件 / 哪一个查询词」，网页正文、
 * 文件内容、工具参数一概不进来。这与「推理正文、工具参数、结果正文不下发」（`wire-cut.js`）
 * 那条边界同向：卡上那一行要的是「值不值得点开」，不是把材料再搬一遍。
 *
 * 信息量口径（为什么挑这三种工具，别的都不挑）：
 *  - `web_fetch`：回答里引用的外部事实的来源，网址本身就是信息；
 *  - `read` / `read_image`：读过的本地文件，路径指出「这个结论是从哪份材料来的」；
 *  - `web_search`：搜索本身也算材料来源，查询词是它唯一的指针。
 * `grep` / `glob` 不挑：它们是在仓库里找，挑出来只是一串正则，读者拿它回不到任何一份材料。
 * 工具名与摘要一律走 `step-index.js` 的 `toolStepSummary`，不在这里另拼一套（同一行摘要在
 * 过程清单里长什么样，来源卡里就长什么样）。
 *
 * 上限 6 条（旧证据账本 `MAX_SOURCES` 的口径）：再多就不是「这次读过哪些」而是第二份过程清单。
 */

const { sendJson } = require('../shared/http-util');
const { callSessions } = require('./rpc.js');
const { unwrap } = require('./envelope.js');
const { toolStepSummary } = require('./step-index.js');
const { liveStepsOf, liveStepsTurnOf } = require('./live-steps.js');

/** 至多列这么多处来源（沿用旧账本的 `MAX_SOURCES`）。 */
const MAX_SOURCES = 6;

/** 回拉历史的条数上限：与 `/session/step` 同一档，够盖住一轮里的全部工具调用。 */
const HISTORY_MAX_MESSAGES = 200;

/** 挑哪些工具。 */
const WEB_TOOLS = new Set(['web_fetch']);
const SEARCH_TOOLS = new Set(['web_search']);
const FILE_TOOLS = new Set(['read', 'read_image']);

/** 这一类工具 → 来源卡上的 `kind`；认不出的返回空串。 */
function kindOfTool(name) {
  if (WEB_TOOLS.has(name)) return 'web';
  if (SEARCH_TOOLS.has(name)) return 'search';
  if (FILE_TOOLS.has(name)) return 'file';
  return '';
}

/** 网址里的主机名（取不到就回空串，调用方退回整条网址）。 */
function hostOf(url) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(String(url || ''));
  if (!match) return '';
  return match[1].replace(/^\[|\]$/g, '').toLowerCase();
}

/** 路径的最后一段（`/a/b/c.md` → `c.md`），取不到回空串。 */
function baseOf(path) {
  const parts = String(path || '').split(/[/\\]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

/**
 * 从一轮的步骤里挑出来源。
 *
 * @param {ReadonlyArray<{key?: string, step?: object}>} entries 过程清单（与 `liveStepsOf` /
 *   `turnProcess.steps` 同一个形状：`{ key, step }`，`step` 带 `kind` / `name` / `summary` /
 *   `state`）。
 * @returns {Array<{obsId:number, kind:string, place:string, title:string, step:number, mediaIds:number[], source:string}>}
 *   宿主侧的来源形状（App 的 `HostAnswerSource`），至多 `MAX_SOURCES` 条，按读到先后。
 */
function answerSourcesOf(entries) {
  if (!Array.isArray(entries)) return [];
  /** 按「种类 + 地点」去重，同一个文件读两次只占一条。 */
  const hits = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const step = entry && typeof entry === 'object' ? entry.step : null;
    if (!step || step.kind !== 'tool') continue;
    // 失败的那一次不算「读过」：抓取报错 / 读文件被拒没留下材料。
    if (step.state === 'error' || step.state === 'stopped') continue;
    const name = typeof step.name === 'string' ? step.name : '';
    const kind = kindOfTool(name);
    if (kind === '') continue;
    const place = typeof step.summary === 'string' ? step.summary.trim() : '';
    if (place === '') continue;
    const title = kind === 'web' ? (hostOf(place) || place) : kind === 'file' ? (baseOf(place) || place) : place;
    const hit = { kind, place, title, step: index + 1, source: name };
    const seen = hits.findIndex((item) => item.kind === kind && item.place === place);
    if (seen >= 0) hits.splice(seen, 1);
    hits.push(hit);
  }
  // 只留最近读的几条（旧账本 `hits.slice(-MAX_SOURCES)` 的口径）。
  return hits.slice(-MAX_SOURCES).map((hit, index) => ({
    obsId: index + 1,
    kind: hit.kind,
    place: hit.place,
    title: hit.title,
    step: hit.step,
    mediaIds: [],
    source: hit.source,
  }));
}

/**
 * 历史事件里的工具调用 → 每一轮的步骤数组。
 *
 * 只读 assistant 消息里的 tool-call 块（参数在这一层还在，与 `history-derive` 取「做过哪些
 * 写」同一个位置）；摘要走 `toolStepSummary`。
 */
function stepsByTurnOf(events) {
  const turns = [];
  const byTurn = new Map();
  const push = (turn, entry) => {
    if (!byTurn.has(turn)) {
      byTurn.set(turn, []);
      turns.push(turn);
    }
    byTurn.get(turn).push(entry);
  };
  for (const raw of events) {
    const event = raw && raw.event ? raw.event : raw;
    if (!event || event.type !== 'assistant/message') continue;
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const turn = typeof data.turn === 'number' ? data.turn : null;
    const message = data.message;
    const content = message && Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!block || block.type !== 'tool-call' || typeof block.name !== 'string') continue;
      const callId = block.id != null ? String(block.id) : `${turn}:${byTurn.get(turn) ? byTurn.get(turn).length : 0}`;
      push(turn, {
        key: `tool:${callId}`,
        step: {
          kind: 'tool',
          name: block.name,
          summary: toolStepSummary(block.name, block.arguments),
          state: 'ok',
        },
      });
    }
  }
  return { turns, byTurn };
}

/** 宿主错误 → 状态码（与 `/session/step` 同一套判据）。 */
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

function intParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return null;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * `GET /api/mobile/v1/session/answer-sources?sessionId=…&turn=…`
 *
 * 不带 `turn` 就是「最近一轮」：先在直播副本里找（跑着的那一轮还没落盘，历史里没有），
 * 没有再去问历史。带 `turn` 就只要那一轮的问法 —— 历史里一轮的工具调用都在。
 *
 * 空结果是正常结果（这一轮只说话没读东西）：回 `{ok:true, turn, sources: []}`，
 * 让 App 那边整块不画。
 */
async function handleAnswerSources(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 sessionId' } });
  const parentSessionId = url.searchParams.get('parentSessionId');
  const mode = url.searchParams.get('mode');
  const hasSubagentAddress = parentSessionId !== null || mode !== null;
  if (hasSubagentAddress && (
    typeof parentSessionId !== 'string' || parentSessionId.trim() === ''
    || (mode !== 'one-shot' && mode !== 'continuable')
  )) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '子代理会话需要 parentSessionId 和有效 mode' } });
  }
  const wantedTurn = intParam(url, 'turn');

  // 直播副本优先：跑着的那一轮（以及刚收口、还没重新拉历史的那一轮）只有这里有。
  const liveTurn = liveStepsTurnOf(ctx, sessionId);
  const liveSteps = liveStepsOf(ctx, sessionId);
  if (liveSteps.length > 0 && (wantedTurn === null || liveTurn === null || liveTurn === wantedTurn)) {
    return sendJson(res, 200, { ok: true, turn: liveTurn, sources: answerSourcesOf(liveSteps) });
  }

  const address = hasSubagentAddress ? { parentSessionId, mode } : {};
  try {
    const { value, error } = unwrap(await callSessions(ctx, 'history', {
      sessionId,
      maxMessages: HISTORY_MAX_MESSAGES,
      ...address,
    }));
    if (error) throw error;
    const events = value && Array.isArray(value.events) ? value.events : [];
    const { turns, byTurn } = stepsByTurnOf(events);
    // 没有明确的轮号就取最近一轮（历史事件按 seq 递增，最后出现的轮号就是最近的）。
    const turn = wantedTurn !== null && byTurn.has(wantedTurn)
      ? wantedTurn
      : (wantedTurn !== null ? null : (turns.length > 0 ? turns[turns.length - 1] : null));
    const entries = turn === null ? [] : byTurn.get(turn) || [];
    return sendJson(res, 200, { ok: true, turn, sources: answerSourcesOf(entries) });
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : 'host-call-failed';
    const message = error && typeof error.message === 'string' && error.message ? error.message : '取出这一轮的来源失败';
    return sendJson(res, historyStatus({ code }), { ok: false, error: { code, message } });
  }
}

module.exports = {
  MAX_SOURCES,
  answerSourcesOf,
  handleAnswerSources,
};

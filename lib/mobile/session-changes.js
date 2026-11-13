'use strict';

/** 按需读取某轮的已证实前后文本，只读会话事件/直播副本，不读工作区或 Git。 */
const { sendJson } = require('../shared/http-util');
const { callSessions } = require('./rpc.js');
const { unwrap } = require('./envelope.js');
const { foldTurnFacts, turnChangesSnapshot } = require('./turn-facts.js');
const { liveTurnChangesOf } = require('./live-steps.js');

const HISTORY_MESSAGES = 200;
const HISTORY_PAGES = 20;

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

/** 有界、定向地向前翻到目标轮起点；第一发同时验证现有读会话/子代理权限。 */
async function readTurnEvents(ctx, sessionId, wantedTurn, address = {}, signal, maxPages = HISTORY_PAGES) {
  const events = [];
  let beforeSeq;
  let turn = wantedTurn;
  for (let page = 0; page < maxPages; page += 1) {
    const { value, error } = unwrap(await callSessions(ctx, 'history', {
      sessionId, ...address, maxMessages: HISTORY_MESSAGES,
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
    }, 'mobile', signal));
    if (error) throw error;
    const entries = value && Array.isArray(value.events) ? value.events : [];
    const batch = entries.map((entry) => entry && entry.event ? entry.event : entry).filter(Boolean)
      .sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity));
    if (turn === null || turn === undefined) {
      for (const event of batch) {
        if (event.data && typeof event.data.turn === 'number') turn = event.data.turn;
      }
    }
    events.unshift(...batch);
    const atStart = batch.some((event) => event.type === 'turn/start' && event.data && event.data.turn === turn);
    const beforeTurn = batch.some((event) => event.data && typeof event.data.turn === 'number' && event.data.turn < turn);
    if (atStart || beforeTurn || !value || value.hasMore !== true) return { events, turn, truncated: false };
    const seqs = batch.map((event) => event.seq).filter(Number.isSafeInteger);
    const oldest = seqs.length ? Math.min(...seqs) : null;
    if (oldest === null || oldest === beforeSeq) return { events, turn, truncated: true };
    beforeSeq = oldest;
  }
  return { events, turn, truncated: true };
}

/** GET sessionId/turn + 可选 parentSessionId/mode；返回 files:[{path,oldText?,newText?}]。 */
async function handleSessionChanges(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const sessionId = url.searchParams.get('sessionId');
  const rawTurn = url.searchParams.get('turn');
  const turn = rawTurn !== null && /^\d+$/.test(rawTurn) ? Number(rawTurn) : null;
  if (!sessionId || !Number.isSafeInteger(turn)) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 sessionId 和有效 turn' } });
  }
  const parentSessionId = url.searchParams.get('parentSessionId');
  const mode = url.searchParams.get('mode');
  const hasAddress = parentSessionId !== null || mode !== null;
  if (hasAddress && (!parentSessionId || !parentSessionId.trim() || (mode !== 'one-shot' && mode !== 'continuable'))) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '子代理会话需要 parentSessionId 和有效 mode' } });
  }
  const address = hasAddress ? { parentSessionId, mode } : {};
  const controller = new AbortController();
  try {
    const history = await readTurnEvents(ctx, sessionId, turn, address, controller.signal);
    const facts = foldTurnFacts(history.events).get(turn);
    const live = liveTurnChangesOf(ctx, sessionId, turn, history.events);
    const details = live || (facts ? turnChangesSnapshot(facts) : { files: [] });
    return sendJson(res, 200, {
      ok: true, ...details,
      ...(history.truncated ? { truncated: true } : {}),
    });
  } catch (error) {
    const normalized = {
      code: error && typeof error.code === 'string' ? error.code : 'host-call-failed',
      message: error && typeof error.message === 'string' && error.message ? error.message : '读取这一轮的改动失败',
    };
    return sendJson(res, historyStatus(normalized), { ok: false, error: normalized });
  }
}

module.exports = { handleSessionChanges, readTurnEvents, HISTORY_MESSAGES, HISTORY_PAGES };

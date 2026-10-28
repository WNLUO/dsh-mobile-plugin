'use strict';

/**
 * 一步的详情：`GET /api/mobile/v1/session/step`。
 *
 * 清单（`/session/messages` 里每条 `turnProcess.steps[]`）只带摘要与位置，正文不上线路；
 * 用户点开清单里的某一步，才由这条路由把**那一步**的完整内容取回来：工具的参数 / 输出 /
 * diff，或思考的全文。
 *
 * 两个数据源，先内存后历史：
 *  - 还在跑的那一轮：直播流里的原始内容被 `live-steps.js` 留了一份副本，宿主历史里还没有
 *    落盘，只有这里答得出来；
 *  - 已经落定的轮：按清单给的 `seq` / `resultSeq` 向宿主回拉**一小窗**事件（宿主没有
 *    「按 seq 取一条」的接口，只能 beforeSeq 窗口取，代价是两次宿主往返，用户点一下才付）。
 *
 * 取不到不是错误状态机的一部分：回 404 + 一句人话，App 那边给一次重试。
 */

const { sendJson } = require('../shared/http-util');
const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');
const { liveStepOf } = require('./live-steps.js');
const { textOfParts } = require('./step-index.js');

/** 详情单段文本的上限（参数 / 输出 / 思考全文各自适用）。 */
const DETAIL_MAX_CHARS = 200_000;

/** 回拉窗口的条数上限：宿主 page 接口按消息条数算，这个量级覆盖一次调用到它的结果。 */
const WINDOW_MAX_MESSAGES = 200;

function intParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return null;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function strParam(url, name) {
  const raw = url.searchParams.get(name);
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

function capText(text) {
  if (typeof text !== 'string' || text === '') return { text: '' };
  if (text.length <= DETAIL_MAX_CHARS) return { text };
  return { text: text.slice(0, DETAIL_MAX_CHARS), truncated: true };
}

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

function normalizeError(error) {
  return {
    code: error && typeof error.code === 'string' ? error.code : 'host-call-failed',
    message: error && typeof error.message === 'string' && error.message ? error.message : '取这一步的过程失败',
  };
}

/** 向宿主回拉 `beforeSeq` 之前的一小窗事件（`beforeSeq` 是开区间，所以传 `seq + 1`）。 */
async function fetchWindow(ctx, sessionId, beforeSeq, address) {
  const payload = { sessionId, maxMessages: WINDOW_MAX_MESSAGES, beforeSeq };
  const { value, error } = unwrap(await callSessions(ctx, 'history', { ...payload, ...address }));
  if (error) throw error;
  const events = (value && Array.isArray(value.events)) ? value.events : [];
  return events.map((entry) => (entry && entry.event ? entry.event : entry)).filter(Boolean);
}

function toolBlocksOf(event, callId) {
  if (!event || event.type !== 'assistant/message') return null;
  const message = event.data && event.data.message;
  const content = message && Array.isArray(message.content) ? message.content : null;
  if (!content) return null;
  for (const block of content) {
    if (!block || block.type !== 'tool-call') continue;
    if (block.id != null && String(block.id) === callId) return block;
  }
  return null;
}

function resultEventOf(events, callId) {
  for (const event of events) {
    if (!event || event.type !== 'tool/result') continue;
    const message = event.data && event.data.message;
    const src = message && message.source;
    if (src && typeof src.callId === 'string' && src.callId === callId) return event;
  }
  return null;
}

/** 一步的详情（历史那条路）：按清单给的两个位置分别定位调用与结果。 */
async function historyStep(ctx, { sessionId, kind, callId, seq, index, resultSeq, address }) {
  const beforeSeq = Number.isSafeInteger(resultSeq) ? resultSeq + 1 : seq + 1;
  let events = await fetchWindow(ctx, sessionId, beforeSeq, address);
  if (kind === 'think') {
    const target = events.find((event) => event.seq === seq && event.type === 'assistant/message')
      || (await fetchWindow(ctx, sessionId, seq + 1, address)).find((event) => event.type === 'assistant/message');
    const message = target && target.data && target.data.message;
    const content = message && Array.isArray(message.content) ? message.content : [];
    const block = content[index];
    const text = block && block.type === 'reasoning' && typeof block.text === 'string' ? block.text : '';
    if (!text) return null;
    const capped = capText(text);
    return { kind: 'think', state: 'ok', text: capped.text, ...(capped.truncated ? { truncated: true } : {}) };
  }
  // 工具：调用块给出参数，结果事件给出输出与 diff。两者常常挨着，先在同一次窗口里找，
  // 找不到再单独补一次（长回合里中间可能夹着别的步骤）。
  let call = null;
  for (const event of events) {
    const block = toolBlocksOf(event, callId);
    if (block) {
      call = { block, event };
      break;
    }
  }
  if (!call && Number.isSafeInteger(seq)) {
    const again = await fetchWindow(ctx, sessionId, seq + 1, address);
    for (const event of again) {
      const block = toolBlocksOf(event, callId);
      if (block) {
        call = { block, event };
        events = again;
        break;
      }
    }
  }
  if (!call) return null;
  const result = resultEventOf(events, callId);
  const rawArgs = typeof call.block.arguments === 'string'
    ? call.block.arguments
    : (call.block.arguments != null ? JSON.stringify(call.block.arguments) : '');
  const args = capText(rawArgs);
  let output = '';
  let diffs;
  let state = 'running';
  if (result) {
    const message = result.data && result.data.message;
    const direct = message && Array.isArray(message.content) ? message.content : [];
    const envelope = direct.length === 1 && direct[0] && typeof direct[0] === 'object'
      && typeof direct[0].type !== 'string' ? direct[0] : null;
    const parts = envelope ? (Array.isArray(envelope.content) ? envelope.content : []) : direct;
    const failed = (envelope ? envelope.isError === true : false) || (message && message.isError === true);
    const code = result.data && result.data.error && typeof result.data.error.code === 'string'
      ? result.data.error.code : undefined;
    state = failed ? (code === 'interrupted' ? 'stopped' : 'error') : 'ok';
    const text = capText(textOfParts(parts));
    output = text.text;
    if (text.truncated) diffs = undefined;
    const meta = result.data && result.data.meta;
    if (meta && Array.isArray(meta.diffs) && meta.diffs.length > 0) diffs = meta.diffs;
  }
  return {
    kind: 'tool',
    ...(typeof call.block.name === 'string' && call.block.name ? { name: call.block.name } : {}),
    state,
    ...(args.text ? { argsRaw: args.text } : {}),
    ...(output ? { output } : {}),
    ...(Array.isArray(diffs) && diffs.length > 0 ? { diffs } : {}),
    ...(args.truncated ? { truncated: true } : {}),
  };
}

/**
 * 取一步的详情。
 *
 * 参数：`sessionId` 必填；`kind` = `tool` | `think`；`callId`（工具）/ `index`（思考）
 * 用于直播副本；`seq` / `resultSeq` 是清单里带的位置，用于回落历史。
 * 子代理会话要额外带 `parentSessionId` + `mode`。
 */
async function handleSessionStep(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const sessionId = strParam(url, 'sessionId');
  if (!sessionId) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 sessionId' } });
  const kind = url.searchParams.get('kind') === 'think' ? 'think' : 'tool';
  const callId = strParam(url, 'callId');
  const index = intParam(url, 'index');
  const seq = intParam(url, 'seq');
  const resultSeq = intParam(url, 'resultSeq');
  const parentSessionId = url.searchParams.get('parentSessionId');
  const mode = url.searchParams.get('mode');
  const hasSubagentAddress = parentSessionId !== null || mode !== null;
  if (hasSubagentAddress && (
    typeof parentSessionId !== 'string' || parentSessionId.trim() === ''
    || (mode !== 'one-shot' && mode !== 'continuable')
  )) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '子代理会话需要 parentSessionId 和有效 mode' } });
  }
  if (kind === 'tool' && !callId) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 callId' } });
  }
  // 还在跑的那一轮：直播副本里就有，不必去问宿主（那边还没落盘），也就不必要求位置 ——
  // 跑到一半的调用只有 `callId`、思考只有块序号。
  const live = liveStepOf(ctx, sessionId, { kind, callId, index });
  if (live) return sendJson(res, 200, { ok: true, step: live });
  if (kind === 'think' && (index === null || seq === null)) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少这一步的位置' } });
  }
  if (kind === 'tool' && seq === null && resultSeq === null) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少这一步的位置' } });
  }

  const address = hasSubagentAddress ? { parentSessionId, mode } : {};
  try {
    const step = await historyStep(ctx, { sessionId, kind, callId, seq, index, resultSeq, address });
    if (!step) {
      return sendJson(res, 404, {
        ok: false,
        error: { code: 'step-not-found', message: '这一步的过程已经不在电脑上了' },
      });
    }
    return sendJson(res, 200, { ok: true, step });
  } catch (error) {
    const normalized = normalizeError(error);
    return sendJson(res, historyStatus(normalized), { ok: false, error: normalized });
  }
}

module.exports = { handleSessionStep, DETAIL_MAX_CHARS };

'use strict';

/** 按轮的模型、成功产出与净改动事实；历史和直播在 wire-cut 之前共用这一份折叠。 */
const { requestModelOf, sameModel } = require('./request-model.cjs');
const { parseArgs } = require('./step-index.js');

const CHANGE_TEXT_MAX = 200_000;
const CHANGE_TOTAL_MAX = 1_000_000;
const LINE_WORK_MAX = 2_000_000;
const FACT_TYPES = new Set(['turn/start', 'request/header', 'assistant/message', 'tool/call', 'tool/result']);

function createTurnFacts() {
  return {
    calls: new Map(), callFacts: new Map(), results: new Map(), applied: new Set(), files: new Map(),
    requests: new Map(), currentModel: null, currentStep: null, actualModel: null, modelTrail: [],
    events: new Map(), nextEvent: 0, lastSeq: -1, revision: 0,
    textSize: 0, truncated: false, complete: false, snapshot: null,
  };
}

function resultCallId(event) {
  const data = event && event.data;
  const message = data && data.message;
  const id = data && (data.toolCallId ?? (message && (message.toolCallId ?? (message.source && message.source.callId))));
  return id == null ? '' : String(id);
}

/** 结果的两种信封与独立 error 都是失败证据，只有明确收到成功结果才记写入。 */
function successfulResult(event) {
  const data = event && event.data;
  const message = data && data.message;
  if (!message || data.error != null || message.isError === true) return false;
  const parts = Array.isArray(message.content) ? message.content : [];
  const inner = parts.length === 1 && parts[0] && typeof parts[0].type !== 'string' ? parts[0] : null;
  return !inner || inner.isError !== true;
}

/** 只保留完整文本；超限整段缺省，不能拿截断后的正文编净行数。 */
function keepText(state, value) {
  if (value === null) value = '';
  if (typeof value !== 'string') return undefined;
  if (value.length > CHANGE_TEXT_MAX || state.textSize + value.length > CHANGE_TOTAL_MAX) {
    state.truncated = true;
    return undefined;
  }
  state.textSize += value.length;
  return value;
}

function callFact(state, id, name, rawArgs) {
  if (id == null) return null;
  const callId = String(id);
  const args = parseArgs(rawArgs);
  const path = args.file_path ?? args.path;
  const previous = state.callFacts.get(callId);
  const fact = {
    id: callId, name: typeof name === 'string' ? name : '',
    path: typeof path === 'string' && path.trim() ? path : '',
    ...(name === 'write' ? { newText: previous && previous.newText !== undefined ? previous.newText : keepText(state, args.content) } : {}),
    noChange: name === 'edit' && typeof args.old_string === 'string' && args.old_string === args.new_string,
  };
  if (previous && previous.name === fact.name && previous.path === fact.path && previous.newText === fact.newText && previous.noChange === fact.noChange) return previous;
  state.callFacts.set(callId, fact);
  return fact;
}

/** 只缓存重建事实所需的小记录；任意工具参数、结果正文与推理不进入这份记录。 */
function eventFact(state, event) {
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const base = { type: event.type, seq: Number.isSafeInteger(event.seq) ? event.seq : null, step: data.step };
  if (event.type === 'request/header') return { ...base, model: requestModelOf(event) };
  if (event.type === 'tool/call') return { ...base, calls: [callFact(state, data.callId, data.name, data.arguments)].filter(Boolean) };
  if (event.type === 'assistant/message') {
    const content = data.message && Array.isArray(data.message.content) ? data.message.content : [];
    return {
      ...base, hasContent: content.length > 0,
      calls: content.filter((block) => block && block.type === 'tool-call')
        .map((block) => callFact(state, block.id, block.name, block.arguments)).filter(Boolean),
    };
  }
  if (event.type === 'tool/result') {
    const success = successfulResult(event);
    const diffs = success && data.meta && Array.isArray(data.meta.diffs) ? data.meta.diffs : [];
    return {
      ...base, callId: resultCallId(event), success,
      diffs: diffs.filter((diff) => diff && typeof diff.path === 'string' && diff.path.trim()).map((diff) => ({
        path: diff.path, same: (typeof diff.oldText === 'string' || diff.oldText === null)
          && (typeof diff.newText === 'string' || diff.newText === null) && (diff.oldText ?? '') === (diff.newText ?? ''),
        oldText: keepText(state, diff.oldText), newText: keepText(state, diff.newText),
      })),
    };
  }
  return base;
}

function addChange(state, change) {
  const { path, oldText, newText } = change;
  if (!path || change.same || (oldText !== undefined && newText !== undefined && oldText === newText)) return;
  let file = state.files.get(path);
  if (!file) {
    file = { path, oldText, newText: undefined };
    state.files.set(path, file);
  } else if (file.newText === undefined || oldText === undefined || file.newText !== oldText) {
    // 缺失中间版本或前后对不上，不能把未证实的修改计入本轮净行数。
    file.oldText = undefined;
  }
  file.newText = newText;
}

function applyResult(state, callId) {
  if (state.applied.has(callId)) return;
  const result = state.results.get(callId);
  if (!result) return;
  const call = state.calls.get(callId);
  if (result.success && !call && result.diffs.length === 0) return;
  state.applied.add(callId);
  state.results.delete(callId);
  state.calls.delete(callId);
  if (!result.success) return;
  const paths = new Set();
  for (const diff of result.diffs) { paths.add(diff.path); addChange(state, diff); }
  if (!call || (call.name !== 'write' && call.name !== 'edit') || paths.has(call.path) || call.noChange) return;
  // edit 的替换片段不能冒充整份文件；write 也证明不了覆盖前的正文。
  addChange(state, { path: call.path, newText: call.newText });
}

function applyFact(state, fact) {
  if (fact.type === 'turn/start') state.complete = true;
  if (fact.type === 'request/header') {
    state.currentModel = fact.model;
    state.currentStep = typeof fact.step === 'number' ? fact.step : null;
    if (typeof fact.step === 'number') state.requests.set(fact.step, fact.model);
    if (fact.model && !sameModel(state.modelTrail[state.modelTrail.length - 1], fact.model)) state.modelTrail.push(fact.model);
  } else if (fact.type === 'assistant/message') {
    const model = typeof fact.step === 'number'
      ? (state.requests.has(fact.step) ? state.requests.get(fact.step) : (state.currentStep === null ? state.currentModel : null))
      : state.currentModel;
    if (fact.hasContent) state.actualModel = model;
  } else if (fact.type === 'tool/result' && fact.callId) {
    state.results.set(fact.callId, fact);
    applyResult(state, fact.callId);
  }
  for (const call of fact.calls || []) {
    if (state.applied.has(call.id)) continue;
    state.calls.set(call.id, call);
    applyResult(state, call.id);
  }
}

/** 授权历史与当前直播合并后，从去重的小记录重建事实，不重放原始正文。 */
function rebuildTurnFacts(state) {
  state.calls.clear(); state.results.clear(); state.applied.clear(); state.files.clear(); state.requests.clear();
  state.currentModel = null; state.currentStep = null; state.actualModel = null; state.modelTrail = []; state.complete = false;
  const ordered = [...state.events.values()].sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity));
  for (const saved of ordered) applyFact(state, saved);
  state.snapshot = null;
}

/** 新帧增量折叠；重连补回更早事件时按 seq 重建，已吸过的持久事件不再吸收。 */
function absorbTurnFact(state, event) {
  if (!event || !FACT_TYPES.has(event.type)) return;
  const seq = Number.isSafeInteger(event.seq) ? event.seq : null;
  const key = seq === null ? `live:${state.nextEvent++}` : seq;
  if (state.events.has(key)) return;
  const fact = eventFact(state, event);
  state.events.set(key, fact);
  if (seq !== null && seq < state.lastSeq) {
    rebuildTurnFacts(state);
  } else applyFact(state, fact);
  if (seq !== null) state.lastSeq = Math.max(state.lastSeq, seq);
  state.revision += 1;
  state.snapshot = null;
}

/** 按行求最短增删数。去公共首尾后限制计算量，超出就只交路径。 */
function lineChanges(oldText, newText) {
  if (oldText === newText) return { added: 0, removed: 0 };
  const lines = (text) => text === '' ? [] : text.split('\n');
  const oldLines = lines(oldText);
  const newLines = lines(newText);
  if (oldText.endsWith('\n')) oldLines.pop();
  if (newText.endsWith('\n')) newLines.pop();
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd -= 1; newEnd -= 1; }
  const removed = oldEnd - start;
  const added = newEnd - start;
  if (removed === 0 && added === 0 && oldText.endsWith('\n') !== newText.endsWith('\n')) return { added: 1, removed: 1 };
  if (removed === 0 || added === 0) return { added, removed };
  if (removed * added > LINE_WORK_MAX) return null;
  const row = new Uint32Array(added + 1);
  for (let i = start; i < oldEnd; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= added; j += 1) {
      const previous = row[j];
      row[j] = oldLines[i] === newLines[start + j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = previous;
    }
  }
  return { added: added - row[added], removed: removed - row[added] };
}

function changedFiles(state) {
  return [...state.files.values()].filter((file) => file.oldText === undefined || file.newText === undefined || file.oldText !== file.newText);
}

function turnFactsSnapshot(state) {
  if (state.snapshot) return state.snapshot;
  const files = changedFiles(state);
  state.snapshot = {
    ...(state.actualModel ? { actualModel: { ...state.actualModel } } : {}),
    modelTrail: state.modelTrail.map((model) => ({ ...model })),
    ...(state.truncated || !state.complete ? { changesTruncated: true } : {}),
    producedFiles: files.map((file) => file.path),
    fileChanges: files.map((file) => {
      const counts = state.complete && file.oldText !== undefined && file.newText !== undefined ? lineChanges(file.oldText, file.newText) : null;
      return { path: file.path, ...(counts && (counts.added || counts.removed) ? counts : {}) };
    }),
  };
  return state.snapshot;
}

function turnChangesSnapshot(state) {
  return {
    files: changedFiles(state).map((file) => ({
      path: file.path,
      ...(file.oldText !== undefined ? { oldText: file.oldText } : {}),
      ...(file.newText !== undefined ? { newText: file.newText } : {}),
    })),
    ...(state.truncated || !state.complete ? { truncated: true } : {}),
  };
}

function foldTurnFacts(entries) {
  const byTurn = new Map();
  const events = (entries || []).map((entry) => entry && entry.event ? entry.event : entry)
    .filter((event) => event && typeof event === 'object')
    .sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity));
  let currentTurn = null;
  for (const event of events) {
    const explicit = event.data && event.data.turn;
    if (typeof explicit === 'number') currentTurn = explicit;
    if (currentTurn === null) continue;
    let state = byTurn.get(currentTurn);
    if (!state) { state = createTurnFacts(); byTurn.set(currentTurn, state); }
    absorbTurnFact(state, event);
  }
  return byTurn;
}

module.exports = {
  createTurnFacts, absorbTurnFact, rebuildTurnFacts, foldTurnFacts, turnFactsSnapshot, turnChangesSnapshot,
  resultCallId, successfulResult, lineChanges, CHANGE_TEXT_MAX, CHANGE_TOTAL_MAX,
};

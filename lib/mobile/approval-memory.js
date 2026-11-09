'use strict';

/**
 * 审批记忆账：用户按「这一类以后都同意」放行过的动作类别，回在这里记一条。
 *
 * 为什么单独一本账：审批桥本身的挂起项全在内存里（宿主重启就没了），而「以后都同意」是一种
 * 跨会话、跨重启都要生效的持久偏好；它必须落盘，并且**能在 UI 里逐条撤销** —— 撤销权是这条
 * 功能成立的前提（用户点错了随时能收回），所以这里提供按 classKey 的删除。
 *
 * 同一份文件里还存**最近拒绝的理由**（`decisions`）：手机上拒绝时写的那句话只存在挂起项上会
 * 随结算一起消失，用户事后没有任何地方能回看自己为什么拒过，所以这里顺手记一条，设置页的
 * 「最近拒绝」直接读它。
 *
 * 落盘位置 `<DSH_HOME>/storages/mobile-plugin/approval-rules.json`，照任务账（task-ledger.js）
 * 同一套「原子写 + 读坏当空」的边界：账本读不动不能把审批拦在门外，写失败也只影响「重启后
 * 还在不在」。`DSH_MOBILE_APPROVAL_RULES` 只给测试注入路径用。
 */

const fs = require('node:fs');
const path = require('node:path');

const { dshHome } = require('../shared/paths.js');
// 只借一个纯函数判据（删除 / 推送 / 装软件这三类不给「以后都同意」），不反向依赖。
const { isIrreversibleClass } = require('./approval-facts.js');

const VERSION = 1;
/** 规则条数上限：纯兜底，超了挤掉最老的（规则很小，正常远到不了）。 */
const MAX_RULES = 500;
/** 拒绝记录条数上限：只给设置页回看用，留最近这些就够。 */
const MAX_DECISIONS = 30;

function rulesFile() {
  return process.env.DSH_MOBILE_APPROVAL_RULES
    || path.join(dshHome(), 'storages', 'mobile-plugin', 'approval-rules.json');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeRule(entry) {
  if (!isRecord(entry)) return null;
  const classKey = textOf(entry.classKey, 200);
  if (!classKey) return null;
  // 删除 / 推送 / 装软件这三类**永远不认**，读到也当没写过（见 approval-facts 的
  // `isIrreversibleClass`）：旧版本记下过 `bash:rm`，不清掉的话一次「以后都同意」会继续
  // 把任意 `rm` 静默放行。这里在加载口清洗，下一次写盘就把它们从文件里抹掉。
  if (isIrreversibleClass(classKey)) return null;
  return {
    classKey,
    label: textOf(entry.label, 120) || classKey,
    createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
  };
}

function emptyStore() {
  return { version: VERSION, updatedAt: 0, rules: [], decisions: [] };
}

/**
 * 一条拒绝记录。`reason` 可以为空（用户只点了拒绝没写理由）—— 那种也照记，设置页据此显示
 * 「拒过这条」；空理由在 UI 上只显示类别。
 */
function normalizeDecision(entry) {
  if (!isRecord(entry)) return null;
  const reason = textOf(entry.reason, 200);
  const classKey = textOf(entry.classKey, 200);
  const toolName = textOf(entry.toolName, 120);
  // 三样都空的记录没有任何信息量，读到了也当没写过。
  if (!reason && !classKey && !toolName) return null;
  return {
    sessionId: textOf(entry.sessionId, 200),
    approvalId: textOf(entry.approvalId, 200),
    toolName,
    classKey,
    reason,
    at: Number.isFinite(entry.at) ? entry.at : 0,
  };
}

/** 读账：文件不存在 / 读坏 / 形状不对一律当空，绝不抛。 */
function readStore() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(rulesFile(), 'utf8'));
  } catch {
    return emptyStore();
  }
  if (!isRecord(raw) || !Array.isArray(raw.rules)) return emptyStore();
  const rules = [];
  for (const entry of raw.rules) {
    const rule = normalizeRule(entry);
    if (rule) rules.push(rule);
  }
  const decisions = [];
  if (Array.isArray(raw.decisions)) {
    for (const entry of raw.decisions) {
      const decision = normalizeDecision(entry);
      if (decision) decisions.push(decision);
    }
  }
  return {
    version: VERSION,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    rules,
    decisions: newestFirst(decisions).slice(0, MAX_DECISIONS),
  };
}

/** 新到旧。`at` 缺失（老文件）的排最后，保持读到的相对顺序。 */
function newestFirst(list) {
  return list
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (b.entry.at - a.entry.at) || (a.index - b.index))
    .map((item) => item.entry);
}

/** 原子写：先写临时文件再 rename；写失败安静返回 false，不抛。 */
function saveStore(store) {
  const file = rulesFile();
  let rules = store.rules.slice();
  if (rules.length > MAX_RULES) {
    rules = rules.sort((a, b) => a.createdAt - b.createdAt).slice(rules.length - MAX_RULES);
  }
  const decisions = newestFirst(store.decisions || []).slice(0, MAX_DECISIONS);
  const next = { ...store, version: VERSION, updatedAt: Date.now(), rules, decisions };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** 列出全部规则（给撤销页）。 */
function listRules() {
  return readStore().rules.map((rule) => ({ classKey: rule.classKey, label: rule.label }));
}

/** 这一类是否已被允许。 */
function hasRule(classKey) {
  if (!classKey) return false;
  return readStore().rules.some((rule) => rule.classKey === classKey);
}

/** 记一条（已存在则更新 label，不重复）。不可记的类别直接拒（见 `normalizeRule`）。 */
function addRule({ classKey, label }) {
  const key = textOf(classKey, 200);
  if (!key) return false;
  if (isIrreversibleClass(key)) return false;
  const store = readStore();
  const at = store.rules.findIndex((rule) => rule.classKey === key);
  if (at >= 0) {
    store.rules[at] = { ...store.rules[at], label: textOf(label, 120) || store.rules[at].label };
  } else {
    store.rules.push({ classKey: key, label: textOf(label, 120) || key, createdAt: Date.now() });
  }
  return saveStore(store);
}

/** 撤一条。返回是否真的删掉了。 */
function removeRule(classKey) {
  const key = textOf(classKey, 200);
  if (!key) return false;
  const store = readStore();
  const next = store.rules.filter((rule) => rule.classKey !== key);
  if (next.length === store.rules.length) return false;
  store.rules = next;
  saveStore(store);
  return true;
}

/**
 * 记一条拒绝（理由落可查处）。调用方只在**手机自己拒绝**时写 —— 桌面端拒绝本桥看不到理由。
 * 返回是否落盘成功；落盘失败不影响这次拒绝本身。
 */
function recordDecision({ sessionId, approvalId, toolName, classKey, reason } = {}) {
  const decision = normalizeDecision({
    sessionId, approvalId, toolName, classKey, reason, at: Date.now(),
  });
  if (!decision) return false;
  const store = readStore();
  store.decisions = newestFirst([decision, ...store.decisions]).slice(0, MAX_DECISIONS);
  return saveStore(store);
}

/** 最近的拒绝记录（新到旧），给设置页的「最近拒绝」小节。 */
function listDecisions() {
  return readStore().decisions.map((decision) => ({
    sessionId: decision.sessionId,
    approvalId: decision.approvalId,
    toolName: decision.toolName,
    classKey: decision.classKey,
    reason: decision.reason,
    at: decision.at,
  }));
}

module.exports = {
  listRules,
  hasRule,
  addRule,
  removeRule,
  recordDecision,
  listDecisions,
};

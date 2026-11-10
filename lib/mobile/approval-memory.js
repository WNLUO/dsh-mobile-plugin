'use strict';

/**
 * 审批记忆账：用户按「这一类以后都同意」放行过的动作类别，回在这里记一条。
 *
 * 为什么单独一本账：审批桥本身的挂起项全在内存里（宿主重启就没了），而「以后都同意」是一种
 * 跨会话、跨重启都要生效的持久偏好；它必须落盘，并且**能在 UI 里逐条撤销** —— 撤销权是这条
 * 功能成立的前提（用户点错了随时能收回），所以这里提供按 classKey 的删除。
 *
 * 同一本账还带**最近的拒绝记录**：用户在审批卡上拒掉一条时把理由写下来，设置页的「最近拒绝」
 * 一节才有得对账（理由当时只在卡上闪一下，卡一结算就没了）。这份记录只给人看，不参与任何
 * 判定，所以只留最近若干条、超了挤掉最老的。
 *
 * 落盘位置 `<DSH_HOME>/storages/mobile-plugin/approval-rules.json`，照移动端那几份账本的
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
/** 拒绝记录上限：只是给人对账用的流水，留最近这些就够了。 */
const MAX_DECISIONS = 50;

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

/** 一条拒绝记录：形状不对的丢掉，读坏的文件不能把页面撑炸。 */
function normalizeDecision(entry) {
  if (!isRecord(entry)) return null;
  const classKey = textOf(entry.classKey, 200);
  if (!classKey) return null;
  const reason = textOf(entry.reason, 200);
  return {
    classKey,
    reason: reason || undefined,
    at: Number.isFinite(entry.at) ? entry.at : Date.now(),
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
  for (const entry of Array.isArray(raw.decisions) ? raw.decisions : []) {
    const decision = normalizeDecision(entry);
    if (decision) decisions.push(decision);
  }
  return {
    version: VERSION,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    rules,
    decisions,
  };
}

/** 原子写：先写临时文件再 rename；写失败安静返回 false，不抛。 */
function saveStore(store) {
  const file = rulesFile();
  let rules = store.rules.slice();
  if (rules.length > MAX_RULES) {
    rules = rules.sort((a, b) => a.createdAt - b.createdAt).slice(rules.length - MAX_RULES);
  }
  let decisions = (store.decisions || []).slice();
  if (decisions.length > MAX_DECISIONS) decisions = decisions.slice(decisions.length - MAX_DECISIONS);
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

/** 最近的拒绝记录（新的在前），给设置页「最近拒绝」那一节。 */
function listDecisions() {
  return readStore().decisions
    .slice()
    .sort((a, b) => b.at - a.at)
    .map((decision) => ({
      classKey: decision.classKey,
      reason: decision.reason,
      at: decision.at,
    }));
}

/**
 * 记一条拒绝。只给人对账用，不参与任何判定；缺 classKey 就不记（没有类别的行在页面上说不出
 * 是哪一类被拒），落盘失败也只影响这一条留不留得下来。
 */
function recordDecision({ classKey, reason } = {}) {
  const key = textOf(classKey, 200);
  if (!key) return false;
  const store = readStore();
  store.decisions.push({
    classKey: key,
    reason: textOf(reason, 200) || undefined,
    at: Date.now(),
  });
  return saveStore(store);
}

module.exports = {
  listRules,
  hasRule,
  addRule,
  removeRule,
  listDecisions,
  recordDecision,
};

'use strict';

/**
 * 成功路线记忆：把「这个 App 上一轮是怎么一步步做成的」记下来，下次打开同一个 App 时能翻出
 * 以前成功过的路线给模型参考。
 *
 * 存一份 JSON 在 `<DSH_HOME>/storages/mobile-plugin/phone-routes.json`，按包名分桶：
 *
 *   { "<包名>": [ { steps: [...], at: 1794…, hits: 0 } ] }   // 每个包最多 20 条
 *
 * 三条边界：
 * - **只在成功时记**：`record` 由调用方在结局判定为成功后调；失败、超时、取消一律不记。
 * - **每个包封顶 20 条**：旧记录满了就挤掉最旧的，避免一个常用 App 把文件越攒越大。
 * - **加载失败安静退化**：文件不存在、读坏、形状不对，都当「还没有记录」，绝不抛 —— 记忆是
 *   锦上添花，不能因为它把一次操作或者整个插件装载掀翻。
 */

const fs = require('node:fs');
const path = require('node:path');

const { dshHome } = require('../../shared/paths');

/** 每个包名最多留这么多条历史路线。 */
const MAX_PER_PACKAGE = 20;

/** 落盘文件：`<DSH_HOME>/storages/mobile-plugin/phone-routes.json`，调用时解析。 */
function routesFile() {
  return path.join(dshHome(), 'storages', 'mobile-plugin', 'phone-routes.json');
}

/** 只保留能落盘、也有意义的字段，别把整个 args 原样塞进去（可能很大）。 */
function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  const out = [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const entry = {};
    if (typeof step.action === 'string' && step.action.trim()) entry.action = step.action.trim();
    if (step.args && typeof step.args === 'object' && !Array.isArray(step.args)) entry.args = step.args;
    if (step.until && typeof step.until === 'object' && !Array.isArray(step.until)) entry.until = step.until;
    if (entry.action) out.push(entry);
  }
  return out;
}

/** 读整份账本。读不到 / 读坏 / 形状不对都当空。 */
function readStore() {
  let raw;
  try {
    raw = fs.readFileSync(routesFile(), 'utf8');
  } catch {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed;
}

/** 写整份账本。写不进去就安静放弃：这一轮照样算完成，只是这条没记住。 */
function writeStore(store) {
  const file = routesFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
}

/** 归一化包名。 */
function normalizePackage(packageName) {
  return typeof packageName === 'string' ? packageName.trim() : '';
}

/**
 * 记一条成功路线。只在成功时由调用方调；包名为空或步骤为空时不记。
 * 返回这个包当前的全部记录（方便调用方/测试看结果）。
 */
function record(packageName, steps) {
  const pkg = normalizePackage(packageName);
  const cleaned = normalizeSteps(steps);
  if (!pkg || cleaned.length === 0) return [];

  const store = readStore();
  const bucket = Array.isArray(store[pkg]) ? store[pkg].filter((item) => item && Array.isArray(item.steps)) : [];
  bucket.push({ steps: cleaned, at: Date.now(), hits: 0 });
  // 只留最近的 MAX_PER_PACKAGE 条：新记录在尾部，超了从头挤掉最旧的。
  store[pkg] = bucket.slice(-MAX_PER_PACKAGE);
  try {
    writeStore(store);
  } catch {
    // 写失败不抛，记忆丢一条不影响这一轮已经成功的结果。
  }
  return store[pkg].map(copyRecord);
}

function copyRecord(item) {
  return {
    steps: Array.isArray(item.steps) ? item.steps.map((step) => ({ ...step })) : [],
    at: Number.isFinite(item.at) ? item.at : 0,
    hits: Number.isFinite(item.hits) ? item.hits : 0,
  };
}

/**
 * 读回某个 App 以前成功过的路线（按记录先后，旧的在前）。包名为空或没记录都回空数组。
 * 返回的是副本，调用方改不到账本上。
 */
function list(packageName) {
  const pkg = normalizePackage(packageName);
  if (!pkg) return [];
  const store = readStore();
  const bucket = Array.isArray(store[pkg]) ? store[pkg] : [];
  return bucket.filter((item) => item && Array.isArray(item.steps)).map(copyRecord);
}

/** 单测用：删掉落盘文件，回到「还没有任何记录」。 */
function resetForTest() {
  try {
    fs.rmSync(routesFile(), { force: true });
  } catch {
    // 本来就没有。
  }
}

module.exports = {
  routesFile,
  record,
  list,
  resetForTest,
  MAX_PER_PACKAGE,
};

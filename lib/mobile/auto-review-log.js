'use strict';

/**
 * 自动审阅档的判定账本：自动放行 / 推卡过哪几次，连同当时看到的事实。
 *
 * ## 为什么落盘，而不是写进会话日志
 *
 * 判定记录天然是「旁路」：它只用于事后翻账（「刚才那条命令怎么没弹卡」），不参与任何派生子
 * 逻辑。可会话日志是宿主的严格结构 —— `dsh-session-persistence` 读盘时遇到不认识的事件类型
 * 且没标 ignorable，会直接拒绝解释整份日志。一条自定义事件写进去，`try/catch` 兜不住，
 * 代价是这条会话重启后可能整份打不开。所以记录落在插件自己的存储里
 * （`<DSH_HOME>/storages/mobile-plugin/auto-review-log.json`），跟着机器走，不进任何一条对话，
 * 宿主怎么读怎么写都碰不到它。
 *
 * ## 条目形状
 *
 *   { at, sessionId, action, verdict, decidedBy, targetMode, toolName, callId, fact }
 *
 *   - `action`：`allow` / `card`（本档不产 `reject`，见 `auto-review.js` 文件头）。
 *   - `verdict`：`within` / `boundary` / `unsure`；`decidedBy` 是谁拍的板
 *     （`judge` 判定、`watching` 有人看着、`structure` 越界结构、`facts` 拿不到真实参数）。
 *   - `fact`：判定当时看到的事实行，说明「凭什么这么判」。
 *
 * ## 三条边界
 *
 * - **只追加、只留最近 N 条**：这是账，不是状态机；超了挤掉最老的，没人需要它无限长。
 * - **读坏当空、写坏不抛**：文件不在 / 读一半 / 形状不对一律当「还没记过」，绝不抛。
 *   记账坏了不该影响正在跑的判定。
 * - **路径可覆盖仅供测试**：`DSH_MOBILE_AUTO_REVIEW_LOG` 与 task-ledger 的
 *   `DSH_MOBILE_TASK_LEDGER` 同一口径，生产不设。
 */

const fs = require('node:fs');
const path = require('node:path');

const { dshHome } = require('../shared/paths.js');

/** 账本格式版本：将来改结构时据此决定丢弃还是迁移。 */
const VERSION = 1;

/** 最多留最近多少条。判定本身很稀疏（只有没人看时才记一笔），200 条够翻很久。 */
const MAX_ITEMS = 200;

const MAX_TEXT = 400;

/** 账本文件。路径每次调用时解析，测试可注入 DSH_HOME 或直接给路径。 */
function logFile() {
  return process.env.DSH_MOBILE_AUTO_REVIEW_LOG
    || path.join(dshHome(), 'storages', 'mobile-plugin', 'auto-review-log.json');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 收窄成单行字符串：账本是给人扫一眼的，换行与连续空白在这里没有意义。 */
function textOf(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 一条记录的清洗：认不出的字段归空，形状不对整条丢。 */
function normalizeEntry(raw) {
  if (!isRecord(raw)) return null;
  const at = Number.isFinite(raw.at) && raw.at > 0 ? raw.at : 0;
  const action = textOf(raw.action, 32);
  if (!at || !action) return null;
  return {
    at,
    sessionId: textOf(raw.sessionId, 200),
    action,
    verdict: textOf(raw.verdict, 32),
    decidedBy: textOf(raw.decidedBy, 32),
    targetMode: textOf(raw.targetMode, 32) || null,
    toolName: textOf(raw.toolName, 80) || null,
    callId: textOf(raw.callId, 120) || null,
    fact: textOf(raw.fact, MAX_TEXT),
  };
}

function emptyLog() {
  return { version: VERSION, items: [] };
}

/** 读账。文件不存在 / 读不动 / JSON 坏了 / 形状不对，一律当空，绝不抛。 */
function readLog() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(logFile(), 'utf8'));
  } catch {
    return emptyLog();
  }
  if (!isRecord(raw) || !Array.isArray(raw.items)) return emptyLog();
  const items = [];
  for (const entry of raw.items) {
    const normalized = normalizeEntry(entry);
    if (normalized) items.push(normalized);
  }
  return { version: VERSION, items };
}

/**
 * 原子写：先写临时文件再 rename。宿主随时可能被杀，半个 JSON 会让整本账从此读不出来。
 * 写失败安静放弃，返回 false，不抛。
 */
function saveLog(log) {
  const file = logFile();
  const next = { version: VERSION, items: log.items };
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

/** 追加一条。返回是否落盘（旁路，调用方不该因此改行为）。 */
function append(entry) {
  const source = isRecord(entry) ? entry : {};
  const normalized = normalizeEntry({ ...source, at: Date.now() });
  if (!normalized) return false;
  const log = readLog();
  log.items.push(normalized);
  if (log.items.length > MAX_ITEMS) log.items = log.items.slice(log.items.length - MAX_ITEMS);
  return saveLog(log);
}

/**
 * 按会话翻账，最近的在前。不给 `sessionId` 就是全部。
 * `limit` 缺省给一小把（翻账的时机通常是「刚才那一条」）。
 */
function list(sessionId, limit) {
  const id = textOf(sessionId, 200);
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
  const items = readLog().items;
  const picked = id ? items.filter((item) => item.sessionId === id) : items;
  return picked.slice(-max).reverse();
}

/** 测试用：清掉落盘文件，回到「还没记过」。 */
function resetForTest() {
  try {
    fs.rmSync(logFile(), { force: true });
  } catch {
    // 本来就没有。
  }
}

module.exports = {
  VERSION,
  MAX_ITEMS,
  logFile,
  readLog,
  append,
  list,
  resetForTest,
};

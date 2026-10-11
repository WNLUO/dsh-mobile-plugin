'use strict';

/**
 * 「已读回执」台账：手机端读过哪个会话，桌面端据此清掉自己的未读绿点。
 *
 * 背景：两端侧边栏的绿点来自**两份互不相干**的状态。
 *   - 手机端绿点 = 宿主按设备维度维护的完成提醒（lib/mobile/completion.js），
 *     由 `POST /api/mobile/v1/session/read` 清掉；
 *   - 桌面端绿点 = 浏览器渲染进程内存里的 `UiSession.completionUnread`
 *     （@deepseek-ai/dsh-client-ui-session），既不落盘也不过服务端。
 * 所以手机上点开一个会话，桌面那份完全不知情，绿点照旧。
 *
 * 这里补的就是这条缺失的通道：手机端每点开一个会话，宿主除了清自己那份提醒，
 * 还往本模块记一条 `sessionId → readAt` 水位；插件的客户端半边
 * （lib/client.js 的 startReadReceiptSync）每 2 秒拉一次 `GET /api/relay/read-receipt`，
 * 对水位前进过的会话做一次瞬时 `sessions.retain(id, { source: 'mainView' })` +
 * `release()`，借桌面自己的 `reconcileStatus()` 把 `completionUnread` 摘掉。
 *
 * 为什么存 readAt 而不是一个「已读」布尔：冲突策略是 last-write-wins。
 * 桌面点开 → 客户端半边把该会话 POST 回 `/api/relay/desktop-read` → 宿主清掉
 * **所有设备**维度上的完成提醒（`clearCompletionForAllDevices`）。而「读完又来一轮」
 * 必须还能重新亮起来 —— 这一条由 completion.js 的 delete 语义本身保证：条目被清掉后
 * 重建出来的 `wasRunning` 是 false，历史折叠会拒绝确认，于是只有**之后**真正跑完的
 * 轮次才会把 completed 重新置真。
 */

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./shared/paths');

/** 单个 sessionId 长度上限；超长的一律丢弃（真实 id 只有十几字节）。 */
const MAX_ID_LENGTH = 200;
/** 台账条目数上限：超出时按 readAt 保留最新的，防止文件无限增长。 */
const MAX_ENTRIES = 512;

/** 台账文件：$DSH_HOME/read-receipts.json（DSH_HOME 在调用时解析，便于测试注入）。 */
function stateFile() {
  return path.join(paths.dshHome(), 'read-receipts.json');
}

/** null = 台账还没写过任何一条；否则 { readAt: { [sessionId]: number } }。 */
let cached = null;
let loaded = false;

/**
 * 归一化台账：只保留「合法的 sessionId → 有限正数 readAt」，并按 readAt 截到 MAX_ENTRIES。
 * 形状不对返回 null（调用方按「还没有台账」处理，不报错）。
 */
function normalizeReceipts(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const entries = [];
  for (const rawKey of Object.keys(input)) {
    const value = input[rawKey];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    const key = rawKey.trim();
    if (!key || key.length > MAX_ID_LENGTH) continue;
    entries.push([key, value]);
  }
  entries.sort((a, b) => b[1] - a[1]);
  const out = {};
  for (const [key, value] of entries.slice(0, MAX_ENTRIES)) out[key] = value;
  return out;
}

function load() {
  if (loaded) return cached;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const readAt = normalizeReceipts(raw && raw.readAt);
    if (!readAt) {
      cached = null;
      return cached;
    }
    cached = { readAt };
  } catch {
    // 文件不存在 / 损坏都按「还没有台账」处理：客户端半边这轮就什么都不做。
    cached = null;
  }
  return cached;
}

/** 当前台账的副本；从未写过时返回 null。 */
function snapshot() {
  const value = load();
  if (!value) return null;
  return { readAt: { ...value.readAt } };
}

function persist(readAt) {
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ readAt }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  cached = { readAt };
  loaded = true;
}

/**
 * 记一条已读：`sessionId` 在 `now` 被读过。返回 `{ sessionId, readAt, changed }`。
 *
 * 水位**只前进不后退**：`now` 不比已记的小就保留原值，`changed` 为 false。
 * 这样客户端半边可以拿「本地见过的最大 readAt」当游标，重复读同一个会话不会
 * 反复触发桌面侧的清除动作。
 */
function recordRead(sessionId, now = Date.now()) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id || id.length > MAX_ID_LENGTH) {
    return { sessionId: id, readAt: 0, changed: false };
  }
  const at = Number.isFinite(now) && now > 0 ? now : Date.now();
  const current = load();
  const previous = current ? current.readAt[id] : undefined;
  if (typeof previous === 'number' && previous >= at) {
    return { sessionId: id, readAt: previous, changed: false };
  }
  const next = { ...(current ? current.readAt : {}), [id]: at };
  const pruned = normalizeReceipts(next);
  persist(pruned || { [id]: at });
  return { sessionId: id, readAt: at, changed: true };
}

module.exports = { stateFile, snapshot, recordRead };

'use strict';

/**
 * 「这条会话操作哪台手机」的绑定账。
 *
 * 规则只有一条：**会话第一次收到某台手机发来的消息时，把会话绑到那台手机上**，之后不管
 * 用户在 B 手机还是平板上继续聊，都还是操作 A。绑定要落盘 —— 宿主重启、插件热替换之后
 * 它还在，否则用户第二天回来会发现任务跑到另一台手机上去了。
 *
 * 另记一本「最近一次发消息的是谁」。它不进绑定，只用来在两件事上有话可说：
 *
 *  1. 工具执行时发现「这一轮来自 B、绑着 A」，就把这件事交给模型，让它问一句要不要改绑，
 *     而不是闷头操纵 A；
 *  2. 没有任何绑定的老会话（这个功能上线之前就存在的对话）第一次要操作手机时，按最近一次
 *     发消息的那台算，而不是干等。
 *
 * 显式改绑走 `setBinding`（模型调 `phone_target`），它只改绑定，不改最近发消息的人 ——
 * 后者是事实，改了就成了编。
 *
 * 两本账都按 sessionId 存，条目上限与已读回执同一量级：会话被删掉时这里不会跟着删
 * （宿主不知道），只按最近活动淘汰，留着一条指向已删会话的记录只是几百字节。
 */

const fs = require('node:fs');
const path = require('node:path');
const paths = require('../../shared/paths');

/** sessionId 与 deviceId 的长度上限（真实值都是 UUID 量级）。 */
const MAX_ID = 200;
/** 条目上限：按 lastAt 保留最新的。 */
const MAX_ENTRIES = 2000;

/** 文件：`$DSH_HOME/phone-bindings.json`。DSH_HOME 在调用时解析，测试可注入。 */
function stateFile() {
  return path.join(paths.dshHome(), 'phone-bindings.json');
}

/** null = 还没写过；否则 `{ [sessionId]: { bound, boundAt, last, lastAt } }`。 */
let table = null;

function load() {
  if (table) return table;
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    table = raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object'
      ? raw.sessions
      : {};
  } catch {
    table = {};
  }
  return table;
}

function text(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_ID) : '';
}

/** 只留合法形状，并按 lastAt 截断 —— 盘上的文件可能是旧版本或被人手改过。 */
function normalize(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const bound = text(entry.bound);
  const last = text(entry.last);
  if (!bound && !last) return null;
  const boundAt = Number.isFinite(entry.boundAt) ? entry.boundAt : 0;
  const lastAt = Number.isFinite(entry.lastAt) ? entry.lastAt : 0;
  return { bound, boundAt, last, lastAt };
}

function persist() {
  const entries = Object.entries(load())
    .map(([id, entry]) => [id, normalize(entry)])
    .filter(([, entry]) => entry);
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => (b[1].lastAt || b[1].boundAt) - (a[1].lastAt || a[1].boundAt));
    entries.length = MAX_ENTRIES;
  }
  const sessions = Object.fromEntries(entries);
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    const tmp = `${stateFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions }), 'utf8');
    fs.renameSync(tmp, stateFile());
  } catch {
    // 落盘失败不该让一次动作中断：内存里那份仍然是对的，下一次写再试。
  }
}

function entryOf(sessionId) {
  const id = text(sessionId);
  if (!id) return null;
  return normalize(load()[id]);
}

/** 这条会话绑在哪台手机上；没有绑定时为 null。 */
function boundDeviceOf(sessionId) {
  const entry = entryOf(sessionId);
  return entry && entry.bound ? entry.bound : null;
}

/** 最近一次给这条会话发消息的是哪台手机；没有记录时为 null。 */
function lastSenderOf(sessionId) {
  const entry = entryOf(sessionId);
  return entry && entry.last ? entry.last : null;
}

/**
 * 记一次「这台手机发来了消息」。**同时**在会话还没有绑定时把它绑上去。
 *
 * 只有 deviceId 非空才动账：没带设备头的调用（桌面端、测试、老客户端）不该把一条已经绑好
 * 的会话改成「未绑定」，也不该把新会话绑到一台认不出的设备上。
 *
 * @returns {{bound: string, changed: boolean}} changed 表示这一次真的建立了绑定
 */
function noteSender(sessionId, deviceId, now = Date.now()) {
  const id = text(sessionId);
  const device = text(deviceId);
  const current = entryOf(id);
  if (!id || !device) return { bound: current ? current.bound : '', changed: false };
  const entry = current || { bound: '', boundAt: 0, last: '', lastAt: 0 };
  const changed = !entry.bound;
  if (changed) {
    entry.bound = device;
    entry.boundAt = now;
  }
  entry.last = device;
  entry.lastAt = now;
  load()[id] = entry;
  persist();
  return { bound: entry.bound, changed };
}

/**
 * 显式改绑（模型调 `phone_target`）。只改 bound，`last` 原样留着。
 *
 * @returns {boolean} 有没有真的写下去（空 deviceId 一律拒）
 */
function setBinding(sessionId, deviceId, now = Date.now()) {
  const id = text(sessionId);
  const device = text(deviceId);
  if (!id || !device) return false;
  const entry = entryOf(id) || { bound: '', boundAt: 0, last: '', lastAt: 0 };
  entry.bound = device;
  entry.boundAt = now;
  if (!entry.lastAt) entry.lastAt = now;
  load()[id] = entry;
  persist();
  return true;
}

/**
 * 从一次请求里认出「发消息的是哪台手机」，记进账。
 *
 * 挂在**发送成功之后**：发失败的那一发什么都没发生，拿它当「用户在这台手机上说话」会让一条
 * 会话被一条没送达的消息绑到某台机器上。没带设备头的调用（桌面端、老客户端、测试）落在
 * `legacy`，那不是任何一台手机，一律不记 —— 记了就会把已经绑好的账改成别的。
 *
 * 失败绝不影响调用方：绑定只是「下次操作哪台手机」的默认值，记账出错不该让一条已经交出去的
 * 消息报失败。
 */
function noteRequestSender(req, sessionId) {
  try {
    const raw = req && req.headers ? req.headers['x-dsh-device'] : undefined;
    const deviceId = text(Array.isArray(raw) ? raw[0] : raw);
    if (!deviceId) return;
    noteSender(sessionId, deviceId);
  } catch { /* 绑定账写不进去不影响这一发 */ }
}

/**
 * 某台手机不再被操作时（用户解除配对），把**指向它**的绑定一条条清掉。
 *
 * 只清 `bound` 指向它的那些；`last` 也指向它的不动 —— 那是「谁发过消息」的事实，不该因为
 * 解绑就变成另一台。清掉之后这条会话回到「没有绑定」，下一次发消息的设备会重新绑上。
 *
 * @returns {number} 清了几条
 */
function clearBindingForDevice(deviceId, now = Date.now()) {
  const device = text(deviceId);
  if (!device) return 0;
  const state = load();
  let removed = 0;
  for (const [id, entry] of Object.entries(state)) {
    const normalized = normalize(entry);
    if (!normalized || normalized.bound !== device) continue;
    normalized.bound = '';
    normalized.boundAt = 0;
    if (!normalized.last) { delete state[id]; continue; }
    normalized.lastAt = normalized.lastAt || now;
    state[id] = normalized;
    removed += 1;
  }
  if (removed) persist();
  return removed;
}

/** 会话被删 / 用户主动解绑时清掉。 */
function clearBinding(sessionId) {
  const id = text(sessionId);
  if (!id) return false;
  const state = load();
  if (!(id in state)) return false;
  delete state[id];
  persist();
  return true;
}

/**
 * 这一次要操作哪台手机。
 *
 * 顺序：显式 target（调用方本次传入）→ 绑定 → 最近一次发消息的那台。三者都没有就是
 * `null` —— 调用方必须把这当成「没有目标」报出来，**不许**拿「随便挑一台在线的」顶上：
 * 那会让一条对话在用户不知情时去操作另一台手机。
 *
 * @returns {{deviceId: string, from: 'explicit'|'bound'|'sender'|'', changed: boolean}}
 */
function resolveTarget(sessionId, explicit) {
  const wanted = text(explicit);
  if (wanted) {
    const current = boundDeviceOf(sessionId);
    const changed = current !== wanted;
    if (changed) setBinding(sessionId, wanted);
    return { deviceId: wanted, from: 'explicit', changed };
  }
  const bound = boundDeviceOf(sessionId);
  if (bound) return { deviceId: bound, from: 'bound', changed: false };
  const sender = lastSenderOf(sessionId);
  if (sender) return { deviceId: sender, from: 'sender', changed: true };
  return { deviceId: '', from: '', changed: false };
}

/** 测试用：丢掉内存里那份（下一个用例重新从盘上读）。 */
function resetForTest() {
  table = null;
}

module.exports = {
  stateFile,
  boundDeviceOf,
  lastSenderOf,
  noteSender,
  noteRequestSender,
  setBinding,
  clearBinding,
  clearBindingForDevice,
  resolveTarget,
  resetForTest,
};

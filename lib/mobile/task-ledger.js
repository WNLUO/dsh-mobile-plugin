'use strict';

/**
 * 任务账：手上还挂着几件事、每件到哪一步、哪个在等人答。
 *
 * ## 为什么单独一本账，不写在会话历史里
 *
 * 会话历史归宿主管，一轮长了会被压缩，细节说没就没。而「他手上有哪几件事」正是最不能丢的
 * 那类信息 —— 新开一通电话，总管一开口就该知道昨天定的那三件事还在不在。所以这份账落在
 * 插件自己的存储里（`<DSH_HOME>/storages/mobile-plugin/task-ledger.json`），跟着机器走，
 * 不进任何一条对话，宿主怎么压缩都动不到它。
 *
 * ## 条目形状
 *
 *   { id: 't1a2b3c4', sessionId: '', title: '修侧栏绿点', step: '在改缓存', status: 'waiting',
 *     waiting: 'approval', note: '', createdAt, updatedAt, doneAt }
 *
 * `sessionId` 是这件事挂在哪条会话上，同一个会话再更新时按它合并，不会多出一条；手动记的
 * 事可以没有会话。`status` 三档：`open`（挂着 / 在做）、`waiting`（在等人）、`done`（完了）。
 * `waiting` 是「在等什么」，与 `status` 分开是因为「做完了但还没人确认」和「卡在审批上」
 * 不是一回事，合成一格会说糊。
 *
 * ## 两条边界
 *
 * - **删是人的动作**：这里没有删除接口，挂了的事永远留着，只会被标成 `done`。存储兜底
 *   （`MAX_ITEMS`）只挤掉**已经完成**的最老条目，一条挂着的都不动 —— 这正是「永不删」的
 *   意思。手动记的事若真写错了，改 `title` / `step` 就是，条目本身不该消失。
 * - **读坏当空、写坏不抛**：文件不存在、读一半、形状不对，一律当「还没有账」，绝不抛。
 *   账本是给人看的辅助，不能因为它把一通电话拦在门外。写失败只影响「重启后还在不在」，
 *   当前这一轮内存里读到的是刚改过的那份。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { dshHome } = require('../shared/paths.js');

/** 账本格式版本：将来改结构时据此决定丢弃还是迁移。 */
const VERSION = 1;

/**
 * 条目条数上限：**只是存储兜底**，不是展示口径。
 *
 * 超了只挤掉「已完成」里最老的那几条，挂着的（`open` / `waiting`）一条都不删。所以真到了
 * 上限而挂着的条目还很多，文件就继续长 —— 宁可多几 KB，也不能把用户手上正在做的事删掉。
 */
const MAX_ITEMS = 200;

const MAX_TITLE = 120;
const MAX_STEP = 120;
const MAX_NOTE = 400;
const MAX_SESSION_TEXT = 200;

/** 一次给总管报账最多说几行：电话里念多了没人听。 */
const BRIEF_MAX_LINES = 8;

/** 三档状态。`waiting` 是「挂着等别人」，不是「在跑」。 */
const STATUSES = Object.freeze(['open', 'waiting', 'done']);

/** 在等谁 / 等什么。前三种与审批、提问桥的取值一致，`person` 是「等用户本人给个话」。 */
const WAITING_KINDS = Object.freeze(['approval', 'question', 'plan-review', 'person']);

/** 账本文件。`DSH_MOBILE_TASK_LEDGER` 只给测试用；路径在每次调用时解析，测试可注入 DSH_HOME。 */
function ledgerFile() {
  return process.env.DSH_MOBILE_TASK_LEDGER
    || path.join(dshHome(), 'storages', 'mobile-plugin', 'task-ledger.json');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 收窄成单行字符串：任务账是为了念出来的，换行与连续空白在这里没有意义。 */
function textOf(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function statusOf(value) {
  return STATUSES.includes(value) ? value : 'open';
}

function waitingOf(value) {
  return WAITING_KINDS.includes(value) ? value : null;
}

/** 新条目的编号：`t` + 8 位小写十六进制，用户念得出来（与文章编号同一套口径）。 */
function newId() {
  return `t${crypto.randomBytes(4).toString('hex')}`;
}

/** 一条记录的清洗：认不出的字段一律丢，不认识的形状整条丢。 */
function normalizeItem(raw) {
  if (!isRecord(raw)) return null;
  const title = textOf(raw.title, MAX_TITLE);
  if (!title) return null;
  const createdAt = Number.isFinite(raw.createdAt) && raw.createdAt > 0 ? raw.createdAt : 0;
  const updatedAt = Number.isFinite(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : createdAt;
  const doneAt = Number.isFinite(raw.doneAt) && raw.doneAt > 0 ? raw.doneAt : 0;
  const status = statusOf(raw.status);
  return {
    id: textOf(raw.id, 40) || newId(),
    sessionId: textOf(raw.sessionId, MAX_SESSION_TEXT),
    sessionTitle: textOf(raw.sessionTitle, MAX_TITLE),
    title,
    step: textOf(raw.step, MAX_STEP),
    status,
    // 已经做完的事不该还写着「在等谁」：两格自相矛盾会让总管念错。
    waiting: status === 'done' ? null : waitingOf(raw.waiting),
    note: textOf(raw.note, MAX_NOTE),
    createdAt,
    updatedAt,
    doneAt,
  };
}

/** 空账本。 */
function emptyLedger() {
  return { version: VERSION, updatedAt: 0, items: [] };
}

/**
 * 读账本。文件不存在 / 读不动 / JSON 坏了 / 形状不对，一律当空，绝不抛。
 *
 * 不做模块级缓存：这份文件小，而且调用点都是「要开口之前读一眼」这种稀疏时机；缓存反而会
 * 让测试里换 DSH_HOME 之后读到上一份。
 */
function readLedger() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(ledgerFile(), 'utf8'));
  } catch {
    return emptyLedger();
  }
  if (!isRecord(raw) || !Array.isArray(raw.items)) return emptyLedger();
  const items = [];
  for (const entry of raw.items) {
    const item = normalizeItem(entry);
    if (item) items.push(item);
  }
  return {
    version: VERSION,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    items,
  };
}

/** 裁剪：只挤掉已完成里最老的那几条，挂着的条目一条都不动（见 `MAX_ITEMS` 的说明）。 */
function trimItems(ledger) {
  if (ledger.items.length <= MAX_ITEMS) return;
  const done = ledger.items
    .filter((item) => item.status === 'done')
    .sort((a, b) => (a.doneAt || a.updatedAt) - (b.doneAt || b.updatedAt));
  let overflow = ledger.items.length - MAX_ITEMS;
  const drop = new Set();
  for (const item of done) {
    if (overflow <= 0) break;
    drop.add(item.id);
    overflow -= 1;
  }
  if (drop.size === 0) return;
  ledger.items = ledger.items.filter((item) => !drop.has(item.id));
}

/**
 * 原子写：先写临时文件再 rename。
 *
 * 宿主随时可能被杀，半个 JSON 会让整本账从此读不出来（读坏当空 = 手上那几件事当场全没）。
 * 写失败安静放弃，返回 false 让调用方知道，但不抛 —— 这一轮已经读到的内容照样能用。
 */
function saveLedger(ledger) {
  const file = ledgerFile();
  const next = { ...ledger, version: VERSION, updatedAt: Date.now() };
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

/** 按 id 或会话 id 找一条。两个都给时先认 id。 */
function indexOf(ledger, { id, sessionId }) {
  if (id) {
    const byId = ledger.items.findIndex((item) => item.id === id);
    if (byId >= 0) return byId;
  }
  if (sessionId) return ledger.items.findIndex((item) => item.sessionId === sessionId);
  return -1;
}

/**
 * 记一件事 / 更新一件事。**给什么改什么**，没给的字段一律不动。
 *
 * 认领顺序：`id` → `sessionId`。所以「这条会话进展到哪一步」只要带 `sessionId` 就能一直
 * 合到同一条上，调用方不用记编号。新建时必须有 `title`。
 *
 * @returns {{item: object, created: boolean}|null} 新建却缺标题时回 null
 */
function upsertTask(input) {
  const source = isRecord(input) ? input : {};
  const ledger = readLedger();
  const now = Date.now();
  const at = indexOf(ledger, {
    id: textOf(source.id, 40),
    sessionId: textOf(source.sessionId, MAX_SESSION_TEXT),
  });

  if (at >= 0) {
    const previous = ledger.items[at];
    const next = { ...previous };
    const title = textOf(source.title, MAX_TITLE);
    if (title) next.title = title;
    if (typeof source.step === 'string') next.step = textOf(source.step, MAX_STEP);
    if (typeof source.note === 'string') next.note = textOf(source.note, MAX_NOTE);
    if (typeof source.sessionTitle === 'string' && source.sessionTitle.trim()) {
      next.sessionTitle = textOf(source.sessionTitle, MAX_TITLE);
    }
    if (typeof source.sessionId === 'string' && !next.sessionId) next.sessionId = textOf(source.sessionId, MAX_SESSION_TEXT);
    if (source.status !== undefined) next.status = statusOf(source.status);
    if (source.waiting !== undefined) next.waiting = waitingOf(source.waiting);
    if (next.status === 'done') {
      next.waiting = null;
      next.doneAt = previous.doneAt || now;
    } else {
      next.doneAt = 0;
    }
    next.updatedAt = now;
    ledger.items[at] = next;
    saveLedger(ledger);
    return { item: next, created: false };
  }

  const title = textOf(source.title, MAX_TITLE);
  if (!title) return null;
  const status = statusOf(source.status);
  const item = {
    id: textOf(source.id, 40) || newId(),
    sessionId: textOf(source.sessionId, MAX_SESSION_TEXT),
    sessionTitle: textOf(source.sessionTitle, MAX_TITLE),
    title,
    step: textOf(source.step, MAX_STEP),
    status,
    waiting: status === 'done' ? null : waitingOf(source.waiting),
    note: textOf(source.note, MAX_NOTE),
    createdAt: now,
    updatedAt: now,
    doneAt: status === 'done' ? now : 0,
  };
  ledger.items.push(item);
  trimItems(ledger);
  saveLedger(ledger);
  return { item, created: true };
}

/**
 * 按会话进度更新：**只改已经在账上的会话**，没记过的不新建。
 *
 * 这条边界是刻意的：会话一多，每条都自动记一笔的话这本账立刻变成会话清单，而它要回答的是
 * 「他手上挂着哪几件事」。所以「要不要把这条会话摆上账」是人的决定（或者总管自己决定），
 * 之后进度由这里跟。`create` 打开时才新建，给工具层显式记账用。
 */
function updateFromSession(sessionId, patch) {
  const id = textOf(sessionId, MAX_SESSION_TEXT);
  if (!id) return null;
  const source = isRecord(patch) ? patch : {};
  const located = indexOf(readLedger(), { sessionId: id });
  if (located < 0 && source.create !== true) return null;
  return upsertTask({ ...source, sessionId: id });
}

/** 标完成。已经在完成状态的重复点一下不改时间。 */
function settleTask(id) {
  return upsertTask({ id: textOf(id, 40), status: 'done', waiting: null });
}

/** 挂起等人：`status` 跟着变成 `waiting`，两格一起动，别让它们对不上。 */
function markWaiting(sessionId, kind) {
  return updateFromSession(sessionId, { status: 'waiting', waiting: kind });
}

/** 等人这件事办完了：回到 `open`，把「在等谁」清掉。 */
function clearWaiting(sessionId) {
  return updateFromSession(sessionId, { status: 'open', waiting: null });
}

/** 挂着的条目：先 `waiting`（在等人答的最要紧），再按更新时间倒序 —— 与报账顺序同一套。 */
function openItems() {
  const ledger = readLedger();
  const live = ledger.items.filter((item) => item.status !== 'done');
  live.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'waiting' ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
  return live;
}

/** 各档条数。给总管一句话概括用。 */
function counts() {
  const ledger = readLedger();
  const out = { open: 0, waiting: 0, done: 0 };
  for (const item of ledger.items) out[statusOf(item.status)] += 1;
  return out;
}

const WAITING_TEXT = {
  approval: '在等你审批',
  question: '在等你回答',
  'plan-review': '在等你过方案',
  person: '在等你一句话',
};

/** 一条念出来是什么样。 */
function lineOf(item) {
  const parts = [item.title];
  if (item.status === 'waiting' && item.waiting) parts.push(WAITING_TEXT[item.waiting]);
  else if (item.step) parts.push(item.step);
  if (item.note) parts.push(item.note);
  return parts.join('，');
}

/**
 * 给总管读的几行字。空账本回空数组（调用方据此什么都不说，而不是念一句「没有任务」）。
 *
 * 只列挂着的：做完的事不占电话里的时间，但它们仍在账上（`done` 那条永不删，手机上要看得到）。
 */
function briefLines(limit = BRIEF_MAX_LINES) {
  const live = openItems();
  if (live.length === 0) return [];
  const max = Number.isFinite(limit) && limit > 0 ? limit : BRIEF_MAX_LINES;
  const shown = live.slice(0, max);
  const lines = shown.map((item, index) => `${index + 1}. ${lineOf(item)}`);
  if (live.length > shown.length) lines.push(`还有 ${live.length - shown.length} 件没念。`);
  return lines;
}

/** 同上，拼成一段话（工具结果里直接用这个）。 */
function briefText(limit) {
  const lines = briefLines(limit);
  if (lines.length === 0) return '';
  const tally = counts();
  const head = [
    `手上有 ${tally.open + tally.waiting} 件事`,
    tally.waiting > 0 ? `其中 ${tally.waiting} 件在等人答` : '',
  ].filter(Boolean).join('，');
  return `${head}：\n${lines.join('\n')}`;
}

/** 测试用：清掉落盘文件，回到「还没有账」。 */
function resetForTest() {
  try {
    fs.rmSync(ledgerFile(), { force: true });
  } catch {
    // 本来就没有。
  }
}

module.exports = {
  VERSION,
  MAX_ITEMS,
  BRIEF_MAX_LINES,
  STATUSES,
  WAITING_KINDS,
  ledgerFile,
  readLedger,
  saveLedger,
  upsertTask,
  updateFromSession,
  settleTask,
  markWaiting,
  clearWaiting,
  openItems,
  counts,
  briefLines,
  briefText,
  resetForTest,
};

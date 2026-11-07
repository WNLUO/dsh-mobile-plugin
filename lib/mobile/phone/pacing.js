'use strict';

/**
 * 操作节奏：决定「动作之间停多久」「对外动作之间至少隔多久」。
 *
 * 三档 fast / standard / human，默认 standard，存在插件设置里（与播报开关同一处：
 * `<DSH_HOME>/storages/mobile-plugin/phone-pacing.json`）。这里只给数字，**自己不 sleep**：
 * 真正等待的是执行动作的那一层，本模块一睡就把测试和宿主都拖住。
 *
 * 对外动作的间隔照 Mika 的 OutwardPacing：最近 30 分钟内做得越多，间隔越往上涨，
 * 上下限各 +0.5s / +1s，封顶 30s。第一次不额外等 —— 一条消息本来就要花那几个动作，
 * 从第一条起就硬等只会让人以为手机卡了。
 *
 * 落盘失败不抛：节奏是锦上添花，写不进去也要让这一轮按新节奏继续跑。
 */

const fs = require('node:fs');
const path = require('node:path');

const { dshHome } = require('../../shared/paths');

/** 可选的三档。 */
const MODES = ['fast', 'standard', 'human'];
const DEFAULT_MODE = 'standard';

/** 对外动作计数的时间窗：只算最近半小时做过的。 */
const OUTWARD_WINDOW_MS = 30 * 60 * 1000;
/** 每多做一次对外动作，间隔下限 / 上限各加这么多毫秒。 */
const PER_ACTION_MS = [500, 1000];
/** 间隔封顶，再密也不等超过半分钟。 */
const MAX_OUTWARD_MS = 30 * 1000;

/**
 * 三档的具体数字。
 *
 * `betweenActionsMs`：同一轮里相邻两个动作之间的停留范围；
 * `outwardMinMs`：两个对外动作（发送 / 提交 / 下单这类）之间的最小间隔范围，起点也会被
 *   noteOutward 按次数往上加；
 * `typingChunkMs`：一段一段打字时每段之间停多久（fast 一次写全文，所以是 0）。
 */
const TABLES = {
  fast: {
    betweenActionsMs: [0, 0],
    outwardMinMs: [0, 0],
    typingChunkMs: 0,
  },
  standard: {
    betweenActionsMs: [500, 1200],
    outwardMinMs: [8000, 20000],
    typingChunkMs: 40,
  },
  human: {
    betweenActionsMs: [1000, 2000],
    outwardMinMs: [15000, 30000],
    typingChunkMs: 90,
  },
};

function settingsFile() {
  return path.join(dshHome(), 'storages', 'mobile-plugin', 'phone-pacing.json');
}

/** 把大小写 / 空白各异的输入收成一个合法档名；认不出返回 null。 */
function normalizeMode(mode) {
  if (typeof mode !== 'string') return null;
  const m = mode.trim().toLowerCase();
  return MODES.includes(m) ? m : null;
}

/** 上一轮写盘失败时记住的档名：写不进去也不能让调用方读回旧值。 */
let memoryMode = null;

function readStoredMode() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return normalizeMode(raw && raw.mode);
  } catch {
    // 文件不存在 / 读坏 / 字段不对都当没设过，走默认档。
    return null;
  }
}

/** 当前档。读不到就是 standard（坏文件同样落在这里）。 */
function get() {
  if (memoryMode) return memoryMode;
  return readStoredMode() || DEFAULT_MODE;
}

/**
 * 改成某一档并落盘。非法档名是调用方写错了，直接抛；写盘失败只记住内存值、不抛。
 * 返回改后的当前档，方便调用方直接回给界面。
 */
function set(mode) {
  const m = normalizeMode(mode);
  if (!m) throw new RangeError(`未知的操作节奏：${String(mode)}（可选 ${MODES.join(' / ')}）`);
  try {
    const file = settingsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ mode: m }, null, 2)}\n`);
    memoryMode = null;
  } catch {
    memoryMode = m;
  }
  return m;
}

/** 某一档的数字。认不出的档按 standard 给，避免调用方拿到 undefined 再炸开。 */
function paceFor(mode) {
  const table = TABLES[normalizeMode(mode) || DEFAULT_MODE];
  return {
    betweenActionsMs: [...table.betweenActionsMs],
    outwardMinMs: [...table.outwardMinMs],
    typingChunkMs: table.typingChunkMs,
  };
}

/** 最近做过的对外动作时间点（升序）。只有一台手机，不按包名分组。 */
let outwardAt = [];

function prune(now) {
  while (outwardAt.length > 0 && now - outwardAt[0] > OUTWARD_WINDOW_MS) outwardAt.shift();
}

/**
 * 记一次「现在要做对外动作」，返回这一发至少要等多少毫秒。
 *
 * 返回的是**最小**值（下限），不是随机值：调用方自己决定要不要在这个余量之外再多停。
 * 第一次对外动作返回 0；之后按最近 30 分钟已做的次数把下限往上抬（每次 +0.5s），
 * 封顶 30s；如果从上一次到现在已经隔够了，返回 0。
 */
function noteOutward(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const pace = paceFor(get());
  prune(now);

  let minWaitMs = 0;
  const baseLowMs = pace.outwardMinMs[0];
  // fast 档下限是 0：不计数、不加码，永远不等（与 Mika 的 Off 一个意思）。
  if (outwardAt.length > 0 && baseLowMs > 0) {
    const extra = outwardAt.length - 1;
    const required = Math.min(baseLowMs + extra * PER_ACTION_MS[0], MAX_OUTWARD_MS);
    const elapsed = now - outwardAt[outwardAt.length - 1];
    minWaitMs = Math.max(0, required - elapsed);
  }

  outwardAt.push(now);
  return minWaitMs;
}

/** 单测用：清掉对外动作的计数。 */
function resetOutwardForTest() {
  outwardAt = [];
}

/** 单测用：把内存里「写盘失败留下的档」也清掉。 */
function resetCacheForTest() {
  memoryMode = null;
}

module.exports = {
  get,
  set,
  paceFor,
  noteOutward,
  resetOutwardForTest,
  resetCacheForTest,
  settingsFile,
  MODES,
  DEFAULT_MODE,
  OUTWARD_WINDOW_MS,
  PER_ACTION_MS,
  MAX_OUTWARD_MS,
};

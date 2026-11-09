'use strict';

/**
 * 逐 App 访问控制（三档）：用户定 AI 能不能碰某个 App —— 放行（allow）/ 每次问（ask）/ 禁止（block）。
 *
 * 这里是**策略真值**（插件侧、落盘）：`mode` 按包名记档，`shareAllowed` 是另一个轴（即便交互被禁，
 * 能不能把内容分享进去）。判定由宿主 `tools.js` 读这份真值来 gate 执行；原生只作 block 兜底。
 *
 * 落盘形状 v2：`{version:2, mode:{pkg:'allow'|'ask'|'block'}, shareAllowed:[...]}`。
 * 读到旧的 `{blocked[], shareAllowed[]}` 就地换算（blocked→block，shareAllowed→block 且保留进
 * shareAllowed），下次 `update()` 落盘成 v2；没有一次性迁移脚本。未列出的包默认 `ask`。
 *
 * 能力面：只是本地开关，不扩「能碰什么 App」之外的能力；不涉及 shell/任意文件写。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MODES = ['allow', 'ask', 'block'];
const DEFAULT_MODE = 'ask';

function storePath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'storages', 'mobile-plugin', 'phone-app-access.json');
}

function emptyState() {
  return { version: 2, mode: {}, shareAllowed: [], unreadable: false };
}

/** 读不出来时的形状：空档 + `unreadable:true`，调用方据此保守处理。 */
function unreadableState() {
  return { version: 2, mode: {}, shareAllowed: [], unreadable: true };
}

/** 只留下认识的档名；坏值一律当没写。 */
function cleanModes(input) {
  const mode = {};
  if (input && typeof input === 'object') {
    for (const [pkg, value] of Object.entries(input)) {
      if (typeof pkg === 'string' && pkg && MODES.includes(value)) mode[pkg] = value;
    }
  }
  return mode;
}

/** 去重、只留字符串。 */
function cleanList(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const item of input) {
    if (typeof item === 'string' && item && !out.includes(item)) out.push(item);
  }
  return out;
}

/** 旧两档存档 → 三档：blocked→block；shareAllowed→block 且保留在 shareAllowed。 */
function migrateLegacy(parsed) {
  const mode = {};
  const shareAllowed = [];
  for (const pkg of cleanList(parsed && parsed.blocked)) mode[pkg] = 'block';
  for (const pkg of cleanList(parsed && parsed.shareAllowed)) {
    mode[pkg] = 'block';
    shareAllowed.push(pkg);
  }
  return { version: 2, mode, shareAllowed };
}

/**
 * 读盘。**读不出来不再当空档**：文件坏了、权限不对、解析炸了，都回 `unreadable:true`。
 * 空档的意思是「每个 App 都是默认的 ask」，那会把用户设过的 block 静默降级成「每次问」——
 * 禁止变松了还看不出来。带上标记，调用方（工具侧 gate）自己保守处理。
 */
function readState() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
  } catch {
    return unreadableState();
  }
  if (!parsed || typeof parsed !== 'object') return unreadableState();
  // v2 形状：有 mode 映射就按它读，没有就把旧的 blocked / shareAllowed 换算过来。
  if (parsed.mode && typeof parsed.mode === 'object') {
    return { version: 2, mode: cleanModes(parsed.mode), shareAllowed: cleanList(parsed.shareAllowed), unreadable: false };
  }
  return { ...migrateLegacy(parsed), unreadable: false };
}

/** `unreadable` 是读盘结果，不是落盘字段：写之前去掉，文件形状仍是 v2。 */
function writeState(state) {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { unreadable: _drop, ...persisted } = state && typeof state === 'object' ? state : emptyState();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function normalizePackage(value) {
  if (typeof value !== 'string') return '';
  const pkg = value.trim();
  // 包名形状：只允许点分标识符。挡住把路径/命令塞进来的调用。
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(pkg)) return '';
  return pkg;
}

/** 一个 App 当前是哪个档；没写过的包回默认档。判定点只读它，别处不再解释档名。 */
function modeFor(state, pkg) {
  if (!state || !state.mode || typeof state.mode !== 'object') return DEFAULT_MODE;
  const value = state.mode[pkg];
  return MODES.includes(value) ? value : DEFAULT_MODE;
}

/**
 * 改一个 App 的档 / 分享例外。只传哪个字段就只改哪个。
 * @returns {{ok:boolean, error?:string, modes?:string[], state?:object}}
 */
function update(packageName, patch) {
  const pkg = normalizePackage(packageName);
  if (!pkg) return { ok: false, error: 'bad-package' };
  const p = patch && typeof patch === 'object' ? patch : {};
  if (p.mode !== undefined && !MODES.includes(p.mode)) {
    return { ok: false, error: 'unknown-mode', modes: MODES.slice() };
  }
  const state = readState();
  if (typeof p.mode === 'string') state.mode[pkg] = p.mode;
  if (typeof p.shareAllowed === 'boolean') {
    const has = state.shareAllowed.includes(pkg);
    if (p.shareAllowed === true && !has) state.shareAllowed.push(pkg);
    if (p.shareAllowed === false && has) state.shareAllowed.splice(state.shareAllowed.indexOf(pkg), 1);
  }
  writeState(state);
  return { ok: true, state };
}

/** 行视图：被改过档或进过分享白名单的 App 各一行，带档与分享例外。 */
function rows() {
  const state = readState();
  const seen = new Set();
  const out = [];
  const push = (pkg) => {
    if (!pkg || seen.has(pkg)) return;
    seen.add(pkg);
    out.push({ packageName: pkg, mode: modeFor(state, pkg), shareAllowed: state.shareAllowed.includes(pkg) });
  };
  for (const pkg of Object.keys(state.mode)) push(pkg);
  for (const pkg of state.shareAllowed) push(pkg);
  return out;
}

/**
 * 下推给手机的兜底策略：`{modes:{pkg:mode}, blocked:[...]}`。
 *
 * `modes` 只含改过档的 App（和行视图同一份来源），`blocked` 是其中所有 block 的包名，
 * 手机侧拿它做本地兜底 —— 只认「哪些绝对不能碰」，不必懂三档语义。读不出来时给空表，
 * 手机侧按「没兜底策略」处理，真正的策略仍在宿主这一侧判定。
 */
function policy() {
  const state = readState();
  const modes = {};
  const blocked = [];
  const push = (pkg) => {
    if (!pkg || Object.prototype.hasOwnProperty.call(modes, pkg)) return;
    const mode = modeFor(state, pkg);
    modes[pkg] = mode;
    if (mode === 'block') blocked.push(pkg);
  };
  for (const pkg of Object.keys(state.mode)) push(pkg);
  for (const pkg of state.shareAllowed) push(pkg);
  return { modes, blocked };
}

module.exports = {
  readState,
  writeState,
  update,
  rows,
  policy,
  modeFor,
  normalizePackage,
  storePath,
  MODES,
  DEFAULT_MODE,
};

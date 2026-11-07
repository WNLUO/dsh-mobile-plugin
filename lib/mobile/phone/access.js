'use strict';

/**
 * 逐 App 访问控制（清单 103）：用户拉黑哪些 App 不许 AI 碰、哪些只允许分享。
 *
 * 这里是**策略真值**（插件侧、落盘）：`blocked` 集与 `shareAllowed` 集，按包名记。
 * 判据本身在原生 `AppAccess.kt`（执行面强制点），它每次读最新状态、不在任务开始时冻结；
 * 插件侧这份是本机唯一真值，原生侧会在下发动作前按同一份名单判。
 *
 * 能力面：只是本地开关，不扩「能碰什么 App」之外的能力；不涉及 shell/任意文件写。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function storePath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'storages', 'mobile-plugin', 'phone-app-access.json');
}

function readState() {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      blocked: Array.isArray(parsed.blocked) ? parsed.blocked.filter((x) => typeof x === 'string') : [],
      shareAllowed: Array.isArray(parsed.shareAllowed) ? parsed.shareAllowed.filter((x) => typeof x === 'string') : [],
    };
  } catch {
    return { blocked: [], shareAllowed: [] };
  }
}

function writeState(state) {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function normalizePackage(value) {
  if (typeof value !== 'string') return '';
  const pkg = value.trim();
  // 包名形状：只允许点分标识符。挡住把路径/命令塞进来的调用。
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(pkg)) return '';
  return pkg;
}

/**
 * 改一个 App 的准入。只传一个字段就只改那一个（另一个保持原样）。
 * @returns {{ok:boolean, error?:string, state?:object}}
 */
function update(packageName, patch) {
  const pkg = normalizePackage(packageName);
  if (!pkg) return { ok: false, error: 'bad-package' };
  const state = readState();
  const set = (list, key) => {
    const has = list.includes(pkg);
    if (patch[key] === true && !has) list.push(pkg);
    if (patch[key] === false && has) list.splice(list.indexOf(pkg), 1);
  };
  if (typeof patch.blocked === 'boolean') set(state.blocked, 'blocked');
  if (typeof patch.shareAllowed === 'boolean') set(state.shareAllowed, 'shareAllowed');
  // 拉了黑名单就不该还在分享白名单里，反之亦然。
  if (state.blocked.includes(pkg)) state.shareAllowed = state.shareAllowed.filter((x) => x !== pkg);
  writeState(state);
  return { ok: true, state };
}

/** 行视图：把两个集合合成一条 App 的开关（包名去重合并）。 */
function rows() {
  const state = readState();
  const seen = new Set();
  const out = [];
  for (const pkg of [...state.blocked, ...state.shareAllowed]) {
    if (seen.has(pkg)) continue;
    seen.add(pkg);
    out.push({ packageName: pkg, blocked: state.blocked.includes(pkg), shareAllowed: state.shareAllowed.includes(pkg) });
  }
  return out;
}

module.exports = { readState, writeState, update, rows, normalizePackage, storePath };

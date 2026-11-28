// 2026-11-28：补 downloadClientTo：换代时把新版下到 <bin>.next，旁边在跑的那份原样不动。
// ZeroNews 客户端获取层：自带 → 系统 PATH → 缓存 → 官方地址下载，四平台固定路径。
'use strict';

/**
 * 在用户电脑上弄到一份能用的 zeronews 可执行文件。像 cloudflared 那样单独一层：
 * 用户不用自己装——插件按平台从官方地址下载、落到自己的运行目录。
 *
 * 官方下载地址（2026-11-22 实测 HEAD 均为 200）：
 *   macOS arm64   https://download.zeronews.cc/macos/arm/zeronews
 *   macOS x64     https://download.zeronews.cc/macos/amd/zeronews
 *   Windows x64   https://download.zeronews.cc/windows/x64/zeronews.exe
 *   Linux x64     https://download.v2.zeronews.cc/linux/x86_x64/zeronews-linux-4.1.1.tar （包内 zeronews/zeronews）
 *   Linux arm64   https://download.v2.zeronews.cc/linux/arm64/zeronews-linux-4.1.1.tar
 *
 * 三条来源按优先级：环境变量 / PATH 里已有 → 缓存 → 下载。Linux 下官方给的是 .tar，
 * 这里只挑出里面的 zeronews 可执行文件落盘。所有 I/O 都可注入，守卫用假体走完整条分支。
 */

const fs = require('node:fs');
const path = require('node:path');
const { dshHome } = require('../shared/paths.js');

const VERSION = '4.1.1';
const DOWNLOADS = {
  'darwin-arm64': 'https://download.zeronews.cc/macos/arm/zeronews',
  'darwin-x64': 'https://download.zeronews.cc/macos/amd/zeronews',
  'win32-x64': 'https://download.zeronews.cc/windows/x64/zeronews.exe',
  'linux-x64': `https://download.v2.zeronews.cc/linux/x86_x64/zeronews-linux-${VERSION}.tar`,
  'linux-arm64': `https://download.v2.zeronews.cc/linux/arm64/zeronews-linux-${VERSION}.tar`,
};
/** Linux 下载的是 tar 包，其余平台就是裸可执行文件。 */
const TAR_PLATFORMS = new Set(['linux-x64', 'linux-arm64']);

function platformId(platform, arch) {
  const p = platform || process.platform;
  const a = arch || process.arch;
  const key = `${p}-${a}`;
  return DOWNLOADS[key] ? key : '';
}

function downloadUrlOf(platform, arch) {
  return DOWNLOADS[platformId(platform, arch)] || '';
}

function runDir(root) {
  return root || path.join(dshHome(), 'zeronews-run');
}

/** 从一份 tar 二进制流里挑出 zeronews 可执行文件（不落盘其它成员）。 */
function extractFromTar(buf) {
  // tar 每 512 字节一个头；头里 name[0..100]、size[124..136]（八进制）、typeflag[156]。
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeText = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeText, 8);
    const typeflag = String.fromCharCode(header[156]);
    const body = buf.subarray(offset + 512, offset + 512 + size);
    if ((name === 'zeronews' || name.endsWith('/zeronews')) && (typeflag === '0' || typeflag === '\0') && body.length) {
      return Buffer.from(body);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

/**
 * 只「找」一份已经在本机的 zeronews，绝不下下载：只读状态 / 账号数据那条路要用它，
 * 面板打开一下不该顺手把几十兆客户端拉下来。来源顺序与 ensure 一致：显式 / PATH / 系统安装 / 缓存。
 *
 * @param {object} options
 * @param {() => string} [options.env] 读环境变量（PATH / DSHM_ZERONEWS_BIN）
 * @param {object} [options.fsImpl] 文件系统注入
 * @param {object} [options.platform] { platform, arch }
 * @param {string} [options.root] 运行目录
 * @returns {{ok:boolean, path:string, source:string, code?:string}}
 */
function locateZeroNews(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const readEnv = typeof options.env === 'function' ? options.env : (key) => process.env[key] || '';
  const plat = options.platform || {};
  const dir = runDir(options.root);
  const binName = (plat.platform || process.platform) === 'win32' ? 'zeronews.exe' : 'zeronews';
  const cached = path.join(dir, binName);
  const exists = (p) => { try { return fsImpl.statSync(p).isFile(); } catch { return false; } };

  const explicit = readEnv('DSHM_ZERONEWS_BIN');
  if (explicit && exists(explicit)) return { ok: true, path: explicit, source: 'env' };
  // 用户自己装的客户端在只读位置时，换代会把它搬到插件目录并在这里记一笔；之后一律用这一份。
  const active = typeof options.active === 'function' ? options.active() : options.active;
  const activePath = typeof active === 'string' && active ? active : (() => {
    try { return String(fsImpl.readFileSync(activeMarkerPath(options), 'utf8')).trim(); } catch { return ''; }
  })();
  if (activePath && exists(activePath)) return { ok: true, path: activePath, source: 'active' };
  // macOS 上官方默认装到 /Applications/zeronews/zeronews（那份可能已经登录），优先复用，别另起一份未登录的。
  if ((plat.platform || process.platform) === 'darwin') {
    const systemInstalled = path.join('/Applications/zeronews', binName);
    if (exists(systemInstalled)) return { ok: true, path: systemInstalled, source: 'system' };
  }
  for (const entry of String(readEnv('PATH') || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, binName);
    if (exists(candidate)) return { ok: true, path: candidate, source: 'path' };
  }
  if (exists(cached)) return { ok: true, path: cached, source: 'cache' };
  return { ok: false, path: '', source: '', code: 'not-installed' };
}

function permissionCode(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'EBUSY' || code === 'ENOTDIR';
}

/** 插件自己那份客户端的落点（换代时搬到这里，位置一定可写）。 */
function ownBinaryPath(options = {}) {
  const binName = (options.platform && options.platform.platform ? options.platform.platform : process.platform) === 'win32' ? 'zeronews.exe' : 'zeronews';
  return path.join(runDir(options.root), binName);
}

/**
 * 插件自己选定的那份客户端（搬到自己目录之后用）：内容是一行绝对路径。
 * 放文件而不是塞进设置，是为了不扩移动端设置契约 —— 它只影响本机用哪个可执行文件。
 */
function activeMarkerPath(options = {}) {
  return path.join(runDir(options.root), '.active-binary');
}

/**
 * 把官方客户端下载到指定路径（换代用：落到 `<bin>.next`，正在跑的那份原样不动）。
 *
 * 先写 `dest.download` 再改名：中途断网只会留下一个临时文件，不会出现半截可执行文件被当成新版。
 * 平台认不出 / 没网 / 下载失败都如实回，绝不覆盖调用方已有的东西。
 *
 * @param {string} dest 目标文件路径
 * @param {object} [options] 与 ensureZeroNews 同一组注入点
 * @returns {Promise<{ok:boolean, path:string, code?:string}>}
 */
async function downloadClientTo(dest, options = {}) {
  const doFetch = typeof options.fetchImpl === 'function'
    ? options.fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  const plat = options.platform || {};
  const key = platformId(plat.platform, plat.arch);
  if (!key) return { ok: false, path: '', code: 'unsupported-platform' };
  if (!doFetch || !dest) return { ok: false, path: '', code: 'download-failed' };
  const fsImpl = options.fsImpl || fs;
  const staging = `${dest}.download`;
  try {
    const response = await doFetch(DOWNLOADS[key]);
    if (!response || response.ok !== true) return { ok: false, path: '', code: 'download-failed' };
    let bytes = Buffer.from(await response.arrayBuffer());
    if (TAR_PLATFORMS.has(key)) {
      const extracted = extractFromTar(bytes);
      if (!extracted) return { ok: false, path: '', code: 'extract-failed' };
      bytes = extracted;
    }
    fsImpl.mkdirSync(path.dirname(dest), { recursive: true });
    fsImpl.writeFileSync(staging, bytes, { mode: 0o755 });
    fsImpl.rmSync(dest, { force: true });
    fsImpl.renameSync(staging, dest);
    return { ok: true, path: dest };
  } catch (error) {
    try { fsImpl.rmSync(staging, { force: true }); } catch { /* 清不掉也不影响返回 */ }
    // 只读安装位置（用户自己装在 /usr/local/bin、Program Files 这种）与「没网」要分开：
    // 前者只能换到插件自己的目录去升级，后者等下一轮再试就行。
    return { ok: false, path: '', code: permissionCode(error) ? 'no-permission' : 'download-failed' };
  }
}

/**
 * @param {object} options
 * @param {() => string} [options.env] 读环境变量（PATH / DSHM_ZERONEWS_BIN）
 * @param {object} [options.fsImpl] 文件系统注入
 * @param {(url: string) => Promise<{ok:boolean, arrayBuffer:()=>Promise<ArrayBuffer>}>} [options.fetchImpl]
 * @param {object} [options.platform] { platform, arch }
 * @param {string} [options.root] 运行目录
 */
async function ensureZeroNews(options = {}) {
  const doFetch = typeof options.fetchImpl === 'function'
    ? options.fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  const plat = options.platform || {};
  const key = platformId(plat.platform, plat.arch);
  const dir = runDir(options.root);
  const binName = (plat.platform || process.platform) === 'win32' ? 'zeronews.exe' : 'zeronews';
  const cached = path.join(dir, binName);
  const fsImpl = options.fsImpl || fs;

  // ① 用户显式指定 / PATH 上已有 / 系统安装 / 缓存，直接用。
  const located = locateZeroNews(options);
  if (located.ok) return located;
  // ② 都不支持或没网，如实说。
  if (!key) return { ok: false, code: 'unsupported-platform', path: '', source: '' };
  if (!doFetch) return { ok: false, code: 'download-failed', path: '', source: '' };

  const url = DOWNLOADS[key];
  try {
    const response = await doFetch(url);
    if (!response || response.ok !== true) return { ok: false, code: 'download-failed', path: '', source: '' };
    let bytes = Buffer.from(await response.arrayBuffer());
    if (TAR_PLATFORMS.has(key)) {
      const extracted = extractFromTar(bytes);
      if (!extracted) return { ok: false, code: 'extract-failed', path: '', source: '' };
      bytes = extracted;
    }
    fsImpl.mkdirSync(dir, { recursive: true });
    fsImpl.writeFileSync(cached, bytes, { mode: 0o755 });
    return { ok: true, path: cached, source: 'downloaded' };
  } catch {
    return { ok: false, code: 'download-failed', path: '', source: '' };
  }
}

module.exports = {
  VERSION, DOWNLOADS, platformId, downloadUrlOf, runDir, extractFromTar, locateZeroNews, ensureZeroNews,
  downloadClientTo, ownBinaryPath, activeMarkerPath,
};

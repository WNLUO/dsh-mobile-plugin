'use strict';

/**
 * 手机端目录浏览的兜底实现：宿主组合出的目录选择器只服务 native 时，由插件自己把
 * 「列一层目录 / 建一个子目录」补上。
 *
 * 「桌面 profile 宿主 + 手机远程连」这一格谁都盖不到：宿主按「操作者就在机器前」选了原生
 * 对话框，手机是远程客户端，点「添加工作区」只能看到 `needs the browse capability`。不能把
 * mobile-host.yml 里钉 browse 的两行搬进 bundle 层——那会把桌面操作者的原生选择框也换掉。
 * 所以宿主只要服务 browse 就整条走它，只有它明确只服务 native 时才用这份。
 *
 * 语义与宿主 browse 后端逐条对齐：隐藏项标记但返回、跟随符号链接、全文件系统无白名单、
 * 名字升序有界窗口（默认 1000，满了置 `truncated`）、回 `resolve(path)` 而不是 realpath。
 */

const { mkdir, opendir, stat } = require('node:fs/promises');
const { homedir } = require('node:os');
const { basename, dirname, join, posix, resolve, win32 } = require('node:path');

/** 单次 list 最多物化的行数，对齐宿主 browse 后端与 GitHub 网页版。 */
const DEFAULT_MAX_ENTRIES = 1000;

/** 越权/不存在的目录操作：code 与宿主 browse 后端同名，便于映射成同一组 wire 码。 */
class DirectoryBrowseError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'DirectoryBrowseError';
    this.code = code;
    this.path = path;
  }
}

/** 被控端主目录；`homedir()` 在极小概率下抛错时退到根，不让列目录整体不可用。 */
function homeDirectory() {
  try {
    return homedir();
  } catch {
    return resolve('/');
  }
}

/**
 * 路径是否指名一个**固定**的文件系统位置：POSIX 上就是绝对路径；Windows 上只认盘符
 * 限定（`C:\…`）或完整 UNC（`\\server\share…`）。无盘符的 `\foo` / `/foo` 与残缺的前缀
 * （`\\`、`\\server`）也能过 `isAbsolute`，却仍会随进程当前盘符漂移。
 */
function fullyQualified(path, platform = process.platform) {
  return platform === 'win32'
    ? win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(path)
    : posix.isAbsolute(path);
}

/** 从文件系统根到 `target`（含）的祖先链 —— 列表的面包屑，每一节都是可跳的目标。 */
function ancestryCrumbs(target) {
  const crumbs = [];
  let current = target;
  for (;;) {
    const parent = dirname(current);
    crumbs.unshift({
      name: parent === current ? current : basename(current),
      path: current,
      hidden: false,
    });
    if (parent === current) return crumbs;
    current = parent;
  }
}

/**
 * 把流式读到的候选插进名字升序的有界窗口，超出 `keep` 时淘汰名字最大的那个。于是无论
 * 一个目录有多少子项，内存都是 O(keep)。
 *
 * @returns 是否发生了淘汰（= 这一层还有窗口外的候选）。
 */
function boundedInsert(window, candidate, keep) {
  if (window.length === keep && candidate.name.localeCompare(window[window.length - 1].name) >= 0) return true;
  let lo = 0;
  let hi = window.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candidate.name.localeCompare(window[mid].name) < 0) hi = mid;
    else lo = mid + 1;
  }
  window.splice(lo, 0, candidate);
  if (window.length <= keep) return false;
  window.pop();
  return true;
}

/** 把任意抛出值收敛成 Error（abort reason 可以不是 Error）。 */
function asError(reason) {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/** 未知抛出值的文案。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * await `operation`，但 signal abort 时立刻 reject。Node 的文件系统读不能撤回，被放弃的
 * 那一步仍在跑，它的迟到 settle 在这里被吞掉，免得变成 unhandled rejection。
 */
function raceAbort(operation, signal) {
  if (signal === undefined) return operation;
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      operation.catch(() => {});
      rejectPromise(asError(signal.reason));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolvePromise(value);
      },
      (reason) => {
        signal.removeEventListener('abort', onAbort);
        rejectPromise(asError(reason));
      },
    );
  });
}

/**
 * 一条列表行：符号链接跟到目录上；非目录与断链/成环的返回 null（浏览器只列得进去的）。
 */
async function directoryRow(parent, name, isDirectory, isSymbolicLink, signal) {
  const path = join(parent, name);
  let enterable = isDirectory;
  if (!enterable && isSymbolicLink) {
    try {
      enterable = (await raceAbort(stat(path), signal)).isDirectory();
    } catch {
      if (signal && signal.aborted) throw asError(signal.reason);
      return null;
    }
  }
  if (!enterable) return null;
  return { name, path, hidden: name.startsWith('.') };
}

/**
 * 列一层目录。`path` 缺省 = 被控端主目录。
 *
 * @returns `{ path, home, crumbs, entries, truncated }`（与宿主 browse 后端同形状）
 */
async function listDirectory(path, options = {}) {
  const { signal, maxEntries = DEFAULT_MAX_ENTRIES } = options;
  const home = homeDirectory();
  if (path !== undefined && path !== null && !fullyQualified(path)) {
    throw new DirectoryBrowseError('directory-unreadable', path, `cannot list "${path}": not a fully qualified path`);
  }
  const target = resolve(path === undefined || path === null ? home : path);
  const keep = maxEntries + 1;
  const window = [];
  let evicted = false;
  try {
    const opening = opendir(target);
    const level = await raceAbort(opening, signal).catch((error) => {
      opening.then((dir) => dir.close().catch(() => {}), () => {});
      throw error;
    });
    try {
      for (;;) {
        const dirent = await raceAbort(level.read(), signal);
        if (dirent === null) break;
        if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
        const candidate = {
          name: dirent.name,
          isDirectory: dirent.isDirectory(),
          isSymbolicLink: dirent.isSymbolicLink(),
        };
        if (boundedInsert(window, candidate, keep)) evicted = true;
      }
    } finally {
      const closing = level.close();
      if (signal && signal.aborted) closing.catch(() => {});
      else await closing;
    }
  } catch (error) {
    if (signal && signal.aborted) throw asError(signal.reason);
    throw new DirectoryBrowseError('directory-unreadable', target, `cannot list ${target}: ${messageOf(error)}`);
  }
  const entries = [];
  let truncated = evicted;
  for (const candidate of window) {
    if (signal) signal.throwIfAborted();
    const row = await directoryRow(target, candidate.name, candidate.isDirectory, candidate.isSymbolicLink, signal);
    if (row === null) continue;
    if (entries.length === maxEntries) {
      truncated = true;
      break;
    }
    entries.push(row);
  }
  return { path: target, home, crumbs: ancestryCrumbs(target), entries, truncated };
}

/**
 * 在 `path` 下建一个名为 `name` 的子目录。
 *
 * @returns 建出来的目录路径
 */
async function createDirectory(path, name) {
  if (!fullyQualified(path)) {
    throw new DirectoryBrowseError('directory-create-failed', path, `cannot create under "${path}": not a fully qualified parent path`);
  }
  const parent = resolve(path);
  if (typeof name !== 'string' || name.trim() === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
    throw new DirectoryBrowseError('directory-create-failed', join(parent, String(name)), `"${name}" is not a single path segment`);
  }
  const target = join(parent, name);
  try {
    await mkdir(target);
    return target;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'EEXIST') throw new DirectoryBrowseError('directory-exists', target, `${target} already exists`);
    throw new DirectoryBrowseError('directory-create-failed', target, `cannot create ${target}: ${messageOf(error)}`);
  }
}

/** 本地实现抛的 code → 宿主 browse 后端那套 wire 码（App 侧已按这几个码写文案）。 */
const WIRE_CODES = Object.freeze({
  'directory-unreadable': 'directory-picker/unreadable',
  'directory-exists': 'directory-picker/exists',
  'directory-create-failed': 'directory-picker/create-failed',
});

/** 把本地实现的抛出值翻成宿主那套 `{ code, message, path }` 错误体。 */
function wireError(error) {
  const local = error instanceof DirectoryBrowseError ? error.code : 'directory-create-failed';
  return {
    code: WIRE_CODES[local] || 'directory-picker/create-failed',
    message: messageOf(error),
    path: error && error.path,
  };
}

/**
 * 宿主当前组合出的目录选择器是否服务 `browse` 能力。
 *
 * 只认「同进程直查得到、且明确报 browse」这一种肯定答案：拿不到服务（老宿主、被隔离的
 * 上下文）时返回 false 也不影响正确性 —— 那只是让我们用自己这份实现，形状与宿主一致。
 */
function hostServesBrowse(ctx, picker) {
  try {
    const source = picker || (ctx && typeof ctx.get === 'function' ? ctx.get('directoryPicker') : null);
    if (!source || typeof source.capability !== 'function') return false;
    const capability = source.capability();
    return !!capability && capability.kind === 'browse';
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_MAX_ENTRIES,
  DirectoryBrowseError,
  WIRE_CODES,
  ancestryCrumbs,
  asError,
  boundedInsert,
  createDirectory,
  fullyQualified,
  homeDirectory,
  hostServesBrowse,
  listDirectory,
  raceAbort,
  wireError,
};

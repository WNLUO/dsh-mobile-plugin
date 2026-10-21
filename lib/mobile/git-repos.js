'use strict';

/**
 * 项目目录的 Git 仓库识别：回传「这里有没有仓库、仓库根在哪、当前在哪个分支」。
 *
 * 为什么由插件做：手机看不到电脑上的目录，侧栏那个 Git 入口的可见性只能靠宿主回传的
 * 标记决定（docs/git-manager.md 第 2 节）。判据不许 App 猜，也不许等用户点进去才发现
 * 是空页 —— 字段缺失一律按「不是仓库」处理。
 *
 * 为什么只读文件、不起 git 进程：这段代码跟着工作区清单一轮一轮地跑（镜像推送每
 * 500ms 构建一次清单），起进程太贵；而且宿主上未必装了 git，装没装不该影响「这个项目
 * 是不是仓库」这个事实。仓库的形状就是 `.git` 这个入口加上里面的 HEAD，读到就够答了。
 *
 * 认哪些（三种都算「有仓库」）：
 *   1. 项目根自己就是仓库根；
 *   2. 项目目录落在某个仓库的子目录里 —— 往上找最近的那个根，操作按它执行；
 *   3. 项目下面并列着若干个仓库（第 1、2 层，含 `.git` 是文件的子模块与 worktree）。
 * 往上走到主目录为止不再往上：主目录本身是个 dotfiles 仓库时，再往上是把每个项目都
 * 判成仓库，那不是这些项目的意思。往下只扫两层、条数封顶，扫满置 `truncated`。
 *
 * 结果按目录缓存一会儿（GIT_CACHE_MS）：下拉刷新带 `fresh` 跳过缓存，见
 * lib/mobile/workspaces.js 的 handleWorkspaces。
 */

const { readdir, readFile, stat } = require('node:fs/promises');
const { homedir } = require('node:os');
const { basename, dirname, isAbsolute, join, relative, resolve } = require('node:path');

/** 识别结果的缓存时长：与侧栏 15 秒轮询同频，镜像推送每 500ms 构建清单时靠它挡住重复扫盘。 */
const GIT_CACHE_MS = 15 * 1000;
/** 往下只扫这么多层（项目目录的直接子目录算第 1 层）。 */
const MAX_DEPTH = 2;
/** 一次最多回这么多仓库（含主仓库），超出的截断并置 `truncated`。 */
const MAX_REPOS = 20;
/** 明显不该往里找仓库的目录：依赖树。点开头的目录由命名规则挡掉。 */
const SKIP_DIRS = new Set(['node_modules']);

/** projectDir → { at, value }。键是解析过的绝对路径，条目数就是工作区条数。 */
const cache = new Map();

function emptyMarker() {
  return { isRepo: false, root: null, branch: null, detached: false, repos: [], truncated: false };
}

/**
 * 读 HEAD：`ref: refs/heads/<名字>` 是正常分支，裸哈希是 detached（此时没有分支名）。
 * 读不到（权限、仓库损坏、子模块还没 init）都当「不知道分支」—— 仓库本身仍然算存在。
 */
async function readHead(gitDir) {
  if (!gitDir) return null;
  let text;
  try {
    text = await readFile(join(gitDir, 'HEAD'), 'utf8');
  } catch {
    return null;
  }
  const line = text.trim();
  const ref = /^ref:\s*(\S+)$/.exec(line);
  if (ref) {
    const name = ref[1];
    return { branch: name.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : name, detached: false };
  }
  if (/^[0-9a-f]{40,64}$/i.test(line)) return { branch: null, detached: true };
  return null;
}

/**
 * 看一个目录自己是不是仓库根。
 *
 * `.git` 是目录 = 普通仓库；是文件 = 子模块 / worktree / 分离 git 目录，文件里那行
 * `gitdir:` 写着真正的 git 目录在哪，HEAD 去那边读。所以这三种形态不需要各写一套判据，
 * 差别只在 kind 上，给界面决定叫「子模块」还是「仓库」。
 */
async function probeRepo(dir) {
  const root = resolve(dir);
  const dotGit = join(root, '.git');
  let entry;
  try {
    entry = await stat(dotGit);
  } catch {
    return null;
  }
  let gitDir = null;
  let kind = 'repo';
  if (entry.isFile()) {
    let text = '';
    try {
      text = await readFile(dotGit, 'utf8');
    } catch {
      text = '';
    }
    const pointer = /^\s*gitdir:\s*(.+?)\s*$/m.exec(text);
    if (pointer) {
      const target = pointer[1];
      gitDir = isAbsolute(target) ? target : resolve(root, target);
      kind = /(^|[\\/])modules[\\/]/.test(gitDir)
        ? 'submodule'
        : /(^|[\\/])worktrees[\\/]/.test(gitDir)
          ? 'worktree'
          : 'linked';
    } else {
      kind = 'linked';
    }
  } else if (entry.isDirectory()) {
    gitDir = dotGit;
  } else {
    return null;
  }
  const head = await readHead(gitDir);
  return {
    root,
    name: basename(root),
    kind,
    branch: head ? head.branch : null,
    detached: head ? head.detached : false,
  };
}

/** 从项目目录往上找最近的仓库根（含项目目录自己），到主目录为止。 */
async function findAncestorRepo(projectDir) {
  const stopAt = resolve(homedir());
  let current = projectDir;
  for (;;) {
    const repo = await probeRepo(current);
    if (repo) return repo;
    if (current === stopAt) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * 从项目目录往下扫并列的仓库，最多 MAX_DEPTH 层。
 *
 * 不进符号链接目录（绕开环，仓库根几乎都是真目录），点开头的目录与依赖树一律跳过。
 * 找到仓库之后仍然往下走一层：子模块就住在主仓库下面，不进去就看不见它。
 */
async function scanNested(projectDir) {
  const found = [];
  let frontier = [projectDir];
  for (let depth = 1; depth <= MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next = [];
    for (const parent of frontier) {
      let entries;
      try {
        entries = await readdir(parent, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (found.length > MAX_REPOS) return found;
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        const child = join(parent, entry.name);
        const repo = await probeRepo(child);
        if (repo) found.push(repo);
        next.push(child);
      }
    }
    frontier = next;
  }
  return found;
}

/** 主仓库排第一（`main: true`），其余按扫描顺序；`relative` 是相对项目目录的写法。 */
async function recognize(projectDir) {
  const primary = await findAncestorRepo(projectDir);
  const nested = await scanNested(projectDir);
  const raw = primary ? [primary, ...nested] : nested;
  const truncated = raw.length > MAX_REPOS;
  const repos = raw.slice(0, MAX_REPOS).map((repo, index) => ({
    root: repo.root,
    name: repo.name,
    relative: relative(projectDir, repo.root) || '.',
    kind: repo.kind,
    branch: repo.branch,
    detached: repo.detached,
    main: index === 0,
  }));
  const head = repos[0];
  return {
    isRepo: repos.length > 0,
    root: head ? head.root : null,
    branch: head ? head.branch : null,
    detached: head ? head.detached : false,
    repos,
    truncated,
  };
}

/**
 * 一个项目目录的仓库标记。永远不抛：目录不存在、没有权限、路径根本不是目录，都回
 * 「不是仓库」，让工作区清单照常下发。
 *
 * @param {unknown} dir 项目目录（宿主 workspace.list 里的 `path`）
 * @param {{ fresh?: boolean }} [options] `fresh` 跳过缓存（下拉刷新 / 写后刷新）
 */
async function describeProjectGit(dir, options = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') return emptyMarker();
  const projectDir = resolve(dir.trim());
  const cached = cache.get(projectDir);
  if (cached && !options.fresh && Date.now() - cached.at < GIT_CACHE_MS) return cached.value;
  const value = await recognize(projectDir);
  cache.set(projectDir, { at: Date.now(), value });
  return value;
}

module.exports = { describeProjectGit, GIT_CACHE_MS, MAX_DEPTH, MAX_REPOS };

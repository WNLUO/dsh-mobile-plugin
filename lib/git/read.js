'use strict';

/**
 * Git 只读能力的实现：每个函数对应移动端一屏要的数据，返回的就是下发的形状。
 *
 * 全部只在**已识别出来的仓库根**上跑（根由调用方校验，见 lib/mobile/git.js），参数里只有
 * 相对仓库根的路径，路径的合法性在调用方那侧先过一遍。
 *
 * 体积与耗时上的取舍写在各自函数的注释里：diff 单文件封顶 200KB、历史一页最多 200 条、
 * 概览的文件遍历有上限。宁可少给一部分并明说（`truncated` / `hasMore`），也不让手机等十秒。
 */

const { readFile, stat } = require('node:fs/promises');
const { basename, extname, join } = require('node:path');

const { runGit, runGitStrict } = require('./exec');
const {
  RECORD,
  UNIT,
  parseDiffText,
  parseLogZ,
  parseNameStatusZ,
  parseNumstatZ,
  parseStatusZ,
} = require('./parse');

/** 单文件 diff 的字节上限：超过就只给前几段完整的 hunk。 */
const MAX_DIFF_BYTES = 200 * 1024;
/** 历史一页的条数上限。 */
const MAX_LOG_LIMIT = 200;
const DEFAULT_LOG_LIMIT = 30;
/** 概览遍历的上限：文件数、单个文件大小、累计读取量。 */
const MAX_OVERVIEW_FILES = 4000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
/** 语言表的展示条数。超出的**并进「其他」**（不是悄悄丢掉，那样百分比就不合 100 了）。 */
const MAX_LANGUAGES = 10;
/** GitHub 元信息的超时。 */
const GITHUB_TIMEOUT_MS = 4000;
/** 概览的缓存时长：这张卡要扫一遍文件与历史，几秒级的活不该跟着每次下拉重算。 */
const OVERVIEW_CACHE_MS = 60 * 1000;

/** 仓库根 → { at, value }。条目数等于用户打开过的仓库数，不需要淘汰。 */
const overviewCache = new Map();

/** 扩展名 → 语言名。够覆盖常见仓库；认不出的并进「其他」。 */
const LANGUAGES = new Map([
  ['ts', 'TypeScript'], ['tsx', 'TypeScript'], ['js', 'JavaScript'], ['jsx', 'JavaScript'],
  ['mjs', 'JavaScript'], ['cjs', 'JavaScript'], ['py', 'Python'], ['rb', 'Ruby'],
  ['go', 'Go'], ['rs', 'Rust'], ['java', 'Java'], ['kt', 'Kotlin'], ['swift', 'Swift'],
  ['c', 'C'], ['h', 'C'], ['cc', 'C++'], ['cpp', 'C++'], ['hpp', 'C++'], ['cs', 'C#'],
  ['php', 'PHP'], ['sh', 'Shell'], ['bash', 'Shell'], ['zsh', 'Shell'], ['ps1', 'PowerShell'],
  ['css', 'CSS'], ['scss', 'SCSS'], ['less', 'Less'], ['html', 'HTML'], ['vue', 'Vue'],
  ['svelte', 'Svelte'], ['json', 'JSON'], ['yml', 'YAML'], ['yaml', 'YAML'], ['toml', 'TOML'],
  ['md', 'Markdown'], ['mdx', 'Markdown'], ['sql', 'SQL'], ['dart', 'Dart'], ['lua', 'Lua'],
  ['ex', 'Elixir'], ['exs', 'Elixir'], ['scala', 'Scala'], ['clj', 'Clojure'], ['hs', 'Haskell'],
  ['m', 'Objective-C'], ['mm', 'Objective-C'], ['plist', 'Plist'], ['gradle', 'Gradle'],
  ['xml', 'XML'], ['proto', 'Protocol Buffers'],
]);

/** 一眼就是「别人写的 / 构建出来的」的目录：这些目录里的字节不计入语言占比。 */
const VENDOR_PATH_RE = /(^|\/)(vendor|node_modules|third_party|dist|build|Pods)\//;
/** 数据而不是代码：抓包日志、数据集这类，按扩展名排除（它们不是「用什么语言写的」）。 */
const DATA_EXT = new Set(['log', 'jsonl', 'ndjson']);
/** 生成物的形状判据：够大、并且平均每行超长（压缩/内联过的产物一行就是几万字符）。 */
const MINIFIED_MIN_BYTES = 64 * 1024;
const MINIFIED_AVG_LINE = 2000;
const MINIFIED_MAX_LINES = 3;

/** 认识的二进制扩展名：语言占比只算文本，这些一个字节都不计入（否则图片会把「其他」撑成大头）。 */
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'heic', 'psd', 'ai', 'sketch',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar',
  'apk', 'aab', 'ipa', 'jar', 'class', 'so', 'dylib', 'dll', 'exe', 'a', 'o', 'wasm',
  'mp3', 'mp4', 'mov', 'm4a', 'wav', 'webm', 'avi', 'mkv',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'keystore', 'jks', 'p12', 'p8', 'cer', 'der', 'mobileprovision', 'provisionprofile',
  'db', 'sqlite', 'sqlite3', 'realm', 'bin', 'dat', 'lockb',
]);

/** 一行 hunk 的边界：截断时只保留完整的 hunk，不把半行喂给前端。 */
function cutDiff(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  let sliced = text.slice(0, maxBytes);
  const boundary = sliced.lastIndexOf('\n@@');
  if (boundary > 0) sliced = sliced.slice(0, boundary + 1);
  return { text: sliced, truncated: true };
}

/** 仓库摘要：分支、是否 detached、上游、领先落后、脏文件数。 */
async function repoOf(root) {
  const { stdout } = await runGitStrict(root, [
    'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all',
  ], { timeoutMs: 8000 });
  const { entries, branch } = parseStatusZ(stdout);
  return {
    isRepo: true,
    root,
    name: basename(root),
    branch: branch.head,
    detached: !branch.head,
    head: branch.oid ? branch.oid.slice(0, 7) : null,
    upstream: branch.upstream || null,
    ahead: branch.upstream ? branch.ahead : null,
    behind: branch.upstream ? branch.behind : null,
    dirtyCount: entries.length,
    conflictedCount: entries.filter((entry) => entry.conflicted).length,
  };
}

/**
 * 变更清单：已暂存 / 未暂存 / 未跟踪 / 冲突四组。
 *
 * 增删行数来自 `--numstat`（二进制给 `-`，归一成 `binary: true` 与 0），未跟踪文件没有 diff，
 * 增删一律给 0；前端要显示多少行得等它点进 diff（那里会把整个文件当新增读出来）。
 */
async function statusOf(root) {
  const [statusResult, unstagedResult, stagedResult] = await Promise.all([
    runGitStrict(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], { timeoutMs: 8000 }),
    runGit(root, ['diff', '--numstat', '-z', '--find-renames'], { timeoutMs: 8000 }),
    runGit(root, ['diff', '--cached', '--numstat', '-z', '--find-renames'], { timeoutMs: 8000 }),
  ]);
  const { entries } = parseStatusZ(statusResult.stdout);
  const unstagedStats = new Map(parseNumstatZ(unstagedResult.stdout).map((item) => [item.path, item]));
  const stagedStats = new Map(parseNumstatZ(stagedResult.stdout).map((item) => [item.path, item]));

  const staged = [];
  const unstaged = [];
  const untracked = [];
  const conflicted = [];
  for (const entry of entries) {
    const base = { path: entry.path, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}) };
    if (entry.conflicted) {
      conflicted.push({ ...base, status: 'U', additions: 0, deletions: 0, binary: false, stage: 'unstaged' });
      continue;
    }
    if (entry.untracked) {
      untracked.push({ ...base, status: '?', additions: 0, deletions: 0, binary: false, stage: 'untracked' });
      continue;
    }
    if (entry.x !== '.' && entry.x !== ' ') {
      const stats = stagedStats.get(entry.path) || {};
      staged.push({
        ...base,
        status: entry.x,
        additions: stats.additions ?? 0,
        deletions: stats.deletions ?? 0,
        binary: Boolean(stats.binary),
        stage: 'staged',
      });
    }
    if (entry.y !== '.' && entry.y !== ' ') {
      const stats = unstagedStats.get(entry.path) || {};
      unstaged.push({
        ...base,
        status: entry.y,
        additions: stats.additions ?? 0,
        deletions: stats.deletions ?? 0,
        binary: Boolean(stats.binary),
        stage: 'unstaged',
      });
    }
  }
  return { staged, unstaged, untracked, conflicted };
}

/** 未跟踪文件的 diff：git 不认为它有过改动，直接把这个文件当「全部新增」读出来。 */
async function untrackedDiff(root, path) {
  const full = join(root, path);
  let info;
  try {
    info = await stat(full);
  } catch {
    const failure = new Error('文件不存在');
    failure.code = 'NOT_FOUND';
    throw failure;
  }
  if (info.size > MAX_DIFF_BYTES) {
    return { binary: false, truncated: true, hunks: [{ header: `@@ -0,0 +1,${0} @@`, lines: [] }] };
  }
  let text = '';
  try {
    text = await readFile(full, 'utf8');
  } catch {
    const failure = new Error('读不了这个文件');
    failure.code = 'NOT_FOUND';
    throw failure;
  }
  if (text.includes('\u0000')) return { binary: true, truncated: false, hunks: [] };
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return {
    binary: false,
    truncated: false,
    hunks: [{
      header: `@@ -0,0 +1,${lines.length} @@`,
      lines: lines.map((line, index) => ({ kind: 'add', text: line, oldLine: null, newLine: index + 1 })),
    }],
  };
}

/**
 * 单文件 diff。三个来源：工作区（默认）、索引（`staged`）、某次提交（`commit`）。
 *
 * 二进制不画假行：给 `binary: true` 与空 hunk，由界面自己说一句。
 */
async function diffOf(root, { path, staged = false, commit = null }) {
  if (commit) {
    const result = await runGit(root, [
      'show', '--no-color', '--no-ext-diff', '--format=', '--find-renames', '--unified=3', commit, '--', path,
    ], { timeoutMs: 10000 });
    if (result.code !== 0) {
      const failure = new Error((result.stderr || '').trim() || '取不到这次提交的 diff');
      failure.code = 'GIT_FAILED';
      throw failure;
    }
    return { binary: false, truncated: false, ...parseDiffText(result.stdout) };
  }
  if (staged) {
    const result = await runGit(root, [
      'diff', '--cached', '--no-color', '--no-ext-diff', '--find-renames', '--unified=3', '--', path,
    ], { timeoutMs: 8000 });
    if (result.code !== 0) {
      const failure = new Error((result.stderr || '').trim() || '取不到 diff');
      failure.code = 'GIT_FAILED';
      throw failure;
    }
    return { binary: false, truncated: false, ...parseDiffText(result.stdout) };
  }
  const tracked = await runGitStrict(root, ['ls-files', '-z', '--', path], { timeoutMs: 8000 });
  if (!tracked.stdout) {
    // 未跟踪：索引里没有它，git diff 对它一个字都不吐。
    const untracked = await untrackedDiff(root, path);
    return { path, status: '?', additions: untracked.hunks.length ? untracked.hunks[0].lines.length : 0, deletions: 0, ...untracked };
  }
  const result = await runGit(root, [
    'diff', '--no-color', '--no-ext-diff', '--find-renames', '--unified=3', '--', path,
  ], { timeoutMs: 8000 });
  if (result.code !== 0) {
    const failure = new Error((result.stderr || '').trim() || '取不到 diff');
    failure.code = 'GIT_FAILED';
    throw failure;
  }
  const cut = cutDiff(result.stdout, MAX_DIFF_BYTES);
  const parsed = parseDiffText(cut.text);
  const additions = parsed.hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.kind === 'add').length, 0);
  const deletions = parsed.hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.kind === 'del').length, 0);
  return { binary: parsed.binary, truncated: cut.truncated, additions, deletions, hunks: parsed.hunks };
}

/**
 * 提交历史（一页）。分页用 `skip` 而不是游标：这一页只做「往下翻」，不做跨设备稳定分页，
 * 少一份游标就少一处对不齐；多给一条用来判 `hasMore`。
 */
async function logOf(root, { limit = DEFAULT_LOG_LIMIT, skip = 0 } = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || DEFAULT_LOG_LIMIT, 1), MAX_LOG_LIMIT);
  const offset = Math.max(Number(skip) || 0, 0);
  const result = await runGit(root, [
    'log', `--max-count=${pageSize + 1}`, `--skip=${offset}`, '--numstat', '-z', '--no-color',
    `--format=${RECORD}%H${UNIT}%h${UNIT}%an${UNIT}%aI${UNIT}%s`,
  ], { timeoutMs: 12000, maxBytes: 8 * 1024 * 1024 });
  if (result.code !== 0) {
    // 空仓库（还没有第一个提交）不是错误：历史就是空的。
    if (/does not have any commits|ambiguous argument/i.test(result.stderr || '')) {
      return { commits: [], hasMore: false };
    }
    const failure = new Error((result.stderr || '').trim() || '取不到提交历史');
    failure.code = 'GIT_FAILED';
    throw failure;
  }
  const commits = parseLogZ(result.stdout);
  const hasMore = commits.length > pageSize;
  return { commits: commits.slice(0, pageSize), hasMore };
}

/** 单次提交：信息 + 文件清单（带增删与改名前的路径）。 */
async function showOf(root, hash) {
  const [meta, body, stats, names] = await Promise.all([
    runGitStrict(root, ['show', '-s', `--format=%H${UNIT}%h${UNIT}%an${UNIT}%aI${UNIT}%s`, hash], { timeoutMs: 8000 }),
    runGitStrict(root, ['show', '-s', '--format=%B', hash], { timeoutMs: 8000 }),
    runGit(root, ['show', '--numstat', '-z', '--format=', '--find-renames', hash], { timeoutMs: 10000 }),
    runGit(root, ['show', '--name-status', '-z', '--format=', '--find-renames', hash], { timeoutMs: 10000 }),
  ]);
  const fields = meta.stdout.trim().split(UNIT);
  const statByPath = new Map(parseNumstatZ(stats.stdout).map((item) => [item.path, item]));
  const files = parseNameStatusZ(names.stdout).map((entry) => {
    const info = statByPath.get(entry.path) || {};
    return {
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      status: entry.status,
      additions: info.additions ?? 0,
      deletions: info.deletions ?? 0,
      binary: Boolean(info.binary),
    };
  });
  return {
    commit: {
      hash: fields[0] || hash,
      shortHash: fields[1] || hash.slice(0, 7),
      author: fields[2] || '',
      time: fields[3] || '',
      subject: fields[4] || '',
      message: body.stdout.trim(),
      filesChanged: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      files,
    },
  };
}

/**
 * 分支清单：本地（可切、可新建）与远端（只读）。
 *
 * 领先 / 落后对每条有上游的分支都给，来源是 git 自己的 `%(upstream:track)`，只认里面的两个
 * 数字（措辞随版本变，数字不会）；认不出就给 null，界面按「没上游」显示。
 */
async function branchesOf(root) {
  const [refs, summary] = await Promise.all([
    runGitStrict(root, [
      'for-each-ref', 'refs/heads', 'refs/remotes',
      '--format=%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(objectname:short)%00%(committerdate:iso-strict)%00%(upstream:track)',
    ], { timeoutMs: 10000 }),
    repoOf(root),
  ]);
  const branches = [];
  for (const line of refs.stdout.split('\n')) {
    if (!line) continue;
    const [full, short, head, upstream, shortHash, time, track] = line.split('\0');
    if (!short) continue;
    const remote = full.startsWith('refs/remotes/');
    if (remote && /\/HEAD$/.test(full)) continue;
    const aheadBehind = /ahead (\d+)/.test(track || '') || /behind (\d+)/.test(track || '')
      ? {
        ahead: Number((/ahead (\d+)/.exec(track) || [0, 0])[1]),
        behind: Number((/behind (\d+)/.exec(track) || [0, 0])[1]),
      }
      : null;
    branches.push({
      name: short,
      remote,
      current: head === '*',
      upstream: upstream || null,
      lastCommitShort: shortHash || null,
      lastCommitTime: time || null,
      ahead: aheadBehind ? aheadBehind.ahead : null,
      behind: aheadBehind ? aheadBehind.behind : null,
    });
  }
  return { current: summary.branch, detached: summary.detached, branches };
}

/**
 * 所有远端（origin 排第一，其余按名字）。只读配置，不联网。
 *
 * 为什么不是只看 origin：开发机的 origin 常常是本地镜像 / 另一个远端，真正的 GitHub 仓库挂在
 * upstream 上；只认 origin 会出现「明明关联了 GitHub，页面却说没有」。
 */
async function remotesOf(root) {
  const list = await runGit(root, ['remote'], { timeoutMs: 4000 });
  const names = (list.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  names.sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : a < b ? -1 : a > b ? 1 : 0));
  const remotes = [];
  for (const name of names) {
    const url = await runGit(root, ['config', '--get', `remote.${name}.url`], { timeoutMs: 4000 });
    const value = (url.stdout || '').trim();
    if (value) remotes.push({ name, url: value });
  }
  return remotes;
}

/** 从远端地址里认出 github 的 owner/repo；不是 github 就返回 null。 */
function githubTargetOf(remote) {
  if (!remote) return null;
  const https = /^(?:https?:\/\/)(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote);
  if (https) return { owner: https[1], repo: https[2] };
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  return null;
}

/**
 * GitHub 元信息（星标 / Fork / 关注）。
 *
 * 只取这三个数字，不取星标曲线：曲线要把 stargazers 一页页翻完，几千星的仓库等于几十次
 * 请求，撞上匿名限流就整页变慢。有 `GITHUB_TOKEN` / `GH_TOKEN` 时带上，私有仓库也能读。
 *
 * 「读不到」和「没有 GitHub 远端」要分开：私有仓库的匿名请求回 404，是两件事，前端那句
 * 话必须说对。
 */
async function githubOf(root) {
  const remotes = await remotesOf(root);
  const remoteUrl = remotes.length > 0 ? remotes[0].url : null;
  const hit = remotes.find((item) => githubTargetOf(item.url));
  if (!hit) return { remote: remoteUrl, github: null, githubRepo: null, githubError: 'not-github' };
  const target = githubTargetOf(hit.url);
  const repo = `${target.owner}/${target.repo}`;
  const token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.github.com/repos/${target.owner}/${target.repo}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-mobile-plugin',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) return { remote: remoteUrl, github: null, githubRepo: repo, githubError: 'unreadable' };
    const body = await response.json();
    return {
      remote: remoteUrl,
      githubRepo: repo,
      githubError: null,
      github: {
        owner: target.owner,
        repo: target.repo,
        stars: Number(body.stargazers_count) || 0,
        forks: Number(body.forks_count) || 0,
        watchers: Number(body.subscribers_count ?? body.watchers_count) || 0,
        starHistory: [],
      },
    };
  } catch {
    return { remote: remoteUrl, github: null, githubRepo: repo, githubError: 'unreadable' };
  } finally {
    clearTimeout(timer);
  }
}

/** 已跟踪文件清单（概览统计用），有上限。 */
async function trackedFiles(root) {
  const result = await runGit(root, ['ls-files', '-z'], { timeoutMs: 12000, maxBytes: 16 * 1024 * 1024 });
  if (result.code !== 0) return { files: [], truncated: false };
  const files = result.stdout.split('\0').filter(Boolean);
  const truncated = files.length > MAX_OVERVIEW_FILES;
  return { files: truncated ? files.slice(0, MAX_OVERVIEW_FILES) : files, truncated };
}

/** 语言占比（按字节，与 GitHub 同口径）与代码行数。 */
async function codeBreakdown(root, files) {
  const bytesByLanguage = new Map();
  let lines = 0;
  let totalBytes = 0;
  let counters = { files: 0, skipped: 0, binary: 0, data: 0, vendored: 0, generated: 0 };
  for (const file of files) {
    let info;
    try {
      info = await stat(join(root, file));
    } catch {
      counters.skipped += 1;
      continue;
    }
    if (!info.isFile()) continue;
    counters.files += 1;
    const ext = extname(file).slice(1).toLowerCase();
    // 图片 / 压缩包 / 字体这些不算「语言」：GitHub 的语言条也不统计它们。
    if (BINARY_EXT.has(ext)) {
      counters.binary += 1;
      continue;
    }
    // 数据（抓包日志之类）不是「用什么语言写的」，构建产物与第三方目录也不算。
    if (DATA_EXT.has(ext)) {
      counters.data += 1;
      continue;
    }
    if (VENDOR_PATH_RE.test(file)) {
      counters.vendored += 1;
      continue;
    }
    let text = null;
    if (info.size <= MAX_FILE_BYTES && totalBytes + info.size <= MAX_TOTAL_BYTES) {
      try {
        text = await readFile(join(root, file), 'utf8');
        totalBytes += info.size;
      } catch {
        counters.skipped += 1;
      }
    }
    // 读到了才发现是二进制（扩展名不认识的那种）也不计语言；没读的大文件按扩展名算文本。
    if (text !== null && text.includes('\u0000')) {
      counters.binary += 1;
      continue;
    }
    // 压缩 / 内联过的产物：几百 KB 只有一两行，或者平均每行上万字符（面板产物就是内联成一行的
    // 一坨 JS+CSS）。不认出来，这两份 HTML 会独占语言条一成多。
    if (text !== null && info.size >= MINIFIED_MIN_BYTES) {
      let newlines = 0;
      for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) newlines += 1;
      const averageLine = info.size / Math.max(1, newlines + 1);
      if (newlines <= MINIFIED_MAX_LINES || averageLine > MINIFIED_AVG_LINE) {
        counters.generated += 1;
        continue;
      }
    }
    const language = LANGUAGES.get(ext) || '其他';
    bytesByLanguage.set(language, (bytesByLanguage.get(language) || 0) + info.size);
    if (text === null) continue;
    for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) lines += 1;
  }
  const total = [...bytesByLanguage.values()].reduce((sum, value) => sum + value, 0);
  const ranked = [...bytesByLanguage.entries()].sort((a, b) => b[1] - a[1]);
  const head = ranked.slice(0, MAX_LANGUAGES);
  const tail = ranked.slice(MAX_LANGUAGES);
  if (tail.length > 0) {
    // 排不进前十的并进「其他」，而不是丢掉：丢掉的字节会让百分比加起来不到 100，
    // 看上去像统计出错；并进去之后「其他」至少是个诚实的兜底。
    const folded = tail.reduce((sum, [, bytes]) => sum + bytes, 0);
    const otherIndex = head.findIndex(([name]) => name === '其他');
    if (otherIndex >= 0) head[otherIndex][1] += folded;
    else head.push(['其他', folded]);
  }
  const languages = head.map(([name, bytes]) => ({ name, percent: total > 0 ? Math.round((bytes / total) * 1000) / 10 : 0 }));
  return { languages, lines, files: counters.files };
}

/** 历史规模与活动：提交数、贡献者、首末提交、标签、近 12 周每周提交数、近 30 天增删。 */
async function activityOf(root) {
  const [counts, authors, last, roots, tags, recent] = await Promise.all([
    runGit(root, ['rev-list', '--count', 'HEAD'], { timeoutMs: 10000 }),
    runGit(root, ['log', '--format=%ae', '--no-merges'], { timeoutMs: 15000, maxBytes: 8 * 1024 * 1024 }),
    runGit(root, ['log', '-1', '--format=%aI'], { timeoutMs: 6000 }),
    runGit(root, ['rev-list', '--max-parents=0', 'HEAD'], { timeoutMs: 8000 }),
    runGit(root, ['for-each-ref', 'refs/tags', '--format=.'], { timeoutMs: 8000 }),
    runGit(root, ['log', '--since=12.weeks', '--numstat', '-z', '--format=' + RECORD + '%aI'], { timeoutMs: 15000, maxBytes: 16 * 1024 * 1024 }),
  ]);
  const commits = Number((counts.stdout || '').trim()) || 0;
  const contributors = new Set((authors.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean)).size;
  const lastCommit = (last.stdout || '').trim() || null;
  let firstCommit = null;
  const rootCommit = (roots.stdout || '').split('\n').map((line) => line.trim()).find(Boolean);
  if (rootCommit) {
    const shown = await runGit(root, ['show', '-s', '--format=%aI', rootCommit], { timeoutMs: 6000 });
    firstCommit = (shown.stdout || '').trim() || null;
  }
  const tagCount = (tags.stdout || '').split('\n').filter(Boolean).length;

  const now = Date.now();
  const week = 7 * 24 * 60 * 60 * 1000;
  const weeklyCommits = new Array(12).fill(0);
  let additions30d = 0;
  let deletions30d = 0;
  for (const block of (recent.stdout || '').split(RECORD)) {
    const trimmed = block.replace(/^\n/, '');
    if (!trimmed) continue;
    const [time, ...stats] = trimmed.split('\0');
    const when = Date.parse(time);
    if (!Number.isFinite(when)) continue;
    const weeksAgo = Math.floor((now - when) / week);
    if (weeksAgo >= 0 && weeksAgo < 12) weeklyCommits[11 - weeksAgo] += 1;
    if (now - when <= 30 * 24 * 60 * 60 * 1000) {
      for (const item of parseNumstatZ(stats.join('\0'))) {
        additions30d += item.additions;
        deletions30d += item.deletions;
      }
    }
  }
  return { commits, contributors, firstCommit, lastCommit, tags: tagCount, weeklyCommits, additions30d, deletions30d };
}

/**
 * 仓库概览：远端、语言占比、代码量、近 12 周活动，外加（能取到时）GitHub 的三个数字。
 *
 * 这张卡最贵，所以结果按仓库缓存一分钟（`fresh` 跳过），每项都自己兜底：语言统计有读取
 * 上限，历史统计失败退化成 0，GitHub 取不到就整块不给。它不该把整页拖垮。
 */
async function overviewOf(root, options = {}) {
  const cached = overviewCache.get(root);
  if (cached && !options.fresh && Date.now() - cached.at < OVERVIEW_CACHE_MS) return cached.value;
  const { files, truncated } = await trackedFiles(root);
  const [breakdown, activity, githubView] = await Promise.all([
    codeBreakdown(root, files),
    activityOf(root),
    githubOf(root),
  ]);
  const value = {
    remote: githubView.remote,
    githubRepo: githubView.githubRepo,
    githubError: githubView.githubError,
    ...(githubView.github ? { github: githubView.github } : {}),
    languages: breakdown.languages,
    code: {
      files: breakdown.files,
      lines: breakdown.lines,
      commits: activity.commits,
      contributors: activity.contributors,
      firstCommit: activity.firstCommit,
      lastCommit: activity.lastCommit,
      tags: activity.tags,
      weeklyCommits: activity.weeklyCommits,
      additions30d: activity.additions30d,
      deletions30d: activity.deletions30d,
      truncated,
    },
  };
  overviewCache.set(root, { at: Date.now(), value });
  return value;
}

module.exports = {
  MAX_DIFF_BYTES,
  MAX_LOG_LIMIT,
  DEFAULT_LOG_LIMIT,
  LANGUAGES,
  repoOf,
  statusOf,
  diffOf,
  logOf,
  showOf,
  branchesOf,
  overviewOf,
  githubTargetOf,
};

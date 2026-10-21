'use strict';

/**
 * 移动端 Git 管理器：十一条 `/api/mobile/v1/git/*` 的 handler。
 *
 * 能力面刻意收成**固定命名的动词**，不接受「传一条 git 命令」：这条 API 的边界是不暴露
 * shell，而 `git -c core.pager=less ...` 这种透传等于把 shell 交出去。所以这里只认
 * 「仓库摘要 / 变更清单 / 单个文件的 diff / 历史 / 单次提交 / 分支 / 概览」加上
 * 「暂存 / 取消暂存 / 提交 / 切分支 / 新建分支」这些动作，参数只有仓库、相对路径、分支名、
 * 提交信息四类值。
 *
 * 归属校验在这一层做两遍：① `workspaceId` 必须是这台设备已注册的工作区（宿主 `workspace.list`
 * 里找得到）；② 请求里的仓库根必须是 `lib/mobile/git-repos.js` 给这个项目识别出来的那几个根
 * 之一 —— 于是「随便传一个路径」这条路根本走不通，`..`、绝对路径、仓库外的目录都进不来。
 *
 * 写操作按仓库串行（`withRepoLock`）：手机上连点两下就是两个并发写，撞上 `.git/index.lock`
 * 会互相踩死；写完顺手回一份新的变更清单，省掉前端一次往返。
 *
 * 明确不做：合并 / 变基 / 拣选 / 冲突解决 / 强制推送 / 删除远端分支 / 改配置与凭据 /
 * 子模块管理 / fetch、pull、push（页面上还没有入口）。丢弃改动也没做 —— 那是不可恢复的
 * 删工作，接口留白比给一个能被误按的按钮安全。
 */

const { isAbsolute, resolve } = require('node:path');

const { readJsonBody, sendJson } = require('../shared/http-util');
const { unwrap } = require('./envelope.js');
const { describeProjectGit } = require('./git-repos.js');
const read = require('../git/read');
const { runGit, withRepoLock } = require('../git/exec');

/** 错误码 → HTTP 状态。前端只认 code，message 只用于排障与兜底文案。 */
const STATUS_BY_CODE = {
  BAD_REQUEST: 400,
  PATH_OUTSIDE: 400,
  EMPTY_MESSAGE: 400,
  NOTHING_STAGED: 400,
  IDENTITY_MISSING: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_A_REPO: 404,
  DIRTY: 409,
  DETACHED: 409,
  NO_UPSTREAM: 409,
  CONFLICT: 409,
  LOCKED: 409,
  HOOK_FAILED: 409,
  GIT_FAILED: 500,
  WORKSPACE_UNAVAILABLE: 502,
  GIT_UNAVAILABLE: 503,
  TIMEOUT: 504,
};

class GitRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GitRequestError';
    this.code = code;
  }
}

function fail(code, message) {
  return new GitRequestError(code, message);
}

/** 统一出包：错误码是契约，HTTP 状态只是顺带。 */
function handle(fn) {
  return async (ctx, req, res) => {
    try {
      await fn(ctx, req, res);
    } catch (error) {
      const code = error && typeof error.code === 'string' ? error.code : 'GIT_FAILED';
      const status = STATUS_BY_CODE[code] || 500;
      const message = error && typeof error.message === 'string' && error.message
        ? error.message
        : 'Git 操作失败';
      // git 的 stderr 只在服务端日志里有价值（英文、随版本变），不下发给手机。
      sendJson(res, status, { ok: false, error: { code, message } });
    }
  };
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function query(req) {
  return new URL(req.url || '/', 'http://x').searchParams;
}

async function bodyJson(req) {
  const body = await readJsonBody(req, 64 * 1024);
  if (!body || typeof body !== 'object') throw fail('BAD_REQUEST', '需要 JSON 请求体');
  return body;
}

/** 仓库内的相对路径：绝对路径、盘符、任何一段 `..` 一律拒掉。 */
function repoTargetPath(value) {
  const raw = text(value);
  if (!raw || raw.length > 4096) throw fail('PATH_OUTSIDE', '需要仓库内的相对路径');
  if (isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) throw fail('PATH_OUTSIDE', '只接受相对仓库根的路径');
  const segments = raw.split(/[\\/]/);
  if (segments.some((segment) => segment === '..')) throw fail('PATH_OUTSIDE', '路径里不许出现 ..');
  const normalized = segments.filter((segment) => segment && segment !== '.').join('/');
  if (!normalized) throw fail('PATH_OUTSIDE', '需要仓库内的相对路径');
  return normalized;
}

function pathList(value) {
  const list = Array.isArray(value) ? value : [value];
  return list.map(repoTargetPath).filter(Boolean);
}

/**
 * 把请求落到一个具体的仓库根上。
 *
 * `repo` 可以不给（默认主仓库）；给了就必须是识别结果里的那几个根之一，而且必须是绝对路径 ——
 * 相对路径会被插件自己的 cwd 解释，那是另一种「越界」。
 */
async function resolveTarget(ctx, params) {
  const workspaceId = text(params.workspaceId);
  if (!workspaceId) throw fail('BAD_REQUEST', '需要 workspaceId');
  const listed = await ctx.apiProxy.workspace.list({ rpcId: 'mobile', method: 'workspace.list', payload: {} });
  const { value, error } = unwrap(listed);
  if (error) throw fail('WORKSPACE_UNAVAILABLE', '取不到工作区清单，稍后再试');
  const items = Array.isArray(value) ? value : (value && Array.isArray(value.items) ? value.items : []);
  const item = items.find((entry) => entry && entry.workspaceId === workspaceId);
  if (!item) throw fail('FORBIDDEN', '这个工作区不在这台机器上');
  const projectPath = text(item.path);
  if (!projectPath) throw fail('NOT_A_REPO', '这个工作区没有对应目录');
  const marker = await describeProjectGit(projectPath);
  if (!marker.isRepo) throw fail('NOT_A_REPO', '这个项目没有 Git 仓库');
  const requested = text(params.repo);
  if (requested && !isAbsolute(requested)) throw fail('FORBIDDEN', '仓库根要用绝对路径');
  const repoRoot = requested ? resolve(requested) : marker.root;
  if (!marker.repos.some((repo) => repo.root === repoRoot)) {
    throw fail('FORBIDDEN', '这个仓库不在该项目的识别结果里');
  }
  return { projectPath, repoRoot };
}

/** HEAD 是否存在：空仓库（还没有第一个提交）时很多命令的行为不一样。 */
async function hasHead(root) {
  const result = await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeoutMs: 4000 });
  return result.code === 0;
}

/** 把 git 的失败翻译成契约里的错误码（stderr 只用来分类，不下发）。 */
function classifyCommitFailure(stderr) {
  const textValue = String(stderr || '');
  if (/nothing to commit|no changes added/i.test(textValue)) return fail('NOTHING_STAGED', '没有可提交的暂存内容');
  if (/hook/i.test(textValue)) return fail('HOOK_FAILED', '仓库的钩子拒绝了这次提交，回电脑上看一下');
  if (/Please tell me who you are|unable to auto-detect email|empty ident/i.test(textValue)) {
    return fail('IDENTITY_MISSING', '这台电脑上的 git 还没配好提交身份（user.name / user.email）');
  }
  return fail('GIT_FAILED', '提交失败，回电脑上看一下具体原因');
}

// ── 只读 ────────────────────────────────────────────────────────────────────

/** GET git/repo */
async function handleGitRepo(ctx, req, res) {
  const params = query(req);
  const target = await resolveTarget(ctx, {
    workspaceId: params.get('workspaceId'),
    repo: params.get('repo'),
  });
  sendJson(res, 200, { ok: true, ...(await read.repoOf(target.repoRoot)) });
}

/** GET git/status：四个分组，带每个文件的增删与二进制标记。 */
async function handleGitStatus(ctx, req, res) {
  const params = query(req);
  const target = await resolveTarget(ctx, {
    workspaceId: params.get('workspaceId'),
    repo: params.get('repo'),
  });
  sendJson(res, 200, { ok: true, ...(await read.statusOf(target.repoRoot)) });
}

/** GET git/diff?path=&staged=1&commit=<hash> */
async function handleGitDiff(ctx, req, res) {
  const params = query(req);
  const target = await resolveTarget(ctx, {
    workspaceId: params.get('workspaceId'),
    repo: params.get('repo'),
  });
  const path = repoTargetPath(params.get('path'));
  const commit = text(params.get('commit'));
  if (commit && !/^[0-9a-f]{4,64}$/i.test(commit)) throw fail('BAD_REQUEST', '提交号不合法');
  const staged = params.get('staged') === '1' || params.get('staged') === 'true';
  const diff = await read.diffOf(target.repoRoot, { path, staged, commit: commit || null });
  sendJson(res, 200, { ok: true, path, ...diff });
}

/** GET git/log?limit=&skip= */
async function handleGitLog(ctx, req, res) {
  const params = query(req);
  const target = await resolveTarget(ctx, {
    workspaceId: params.get('workspaceId'),
    repo: params.get('repo'),
  });
  const page = await read.logOf(target.repoRoot, {
    limit: Number(params.get('limit')) || read.DEFAULT_LOG_LIMIT,
    skip: Number(params.get('skip')) || 0,
  });
  sendJson(res, 200, { ok: true, ...page });
}

/** GET git/show?hash= */
async function handleGitShow(ctx, req, res) {
  const params = query(req);
  const target = await resolveTarget(ctx, {
    workspaceId: params.get('workspaceId'),
    repo: params.get('repo'),
  });
  const hash = text(params.get('hash'));
  if (!/^[0-9a-f]{4,64}$/i.test(hash)) throw fail('BAD_REQUEST', '提交号不合法');
  sendJson(res, 200, { ok: true, ...(await read.showOf(target.repoRoot, hash)) });
}

/** GET git/branches */
async function handleGitBranches(ctx, req, res) {
  const params = query(req);
  const target = await resolveTarget(ctx, {
    workspaceId: params.get('workspaceId'),
    repo: params.get('repo'),
  });
  sendJson(res, 200, { ok: true, ...(await read.branchesOf(target.repoRoot)) });
}

/** GET git/overview?fresh=1 */
async function handleGitOverview(ctx, req, res) {
  const params = query(req);
  const target = await resolveTarget(ctx, {
    workspaceId: params.get('workspaceId'),
    repo: params.get('repo'),
  });
  const fresh = params.get('fresh') === '1';
  sendJson(res, 200, { ok: true, ...(await read.overviewOf(target.repoRoot, { fresh })) });
}

// ── 写 ──────────────────────────────────────────────────────────────────────

/** POST git/stage { workspaceId, repo?, paths? | all? } */
async function handleGitStage(ctx, req, res) {
  const body = await bodyJson(req);
  const target = await resolveTarget(ctx, body);
  const all = body.all === true;
  const paths = all ? [] : pathList(body.paths ?? body.path);
  if (!all && paths.length === 0) throw fail('BAD_REQUEST', '要说清楚暂存哪些文件，或者给 all');
  const status = await withRepoLock(target.repoRoot, async () => {
    const result = all
      ? await runGit(target.repoRoot, ['add', '-A'], { timeoutMs: 30000 })
      : await runGit(target.repoRoot, ['add', '--', ...paths], { timeoutMs: 30000 });
    if (result.error === 'GIT_UNAVAILABLE') throw fail('GIT_UNAVAILABLE', '这台电脑上没有可用的 git');
    if (result.error === 'TIMEOUT') throw fail('TIMEOUT', '暂存超时了，稍后再试');
    if (result.code !== 0) throw fail('GIT_FAILED', '暂存失败（可能是文件已被删除或路径不在仓库里）');
    return read.statusOf(target.repoRoot);
  });
  sendJson(res, 200, { ok: true, status });
}

/** POST git/unstage { workspaceId, repo?, paths? | all? } */
async function handleGitUnstage(ctx, req, res) {
  const body = await bodyJson(req);
  const target = await resolveTarget(ctx, body);
  const all = body.all === true;
  const paths = all ? [] : pathList(body.paths ?? body.path);
  if (!all && paths.length === 0) throw fail('BAD_REQUEST', '要说清楚取消暂存哪些文件，或者给 all');
  const status = await withRepoLock(target.repoRoot, async () => {
    const head = await hasHead(target.repoRoot);
    // 空仓库（没有第一个提交）没有 HEAD 可 reset，只能把索引里的条目移除。
    const args = head
      ? (all ? ['reset', '-q'] : ['reset', '-q', 'HEAD', '--', ...paths])
      : (all ? ['rm', '-q', '-r', '--cached', '--', '.'] : ['rm', '-q', '-r', '--cached', '--', ...paths]);
    const result = await runGit(target.repoRoot, args, { timeoutMs: 30000 });
    if (result.error === 'GIT_UNAVAILABLE') throw fail('GIT_UNAVAILABLE', '这台电脑上没有可用的 git');
    if (result.error === 'TIMEOUT') throw fail('TIMEOUT', '取消暂存超时了，稍后再试');
    if (result.code !== 0) throw fail('GIT_FAILED', '取消暂存失败');
    return read.statusOf(target.repoRoot);
  });
  sendJson(res, 200, { ok: true, status });
}

/** POST git/commit { workspaceId, repo?, message }：只提交已暂存那批。 */
async function handleGitCommit(ctx, req, res) {
  const body = await bodyJson(req);
  const target = await resolveTarget(ctx, body);
  const message = text(body.message);
  if (!message) throw fail('EMPTY_MESSAGE', '先写一句提交信息');
  if (message.length > 8000) throw fail('BAD_REQUEST', '提交信息太长了');
  const result = await withRepoLock(target.repoRoot, async () => {
    const status = await read.statusOf(target.repoRoot);
    // 索引里有未合并路径时真实 git 也会拒，提前说清楚，别等它报一段英文。
    if (status.conflicted.length > 0) throw fail('CONFLICT', '还有没解决的冲突，回电脑上处理');
    if (status.staged.length === 0) throw fail('NOTHING_STAGED', '没有已暂存的文件');
    const committed = await runGit(target.repoRoot, ['commit', '-m', message], { timeoutMs: 30000 });
    if (committed.error === 'GIT_UNAVAILABLE') throw fail('GIT_UNAVAILABLE', '这台电脑上没有可用的 git');
    if (committed.error === 'TIMEOUT') throw fail('TIMEOUT', '提交超时了，稍后再试');
    if (committed.code !== 0) throw classifyCommitFailure(committed.stderr);
    const head = await runGit(target.repoRoot, ['rev-parse', 'HEAD'], { timeoutMs: 4000 });
    const short = await runGit(target.repoRoot, ['rev-parse', '--short', 'HEAD'], { timeoutMs: 4000 });
    return {
      hash: (head.stdout || '').trim(),
      shortHash: (short.stdout || '').trim(),
    };
  });
  sendJson(res, 200, { ok: true, hash: result.hash, shortHash: result.shortHash });
}

/** POST git/checkout { workspaceId, repo?, branch, create? }：切本地分支或新建一条。 */
async function handleGitCheckout(ctx, req, res) {
  const body = await bodyJson(req);
  const target = await resolveTarget(ctx, body);
  const branch = text(body.branch);
  if (!branch) throw fail('BAD_REQUEST', '需要分支名');
  const create = body.create === true;
  if (create) {
    const checked = await runGit(target.repoRoot, ['check-ref-format', '--branch', branch], { timeoutMs: 4000 });
    if (checked.code !== 0) throw fail('BAD_REQUEST', '分支名不合法');
  }
  const result = await withRepoLock(target.repoRoot, async () => {
    const summary = await read.repoOf(target.repoRoot);
    if (summary.detached) throw fail('DETACHED', '现在不在任何分支上，回电脑上处理');
    const status = await read.statusOf(target.repoRoot);
    // 有未提交的改动就拒绝：切分支时 git 可能把改动带过去，用户以为是另一份代码。
    if (status.staged.length > 0 || status.unstaged.length > 0 || status.conflicted.length > 0) {
      throw fail('DIRTY', '还有没提交的改动，先提交或回电脑上处理');
    }
    const switched = await runGit(target.repoRoot, create ? ['switch', '-c', branch] : ['switch', branch], { timeoutMs: 30000 });
    if (switched.error === 'GIT_UNAVAILABLE') throw fail('GIT_UNAVAILABLE', '这台电脑上没有可用的 git');
    if (switched.error === 'TIMEOUT') throw fail('TIMEOUT', '切分支超时了，稍后再试');
    if (switched.code !== 0) {
      const stderr = String(switched.stderr || '');
      if (/did not match any|no such branch|invalid reference/i.test(stderr)) {
        throw fail('NOT_FOUND', '没有这条分支');
      }
      if (/already exists/i.test(stderr)) throw fail('BAD_REQUEST', '这条分支已经存在了');
      throw fail('GIT_FAILED', '切分支失败');
    }
    return read.repoOf(target.repoRoot);
  });
  sendJson(res, 200, { ok: true, branch: result.branch, detached: result.detached });
}

module.exports = {
  handleGitRepo: handle(handleGitRepo),
  handleGitStatus: handle(handleGitStatus),
  handleGitDiff: handle(handleGitDiff),
  handleGitLog: handle(handleGitLog),
  handleGitShow: handle(handleGitShow),
  handleGitBranches: handle(handleGitBranches),
  handleGitOverview: handle(handleGitOverview),
  handleGitStage: handle(handleGitStage),
  handleGitUnstage: handle(handleGitUnstage),
  handleGitCommit: handle(handleGitCommit),
  handleGitCheckout: handle(handleGitCheckout),
  GitRequestError,
  repoTargetPath,
  resolveTarget,
};

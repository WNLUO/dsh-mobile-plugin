'use strict';

/**
 * 移动端 Git 管理器：十一条 `/api/mobile/v1/git/*` 的 handler。
 *
 * 能力面刻意收成**固定命名的动词**，不接受「传一条 git 命令」：这条 API 的边界是不暴露
 * shell，而 `git -c core.pager=less ...` 这种透传等于把 shell 交出去。所以这里只认
 * 「仓库摘要 / 变更清单 / 单个文件的 diff / 历史 / 单次提交 / 分支 / 概览」加上
 * 「暂存 / 取消暂存 / 提交 / 切分支 / 新建分支 / 推送到上游」这些动作，参数只有仓库、
 * 相对路径、分支名、提交信息四类值（push 连分支名都不收：只推当前分支到它自己的上游）。
 *
 * 归属校验在这一层做两遍：① `workspaceId` 必须是这台设备已注册的工作区（宿主 `workspace.list`
 * 里找得到）；② 请求里的仓库根必须是 `lib/mobile/git-repos.js` 给这个项目识别出来的那几个根
 * 之一 —— 于是「随便传一个路径」这条路根本走不通，`..`、绝对路径、仓库外的目录都进不来。
 *
 * 写操作按仓库串行（`withRepoLock`）：手机上连点两下就是两个并发写，撞上 `.git/index.lock`
 * 会互相踩死；写完顺手回一份新的变更清单，省掉前端一次往返。
 *
 * 明确不做：合并 / 变基 / 拣选 / 冲突解决 / 强制推送 / 删除远端分支 / 改配置与凭据 /
 * 子模块管理 / fetch、pull。**push 只做最窄的一档**（2026-10-22）：推当前分支到它已有的上游，
 * 不接受 `--force`、不收分支名参数 —— 远端分叉、没有上游一律拒掉并叫用户回电脑处理，
 * 因为「拉下来再合」这件事本来就留在电脑上。丢弃改动也没做 —— 那是不可恢复的删工作，
 * 接口留白比给一个能被误按的按钮安全。
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
  REJECTED: 409,
  AUTH_FAILED: 403,
  CONFLICT: 409,
  LOCKED: 409,
  HOOK_FAILED: 409,
  LLM_FAILED: 502,
  GIT_FAILED: 500,
  WORKSPACE_UNAVAILABLE: 502,
  REMOTE_UNAVAILABLE: 502,
  GIT_UNAVAILABLE: 503,
  LLM_UNAVAILABLE: 503,
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

/**
 * 把 push 的失败翻译成契约里的错误码。
 *
 * 用户这一端只可能做三件事：再推一次、回电脑上拉一下、回电脑上配凭据 —— 所以码就分这三类
 * （外加远端地址 / 网络本身不通），不要按 git 的英文措辞一五一十地回给手机。
 */
function classifyPushFailure(stderr) {
  const value = String(stderr || '');
  if (/no upstream branch|has no upstream branch|set-upstream/i.test(value)) {
    return fail('NO_UPSTREAM', '这条分支还没有上游分支：先在电脑上推一次建立跟踪');
  }
  if (/non-fast-forward|fetch first|\[rejected\]|\[remote rejected\]/i.test(value)) {
    return fail('REJECTED', '远端有你还没拉取的提交，先在电脑上拉取再推');
  }
  // 地址 / 网络先判：这类 stderr 末尾也会跟一句 "Please make sure you have the correct access
  // rights"，先判凭据会把「地址写错」说成「没配凭据」。
  if (/does not appear to be a git repository|could not resolve host|unable to access|connection (refused|timed out)|network is unreachable|no such remote/i.test(value)) {
    return fail('REMOTE_UNAVAILABLE', '连不上远端仓库，检查一下网络或远端地址');
  }
  if (/authentication failed|could not read username|could not read password|permission denied \(publickey\)|terminal prompts disabled|invalid username or password/i.test(value)) {
    return fail('AUTH_FAILED', '这台电脑上没有可用的远端凭据，回电脑上处理');
  }
  return fail('GIT_FAILED', '推送失败，回电脑上看一下具体原因');
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

// ── AI 提交信息 ─────────────────────────────────────────────────────────────

/** 喂给模型的最大 diff 字节数：太大既慢又贵，只留够判断「改了什么」的量。 */
const AI_DIFF_MAX_BYTES = 60 * 1024;
/** 给模型的总时限：等不到就报错，别让手机上一直转圈。 */
const AI_MESSAGE_TIMEOUT_MS = 30000;
/** 最终回给页面的提交信息长度上限（Conventional Commits 一行足够）。 */
const AI_MESSAGE_MAX_CHARS = 200;

const AI_SYSTEM_PROMPT = [
  '你在给一个 Git 仓库写提交信息。',
  '只输出一行 Conventional Commits 标题，格式 `type(scope): 说明`。',
  'type 只能是 feat / fix / refactor / docs / test / chore / perf / style / build / ci 之一；scope 可以省略。',
  '说明用中文、动词开头、说清这次改了什么，不超过 40 个汉字。',
  '不要代码块、不要引号、不要编号、不要解释，也不要句末的句号。',
  '只输出那一行。',
].join('\n');

/** 模型爱加的东西（代码块围栏、列表符号、引号、句末句号）就地剥掉，只留那一行。 */
function cleanCommitMessage(raw) {
  const lines = String(raw || '')
    .replace(/```[a-z]*/gi, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const first = (lines[0] || '')
    .replace(/^[-*\d.、)\s]+/, '')
    .replace(/^["'`「『]+|["'`」』]+$/g, '')
    .replace(/[。.]+$/, '')
    .trim();
  return first.slice(0, AI_MESSAGE_MAX_CHARS);
}

/**
 * POST git/commit-message { workspaceId, repo?, provider, model }
 *
 * 把「已暂存的改动」交给宿主那个 `llm` 服务（跟渠道包、agent loop 同一条流式路径），
 * 让它写一行 Conventional Commits 标题填进提交框 —— 只是**填框**，不提交、不推送。
 *
 * 边界：模型要由手机指定（选哪个是用户的事，宿主不猜）；暂存区空就直接拒（没有改动可总结，
 * 让模型凭空写一条比报错更糟）。这里只读 `git diff --cached`，不写盘。
 */
async function handleGitCommitMessage(ctx, req, res) {
  const body = await bodyJson(req);
  const target = await resolveTarget(ctx, body);
  const provider = text(body.provider);
  const model = text(body.model);
  if (!provider || !model) throw fail('BAD_REQUEST', '需要 provider 与 model');

  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : null;
  if (!llm || typeof llm.stream !== 'function') throw fail('LLM_UNAVAILABLE', '这台电脑上的模型服务不可用');

  const staged = await runGit(target.repoRoot, ['diff', '--cached', '--name-status', '--no-color'], { timeoutMs: 15000 });
  const names = String(staged.stdout || '').trim();
  if (!names) throw fail('NOTHING_STAGED', '没有已暂存的文件，先暂存几个再让 AI 写');

  const diff = await runGit(target.repoRoot, ['diff', '--cached', '--no-color', '--unified=2'], {
    timeoutMs: 20000,
    maxBytes: 4 * 1024 * 1024,
  });
  const diffText = String(diff.stdout || '').slice(0, AI_DIFF_MAX_BYTES);
  const prompt = [
    '这次已暂存的文件：',
    names.slice(0, 4000),
    '',
    '改动内容（可能已截断）：',
    diffText,
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_MESSAGE_TIMEOUT_MS);
  let written = '';
  let failure = null;
  try {
    for await (const chunk of llm.stream({
      provider,
      model,
      system: AI_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: 200,
      signal: controller.signal,
    })) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') written += chunk.text;
      if (chunk && chunk.type === 'finish') {
        // 协议层把失败摊在终止块上：`finish` 就是这次调用的最终结论。
        if (chunk.reason && chunk.reason.kind === 'error') failure = chunk.reason.failure || {};
        break;
      }
    }
  } catch (error) {
    if (controller.signal.aborted) throw fail('TIMEOUT', '这个模型 30 秒没有回话，换一个模型试试');
    throw fail('LLM_FAILED', String(error && error.message ? error.message : '模型调用失败').slice(0, 200));
  } finally {
    clearTimeout(timer);
  }

  if (failure) {
    throw fail('LLM_FAILED', String(failure.message || failure.code || '模型调用失败').slice(0, 200));
  }
  const message = cleanCommitMessage(written);
  if (!message) throw fail('LLM_FAILED', '模型没写出提交信息，换一个模型试试');
  sendJson(res, 200, { ok: true, message });
}

/**
 * POST git/push { workspaceId, repo? }：把当前分支推到它的上游，永不强制。
 *
 * 不收分支名、不收远端名、不收任何开关 —— 能做的只有「把我已经提交的推上去」。没有上游就拒
 * （让用户回电脑上推一次建立跟踪），落后远端也拒（拉取与合并留在电脑上），两条都不需要在这里
 * 猜用户想要什么。
 */
async function handleGitPush(ctx, req, res) {
  const body = await bodyJson(req);
  const target = await resolveTarget(ctx, body);
  const summary = await withRepoLock(target.repoRoot, async () => {
    if (!(await hasHead(target.repoRoot))) throw fail('NO_UPSTREAM', '这个仓库还没有第一次提交');
    const before = await read.repoOf(target.repoRoot);
    if (before.detached) throw fail('DETACHED', '现在不在任何分支上，回电脑上处理');
    if (!before.upstream) throw fail('NO_UPSTREAM', '这条分支还没有上游分支：先在电脑上推一次建立跟踪');
    const pushed = await runGit(target.repoRoot, ['push'], { timeoutMs: 60000 });
    if (pushed.error === 'GIT_UNAVAILABLE') throw fail('GIT_UNAVAILABLE', '这台电脑上没有可用的 git');
    if (pushed.error === 'TIMEOUT') throw fail('TIMEOUT', '推送超时了，稍后再试');
    // 退出码才是结论：「Everything up-to-date」也回 0，那不算失败。
    if (pushed.code !== 0) throw classifyPushFailure(pushed.stderr);
    return read.repoOf(target.repoRoot);
  });
  sendJson(res, 200, {
    ok: true,
    branch: summary.branch,
    detached: summary.detached,
    ahead: summary.ahead ?? 0,
    behind: summary.behind ?? 0,
  });
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
  handleGitPush: handle(handleGitPush),
  handleGitCommitMessage: handle(handleGitCommitMessage),
  GitRequestError,
  repoTargetPath,
  resolveTarget,
};

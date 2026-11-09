'use strict';

/**
 * GitHub PR 一层：列本分支的 PR、看检查、标可评审、合并（只 squash / merge）、读评论。
 *
 * 这一层是 `lib/mobile/git.js` 那组封闭动词的下半截 —— GitHub 的部分全在这里，handler 只做
 * 归属校验与参数校验。**不接受**调用方给的 URL / host / method / GraphQL：这里的每条路都写死
 * 成 `https://api.github.com` 下的固定 REST 子路径，参数只有 PR 号与合并方式两个值。
 *
 * 凭据沿用宿主环境里已有的 `GITHUB_TOKEN` / `GH_TOKEN`（与 `read.js` 的 GitHub 元信息同一条路），
 * 不在 App 里输 token、不落任何明文、不读凭据文件。
 *
 * 错误一律是带 `code` 的 Error：404 → `PR_NOT_FOUND`、401/403 → `GH_AUTH`、429 / 限流头见底 →
 * `GH_RATE_LIMITED`、网络与 5xx → `GH_UNAVAILABLE`。合并被 GitHub 拒时尽量分成
 * `CHECKS_FAILING`（检查没过）与 `MERGE_NOT_ALLOWED`（其余不可合并）。
 */

const { githubTargetOf, remotesOf } = require('./read');
const read = require('./read');

/** 固定基址。调用方给不了，也不该给。 */
const GITHUB_API = 'https://api.github.com';
/** 比 read.js 的元信息读宽一点：check-runs 与合并都可能多等一会儿。 */
const GITHUB_TIMEOUT_MS = 8000;
/** 列表一页的条数。PR 列表按当前分支过滤，一般就一两条。 */
const PULLS_PER_PAGE = 30;
const CHECKS_PER_PAGE = 100;

/** 合法的 PR 状态过滤；其余一律按 open。 */
const PR_STATES = new Set(['open', 'closed', 'merged', 'all']);
/** 合并方式只有两种：squash 与 merge。rebase 与自定义提交信息一律不收。 */
const MERGE_METHODS = new Set(['squash', 'merge']);

/** 列表里不额外拉 checks 时用的空汇总：字段必须齐全（前端按它画角标）。 */
function emptyChecks() {
  return { total: 0, passing: 0, failing: 0, pending: 0, status: 'none' };
}

function ghError(code, message) {
  const error = new Error(message);
  error.name = 'GitHubRequestError';
  error.code = code;
  return error;
}

/** 宿主环境里的 GitHub 凭据。只读环境变量，与 read.js 完全同一条路。 */
function githubToken() {
  return (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
}

function normalizeState(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return PR_STATES.has(raw) ? raw : 'open';
}

/**
 * 一条 check-run 的结论归一。
 *
 * GitHub 的 `conclusion` 在「还没跑完」时是 null，这时要看 `status`：completed 以外的都不算
 * 出结果，一律按 pending —— 把「还在跑」画成失败会让人白跑一趟。
 */
function normalizeConclusion(run) {
  const conclusion = run && typeof run.conclusion === 'string' ? run.conclusion.trim().toLowerCase() : '';
  if (!conclusion) {
    const status = run && typeof run.status === 'string' ? run.status.trim().toLowerCase() : '';
    if (status && status !== 'completed') return 'pending';
    return 'pending';
  }
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'action_required':
      return 'failure';
    case 'neutral':
      return 'neutral';
    case 'skipped':
      return 'skipped';
    case 'cancelled':
      return 'cancelled';
    case 'timed_out':
      return 'timed_out';
    case 'stale':
      return 'pending';
    default:
      return 'pending';
  }
}

/**
 * check-runs 数组 → 汇总。中性 / 跳过的算「过了」（它们没拦），pending 单独一档。
 *
 * 一条都没有时 `status: 'none'`：那是「没配 CI」，不是「全过了」。
 */
function summarizeChecks(checkRuns) {
  const list = Array.isArray(checkRuns) ? checkRuns : [];
  const summary = emptyChecks();
  for (const run of list) {
    const conclusion = normalizeConclusion(run);
    summary.total += 1;
    if (conclusion === 'pending') {
      summary.pending += 1;
    } else if (conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out') {
      summary.failing += 1;
    } else {
      summary.passing += 1;
    }
  }
  if (summary.total === 0) return summary;
  if (summary.failing > 0) summary.status = 'failing';
  else if (summary.pending > 0) summary.status = 'pending';
  else summary.status = 'passing';
  return summary;
}

/**
 * 打一次 GitHub REST。
 *
 * 只接固定子路径（以 `/` 开头、拼在 `https://api.github.com` 后面），不接完整 URL、不接 host、
 * 不接任意 method（GET / POST / PUT 三档够这一层用了）。
 *
 * 正常返回 `{ status, ok, json }`；非 2xx 按契约抛出带 `code` 的 Error，并带上 `status` 与
 * GitHub 的 `message`（合并那条要靠它区分「检查没过」与「其余不可合并」）。
 */
async function ghRequest(target, path, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw ghError('GH_UNAVAILABLE', '这个运行时没有 fetch，读不到 GitHub');
  if (typeof path !== 'string' || !path.startsWith('/')) throw ghError('BAD_REQUEST', 'GitHub 路径必须是以 / 开头的固定子路径');
  const method = options.method === 'POST' || options.method === 'PUT' ? options.method : 'GET';
  const token = githubToken();
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-mobile-plugin',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(`${GITHUB_API}${path}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
    });
  } catch {
    throw ghError('GH_UNAVAILABLE', '连不上 GitHub，检查一下网络或代理');
  } finally {
    clearTimeout(timer);
  }

  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  const status = Number(response.status) || 0;
  if (response.ok) return { status, ok: true, json };

  const remaining = response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('x-ratelimit-remaining')
    : null;
  const reason = json && typeof json.message === 'string' ? json.message : '';
  const error = (() => {
    if (status === 401) return ghError('GH_AUTH', '这台电脑上的 GitHub 凭据不可用');
    if (status === 403) {
      return String(remaining).trim() === '0'
        ? ghError('GH_RATE_LIMITED', 'GitHub 限流了，过一会儿再试')
        : ghError('GH_AUTH', '这个 GitHub 凭据没有权限做这件事');
    }
    if (status === 404) return ghError('PR_NOT_FOUND', reason || 'GitHub 上找不到这条 PR');
    if (status === 429) return ghError('GH_RATE_LIMITED', 'GitHub 限流了，过一会儿再试');
    if (status >= 500) return ghError('GH_UNAVAILABLE', 'GitHub 暂时不可用，稍后再试');
    if (status >= 400) return ghError('BAD_REQUEST', reason || 'GitHub 拒绝了这次请求');
    return ghError('GH_UNAVAILABLE', 'GitHub 没有回包，稍后再试');
  })();
  error.status = status;
  error.reason = reason;
  throw error;
}

/** 项目里的第一个 GitHub 远端 → `{ owner, repo }`；没有就 null。 */
async function githubRepoOf(root) {
  const remotes = await remotesOf(root);
  const hit = remotes.find((item) => githubTargetOf(item.url));
  if (!hit) return null;
  const target = githubTargetOf(hit.url);
  if (!target) return null;
  return { owner: target.owner, repo: target.repo };
}

/** 上面四个「必须有 GitHub 仓库」的动作共用：没有就按「没有 PR」回，不是 500。 */
async function requireGithubRepo(root) {
  const repo = await githubRepoOf(root);
  if (!repo) throw ghError('NO_PR', '这个项目没有关联 GitHub 远端，看不到 PR');
  return repo;
}

function repoPath(repo) {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
}

/** GitHub 的 PR 对象 → 下发的形状（字段名对齐 App 的 `GitPullRequest`）。 */
function toPullRequest(item) {
  const state = item && item.merged_at ? 'merged' : (item && item.state === 'open' ? 'open' : 'closed');
  return {
    number: Number(item.number) || 0,
    title: typeof item.title === 'string' ? item.title : '',
    headBranch: item.head && typeof item.head.ref === 'string' ? item.head.ref : '',
    baseBranch: item.base && typeof item.base.ref === 'string' ? item.base.ref : '',
    state,
    draft: Boolean(item.draft),
    // GitHub 的 mergeable 是异步算的：null = 还没算出来，不能当成 false。
    mergeable: typeof item.mergeable === 'boolean' ? item.mergeable : null,
    // 列表里不为每条 PR 再拉一次 check-runs（那是 N 次请求）；要看检查结果点进去走 checksOf。
    checks: emptyChecks(),
    author: item.user && typeof item.user.login === 'string' ? item.user.login : '',
    updatedAt: typeof item.updated_at === 'string' ? item.updated_at : '',
    url: typeof item.html_url === 'string' ? item.html_url : '',
  };
}

/**
 * 当前分支的 PR 列表。
 *
 * 不收分支名：一律用仓库当前分支（`read.repoOf` 的 branch）。detached 时没有「当前分支」，
 * 回 `NO_PR` 而不是拿 HEAD 去猜。`state: 'merged'` 不是 GitHub 的合法取值，映射成
 * `closed` 之后在本地按 `merged_at` 过滤。
 */
async function pullsOf(root, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const state = normalizeState(options.state);
  const repo = await githubRepoOf(root);
  if (!repo) return { prs: [], notGithub: true };
  const summary = await read.repoOf(root);
  const branch = summary && typeof summary.branch === 'string' ? summary.branch.trim() : '';
  if (!branch) throw ghError('NO_PR', '现在不在任何分支上，回电脑上切回分支再看 PR');
  const search = new URLSearchParams({
    head: `${repo.owner}:${branch}`,
    state: state === 'merged' ? 'closed' : state,
    per_page: String(PULLS_PER_PAGE),
  });
  const response = await ghRequest(repo, `${repoPath(repo)}/pulls?${search.toString()}`, { fetchImpl });
  const list = Array.isArray(response.json) ? response.json : [];
  const prs = list
    .filter((item) => item && (state !== 'merged' || item.merged_at))
    .map(toPullRequest);
  return { prs, notGithub: false };
}

/** 一条 PR 的 check-runs：先拿 head.sha，再拉那个提交的检查。 */
async function checksOf(root, number, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const repo = await requireGithubRepo(root);
  const pull = await ghRequest(repo, `${repoPath(repo)}/pulls/${number}`, { fetchImpl });
  const sha = pull.json && pull.json.head && typeof pull.json.head.sha === 'string' ? pull.json.head.sha : '';
  if (!sha) return [];
  const runs = await ghRequest(
    repo,
    `${repoPath(repo)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=${CHECKS_PER_PAGE}`,
    { fetchImpl },
  );
  const list = runs.json && Array.isArray(runs.json.check_runs) ? runs.json.check_runs : [];
  return list.map((run) => ({
    name: run && typeof run.name === 'string' ? run.name : '',
    conclusion: normalizeConclusion(run),
    detailsUrl: run && typeof run.details_url === 'string'
      ? run.details_url
      : (run && typeof run.html_url === 'string' ? run.html_url : null),
  }));
}

/** 把草稿 PR 标成可评审。 */
async function markReady(root, number, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const repo = await requireGithubRepo(root);
  const response = await ghRequest(repo, `${repoPath(repo)}/pulls/${number}/ready_for_review`, {
    method: 'POST',
    fetchImpl,
  });
  const body = response.json || {};
  return {
    number: Number(body.number) || number,
    draft: Boolean(body.draft),
    state: typeof body.state === 'string' ? body.state : 'open',
  };
}

/** GitHub 拒合并时的措辞分类：检查没过与其余不可合并要分开说。 */
function mergeRejection(error) {
  const reason = `${error && error.reason ? error.reason : ''} ${error && error.message ? error.message : ''}`;
  if (/check|status/i.test(reason)) {
    return ghError('CHECKS_FAILING', '这条 PR 的检查还没过，先在 GitHub 上把检查跑绿');
  }
  return ghError('MERGE_NOT_ALLOWED', 'GitHub 不让合这条 PR（可能有冲突或分支保护），回电脑上看一下');
}

/**
 * 合并一条 PR。只认 `squash` / `merge`，不收提交信息、不收 rebase。
 *
 * 先读一次 PR：已经合并过的直接回 `ALREADY_MERGED`（二次点击是常态，报成失败没有意义）。
 * **不预判 checks** —— 那是 GitHub 的事，它拒了我们再按措辞分成 `CHECKS_FAILING` / `MERGE_NOT_ALLOWED`。
 */
async function mergeOf(root, number, method, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!MERGE_METHODS.has(method)) throw ghError('BAD_REQUEST', '合并方式只支持 squash 或 merge');
  const repo = await requireGithubRepo(root);
  const before = await ghRequest(repo, `${repoPath(repo)}/pulls/${number}`, { fetchImpl });
  const current = before.json || {};
  if (current.merged_at || current.state === 'merged') {
    throw ghError('ALREADY_MERGED', `#${number} 已经合并过了`);
  }
  let response;
  try {
    response = await ghRequest(repo, `${repoPath(repo)}/pulls/${number}/merge`, {
      method: 'PUT',
      body: { merge_method: method },
      fetchImpl,
    });
  } catch (error) {
    if (error && (error.status === 405 || error.status === 409)) {
      // 被拒之后回读一次：有可能是另一处刚合完（二次点击 / 两个人同时按）。那就按幂等提示回。
      const after = await ghRequest(repo, `${repoPath(repo)}/pulls/${number}`, { fetchImpl });
      const latest = after.json || {};
      if (latest.merged_at || latest.state === 'merged') {
        throw ghError('ALREADY_MERGED', `#${number} 已经合并过了`);
      }
      throw mergeRejection(error);
    }
    throw error;
  }
  const body = response.json || {};
  if (!body.merged) throw mergeRejection({ reason: body.message || '', message: '' });
  return { merged: true, sha: typeof body.sha === 'string' ? body.sha : '' };
}

/** 一条 PR 的评论（走 issues/{number}/comments：PR 的评论就是这个端点）。 */
async function commentsOf(root, number, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const repo = await requireGithubRepo(root);
  const response = await ghRequest(
    repo,
    `${repoPath(repo)}/issues/${number}/comments?per_page=${CHECKS_PER_PAGE}`,
    { fetchImpl },
  );
  const list = Array.isArray(response.json) ? response.json : [];
  return list.map((item) => ({
    author: item && item.user && typeof item.user.login === 'string' ? item.user.login : '',
    body: item && typeof item.body === 'string' ? item.body : '',
    createdAt: item && typeof item.created_at === 'string' ? item.created_at : '',
    url: item && typeof item.html_url === 'string' ? item.html_url : '',
  }));
}

module.exports = {
  GITHUB_API,
  GITHUB_TIMEOUT_MS,
  MERGE_METHODS,
  PR_STATES,
  githubToken,
  normalizeConclusion,
  normalizeState,
  summarizeChecks,
  githubRepoOf,
  pullsOf,
  checksOf,
  markReady,
  mergeOf,
  commentsOf,
  // 内部函数，导出只给测试用：对外仍然只接固定子路径。
  ghRequest,
};

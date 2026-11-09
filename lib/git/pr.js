'use strict';

/**
 * GitHub PR 一层：列本分支提交关联的 PR、看检查、标可评审、合并（只 squash / merge）、读评论。
 *
 * 这一层是 `lib/mobile/git.js` 那组封闭动词的下半截 —— GitHub 的部分全在这里，handler 只做
 * 归属校验与参数校验。**不接受**调用方给的 URL / host / method / GraphQL：这里的每条路都写死
 * 成 `https://api.github.com` 下的固定 REST 子路径，参数只有 PR 号与合并方式两个值。
 *
 * 凭据沿用宿主环境里已有的 `GITHUB_TOKEN` / `GH_TOKEN`（与 `read.js` 的 GitHub 元信息同一条路），
 * 不在 App 里输 token、不落任何明文、不读凭据文件。
 *
 * 错误一律是带 `code` 的 Error：401/403 → `GH_AUTH`、429 / 限流头见底 → `GH_RATE_LIMITED`、网络与
 * 5xx → `GH_UNAVAILABLE`。404 分两种：这台机器上**没有**凭据时归 `GH_AUTH`（私有仓库匿名读也是
 * 404，说成「PR 不存在」是误导），有凭据时才算 `PR_NOT_FOUND`。合并被 GitHub 拒时回读一次 PR，
 * 按 `mergeable_state` 分成 `CHECKS_FAILING`（检查没过 / 缺必过评审）与 `MERGE_NOT_ALLOWED`（其余）。
 */

const { githubTargetOf, remotesOf } = require('./read');
const read = require('./read');
const { runGit } = require('./exec');

/** 固定基址。调用方给不了，也不该给。 */
const GITHUB_API = 'https://api.github.com';
/** 比 read.js 的元信息读宽一点：check-runs 与合并都可能多等一会儿。 */
const GITHUB_TIMEOUT_MS = 8000;
/** 列表一页的条数。按当前提交的 sha 过滤，一般就一两条。 */
const PULLS_PER_PAGE = 30;
const CHECKS_PER_PAGE = 100;
/** 列表里最多给前几条 PR 拉检查：每条要两次请求，跟着 PR 数长会把列表拖慢。 */
const LIST_CHECKS_LIMIT = 5;

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
 * 老式 Statuses API 的 `state` → 同一套 conclusion。它只有四种取值，`error` 和 `failure` 一样拦人。
 */
function statusConclusion(value) {
  const state = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (state === 'success') return 'success';
  if (state === 'failure' || state === 'error') return 'failure';
  return 'pending';
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
 * GitHub 的 `message`（`status` 用来判断「合并被拒」这类要回读一次 PR 的情况）。
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
    if (status === 404) {
      // 私有仓库没权限时 GitHub 也回 404：没有凭据就说「PR 不存在」是误导，归到凭据这一类。
      return token
        ? ghError('PR_NOT_FOUND', reason || 'GitHub 上找不到这条 PR')
        : ghError('GH_AUTH', '这台电脑上没有 GitHub 凭据，看不到这个仓库（也可能是 PR 不存在）');
    }
    if (status === 429) return ghError('GH_RATE_LIMITED', 'GitHub 限流了，过一会儿再试');
    if (status >= 500) return ghError('GH_UNAVAILABLE', 'GitHub 暂时不可用，稍后再试');
    if (status >= 400) return ghError('BAD_REQUEST', reason || 'GitHub 拒绝了这次请求');
    return ghError('GH_UNAVAILABLE', 'GitHub 没有回包，稍后再试');
  })();
  error.status = status;
  error.reason = reason;
  throw error;
}

/**
 * 本仓库全部 GitHub 远端，顺序：`upstream` → `origin` → 其余按名字。
 *
 * upstream 排最前是因为 fork 工作流：PR 开在上游，本地的 origin 往往是自己的 fork，先问 origin
 * 一条都问不到。`name` 只用于排序与排障，请求只用 owner/repo。
 */
async function githubTargetsOf(root) {
  const remotes = await remotesOf(root);
  const rank = (name) => (name === 'upstream' ? 0 : name === 'origin' ? 1 : 2);
  const targets = [];
  for (const item of remotes) {
    const target = githubTargetOf(item.url);
    if (target) targets.push({ name: item.name, owner: target.owner, repo: target.repo });
  }
  targets.sort((a, b) => rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return targets;
}

/** 头一个 GitHub 远端（上游优先）→ `{ owner, repo }`；不是 GitHub 项目就 null。 */
async function githubRepoOf(root) {
  const targets = await githubTargetsOf(root);
  if (targets.length === 0) return null;
  return { owner: targets[0].owner, repo: targets[0].repo };
}

/** 当前提交的完整 sha：拿不到（空仓库 / 不在分支上）回 null。 */
async function headShaOf(root) {
  const result = await runGit(root, ['rev-parse', 'HEAD'], { timeoutMs: 4000 });
  const sha = (result.stdout || '').trim();
  if (result.code !== 0 || !sha) return null;
  return sha;
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
function toPullRequest(item, checks) {
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
    // 汇总由调用方给：列表里只给前几条算（见 LIST_CHECKS_LIMIT），其余明说「没查」。
    checks: checks || emptyChecks(),
    author: item.user && typeof item.user.login === 'string' ? item.user.login : '',
    updatedAt: typeof item.updated_at === 'string' ? item.updated_at : '',
    url: typeof item.html_url === 'string' ? item.html_url : '',
  };
}

/**
 * `owner/repo` 形式的 full_name → `{ owner, repo }`；认不出就 null。
 *
 * 用来定位 PR 的 head 仓库：fork 工作流里 head 提交只在 fork 上，拿上游仓库去查这个提交的检查
 * 会 404。PR 对象里的 `head.repo.full_name` 就是它的确切位置。
 */
function repoFromFullName(value) {
  if (typeof value !== 'string') return null;
  const hit = /^([^/\s]+)\/([^/\s]+)$/.exec(value.trim());
  return hit ? { owner: hit[1], repo: hit[2] } : null;
}

/** PR 的 head 提交该去哪个仓库查检查：优先 head 仓库，取不到就用查到这条 PR 的那个仓库。 */
function headRepoOf(item, fallback) {
  const full = item && item.head && item.head.repo ? item.head.repo.full_name : null;
  return repoFromFullName(full) || fallback;
}

/**
 * 当前分支的 PR 列表。
 *
 * 不收分支名：先 `rev-parse HEAD` 拿当前提交的完整 sha，再拿这个 sha 去每个 GitHub 远端问
 * 「哪些 PR 带了这个提交」（`GET /repos/{owner}/{repo}/commits/{sha}/pulls`）。**不用**
 * `head=owner:branch` 过滤：fork 工作流（PR 开向上游）与本地分支改名都会一条都列不出来。
 *
 * `state: 'merged'` 不是 GitHub 的合法取值，映射成 `closed` 之后在本地按 `merged_at` 过滤。
 * 每条 PR 的 `checks` 当场填：列表本来就是按 sha 过滤、通常 0 到 1 条，前几条算得起。
 */
async function pullsOf(root, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const state = normalizeState(options.state);
  const targets = await githubTargetsOf(root);
  if (targets.length === 0) return { prs: [], notGithub: true };
  const sha = await headShaOf(root);
  if (!sha) {
    // 拿不到 HEAD：不在分支上就说不清「本分支」，空仓库则本来就没有 PR。
    const summary = await read.repoOf(root);
    if (summary.detached) throw ghError('DETACHED', '现在不在任何分支上，回电脑上切回分支再看 PR');
    return { prs: [], notGithub: false };
  }
  const found = [];
  const seen = new Set();
  for (const target of targets) {
    const search = new URLSearchParams({
      state: state === 'merged' ? 'closed' : state,
      per_page: String(PULLS_PER_PAGE),
    });
    // eslint-disable-next-line no-await-in-loop
    const response = await ghRequest(
      target,
      `${repoPath(target)}/commits/${encodeURIComponent(sha)}/pulls?${search.toString()}`,
      { fetchImpl },
    );
    const list = Array.isArray(response.json) ? response.json : [];
    for (const item of list) {
      if (!item) continue;
      if (state === 'merged' && !item.merged_at) continue;
      const number = Number(item.number) || 0;
      // 同一个号在两个远端各出现一次时只留先查到的那个（上游优先）。
      if (!number || seen.has(number)) continue;
      seen.add(number);
      found.push({ item, target });
    }
  }
  const prs = [];
  for (let index = 0; index < found.length; index += 1) {
    const { item, target } = found[index];
    let checks = emptyChecks();
    if (index < LIST_CHECKS_LIMIT) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const list = await checksForSha(headRepoOf(item, target), item.head && item.head.sha, fetchImpl);
        checks = summarizeChecks(list);
      } catch {
        // 检查读不到不该让整张列表失败：PR 本身已经拿到了，角标退回「没查」。
        checks = emptyChecks();
      }
    }
    prs.push(toPullRequest(item, checks));
  }
  return { prs, notGithub: false };
}

/**
 * 一个提交的检查：check-runs（Actions 那套）与 statuses（老式 CI 用的 Statuses API）并在一起。
 *
 * 只看 check-runs 会漏掉只写 statuses 的 CI —— 那些 PR 在手机上永远显示「没配 CI」。
 */
async function checksForSha(repo, sha, fetchImpl) {
  if (!sha || typeof sha !== 'string') return [];
  const base = `${repoPath(repo)}/commits/${encodeURIComponent(sha)}`;
  const [runs, statuses] = await Promise.all([
    ghRequest(repo, `${base}/check-runs?per_page=${CHECKS_PER_PAGE}`, { fetchImpl }),
    ghRequest(repo, `${base}/status`, { fetchImpl }),
  ]);
  const runList = runs.json && Array.isArray(runs.json.check_runs) ? runs.json.check_runs : [];
  const statusList = statuses.json && Array.isArray(statuses.json.statuses) ? statuses.json.statuses : [];
  return [
    ...runList.map((run) => ({
      name: run && typeof run.name === 'string' ? run.name : '',
      conclusion: normalizeConclusion(run),
      detailsUrl: run && typeof run.details_url === 'string'
        ? run.details_url
        : (run && typeof run.html_url === 'string' ? run.html_url : null),
    })),
    ...statusList.map((item) => ({
      name: item && typeof item.context === 'string' ? item.context : '',
      conclusion: statusConclusion(item && item.state),
      detailsUrl: item && typeof item.target_url === 'string' ? item.target_url : null,
    })),
  ];
}

/** 一条 PR 的检查：先拿 head.sha，再看那个提交的检查（fork 来的 PR 要去 head 仓库查）。 */
async function checksOf(root, number, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const repo = await requireGithubRepo(root);
  const pull = await ghRequest(repo, `${repoPath(repo)}/pulls/${number}`, { fetchImpl });
  const item = pull.json || {};
  const sha = item.head && typeof item.head.sha === 'string' ? item.head.sha : '';
  return checksForSha(headRepoOf(item, repo), sha, fetchImpl);
}

/**
 * 把草稿 PR 标成可评审。
 *
 * 收到 422 多半是「已经不在草稿状态」——两个人都按了、或者上一次按完没刷新。那不算失败：
 * 回读一次 PR，`draft` 已经是 false 就当成功（幂等）。
 */
async function markReady(root, number, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const repo = await requireGithubRepo(root);
  let response;
  try {
    response = await ghRequest(repo, `${repoPath(repo)}/pulls/${number}/ready_for_review`, {
      method: 'POST',
      fetchImpl,
    });
  } catch (error) {
    if (error && error.status === 422) {
      const after = await ghRequest(repo, `${repoPath(repo)}/pulls/${number}`, { fetchImpl });
      const latest = after.json || {};
      if (latest.draft === false) {
        return {
          number: Number(latest.number) || number,
          draft: false,
          state: typeof latest.state === 'string' ? latest.state : 'open',
        };
      }
      throw ghError('BAD_REQUEST', 'GitHub 拒绝了这次操作：这条 PR 现在不是草稿');
    }
    throw error;
  }
  const body = response.json || {};
  return {
    number: Number(body.number) || number,
    draft: Boolean(body.draft),
    state: typeof body.state === 'string' ? body.state : 'open',
  };
}

/**
 * 合并被 GitHub 拒之后回读一次 PR，按 `mergeable_state` 定因。
 *
 * 不猜 GitHub 的英文措辞：真机上冲突、检查没过、缺必过评审、分支保护全都回 405 而且不点名，
 * 靠 message 分类基本永远落到「其余不可合并」。`mergeable_state` 才是它自己给的结论。
 */
async function rejectionAfterMerge(repo, number, fetchImpl) {
  let latest = null;
  try {
    const after = await ghRequest(repo, `${repoPath(repo)}/pulls/${number}`, { fetchImpl });
    latest = after.json || {};
  } catch {
    latest = null;
  }
  if (latest && (latest.merged_at || latest.state === 'merged')) {
    return ghError('ALREADY_MERGED', `#${number} 已经合并过了`);
  }
  const mergeableState = latest && typeof latest.mergeable_state === 'string'
    ? latest.mergeable_state.trim().toLowerCase()
    : '';
  if (mergeableState === 'blocked') {
    return ghError('CHECKS_FAILING', '这条 PR 的检查还没过（或者还缺一次必过的评审），先在 GitHub 上看一眼');
  }
  if (mergeableState === 'dirty') {
    return ghError('MERGE_NOT_ALLOWED', '这条 PR 和它的基分支有冲突，回电脑上解决一下');
  }
  return ghError('MERGE_NOT_ALLOWED', 'GitHub 不让合这条 PR（分支落后、还是草稿，或者有分支保护），回电脑上看一下');
}

/**
 * 合并一条 PR。只认 `squash` / `merge`，不收提交信息、不收 rebase。
 *
 * 先读一次 PR：已经合并过的直接回 `ALREADY_MERGED`（二次点击是常态，报成失败没有意义），
 * 同时拿它的 `head.sha` 一起发给 GitHub —— 这样合的就是用户刚看过检查的那一次提交（sha 对不上
 * 时 GitHub 回 409，走回读那条路）。**不预判 checks**：它拒了我们再回读 PR 分成
 * `CHECKS_FAILING` / `MERGE_NOT_ALLOWED`。
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
  const sha = current.head && typeof current.head.sha === 'string' ? current.head.sha : '';
  let response;
  try {
    response = await ghRequest(repo, `${repoPath(repo)}/pulls/${number}/merge`, {
      method: 'PUT',
      body: sha ? { merge_method: method, sha } : { merge_method: method },
      fetchImpl,
    });
  } catch (error) {
    if (error && (error.status === 405 || error.status === 409 || error.status === 422)) {
      throw await rejectionAfterMerge(repo, number, fetchImpl);
    }
    throw error;
  }
  const body = response.json || {};
  if (!body.merged) throw await rejectionAfterMerge(repo, number, fetchImpl);
  return { merged: true, sha: typeof body.sha === 'string' ? body.sha : '' };
}

/**
 * 一条 PR 的评论（走 issues/{number}/comments：PR 的评论就是这个端点）。
 *
 * 按创建时间倒序取最新的一页：默认是升序，热门 PR 只会给到最老那 100 条，页面上就看不到正在
 * 讨论的内容。评审的行内评论（pulls/{number}/comments）这轮不做。
 */
async function commentsOf(root, number, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const repo = await requireGithubRepo(root);
  const search = new URLSearchParams({
    sort: 'created',
    direction: 'desc',
    per_page: String(CHECKS_PER_PAGE),
  });
  const response = await ghRequest(
    repo,
    `${repoPath(repo)}/issues/${number}/comments?${search.toString()}`,
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

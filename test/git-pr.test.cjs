'use strict';

// GitHub PR 一层（lib/git/pr.js）与那五个 handler 的测试。
//
// 守的是六件事：
//   1. 纯函数——check-run 的结论归一与汇总、`githubRepoOf` 认 remote 与 upstream 优先；
//   2. 列 PR——按当前提交的 sha 查关联 PR（不是 head=owner:branch），多远端合并去重、checks 当场填；
//   3. 请求形状——固定基址、路径是写死的 REST 子路径、合并只 PUT 一次且带 head.sha；
//   4. 错误分类——401 / 403 / 404（分有没有凭据）/ 429 / 5xx 各落到契约里的 code；
//   5. 合并被拒——回读 `mergeable_state` 定因，不猜 GitHub 的英文措辞；
//   6. 参数校验与错误码到 HTTP 的映射——PR 号与合并方式在本地就拒，**一个请求都不发**。
//
// 全程用注入的假 fetch / 假 fetchImpl，不联网。

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const pr = require('../lib/git/pr.js');
const gitApi = require('../lib/mobile/git.js');

function sh(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/** 一个带 GitHub 远端的真仓库（`git remote` 的读取是真的，联网不会发生）。 */
function makeProject(t, remote = 'git@github.com:acme/widget.git') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-git-pr-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'dev@example.com');
  sh(dir, 'config', 'user.name', 'Dev');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'first commit');
  if (remote) sh(dir, 'remote', 'add', 'origin', remote);
  return dir;
}

/** 再加一个远端（fork 工作流里 origin 是自己的 fork、upstream 是上游）。 */
function addRemote(dir, name, url) {
  sh(dir, 'remote', 'add', name, url);
}

/** 当前提交的完整 sha，列 PR 就是拿它去问 GitHub 的。 */
function headSha(dir) {
  return sh(dir, 'rev-parse', 'HEAD').trim();
}

/**
 * 换掉宿主环境里的 GitHub 凭据（pr.js 只读 `GITHUB_TOKEN` / `GH_TOKEN`），返回还原函数。
 *
 * 一个用例里连着换两次时，只把**第一次**返回的还原函数挂进 `t.after`：它恢复的是最初的环境。
 */
function githubTokenEnv(value) {
  const saved = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_TOKEN: process.env.GH_TOKEN,
  };
  delete process.env.GH_TOKEN;
  if (value === null) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = value;
  return () => {
    for (const key of ['GITHUB_TOKEN', 'GH_TOKEN']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

/** 记录每次调用的假 fetch：按队列回包，队列空了就报错（说明多发了一次请求）。 */
function fakeFetch(responses) {
  const calls = [];
  const queue = responses.slice();
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    if (queue.length === 0) throw new Error(`意外的请求：${init.method || 'GET'} ${url}`);
    const next = queue.shift();
    const status = next.status ?? 200;
    const headers = new Map(Object.entries(next.headers || {}));
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
      json: async () => next.json,
    };
  };
  impl.calls = calls;
  return impl;
}

// ── 纯函数 ──────────────────────────────────────────────────────────────────

test('summarizeChecks：全过 / 有失败 / 还在跑，三档分开', () => {
  const passing = pr.summarizeChecks([
    { status: 'completed', conclusion: 'success' },
    { status: 'completed', conclusion: 'skipped' },
    { status: 'completed', conclusion: 'neutral' },
  ]);
  assert.deepEqual(passing, { total: 3, passing: 3, failing: 0, pending: 0, status: 'passing' });

  const failing = pr.summarizeChecks([
    { status: 'completed', conclusion: 'success' },
    { status: 'completed', conclusion: 'failure' },
    { status: 'completed', conclusion: 'timed_out' },
  ]);
  assert.deepEqual(failing, { total: 3, passing: 1, failing: 2, pending: 0, status: 'failing' });

  const pending = pr.summarizeChecks([
    { status: 'completed', conclusion: 'success' },
    { status: 'in_progress', conclusion: null },
  ]);
  assert.deepEqual(pending, { total: 2, passing: 1, failing: 0, pending: 1, status: 'pending' });
});

test('summarizeChecks：一条都没有是 none，不是 passing', () => {
  assert.deepEqual(pr.summarizeChecks([]), { total: 0, passing: 0, failing: 0, pending: 0, status: 'none' });
  assert.deepEqual(pr.summarizeChecks(null), { total: 0, passing: 0, failing: 0, pending: 0, status: 'none' });
});

test('normalizeConclusion：conclusion 为 null 时按 status 判（没跑完一律 pending）', () => {
  assert.equal(pr.normalizeConclusion({ status: 'completed', conclusion: null }), 'pending');
  assert.equal(pr.normalizeConclusion({ status: 'queued', conclusion: null }), 'pending');
  assert.equal(pr.normalizeConclusion({ status: 'in_progress', conclusion: null }), 'pending');
  assert.equal(pr.normalizeConclusion({ status: 'completed', conclusion: 'success' }), 'success');
  assert.equal(pr.normalizeConclusion({ status: 'completed', conclusion: 'failure' }), 'failure');
  assert.equal(pr.normalizeConclusion({ status: 'completed', conclusion: 'action_required' }), 'failure');
  assert.equal(pr.normalizeConclusion({ status: 'completed', conclusion: 'cancelled' }), 'cancelled');
  assert.equal(pr.normalizeConclusion({ status: 'completed', conclusion: 'stale' }), 'pending');
});

test('githubRepoOf：认 https / ssh 两种 GitHub 远端，非 GitHub 回 null', async (t) => {
  const https = makeProject(t, 'https://github.com/acme/widget.git');
  assert.deepEqual(await pr.githubRepoOf(https), { owner: 'acme', repo: 'widget' });

  const ssh = makeProject(t, 'git@github.com:acme/other.git');
  assert.deepEqual(await pr.githubRepoOf(ssh), { owner: 'acme', repo: 'other' });

  const none = makeProject(t, null);
  assert.equal(await pr.githubRepoOf(none), null);
});

test('githubRepoOf：有 upstream 时认上游（fork 工作流的 PR 开在上游）', async (t) => {
  const root = makeProject(t);
  addRemote(root, 'upstream', 'https://github.com/upstream-org/widget.git');
  assert.deepEqual(await pr.githubRepoOf(root), { owner: 'upstream-org', repo: 'widget' });
});

// ── 请求形状与错误分类 ───────────────────────────────────────────────────────

test('pullsOf：按当前提交的 sha 查关联 PR，checks 当场填好', async (t) => {
  const root = makeProject(t);
  const sha = headSha(root);
  const fetchImpl = fakeFetch([
    {
      json: [{
        number: 12,
        title: 'Add widget',
        head: { ref: 'feature/x', sha: 'abc123' },
        base: { ref: 'main' },
        state: 'open',
        draft: true,
        mergeable: null,
        user: { login: 'octocat' },
        updated_at: '2026-11-09T10:00:00Z',
        html_url: 'https://github.com/acme/widget/pull/12',
      }],
    },
    { json: { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] } },
    { json: { statuses: [{ context: 'ci/legacy', state: 'success' }] } },
  ]);
  const result = await pr.pullsOf(root, { state: 'open', fetchImpl });
  assert.equal(result.notGithub, false);
  assert.equal(fetchImpl.calls.length, 3);
  const first = fetchImpl.calls[0];
  assert.ok(
    first.url.startsWith(`https://api.github.com/repos/acme/widget/commits/${sha}/pulls?`),
    first.url,
  );
  const search = new URL(first.url).searchParams;
  assert.equal(search.get('state'), 'open');
  assert.equal(search.get('per_page'), '30');
  // 不再用 head=owner:branch 过滤：fork 与本地改名都会漏。
  assert.equal(search.get('head'), null);
  assert.equal(first.method, 'GET');
  assert.equal(first.headers['user-agent'], 'dsh-mobile-plugin');
  const calledUrls = fetchImpl.calls.map((item) => item.url);
  assert.ok(calledUrls.some((url) => url.includes('/commits/abc123/check-runs')), calledUrls.join(' '));
  assert.ok(calledUrls.some((url) => url.includes('/commits/abc123/status')), calledUrls.join(' '));
  assert.deepEqual(result.prs[0], {
    number: 12,
    title: 'Add widget',
    headBranch: 'feature/x',
    baseBranch: 'main',
    state: 'open',
    draft: true,
    mergeable: null,
    checks: { total: 2, passing: 2, failing: 0, pending: 0, status: 'passing' },
    author: 'octocat',
    updatedAt: '2026-11-09T10:00:00Z',
    url: 'https://github.com/acme/widget/pull/12',
  });
});

test('pullsOf：多个 GitHub 远端按 upstream → origin 问，同号只留先查到的', async (t) => {
  const root = makeProject(t);
  addRemote(root, 'upstream', 'git@github.com:upstream-org/widget.git');
  const fetchImpl = fakeFetch([
    { json: [{ number: 1, state: 'open' }, { number: 2, state: 'open' }] },
    { json: [{ number: 2, state: 'open' }, { number: 3, state: 'open' }] },
  ]);
  const result = await pr.pullsOf(root, { state: 'open', fetchImpl });
  assert.equal(fetchImpl.calls.length, 2);
  assert.ok(fetchImpl.calls[0].url.startsWith('https://api.github.com/repos/upstream-org/widget/commits/'));
  assert.ok(fetchImpl.calls[1].url.startsWith('https://api.github.com/repos/acme/widget/commits/'));
  assert.deepEqual(result.prs.map((item) => item.number), [1, 2, 3]);
  // 这几条没带 head.sha，不为它们发检查请求。
  assert.deepEqual(result.prs.map((item) => item.checks.status), ['none', 'none', 'none']);
});

test('pullsOf：merged_at 判成 merged；state=merged 时只留已合并的', async (t) => {
  const root = makeProject(t);
  const fetchImpl = fakeFetch([
    {
      json: [
        { number: 1, merged_at: '2026-11-01T00:00:00Z', state: 'closed', head: { ref: 'a' }, base: { ref: 'main' } },
        { number: 2, merged_at: null, state: 'closed', head: { ref: 'b' }, base: { ref: 'main' } },
      ],
    },
  ]);
  const result = await pr.pullsOf(root, { state: 'merged', fetchImpl });
  // GitHub 没有 merged 这个 state，映射成 closed 再本地按 merged_at 过滤。
  assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('state'), 'closed');
  assert.deepEqual(result.prs.map((item) => [item.number, item.state]), [[1, 'merged']]);
  assert.equal(fetchImpl.calls.length, 1);
});

test('pullsOf：没有 GitHub 远端 → notGithub，不发请求', async (t) => {
  const root = makeProject(t, null);
  const fetchImpl = fakeFetch([]);
  const result = await pr.pullsOf(root, { fetchImpl });
  assert.deepEqual(result, { prs: [], notGithub: true });
  assert.equal(fetchImpl.calls.length, 0);
});

test('ghRequest：401 → GH_AUTH、限流 → GH_RATE_LIMITED、5xx → GH_UNAVAILABLE', async (t) => {
  const root = makeProject(t);
  const repo = await pr.githubRepoOf(root);
  const cases = [
    { status: 401, expect: 'GH_AUTH' },
    { status: 403, expect: 'GH_AUTH' },
    { status: 403, headers: { 'x-ratelimit-remaining': '0' }, expect: 'GH_RATE_LIMITED' },
    { status: 429, expect: 'GH_RATE_LIMITED' },
    { status: 502, expect: 'GH_UNAVAILABLE' },
  ];
  for (const item of cases) {
    const fetchImpl = fakeFetch([{ status: item.status, headers: item.headers, json: { message: 'nope' } }]);
    await assert.rejects(
      () => pr.ghRequest(repo, '/repos/acme/widget/pulls', { fetchImpl }),
      (error) => error.code === item.expect,
      `${item.status} 应该落到 ${item.expect}`,
    );
  }
});

test('私有仓库的 404：没有凭据算 GH_AUTH，有凭据才算 PR_NOT_FOUND', async (t) => {
  const root = makeProject(t);
  const repo = await pr.githubRepoOf(root);
  const notFound = () => fakeFetch([{ status: 404, json: { message: 'Not Found' } }]);
  const restoreToken = githubTokenEnv(null);
  t.after(restoreToken);

  await assert.rejects(
    () => pr.ghRequest(repo, '/repos/acme/widget/pulls/1', { fetchImpl: notFound() }),
    (error) => error.code === 'GH_AUTH',
  );

  // 下面这一次换上的凭据不用单独还原：上面的还原函数恢复的是最初的环境。
  githubTokenEnv('ghp_test');
  await assert.rejects(
    () => pr.ghRequest(repo, '/repos/acme/widget/pulls/1', { fetchImpl: notFound() }),
    (error) => error.code === 'PR_NOT_FOUND',
  );
});

test('ghRequest：网络抛错 → GH_UNAVAILABLE；不接完整 URL', async (t) => {
  const root = makeProject(t);
  const repo = await pr.githubRepoOf(root);
  const boom = async () => { throw new Error('ENOTFOUND'); };
  await assert.rejects(() => pr.ghRequest(repo, '/repos/acme/widget', { fetchImpl: boom }), (error) => error.code === 'GH_UNAVAILABLE');
  await assert.rejects(
    () => pr.ghRequest(repo, 'https://evil.example/x', { fetchImpl: fakeFetch([]) }),
    (error) => error.code === 'BAD_REQUEST',
  );
});

test('checksOf：check-runs 与老式 statuses 并成同一份结论', async (t) => {
  const root = makeProject(t);
  const fetchImpl = fakeFetch([
    { json: { number: 7, head: { sha: 'abc123' } } },
    {
      json: {
        check_runs: [
          { name: 'build', status: 'completed', conclusion: 'success', details_url: 'https://ci/1' },
          { name: 'lint', status: 'in_progress', conclusion: null, html_url: 'https://ci/2' },
        ],
      },
    },
    {
      json: {
        state: 'failure',
        statuses: [
          { context: 'ci/legacy', state: 'error', target_url: 'https://ci/3' },
          { context: 'ci/other', state: 'pending' },
          { context: 'ci/ignored', state: 'success' },
        ],
      },
    },
  ]);
  const checks = await pr.checksOf(root, 7, { fetchImpl });
  assert.deepEqual(checks, [
    { name: 'build', conclusion: 'success', detailsUrl: 'https://ci/1' },
    { name: 'lint', conclusion: 'pending', detailsUrl: 'https://ci/2' },
    { name: 'ci/legacy', conclusion: 'failure', detailsUrl: 'https://ci/3' },
    { name: 'ci/other', conclusion: 'pending', detailsUrl: null },
    { name: 'ci/ignored', conclusion: 'success', detailsUrl: null },
  ]);
  assert.deepEqual(pr.summarizeChecks(checks), { total: 5, passing: 2, failing: 1, pending: 2, status: 'failing' });
  assert.ok(fetchImpl.calls[0].url.endsWith('/repos/acme/widget/pulls/7'), fetchImpl.calls[0].url);
  const calledUrls = fetchImpl.calls.map((item) => item.url);
  assert.ok(calledUrls.some((url) => url.includes('/repos/acme/widget/commits/abc123/check-runs')), calledUrls.join(' '));
  assert.ok(calledUrls.some((url) => url.includes('/repos/acme/widget/commits/abc123/status')), calledUrls.join(' '));
});

test('markReady：POST 到 ready_for_review，回下发的三个字段', async (t) => {
  const root = makeProject(t);
  const fetchImpl = fakeFetch([{ json: { number: 9, draft: false, state: 'open' } }]);
  const result = await pr.markReady(root, 9, { fetchImpl });
  assert.deepEqual(result, { number: 9, draft: false, state: 'open' });
  assert.equal(fetchImpl.calls[0].method, 'POST');
  assert.ok(fetchImpl.calls[0].url.endsWith('/repos/acme/widget/pulls/9/ready_for_review'));
});

test('markReady：422「已经不在草稿状态」时回读一次，draft 已是 false 就当成功', async (t) => {
  const root = makeProject(t);
  const idempotent = fakeFetch([
    { status: 422, json: { message: 'Pull request is already ready for review' } },
    { json: { number: 9, draft: false, state: 'open' } },
  ]);
  assert.deepEqual(await pr.markReady(root, 9, { fetchImpl: idempotent }), { number: 9, draft: false, state: 'open' });
  assert.equal(idempotent.calls.length, 2);
  assert.ok(idempotent.calls[1].url.endsWith('/repos/acme/widget/pulls/9'));

  const stillDraft = fakeFetch([
    { status: 422, json: { message: 'nope' } },
    { json: { number: 9, draft: true, state: 'open' } },
  ]);
  await assert.rejects(
    () => pr.markReady(root, 9, { fetchImpl: stillDraft }),
    (error) => error.code === 'BAD_REQUEST',
  );
});

test('mergeOf：先读 head.sha 并随 PUT 一起发；已合并过的回 ALREADY_MERGED', async (t) => {
  const root = makeProject(t);
  const fetchImpl = fakeFetch([
    { json: { number: 5, state: 'open', merged_at: null, head: { sha: 'cafe1234' } } },
    { json: { merged: true, sha: 'deadbeef' } },
  ]);
  const result = await pr.mergeOf(root, 5, 'squash', { fetchImpl });
  assert.deepEqual(result, { merged: true, sha: 'deadbeef' });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[1].method, 'PUT');
  assert.ok(fetchImpl.calls[1].url.endsWith('/repos/acme/widget/pulls/5/merge'));
  // 合的就是刚读到的那一次提交：sha 对不上时 GitHub 会拒，那时再回读 PR。
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].body), { merge_method: 'squash', sha: 'cafe1234' });

  const already = fakeFetch([{ json: { number: 5, state: 'closed', merged_at: '2026-11-01T00:00:00Z' } }]);
  await assert.rejects(
    () => pr.mergeOf(root, 5, 'merge', { fetchImpl: already }),
    (error) => error.code === 'ALREADY_MERGED',
  );
  assert.equal(already.calls.length, 1);
});

test('mergeOf：被拒后回读 mergeable_state——blocked 说检查没过，dirty 说有冲突', async (t) => {
  const root = makeProject(t);
  // 两次 405 的措辞一样（真机上也确实不点名）：分因只靠回读的 mergeable_state。
  const notMergeable = { status: 405, json: { message: 'Pull request is not mergeable' } };
  const blocked = fakeFetch([
    { json: { number: 5, state: 'open', head: { sha: 'a1' } } },
    notMergeable,
    { json: { number: 5, state: 'open', mergeable_state: 'blocked' } },
  ]);
  await assert.rejects(
    () => pr.mergeOf(root, 5, 'squash', { fetchImpl: blocked }),
    (error) => error.code === 'CHECKS_FAILING',
  );
  assert.equal(blocked.calls.length, 3);

  const dirty = fakeFetch([
    { json: { number: 5, state: 'open', head: { sha: 'a1' } } },
    notMergeable,
    { json: { number: 5, state: 'open', mergeable_state: 'dirty' } },
  ]);
  await assert.rejects(
    () => pr.mergeOf(root, 5, 'merge', { fetchImpl: dirty }),
    (error) => error.code === 'MERGE_NOT_ALLOWED',
  );

  // sha 不匹配时 GitHub 回 409、分支落后时是 behind：都归 MERGE_NOT_ALLOWED。
  const stale = fakeFetch([
    { json: { number: 5, state: 'open', head: { sha: 'a1' } } },
    { status: 409, json: { message: 'Head branch was modified. Review and try the merge again.' } },
    { json: { number: 5, state: 'open', mergeable_state: 'behind' } },
  ]);
  await assert.rejects(
    () => pr.mergeOf(root, 5, 'squash', { fetchImpl: stale }),
    (error) => error.code === 'MERGE_NOT_ALLOWED',
  );
});

test('mergeOf：被别人合过了——PUT 被拒后回读到 merged_at，回 ALREADY_MERGED', async (t) => {
  const root = makeProject(t);
  const fetchImpl = fakeFetch([
    { json: { number: 5, state: 'open', head: { sha: 'a1' } } },
    { status: 405, json: { message: 'Pull request is not mergeable' } },
    { json: { number: 5, state: 'closed', merged_at: '2026-11-09T00:00:00Z' } },
  ]);
  await assert.rejects(
    () => pr.mergeOf(root, 5, 'squash', { fetchImpl }),
    (error) => error.code === 'ALREADY_MERGED',
  );
});

test('mergeOf：rebase 本地就拒，一个请求都不发', async (t) => {
  const root = makeProject(t);
  const fetchImpl = fakeFetch([]);
  await assert.rejects(
    () => pr.mergeOf(root, 5, 'rebase', { fetchImpl }),
    (error) => error.code === 'BAD_REQUEST',
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('commentsOf：取最新一页，字段映射成 {author, body, createdAt, url}', async (t) => {
  const root = makeProject(t);
  const fetchImpl = fakeFetch([{
    json: [{
      user: { login: 'octocat' },
      body: 'LGTM',
      created_at: '2026-11-09T10:00:00Z',
      html_url: 'https://github.com/acme/widget/pull/3#issuecomment-1',
    }],
  }]);
  const comments = await pr.commentsOf(root, 3, { fetchImpl });
  assert.deepEqual(comments, [{
    author: 'octocat',
    body: 'LGTM',
    createdAt: '2026-11-09T10:00:00Z',
    url: 'https://github.com/acme/widget/pull/3#issuecomment-1',
  }]);
  const called = new URL(fetchImpl.calls[0].url);
  assert.ok(called.pathname.endsWith('/repos/acme/widget/issues/3/comments'), called.pathname);
  // 默认是升序，热门 PR 只会看到最老那 100 条：倒序取最新的一页。
  assert.equal(called.searchParams.get('sort'), 'created');
  assert.equal(called.searchParams.get('direction'), 'desc');
  assert.equal(called.searchParams.get('per_page'), '100');
});

// ── handler 级：参数校验在本地拦，绝不外发 ──────────────────────────────────

function ctxFor(projectPath) {
  return {
    get: () => undefined,
    apiProxy: {
      workspace: {
        list: async () => ({
          result: { ok: true, value: { items: [{ workspaceId: 'w1', path: projectPath }] } },
        }),
      },
    },
  };
}

function fakeRequest(url, body) {
  const req = new EventEmitter();
  req.url = url;
  req.headers = {};
  req.destroy = () => {};
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: null,
    payload: '',
    req: { headers: {} },
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk) {
      this.payload = chunk === undefined ? '' : String(chunk);
    },
  };
}

async function call(handler, ctx, url, body) {
  const res = fakeResponse();
  await handler(ctx, fakeRequest(url, body), res);
  return { status: res.statusCode, body: JSON.parse(res.payload || '{}') };
}

const q = (params) => `?${new URLSearchParams(params).toString()}`;

/** 把全局 fetch 换成计数桩：handler 没注入 fetchImpl，那条路走 globalThis.fetch。 */
function countGlobalFetch(t) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    throw new Error(`测试里不该真的联网：${init.method || 'GET'} ${url}`);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

/** 把全局 fetch 换成按队列回包的桩（handler 那条路不注入 fetchImpl）。一个用例只换一次。 */
function stubGlobalFetch(t, responses) {
  const impl = fakeFetch(responses);
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  t.after(() => { globalThis.fetch = original; });
  return impl;
}

test('git/pr/merge 传 rebase：本地 400 BAD_REQUEST，一个请求都不发', async (t) => {
  const project = makeProject(t);
  const calls = countGlobalFetch(t);
  const result = await call(
    gitApi.handleGitPrMerge,
    ctxFor(project),
    '/api/mobile/v1/git/pr/merge',
    { workspaceId: 'w1', number: 5, method: 'rebase' },
  );
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'BAD_REQUEST');
  assert.equal(calls.length, 0);
});

test('git/pr/merge 缺 method：本地 400，一个请求都不发', async (t) => {
  const project = makeProject(t);
  const calls = countGlobalFetch(t);
  const result = await call(
    gitApi.handleGitPrMerge,
    ctxFor(project),
    '/api/mobile/v1/git/pr/merge',
    { workspaceId: 'w1', number: 5 },
  );
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'BAD_REQUEST');
  assert.equal(calls.length, 0);
});

test('PR 号不是正整数：400 BAD_REQUEST（四条读/写都一样）', async (t) => {
  const project = makeProject(t);
  const calls = countGlobalFetch(t);
  const bad = ['abc', '0', '-1', '1.5', ''];
  for (const number of bad) {
    const checks = await call(gitApi.handleGitPrChecks, ctxFor(project), `/api/mobile/v1/git/pr/checks${q({ workspaceId: 'w1', number })}`);
    assert.equal(checks.status, 400, `checks number=${JSON.stringify(number)}`);
    assert.equal(checks.body.error.code, 'BAD_REQUEST');

    const comments = await call(gitApi.handleGitPrComments, ctxFor(project), `/api/mobile/v1/git/pr/comments${q({ workspaceId: 'w1', number })}`);
    assert.equal(comments.status, 400, `comments number=${JSON.stringify(number)}`);
  }
  const ready = await call(gitApi.handleGitPrReady, ctxFor(project), '/api/mobile/v1/git/pr/ready', { workspaceId: 'w1', number: 'x' });
  assert.equal(ready.status, 400);
  assert.equal(ready.body.error.code, 'BAD_REQUEST');
  assert.equal(calls.length, 0);
});

test('git/prs：没有 GitHub 远端 → 200 空列表 + notGithub，不发请求', async (t) => {
  const project = makeProject(t, null);
  const calls = countGlobalFetch(t);
  const result = await call(gitApi.handleGitPrs, ctxFor(project), `/api/mobile/v1/git/prs${q({ workspaceId: 'w1' })}`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, prs: [], notGithub: true });
  assert.equal(calls.length, 0);
});

test('已识别到仓库根、但 PR 号非法时，校验发生在任何网络动作之前', async (t) => {
  const project = makeProject(t);
  const calls = countGlobalFetch(t);
  // 先过归属校验（真目录 + 真 git 识别），再被 number 校验拦下。
  const result = await call(gitApi.handleGitPrChecks, ctxFor(project), `/api/mobile/v1/git/pr/checks${q({ workspaceId: 'w1', number: '../x' })}`);
  assert.equal(result.status, 400);
  assert.equal(calls.length, 0);
});

test('git/pr/checks 在非 GitHub 项目上：404 NO_PR，不发请求', async (t) => {
  const project = makeProject(t, null);
  const calls = countGlobalFetch(t);
  const result = await call(
    gitApi.handleGitPrChecks,
    ctxFor(project),
    `/api/mobile/v1/git/pr/checks${q({ workspaceId: 'w1', number: '7' })}`,
  );
  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, 'NO_PR');
  assert.equal(calls.length, 0);
});

test('错误码 → HTTP：不在分支上（DETACHED）回 409，一个请求都不发', async (t) => {
  const project = makeProject(t);
  sh(project, 'checkout', '-q', '--detach');
  const stub = stubGlobalFetch(t, []);
  const result = await call(gitApi.handleGitPrs, ctxFor(project), `/api/mobile/v1/git/prs${q({ workspaceId: 'w1' })}`);
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'DETACHED');
  assert.equal(stub.calls.length, 0);
});

test('错误码 → HTTP：GH_AUTH 403、限流 429、GitHub 挂了 502', async (t) => {
  const project = makeProject(t);
  const stub = stubGlobalFetch(t, [
    { status: 403, json: { message: 'nope' } },
    { status: 403, headers: { 'x-ratelimit-remaining': '0' }, json: { message: 'nope' } },
    { status: 502, json: { message: 'bad gateway' } },
  ]);
  const cases = [['GH_AUTH', 403], ['GH_RATE_LIMITED', 429], ['GH_UNAVAILABLE', 502]];
  for (const [code, status] of cases) {
    const result = await call(
      gitApi.handleGitPrChecks,
      ctxFor(project),
      `/api/mobile/v1/git/pr/checks${q({ workspaceId: 'w1', number: '7' })}`,
    );
    assert.equal(result.body.error.code, code);
    assert.equal(result.status, status);
  }
  assert.equal(stub.calls.length, 3);
});

test('错误码 → HTTP：CHECKS_FAILING / MERGE_NOT_ALLOWED / ALREADY_MERGED 都是 409', async (t) => {
  const project = makeProject(t);
  const notMergeable = { status: 405, json: { message: 'Pull request is not mergeable' } };
  const stub = stubGlobalFetch(t, [
    { json: { number: 5, state: 'open', head: { sha: 'a1' } } },
    notMergeable,
    { json: { number: 5, state: 'open', mergeable_state: 'blocked' } },
    { json: { number: 6, state: 'open', head: { sha: 'b2' } } },
    notMergeable,
    { json: { number: 6, state: 'open', mergeable_state: 'dirty' } },
    { json: { number: 7, state: 'closed', merged_at: '2026-11-09T00:00:00Z' } },
  ]);
  const merge = (number) => call(
    gitApi.handleGitPrMerge,
    ctxFor(project),
    '/api/mobile/v1/git/pr/merge',
    { workspaceId: 'w1', number, method: 'squash' },
  );

  const failing = await merge(5);
  assert.equal(failing.status, 409);
  assert.equal(failing.body.error.code, 'CHECKS_FAILING');

  const dirty = await merge(6);
  assert.equal(dirty.status, 409);
  assert.equal(dirty.body.error.code, 'MERGE_NOT_ALLOWED');

  const already = await merge(7);
  assert.equal(already.status, 409);
  assert.equal(already.body.error.code, 'ALREADY_MERGED');

  assert.equal(stub.calls.length, 7);
});

test('git/pr/merge 成功：回 { ok, number, merged, sha }，PUT 带上读到的 head.sha', async (t) => {
  const project = makeProject(t);
  const stub = stubGlobalFetch(t, [
    { json: { number: 5, state: 'open', head: { sha: 'cafe1234' } } },
    { json: { merged: true, sha: 'squashed1' } },
  ]);
  const result = await call(
    gitApi.handleGitPrMerge,
    ctxFor(project),
    '/api/mobile/v1/git/pr/merge',
    { workspaceId: 'w1', number: 5, method: 'merge' },
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, number: 5, merged: true, sha: 'squashed1' });
  assert.deepEqual(JSON.parse(stub.calls[1].body), { merge_method: 'merge', sha: 'cafe1234' });
});

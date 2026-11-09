'use strict';

// GitHub PR 一层（lib/git/pr.js）与那五个 handler 的测试。
//
// 守的是四件事：
//   1. 纯函数——check-run 的结论归一与汇总、`githubRepoOf` 认 remote；
//   2. 请求形状——固定基址、路径是写死的 REST 子路径、合并只 PUT 一次；
//   3. 错误分类——404 / 401 / 403 / 429 / 5xx 各自落到契约里的 code；
//   4. 参数校验——PR 号与合并方式在本地就拒，**一个请求都不发**。
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

// ── 请求形状与错误分类 ───────────────────────────────────────────────────────

test('pullsOf：只打固定基址 + 当前分支的 head 过滤，字段对齐 App 的 GitPullRequest', async (t) => {
  const root = makeProject(t);
  const fetchImpl = fakeFetch([{
    json: [{
      number: 12,
      title: 'Add widget',
      head: { ref: 'feature/x' },
      base: { ref: 'main' },
      state: 'open',
      draft: true,
      mergeable: null,
      user: { login: 'octocat' },
      updated_at: '2026-11-09T10:00:00Z',
      html_url: 'https://github.com/acme/widget/pull/12',
    }],
  }]);
  const result = await pr.pullsOf(root, { state: 'open', fetchImpl });
  assert.equal(result.notGithub, false);
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.ok(call.url.startsWith('https://api.github.com/repos/acme/widget/pulls?'), call.url);
  const search = new URL(call.url).searchParams;
  // 列「本分支」的 PR：head 用 owner:当前分支，不收调用方给的分支名。
  assert.equal(search.get('head'), 'acme:main');
  assert.equal(search.get('state'), 'open');
  assert.equal(call.method, 'GET');
  assert.equal(call.headers['user-agent'], 'dsh-mobile-plugin');
  assert.deepEqual(result.prs[0], {
    number: 12,
    title: 'Add widget',
    headBranch: 'feature/x',
    baseBranch: 'main',
    state: 'open',
    draft: true,
    mergeable: null,
    checks: { total: 0, passing: 0, failing: 0, pending: 0, status: 'none' },
    author: 'octocat',
    updatedAt: '2026-11-09T10:00:00Z',
    url: 'https://github.com/acme/widget/pull/12',
  });
});

test('pullsOf：merged_at 判成 merged；state=merged 时只留已合并的', async (t) => {
  const root = makeProject(t);
  const fetchImpl = fakeFetch([{
    json: [
      { number: 1, merged_at: '2026-11-01T00:00:00Z', state: 'closed', head: { ref: 'a' }, base: { ref: 'main' } },
      { number: 2, merged_at: null, state: 'closed', head: { ref: 'b' }, base: { ref: 'main' } },
    ],
  }]);
  const result = await pr.pullsOf(root, { state: 'merged', fetchImpl });
  // GitHub 没有 merged 这个 state，映射成 closed 再本地按 merged_at 过滤。
  assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('state'), 'closed');
  assert.deepEqual(result.prs.map((item) => [item.number, item.state]), [[1, 'merged']]);
});

test('pullsOf：没有 GitHub 远端 → notGithub，不发请求', async (t) => {
  const root = makeProject(t, null);
  const fetchImpl = fakeFetch([]);
  const result = await pr.pullsOf(root, { fetchImpl });
  assert.deepEqual(result, { prs: [], notGithub: true });
  assert.equal(fetchImpl.calls.length, 0);
});

test('ghRequest：404 → PR_NOT_FOUND、401 → GH_AUTH、限流 → GH_RATE_LIMITED、5xx → GH_UNAVAILABLE', async (t) => {
  const root = makeProject(t);
  const repo = await pr.githubRepoOf(root);
  const cases = [
    { status: 404, expect: 'PR_NOT_FOUND' },
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

test('checksOf：先拿 head.sha，再拉那个提交的 check-runs，结论已归一', async (t) => {
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
  ]);
  const checks = await pr.checksOf(root, 7, { fetchImpl });
  assert.deepEqual(checks, [
    { name: 'build', conclusion: 'success', detailsUrl: 'https://ci/1' },
    { name: 'lint', conclusion: 'pending', detailsUrl: 'https://ci/2' },
  ]);
  assert.ok(fetchImpl.calls[0].url.endsWith('/repos/acme/widget/pulls/7'), fetchImpl.calls[0].url);
  assert.ok(fetchImpl.calls[1].url.includes('/repos/acme/widget/commits/abc123/check-runs'), fetchImpl.calls[1].url);
});

test('markReady：POST 到 ready_for_review，回下发的三个字段', async (t) => {
  const root = makeProject(t);
  const fetchImpl = fakeFetch([{ json: { number: 9, draft: false, state: 'open' } }]);
  const result = await pr.markReady(root, 9, { fetchImpl });
  assert.deepEqual(result, { number: 9, draft: false, state: 'open' });
  assert.equal(fetchImpl.calls[0].method, 'POST');
  assert.ok(fetchImpl.calls[0].url.endsWith('/repos/acme/widget/pulls/9/ready_for_review'));
});

test('mergeOf：只 PUT 一次，body 只有 merge_method；已合并过的回 ALREADY_MERGED', async (t) => {
  const root = makeProject(t);
  const fetchImpl = fakeFetch([
    { json: { number: 5, state: 'open', merged_at: null } },
    { json: { merged: true, sha: 'deadbeef' } },
  ]);
  const result = await pr.mergeOf(root, 5, 'squash', { fetchImpl });
  assert.deepEqual(result, { merged: true, sha: 'deadbeef' });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[1].method, 'PUT');
  assert.ok(fetchImpl.calls[1].url.endsWith('/repos/acme/widget/pulls/5/merge'));
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].body), { merge_method: 'squash' });

  const already = fakeFetch([{ json: { number: 5, state: 'closed', merged_at: '2026-11-01T00:00:00Z' } }]);
  await assert.rejects(
    () => pr.mergeOf(root, 5, 'merge', { fetchImpl: already }),
    (error) => error.code === 'ALREADY_MERGED',
  );
  assert.equal(already.calls.length, 1);
});

test('mergeOf：GitHub 因检查拒合并 → CHECKS_FAILING；其余不可合并 → MERGE_NOT_ALLOWED', async (t) => {
  const root = makeProject(t);
  const failing = fakeFetch([
    { json: { number: 5, state: 'open' } },
    { status: 405, json: { message: 'Required status check "ci" is expected.' } },
    { json: { number: 5, state: 'open' } },
  ]);
  await assert.rejects(
    () => pr.mergeOf(root, 5, 'squash', { fetchImpl: failing }),
    (error) => error.code === 'CHECKS_FAILING',
  );

  const blocked = fakeFetch([
    { json: { number: 5, state: 'open' } },
    { status: 405, json: { message: 'Pull request is not mergeable' } },
    { json: { number: 5, state: 'open' } },
  ]);
  await assert.rejects(
    () => pr.mergeOf(root, 5, 'merge', { fetchImpl: blocked }),
    (error) => error.code === 'MERGE_NOT_ALLOWED',
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

test('commentsOf：字段映射成 {author, body, createdAt, url}', async (t) => {
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
  assert.ok(fetchImpl.calls[0].url.includes('/repos/acme/widget/issues/3/comments'), fetchImpl.calls[0].url);
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

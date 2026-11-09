'use strict';

/**
 * 会话级隔离工作树的守卫：建树 / 复用 / 回收 / 保留策略，以及项目写入队列的串行与暂停。
 *
 * 这两块此前是**零守卫**：`releaseIsolationWorktree` 全仓零调用方、`pauseProjectWrites`
 * 零调用方零测试，所以「开两次留两棵」「建树与建会话不是一个事务」这类毛病没有一条断言
 * 会红。这里钉的是**规格**，不是实现形状：
 *
 *  1. 真开树（`git worktree list` 里多一棵，`.git` 是 gitfile）；不是仓库就如实报错。
 *  2. 同一个复用键建两次只有一棵 —— 连开两次不留两棵。
 *  3. 建树是一笔登记：登记表里那条能被会话号找到，且落盘（跨进程还能读到）。
 *  4. 会话结束就收掉；`keep: true` 的不收；清理失败不抛。
 *  5. 会话 create 失败时回滚那棵树（事务）—— 走真 `handleNew`，宿主那侧是假对象。
 *  6. 队列：同键串行、不同键并行、失败不带走后续；暂停会真的停住、恢复放行。
 *
 * 真跑 git，所以每个用例一个临时仓库，跑完连仓带树一起删。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');

// `paths.js` 在调用时解析 env，所以这里在 require 之前立一个临时 DSH_HOME：
// 登记表与工作树根都落在它下面，用例之间互不影响。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-worktree-'));
process.env.DSH_HOME = home;
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const worktree = require('../lib/mobile/worktree-isolation.js');
const lifecycle = require('../lib/mobile/worktree-lifecycle.js');
const queue = require('../lib/mobile/project-write-queue.js');
const { handleNew } = require('../lib/mobile/session-new.js');

/** 真 git 调用（测试自己造仓库用，不走被测代码）。 */
function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    },
    encoding: 'utf8',
  });
}

/** 造一个真仓库（要能 `worktree add HEAD`，所以得有一个提交）。 */
function makeRepo(t, name = 'repo') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `dsh-wt-${name}-`)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q']);
  fs.writeFileSync(path.join(dir, 'README.md'), `${name}\n`);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

/** 这个仓库的工作树清单（绝对路径数组）。 */
function worktreePaths(repoRoot) {
  return git(repoRoot, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim());
}

/** 与其它 handler 测试同形：把 JSON body 灌成一条请求流。 */
function makeReq(body, headers = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]);
  req.headers = headers;
  return req;
}

function makeRes() {
  const res = { status: null, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = JSON.parse(payload); };
  return res;
}

/** 假 ctx：只提供建树要的那两件（工作区清单 + session.create 的结果由用例给）。 */
function makeCtx(projectDir, createImpl) {
  const calls = { create: [] };
  const ctx = {
    calls,
    apiProxy: {
      workspace: {
        list: async () => ({ result: { ok: true, value: { items: [{ workspaceId: 'w1', path: projectDir }] } } }),
      },
      sessions: {
        create: async (request) => {
          calls.create.push(request.payload);
          return createImpl ? createImpl(request) : { result: { ok: true, value: { sessionId: `s-${calls.create.length}` } } };
        },
      },
    },
  };
  return ctx;
}

// ── 1. 建树：真多一棵，且是 gitfile ─────────────────────────────────────

test('建树：worktree list 里真多一棵，目录里的 .git 是文件不是标记', async (t) => {
  const repo = makeRepo(t);
  const before = worktreePaths(repo).length;

  const made = await worktree.createIsolationWorktreeForNew({}, { cwd: repo, label: 'demo', reuseKey: 'req-a' });
  t.after(() => worktree.releaseIsolationWorktree({ repoRoot: made.repoRoot, cwd: made.cwd }));

  assert.equal(made.reused, false);
  assert.equal(made.repoRoot, repo);
  assert.ok(fs.existsSync(made.cwd), '工作树目录该真的在盘上');
  assert.equal(worktreePaths(repo).length, before + 1, 'git 那边该多一棵工作树');
  // 真 worktree 的 `.git` 是一个指向主仓 `.git/worktrees/<名字>` 的文件，不是目录、也不是假标记。
  const dotGit = path.join(made.cwd, '.git');
  assert.equal(fs.statSync(dotGit).isFile(), true, '.git 该是一个文件（gitfile）');
  assert.match(fs.readFileSync(dotGit, 'utf8'), /^gitdir:/, 'gitfile 里该有一行 gitdir:');

  // 登记表落了盘：会话号还没绑，但复用键那条在。
  const registered = worktree.registeredIsolations();
  assert.equal(registered['reuse:req-a'].cwd, made.cwd);
  assert.ok(fs.existsSync(worktree.registryFile()), '登记表该落在 DSH_HOME 下');
});

test('不是 Git 仓库：如实回 not-a-git-repo，不退回原目录', async (t) => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wt-plain-'));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  await assert.rejects(
    () => worktree.createIsolationWorktreeForNew({}, { cwd: plain, label: 'x', reuseKey: 'req-plain' }),
    (error) => error.code === 'not-a-git-repo',
  );
});

test('既没 workspaceId 也没 cwd：bad-request', async () => {
  await assert.rejects(
    () => worktree.createIsolationWorktreeForNew({}, { label: 'x' }),
    (error) => error.code === 'bad-request',
  );
});

// ── 2. 复用：同一个请求键建两次只有一棵 ──────────────────────────────────

test('同一个复用键建两次：交回同一棵，盘上只多一棵', async (t) => {
  const repo = makeRepo(t, 'reuse');
  const before = worktreePaths(repo).length;

  const first = await worktree.createIsolationWorktreeForNew({}, { cwd: repo, label: 'demo', reuseKey: 'req-same' });
  t.after(() => worktree.releaseIsolationWorktree({ repoRoot: first.repoRoot, cwd: first.cwd }));
  const second = await worktree.createIsolationWorktreeForNew({}, { cwd: repo, label: 'demo', reuseKey: 'req-same' });

  assert.equal(first.reused, false);
  assert.equal(second.reused, true, '第二次该复用');
  assert.equal(second.cwd, first.cwd, '交回的必须是同一棵');
  assert.equal(worktreePaths(repo).length, before + 1, '连开两次只能多一棵');
});

test('不同的复用键各建一棵（不误复用别人的树）', async (t) => {
  const repo = makeRepo(t, 'distinct');
  const before = worktreePaths(repo).length;
  const a = await worktree.createIsolationWorktreeForNew({}, { cwd: repo, label: 'a', reuseKey: 'req-1' });
  const b = await worktree.createIsolationWorktreeForNew({}, { cwd: repo, label: 'b', reuseKey: 'req-2' });
  t.after(async () => {
    await worktree.releaseIsolationWorktree({ repoRoot: a.repoRoot, cwd: a.cwd });
    await worktree.releaseIsolationWorktree({ repoRoot: b.repoRoot, cwd: b.cwd });
  });
  assert.notEqual(a.cwd, b.cwd);
  assert.equal(worktreePaths(repo).length, before + 2);
});

test('登记表里的树被手工删掉之后，复用键不再交回一个不存在的目录', async (t) => {
  const repo = makeRepo(t, 'stale');
  const first = await worktree.createIsolationWorktreeForNew({}, { cwd: repo, label: 'demo', reuseKey: 'req-stale' });
  // 模拟用户自己 `rm -rf` 了那棵树。
  fs.rmSync(first.cwd, { recursive: true, force: true });

  const second = await worktree.createIsolationWorktreeForNew({}, { cwd: repo, label: 'demo', reuseKey: 'req-stale' });
  t.after(() => worktree.releaseIsolationWorktree({ repoRoot: second.repoRoot, cwd: second.cwd }));

  assert.equal(second.reused, false, '目录不在了就该照常新建');
  assert.notEqual(second.cwd, first.cwd);
  assert.ok(fs.existsSync(second.cwd));
});

// ── 3. 回收：按会话号收、保留的不收、失败不抛 ────────────────────────────

test('回收：按会话号删树，git 那边少一棵，登记表也清掉那条', async (t) => {
  const repo = makeRepo(t, 'release');
  const made = await worktree.createIsolationWorktreeForNew({}, { cwd: repo, label: 'demo', reuseKey: 'req-rel' });
  worktree.bindSession('session-x', { cwd: made.cwd, repoRoot: made.repoRoot, reuseKey: 'req-rel' });

  assert.ok(worktree.isolationOf('session-x'), '绑过之后该能按会话号找到它');
  const before = worktreePaths(repo).length;

  const result = await worktree.releaseForSessions(['session-x']);
  assert.deepEqual(result.released, ['session-x']);
  assert.equal(worktreePaths(repo).length, before - 1, 'git 那边该少一棵');
  assert.equal(fs.existsSync(made.cwd), false, '目录该真的没了');
  assert.equal(worktree.isolationOf('session-x'), null, '登记表里那条该清掉');
});

test('保留策略：keep 的树不被自动回收', async (t) => {
  const repo = makeRepo(t, 'keep');
  const made = await worktree.createIsolationWorktreeForNew({}, { cwd: repo, label: 'demo', reuseKey: 'req-keep', keep: true });
  t.after(() => worktree.releaseIsolationWorktree({ repoRoot: made.repoRoot, cwd: made.cwd }));
  worktree.bindSession('session-keep', { cwd: made.cwd, repoRoot: made.repoRoot, reuseKey: 'req-keep', keep: true });

  const result = await worktree.releaseForSessions(['session-keep']);
  assert.deepEqual(result.kept, ['session-keep']);
  assert.equal(fs.existsSync(made.cwd), true, '选了保留就不该被回收');
});

test('建成之后才决定保留：setIsolationKeep 改得动后面的回收', async (t) => {
  const repo = makeRepo(t, 'keep-later');
  const made = await worktree.createIsolationWorktreeForNew({}, { cwd: repo, label: 'demo', reuseKey: 'req-kl' });
  t.after(() => worktree.releaseIsolationWorktree({ repoRoot: made.repoRoot, cwd: made.cwd }));
  worktree.bindSession('session-kl', { cwd: made.cwd, repoRoot: made.repoRoot, reuseKey: 'req-kl' });

  assert.equal(worktree.setIsolationKeep('session-kl', true), true);
  assert.deepEqual((await worktree.releaseForSessions(['session-kl'])).kept, ['session-kl']);
  assert.equal(fs.existsSync(made.cwd), true);

  assert.equal(worktree.setIsolationKeep('session-kl', false), true);
  assert.deepEqual((await worktree.releaseForSessions(['session-kl'])).released, ['session-kl']);
  assert.equal(fs.existsSync(made.cwd), false);
});

test('清理：参数不全 / keep 回 false，目录已经不在了算收干净、不抛', async () => {
  // 参数不全与「选了保留」都不该起 git 进程，也都只是回 false。
  assert.equal(await worktree.releaseIsolationWorktree({}), false);
  assert.equal(await worktree.releaseIsolationWorktree({ repoRoot: '/nope', cwd: '/nope', keep: true }), false);
  // 树已经不在了（用户手工删 / 上一轮 prune 过）：算收干净 —— 登记表也顺手清掉，
  // 否则它会一直指着一个不存在的目录。
  worktree.recordIsolation({ reuseKey: 'req-already-gone', repoRoot: '/nope', cwd: '/nope', keep: false });
  assert.equal(await worktree.releaseIsolationWorktree({ repoRoot: '/nope', cwd: '/nope' }), true);
  assert.equal(worktree.registeredIsolations()['reuse:req-already-gone'], undefined);
});

// ── 4. 自动回收：会话结束（归档 / 从清单消失）就收 ───────────────────────

test('自动回收：归档的会话与从清单消失的会话都被收，还在的不动', async (t) => {
  const repo = makeRepo(t, 'sweep');
  const gone = await worktree.createIsolationWorktreeForNew({}, { cwd: repo, label: 'gone', reuseKey: 'req-g' });
  const dropped = await worktree.createIsolationWorktreeForNew({}, { cwd: repo, label: 'drop', reuseKey: 'req-d' });
  const alive = await worktree.createIsolationWorktreeForNew({}, { cwd: repo, label: 'alive', reuseKey: 'req-a' });
  t.after(() => worktree.releaseIsolationWorktree({ repoRoot: alive.repoRoot, cwd: alive.cwd }));
  worktree.bindSession('s-archived', { cwd: gone.cwd, repoRoot: gone.repoRoot, reuseKey: 'req-g' });
  worktree.bindSession('s-deleted', { cwd: dropped.cwd, repoRoot: dropped.repoRoot, reuseKey: 'req-d' });
  worktree.bindSession('s-alive', { cwd: alive.cwd, repoRoot: alive.repoRoot, reuseKey: 'req-a' });

  const result = await lifecycle.sweepIsolationWorktrees({}, {
    liveSessionIds: ['s-alive'],
    archivedSessionIds: ['s-archived'],
  }, { force: true });

  assert.ok(result, '该跑了一次回收');
  assert.deepEqual(result.released.sort(), ['s-archived', 's-deleted']);
  assert.equal(fs.existsSync(gone.cwd), false, '归档的会话那棵该收掉');
  assert.equal(fs.existsSync(dropped.cwd), false, '从清单消失的会话那棵该收掉');
  assert.equal(fs.existsSync(alive.cwd), true, '还在的会话那棵不许动');
});

test('自动回收：拿不到清单时一棵都不动（读不到不等于全没了）', async (t) => {
  const repo = makeRepo(t, 'noalive');
  const made = await worktree.createIsolationWorktreeForNew({}, { cwd: repo, label: 'x', reuseKey: 'req-na' });
  t.after(() => worktree.releaseIsolationWorktree({ repoRoot: made.repoRoot, cwd: made.cwd }));
  worktree.bindSession('s-na', { cwd: made.cwd, repoRoot: made.repoRoot, reuseKey: 'req-na' });

  assert.equal(await lifecycle.sweepIsolationWorktrees({}, {}, { force: true }), null, '两组都空就不跑');
  assert.equal(fs.existsSync(made.cwd), true, '不该因为读不到清单就把树全收了');
});

test('自动回收有节流与在途锁：紧接着的第二次不再跑', async (t) => {
  const repo = makeRepo(t, 'throttle');
  const made = await worktree.createIsolationWorktreeForNew({}, { cwd: repo, label: 'x', reuseKey: 'req-th' });
  t.after(() => worktree.releaseIsolationWorktree({ repoRoot: made.repoRoot, cwd: made.cwd }));
  worktree.bindSession('s-th', { cwd: made.cwd, repoRoot: made.repoRoot, reuseKey: 'req-th' });
  const ctx = {};
  const first = await lifecycle.sweepIsolationWorktrees(ctx, { liveSessionIds: ['other'], archivedSessionIds: [] });
  assert.ok(first, '第一次该跑');
  const second = await lifecycle.sweepIsolationWorktrees(ctx, { liveSessionIds: ['other'], archivedSessionIds: [] });
  assert.equal(second, null, '节流窗口内不该再跑');
});

// ── 5. 事务：会话 create 失败时回滚那棵树 ───────────────────────────────

test('事务：session.create 回错 → 刚建的那棵被回滚，盘上不残留', async (t) => {
  const repo = makeRepo(t, 'rollback');
  const before = worktreePaths(repo).length;
  const ctx = makeCtx(repo, () => ({ result: { ok: false, error: { code: 'boom', message: '宿主拒绝建会话' } } }));

  const res = makeRes();
  await handleNew(ctx, makeReq({ workspaceId: 'w1', isolate: true }), res);

  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, 'boom');
  assert.equal(ctx.calls.create.length, 1, '该真的试过一次 create');
  assert.equal(worktreePaths(repo).length, before, 'create 失败就不该留一棵树');
  // 登记表里也不该留下这条复用键 —— 它会指着一个已经不存在的目录。
  const registered = worktree.registeredIsolations();
  assert.equal(registered['reuse:'] === undefined || Object.keys(registered).length === 0, true, '回滚之后不该留登记');
});

test('事务：session.create 不回 sessionId（形状坏）→ 同样回滚', async (t) => {
  const repo = makeRepo(t, 'rollback2');
  const before = worktreePaths(repo).length;
  const ctx = makeCtx(repo, () => ({ result: { ok: true, value: {} } }));

  const res = makeRes();
  await handleNew(ctx, makeReq({ workspaceId: 'w1', isolate: true }), res);

  assert.equal(res.status, 500);
  assert.equal(worktreePaths(repo).length, before, '没有 sessionId 也不算建成，树要回滚');
});

test('事务：建成功时登记表把树挂到会话号上，之后能按会话号收掉', async (t) => {
  const repo = makeRepo(t, 'bind');
  const ctx = makeCtx(repo);
  const res = makeRes();
  await handleNew(ctx, makeReq({ workspaceId: 'w1', isolate: true }), res);

  assert.equal(res.status, 200);
  assert.equal(res.body.isolated, true);
  const treeCwd = res.body.cwd;
  assert.ok(fs.existsSync(treeCwd), '树该在盘上');
  t.after(() => worktree.releaseIsolationWorktree({ repoRoot: repo, cwd: treeCwd }));

  const entry = worktree.isolationOf(res.body.sessionId);
  assert.ok(entry, '登记表该把会话号与树对上');
  assert.equal(entry.cwd, treeCwd);
  assert.equal(entry.keep, false, '默认不保留');

  await worktree.releaseForSessions([res.body.sessionId]);
  assert.equal(fs.existsSync(treeCwd), false);
});

test('事务：keepWorktree: true 时登记成保留，会话结束后不回收', async (t) => {
  const repo = makeRepo(t, 'keepflag');
  const ctx = makeCtx(repo);
  const res = makeRes();
  await handleNew(ctx, makeReq({ workspaceId: 'w1', isolate: true, keepWorktree: true }), res);

  assert.equal(res.status, 200);
  assert.equal(res.body.keepWorktree, true);
  const entry = worktree.isolationOf(res.body.sessionId);
  t.after(() => worktree.releaseIsolationWorktree({ repoRoot: repo, cwd: entry.cwd }));
  assert.equal(entry.keep, true, '选了保留就该登记成保留');
  assert.deepEqual((await worktree.releaseForSessions([res.body.sessionId])).kept, [res.body.sessionId]);
});

test('事务：同一个 requestId 重投不会开出第二棵', async (t) => {
  const repo = makeRepo(t, 'retry');
  const ctx = makeCtx(repo);
  const headers = { 'x-dsh-request-id': 'rid-same' };
  // 第一次：create 回 500（幂等窗口对 >=500 不缓存，所以重投会真的再进来）。
  let first = true;
  ctx.apiProxy.sessions.create = async (request) => {
    ctx.calls.create.push(request.payload);
    if (first) { first = false; return { result: { ok: true, value: {} } }; }
    return { result: { ok: true, value: { sessionId: 's-retry' } } };
  };
  const before = worktreePaths(repo).length;

  const res1 = makeRes();
  await handleNew(ctx, makeReq({ workspaceId: 'w1', isolate: true }, headers), res1);
  assert.equal(res1.status, 500, '第一次形状坏');
  assert.equal(worktreePaths(repo).length, before, '失败那次把自己的树回滚掉了');

  const res2 = makeRes();
  await handleNew(ctx, makeReq({ workspaceId: 'w1', isolate: true }, headers), res2);
  assert.equal(res2.status, 200);
  const treeCwd = res2.body.cwd;
  t.after(() => worktree.releaseIsolationWorktree({ repoRoot: repo, cwd: treeCwd }));
  assert.equal(worktreePaths(repo).length, before + 1, '重投之后盘上只有一棵');
  assert.equal(ctx.calls.create.length, 2);
});

// ── 6. 写队列：串行、失败不带走后续、暂停与恢复 ──────────────────────────

test('withProjectWrite：同键串行（后一个等前一个落定）', async () => {
  const order = [];
  const first = queue.withProjectWrite('proj-a', async () => {
    order.push('first-start');
    await new Promise((r) => setTimeout(r, 30));
    order.push('first-end');
  });
  const second = queue.withProjectWrite('proj-a', async () => {
    order.push('second-start');
    order.push('second-end');
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end']);
});

test('withProjectWrite：不同键并行（不会互相排队）', async () => {
  const order = [];
  const a = queue.withProjectWrite('proj-x', async () => {
    order.push('a-start');
    await new Promise((r) => setTimeout(r, 25));
    order.push('a-end');
  });
  const b = queue.withProjectWrite('proj-y', async () => {
    order.push('b-start');
    await new Promise((r) => setTimeout(r, 5));
    order.push('b-end');
  });
  await Promise.all([a, b]);
  // b 很短、a 很长：并行的证据是 b 在 a 结束之前就完成了。
  assert.ok(order.indexOf('b-end') < order.indexOf('a-end'), `实际顺序 ${order.join(' → ')}`);
});

test('withProjectWrite：一次失败不把后续排队的活一起带走', async () => {
  const ran = [];
  await assert.rejects(() => queue.withProjectWrite('proj-f', async () => { throw new Error('boom'); }), /boom/);
  await queue.withProjectWrite('proj-f', async () => { ran.push('after'); });
  assert.deepEqual(ran, ['after'], '失败之后后续的写仍要跑');
});

test('pause / resume：暂停时任务停在门口，恢复后放行', async () => {
  let ran = false;
  queue.pauseProjectWrites('proj-p');
  assert.equal(queue.isProjectPaused('proj-p'), true);

  const task = queue.withProjectWrite('proj-p', async () => { ran = true; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ran, false, '暂停期间该停在门口');

  queue.resumeProjectWrites('proj-p');
  assert.equal(queue.isProjectPaused('proj-p'), false);
  await task;
  assert.equal(ran, true, '恢复之后该真的跑掉');
});

test('pause：只停住还没落盘的那些，暂停之前已经在跑的那个不被中断', async () => {
  const order = [];
  const running = queue.withProjectWrite('proj-r', async () => {
    order.push('running-start');
    await new Promise((r) => setTimeout(r, 30));
    order.push('running-end');
  });
  // 先等它真的进到任务里再暂停：`withProjectWrite` 的 run 是在队尾的微任务里执行的，
  // 连 pause 一起发出去的话，暂停会赶在它开跑之前生效 —— 那时它也算「还没落盘」。
  while (!order.includes('running-start')) await new Promise((r) => setTimeout(r, 1));
  queue.pauseProjectWrites('proj-r');
  const waiting = queue.withProjectWrite('proj-r', async () => { order.push('waiting'); });
  await running;
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ['running-start', 'running-end'], '已经在跑的那个照常跑完，后面那个还停着');
  queue.resumeProjectWrites('proj-r');
  await waiting;
  assert.deepEqual(order, ['running-start', 'running-end', 'waiting']);
});

test('pause / resume 的用户出口：那条路由能读能切', async () => {
  const { handleProjectWrites } = require('../lib/mobile/project-writes.js');

  const read0 = await callWriteRoute(handleProjectWrites, { path: 'proj-ui' }, null);
  assert.equal(read0.status, 200);
  assert.equal(read0.body.paused, false);

  const on = await callWriteRoute(handleProjectWrites, {}, { path: 'proj-ui', paused: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.paused, true);
  assert.equal(queue.isProjectPaused('proj-ui'), true, '路由该真的切到队列上');

  const read1 = await callWriteRoute(handleProjectWrites, { path: 'proj-ui' }, null);
  assert.equal(read1.body.paused, true);

  const off = await callWriteRoute(handleProjectWrites, {}, { path: 'proj-ui', paused: false });
  assert.equal(off.body.paused, false);
  assert.equal(queue.isProjectPaused('proj-ui'), false);

  // 缺参数如实 400，不静默什么都不做。
  assert.equal((await callWriteRoute(handleProjectWrites, {}, { paused: true })).status, 400);
  assert.equal((await callWriteRoute(handleProjectWrites, {}, { path: 'proj-ui' })).status, 400);
  assert.equal((await callWriteRoute(handleProjectWrites, {}, null)).status, 400);
});

/** 跑一次 project/writes：query 走 URL，body 走请求流（传 null 表示 GET）。 */
async function callWriteRoute(handler, query, body) {
  const search = new URLSearchParams(query || {}).toString();
  const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]);
  req.headers = {};
  req.url = `/api/mobile/v1/project/writes${search ? `?${search}` : ''}`;
  req.method = body ? 'POST' : 'GET';
  const res = { status: null, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = JSON.parse(payload); };
  await handler({}, req, res);
  return res;
}

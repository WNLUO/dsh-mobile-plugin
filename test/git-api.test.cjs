'use strict';

// 移动端 Git 接口（lib/mobile/git.js）的活体测试：真 git、真临时仓库、真 handler。
//
// 守的是三件事：
//   1. 归属与路径——不属于这台设备的工作区、不在识别结果里的仓库根、带 `..` 的路径，一律拒绝；
//   2. 只读那几条的形状（分组、行号、分页、改名、二进制）与写操作之后的状态（暂存 / 提交 / 切分支）；
//   3. 错误码是契约：空提交信息、没有暂存内容、脏工作区切分支，各自给固定的 code 而不是一段英文。

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const gitApi = require('../lib/mobile/git.js');

function sh(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/** 一个带两次提交的真仓库：a.txt（第二提交里改过一次）、b.txt、c.bin、README.md。 */
function makeProject(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-git-api-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'dev@example.com');
  sh(dir, 'config', 'user.name', 'Dev');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'bee\n');
  fs.writeFileSync(path.join(dir, 'c.bin'), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'first commit');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  sh(dir, 'add', 'a.txt');
  sh(dir, 'commit', '-q', '-m', 'second commit');
  return dir;
}

function ctxFor(projectPath, extra = {}) {
  return {
    // 模型服务只在 AI 写提交信息那条路上被问到；其余用例不提供它。
    get: (name) => (name === 'llm' ? extra.llm : undefined),
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

test('不属于这台设备的工作区：403，且不碰盘', async (t) => {
  const project = makeProject(t);
  const result = await call(gitApi.handleGitRepo, ctxFor(project), `/api/mobile/v1/git/repo${q({ workspaceId: 'nope' })}`);
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, 'FORBIDDEN');
});

test('仓库根不在识别结果里：403（挡住「随便指一个目录」）', async (t) => {
  const project = makeProject(t);
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-git-other-')));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const result = await call(gitApi.handleGitRepo, ctxFor(project), `/api/mobile/v1/git/repo${q({ workspaceId: 'w1', repo: other })}`);
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, 'FORBIDDEN');
});

test('路径里带 ..：400 PATH_OUTSIDE', async (t) => {
  const project = makeProject(t);
  const result = await call(gitApi.handleGitDiff, ctxFor(project), `/api/mobile/v1/git/diff${q({ workspaceId: 'w1', path: '../evil.txt' })}`);
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'PATH_OUTSIDE');
});

test('仓库摘要：分支、上游、脏文件数', async (t) => {
  const project = makeProject(t);
  fs.writeFileSync(path.join(project, 'a.txt'), 'changed\n');
  const result = await call(gitApi.handleGitRepo, ctxFor(project), `/api/mobile/v1/git/repo${q({ workspaceId: 'w1' })}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.isRepo, true);
  assert.equal(result.body.branch, 'main');
  assert.equal(result.body.detached, false);
  assert.equal(result.body.upstream, null);
  assert.equal(result.body.ahead, null);
  assert.equal(result.body.dirtyCount, 1);
});

test('变更清单：已暂存 / 未暂存 / 未跟踪三组分开', async (t) => {
  const project = makeProject(t);
  fs.writeFileSync(path.join(project, 'a.txt'), 'staged change\n');
  sh(project, 'add', 'a.txt');
  fs.writeFileSync(path.join(project, 'b.txt'), 'worktree change\n');
  fs.writeFileSync(path.join(project, 'new.txt'), 'brand new\n');

  const status = await call(gitApi.handleGitStatus, ctxFor(project), `/api/mobile/v1/git/status${q({ workspaceId: 'w1' })}`);
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.staged.map((file) => [file.path, file.stage]), [['a.txt', 'staged']]);
  assert.deepEqual(status.body.unstaged.map((file) => [file.path, file.stage]), [['b.txt', 'unstaged']]);
  assert.deepEqual(status.body.untracked.map((file) => [file.path, file.status]), [['new.txt', '?']]);
  assert.equal(status.body.staged[0].additions, 1);
  assert.equal(status.body.staged[0].deletions, 3);
});

test('单文件 diff：不仅能取到 hunk，行号也在插件这侧算好', async (t) => {
  const project = makeProject(t);
  fs.writeFileSync(path.join(project, 'a.txt'), 'one\ntwo\nthree\nfour\n');
  const result = await call(gitApi.handleGitDiff, ctxFor(project), `/api/mobile/v1/git/diff${q({ workspaceId: 'w1', path: 'a.txt' })}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.binary, false);
  const lines = result.body.hunks.flatMap((hunk) => hunk.lines);
  const added = lines.find((line) => line.kind === 'add');
  assert.equal(added.text, 'four');
  assert.equal(added.newLine, 4);
  assert.equal(added.oldLine, null);
});

test('未跟踪文件的 diff：把整个文件当新增读出来', async (t) => {
  const project = makeProject(t);
  fs.writeFileSync(path.join(project, 'new.txt'), 'alpha\nbeta\n');
  const result = await call(gitApi.handleGitDiff, ctxFor(project), `/api/mobile/v1/git/diff${q({ workspaceId: 'w1', path: 'new.txt' })}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.status, '?');
  assert.equal(result.body.hunks.length, 1);
  assert.deepEqual(result.body.hunks[0].lines.map((line) => line.text), ['alpha', 'beta']);
});

test('二进制文件：只给标记，不画假行', async (t) => {
  const project = makeProject(t);
  fs.writeFileSync(path.join(project, 'c.bin'), Buffer.from([9, 9, 9, 9, 9]));
  const result = await call(gitApi.handleGitDiff, ctxFor(project), `/api/mobile/v1/git/diff${q({ workspaceId: 'w1', path: 'c.bin' })}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.binary, true);
  assert.equal(result.body.hunks.length, 0);
});

test('提交历史：分页多取一条判 hasMore，统计跟着走', async (t) => {
  const project = makeProject(t);
  const first = await call(gitApi.handleGitLog, ctxFor(project), `/api/mobile/v1/git/log${q({ workspaceId: 'w1', limit: '1' })}`);
  assert.equal(first.status, 200);
  assert.equal(first.body.commits.length, 1);
  assert.equal(first.body.commits[0].subject, 'second commit');
  assert.equal(first.body.hasMore, true);

  const second = await call(gitApi.handleGitLog, ctxFor(project), `/api/mobile/v1/git/log${q({ workspaceId: 'w1', limit: '1', skip: '1' })}`);
  assert.equal(second.body.commits[0].subject, 'first commit');
  assert.equal(second.body.commits[0].filesChanged, 4);
});

test('提交详情：文件清单带状态字母与增删', async (t) => {
  const project = makeProject(t);
  const head = sh(project, 'rev-parse', 'HEAD').trim();
  const result = await call(gitApi.handleGitShow, ctxFor(project), `/api/mobile/v1/git/show${q({ workspaceId: 'w1', hash: head })}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.commit.subject, 'second commit');
  assert.equal(result.body.commit.filesChanged, 1);
  assert.deepEqual(
    result.body.commit.files.map((file) => [file.path, file.status, file.additions]),
    [['a.txt', 'M', 1]],
  );
});

test('分支清单：本地当前分支标出来，远端分支只读', async (t) => {
  const project = makeProject(t);
  sh(project, 'branch', 'feature');
  const result = await call(gitApi.handleGitBranches, ctxFor(project), `/api/mobile/v1/git/branches${q({ workspaceId: 'w1' })}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.current, 'main');
  const names = result.body.branches.map((branch) => [branch.name, branch.current, branch.remote]);
  assert.deepEqual(names, [['feature', false, false], ['main', true, false]]);
});

test('暂存一个文件：回一份新的变更清单', async (t) => {
  const project = makeProject(t);
  fs.writeFileSync(path.join(project, 'a.txt'), 'one\n');
  const result = await call(gitApi.handleGitStage, ctxFor(project), '/api/mobile/v1/git/stage', { workspaceId: 'w1', path: 'a.txt' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.status.staged.map((file) => file.path), ['a.txt']);
  assert.deepEqual(result.body.status.unstaged, []);
});

test('全部取消暂存：回到未暂存', async (t) => {
  const project = makeProject(t);
  fs.writeFileSync(path.join(project, 'a.txt'), 'one\n');
  sh(project, 'add', 'a.txt');
  const result = await call(gitApi.handleGitUnstage, ctxFor(project), '/api/mobile/v1/git/unstage', { workspaceId: 'w1', all: true });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.status.staged, []);
  assert.deepEqual(result.body.status.unstaged.map((file) => file.path), ['a.txt']);
});

test('提交：空信息 / 没暂存 / 正常三条路', async (t) => {
  const project = makeProject(t);
  const empty = await call(gitApi.handleGitCommit, ctxFor(project), '/api/mobile/v1/git/commit', { workspaceId: 'w1', message: '   ' });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, 'EMPTY_MESSAGE');

  const nothing = await call(gitApi.handleGitCommit, ctxFor(project), '/api/mobile/v1/git/commit', { workspaceId: 'w1', message: '空提交' });
  assert.equal(nothing.status, 400);
  assert.equal(nothing.body.error.code, 'NOTHING_STAGED');

  const before = sh(project, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(project, 'a.txt'), 'one\ntwo\nthree\nfour\n');
  sh(project, 'add', 'a.txt');
  const ok = await call(gitApi.handleGitCommit, ctxFor(project), '/api/mobile/v1/git/commit', { workspaceId: 'w1', message: '手机上提交的一次' });
  assert.equal(ok.status, 200);
  assert.match(ok.body.hash, /^[0-9a-f]{40}$/);
  assert.notEqual(ok.body.hash, before);
  assert.equal(sh(project, 'log', '-1', '--format=%s').trim(), '手机上提交的一次');
});

test('切分支：干净时能新建，脏工作区直接拒', async (t) => {
  const project = makeProject(t);
  const created = await call(gitApi.handleGitCheckout, ctxFor(project), '/api/mobile/v1/git/checkout', { workspaceId: 'w1', branch: 'feature', create: true });
  assert.equal(created.status, 200);
  assert.equal(created.body.branch, 'feature');

  fs.writeFileSync(path.join(project, 'a.txt'), 'dirty\n');
  const dirty = await call(gitApi.handleGitCheckout, ctxFor(project), '/api/mobile/v1/git/checkout', { workspaceId: 'w1', branch: 'main' });
  assert.equal(dirty.status, 409);
  assert.equal(dirty.body.error.code, 'DIRTY');
});

test('切分支：不存在的分支给 NOT_FOUND，坏名字给 BAD_REQUEST', async (t) => {
  const project = makeProject(t);
  const missing = await call(gitApi.handleGitCheckout, ctxFor(project), '/api/mobile/v1/git/checkout', { workspaceId: 'w1', branch: 'nope' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');

  const bad = await call(gitApi.handleGitCheckout, ctxFor(project), '/api/mobile/v1/git/checkout', { workspaceId: 'w1', branch: 'bad name', create: true });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'BAD_REQUEST');
});

test('概览：文件数 / 行数 / 语言占比 / 提交数，没有远端就不给 github', async (t) => {
  const project = makeProject(t);
  const result = await call(gitApi.handleGitOverview, ctxFor(project), `/api/mobile/v1/git/overview${q({ workspaceId: 'w1' })}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.remote, null);
  assert.equal(result.body.github, undefined);
  assert.equal(result.body.githubError, 'not-github');
  assert.equal(result.body.githubRepo, null);
  assert.equal(result.body.code.files, 4);
  assert.equal(result.body.code.commits, 2);
  assert.ok(result.body.code.lines > 0);
  assert.ok(result.body.languages.length > 0);
  assert.equal(result.body.languages.reduce((sum, item) => sum + item.percent, 0) > 99, true);
});

test('一个项目里两个仓库：请求指哪个就操作哪个', async (t) => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-git-multi-')));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  for (const name of ['one', 'two']) {
    const dir = path.join(project, name);
    fs.mkdirSync(dir);
    sh(dir, 'init', '-q', '-b', 'main');
    sh(dir, 'config', 'user.email', 'dev@example.com');
    sh(dir, 'config', 'user.name', 'Dev');
    fs.writeFileSync(path.join(dir, 'f.txt'), `${name}\n`);
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', `${name} 的第一个提交`);
  }
  const one = path.join(project, 'one');
  const two = path.join(project, 'two');
  const repoOne = await call(gitApi.handleGitRepo, ctxFor(project), `/api/mobile/v1/git/repo${q({ workspaceId: 'w1', repo: one })}`);
  assert.equal(repoOne.body.root, one);
  const logTwo = await call(gitApi.handleGitLog, ctxFor(project), `/api/mobile/v1/git/log${q({ workspaceId: 'w1', repo: two })}`);
  assert.equal(logTwo.body.commits[0].subject, 'two 的第一个提交');
});

test('GitHub 远端的两种「没有数据」互不混淆：没配 / 配了但读不到', async (t) => {
  const read = require('../lib/git/read.js');
  const project = makeProject(t);
  // 不是 github：远端只是本地镜像，页面该说「没有关联 GitHub」。
  sh(project, 'remote', 'add', 'origin', 'https://gitlab.com/someone/elsewhere.git');
  const plain = await call(gitApi.handleGitOverview, ctxFor(project), `/api/mobile/v1/git/overview${q({ workspaceId: 'w1', fresh: '1' })}`);
  assert.equal(plain.body.githubError, 'not-github');
  assert.equal(plain.body.githubRepo, null);

  // 是 github 但读不到（这里刻意用一个不存在的仓库：匿名请求必然回 404）。
  sh(project, 'remote', 'set-url', 'origin', 'git@github.com:dsh-mobile-test/definitely-not-a-real-repo.git');
  const github = await call(gitApi.handleGitOverview, ctxFor(project), `/api/mobile/v1/git/overview${q({ workspaceId: 'w1', fresh: '1' })}`);
  assert.equal(github.body.githubRepo, 'dsh-mobile-test/definitely-not-a-real-repo');
  assert.equal(github.body.githubError, 'unreadable');
  assert.equal(github.body.github, undefined);
});

test('GitHub 远端地址的几种写法都认得（https / ssh 简写 / ssh://）', () => {
  const read = require('../lib/git/read.js');
  assert.deepEqual(read.githubTargetOf('https://github.com/o/r.git'), { owner: 'o', repo: 'r' });
  assert.deepEqual(read.githubTargetOf('https://github.com/o/r'), { owner: 'o', repo: 'r' });
  assert.deepEqual(read.githubTargetOf('git@github.com:o/r.git'), { owner: 'o', repo: 'r' });
  assert.deepEqual(read.githubTargetOf('ssh://git@github.com/o/r.git'), { owner: 'o', repo: 'r' });
  assert.equal(read.githubTargetOf('https://gitlab.com/o/r.git'), null);
  assert.equal(read.githubTargetOf(null), null);
});

test('语言占比只算文本：二进制文件不计入（否则图片会把「其他」撑成大头）', async (t) => {
  const project = makeProject(t);
  fs.writeFileSync(path.join(project, 'big.ts'), 'x'.repeat(4000));
  fs.writeFileSync(path.join(project, 'shot.png'), Buffer.alloc(20000, 7));
  sh(project, 'add', '-A');
  sh(project, 'commit', '-q', '-m', 'add ts and png');

  const result = await call(gitApi.handleGitOverview, ctxFor(project), `/api/mobile/v1/git/overview${q({ workspaceId: 'w1', fresh: '1' })}`);
  const languages = result.body.languages;
  const typescript = languages.find((item) => item.name === 'TypeScript');
  assert.ok(typescript && typescript.percent > 90, `TypeScript 应当占绝大多数，实际 ${JSON.stringify(languages)}`);
  assert.equal(languages.some((item) => /png/i.test(item.name)), false);
  const total = languages.reduce((sum, item) => sum + item.percent, 0);
  assert.ok(Math.abs(total - 100) < 1, `百分比应当合计 100，实际 ${total}`);
});

test('语言占比的口径：第三方 / 数据 / 生成物不进语言条，排不进前十的并进「其他」', async (t) => {
  const project = makeProject(t);
  // 第三方目录里的大文件：不算进 JavaScript。
  fs.mkdirSync(path.join(project, 'vendor', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(project, 'vendor', 'lib', 'bundle.js'), 'var a=1;\n'.repeat(4000));
  // 抓包日志这种数据：不是「用什么语言写的」。
  fs.writeFileSync(path.join(project, 'traffic.jsonl'), '{"a":1}\n'.repeat(4000));
  // 内联成一行的构建产物：800KB 只有一行，得按生成物认出来。
  fs.writeFileSync(path.join(project, 'panel.html'), '<html>' + 'x'.repeat(200000) + '</html>');
  // 真源码：TypeScript。
  fs.writeFileSync(path.join(project, 'main.ts'), 'export const a = 1;\n'.repeat(200));
  sh(project, 'add', '-A');
  sh(project, 'commit', '-q', '-m', 'mix');

  const result = await call(gitApi.handleGitOverview, ctxFor(project), `/api/mobile/v1/git/overview${q({ workspaceId: 'w1', fresh: '1' })}`);
  const languages = result.body.languages;
  const names = languages.map((item) => item.name);
  const typescript = languages.find((item) => item.name === 'TypeScript');
  assert.ok(typescript && typescript.percent > 80, `TypeScript 应当占绝大多数：${JSON.stringify(languages)}`);
  assert.equal(names.includes('JavaScript'), false, 'vendor 里的大文件不该算进 JavaScript');
  const total = languages.reduce((sum, item) => sum + item.percent, 0);
  assert.ok(Math.abs(total - 100) < 1, `百分比合计应当接近 100，实际 ${total}`);
});

// ── push：只推当前分支到它的上游，永不强制 ─────────────────────────────────

/** 一个本地裸仓库当远端；返回它的路径。 */
function makeBareRemote(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-git-remote-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '--bare', '-q', dir], { encoding: 'utf8' });
  // 裸仓库默认 HEAD 指向 master，先拨到 main：否则 clone 出来的工作副本默认在 master 上。
  execFileSync('git', ['--git-dir', dir, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { encoding: 'utf8' });
  return dir;
}

function commitFile(dir, name, body, message) {
  fs.writeFileSync(path.join(dir, name), body);
  sh(dir, 'add', name);
  sh(dir, 'commit', '-q', '-m', message);
}

test('推送：没有上游直接拒（NO_UPSTREAM），不是让它连一次远端再报英文', async (t) => {
  const project = makeProject(t);
  const result = await call(gitApi.handleGitPush, ctxFor(project), '/api/mobile/v1/git/push', { workspaceId: 'w1' });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'NO_UPSTREAM');
});

test('推送：推到真远端，之后 ahead 归零、远端拿到那个提交', async (t) => {
  const project = makeProject(t);
  const remote = makeBareRemote(t);
  sh(project, 'remote', 'add', 'origin', remote);
  sh(project, 'push', '-q', '-u', 'origin', 'main');
  commitFile(project, 'new.txt', 'pushed from phone\n', '手机上提交的一次');

  const before = await call(gitApi.handleGitRepo, ctxFor(project), `/api/mobile/v1/git/repo${q({ workspaceId: 'w1' })}`);
  assert.equal(before.body.ahead, 1);

  const result = await call(gitApi.handleGitPush, ctxFor(project), '/api/mobile/v1/git/push', { workspaceId: 'w1' });
  assert.equal(result.status, 200);
  assert.equal(result.body.branch, 'main');
  assert.equal(result.body.ahead, 0);
  assert.equal(sh(project, 'rev-parse', 'HEAD').trim(), execFileSync('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' }).trim());
});

test('推送：远端有本地没有的提交时拒掉（REJECTED），并提示回电脑上拉', async (t) => {
  const project = makeProject(t);
  const remote = makeBareRemote(t);
  sh(project, 'remote', 'add', 'origin', remote);
  sh(project, 'push', '-q', '-u', 'origin', 'main');

  // 另一台机器（另一个 clone）先推了一条上去。
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-git-other-clone-')));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  sh(os.tmpdir(), 'clone', '-q', remote, other);
  sh(other, 'checkout', '-q', '-B', 'main');
  sh(other, 'config', 'user.email', 'dev@example.com');
  sh(other, 'config', 'user.name', 'Dev');
  commitFile(other, 'from-other.txt', 'other machine\n', '另一台机器的提交');
  sh(other, 'push', '-q', 'origin', 'main');

  commitFile(project, 'mine.txt', 'local\n', '本地新提交');
  const result = await call(gitApi.handleGitPush, ctxFor(project), '/api/mobile/v1/git/push', { workspaceId: 'w1' });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'REJECTED');
});

test('推送：远端地址不存在给 REMOTE_UNAVAILABLE（不把 git 的英文原样丢给手机）', async (t) => {
  const project = makeProject(t);
  const remote = makeBareRemote(t);
  sh(project, 'remote', 'add', 'origin', remote);
  sh(project, 'push', '-q', '-u', 'origin', 'main');
  // 上游已经建好，再把地址改坏：模拟「远端没了 / 地址写错」。
  sh(project, 'remote', 'set-url', 'origin', path.join(os.tmpdir(), 'dsh-no-such-remote'));
  commitFile(project, 'x.txt', 'x\n', '再来一条');
  const result = await call(gitApi.handleGitPush, ctxFor(project), '/api/mobile/v1/git/push', { workspaceId: 'w1' });
  assert.equal(result.status, 502);
  assert.equal(result.body.error.code, 'REMOTE_UNAVAILABLE');
});

// ── AI 写提交信息：只填框，不提交 ─────────────────────────────────────────

/** 一个假的宿主 llm 服务：按给定的块序列流淌。 */
function fakeLlm(chunks) {
  return {
    stream: () => (async function* () { for (const chunk of chunks) yield chunk; })(),
  };
}

test('AI 提交信息：没暂存就拒，不白调一次模型', async (t) => {
  const project = makeProject(t);
  let called = 0;
  const llm = { stream: () => { called += 1; return (async function* () {})(); } };
  const result = await call(gitApi.handleGitCommitMessage, ctxFor(project, { llm }), '/api/mobile/v1/git/commit-message', {
    workspaceId: 'w1', provider: 'deepseek-official', model: 'deepseek-chat',
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'NOTHING_STAGED');
  assert.equal(called, 0);
});

test('AI 提交信息：模型的代码块 / 引号 / 句号被剥掉，只回一行', async (t) => {
  const project = makeProject(t);
  fs.writeFileSync(path.join(project, 'a.txt'), 'one\ntwo\nthree\nfour\n');
  sh(project, 'add', 'a.txt');
  const seen = [];
  const llm = {
    stream(request) {
      seen.push(request);
      return fakeLlm([
        { type: 'text-delta', text: '```text\n' },
        { type: 'text-delta', text: 'feat(git): 变更栏加一颗推送按钮。\n' },
        { type: 'text-delta', text: '```' },
        { type: 'finish', reason: { kind: 'done' } },
      ]).stream(request);
    },
  };
  const result = await call(gitApi.handleGitCommitMessage, ctxFor(project, { llm }), '/api/mobile/v1/git/commit-message', {
    workspaceId: 'w1', provider: 'deepseek-official', model: 'deepseek-chat',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.message, 'feat(git): 变更栏加一颗推送按钮');
  // 提示词里带上了已暂存的文件名与 diff，且指定了模型的 provider / model。
  assert.equal(seen[0].provider, 'deepseek-official');
  assert.equal(seen[0].model, 'deepseek-chat');
  assert.match(seen[0].messages[0].content[0].text, /a\.txt/);
  assert.match(seen[0].messages[0].content[0].text, /\+four/);
  assert.match(seen[0].system, /Conventional Commits/);
});

test('AI 提交信息：模型那边失败 / 没回话都给 LLM_FAILED，不把半截话填进框', async (t) => {
  const project = makeProject(t);
  fs.writeFileSync(path.join(project, 'a.txt'), 'x\n');
  sh(project, 'add', 'a.txt');

  const failed = {
    stream: () => fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { message: '额度用完了' } } }]).stream(),
  };
  const first = await call(gitApi.handleGitCommitMessage, ctxFor(project, { llm: failed }), '/api/mobile/v1/git/commit-message', {
    workspaceId: 'w1', provider: 'p', model: 'm',
  });
  assert.equal(first.status, 502);
  assert.equal(first.body.error.code, 'LLM_FAILED');

  const silent = { stream: () => fakeLlm([{ type: 'finish', reason: { kind: 'done' } }]).stream() };
  const second = await call(gitApi.handleGitCommitMessage, ctxFor(project, { llm: silent }), '/api/mobile/v1/git/commit-message', {
    workspaceId: 'w1', provider: 'p', model: 'm',
  });
  assert.equal(second.status, 502);
  assert.equal(second.body.error.code, 'LLM_FAILED');
});

test('AI 提交信息：宿主机上没有模型服务给 LLM_UNAVAILABLE', async (t) => {
  const project = makeProject(t);
  fs.writeFileSync(path.join(project, 'a.txt'), 'y\n');
  sh(project, 'add', 'a.txt');
  const result = await call(gitApi.handleGitCommitMessage, ctxFor(project), '/api/mobile/v1/git/commit-message', {
    workspaceId: 'w1', provider: 'p', model: 'm',
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'LLM_UNAVAILABLE');
});

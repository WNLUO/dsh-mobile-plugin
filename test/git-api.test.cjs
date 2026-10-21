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

function ctxFor(projectPath) {
  return {
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

'use strict';

// 项目 Git 仓库识别（lib/mobile/git-repos.js）与它挂进工作区清单的那一处接线。
//
// 守的是「侧栏那个 Git 入口到底该不该出现」：项目根是仓库、项目落在某个仓库的子目录
// 里、项目下面并列着若干仓库（含 `.git` 是文件的子模块 / worktree），三种都算有仓库；
// 再往上一层都不认。判据全部来自盘上的 `.git` 与 HEAD，一个 git 进程都不起 ——
// 宿主上可能没装 git，而「这个项目是不是仓库」跟装没装无关。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { describeProjectGit, MAX_DEPTH, MAX_REPOS } = require('../lib/mobile/git-repos.js');
const { buildWorkspacesBody } = require('../lib/mobile/workspaces.js');

/** 每个用例一个独立临时目录；用例结束后整棵删掉。 */
function tmpProject(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-git-repos-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 造一个普通仓库：`.git` 是目录，HEAD 指到一个分支。 */
function makeRepo(dir, branch = 'main') {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  return dir;
}

/** 造一个 `.git` 是文件的仓库（子模块 / worktree / 分离 git 目录都长这样）。 */
function makeLinkedRepo(dir, gitDir, branch = 'main') {
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${gitDir}\n`);
  return dir;
}

test('项目根自己就是仓库：认出根、分支，主仓库排在第一位', async (t) => {
  const project = makeRepo(tmpProject(t), 'feature/x');
  const git = await describeProjectGit(project);

  assert.equal(git.isRepo, true);
  assert.equal(git.root, project);
  assert.equal(git.branch, 'feature/x');
  assert.equal(git.detached, false);
  assert.equal(git.truncated, false);
  assert.equal(git.repos.length, 1);
  assert.deepEqual(git.repos[0], {
    root: project,
    name: path.basename(project),
    relative: '.',
    kind: 'repo',
    branch: 'feature/x',
    detached: false,
    main: true,
  });
});

test('项目只是某个仓库里的一层子目录：按外层仓库根认，relative 写 ..', async (t) => {
  const outer = makeRepo(tmpProject(t), 'main');
  const project = path.join(outer, 'packages', 'app');
  fs.mkdirSync(project, { recursive: true });

  const git = await describeProjectGit(project);
  assert.equal(git.isRepo, true);
  assert.equal(git.root, outer);
  assert.equal(git.repos.length, 1);
  assert.equal(git.repos[0].relative, path.join('..', '..'));
});

test('项目根没有仓库、两个子目录各是一个仓库：两个都认，主仓库取扫描到的第一个', async (t) => {
  const project = tmpProject(t);
  makeRepo(path.join(project, 'server'), 'main');
  makeRepo(path.join(project, 'app'), 'develop');

  const git = await describeProjectGit(project);
  assert.equal(git.isRepo, true);
  assert.equal(git.repos.length, 2);
  // 按名字排序扫描：app 在 server 前面。
  assert.deepEqual(git.repos.map((repo) => repo.relative), ['app', 'server']);
  assert.deepEqual(git.repos.map((repo) => repo.main), [true, false]);
  assert.equal(git.root, path.join(project, 'app'));
  assert.equal(git.branch, 'develop');
});

test('项目根是仓库、下面还并列着另一个仓库：主仓库仍是项目根', async (t) => {
  const project = makeRepo(tmpProject(t), 'main');
  makeRepo(path.join(project, 'vendor', 'tool'), 'master');

  const git = await describeProjectGit(project);
  assert.equal(git.repos.length, 2);
  assert.equal(git.repos[0].relative, '.');
  assert.equal(git.repos[0].main, true);
  assert.equal(git.repos[1].relative, path.join('vendor', 'tool'));
  assert.equal(git.root, project);
});

test('子模块：.git 是文件，顺着 gitdir 读它自己的 HEAD，kind 记成 submodule', async (t) => {
  const project = makeRepo(tmpProject(t), 'main');
  const sub = path.join(project, 'libs', 'shared');
  makeLinkedRepo(sub, path.join(project, '.git', 'modules', 'libs', 'shared'), 'release');

  const git = await describeProjectGit(project);
  const entry = git.repos.find((repo) => repo.relative === path.join('libs', 'shared'));
  assert.ok(entry, '子模块应当出现在仓库清单里');
  assert.equal(entry.kind, 'submodule');
  assert.equal(entry.branch, 'release');
  assert.equal(entry.detached, false);
  assert.equal(entry.main, false);
});

test('worktree：.git 文件指向 worktrees 目录，kind 记成 worktree', async (t) => {
  const project = tmpProject(t);
  const gitDir = path.join(project, 'main-repo', '.git', 'worktrees', 'feature');
  makeLinkedRepo(project, gitDir, 'feature');

  const git = await describeProjectGit(project);
  assert.equal(git.isRepo, true);
  assert.equal(git.repos[0].kind, 'worktree');
  assert.equal(git.repos[0].branch, 'feature');
});

test('detached HEAD：没有分支名，但算有仓库', async (t) => {
  const project = makeRepo(tmpProject(t), 'main');
  fs.writeFileSync(path.join(project, '.git', 'HEAD'), `${'a'.repeat(40)}\n`);

  const git = await describeProjectGit(project);
  assert.equal(git.isRepo, true);
  assert.equal(git.branch, null);
  assert.equal(git.detached, true);
});

test('什么都没有：isRepo 为假，字段形状仍然齐全（前端只判一个字段）', async (t) => {
  const project = tmpProject(t);
  fs.mkdirSync(path.join(project, 'src'));

  const git = await describeProjectGit(project);
  assert.deepEqual(git, { isRepo: false, root: null, branch: null, detached: false, repos: [], truncated: false });
});

test(`只扫 ${MAX_DEPTH} 层：再深一层的仓库不算`, async (t) => {
  const project = tmpProject(t);
  // 第 3 层
  makeRepo(path.join(project, 'a', 'b', 'c'));

  const git = await describeProjectGit(project);
  assert.equal(git.isRepo, false);
});

test('依赖树与点开头的目录里的仓库不算', async (t) => {
  const project = makeRepo(tmpProject(t), 'main');
  makeRepo(path.join(project, 'node_modules', 'dep'));
  makeRepo(path.join(project, '.cache', 'mirror'));

  const git = await describeProjectGit(project);
  assert.equal(git.repos.length, 1);
  assert.equal(git.repos[0].relative, '.');
});

test(`仓库数量封顶 ${MAX_REPOS} 个，超出的置 truncated`, async (t) => {
  const project = tmpProject(t);
  for (let index = 0; index < MAX_REPOS + 1; index += 1) {
    makeRepo(path.join(project, `repo-${String(index).padStart(2, '0')}`));
  }

  const git = await describeProjectGit(project);
  assert.equal(git.repos.length, MAX_REPOS);
  assert.equal(git.truncated, true);
});

test('目录不存在 / 路径是个文件：回「不是仓库」，不抛', async (t) => {
  const project = tmpProject(t);
  const file = path.join(project, 'notes.txt');
  fs.writeFileSync(file, 'x');

  assert.equal((await describeProjectGit(path.join(project, 'missing'))).isRepo, false);
  assert.equal((await describeProjectGit(file)).isRepo, false);
  assert.equal((await describeProjectGit('')).isRepo, false);
  assert.equal((await describeProjectGit(null)).isRepo, false);
});

test('读不动的目录：当没有，不抛', { skip: typeof process.getuid === 'function' && process.getuid() === 0 }, async (t) => {
  const project = tmpProject(t);
  makeRepo(path.join(project, 'locked'));
  fs.chmodSync(path.join(project, 'locked'), 0o000);
  try {
    const git = await describeProjectGit(project, { fresh: true });
    assert.equal(git.isRepo, false);
  } finally {
    fs.chmodSync(path.join(project, 'locked'), 0o755);
  }
});

test('识别按目录缓存：盘上刚建好的仓库要 fresh 才立刻认', async (t) => {
  const project = tmpProject(t);
  assert.equal((await describeProjectGit(project)).isRepo, false);

  makeRepo(project, 'main');
  assert.equal((await describeProjectGit(project)).isRepo, false, '缓存期内不应重新扫盘');
  assert.equal((await describeProjectGit(project, { fresh: true })).isRepo, true);
});

// ── 接线：工作区清单上带 git 标记 ────────────────────────────────────────────

function ctxWithWorkspaces(items) {
  return {
    apiProxy: {
      workspace: {
        list: async () => ({ result: { ok: true, value: { items } } }),
      },
    },
  };
}

test('buildWorkspacesBody：带 path 的条目挂上 git 标记，没 path 的条目一个字不动', async (t) => {
  const project = makeRepo(tmpProject(t), 'main');
  const body = await buildWorkspacesBody(ctxWithWorkspaces([
    { workspaceId: 'w1', path: project, title: 'demo' },
    { workspaceId: 'w2' },
  ]));

  assert.equal(body.ok, true);
  assert.equal(body.items[0].workspaceId, 'w1');
  assert.equal(body.items[0].title, 'demo');
  assert.equal(body.items[0].git.isRepo, true);
  assert.equal(body.items[0].git.branch, 'main');
  assert.equal('git' in body.items[1], false, '没有目录的条目不查，也不编一个结论');
});

test('buildWorkspacesBody：仓库标记进 revision，换分支就是新版本', async (t) => {
  const project = makeRepo(tmpProject(t), 'main');
  const ctx = ctxWithWorkspaces([{ workspaceId: 'w1', path: project }]);
  const before = await buildWorkspacesBody(ctx, { fresh: true });

  makeRepo(project, 'next');
  const after = await buildWorkspacesBody(ctx, { fresh: true });
  assert.notEqual(after.revision, before.revision, '分支变了，快照就是新的');
  assert.equal(after.items[0].git.branch, 'next');
});

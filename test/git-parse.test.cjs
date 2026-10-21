'use strict';

// git 机器可读输出的解析（lib/git/parse.js）—— 纯函数，喂真实输出。
//
// 这些字符串都是在一台真仓库上跑出来再原样贴进来的（`--porcelain=v2 -z`、`--numstat -z`、
// `--name-status -z`、`log --numstat -z`），分隔符与字段顺序一旦被改动，这里先红。

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  parseStatusZ,
  parseNumstatZ,
  parseNameStatusZ,
  parseDiffText,
  parseLogZ,
  parseRefList,
  parseTrack,
} = require('../lib/git/parse.js');

test('status v2：分支头 + 普通改动 + 重命名 + 未跟踪', () => {
  const raw = [
    '# branch.oid 3376ac5df94b0c27f2720604f3711bc1218e987e',
    '# branch.head master',
    '# branch.upstream origin/master',
    '# branch.ab +2 -1',
    '1 M. N... 100644 100644 100644 814f 4cb2 a.txt',
    '2 R. N... 100644 100644 100644 587b 587b R100 d.txt',
    'b.txt',
    '? u.txt',
    '',
  ].join('\0');
  const { entries, branch } = parseStatusZ(raw);
  assert.deepEqual(branch, { head: 'master', oid: '3376ac5df94b0c27f2720604f3711bc1218e987e', upstream: 'origin/master', ahead: 2, behind: 1 });
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { path: 'a.txt', x: 'M', y: '.' });
  // 重命名：path 是改名后的那个，oldPath 是原来那个。
  assert.deepEqual(entries[1], { path: 'd.txt', oldPath: 'b.txt', x: 'R', y: '.' });
  assert.deepEqual(entries[2], { path: 'u.txt', x: '?', y: '?', untracked: true });
});

test('status v2：一条已暂存又改了工作区的文件，两列各自给出', () => {
  const raw = '1 MM N... 100644 100644 100644 a a f.txt\0';
  const { entries } = parseStatusZ(raw);
  assert.equal(entries[0].x, 'M');
  assert.equal(entries[0].y, 'M');
});

test('status v2：detached 与空仓库的头部写法', () => {
  assert.equal(parseStatusZ('# branch.head (detached)\0').branch.head, null);
  assert.equal(parseStatusZ('# branch.oid (initial)\0').branch.oid, null);
});

test('status v2：带空格的路径不被切断', () => {
  const { entries } = parseStatusZ('1 M. N... 100644 100644 100644 a a "my dir/a b.txt"\0');
  assert.equal(entries[0].path, '"my dir/a b.txt"');
});

test('numstat：普通、二进制、重命名（路径字段留空）', () => {
  const items = parseNumstatZ('1\t0\ta.txt\0-\t-\tc.bin\0' + '0\t0\t\0b.txt\0d.txt\0');
  assert.deepEqual(items[0], { path: 'a.txt', additions: 1, deletions: 0, binary: false });
  assert.equal(items[1].binary, true);
  assert.equal(items[1].additions, 0);
  assert.deepEqual(items[2], { path: 'd.txt', oldPath: 'b.txt', additions: 0, deletions: 0, binary: false });
});

test('name-status：普通与重命名（旧路径在前）', () => {
  const files = parseNameStatusZ('M\0a.txt\0M\0c.bin\0R100\0b.txt\0d.txt\0');
  assert.deepEqual(files, [
    { status: 'M', path: 'a.txt' },
    { status: 'M', path: 'c.bin' },
    { status: 'R', path: 'd.txt', oldPath: 'b.txt' },
  ]);
});

test('diff：hunk 行号自己算，末尾换行不多画一行', () => {
  const text = [
    'diff --git a/a.txt b/a.txt',
    'index 814f..4cb2 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,2 +1,3 @@',
    ' one',
    ' two',
    '+three',
    '',
  ].join('\n');
  const { hunks, binary } = parseDiffText(text);
  assert.equal(binary, false);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].header, '@@ -1,2 +1,3 @@');
  assert.deepEqual(hunks[0].lines.map((line) => [line.kind, line.text, line.oldLine, line.newLine]), [
    ['context', 'one', 1, 1],
    ['context', 'two', 2, 2],
    ['add', 'three', null, 3],
  ]);
});

test('diff：两段 hunk、删除行的旧行号、\\ No newline 提示丢掉', () => {
  const text = [
    '@@ -1,2 +1,1 @@',
    ' keep',
    '-gone',
    '\\ No newline at end of file',
    '@@ -10,1 +9,2 @@',
    ' ten',
    '+eleven',
  ].join('\n');
  const { hunks } = parseDiffText(text);
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0].lines.map((line) => [line.kind, line.oldLine, line.newLine]), [
    ['context', 1, 1],
    ['del', 2, null],
  ]);
  assert.deepEqual(hunks[1].lines.map((line) => [line.kind, line.oldLine, line.newLine]), [
    ['context', 10, 9],
    ['add', null, 10],
  ]);
});

test('diff：二进制只报标记，不画假行', () => {
  const { hunks, binary } = parseDiffText('diff --git a/c.bin b/c.bin\nBinary files a/c.bin and b/c.bin differ\n');
  assert.equal(binary, true);
  assert.equal(hunks.length, 0);
});

test('log：两条提交各自带 numstat 统计，标题与时间都在', () => {
  const raw = [
    '\x1eaaaabbbbccccdddd1111\x1faaaa'
      + '\x1fAlice\x1f2026-10-22T00:01:07+08:00\x1f修一下排序'
      + '\0' + '2\t0\ta.txt\0-\t-\tc.bin\0',
    '\x1e0000111122223333\x1f0000\x1fBob\x1f2026-10-21T10:00:00+08:00\x1f第一次提交'
      + '\0' + '1\t1\tb.txt\0',
  ].join('');
  const commits = parseLogZ(raw);
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0], {
    hash: 'aaaabbbbccccdddd1111',
    shortHash: 'aaaa',
    author: 'Alice',
    time: '2026-10-22T00:01:07+08:00',
    subject: '修一下排序',
    filesChanged: 2,
    additions: 2,
    deletions: 0,
  });
  assert.equal(commits[1].additions, 1);
  assert.equal(commits[1].deletions, 1);
});

test('for-each-ref：一行一条、字段用 NUL 分开', () => {
  const refs = parseRefList(
    'main\0origin/main\0abc1234\0' + '2026-10-22T00:00:00+08:00\n'
    + 'origin/dev\0\0' + 'def5678\0' + '2026-10-20T00:00:00+08:00\n',
  );
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[0], { name: 'main', upstream: 'origin/main', shortHash: 'abc1234', time: '2026-10-22T00:00:00+08:00' });
  assert.equal(refs[1].upstream, '');
});

test('upstream:track 只认两个数字，认不出就说不知道', () => {
  assert.deepEqual(parseTrack('[ahead 1, behind 2]'), { ahead: 1, behind: 2 });
  assert.deepEqual(parseTrack('[ahead 3]'), { ahead: 3, behind: 0 });
  assert.equal(parseTrack('[gone]'), null);
  assert.equal(parseTrack(''), null);
});

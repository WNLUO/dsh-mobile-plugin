'use strict';

/**
 * git 机器可读输出的解析：全部是纯函数，喂字符串出结构化数据。
 *
 * 为什么不用人能读的那份输出：`git status`、`git log --stat` 这些是给眼睛看的，措辞随版本与
 * 语言环境变（`LC_ALL=C` 也挡不住措辞在版本间的改动），拿正则去啃迟早会碎。这里只用
 * `--porcelain=v2 -z` / `--numstat -z` / `--name-status -z` / `for-each-ref` 这些**约定为机器
 * 输出**的格式，字段之间用 NUL 与 `\x1f` 分隔（文件名里可以有空格、冒号、中文，不能有 NUL）。
 *
 * 分隔符约定（都实测过，见 test/git-parse.test.cjs）：
 *   - `status --porcelain=v2 -z`：状态行以 NUL 结尾；重命名那条（`2` 开头）后面紧跟一个 NUL
 *     再跟旧路径；
 *   - `--numstat -z`：正常一条 `增\t删\t路径\0`；重命名的是 `增\t删\t\0旧\0新\0`，路径字段
 *     为空 —— 空就是「后面还有两个」的信号；
 *   - `log --numstat -z --format=%x1e%H`：每条提交以 `\x1e` 开头，hash 之后是若干个 numstat
 *     记录，同样 NUL 结尾；
 *   - `show --name-status -z`：`状态\0路径\0`，重命名是 `R100\0旧\0新\0`；
 *   - `for-each-ref`：一条一行，字段之间是 `%00`。
 */

const NUL = '\0';
const UNIT = '\x1f';
const RECORD = '\x1e';

/** 把 NUL 分隔的 numstat 记录切成 `{ path, oldPath, additions, deletions, binary }`。 */
function parseNumstatZ(text) {
  const tokens = String(text || '').split(NUL);
  const out = [];
  for (let index = 0; index < tokens.length; index += 1) {
    // `--format=` 的提交头后面会跟一个换行，第一条记录因此以 `\n` 开头（实测）。
    const token = tokens[index].replace(/^\n+/, '');
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(token);
    if (!match) continue;
    const binary = match[1] === '-';
    let path = match[3];
    let oldPath;
    if (path === '') {
      // 重命名：路径字段留空，后面紧跟旧路径与新路径。
      oldPath = tokens[index + 1] || '';
      path = tokens[index + 2] || '';
      index += 2;
    }
    if (!path) continue;
    out.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      additions: binary ? 0 : Number(match[1]),
      deletions: binary ? 0 : Number(match[2]),
      binary,
    });
  }
  return out;
}

/**
 * 解析 `status --porcelain=v2 -z --branch`：返回状态条目与分支头信息。
 *
 * 条目里 `x` 是索引相对 HEAD 的状态（已暂存那批），`y` 是工作区相对索引的状态（未暂存那批），
 * 未跟踪是 `?`，冲突是 `u` 那条。
 */
function parseStatusZ(text) {
  const tokens = String(text || '').split(NUL);
  const entries = [];
  const branch = { head: null, oid: null, upstream: null, ahead: 0, behind: 0 };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const kind = token[0];
    if (kind === '#') {
      const [, key, ...rest] = token.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.head') branch.head = value === '(detached)' ? null : value;
      else if (key === 'branch.oid') branch.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.upstream') branch.upstream = value;
      else if (key === 'branch.ab') {
        const match = /\+(-?\d+) -(-?\d+)/.exec(value);
        if (match) {
          branch.ahead = Number(match[1]);
          branch.behind = Number(match[2]);
        }
      }
      continue;
    }
    if (kind === '?') {
      entries.push({ path: token.slice(2), x: '?', y: '?', untracked: true });
      continue;
    }
    if (kind === '!') continue;
    if (kind === '1' || kind === 'u') {
      const fields = kind === '1'
        ? /^1 (\S{2}) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/.exec(token)
        : /^u (\S{2}) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/.exec(token);
      if (!fields) continue;
      entries.push({
        path: fields[2],
        x: fields[1][0],
        y: fields[1][1],
        ...(kind === 'u' ? { conflicted: true } : {}),
      });
      continue;
    }
    if (kind === '2') {
      const fields = /^2 (\S{2}) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/.exec(token);
      if (!fields) continue;
      entries.push({
        path: fields[2],
        oldPath: tokens[index + 1] || '',
        x: fields[1][0],
        y: fields[1][1],
      });
      index += 1;
    }
  }
  return { entries, branch };
}

/** 解析 `--name-status -z`（提交详情里的文件清单）：`状态\0路径\0`，重命名多一个旧路径。 */
function parseNameStatusZ(text) {
  const tokens = String(text || '').split(NUL);
  const out = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index];
    if (!status) continue;
    if (status[0] === 'R' || status[0] === 'C') {
      const oldPath = tokens[index + 1] || '';
      const path = tokens[index + 2] || '';
      index += 2;
      if (path) out.push({ status: status[0], path, oldPath });
      continue;
    }
    const path = tokens[index + 1] || '';
    index += 1;
    if (path) out.push({ status: status[0], path });
  }
  return out;
}

/**
 * 解析统一格式的 diff 文本成 hunk 列表（行号由插件算好，前端不再数）。
 *
 * `\ No newline at end of file` 那种提示行丢掉：它不占行号，留着只会让前端画出一条空行。
 */
function parseDiffText(text) {
  const lines = String(text || '').split('\n');
  // 末尾那个换行会切出一个空串；不先摘掉它，最后一个 hunk 会多画一行空上下文。
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const hunks = [];
  let current = null;
  let oldLine = 0;
  let newLine = 0;
  let binary = false;
  for (const line of lines) {
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      binary = true;
      continue;
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) {
      current.lines.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine });
      newLine += 1;
      continue;
    }
    if (line.startsWith('-')) {
      current.lines.push({ kind: 'del', text: line.slice(1), oldLine, newLine: null });
      oldLine += 1;
      continue;
    }
    if (line.startsWith(' ')) {
      current.lines.push({ kind: 'context', text: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return { hunks, binary };
}

/**
 * 解析 `log --numstat -z --format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s`：
 * 每条提交以 `\x1e` 开头，第一段是按 `\x1f` 切开的元信息，后面是本条提交的 numstat 记录。
 */
function parseLogZ(text) {
  const blocks = String(text || '').split(RECORD);
  const commits = [];
  for (const block of blocks) {
    const trimmed = block.replace(/^\n/, '');
    if (!trimmed) continue;
    const [head, ...stats] = trimmed.split(NUL);
    const fields = head.split(UNIT);
    if (fields.length < 5) continue;
    const [hash, shortHash, author, time, subject] = fields;
    const files = parseNumstatZ(stats.join(NUL));
    commits.push({
      hash,
      shortHash,
      author,
      time,
      subject,
      filesChanged: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    });
  }
  return commits;
}

/** 解析 `for-each-ref --format=%(refname:short)%00…`：一条一行，字段之间是 NUL。 */
function parseRefList(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.split(NUL))
    .filter((fields) => fields.length >= 2 && fields[0])
    .map((fields) => ({ name: fields[0], upstream: fields[1] || '', shortHash: fields[2] || '', time: fields[3] || '' }));
}

/**
 * `%(upstream:track)` 是 git 给眼睛看的一行（`[ahead 1, behind 2]`），只认 ahead/behind 两个
 * 数字：措辞可能随版本变，数字不会。拿不到就返回空串，界面按「没上游」处理。
 */
function parseTrack(text) {
  const match = /ahead (\d+)/.exec(String(text || ''));
  const behind = /behind (\d+)/.exec(String(text || ''));
  if (!match && !behind) return null;
  return { ahead: match ? Number(match[1]) : 0, behind: behind ? Number(behind[1]) : 0 };
}

module.exports = {
  NUL,
  UNIT,
  RECORD,
  parseNumstatZ,
  parseStatusZ,
  parseNameStatusZ,
  parseDiffText,
  parseLogZ,
  parseRefList,
  parseTrack,
};

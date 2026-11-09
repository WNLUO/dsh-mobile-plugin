'use strict';

/**
 * 会话级工作目录隔离：给一条新会话在项目仓库里开一个 git worktree，让它在独立目录里干活，
 * 不再和同项目的其他会话抢同一批文件。
 *
 * 为什么是 worktree：宿主建会话只认一个 cwd，而 cwd 一旦建好就改不了；把 cwd 指到一条独立
 * 工作树，等于这条会话从根上和别人隔开。桌面的「对话分身」早有同款机制（dsh-devmap 的
 * createTree），这里只取「开一棵独立工作树」这一小步，不搬它的合并 / 对账。
 *
 * 三条边界：
 * 1. 目录由插件按「已登记项目的仓库根」自己算，App 只传一个布尔，不接受任何外部路径 ——
 *    能力面没有从「工作区目录」放宽到「任意路径」。
 * 2. 只有项目确实是 Git 仓库才开得了树；不是仓库就如实回错误，不退回「就在原目录建」。
 *    `git init` 之后一次都没提交的空仓库同样开不了（HEAD 指不到任何提交），也按
 *    `not-a-git-repo` 如实回，只是文案说清是「还没有第一次提交」。
 * 3. 建树时起 git 进程（worktree add），与 `git/*` 写接口同一路；识别层仍是只读盘（见
 *    A3-51 的刻意设计），两者不冲突。
 *
 * ## 树挂在具名分支上
 *
 * 此前用 `worktree add --detach`：树里 `git commit` 能成功，但提交不挂在任何分支上，树一被
 * 回收那些提交就成了悬空对象、迟早被 gc —— 用户在树里干完的活拿不回来。现在改成开一条具名
 * 分支（名字见 `isolationBranchName`），分支名与基线 sha 一起记进登记表；回收时**只有那条
 * 分支上没有任何超出基线的提交**才顺手删掉它，有提交就留着。
 *
 * ## 建了就要有人收（2026-11-10 修）
 *
 * 这里此前只有「建」，删树的出口 `releaseIsolationWorktree` 全仓零调用方：开一次多一棵，
 * 会话结束只靠手工 `git worktree prune`。现在三件事一起补上：
 *
 *  - **登记**：每建一棵都在 `worktrees.json` 里记一条 `{repoRoot, cwd, sessionId, keep,
 *    branch, baseSha}`。登记必须落盘而不是只放内存 —— 会话与工作树都比一次插件重启活得久，
 *    内存表一丢，盘上那些树就再也没人知道它们属于谁。
 *  - **回收**：会话归档 / 被删 / 从宿主清单里消失时，`releaseForSessions` 按登记表删树
 *    （调用点在 `worktree-lifecycle.js`，接的是会话列表那条刷新）。清理失败只记不抛：
 *    收尾本身不能因为删不掉一棵树就崩。
 *  - **保留策略**：建的时候能选「保留」（`keep: true`），保留的那些不进自动回收；默认清理。
 *
 * 另外两点是「开两次别留两棵」的那一半：同一个 `reuseKey`（一次新建请求）重复进来复用已经
 * 建好的那棵；会话 create 失败时由调用方回滚（`releaseIsolationWorktree`）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { mkdir } = require('node:fs/promises');
const { createHash, randomBytes } = require('node:crypto');

const { dshHome } = require('../shared/paths');
const { runGit } = require('../git/exec');
const { describeProjectGit } = require('./git-repos');
const { unwrap } = require('./envelope');

/** 工作树都收在这一个目录下，按仓库根哈希分桶，便于日后整目录清。 */
function worktreeRoot() {
  return path.join(dshHome(), 'storages', 'mobile-plugin', 'worktrees');
}

/**
 * 登记表：`{ version: 1, entries: { <key>: { repoRoot, cwd, sessionId, keep, createdAt, branch?, baseSha? } } }`。
 * `branch` / `baseSha` 是后加的；老记录没有这两个字段，读的地方一律按「可能没有」处理。
 */
function registryFile() {
  return path.join(dshHome(), 'storages', 'mobile-plugin', 'worktrees.json');
}

function readRegistry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryFile(), 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      return { version: 1, entries: parsed.entries };
    }
  } catch {
    // 没有 / 读坏 / 形状不对：都当空表。登记表只是回收用的线索，读不出来不该挡住建树。
  }
  return { version: 1, entries: {} };
}

function writeRegistry(state) {
  const file = registryFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, entries: state.entries }, null, 2)}\n`);
  } catch {
    // 写不进去就算了：树照样能用，只是重启之后这条线索没了。
  }
}

/** 一棵树属于谁的那个键：优先会话号，没有会话号时用「这次请求」的复用键。 */
function entryKeyOf({ sessionId, reuseKey }) {
  if (typeof sessionId === 'string' && sessionId) return `session:${sessionId}`;
  if (typeof reuseKey === 'string' && reuseKey) return `reuse:${reuseKey}`;
  return '';
}

/**
 * 登记一棵刚建好的树（同键覆盖：复用那条路也会走到这里刷新一次）。
 *
 * `branch` / `baseSha` 是后加的字段：老登记记录里没有它们，读的地方一律按「可能没有」处理，
 * 别的地方照着旧形状写出来的记录也照样能用。
 */
function recordIsolation({ sessionId, reuseKey, repoRoot, cwd, keep, branch, baseSha }) {
  const key = entryKeyOf({ sessionId, reuseKey });
  if (!key || !repoRoot || !cwd) return;
  const state = readRegistry();
  const previous = state.entries[key];
  state.entries[key] = {
    repoRoot,
    cwd,
    ...(sessionId ? { sessionId } : {}),
    keep: keep === true,
    createdAt: (previous && previous.createdAt) || Date.now(),
    ...(branch ? { branch } : {}),
    ...(baseSha ? { baseSha } : {}),
  };
  writeRegistry(state);
}

/** 把一条会话挂到已经建好的那棵树上（建树时还不知道会话号）。 */
function bindSession(sessionId, { cwd, repoRoot, reuseKey, keep, branch, baseSha }) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  const state = readRegistry();
  const stale = entryKeyOf({ reuseKey });
  const fromReuse = stale ? state.entries[stale] : null;
  if (stale) delete state.entries[stale];
  // 分支信息优先用调用方给的，其次沿用建树时那条复用登记；都没有（老记录）就不写。
  const branchName = branch || (fromReuse && fromReuse.branch) || '';
  const base = baseSha || (fromReuse && fromReuse.baseSha) || '';
  state.entries[`session:${sessionId}`] = {
    repoRoot: (fromReuse && fromReuse.repoRoot) || repoRoot,
    cwd: (fromReuse && fromReuse.cwd) || cwd,
    sessionId,
    keep: keep === true || Boolean(fromReuse && fromReuse.keep),
    createdAt: (fromReuse && fromReuse.createdAt) || Date.now(),
    ...(branchName ? { branch: branchName } : {}),
    ...(base ? { baseSha: base } : {}),
  };
  writeRegistry(state);
}

/** 这条会话的隔离登记（没有就 null）。 */
function isolationOf(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const entry = readRegistry().entries[`session:${sessionId}`];
  return entry && typeof entry.cwd === 'string' ? entry : null;
}

/** 改一棵树的保留策略（「建成后再说要留着」也要能生效）。 */
function setIsolationKeep(sessionId, keep) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const state = readRegistry();
  const key = `session:${sessionId}`;
  if (!state.entries[key]) return false;
  state.entries[key].keep = keep === true;
  writeRegistry(state);
  return true;
}

/** 宿主 workspace.list 里按 id / workspaceId 找到项目目录（绝对路径）。找不到回空串。 */
async function projectPathOf(ctx, workspaceId) {
  const { value, error } = unwrap(await ctx.apiProxy.workspace.list({
    rpcId: 'mobile', method: 'workspace.list', payload: {},
  }));
  if (error) {
    throw Object.assign(new Error(error.message || '读工作区清单失败'), { code: error.code || 'workspace-list-failed' });
  }
  const items = Array.isArray(value) ? value : (value && Array.isArray(value.items) ? value.items : []);
  const hit = items.find((it) => it && (it.id === workspaceId || it.workspaceId === workspaceId));
  const dir = hit && typeof hit.path === 'string' ? hit.path.trim() : '';
  return dir ? path.resolve(dir) : '';
}

/** label 只用来拼目录名，剔掉路径分隔符等不安全字符。 */
function safeLabel(label) {
  const text = String(label || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  return text || 'session';
}

/** 隔离树分支名的前缀：一看就知道是插件开的，不是用户自己的分支。 */
const BRANCH_PREFIX = 'dsh-iso/';

/**
 * 给这次建树拼一个分支名：`dsh-iso/<safeLabel>-<36 进制时间>-<4 位随机>`。
 *
 * `safeLabel` 已经洗掉了 `[A-Za-z0-9_-]` 以外的字符，只再把开头的 `-` / `_` 去掉 ——
 * 免得拼出一个像命令行选项的分支名。时间加随机后缀是为了同一毫秒内开两棵树、或跟以前
 * 留下的分支不撞。
 */
function isolationBranchName(label) {
  const body = safeLabel(label).replace(/^[-_]+/, '') || 'session';
  return `${BRANCH_PREFIX}${body}-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
}

/** 库里已经有这条分支了吗（`rev-parse --verify --quiet` 的退出码就是答案）。 */
async function branchExists(repoRoot, branch) {
  const result = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { timeoutMs: 8000 });
  if (result.error === 'GIT_UNAVAILABLE') {
    throw Object.assign(new Error('这台电脑上没有可用的 git，无法开隔离工作目录'), { code: 'git-unavailable' });
  }
  if (result.error === 'TIMEOUT') {
    throw Object.assign(new Error('git 超时：查这个仓库的分支没有响应，开不了隔离工作目录'), { code: 'git-failed' });
  }
  // 非零既可能是「没有这条分支」，也可能是仓库读不了 —— 后者会让下一步的建树如实报错。
  return result.code === 0;
}

/**
 * 建树失败后的尽力回滚：删掉这次刚建出来的那个目录，让 git 清掉对应的登记，再顺手收掉
 * 没来得及挂上任何提交的那条分支。
 *
 * 只在目录确实是本次建出来的前提下删（`created`），别人的既有工作树一律不碰。整段吞错：
 * 回滚本身失败最多留一点残骸，**绝不能盖掉调用方要抛的那个原始错误**。
 */
async function rollbackTreeAdd(repoRoot, treeDir, { created, branch, baseSha } = {}) {
  try {
    if (created === true) fs.rmSync(treeDir, { recursive: true, force: true });
  } catch {
    // 盘上删不掉就交给下面的 prune 尽力而为。
  }
  try {
    await runGit(repoRoot, ['worktree', 'prune'], { timeoutMs: 8000 });
  } catch {
    // prune 起不来也没关系：残骸不挡下一次重试。
  }
  await dropBranchIfUnused(repoRoot, branch, baseSha);
}

/**
 * 给一条新会话开隔离工作目录。
 *
 * 树开在一条具名分支上（不是 detached HEAD）：树里提交的活挂在分支上，树被回收之后那些
 * 提交仍然在仓库里，用户还能 merge / cherry-pick 回来。
 *
 * @param {object} ctx 插件上下文
 * @param {{ workspaceId?: string, cwd?: string, label?: string, reuseKey?: string, keep?: boolean }} opts
 *   项目工作区 id 或项目目录；`reuseKey` 是「这次新建请求」的稳定键，同一个键重复进来会
 *   复用已经建好的那棵（连开两次不留两棵）；`keep` 为 true 表示这棵树建好后不自动回收。
 * @returns {Promise<{ cwd: string, repoRoot: string, reused: boolean, branch?: string, baseSha?: string }>}
 *   抛错时 `code`：bad-request / not-a-git-repo / git-unavailable / git-failed / workspace-list-failed。
 *   项目里一次提交都没有（HEAD 无效）也回 `not-a-git-repo`，只是文案说明是还没提交过。
 */
async function createIsolationWorktreeForNew(ctx, { workspaceId, cwd, label, reuseKey, keep } = {}) {
  // 复用：同一个请求重复进来时，已经建好的那棵直接交回去。先看目录还在不在 ——
  // 登记表里的树可能已经被手工 prune 掉了，那就当没有、照常新建。
  const existingKey = entryKeyOf({ reuseKey });
  if (existingKey) {
    const existing = readRegistry().entries[existingKey];
    if (existing && existing.cwd && !fs.existsSync(existing.cwd)) {
      // 那棵树已经被手工删掉了：登记顺手清掉，旧分支要是没干活也收掉，别在仓库里堆空分支。
      dropRecord(existing.cwd);
      if (existing.repoRoot) await pruneAndDropBranch(existing.repoRoot, existing.branch, existing.baseSha);
    }
    if (existing && existing.cwd && fs.existsSync(existing.cwd)) {
      return {
        cwd: existing.cwd,
        repoRoot: existing.repoRoot,
        reused: true,
        branch: existing.branch,
        baseSha: existing.baseSha,
      };
    }
  }

  let projectPath = '';
  if (workspaceId) {
    projectPath = await projectPathOf(ctx, workspaceId);
    if (!projectPath) {
      throw Object.assign(new Error('找不到这个项目的工作区目录，无法开隔离工作目录'), { code: 'bad-request' });
    }
  } else if (cwd) {
    projectPath = path.resolve(cwd);
  } else {
    throw Object.assign(new Error('隔离工作目录需要指定一个项目'), { code: 'bad-request' });
  }

  const marker = await describeProjectGit(projectPath, { fresh: true });
  if (!marker || !marker.isRepo || !marker.root) {
    throw Object.assign(new Error('这个项目不是 Git 仓库，无法开隔离工作目录'), { code: 'not-a-git-repo' });
  }
  const repoRoot = marker.root;
  // 先确认 HEAD 指得到一次提交：刚 `git init`、一次都没提交的仓库里 HEAD 是空的，
  // 直接建树只会落进泛化失败、回一句用户看不懂的英文。这里提前判掉，并复用
  // not-a-git-repo（上层 session-new 已经把它映射成 400）。顺带把基线 sha 拿到手 ——
  // 分支就从这里开出来，登记表也记它。
  const headResult = await runGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], { timeoutMs: 8000 });
  if (headResult.error === 'GIT_UNAVAILABLE') {
    throw Object.assign(new Error('这台电脑上没有可用的 git，无法开隔离工作目录'), { code: 'git-unavailable' });
  }
  if (headResult.error === 'TIMEOUT') {
    throw Object.assign(new Error('git 超时：读这个仓库的 HEAD 没有响应，开不了隔离工作目录'), { code: 'git-failed' });
  }
  const baseSha = (headResult.stdout || '').trim();
  if (headResult.code !== 0 || !baseSha) {
    throw Object.assign(
      new Error('这个项目还没有任何一次提交，开不了隔离工作目录 —— 先在项目里提交一次再试'),
      { code: 'not-a-git-repo' },
    );
  }

  const bucket = createHash('sha1').update(repoRoot).digest('hex').slice(0, 12);
  const treeDir = path.join(worktreeRoot(), bucket, `${safeLabel(label)}-${Date.now()}`);
  // 目录名带着时间戳，正常不会已存在；万一撞上（同一毫秒）就不回滚它，只清本次自己建的。
  const treePreexisted = fs.existsSync(treeDir);
  try {
    await mkdir(path.dirname(treeDir), { recursive: true });
  } catch (error) {
    throw Object.assign(new Error(`建隔离目录失败：${String((error && error.message) || error)}`), { code: 'git-failed' });
  }

  // 分支名撞车就换一个（最多试三次），仍撞就如实报错 —— 不硬用一个既有分支，
  // 那会把用户的活和这条会话的活搅在一起。
  let branch = '';
  for (let attempt = 0; attempt < 3 && !branch; attempt += 1) {
    const candidate = isolationBranchName(label);
    if (!(await branchExists(repoRoot, candidate))) branch = candidate;
  }
  if (!branch) {
    throw Object.assign(new Error('给隔离工作目录起分支名时连续撞名，稍后再试一次'), { code: 'git-failed' });
  }

  const result = await runGit(repoRoot, ['worktree', 'add', '-b', branch, treeDir, baseSha], { timeoutMs: 15000 });
  if (result.error === 'GIT_UNAVAILABLE') {
    throw Object.assign(new Error('这台电脑上没有可用的 git，无法开隔离工作目录'), { code: 'git-unavailable' });
  }
  if (result.error === 'TIMEOUT' || result.code !== 0) {
    // 半成品（半棵目录 + git 里的登记）也清掉再抛，否则用户下次重试或 `worktree list`
    // 才会撞见残骸。原始错误仍然是抛出去的那一个。
    await rollbackTreeAdd(repoRoot, treeDir, { created: !treePreexisted, branch, baseSha });
    if (result.error === 'TIMEOUT') {
      throw Object.assign(new Error('建隔离工作目录超时（大仓库首次检出可能比较慢），已清掉这次的残留，稍后重试'), {
        code: 'git-failed',
      });
    }
    const detail = (result.stderr || '').trim();
    throw Object.assign(new Error(detail ? `创建隔离工作目录失败：${detail}` : '创建隔离工作目录失败'), {
      code: 'git-failed',
      stderr: result.stderr,
    });
  }
  recordIsolation({ reuseKey, repoRoot, cwd: treeDir, keep, branch, baseSha });
  return { cwd: treeDir, repoRoot, reused: false, branch, baseSha };
}

/**
 * 只删「没干活」的分支：只有分支尖恰好还在基线 sha 上（或干脆没建出来）时才删。
 *
 * 判据是 `merge-base --is-ancestor <branch> <baseSha>` —— 成立说明分支上没有超出基线的
 * 提交，删了不丢东西；用户已经在树里提交过就留着，那是他的活，宁可留一条分支也不吞掉。
 * 只看本模块前缀的分支，别人的分支一律不碰。整段尽力而为，失败只当没删。
 */
async function dropBranchIfUnused(repoRoot, branch, baseSha) {
  if (!repoRoot || !branch || !baseSha) return;
  if (!String(branch).startsWith(BRANCH_PREFIX)) return;
  try {
    const reached = await runGit(repoRoot, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, baseSha], { timeoutMs: 8000 });
    if (reached.error) return;
    if (reached.code === 0) await runGit(repoRoot, ['branch', '-D', branch], { timeoutMs: 8000 });
  } catch {
    // 删不掉就留着：一条空分支不碍事。
  }
}

/**
 * 磁盘上那条目录已经不在了时的收尾：先让 git 认下「那棵树没了」，再收拾它的分支。
 *
 * 不 prune 的话，git 仍然把分支算在被那棵工作树占着，`branch -D` 会被拒。老登记记录里
 * 没有分支字段，那种情况什么都不用做，也就别去起 git 进程。
 */
async function pruneAndDropBranch(repoRoot, branch, baseSha) {
  if (!repoRoot || !branch || !baseSha) return;
  try {
    await runGit(repoRoot, ['worktree', 'prune'], { timeoutMs: 8000 });
  } catch {
    // prune 起不来就只当分支那步没做成。
  }
  await dropBranchIfUnused(repoRoot, branch, baseSha);
}

/** 登记表里指向这个目录的那条（回收时用来取分支名与基线；老记录没有这些字段）。 */
function recordOfCwd(cwd) {
  for (const entry of Object.values(readRegistry().entries)) {
    if (entry && entry.cwd === cwd) return entry;
  }
  return null;
}

/**
 * 删掉一棵隔离工作树（`worktree remove --force`，失败退回 `prune`）。
 *
 * 返回是否真的删掉了。**不抛错**：调用点都在会话收尾那一段，清理失败最多留一棵树，
 * 不该把「归档一条会话」变成 500。`keep: true` 的树不删（用户当初选了保留）。
 *
 * 树收干净之后顺带处理它那条分支：分支上没有任何超出基线的提交才删（见
 * `dropBranchIfUnused`），有提交就留着，用户的活不会跟着树一起没。分支信息优先用参数，
 * 没给就从登记表里查 —— 建树回滚那条路就是只传目录进来的。
 */
async function releaseIsolationWorktree({ repoRoot, cwd, keep, branch, baseSha } = {}) {
  if (keep === true) return false;
  if (!repoRoot || !cwd) return false;
  const registered = recordOfCwd(cwd);
  const branchName = branch || (registered && registered.branch) || '';
  const base = baseSha || (registered && registered.baseSha) || '';
  // 目录已经不在了（用户手工删过 / 上一轮就 prune 掉了）：没什么可收的，把登记表里
  // 那条清掉就算收干净了 —— 不起 git 进程，也不把它算成失败。
  if (!fs.existsSync(cwd)) {
    dropRecord(cwd);
    await pruneAndDropBranch(repoRoot, branchName, base);
    return true;
  }
  try {
    const removed = await runGit(repoRoot, ['worktree', 'remove', '--force', cwd], { timeoutMs: 15000 });
    if (removed.code === 0) {
      dropRecord(cwd);
      await dropBranchIfUnused(repoRoot, branchName, base);
      return true;
    }
    await runGit(repoRoot, ['worktree', 'prune'], { timeoutMs: 8000 });
    // prune 之后目录按 git 的说法已经不属于任何工作树了；仍然在盘上就是没删掉。
    if (!fs.existsSync(cwd)) {
      dropRecord(cwd);
      await dropBranchIfUnused(repoRoot, branchName, base);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 删掉登记表里指向这个目录的那条（不管是谁建的）。 */
function dropRecord(cwd) {
  const state = readRegistry();
  let changed = false;
  for (const [key, entry] of Object.entries(state.entries)) {
    if (entry && entry.cwd === cwd) { delete state.entries[key]; changed = true; }
  }
  if (changed) writeRegistry(state);
}

/**
 * 按会话号回收：这些会话已经结束（归档 / 被删 / 从宿主清单里消失）。
 *
 * 一条失败不影响下一条 —— 收尾那一段不能因为一棵树删不掉就整批停。返回
 * `{ released: string[], kept: string[], failed: string[] }`，供日志与测试看。
 */
async function releaseForSessions(sessionIds) {
  const ids = Array.isArray(sessionIds) ? sessionIds.filter((id) => typeof id === 'string' && id) : [];
  const out = { released: [], kept: [], failed: [] };
  if (ids.length === 0) return out;
  const state = readRegistry();
  for (const sessionId of ids) {
    const entry = state.entries[`session:${sessionId}`];
    if (!entry) continue;
    if (entry.keep === true) { out.kept.push(sessionId); continue; }
    // 分支名与基线由 releaseIsolationWorktree 按目录从登记表里取。
    const ok = await releaseIsolationWorktree({ repoRoot: entry.repoRoot, cwd: entry.cwd });
    if (ok) out.released.push(sessionId); else out.failed.push(sessionId);
  }
  return out;
}

/** 登记表里的全部条目（测试与排查用）。 */
function registeredIsolations() {
  return { ...readRegistry().entries };
}

module.exports = {
  createIsolationWorktreeForNew,
  releaseIsolationWorktree,
  releaseForSessions,
  registeredIsolations,
  recordIsolation,
  bindSession,
  isolationOf,
  setIsolationKeep,
  projectPathOf,
  worktreeRoot,
  registryFile,
};

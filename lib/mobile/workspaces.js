'use strict';

/**
 * dsh-mobile 工作区/目录浏览：透传宿主 apiProxy 的目录浏览与工作区采纳 RPC。
 *
 * 移动端是**远程遥控器**——它不能像桌面端那样弹被控端的原生目录对话框。
 *
 * 这里曾经写着一个**错的**前提：以为 directory-picker-auto 会在「宿主绑定局域网（非
 * 127.0.0.1）」时自动启用 `browse` 能力，于是 `apiProxy.host.listDirectory` /
 * `host.createDirectory` 在任何被控端都可用。实际不是：auto 只在「web 服务绑到非回环」
 * 或「平台不是 darwin/win32」时挂 browse，而**桌面 profile 宿主**（手机经 sidecar/中转
 * 连上的那种）两者都不满足，于是恒解析成 native —— 手机端一个条目都列不出来，只能登记
 * 一个恰好已存在的目录。现在这两个动词在宿主不服务 browse 时由插件自带实现兜底，见
 * lib/mobile/directory-browse.js。本模块仍只做与 sessions.js 相同的透传包装。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');
const { isFreshRequest } = require('../shared/fresh-request');
const { stableRevision, unchangedListBody } = require('../shared/list-revision.js');
const { listSignal: sharedListSignal } = require('../shared/list-signal.js');
// 条件刷新要记的那几样按 ctx 隔离：这类模块级状态只许住在 session-cache.js。
const { workspaceShortcutStateOf } = require('./session-cache.js');
// 会话列表缓存归 sessions.js 管。归档/移动会话会改变列表行本身，必须让那边立刻失效，
// 否则手机端按完「归档会话」，那一行最长 10 秒还留在侧栏里，看着像没归档。
const { invalidateSessionList } = require('./sessions.js');
const { withIdempotency, requestIdOf } = require('./idempotency.js');
const { canonicalDeviceKey } = require('./session-cache.js');
const { unwrap } = require('./envelope.js');
const { describeProjectGit } = require('./git-repos.js');

/** 调宿主 apiProxy.host.*（directory-picker 的 browse 能力）。 */
function callHost(ctx, method, payload) {
  return ctx.apiProxy.host[method]({ rpcId: 'mobile', method: `host.${method}`, payload });
}

/** 调宿主 apiProxy.workspace.*（工作区清单与采纳）。 */
function callWorkspace(ctx, method, payload) {
  return ctx.apiProxy.workspace[method]({ rpcId: 'mobile', method: `workspace.${method}`, payload });
}

/**
 * GET /api/mobile/v1/workspaces（token）
 * 列出被控端当前所有工作区，供侧边栏「工作区」区块渲染与重命名/删除判定。
 */
/**
 * 给每条工作区挂上 Git 仓库标记（`git`）。
 *
 * 只有带 `path` 的条目才查：没有路径的条目连目录都没有，给它一个「不是仓库」的结论
 * 只是把「我不知道」说成「我查过了」。识别本身不抛错、按目录缓存，所以这里不再包
 * try —— 包了只会把真 bug 藏起来。
 */
async function attachGitMarkers(items, options) {
  return Promise.all(items.map(async (item) => {
    if (!item || typeof item !== 'object') return item;
    const path = typeof item.path === 'string' ? item.path.trim() : '';
    if (!path) return item;
    return { ...item, git: await describeProjectGit(path, options) };
  }));
}

/**
 * 构建工作区快照 body（供移动端镜像同步推送复用）。
 *
 * `archivedSessionIds` 必须原样透传：宿主 `workspace.list` 一直在返回它，
 * 但此前这里只保留 `items`，把它整个丢掉。于是 App 点完「归档会话」拿不到任何
 * 归档状态，侧边栏那一行永远不消失——归档在移动端表现为一次没有反馈的空操作。
 * 它同时也是将来做「取消归档」入口的唯一数据来源。
 *
 * `options.fresh` 透传给仓库识别，跳过它那 15 秒的目录缓存（写后刷新 / 下拉刷新）。
 */
async function buildWorkspacesBody(ctx, options = {}) {
  const { value, error } = unwrap(await callWorkspace(ctx, 'list', {}));
  if (error) return { ok: false, error };
  // 宿主报「成功」却没有给出清单数组，这是**没取到**，不是「你没有工作区」。
  // 旧实现兜底成 `{ ok:true, items:[] }`，于是空篮子一路通过 workspace-guard（只判 .ok）、
  // 被中转冻结成权威空清单、App 下一次 15s 轮询把好数据整个覆盖掉且全程零报错——
  // 真机表现就是侧边栏只剩一根设备行、点不开、只有下拉刷新能救。
  // 形状不对必须走错误通道：下游（App 保留旧数据、镜像保持上一份好快照）才能正确反应。
  const items = Array.isArray(value) ? value : (value && Array.isArray(value.items) ? value.items : null);
  if (items === null) {
    return {
      ok: false,
      error: {
        code: 'host-workspace-list-degraded',
        message: '宿主工作区清单形状异常：响应里没有 items 数组',
      },
    };
  }
  const archivedSessionIds = value && Array.isArray(value.archivedSessionIds)
    ? value.archivedSessionIds.filter(id => typeof id === 'string')
    : [];
  const marked = await attachGitMarkers(items, { fresh: Boolean(options.fresh) });
  return {
    ok: true,
    items: marked,
    archivedSessionIds,
    // 与 sessions 快照同款的新鲜度/空态契约（见 lib/mobile/sessions.js 的说明）：
    // App 把 generatedAt + revision 存进快照用于展示「数据时间」，emptyConfirmed
    // 让「用户真的删光了工作区」不必再靠连续两次空去猜。
    generatedAt: Date.now(),
    // 归档集合也是工作区快照语义的一部分；仅它变化时也必须让镜像推送判为新版本。
    // 仓库标记也在里面：换分支是这份快照的一部分，变了就该推新版本。
    revision: stableRevision({ items: marked, archivedSessionIds }),
    emptyConfirmed: marked.length === 0,
  };
}

/** 短路状态的最长信任时间：只是兜底，工作区信号一涨就会被判失效。 */
const WORKSPACE_SHORTCUT_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * GET /api/mobile/v1/workspaces?rev=<上次的 revision>（token）
 *
 * 与 `/sessions` 同一条条件刷新契约（形状见 `lib/shared/list-revision.js` 的
 * `unchangedListBody`）：`rev` 与最终 body 的 revision **恰好相等**时只回一句
 * `{ok, unchanged:true, revision, generatedAt}`，不带 items。这条路由没有响应缓存，
 * 所以只判「这份刚构建出来的 body」。
 * `?fresh=1` 是写后刷新，必须拿到真数据，一律不走这条。
 */
async function handleWorkspaces(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const rev = (url.searchParams.get('rev') || '').trim();
  const fresh = isFreshRequest(req.url);
  // 仓库识别也认这一个 `fresh`：写后刷新 / 下拉刷新必须看见刚新建的仓库，
  // 不能被识别那 15 秒的目录缓存挡回去。
  //
  // 构建前短路：这份响应里有 `archivedSessionIds`（一份几十 KB 的数组），每 15 秒重建
  // 一次纯属白费。与 `/sessions` 同一条判据：客户端 rev 命中的那份没变、工作区信号没涨、
  // 而且真有观众（推送调度器在跑，信号才可信）。
  const cache = workspaceShortcutStateOf(ctx);
  if (!fresh && rev && sharedListSignal.watching()) {
    const current = sharedListSignal.workspaceSnapshot().revision;
    if (cache.lastRevision === rev && cache.lastSignalRevision === current
      && Date.now() - cache.lastBuiltAt <= WORKSPACE_SHORTCUT_MAX_AGE_MS) {
      return sendJson(res, 200, { ok: true, unchanged: true, revision: rev, generatedAt: cache.lastGeneratedAt });
    }
  }
  const body = await buildWorkspacesBody(ctx, { fresh });
  if (body && typeof body.revision === 'string' && body.revision) {
    cache.lastRevision = body.revision;
    cache.lastGeneratedAt = body.generatedAt;
    cache.lastSignalRevision = sharedListSignal.workspaceSnapshot().revision;
    cache.lastBuiltAt = Date.now();
  }
  const unchanged = fresh ? null : unchangedListBody(body, rev);
  sendJson(res, 200, unchanged || body);
}

/**
 * GET /api/mobile/v1/directory/list?path=…（token；path 缺省 = 被控端主目录）
 * 透传宿主 host.listDirectory：返回 { path, home, crumbs, entries, truncated }，
 * 供前端目录浏览器渲染面包屑与文件夹行（Show hidden 开关在前端侧边过滤）。
 */
async function handleListDirectory(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.searchParams.get('path');
  const payload = path && path.trim() ? { path: path.trim() } : {};
  const { value, error } = unwrap(await callHost(ctx, 'listDirectory', payload));
  if (error) return sendJson(res, 400, { ok: false, error });
  sendJson(res, 200, { ok: true, listing: value });
}

/**
 * POST /api/mobile/v1/directory/create（token）{ path, name }
 * 透传宿主 host.createDirectory：在被控端 `path` 下新建名为 `name` 的文件夹。
 * name 必须为单个非空路径段（不允许含 / 或 \\）。
 */
async function handleCreateDirectory(ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const path = body && typeof body.path === 'string' ? body.path.trim() : '';
  const name = body && typeof body.name === 'string' ? body.name.trim() : '';
  if (!path || !name) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 path 或 name' } });
  const { value, error } = unwrap(await callHost(ctx, 'createDirectory', { path, name }));
  if (error) return sendJson(res, 400, { ok: false, error });
  sendJson(res, 200, { ok: true, path: value && value.path });
}

/**
 * POST /api/mobile/v1/workspace/create（token）{ path }
 * 透传宿主 workspace.create：把被控端 `path` 目录采纳为一个工作区（已存在则返回现有项）。
 * 返回 { workspace: { workspaceId, path, title, ... }, created }。
 */
async function handleCreateWorkspace(ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const path = body && typeof body.path === 'string' ? body.path.trim() : '';
  if (!path) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 path' } });
  const { value, error } = unwrap(await callWorkspace(ctx, 'create', { path }));
  if (error) return sendJson(res, 400, { ok: false, error });
  sendJson(res, 200, { ok: true, workspace: value && value.workspace, created: !!(value && value.created) });
}

/**
 * POST /api/mobile/v1/workspace/delete（token）{ workspaceId }
 * 透传宿主 workspace.delete：删除工作区登记，但保留目录和会话日志。
 */
async function handleDeleteWorkspace(ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const workspaceId = body && typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
  if (!workspaceId) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 workspaceId' } });
  }
  const { value, error } = unwrap(await callWorkspace(ctx, 'delete', { workspaceId }));
  if (error) return sendJson(res, 400, { ok: false, error });
  sendJson(res, 200, { ok: true, ...(value || { deleted: true }) });
}

/**
 * POST /api/mobile/v1/workspace/move-session（token）{ workspaceId, sessionId, beforeSessionId? }
 * 透传宿主 workspace.insertSessionBefore，使移动端和桌面端共享工作区排序。
 */
async function handleMoveWorkspace(ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const workspaceId = body && typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
  const beforeWorkspaceId = body && typeof body.beforeWorkspaceId === 'string' ? body.beforeWorkspaceId.trim() : '';
  if (!workspaceId) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 workspaceId' } });
  const payload = { workspaceId, ...(beforeWorkspaceId ? { beforeWorkspaceId } : {}) };
  const { value, error } = unwrap(await callWorkspace(ctx, 'insertBefore', payload));
  if (error) return sendJson(res, 400, { ok: false, error });
  sendJson(res, 200, { ok: true, workspaceIds: value && value.workspaceIds });
}

async function handleMoveSession(ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const workspaceId = body && typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
  const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  const beforeSessionId = body && typeof body.beforeSessionId === 'string' ? body.beforeSessionId.trim() : '';
  if (!workspaceId || !sessionId) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 workspaceId 和 sessionId' } });
  }
  const payload = { workspaceId, sessionId, ...(beforeSessionId ? { beforeSessionId } : {}) };
  const { value, error } = unwrap(await callWorkspace(ctx, 'insertSessionBefore', payload));
  if (error) return sendJson(res, 400, { ok: false, error });
  invalidateSessionList(ctx);
  sendJson(res, 200, { ok: true, workspace: value && value.workspace });
}

/**
 * POST /api/mobile/v1/workspace/rename（token）{ workspaceId, title }
 * 透传宿主 workspace.rename：改工作区显示名，重名返回 workspace/name-conflict。
 * 返回 { workspace }。App 的 `renameWorkspace()` 一直在调这个地址，但在本次修复
 * 之前插件根本没注册它 —— 会话列表里的「重命名工作区」永远 404。
 */
async function handleRenameWorkspace(ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const workspaceId = body && typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
  const title = body && typeof body.title === 'string' ? body.title.trim() : '';
  if (!workspaceId || !title) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 workspaceId 和 title' } });
  }
  const { value, error } = unwrap(await callWorkspace(ctx, 'rename', { workspaceId, title }));
  if (error) return sendJson(res, 400, { ok: false, error });
  sendJson(res, 200, { ok: true, workspace: value && value.workspace });
}

/**
 * POST /api/mobile/v1/workspace/archive-session（token）{ sessionId, stopActivity? }
 * 透传宿主 workspace.archiveSession：把会话移入归档（日志保留、从工作区列表隐藏）。
 * 这是移动端唯一的「删除会话」语义，同样曾因未注册路由而对 App 返回 404。
 */
async function handleArchiveSession(ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!sessionId) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 sessionId' } });
  }
  // 归档在宿主侧本身是幂等的（重复归档同一会话状态不变），但仍按 requestId 重放：
  // 重投要拿到和第一次一样的结果，而不是让 App 再多等一次 RPC。
  const outcome = await withIdempotency(ctx, canonicalDeviceKey(req), requestIdOf(req, body), async () => {
    const payload = { sessionId, ...(body.stopActivity === true ? { stopActivity: true } : {}) };
    const { value, error } = unwrap(await callWorkspace(ctx, 'archiveSession', payload));
    if (error) return { status: 400, body: { ok: false, error } };
    invalidateSessionList(ctx);
    return { status: 200, body: { ok: true, ...(value || {}) } };
  });
  sendJson(res, outcome.status, outcome.body);
}

/**
 * 会话级开关写的公共骨架（取消归档 / 置顶 / 取消置顶三条共用）。
 *
 * 与 handleArchiveSession 完全同一套口径：请求体只要 sessionId；按 requestId 走幂等
 * 重放（宿主的这三个动词本身幂等，但重投要拿到和第一次一样的响应体）；成功后立刻作废
 * 会话列表缓存，否则 App 按完最长 10 秒里拿到的还是旧那一行，看着像没生效。
 *
 * 宿主回执分别是 `{ archivedSessionIds }` / `{ pinnedSessionIds }`（后者按「最近置顶的
 * 在前」排序），原样透传给 App——它据此立刻重排侧栏。
 */
async function runSessionFlagWrite(ctx, req, res, method) {
  const body = await readJsonBody(req, 64 * 1024);
  const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!sessionId) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 sessionId' } });
  }
  const outcome = await withIdempotency(ctx, canonicalDeviceKey(req), requestIdOf(req, body), async () => {
    const { value, error } = unwrap(await callWorkspace(ctx, method, { sessionId }));
    if (error) return { status: 400, body: { ok: false, error } };
    invalidateSessionList(ctx);
    return { status: 200, body: { ok: true, ...(value || {}) } };
  });
  sendJson(res, outcome.status, outcome.body);
}

/**
 * POST /api/mobile/v1/workspace/unarchive-session（token）{ sessionId }
 * 透传宿主 workspace.unarchiveSession：把会话移出归档集合（未归档的 id 是 no-op）。
 * 移动端此前没有任何取消归档入口，而归档又是移动端唯一的「删除」语义——归档错了
 * 就只能去桌面端捞回来。
 */
async function handleUnarchiveSession(ctx, req, res) {
  return runSessionFlagWrite(ctx, req, res, 'unarchiveSession');
}

/**
 * POST /api/mobile/v1/workspace/pin-session（token）{ sessionId }
 * 透传宿主 workspace.pinSession：把会话加进置顶集合（宿主侧对已归档会话报
 * `gateway/bad-request`，所以 App 的置顶入口在归档行上不出现）。
 */
async function handlePinSession(ctx, req, res) {
  return runSessionFlagWrite(ctx, req, res, 'pinSession');
}

/**
 * POST /api/mobile/v1/workspace/unpin-session（token）{ sessionId }
 * 透传宿主 workspace.unpinSession：把会话移出置顶集合（未置顶的 id 是 no-op）。
 */
async function handleUnpinSession(ctx, req, res) {
  return runSessionFlagWrite(ctx, req, res, 'unpinSession');
}

module.exports = {
  buildWorkspacesBody,
  handleMoveWorkspace,
  handleWorkspaces,
  handleListDirectory,
  handleCreateDirectory,
  handleCreateWorkspace,
  handleRenameWorkspace,
  handleDeleteWorkspace,
  handleMoveSession,
  handleArchiveSession,
  handleUnarchiveSession,
  handlePinSession,
  handleUnpinSession,
};
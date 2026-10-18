'use strict';

/**
 * 端点表：旧 `apiProxy.<ns>.<method>` 的键 ⇄ 宿主 wire 名与参数形状。
 *
 * ⚠️ 这张表是人肉对照宿主 descriptor 校验的，**没有任何机器可校验机制**，而它错一次的
 * 后果是静默的：`sessions.projections` 曾少包一层 `request`，宿主每次都回 400，
 * 而 App 侧把 400 catch 掉了，于是整个统计 UI 凭空消失。args 的键名必须**恰好**是
 * descriptor 的 wire 名（多一个少一个都报 gateway/arguments-invalid，dropUnexpectedArgs
 * 只摘多余的键，救不了「少一个」）。改动前请先在 test/host-bridge-endpoints.test.cjs
 * 里补一条参数化用例。
 */

const { invoke, invokeEnvelope, ok, fail, pick, requestId, unsupported, warn } = require('./transport.js');
const { historyViaPage, modelCatalog, workspaceListViaFollow, subagentCatalog } = require('./shims.js');
const { createDirectory, hostServesBrowse, listDirectory, wireError } = require('../directory-browse.js');

// ── 端点表 ────────────────────────────────────────────────────────────────
//
// inv(namespace, method, buildArgs)：最常见的一档 —— 宿主方法只有一个 `request` 参数，
// payload 原样塞进去即可。少数几个要改名（sessionId → agentId）、要丢字段
// （fork 的 increaseTitle）、要补必填字段（prompt 的 requestId）。

function inv(namespace, method, buildArgs) {
  return (ctx, payload, signal) => invokeEnvelope(ctx, namespace, method, (buildArgs || ((p) => ({ request: p })))(payload), signal);
}

const ENDPOINTS = {
  // sessions
  // 会话列表：键名是 `_request` —— 宿主签名 `list(_request: SessionListRequest, signal)`
  // 用下划线前缀表示「保留的空请求」，assertExactArguments 认的就是这个字面名。
  'sessions.list': inv('session', 'list', (p) => ({ _request: p && Object.keys(p).length ? p : {} })),
  'sessions.history': (ctx, payload, signal) => historyViaPage(ctx, payload, signal),
  // 0.2.0 把投影从 session.page 的返回值里拆走了（page 只回 events/hasMore/cursor），
  // 整帧 values 只能走这一个端点。
  //
  // args 形状由宿主 typertGateway 的 assertExactArguments 把关：键名必须**恰好**是
  // descriptor 的 wire 名，多一个少一个都报 gateway/arguments-invalid（而
  // dropUnexpectedArgs 只会摘多余的键，救不了「少一个」）。session/projections 的
  // descriptor 只有一个参数，wire 名是 `request`，内层是 `object({ sessionId })`
  // （app.asar 里 dsh_api_session_controller 的 session.projections parameter_0 schema）。
  //
  // 这里曾经写成 `pick(p, ['sessionId'])`（注释断言「没有 request 包层」，是错的）：
  // 少一层 request，宿主每次都回 `missing "request"` → /session/stats 恒 400。而
  // App 侧把 400 catch 掉了（app/src/ChatScreen.tsx 的统计轮询 `catch { }`），于是
  // **一整层 UI 静默消失**：输入框下方的统计行、ContextMeter 圆环、TodoDock、
  // GoalBar、权限档、planMode、图片上限——它们全都来自这一个投影帧。
  // 形状写错的代价是不报错的「功能不见了」，所以每个端点都要对着宿主 descriptor 核。
  'sessions.projections': inv('session', 'projections', (p) => ({ request: pick(p, ['sessionId']) })),
  'sessions.prompt': inv('session', 'prompt', (p) => ({
    request: {
      ...pick(p, ['sessionId', 'mode', 'content', 'clientTimeZone']),
      requestId: typeof (p && p.requestId) === 'string' && p.requestId ? p.requestId : requestId('mobile-prompt'),
    },
  })),
  'sessions.cancel': inv('session', 'cancel'),
  'sessions.rename': inv('session', 'rename'),
  'sessions.create': inv('session', 'create'),
  'sessions.search': inv('session', 'search'),
  'sessions.selectModel': inv('session', 'selectModel'),
  'sessions.attachment': inv('session', 'attachment'),
  'sessions.updateQueue': inv('session', 'updateQueue'),
  // 宿主的 fork 请求体只有 sessionId / atSeq，increaseTitle 在 0.2.0 已删除。
  'sessions.fork': inv('session', 'fork', (p) => ({ request: pick(p, ['sessionId', 'atSeq']) })),
  // 宿主的模型目录是全局的（不再按 session 查），这里翻译成插件/移动端要的形状；
  // payload 带 sessionId，供 modelCatalog 叠加会话自己的 modelSelection 投影。
  'sessions.models': (ctx, payload, signal) => modelCatalog(ctx, payload, signal),

  // agentPresets（namespace 是复数 agentPresets）
  'agentPresets.list': inv('agentPresets', 'list', () => ({})),
  'agentPresets.read': inv('agentPresets', 'read', (p) => ({ agentPreset: p && p.agentPreset })),
  'agentPresets.select': (ctx, payload, signal) =>
    invoke(ctx, 'agentPresets', 'select', { agentId: payload.sessionId, agentPreset: payload.agentPreset }, signal)
      .then((r) => (r.error ? fail(r.error) : ok({ agentPreset: r.value }))),
  'agentPresets.copy': () => unsupported('复制 agent preset 的接口'),
  'agentPresets.remove': () => unsupported('删除 agent preset 的接口'),

  // workspace
  'workspace.list': (ctx, payload, signal) => workspaceListViaFollow(ctx, signal),
  'workspace.create': inv('workspace', 'create'),
  'workspace.rename': inv('workspace', 'rename'),
  'workspace.delete': inv('workspace', 'delete'),
  'workspace.archiveSession': inv('workspace', 'archiveSession'),
  'workspace.unarchiveSession': inv('workspace', 'unarchiveSession'),
  'workspace.pinSession': inv('workspace', 'pinSession'),
  'workspace.unpinSession': inv('workspace', 'unpinSession'),
  'workspace.insertBefore': inv('workspace', 'insertBefore'),
  'workspace.insertSessionBefore': inv('workspace', 'insertSessionBefore'),

  // host.* → directoryPicker.*（宿主服务 browse 时），否则回落到插件自带的 browse 原语。
  //
  // 为什么会有「否则」：宿主那套选择器由 directory-picker-auto 启动时二选一，只有
  // 「web 服务绑到非回环」或「平台不是 darwin/win32」才挂 browse；无头移动宿主由本包的
  // cordis.mobile-host.yml 钉成 browse，**桌面 profile 宿主**则解析成 native。于是
  // 「桌面宿主 + 手机远程连」这一格没人盖 —— 手机点「添加工作区」只拿到
  // `host.listDirectory needs the browse capability`，一个条目都列不出来。
  // 判定与回落语义见 lib/mobile/directory-browse.js 的头注释：宿主服务 browse 就整条走
  // 宿主（策略单一真源），宿主明确只服务 native（或查不到选择器）时用插件自己那份。
  //
  // 金标准（test/host-bridge-endpoints.test.cjs）钉的仍是「走宿主」那条路由：它的假 ctx
  // 显式给了一个 browse 能力对象。
  'host.listDirectory': (ctx, payload, signal) => (hostServesBrowse(ctx)
    ? invokeEnvelope(ctx, 'directoryPicker', 'list', pick(payload, ['path']), signal)
    : localListDirectory(ctx, payload, signal)),
  'host.createDirectory': (ctx, payload, signal) => (hostServesBrowse(ctx)
    ? invoke(ctx, 'directoryPicker', 'createDirectory', { path: payload.path, name: payload.name }, signal)
      .then((r) => (r.error ? fail(r.error) : ok({ path: r.value })))
    : localCreateDirectory(ctx, payload, signal)),

  // skills / subagents
  'skills.list': inv('skills', 'list'),
  'subagents.history': inv('subagents', 'history'),
  'subagents.prompt': inv('subagents', 'prompt', (p) => ({
    request: {
      ...pick(p, ['parentSessionId', 'childSessionId', 'mode', 'content', 'clientTimeZone']),
      requestId: typeof (p && p.requestId) === 'string' && p.requestId ? p.requestId : requestId('mobile-subagent'),
      delivery: (p && p.delivery) || 'queue',
    },
  })),
  'subagents.interrupt': (ctx, payload, signal) =>
    invoke(ctx, 'subagents', 'interruptByParent', {
      childSessionId: payload.childSessionId,
      parentSessionId: payload.parentSessionId,
      mode: payload.mode || 'continuable',
    }, signal).then((r) => (r.error ? fail(r.error) : ok(r.value))),
  'subagents.list': (ctx, payload, signal) => subagentCatalog(ctx, payload, signal),

  // goals：objective 被宿主挪进了 request 里
  'goals.edit': (ctx, payload, signal) =>
    invoke(ctx, 'goals', 'edit', {
      agentId: payload.sessionId,
      ref: payload.ref,
      request: pick(payload, ['objective', 'maxGoalRounds']),
    }, signal).then((r) => (r.error ? fail(r.error) : ok(r.value))),
  'goals.pause': (ctx, payload, signal) => goalAction(ctx, 'pause', payload, signal),
  'goals.resume': (ctx, payload, signal) => goalAction(ctx, 'resume', payload, signal),
  'goals.complete': (ctx, payload, signal) => goalAction(ctx, 'complete', payload, signal),
  'goals.clear': (ctx, payload, signal) => goalAction(ctx, 'clear', payload, signal),

  // account: mobile can inspect the stored DeepSeek account and its safe profile/balances only.
  'account.getState': inv('account', 'getState', () => ({})),
  'account.getProfile': inv('account', 'getProfile', (p) => ({ client: p.client })),
  'account.getBalance': inv('account', 'getBalance', (p) => ({ client: p.client })),

  // settings / llm / credentials
  'settings.describe': inv('settings', 'describe', () => ({})),
  'settings.mutate': inv('settings', 'mutate', (p) => pick(p, ['ns', 'ops', 'expectedRevision'])),
  'llm.providers': (ctx, payload, signal) =>
    invoke(ctx, 'llm', 'listProviders', {}, signal).then((r) => {
      if (r.error) return fail(r.error);
      const list = Array.isArray(r.value) ? r.value : [];
      return ok({
        providers: list.map((item) => ({
          provider: item && item.id,
          displayName: item && (item.name || item.id),
          active: true,
        })),
      });
    }),
  'credentials.describe': inv('credentials', 'describe', (p) => ({ refs: p.refs })),
  'credentials.set': inv('credentials', 'set', (p) => ({ ref: p.ref, value: p.value })),
  'credentials.unset': inv('credentials', 'unset', (p) => ({ ref: p.ref })),
};

function goalAction(ctx, method, payload, signal) {
  return invoke(ctx, 'goals', method, { agentId: payload.sessionId, ref: payload.ref }, signal)
    .then((r) => (r.error ? fail(r.error) : ok(r.value)));
}

/**
 * 宿主只服务 native 选择器时的清单条（**不回落到网关**）。
 *
 * 这里的 code/message 与宿主 browse 后端那条路完全同名同形：本地实现的
 * `directory-unreadable` 等翻成 `directory-picker/unreadable` 这一组 wire 码，App 侧的
 * `formatDirectoryError` 已经按它们写好了文案，两条路对客户端应当不可区分。
 */
async function localListDirectory(ctx, payload, signal) {
  const path = payload && typeof payload.path === 'string' && payload.path.trim() ? payload.path.trim() : undefined;
  try {
    return ok(await listDirectory(path, { signal }));
  } catch (error) {
    warn(ctx, `宿主选择器不是 browse，listDirectory 走插件自带实现：${error && error.message}`);
    return fail(wireError(error));
  }
}

/** 宿主只服务 native 选择器时的建目录条；回创建出来的 path，与网关那条同形状。 */
async function localCreateDirectory(ctx, payload, signal) {
  try {
    return ok({ path: await createDirectory(payload.path, payload.name) });
  } catch (error) {
    warn(ctx, `宿主选择器不是 browse，createDirectory 走插件自带实现：${error && error.message}`);
    return fail(wireError(error));
  }
}

module.exports = { ENDPOINTS, goalAction, localCreateDirectory, localListDirectory };

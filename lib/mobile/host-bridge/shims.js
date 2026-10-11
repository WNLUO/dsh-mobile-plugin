'use strict';
/** 没有 1:1 端点、需要跨端点合成或翻译的几处（翻页游标、模型目录、跟随流、投影基线）。 */

const { invoke, invokeEnvelope, ok, fail, pick, warn, deadline, openStream, SYNTHETIC_DEADLINE_MS } = require('./transport.js');

// ── bespoke：没有 1:1 端点、需要合成或翻译的几处 ──────────────────────────

/**
 * `session.history` → `session/page`。
 *
 * 宿主的 page 请求体多了个必填的 throughSeq（“读到哪一条为止”），没有默认值，必须
 * 先知道会话当前游标 —— follow 流首帧的 snapshot.cursor 就是它。所以这里开一条
 * follow 拿游标（读完首帧立刻 break，网关会取消这条流），再翻一页历史。
 * 返回值把 records 拆回旧形状的 events（history-derive.js 只认 events/hasMore）。
 */
async function historyViaPage(ctx, payload, signal) {
  const sessionId = payload && payload.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return fail({ code: 'bad-request', message: '缺少 sessionId' }, 'bad-request');
  let throughSeq = -1;
  try {
    const frames = await openStream(ctx, 'session', 'follow', {
      request: { address: { kind: 'session', sessionId }, maxMessages: 1 },
    }, deadline(signal, SYNTHETIC_DEADLINE_MS));
    for await (const frame of frames) {
      if (frame && frame.type === 'snapshot' && Number.isSafeInteger(frame.cursor)) {
        throughSeq = frame.cursor;
        break;
      }
    }
  } catch (error) {
    return fail(error);
  }
  const request = {
    address: { kind: 'session', sessionId },
    throughSeq,
    ...pick(payload, ['maxMessages', 'beforeSeq', 'turnWindow']),
  };
  const result = await invoke(ctx, 'session', 'page', { request }, signal);
  if (result.error) return fail(result.error);
  const page = result.value && typeof result.value === 'object' ? result.value : {};
  const records = Array.isArray(page.records) ? page.records : [];
  return ok({
    events: records.map((record) => (record && record.type === 'event' ? record.event : record)).filter(Boolean),
    hasMore: page.hasMore === true,
    cursor: throughSeq,
  });
}

/**
 * `session.models` → `session.modelCatalog`。
 *
 * 宿主改成全局目录了（args 为空），字段也换了名：default → current、
 * routableProviders 变成「能不能用这个 provider」。移动端要的 groups 结构两边一致，
 * 原样带过去即可。
 */
async function modelCatalog(ctx, signal) {
  const result = await invoke(ctx, 'session', 'modelCatalog', {}, signal);
  if (result.error) return fail(result.error);
  const catalog = result.value && typeof result.value === 'object' ? result.value : {};
  const current = catalog.default && typeof catalog.default === 'object'
    ? pick(catalog.default, ['provider', 'model', 'reasoningEffort'])
    : null;
  const routable = Array.isArray(catalog.routableProviders) ? catalog.routableProviders : [];
  return ok({
    ...(current ? { current } : {}),
    routable: Boolean(current && routable.includes(current.provider)),
    groups: Array.isArray(catalog.groups) ? catalog.groups : [],
  });
}

/**
 * `workspace.list` → `workspace.follow` 的首帧 baseline。
 *
 * 0.2.0 的 workspace 只有 follow（流），没有一次性 list；但它的 baseline 值恰好就是
 * 旧 list 的返回体（items + archivedSessionIds + pinnedSessionIds），所以取首帧即可。
 */
async function workspaceListViaFollow(ctx, signal) {
  try {
    const frames = await openStream(ctx, 'workspace', 'follow', {}, deadline(signal, SYNTHETIC_DEADLINE_MS));
    for await (const frame of frames) {
      if (frame && frame.type === 'baseline' && frame.value) return ok(frame.value);
    }
  } catch (error) {
    return fail(error);
  }
  // 流「正常结束却没吐 baseline」不是「你没有工作区」，而是没取到。原先这里返回
  // ok({ items: [] })，与真成功在下游完全无法区分：宿主正在初始化 / 正忙 / 网关给了
  // 空流时都会走到这里，于是 { ok: true, items: [] } 一路畅通地通过 lib/index.js 的
  // 镜像守卫、被当作权威清单推给中转，手机侧表现为工作区整行消失、会话全塌进
  // 「未分组」，且中转只会附一个 App 根本不看的 stale 标记，不会有任何报错。
  // 拿不到就是拿不到，如实走错误通道，让调用方去重试或保留上一次结果。
  warn(
    ctx,
    'workspace.follow 流结束前没有给出 baseline 帧，无法确定工作区清单（宿主可能仍在初始化或正忙），' +
      '本次按失败处理而不是谎报空列表',
  );
  return fail({
    code: 'host-workspace-baseline-missing',
    message: 'workspace.follow 流结束前没有给出 baseline 帧，无法确定工作区列表',
  }, 'host-call-failed');
}

/** 会话摘要内联投影 `session.list items[].projections.values`（没有就是空对象）。 */
function projectionValues(item) {
  const projections = item && typeof item === 'object' ? item.projections : null;
  const values = projections && typeof projections === 'object' ? projections.values : null;
  return values && typeof values === 'object' ? values : {};
}

/**
 * 子代理目录的投影基线预算，比通用合成流（SYNTHETIC_DEADLINE_MS）更紧。
 *
 * 手机端一次请求的总预算只有 8 秒（app/src/api.ts 的 REQUEST_TIMEOUT_MS），走中转还要
 * 多一个 RTT。基线开不出来并不致命 —— session.list 摘要内联的是同一份 values，退回它
 * 就行，所以宁可慢的时候少等几秒，也别把整次 subagents.list 拖成客户端超时。
 */
const SUBAGENT_BASELINE_DEADLINE_MS = 3000;

/**
 * 开一条 session.control 只读它的首帧 baseline，取回全设备投影快照
 * `{ [sessionId]: values }`，读完立刻 break（网关随之取消这条流），
 * 与 workspaceListViaFollow 同一手法。
 *
 * 开不成流不算致命：调用方还能退回 session.list 摘要内联的投影，所以这里吞掉异常返回
 * 空表，而不是把整次调用判失败。
 */
async function projectionBaseline(ctx, signal) {
  // 这里只读首帧 baseline，读完就 break，所以不需要 event-synthesis.js 那份逐帧累积器
  // （依赖方向也不允许 shims 反过来 require 它），直接取首帧的 projections 即可。
  let projections = null;
  try {
    const frames = await openStream(ctx, 'session', 'control', {}, deadline(signal, SUBAGENT_BASELINE_DEADLINE_MS));
    for await (const frame of frames) {
      if (frame && frame.type === 'baseline') {
        projections = frame.value && typeof frame.value === 'object' ? frame.value.projections : null;
        break;
      }
    }
  } catch (error) {
    warn(ctx, `子代理目录：session/control 基线不可用（${error && error.message ? error.message : String(error)}），改用会话列表内联投影`);
  }
  const out = new Map();
  if (projections && typeof projections === 'object') {
    for (const [sessionId, entry] of Object.entries(projections)) {
      out.set(sessionId, entry && entry.values && typeof entry.values === 'object' ? entry.values : {});
    }
  }
  return out;
}

/**
 * `subagents.list` → `session.control` 投影基线 + `session.list`。
 *
 * 0.2.0 撤掉了 subagent.list 这个 RPC，但目录数据一条没少：它变成了会话投影里的
 * `subagentCatalog` 键，桌面端 @deepseek-ai/dsh-client-ui-subagent 的 CatalogDropdown
 * 就是读 `state.projectionsBySession` 渲染的。投影基线一次给出**全部**会话的 values，
 * 父子两层的目录在同一帧里 —— hasChildren 因此不需要按子会话再发 N 次投影查询。
 *
 * 投影里没有的是运行时状态：跑没在跑、父会话在不在线。桌面端也是拿 sessions.list 的
 * summaries 合成 activity 的，这里同口径再取一次会话列表，两边判定完全一致。
 */
async function subagentCatalog(ctx, payload, signal) {
  const parentSessionId = payload && payload.parentSessionId;
  if (typeof parentSessionId !== 'string' || !parentSessionId) {
    return fail({ code: 'bad-request', message: '缺少 parentSessionId' });
  }
  const list = await invoke(ctx, 'session', 'list', { _request: {} }, signal);
  if (list.error) return fail(list.error);
  const items = list.value && Array.isArray(list.value.items) ? list.value.items : [];
  const byId = new Map();
  for (const item of items) {
    if (item && typeof item.sessionId === 'string' && item.sessionId) byId.set(item.sessionId, item);
  }
  // 桌面端 ClientSessions.agentAvailable() 的口径：在会话列表里找父会话，读它的
  // agentAvailable；列表已就绪还找不到就是 false（它那个 undefined 是「列表还没读完」，
  // 这里 list 是刚 await 回来的，早就就绪了）。
  //
  // 这一条是整套里唯一没法离线证实的口径，所以留一级退路：宿主万一不填
  // agentAvailable（schema 里有，但没实证它一定被赋值），就退成「父会话还在列表里 =
  // 还在这台宿主上」。宁可偶尔多给一个输入框，也不要整片目录一律只读 —— 后者用户
  // 点进去发现子代理明明能续话却打不了字，比误判严重得多。
  const parent = byId.get(parentSessionId);
  const parentAvailable = !parent
    ? false
    : typeof parent.agentAvailable === 'boolean' ? parent.agentAvailable : true;

  const baseline = await projectionBaseline(ctx, signal);
  // 基线优先：它是桌面端渲染目录的同一份数据。基线里没有这个会话、或者它的
  // subagentCatalog 还没算出来，就退回列表摘要内联的那份投影；两处都没有就当
  // 它没有派出过子代理。
  const catalogOf = (sessionId) => {
    const fromBaseline = baseline.get(sessionId);
    if (fromBaseline && Array.isArray(fromBaseline.subagentCatalog)) return fromBaseline.subagentCatalog;
    const inline = projectionValues(byId.get(sessionId));
    return Array.isArray(inline.subagentCatalog) ? inline.subagentCatalog : [];
  };

  const entries = [];
  for (const item of catalogOf(parentSessionId)) {
    if (!item || typeof item.id !== 'string' || !item.id) continue;
    if (item.mode !== 'one-shot' && item.mode !== 'continuable' && item.mode !== 'unknown') continue;
    const child = byId.get(item.id);
    entries.push({
      kind: 'child',
      id: item.id,
      mode: item.mode,
      activity: child && child.running === true ? 'running' : 'inactive',
      // 子会话不在列表里（已归档/已删）时保守报 false：手机端契约只有布尔值，
      // 桌面端 isKnownLeaf 那种「目录未加载先留个展开箭头」的三态没法表达，
      // 而且假箭头点开是空面板，比不显示更糟。
      hasChildren: catalogOf(item.id).length > 0,
      ...(typeof item.label === 'string' && item.label ? { label: item.label } : {}),
    });
  }
  return ok({ entries, parentAvailable });
}

module.exports = { historyViaPage, modelCatalog, workspaceListViaFollow, projectionBaseline, subagentCatalog };

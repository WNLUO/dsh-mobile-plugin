// 工作区快照读取已激活的宿主登记服务，缺服务时才取 Remote 跟随流。
// 子代理目录保留 rc.5 名字与关系，根可用性由已验证的 catalog 创建链决定。
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
/**
 * 这次 history 要读的是「谁」的地址。
 *
 * 普通会话是 `{kind:'session'}`；子会话必须换成**带父会话的 durable 地址**
 * `{kind:'subagent'}` —— 宿主对 `origin === 'subagent'` 的会话拿普通地址一律回
 * agent-busy（见 dsh-api-session-controller 的 validateAddress），这跟续话那条
 * 是同一个门。`mode` 也要带：宿主会拿它跟子会话自己的 descriptor 对一遍。
 */
function historyAddress(payload) {
  const sessionId = payload && payload.sessionId;
  const parentSessionId = payload && payload.parentSessionId;
  if (typeof parentSessionId === 'string' && parentSessionId) {
    const mode = (payload && payload.mode) || 'continuable';
    if (mode === 'external') return null;
    return { kind: 'subagent', parentSessionId, childSessionId: sessionId, mode };
  }
  return { kind: 'session', sessionId };
}

async function historyViaPage(ctx, payload, signal) {
  const sessionId = payload && payload.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return fail({ code: 'bad-request', message: '缺少 sessionId' }, 'bad-request');
  const address = historyAddress(payload);
  if (!address) return fail({ code: 'subagent/not-resumable', message: '外部执行没有本地子会话历史' });
  let throughSeq = -1;
  try {
    const frames = await openStream(ctx, 'session', 'follow', {
      request: { address, maxMessages: 1 },
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
    address,
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
 * `session.models` → `session.modelCatalog` + 会话自己的 `session/projections`。
 *
 * 宿主改成全局目录了（args 为空），字段也换了名：default → current；移动端要的 groups 结构
 * 两边一致，原样带过去即可。
 *
 * `default` 是全局默认，不是「这个会话实际用的模型」。会话自己的模型记在
 * `session/projections` 的 `modelSelection` 投影里（`next` 是下一次请求要用，`lastUsed` 是
 * 最近一次真正跑过的）；从没选过时才回落到全局默认。读不到投影不是错误，退回全局默认即可，
 * 别让整个模型面板消失。
 *
 * `defaultModel` 单独回一份全局默认：宿主的新会话读的就是最近一次成功保存的默认值，所以
 * App 要显示「新对话会用哪个模型」只能看它，拿任何一个会话的 `current` 去顶都是猜。
 */
async function modelCatalog(ctx, payload, signal) {
  const sessionId = payload && typeof payload.sessionId === 'string' ? payload.sessionId : '';
  const [result, projection] = await Promise.all([
    invoke(ctx, 'session', 'modelCatalog', {}, signal),
    sessionId ? invoke(ctx, 'session', 'projections', { request: { sessionId } }, signal) : Promise.resolve({ error: undefined, value: undefined }),
  ]);
  if (result.error) return fail(result.error);
  const catalog = result.value && typeof result.value === 'object' ? result.value : {};
  const globalDefault = catalog.default && typeof catalog.default === 'object'
    ? pick(catalog.default, ['provider', 'model', 'reasoningEffort'])
    : null;
  // 会话自己选过模型时，用它覆盖全局默认；读不到或没选过才保留全局默认。
  const sessionModel = !projection.error && projection.value && typeof projection.value === 'object'
    ? projection.value.values && typeof projection.value.values === 'object' && projection.value.values.modelSelection
    : undefined;
  const sessionSelection = sessionModel && typeof sessionModel === 'object'
    ? (sessionModel.next && typeof sessionModel.next === 'object'
      ? pick(sessionModel.next, ['provider', 'model', 'reasoningEffort'])
      : sessionModel.lastUsed && typeof sessionModel.lastUsed === 'object'
        ? pick(sessionModel.lastUsed, ['provider', 'model', 'reasoningEffort'])
        : null)
    : null;
  const effective = sessionSelection && sessionSelection.provider && sessionSelection.model ? sessionSelection : globalDefault;
  const routableProviders = Array.isArray(catalog.routableProviders) ? catalog.routableProviders : [];
  const defaultModel = globalDefault && globalDefault.provider && globalDefault.model ? globalDefault : null;
  return ok({
    ...(effective ? { current: effective } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    routable: Boolean(effective && routableProviders.includes(effective.provider)),
    routableProviders,
    groups: Array.isArray(catalog.groups) ? catalog.groups : [],
  });
}

/**
 * `workspace.list` 读取 Host 的完整工作区投影，缺登记服务时取 `workspace.follow` 首帧。
 *
 * `ctx.get` 默认只返回已激活的服务，登记服务完成持久化加载与历史引导后才可读。
 * 字段与宿主 WorkspaceFeed.baseline / workspaceView 一致，不依赖另行挂载的 Remote controller。
 */
async function workspaceListViaFollow(ctx, signal) {
  try {
    if (signal) signal.throwIfAborted();
    const registry = ctx.get && ctx.get('workspaceRegistry');
    if (registry) {
      return ok({
        items: registry.list().map(workspace => ({
          workspaceId: workspace.id,
          path: workspace.path,
          title: workspace.title,
          sessionIds: [...workspace.sessionIds],
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
        })),
        archivedSessionIds: [...registry.archivedSessionIds],
        pinnedSessionIds: Array.isArray(registry.pinnedSessionIds) ? [...registry.pinnedSessionIds] : [],
      });
    }
    const frames = await openStream(ctx, 'workspace', 'follow', {}, deadline(signal, SYNTHETIC_DEADLINE_MS));
    for await (const frame of frames) {
      if (frame && frame.type === 'baseline' && frame.value) return ok(frame.value);
    }
  } catch (error) {
    return fail(error);
  }
  // 流「正常结束却没吐 baseline」不是「你没有工作区」，而是没取到。原先这里返回
  // ok({ items: [] })，与真成功在下游完全无法区分：宿主正在初始化 / 正忙 / 网关给了
  // 空流时都会走到这里，于是 { ok: true, items: [] } 一路畅通地通过 lib/mirror/pusher.cjs 的
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
 * 手机端一次请求的总预算只有 8 秒（app/src/api/core.ts 的 REQUEST_TIMEOUT_MS），走中转还要
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
 * 0.2.0 撤掉了 subagent.list，但目录数据没少：它变成会话投影里的 `subagentCatalog` 键。
 * 投影基线一次给出全部会话的 values，父子两层的目录在同一帧里，hasChildren 不需要再按子
 * 会话逐个查。
 *
 * 投影里没有运行时状态（跑没在跑、父会话在不在线），所以同口径再取一次会话列表的 summaries。
 * 两发互不依赖，并发出去（见下面的注释），别改回串行。
 */
async function subagentCatalog(ctx, payload, signal) {
  const parentSessionId = payload && payload.parentSessionId;
  if (typeof parentSessionId !== 'string' || !parentSessionId) {
    return fail({ code: 'bad-request', message: '缺少 parentSessionId' });
  }
  // **两发并发，不排队**：这两条互不依赖（list 给 summaries，基线给投影），串起来等于把
  // 手机输入区那条最贵的请求乘二。真机记录里这条目录整发 2664ms，而同一时刻 App 自己在问
  // 会话列表 —— 两次全量扫描日志的样子，就是这里先 list 再开流叠出来的。
  //
  // 基线自己吞异常、自带 3 秒截止，所以它跑在前面也不怕：list 失败照样走下面那条 fail。
  const [list, baseline] = await Promise.all([
    invoke(ctx, 'session', 'list', { _request: {} }, signal),
    projectionBaseline(ctx, signal),
  ]);
  if (list.error) return fail(list.error);
  const items = list.value && Array.isArray(list.value.items) ? list.value.items : [];
  const byId = new Map();
  for (const item of items) {
    if (item && typeof item.sessionId === 'string' && item.sessionId) byId.set(item.sessionId, item);
  }
  // 基线优先：它是桌面端渲染目录的同一份数据。基线里没有这个会话、或者它的
  // subagentCatalog 还没算出来，就退回列表摘要内联的那份投影；两处都没有就当
  // 它没有派出过子代理。
  const catalogOf = (sessionId) => {
    const fromBaseline = baseline.get(sessionId);
    if (fromBaseline && Array.isArray(fromBaseline.subagentCatalog)) return fromBaseline.subagentCatalog;
    const inline = projectionValues(byId.get(sessionId));
    return Array.isArray(inline.subagentCatalog) ? inline.subagentCatalog : [];
  };

  // 由父级 catalog 的创建边追溯根；只有 summary 的父指针而无 catalog 证明时保持未知。
  const creators = new Map();
  for (const id of new Set([...byId.keys(), ...baseline.keys()])) {
    for (const entry of catalogOf(id)) {
      if (!entry || typeof entry.id !== 'string' || !['continuable', 'one-shot', 'unknown', 'external'].includes(entry.mode)) continue;
      const previous = creators.get(entry.id);
      creators.set(entry.id, previous && previous.parentId !== id ? { conflict: true } : { parentId: id, entry });
    }
  }
  const ancestry = [];
  const seen = new Set();
  let rootSessionId = parentSessionId;
  let verified = true;
  while (creators.has(rootSessionId) && !seen.has(rootSessionId)) {
    seen.add(rootSessionId);
    const edge = creators.get(rootSessionId);
    if (edge.conflict || edge.entry.mode === 'external') { verified = false; break; }
    ancestry.unshift(edge.entry.name);
    rootSessionId = edge.parentId;
  }
  const root = byId.get(rootSessionId);
  if (seen.has(rootSessionId) || !root || root.origin === 'subagent') verified = false;
  const rootAvailable = verified && typeof root.agentAvailable === 'boolean' ? root.agentAvailable : null;
  const parentPath = ancestry.every(name => typeof name === 'string' && name) ? ancestry.join('/') : undefined;
  const entries = [];
  for (const item of catalogOf(parentSessionId)) {
    if (!item || typeof item.id !== 'string' || !item.id) continue;
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : undefined;
    const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : undefined;
    const path = parentPath !== undefined && name ? [parentPath, name].filter(Boolean).join('/') : undefined;
    const relation = { parentId: parentSessionId, parentSessionId, depth: ancestry.length + 1, ...(path ? { path } : {}) };
    if (item.kind === 'diagnostic') {
      if (['corrupt', 'unsupported', 'unavailable'].includes(item.reason)) entries.push({ kind: 'diagnostic', id: item.id, reason: item.reason, ...relation, ...(name ? { name } : {}) });
      continue;
    }
    if (!['one-shot', 'continuable', 'unknown', 'external'].includes(item.mode)) {
      entries.push({ kind: 'diagnostic', id: item.id, reason: 'unsupported', ...relation });
      continue;
    }
    const child = byId.get(item.id);
    entries.push({
      kind: 'child', id: item.id, mode: item.mode,
      activity: child && child.running === true ? 'running' : 'inactive',
      hasChildren: item.mode !== 'external' && catalogOf(item.id).length > 0,
      ...(name ? { name } : {}),
      ...(label ? { label, description: label } : {}),
      ...(typeof item.description === 'string' && item.description.trim() ? { description: item.description.trim() } : {}),
      ...relation,
      // Cold continuable targets can be resumed under the live root; target residency is not admission.
      targetAvailable: item.mode === 'continuable' ? rootAvailable : false,
    });
  }
  return ok({ entries, ...(verified ? { rootSessionId } : {}), rootAvailable, parentAvailable: rootAvailable === true });
}

module.exports = { historyViaPage, modelCatalog, workspaceListViaFollow, projectionBaseline, subagentCatalog };

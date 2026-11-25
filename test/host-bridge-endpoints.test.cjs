// 手机模型选择改走会话能力，与桌面默认保存解耦。
// rc.5 子代理 wire、根可用性与显式 follow 激活兼容用例。
'use strict';

/**
 * 端点表的**参数化金标准**：每个旧 `apiProxy` 键 → 宿主 namespace/method/args 键名。
 *
 * 为什么要有这张表：宿主 typertGateway 用 assertExactArguments 严格校验 args 的键名，
 * 键名少一个或多一个都回 `gateway/arguments-invalid`。而这类失败的杀伤力全在「不报错」
 * 上——App 侧把 400 catch 掉了，于是统计行、ContextMeter、TodoDock、GoalBar、权限档、
 * planMode **一整层**静默消失。真实事故：sessions.projections 曾少包一层 `request`，
 * /session/stats 恒 400。
 *
 * 这张表此前完全靠人肉对照宿主 descriptor，没有任何机器可校验机制。这里把它固化成
 * 断言：改端点表而不同步改这张表，就会当场红，并告诉你是哪一条。
 *
 * 新增/修改端点时，请先在宿主 app.asar 里确认 descriptor 的 wire 名，再同步更新
 * GOLDEN；不要绕过这张表。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { createApiProxy } = require('../lib/mobile/host-bridge.js');
const { ENDPOINTS, subagentPromptCapabilities } = require('../lib/mobile/host-bridge/endpoints.js');
const { muxFrames } = require('../lib/mobile/host-bridge/event-synthesis.js');

/**
 * 旧 apiProxy 键 → [宿主 namespace, 宿主 method, args 顶层键]。
 *
 * 值 `null` 表示这条端点不直接打网关：要么走合成（要开流、拿游标），要么宿主 0.2.0
 * 根本没有这个能力，如实回报不支持。
 */
const GOLDEN = {
  'sessions.list': ['session', 'list', ['_request']],  // 键名是 `_request`：宿主签名 list(_request)，下划线表示保留的空请求
  'sessions.history': null, // 合成：翻页要 follow 首帧的游标（shims.historyViaPage）
  'sessions.projections': ['session', 'projections', ['request']],  // 曾少包一层 request → 恒 400 而 App catch 掉了，统计 UI 整层静默消失
  'sessions.prompt': ['session', 'prompt', ['request']],
  'sessions.cancel': ['session', 'cancel', ['request']],
  'sessions.rename': ['session', 'rename', ['request']],
  'sessions.create': ['session', 'create', ['request']],
  'sessions.search': ['session', 'search', ['request']],
  // 2026-11-15 用户要求手机默认独立：只经公开 Agent.model 改会话，不调用会保存默认的桌面接口。
  'sessions.selectModel': null,
  'sessions.attachment': ['session', 'attachment', ['request']],
  'sessions.updateQueue': ['session', 'updateQueue', ['request']],
  'sessions.fork': ['session', 'fork', ['request']],
  'sessions.models': null, // 合成：走 session/modelCatalog 再拼回旧形状
  'llm.models': null,      // 合成：同一个 modelCatalog，不带 sessionId（宿主级模型目录）
  'agentPresets.list': ['agentPresets', 'list', []],  // descriptor 不收参数
  'agentPresets.read': ['agentPresets', 'read', ['agentPreset']],
  'agentPresets.select': ['agentPresets', 'select', ['agentId', 'agentPreset']],
  'agentPresets.copy': null, // 宿主 0.2.0 没有这个端点，如实报不支持
  'agentPresets.remove': null, // 宿主 0.2.0 没有这个端点，如实报不支持
  'workspace.list': null, // 合成：走 workspace/follow 的 baseline 流
  'workspace.create': ['workspace', 'create', ['request']],
  'workspace.rename': ['workspace', 'rename', ['request']],
  'workspace.delete': ['workspace', 'delete', ['request']],
  'workspace.archiveSession': ['workspace', 'archiveSession', ['request']],
  'workspace.unarchiveSession': ['workspace', 'unarchiveSession', ['request']],
  'workspace.pinSession': ['workspace', 'pinSession', ['request']],
  'workspace.unpinSession': ['workspace', 'unpinSession', ['request']],
  'workspace.insertBefore': ['workspace', 'insertBefore', ['request']],
  'workspace.insertSessionBefore': ['workspace', 'insertSessionBefore', ['request']],
  'host.listDirectory': ['directoryPicker', 'list', ['path']],  // 不是 host 命名空间，是宿主的 directoryPicker
  'host.createDirectory': ['directoryPicker', 'createDirectory', ['name', 'path']],
  'skills.list': ['skills', 'list', ['request']],
  'subagents.prompt': ['subagents', 'prompt', ['request']],
  // 2026-11-08：上游 0.2.1-rc.2 起 `interruptByParent(childSessionId, parentSessionId, mode)`
  // 被换成 `interruptByUser(childSessionId)`（授权挂在子会话本身），插件侧先打新接口、
  // 只有宿主没有这个方法（host-unavailable）时才退回旧接口。这张金标准钉的是**那条主路由**，
  // 所以记新接口；旧接口那条兜底在下面「打断先打新接口」的用例里单独钉。
  'subagents.interrupt': ['subagents', 'interruptByUser', ['childSessionId']],
  'subagents.list': null, // 合成：从会话投影里出目录
  'goals.edit': ['goals', 'edit', ['agentId', 'ref', 'request']],  // objective/maxGoalRounds 被宿主挪进了 request
  'goals.pause': ['goals', 'pause', ['agentId', 'ref']],
  'goals.resume': ['goals', 'resume', ['agentId', 'ref']],
  'goals.complete': ['goals', 'complete', ['agentId', 'ref']],
  'goals.clear': ['goals', 'clear', ['agentId', 'ref']],
  // 会话级「启用智能体团队协作」：宿主 `agentTeams.setEnabled(agentId, enabled, signal)`，
  // 只收根会话（子会话调它会回 TEAM_LEAD_REQUIRED）。两个参数名都按 descriptor 来。
  'agentTeams.setEnabled': ['agentTeams', 'setEnabled', ['agentId', 'enabled']],
  'settings.describe': ['settings', 'describe', []],  // descriptor 不收参数
  'settings.mutate': ['settings', 'mutate', []],  // inv 的默认包装；pick 出 ns/ops/expectedRevision 后仍由 inv 包成 {}
  'llm.providers': ['llm', 'listProviders', []],  // 宿主方法是 listProviders，不是 providers
  'account.getState': ['account', 'getState', []],
  'account.getProfile': ['account', 'getProfile', ['client']],
  'account.getBalance': ['account', 'getBalance', ['client']],
  'credentials.describe': ['credentials', 'describe', ['refs']],
  // 取一次凭据的值（一键导入要把它那把 Key 交给手机）。宿主 Service 上 resolve(ref) 与
  // describe(ref) 是分开的两个方法：describe 只回状态，resolve 才回值。
  'credentials.resolve': ['credentials', 'resolve', ['ref']],
  'credentials.set': ['credentials', 'set', ['ref', 'value']],
  'credentials.unset': ['credentials', 'unset', ['ref']],
};

/** 走合成路径或如实报不支持的端点：值是 null，理由写在金标准那几行的注释里。 */
const COMPOSED = Object.keys(GOLDEN).filter((key) => GOLDEN[key] === null);

/** 假网关：记录每次 invoke，不做任何校验（校验交给下面的金标准比对）。 */
function makeCtx() {
  const calls = [];
  const ctx = {
    calls,
    get: (key) => (key === 'typertGateway'
      ? {
          async invoke({ namespace, method, args }) {
            calls.push({ namespace, method, args });
            return { ok: true };
          },
          async stream() { return Readable.from([]); },
        }
      // 这张表钉的是「走宿主」那条路由：host.listDirectory / host.createDirectory 在宿主
      // 组合出 browse 能力时整条打网关；宿主只服务 native 时那两条会回落到插件自带的
      // browse 原语（回落本身在 directory-browse.test.cjs 里单独钉）。这里给出 browse，
      // 否则它们不会打出任何网关调用。
      : key === 'directoryPicker'
        ? { capability: () => ({ kind: 'browse' }) }
        : undefined),
    logger: { warn() {} },
  };
  return ctx;
}

/** 一份对大多数端点都够用的 payload：有 sessionId、ref、各种 id。 */
const PAYLOAD = {
  rpcId: 'mobile',
  sessionId: 'sess-1',
  agentId: 'agent-1',
  ref: 'ref-1',
  id: 'item-1',
  name: 'n',
  kind: 'k',
  path: '/tmp/x',
  content: 'c',
  messageId: 'm-1',
  value: 'v',
  key: 'k',
  settings: { a: 1 },
  enabled: true,
};

test('端点表里每一条要么落在金标准里，要么被显式标成合成/不支持', () => {
  const known = new Set([...Object.keys(GOLDEN), ...COMPOSED]);
  const unlisted = Object.keys(ENDPOINTS).filter((key) => !known.has(key));
  assert.deepEqual(unlisted, [], `这些端点既不在金标准也不在合成清单里：${unlisted.join(', ')}（请先确认宿主 descriptor 再登记）`);
});

test('金标准没有登记端点表里已删除的键（防止有人顺手删端点、忘了改这张表）', () => {
  const gone = Object.keys(GOLDEN).filter((key) => !Object.hasOwn(ENDPOINTS, key));
  assert.deepEqual(gone, [], `端点表里已经没有 ${gone.join(', ')} 了；确认是删除就把金标准里那几行一并删掉`);
});

test('每条端点打给宿主的 namespace / method / args 键名与金标准一致', async () => {
  const ctx = makeCtx();
  const api = createApiProxy(ctx);
  const mismatches = [];
  for (const [key, spec] of Object.entries(GOLDEN)) {
    if (spec === null) continue;
    const [namespace, method, argKeys] = spec;
    const dot = key.indexOf('.');
    const ns = key.slice(0, dot);
    const fn = api[ns] && api[ns][key.slice(dot + 1)];
    assert.equal(typeof fn, 'function', `${key} 没有铺到 apiProxy 上`);
    ctx.calls.length = 0;
    const envelope = await fn({ rpcId: 'mobile', payload: PAYLOAD });
    assert.ok(envelope && typeof envelope === 'object' && envelope.result, `${key} 没有回旧信封`);
    const call = ctx.calls.find((c) => c.namespace === namespace && c.method === method);
    if (!call) {
      mismatches.push(`${key}: 没有打出 ${namespace}/${method}，实际打了 ${ctx.calls.map((c) => `${c.namespace}/${c.method}`).join(', ') || '（一次都没打）'}`);
      continue;
    }
    const actual = Object.keys(call.args).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...argKeys].sort())) {
      mismatches.push(`${key}: ${namespace}/${method} 的 args 键名是 ${JSON.stringify(actual)}，金标准是 ${JSON.stringify(argKeys)}`);
    }
  }
  assert.deepEqual(mismatches, [], `端点表与金标准不一致：\n${mismatches.join('\n')}`);
});

test('session.prompt defaults an omitted mode to queue and preserves explicit modes', async () => {
  const ctx = makeCtx();
  const api = createApiProxy(ctx);
  for (const [payload, expected] of [
    [{ sessionId: 's-1', content: [{ type: 'text', text: 'hello' }] }, 'queue'],
    [{ sessionId: 's-1', mode: 'steer', content: [{ type: 'text', text: 'hello' }] }, 'steer'],
  ]) {
    ctx.calls.length = 0;
    await api.sessions.prompt({ rpcId: 'mobile', payload });
    const call = ctx.calls.find((item) => item.namespace === 'session' && item.method === 'prompt');
    assert.equal(call.args.request.mode, expected);
  }
});

test('session.attachment wraps the full image reference under request.attachment', async () => {
  // 宿主 `SessionAttachmentRequest` = `{ sessionId, attachment: ImageAttachmentRef }`，
  // attachment 必填（内含 attachmentId/mediaType/bytes/width/height）。曾经直接递
  // `{ sessionId, attachmentId }`，宿主 strict codec 挡回 `wire field "request" failed
  // boundary validation` → 400，App catch 掉后图片静默消失。
  const ctx = makeCtx();
  const api = createApiProxy(ctx);
  const ref = { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', bytes: 10, width: 2, height: 3 };
  ctx.calls.length = 0;
  await api.sessions.attachment({ rpcId: 'mobile', payload: { sessionId: 's-1', attachment: ref } });
  const call = ctx.calls.find((item) => item.namespace === 'session' && item.method === 'attachment');
  assert.equal(call.args.request.sessionId, 's-1');
  assert.deepEqual(call.args.request.attachment, ref);
  assert.equal(call.args.request.attachmentId, undefined, '编号不许留在 request 顶层');
});

test('端点表不出现 shell / 系统设置这类越界命名空间', () => {
  // 移动端 API 的边界就是这一条：宿主能力很多，但手机端只能拿到会话/消息/审批/工作区
  // 这几类。键表里多出一个 namespace 就等于悄悄扩了权限。
  const forbidden = ['shell', 'exec', 'runCommand', 'systemSettings', 'system', 'process', 'fs'];
  const hits = Object.keys(ENDPOINTS).filter((key) => forbidden.some((bad) => key.toLowerCase().startsWith(`${bad.toLowerCase()}.`)));
  assert.deepEqual(hits, [], `端点表里出现了越界命名空间：${hits.join(', ')}`);
});

test('标成 null 的端点确实没有直接打网关（要么要开流合成，要么如实报不支持）', () => {
  for (const key of COMPOSED) {
    const src = String(ENDPOINTS[key]);
    assert.ok(
      /historyViaPage|modelCatalog|selectSessionModel|workspaceListViaFollow|subagentCatalog|unsupported\(/.test(src),
      `${key} 应该是合成端点或如实报不支持，现在像是直接打了网关`,
    );
    assert.ok(!/\binvoke\s*\(/.test(src), `${key} 不该自己直接调 invoke`);
  }
});

test('DeepSeek 账号只开放状态、资料和余额读取', () => {
  assert.deepEqual(
    Object.keys(ENDPOINTS).filter((key) => key.startsWith('account.')),
    ['account.getState', 'account.getProfile', 'account.getBalance'],
  );
});

/**
 * 网关说「没注册」时，话要指向真正缺的那一格，不能一律说成宿主太老（2026-11-17）。
 *
 * 真机事故：手机拨「启用智能体团队协作」，宿主网关回的是方法不存在，插件把它译成
 * 「当前宿主版本没有提供该能力（需要 DSH 0.2.0 的 typertGateway）」。可请求正是经这个
 * 网关发出去的，网关显然在；这句话把排查方向带到版本上，而实际可能是某台机器上那个
 * 插件没加载。码必须仍是 `host-unavailable`（子代理打断的旧接口兜底认的是这个码），
 * 只有「连网关都没有」才该提版本。
 */
function gatewayThatThrows(error) {
  return {
    async invoke() { throw error; },
    async stream() { return Readable.from([]); },
  };
}

test('网关说方法没注册：仍回 host-unavailable，但点出缺的是哪个接口、不提版本', async () => {
  const failure = Object.assign(new Error('no such method'), { code: 'gateway/method-unavailable' });
  const ctx = { get: (key) => (key === 'typertGateway' ? gatewayThatThrows(failure) : undefined), logger: { warn() {} } };
  const api = createApiProxy(ctx);
  const envelope = await api.agentTeams.setEnabled({ rpcId: 'mobile', payload: { sessionId: 's-1', enabled: true } });
  const error = envelope.result.error;
  assert.equal(error.code, 'host-unavailable', '兜底判据认的仍是这个码');
  assert.match(error.message, /agentTeams\/setEnabled/, '要点出缺的是哪一格');
  assert.doesNotMatch(error.message, /版本/, '网关明明在，不许把问题说成版本');
});

test('网关说服务没装：同样点名服务，不说版本', async () => {
  const failure = Object.assign(new Error('service not available'), { code: 'gateway/service-unavailable' });
  const ctx = { get: (key) => (key === 'typertGateway' ? gatewayThatThrows(failure) : undefined), logger: { warn() {} } };
  const api = createApiProxy(ctx);
  const envelope = await api.agentTeams.setEnabled({ rpcId: 'mobile', payload: { sessionId: 's-1', enabled: true } });
  assert.equal(envelope.result.error.code, 'host-unavailable');
  assert.match(envelope.result.error.message, /agentTeams\/setEnabled/);
  assert.doesNotMatch(envelope.result.error.message, /版本/);
});

test('连网关都没有时，才说宿主没提供这个网关', async () => {
  const ctx = { get: () => undefined, logger: { warn() {} } };
  const api = createApiProxy(ctx);
  const envelope = await api.agentTeams.setEnabled({ rpcId: 'mobile', payload: { sessionId: 's-1', enabled: true } });
  assert.equal(envelope.result.error.code, 'host-unavailable');
  assert.match(envelope.result.error.message, /typertGateway/);
});

/**
 * 子代理打断的两代接口：新宿主只有 `interruptByUser(childSessionId)`，老宿主只有
 * `interruptByParent(childSessionId, parentSessionId, mode)`。
 *
 * 这条金标准只钉得住「第一发打哪个」，钉不住「老宿主能不能真的打断」——退错一步就是
 * 点「停止」看着点了、子代理还在跑，而这在手机上没有任何报错可看。所以兜底那条单独钉。
 */
function interruptCtx({ newMethodExists, newError, legacyExists, legacyError }) {
  const calls = [];
  /** 网关的失败是**抛**出来的（`invoke` 接的是 reject），不是回一个 error 字段。 */
  const thrown = (error) => {
    const failure = new Error(error.message || error.code);
    failure.code = error.code;
    return failure;
  };
  const ctx = {
    calls,
    get: (key) => (key === 'typertGateway'
      ? {
          async invoke({ namespace, method, args }) {
            calls.push({ namespace, method, args });
            // 「这个方法不存在」在网关那侧是 method-unavailable，`errorOf` 会把它收敛成
            // host-unavailable —— 兜底判据认的正是收敛后的那个码。
            const missing = { code: 'gateway/method-unavailable', message: 'no such method' };
            if (method === 'interruptByUser') {
              if (!newMethodExists) throw thrown(missing);
              if (newError) throw thrown(newError);
              return { interrupted: true };
            }
            if (!legacyExists) throw thrown(missing);
            if (legacyError) throw thrown(legacyError);
            return { interrupted: true };
          },
          async stream() { return Readable.from([]); },
        }
      : undefined),
    logger: { warn() {} },
  };
  return ctx;
}

const INTERRUPT_PAYLOAD = {
  rpcId: 'mobile',
  parentSessionId: 'parent-1',
  childSessionId: 'child-1',
  mode: 'continuable',
};

test('打断在新宿主上只打 interruptByUser，且只带 childSessionId', async () => {
  const ctx = interruptCtx({ newMethodExists: true });
  const api = createApiProxy(ctx);
  const envelope = await api.subagents.interrupt({ rpcId: 'mobile', payload: INTERRUPT_PAYLOAD });
  assert.deepEqual(ctx.calls.map((c) => `${c.namespace}/${c.method}`), ['subagents/interruptByUser']);
  assert.deepEqual(Object.keys(ctx.calls[0].args), ['childSessionId']);
  assert.equal(ctx.calls[0].args.childSessionId, 'child-1');
  assert.ok(!envelope.result.error, '新宿主上打断应该直接成功');
});

test('打断在老宿主上退回 interruptByParent（带齐三个键）', async () => {
  const ctx = interruptCtx({ newMethodExists: false, legacyExists: true });
  const api = createApiProxy(ctx);
  const envelope = await api.subagents.interrupt({ rpcId: 'mobile', payload: INTERRUPT_PAYLOAD });
  assert.deepEqual(
    ctx.calls.map((c) => `${c.namespace}/${c.method}`),
    ['subagents/interruptByUser', 'subagents/interruptByParent'],
  );
  assert.deepEqual(Object.keys(ctx.calls[1].args).sort(), ['childSessionId', 'mode', 'parentSessionId']);
  assert.equal(ctx.calls[1].args.mode, 'continuable');
  assert.ok(!envelope.result.error, '老宿主上退回旧接口也应该成功');
});

test('打断在新接口存在但真失败时不退回旧接口（否则会盖掉真实错误）', async () => {
  const ctx = interruptCtx({ newMethodExists: true, newError: { code: 'gateway/internal', message: 'boom' } });
  const api = createApiProxy(ctx);
  const envelope = await api.subagents.interrupt({ rpcId: 'mobile', payload: INTERRUPT_PAYLOAD });
  assert.deepEqual(ctx.calls.map((c) => `${c.namespace}/${c.method}`), ['subagents/interruptByUser']);
  assert.equal(envelope.result.error.code, 'gateway/internal', '新接口的真实错误要原样透出');
});

test('两个打断接口都不存在时，报的是「宿主没有打断能力」而不是静默成功', async () => {
  const ctx = interruptCtx({ newMethodExists: false, legacyExists: false });
  const api = createApiProxy(ctx);
  const envelope = await api.subagents.interrupt({ rpcId: 'mobile', payload: INTERRUPT_PAYLOAD });
  assert.equal(envelope.result.error.code, 'host-unavailable');
  assert.match(envelope.result.error.message, /打断接口/);
});

/**
 * 子代理目录的两发必须并发，不许排队（2026-11-12）。
 *
 * 2026-11-12 的真机记录里这一发 2664ms：`subagents.list` 先 `session.list` 扫一遍全部
 * 会话日志、再开 `session.control` 读投影基线，两段串起来；而同一时刻 App 自己也在问
 * 会话列表，等于把最贵的那次扫描跑了两遍。这两条互不依赖，`Promise.all` 发出去就行 ——
 * 但「并发」这件事改回串行不会红任何功能用例（结果一模一样，只是慢一倍），所以单独钉。
 *
 * 判据是顺序而不是耗时：list 这一发**在流开出来之前不许返回**。串行写法下它永远等不到
 * 流，于是只能由超时兜底成失败。
 */
test('子代理目录：会话列表与投影基线并发出去，不排队', async () => {
  let streamStarted = false;
  let resolveList = null;
  const calls = [];
  const gateway = {
    invoke({ namespace, method }) {
      calls.push(`${namespace}/${method}`);
      if (namespace === 'session' && method === 'list') {
        return new Promise((resolve, reject) => {
          resolveList = () => resolve({ items: [{ sessionId: 'parent-1', agentAvailable: true }] });
          const timer = setTimeout(() => {
            reject(new Error(`session/list 等了 300ms 还没等到 session/control 开流：这两发被写成串行了（开流前 streamStarted=${streamStarted}）`));
          }, 300);
          resolveList = ((inner) => () => { clearTimeout(timer); inner(); })(resolveList);
        });
      }
      return Promise.reject(new Error(`未预期的端点 ${namespace}/${method}`));
    },
    async stream({ method }) {
      calls.push(`session/${method}`);
      streamStarted = true;
      // 流一开就让 list 那一发放行：并发的写法下此刻它正挂在 Promise.all 里等着。
      if (resolveList) resolveList();
      return require('node:stream').Readable.from([{ type: 'baseline', value: { projections: { 'parent-1': { values: { subagentCatalog: [{ id: 'child-1', mode: 'continuable' }] } } } } }]);
    },
  };
  const ctx = {
    get: (key) => (key === 'typertGateway' ? gateway : undefined),
    logger: { warn() {} },
  };
  const api = createApiProxy(ctx);
  const envelope = await api.subagents.list({ rpcId: 'mobile', payload: { parentSessionId: 'parent-1' } });

  assert.equal(envelope.result.ok, true, `目录请求应当成功：${JSON.stringify(envelope.result)}`);
  assert.deepEqual(envelope.result.value.entries.map((e) => e.id), ['child-1']);
  assert.deepEqual(calls, ['session/list', 'session/control'], '两发的顺序固定：list 先发、基线随后；关键在它们同时在路上');
  assert.equal(streamStarted, true, '必须真的去开了投影基线那条流');
});

function promptDescriptorCtx(generation = 'modern', invokeImpl) {
  const calls = [];
  const parse = value => {
    if (generation === 'legacy') {
      if (!value.parentSessionId || value.mode !== 'continuable') throw new Error('parentSessionId required');
      return { ...value };
    }
    assert.ok(value.requestId && value.childSessionId);
    assert.ok(value.delivery === 'queue' || value.delivery === 'steer');
    assert.ok(Array.isArray(value.content));
    return { ...value };
  };
  return {
    calls,
    typert: generation === 'unknown' ? undefined : { local: { get: endpoint => endpoint === 'subagents/prompt' ? { parameters: [{ wire: 'request', codec: { mode: 'strict', create: () => ({ parse }) } }] } : undefined } },
    get: key => key === 'typertGateway' ? { invoke: async call => { calls.push(call); return invokeImpl ? invokeImpl(call) : { messageId: 'm-1' }; } } : undefined,
    logger: { warn() {} },
  };
}

test('子代理 prompt：strict codec 确认新版 child-only、Queue/Steer 和图片批次', async () => {
  const ctx = promptDescriptorCtx();
  assert.deepEqual(subagentPromptCapabilities(ctx), { images: true, delivery: true, queue: true, steer: true });
  const content = [{ type: 'text', text: '看图' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }];
  const response = await createApiProxy(ctx).subagents.prompt({ payload: { parentSessionId: 'p', childSessionId: 'c', mode: 'continuable', requestId: 'r-1', delivery: 'steer', content, clientTimeZone: 'Asia/Shanghai' } });
  assert.equal(response.result.ok, true);
  assert.deepEqual(ctx.calls[0].args, { request: { requestId: 'r-1', childSessionId: 'c', delivery: 'steer', content, clientTimeZone: 'Asia/Shanghai' } });
});

test('子代理 prompt：旧 descriptor 使用旧形状，图片和 Steer 不静默降为文本 Queue', async () => {
  const ctx = promptDescriptorCtx('legacy');
  assert.deepEqual(subagentPromptCapabilities(ctx), { images: false, delivery: false, queue: true, steer: false });
  const api = createApiProxy(ctx);
  const base = { parentSessionId: 'p', childSessionId: 'c', requestId: 'r', content: [{ type: 'text', text: 'old' }] };
  assert.equal((await api.subagents.prompt({ payload: base })).result.ok, true);
  assert.equal(ctx.calls[0].args.request.parentSessionId, 'p');
  assert.equal(ctx.calls[0].args.request.mode, 'continuable');
  assert.equal((await api.subagents.prompt({ payload: { ...base, delivery: 'steer' } })).result.error.code, 'subagent-prompt-unsupported');
  assert.equal((await api.subagents.prompt({ payload: { ...base, content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] } })).result.error.code, 'subagent-prompt-unsupported');
  assert.equal(ctx.calls.length, 1);
  assert.deepEqual(subagentPromptCapabilities(promptDescriptorCtx('unknown')), { images: null, delivery: null, queue: true, steer: null });
});

function catalogCtx(items, projections) {
  return { get: key => key === 'typertGateway' ? {
    invoke: async () => ({ items }),
    stream: async () => Readable.from([{ type: 'baseline', value: { projections: Object.fromEntries(Object.entries(projections).map(([id, values]) => [id, { values }])) } }]),
  } : undefined, logger: { warn() {} } };
}

test('子代理目录：直接父离线但真实根在线，冷目标仍可继续且名字路径完整', async () => {
  const ctx = catalogCtx([
    { sessionId: 'root', agentAvailable: true },
    { sessionId: 'parent', origin: 'subagent', parentSessionId: 'root', agentAvailable: false },
  ], {
    root: { subagentCatalog: [{ id: 'parent', name: 'reviewer', label: '审阅', mode: 'continuable' }] },
    parent: { subagentCatalog: [{ id: 'cold', name: 'checker', label: '检查', mode: 'continuable' }, { id: 'ext', name: 'outside', mode: 'external' }, { id: 'diag', kind: 'diagnostic', reason: 'corrupt' }] },
  });
  const { value } = (await createApiProxy(ctx).subagents.list({ payload: { parentSessionId: 'parent' } })).result;
  assert.equal(value.rootSessionId, 'root');
  assert.equal(value.rootAvailable, true);
  assert.equal(value.parentAvailable, true);
  assert.deepEqual(value.entries[0], { kind: 'child', id: 'cold', mode: 'continuable', activity: 'inactive', hasChildren: false, name: 'checker', label: '检查', description: '检查', parentId: 'parent', parentSessionId: 'parent', depth: 2, path: 'reviewer/checker', targetAvailable: true });
  assert.equal(value.entries[1].mode, 'external');
  assert.equal(value.entries[1].targetAvailable, false);
  assert.equal(value.entries[1].hasChildren, false);
  assert.equal(value.entries[2].reason, 'corrupt');
});

test('子代理目录：根离线与关系无法证明分别回 false 和 null', async () => {
  for (const [items, expected] of [[[{ sessionId: 'p', agentAvailable: false }], false], [[{ sessionId: 'p', origin: 'subagent', agentAvailable: true }], null]]) {
    const ctx = catalogCtx(items, { p: { subagentCatalog: [{ id: 'c', name: 'child', mode: 'continuable' }] } });
    const { value } = (await createApiProxy(ctx).subagents.list({ payload: { parentSessionId: 'p' } })).result;
    assert.equal(value.rootAvailable, expected);
    assert.equal(value.entries[0].targetAvailable, expected);
    assert.equal(value.parentAvailable, false);
  }
});

test('follow：只有明确 activate:true 的普通活跃订阅才恢复 Agent，历史读游标不激活', async () => {
  for (const activate of [undefined, false, true]) {
    const calls = [];
    const ctx = { get: key => key === 'typertGateway' ? { stream: async call => { calls.push(call); return Readable.from([]); } } : undefined };
    for await (const _ of muxFrames(ctx, { payload: { sessionId: 's', ...(activate === undefined ? {} : { activate }) } })) {}
    assert.equal(calls.find(call => call.method === 'follow').args.request.activate, activate === true ? true : undefined);
  }
  const calls = [];
  const ctx = { get: key => key === 'typertGateway' ? {
    stream: async call => { calls.push(call); return Readable.from([{ type: 'snapshot', cursor: 4 }]); },
    invoke: async () => ({ records: [], hasMore: false }),
  } : undefined };
  await createApiProxy(ctx).sessions.history({ payload: { sessionId: 's', activate: true } });
  assert.equal(calls[0].args.request.activate, undefined);
});

test('external：没有本地 Session，不会打开历史与 follow 流', async () => {
  const calls = [];
  const ctx = { get: key => key === 'typertGateway' ? { stream: async call => { calls.push(call); return Readable.from([]); } } : undefined };
  const result = await createApiProxy(ctx).sessions.history({ payload: { sessionId: 'external', parentSessionId: 'p', mode: 'external' } });
  assert.equal(result.result.error.code, 'subagent/not-resumable');
  await assert.rejects(async () => { for await (const _ of muxFrames(ctx, { payload: { sessionId: 'external', parentSessionId: 'p', mode: 'external' } })) {} }, { code: 'subagent/not-resumable' });
  assert.deepEqual(calls, []);
});

function mutatedBridge(fileName, before, after) {
  const fs = require('node:fs');
  const path = require('node:path');
  const Module = require('node:module');
  const file = require.resolve(`../lib/mobile/host-bridge/${fileName}`);
  const source = fs.readFileSync(file, 'utf8');
  const changed = source.replace(before, after);
  assert.notEqual(changed, source, '变异必须命中真实实现');
  const instance = new Module(file, module);
  instance.filename = file;
  instance.paths = Module._nodeModulePaths(path.dirname(file));
  instance._compile(changed, file);
  return instance.exports;
}

test('变异证明：把 target 改成依赖驻留会被冷目标断言抓住', async () => {
  const broken = mutatedBridge('shims.js', "targetAvailable: item.mode === 'continuable' ? rootAvailable : false", "targetAvailable: item.mode === 'continuable' && child && child.agentAvailable === true ? rootAvailable : false");
  const ctx = catalogCtx([{ sessionId: 'root', agentAvailable: true }], { root: { subagentCatalog: [{ id: 'cold', mode: 'continuable' }] } });
  const output = await broken.subagentCatalog(ctx, { parentSessionId: 'root' });
  assert.throws(() => assert.equal(output.result.value.entries[0].targetAvailable, true));
});

test('变异证明：去掉能力门禁会让旧宿主 Steer 错发', async () => {
  const broken = mutatedBridge('endpoints.js', "(request.delivery === 'steer' && caps.steer !== true)", 'false');
  const ctx = promptDescriptorCtx('legacy');
  const output = await broken.ENDPOINTS['subagents.prompt'](ctx, { childSessionId: 'c', parentSessionId: 'p', content: [{ type: 'text', text: 'x' }], delivery: 'steer' });
  assert.throws(() => assert.equal(output.result.error?.code, 'subagent-prompt-unsupported'));
  assert.equal(ctx.calls.length, 1);
});

test('变异证明：移除显式 activate 条件会被被动流断言抓住', async () => {
  const broken = mutatedBridge('event-synthesis.js', "payload && payload.activate === true && address.kind === 'session'", "address.kind === 'session'");
  const calls = [];
  const ctx = { get: key => key === 'typertGateway' ? { stream: async call => { calls.push(call); return Readable.from([]); } } : undefined };
  for await (const _ of broken.muxFrames(ctx, { payload: { sessionId: 's' } })) {}
  assert.throws(() => assert.equal(calls.find(call => call.method === 'follow').args.request.activate, undefined));
});

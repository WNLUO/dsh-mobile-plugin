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
const { ENDPOINTS } = require('../lib/mobile/host-bridge/endpoints.js');

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
  'sessions.selectModel': ['session', 'selectModel', ['request']],
  'sessions.attachment': ['session', 'attachment', ['request']],
  'sessions.updateQueue': ['session', 'updateQueue', ['request']],
  'sessions.fork': ['session', 'fork', ['request']],
  'sessions.models': null, // 合成：走 session/modelCatalog 再拼回旧形状
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
  'workspace.insertSessionBefore': ['workspace', 'insertSessionBefore', ['request']],
  'host.listDirectory': ['directoryPicker', 'list', ['path']],  // 不是 host 命名空间，是宿主的 directoryPicker
  'host.createDirectory': ['directoryPicker', 'createDirectory', ['name', 'path']],
  'skills.list': ['skills', 'list', ['request']],
  'subagents.prompt': ['subagents', 'prompt', ['request']],
  'subagents.interrupt': ['subagents', 'interruptByParent', ['childSessionId', 'mode', 'parentSessionId']],
  'subagents.list': null, // 合成：从会话投影里出目录
  'goals.edit': ['goals', 'edit', ['agentId', 'ref', 'request']],  // objective/maxGoalRounds 被宿主挪进了 request
  'goals.pause': ['goals', 'pause', ['agentId', 'ref']],
  'goals.resume': ['goals', 'resume', ['agentId', 'ref']],
  'goals.complete': ['goals', 'complete', ['agentId', 'ref']],
  'goals.clear': ['goals', 'clear', ['agentId', 'ref']],
  'settings.describe': ['settings', 'describe', []],  // descriptor 不收参数
  'settings.mutate': ['settings', 'mutate', []],  // inv 的默认包装；pick 出 ns/ops/expectedRevision 后仍由 inv 包成 {}
  'llm.providers': ['llm', 'listProviders', []],  // 宿主方法是 listProviders，不是 providers
  'credentials.describe': ['credentials', 'describe', ['refs']],
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
      /historyViaPage|modelCatalog|workspaceListViaFollow|subagentCatalog|unsupported\(/.test(src),
      `${key} 应该是合成端点或如实报不支持，现在像是直接打了网关`,
    );
    assert.ok(!/\binvoke\s*\(/.test(src), `${key} 不该自己直接调 invoke`);
  }
});

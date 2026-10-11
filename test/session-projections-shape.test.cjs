'use strict';

/**
 * session/projections 的 args 形状守卫。
 *
 * 这个 bug 的杀伤力全在「不报错」上：宿主 typertGateway 用 assertExactArguments
 * 严格校验 args 键名，形状写错回 gateway/arguments-invalid，而 App 把 /session/stats
 * 的 400 catch 掉了 —— 结果是输入框下方的统计行、ContextMeter 圆环、TodoDock、
 * GoalBar、权限档、planMode、图片上限**一整层**静默消失，UI 上看不出任何错误。
 *
 * 所以这里的假网关不是「宽松地记录一下 args」，而是**照抄宿主那条断言**：
 * 键名必须恰好等于 descriptor 的 wire 名，少一个就抛 gateway/arguments-invalid。
 * 这样任何把 `request` 包层去掉的改动都会当场红。
 *
 * descriptor 的依据（app.asar，dsh_api_session_controller）：
 *   参数 wire 名  = "request"
 *   parameter_0    = object({ "sessionId": intersection(string(), unknown()).readonly() })
 *   返回          = null | { asOfSeq: number, values: {...} }
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { handleStats } = require('../lib/mobile/sessions.js');
const { createApiProxy } = require('../lib/mobile/host-bridge.js');

/** session/projections 的宿主 descriptor（wire 名 + 内层字段）。 */
const PROJECTIONS_WIRE = ['request'];
const PROJECTIONS_REQUEST_FIELDS = ['sessionId'];

function assertExactArguments(args, expectedWire, innerFields, endpoint) {
  assert.ok(args && typeof args === 'object' && !Array.isArray(args), `${endpoint}: args 必须是普通对象`);
  const expected = new Set(expectedWire);
  const extra = Object.keys(args).filter((key) => !expected.has(key));
  const missing = [...expected].filter((key) => !Object.hasOwn(args, key));
  assert.equal(
    extra.length === 0 && missing.length === 0,
    true,
    `${endpoint}: args 字段与 descriptor 不符 — unexpected ${JSON.stringify(extra)}; missing ${JSON.stringify(missing)}`,
  );
  const inner = args.request;
  assert.ok(inner && typeof inner === 'object' && !Array.isArray(inner), `${endpoint}: request 必须是普通对象`);
  const innerExtra = Object.keys(inner).filter((key) => !innerFields.includes(key));
  assert.deepEqual(innerExtra, [], `${endpoint}: request 里有多余字段 ${JSON.stringify(innerExtra)}`);
  for (const field of innerFields) {
    assert.equal(typeof inner[field], 'string', `${endpoint}: request.${field} 必须是字符串`);
  }
}

/**
 * 假网关：只实现 session/projections，并且按宿主那条断言校验 args。
 * 记录最后一次调用，便于断言形状本身。
 */
function makeCtx(values, { asOfSeq = 42 } = {}) {
  const calls = [];
  const gateway = {
    async invoke({ namespace, method, args }) {
      calls.push({ namespace, method, args });
      if (namespace === 'session' && method === 'projections') {
        assertExactArguments(args, PROJECTIONS_WIRE, PROJECTIONS_REQUEST_FIELDS, 'session/projections');
        return { asOfSeq, values };
      }
      throw Object.assign(new Error(`未预期的端点 ${namespace}/${method}`), { code: 'gateway/invocation-unavailable' });
    },
    async stream() { throw new Error('本测试不涉及流'); },
  };
  const ctx = {
    get: (name) => (name === 'typertGateway' ? gateway : undefined),
    logger: { warn() {}, error() {} },
  };
  ctx.apiProxy = createApiProxy(ctx);
  return { ctx, calls };
}

function makeReq(url) {
  const req = Readable.from([]);
  req.url = url;
  req.headers = {};
  return req;
}

function makeRes() {
  const res = { status: null, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = payload ? JSON.parse(payload) : null; };
  return res;
}

const STATS_VALUES = {
  tokenUsage: { uncachedInputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0 },
  sessionStats: { decodeTokens: 1840, decodeMs: 100_000 },
  contextPressure: { pressureTokens: 12_300, contextWindow: 36_000 },
};

test('session/stats sends the request-wrapped args the host descriptor demands', async () => {
  const { ctx, calls } = makeCtx(STATS_VALUES);
  const res = makeRes();

  await handleStats(ctx, makeReq('/api/mobile/v1/session/stats?sessionId=session-1'), res);

  // 假网关里的 assertExactArguments 是本测试真正的断言点：形状不对这里就抛。
  assert.equal(res.status, 200, `期望 200，实际 ${res.status}：${JSON.stringify(res.body)}`);
  assert.deepEqual(res.body.projections, STATS_VALUES, 'values 应原样透传给移动端');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { request: { sessionId: 'session-1' } });
});

test('session/stats drops stray payload fields before they reach the gateway', async () => {
  // pick() 只放行 sessionId：多带一个键就是宿主那边的 unexpected。
  const { ctx, calls } = makeCtx(STATS_VALUES);
  const ctxWithStray = ctx;
  await ctxWithStray.apiProxy.sessions.projections({
    rpcId: 'mobile',
    method: 'session.projections',
    payload: { sessionId: 'session-1', maxMessages: 10 },
  });

  assert.deepEqual(calls[0].args, { request: { sessionId: 'session-1' } });
});

test('session/stats normalizes plan into planMode and keeps values untouched', async () => {
  const { ctx } = makeCtx({ ...STATS_VALUES, plan: { active: true, pending: false } });
  const res = makeRes();

  await handleStats(ctx, makeReq('/api/mobile/v1/session/stats?sessionId=session-1'), res);

  assert.equal(res.status, 200);
  // statsProjections 是 `{ ...projections, planMode }`：原样保留 plan，再补归一化后的 planMode。
  assert.deepEqual(res.body.projections.planMode, { active: true, pending: false });
  assert.deepEqual(res.body.projections.plan, { active: true, pending: false }, 'plan 原帧字段应保留');
  // 统计行/圆环要读的三个投影必须还在（ComposerStatsBar + ContextMeter 的数据源）。
  assert.ok(res.body.projections.tokenUsage, 'tokenUsage 缺失');
  assert.ok(res.body.projections.sessionStats, 'sessionStats 缺失');
  assert.ok(res.body.projections.contextPressure, 'contextPressure 缺失');
});

test('session/stats answers 400 (not a fake success) when the host call fails', async () => {
  const { ctx } = makeCtx(null);
  const failing = {
    get: () => ({
      async invoke() {
        throw Object.assign(new Error('typert gateway: session/projections: args fields do not match the descriptor'), {
          code: 'gateway/arguments-invalid',
        });
      },
      async stream() { throw new Error('本测试不涉及流'); },
    }),
    logger: { warn() {}, error() {} },
  };
  failing.apiProxy = createApiProxy(failing);
  const res = makeRes();

  await handleStats(failing, makeReq('/api/mobile/v1/session/stats?sessionId=session-1'), res);
  // ctx 未被使用（makeCtx 的返回值只是让上面三例读起来对称），这里显式说明。
  assert.ok(ctx);
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, 'gateway/arguments-invalid', '宿主错误码应原样透出，不许被抹成 host-unavailable');
});

test('session/stats rejects a missing sessionId without calling the host', async () => {
  const { ctx, calls } = makeCtx(STATS_VALUES);
  const res = makeRes();

  await handleStats(ctx, makeReq('/api/mobile/v1/session/stats'), res);

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'bad-request');
  assert.equal(calls.length, 0);
});

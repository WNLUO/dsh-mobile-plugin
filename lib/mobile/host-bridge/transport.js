'use strict';

/**
 * 网关传输层：旧 `apiProxy` 的信封形状 ⇄ 宿主 `typertGateway` 的 invoke/stream。
 *
 * 这是整座桥里唯一知道「宿主怎么调」的地方，四个上层文件（端点表 / bespoke 翻译 /
 * 事件合成 / 装配）都只经它出入。三条不能改的语义：
 *  1. `gateway.invoke()` **不返回信封**，直接返回业务值本体 —— 包回信封是这里的事。
 *  2. 业务错误的 `code`/`message`/`details` **原样透传**，否则 `promptErrorObject`
 *     的 code 白名单、`errorDetails` 的 details.reason 契约、agent-preset 的
 *     `agent-preset-not-found` 分支全部失效。
 *  3. 网关自己抛的错（服务没装、方法没注册）一律收敛成 `host-unavailable`：对移动端
 *     来说「宿主没这个能力」只有一种含义。
 */

const crypto = require('node:crypto');

// 网关层抛的「服务/方法不存在」类错误：前缀随版本变过（0.1.x 时期是无前缀的
// invocation-unavailable，0.2.0 是 gateway/invocation-unavailable），两种都认。
const GATEWAY_MISSING = new Set([
  'invocation-unavailable',
  'service-unavailable',
  'method-unavailable',
  'definition-unavailable',
  'ambiguous-endpoint',
]);

const UNAVAILABLE = Object.freeze({
  code: 'host-unavailable',
  message: '当前宿主版本没有提供该能力（需要 DSH 0.2.0 的 typertGateway）',
});

/** 宿主 0.2.0 确实没有这个端点（不是版本问题，是没实现）：如实回报，别假装成功。 */
function unsupported(what) {
  return {
    result: {
      ok: false,
      error: {
        code: 'host-unsupported',
        message: `当前宿主版本没有提供${what}，请在被控端使用更新版本的 DSH`,
      },
    },
  };
}

/** 合成流（workspace 跟随 / 历史翻页取游标）没有天然截止时间，这里给一个上限。 */
const SYNTHETIC_DEADLINE_MS = 8000;

function deadline(signal, ms) {
  const timer = AbortSignal.timeout(ms);
  if (!signal) return timer;
  try {
    return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timer]) : signal;
  } catch {
    return signal;
  }
}

function gatewayOf(ctx) {
  try {
    return (ctx.get && ctx.get('typertGateway')) || null;
  } catch {
    return null;
  }
}

function warn(ctx, message) {
  try {
    const logger = ctx && ctx.logger;
    if (logger && typeof logger.warn === 'function') logger.warn(`[dsh-mobile-plugin] ${message}`);
  } catch {
    /* 桥接层的告警不能反过来弄挂宿主 */
  }
}

function pick(source, keys) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function ok(value) {
  return { result: { ok: true, value } };
}

function errorOf(error, fallbackCode) {
  if (!error) return { ...UNAVAILABLE };
  const code = typeof error.code === 'string' && error.code ? error.code : fallbackCode || 'host-call-failed';
  if (GATEWAY_MISSING.has(code) || GATEWAY_MISSING.has(String(code).replace(/^gateway\//, ''))) {
    return { ...UNAVAILABLE };
  }
  const message = typeof error.message === 'string' && error.message ? error.message : String(error);
  const details = error.details;
  const plain =
    details && typeof details === 'object' && !Array.isArray(details) &&
    (Object.getPrototypeOf(details) === Object.prototype || Object.getPrototypeOf(details) === null)
      ? details
      : undefined;
  return plain ? { code, message, details: plain } : { code, message };
}

function fail(error, fallbackCode) {
  return { result: { ok: false, error: errorOf(error, fallbackCode) } };
}

function requestId(prefix) {
  return `${prefix}-randomUUID-${crypto.randomUUID()}`;
}

/**
 * args 多一个键就会 gateway/arguments-invalid。这里按宿主文案（形如
 * `unexpected "clientMessageId"`）把多余的键摘掉重试一次 —— 多出来的键宿主根本
 * 不会读，摘掉是安全的，也免得为一个拼写差异让整个功能不可用。
 */
function dropUnexpectedArgs(args, message) {
  if (!message || !message.includes('unexpected')) return null;
  const clause = message.slice(message.indexOf('unexpected'));
  const keys = [...clause.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (!keys.length) return null;
  const next = { ...args };
  let removed = 0;
  for (const key of keys) {
    if (!Object.hasOwn(next, key)) continue;
    delete next[key];
    removed += 1;
  }
  return removed ? next : null;
}

/**
 * 调用宿主时一并交出「本机操作者」身份。
 *
 * 0.2.1 起网关在派发前先 `assertPeerLive(request.peer)`：Peer 缺了就对 undefined 读
 * `.signal`，抛 `Cannot read properties of undefined (reading 'signal')`，这里把它收敛成
 * `host-call-failed` —— 手机上表现为 /sessions、/workspaces 一律 400，会话镜像永远
 * 「未推送」（只有本机自算的 /status 还活着）。0.2.0 及更早没有这道检查（网关自己回落
 * operatorPeer），也没有 `browserPeer` 这个成员，所以取不到就**不带**，行为与从前一致。
 *
 * 用 `ctx.get` 而不是 inject：旧宿主没这个成员、极简 profile 也可能没有这个服务，
 * 注入一个不存在的服务会让整行永远 pending（见 impl.js 里 apiProxy 那段教训）。
 */
function peerOf(ctx) {
  try {
    const connection = ctx.get && ctx.get('connection');
    const peer = connection && connection.browserPeer;
    return peer && typeof peer === 'object' ? peer : null;
  } catch {
    return null;
  }
}

/** 补齐到「当前宿主认得」的请求形状：新旧宿主的差别只在这一个函数里判定。 */
function hostRequest(ctx, namespace, method, args, signal) {
  const request = { namespace, method, args };
  if (signal) request.signal = signal;
  const peer = peerOf(ctx);
  if (peer) request.peer = peer;
  return request;
}

async function invoke(ctx, namespace, method, args, signal) {
  const gateway = gatewayOf(ctx);
  if (!gateway) return { error: { ...UNAVAILABLE } };
  const request = hostRequest(ctx, namespace, method, args, signal);
  try {
    return { value: await gateway.invoke(request) };
  } catch (error) {
    if (error && error.code === 'gateway/arguments-invalid') {
      const retry = dropUnexpectedArgs(args, error.message);
      if (retry) {
        warn(ctx, `${namespace}/${method} 去掉多余参数后重试：${JSON.stringify(retry)}`);
        try {
          return { value: await gateway.invoke({ ...request, args: retry }) };
        } catch (second) {
          return { error: errorOf(second, 'host-call-failed') };
        }
      }
    }
    return { error: errorOf(error, 'host-call-failed') };
  }
}

async function openStream(ctx, namespace, method, args, signal) {
  const gateway = gatewayOf(ctx);
  if (!gateway) throw Object.assign(new Error(UNAVAILABLE.message), { code: UNAVAILABLE.code });
  return gateway.stream(hostRequest(ctx, namespace, method, args, signal));
}

async function invokeEnvelope(ctx, namespace, method, args, signal) {
  const result = await invoke(ctx, namespace, method, args, signal);
  if (result.error) return fail(result.error);
  return ok(result.value);
}

module.exports = { GATEWAY_MISSING, UNAVAILABLE, unsupported, deadline, gatewayOf, warn, pick, ok, errorOf, fail, requestId, dropUnexpectedArgs, invoke, openStream, invokeEnvelope, SYNTHETIC_DEADLINE_MS };

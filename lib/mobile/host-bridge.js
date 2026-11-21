// 宿主能力检测与协议兼容桥共用入口，兼容服务由每代的独立上下文持有。
'use strict';

/**
 * 0.2.0 兼容桥：旧 `apiProxy` 调用形状 → 宿主 `typertGateway`。
 *
 * 0.2.0 删掉了 `apiProxy` 服务，宿主 RPC 全改走 `ctx.get('typertGateway')` 的 invoke /
 * stream。本插件十几个移动端模块都按旧形状调用（`ctx.apiProxy.<ns>.<method>(…)`，返回
 * `{ result: { ok, value|error } }`），这里提供同名同形状的服务，内部翻译成 gateway 调用并
 * 把结果包回旧信封；将来宿主若恢复真 apiProxy，删掉这个目录即可。
 *
 * 本文件只剩装配：实现分四份——transport（网关传输与信封翻译）、endpoints（端点表）、
 * shims（需要跨端点合成的那几处）、event-synthesis（旧 mux ⇄ 三条新流）。
 */

const { ENDPOINTS } = require('./host-bridge/endpoints.js');
const { muxFrames } = require('./host-bridge/event-synthesis.js');
const { unsupported, UNAVAILABLE } = require('./host-bridge/transport.js');

// ── 装配 ──────────────────────────────────────────────────────────────────

/**
 * 把端点表铺成旧的 `apiProxy.<ns>.<method>` 形状。
 *
 * 键表直接从 ENDPOINTS 推，不再手写一份：两份表对不上时的症状不是报错，而是别的模块里炸
 * 出 `ctx.apiProxy.<ns>.<method> is not a function`。新增端点只改 ENDPOINTS 一处。
 */
function createApiProxy(ctx) {
  const namespaces = {};
  for (const key of Object.keys(ENDPOINTS)) {
    const dot = key.indexOf('.');
    if (dot <= 0) continue;
    const name = key.slice(0, dot);
    const method = key.slice(dot + 1);
    if (!namespaces[name]) namespaces[name] = {};
    const spec = ENDPOINTS[key];
    namespaces[name][method] = (request, signal) => spec(ctx, (request && request.payload) || {}, signal);
  }

  return {
    ...namespaces,

    // 帧流：返回的是异步生成器，调用方直接 for await（不是 Promise）。
    events: {
      mux: (request, signal) => muxFrames(ctx, request || {}, signal),
      host: (request, signal) => muxFrames(ctx, request || {}, signal),
    },

    // 回答问题 / 审批。0.2.0 没有 approvals 命名空间，问题是 userQuestions/answer
    // 且必须带 callId —— 而 callId 只在问题事件里出现过，本插件 0.1.x 的问题帧来自
    // 旧 mux，形状对不上（见 README 的迁移说明），如实回报不支持，别让手机端干等。
    respond: () => unsupported('远程回答提问/审批的接口'),

    downloads: {
      sessionLog: () => unsupported('会话日志导出接口'),
    },
  };
}

/**
 * apiProxy 服务本体：**启动即提供**、方法被调用时才决定走哪条路——
 * 宿主自己的真服务在（旧运行时）就用它，不在（新运行时）就用上面那份网关兼容桥。
 *
 * 为什么要这样推迟判据：宿主的服务可能晚于本插件出现，而 App 打开后第一批接口
 * （会话列表）随时可能打进来。若在服务尚未提供时读 `ctx.apiProxy`，cordis 会抛
 * `cannot get property "apiProxy" without inject`——手机侧就是「加载会话列表失败」。
 * 返回的代理让这个空档不存在：先有个可用对象，宿主那份一出现，下一次调用自动接上。
 *
 * @param {object} ctx 本代隔离上下文
 * @param {() => object|null} hostProxyOf 取宿主真服务的取值器（取不到返回 null）
 */
function createApiProxyService(ctx, hostProxyOf) {
  const compat = createApiProxy(ctx);
  return new Proxy(compat, {
    get(target, prop, receiver) {
      if (typeof prop !== 'symbol') {
        const host = hostProxyOf();
        if (host && prop in host) return host[prop];
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      const host = hostProxyOf();
      return (host != null && prop in host) || prop in target;
    },
  });
}

/** 包存在时先等宿主提供旧协议服务，包缺席时直接使用网关兼容桥。 */
function runtimeProvidesApiProxy() {
  try {
    require.resolve('@deepseek-ai/dsh-host-apiproxy/package.json');
    return true;
  } catch {
    return false;
  }
}

module.exports = { createApiProxy, createApiProxyService, runtimeProvidesApiProxy, UNAVAILABLE };

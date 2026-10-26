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

module.exports = { createApiProxy, UNAVAILABLE };

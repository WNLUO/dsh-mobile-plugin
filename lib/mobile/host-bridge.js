'use strict';

/**
 * 0.2.0 兼容桥：旧 `apiProxy` 调用形状 → 宿主 `typertGateway`。
 *
 * 背景：DSH 0.2.0 删掉了 `apiProxy` 服务（整个 app.asar 里零命中），宿主 RPC 全部改走
 * `ctx.get('typertGateway')` 的 `invoke({namespace, method, args, signal})` / `stream(...)`。
 * 但本插件 17 个移动端模块历史上都是这一套：
 *
 *   请求：`ctx.apiProxy.<ns>.<method>({ rpcId, method: '<ns>.<method>', payload }, signal)`
 *   返回：`{ result: { ok: true, value } }` 或 `{ result: { ok: false, error } }`
 *
 * 与其逐个改 55 处调用点（每处都要对上宿主的 wire 参数名，而参数名错了只在运行时
 * 报 `gateway/arguments-invalid`），这里提供**同名同形状**的服务，内部翻译成
 * gateway 调用并把结果包回旧信封 —— 17 个文件一行都不用动，将来 DSH 若恢复真
 * `apiProxy`，把这个目录删掉、apply 里那一行 provide 去掉即可。
 *
 * 本文件只剩装配：把端点表铺成 `apiProxy.<ns>.<method>` 的形状。实现分四份：
 *   host-bridge/transport.js       网关传输与信封翻译（唯一知道「宿主怎么调」的地方）
 *   host-bridge/endpoints.js       端点表（键 ⇄ 宿主 wire 名与参数形状）
 *   host-bridge/shims.js           没有 1:1 端点、需要跨端点合成的几处
 *   host-bridge/event-synthesis.js 旧设备级 events.mux ⇄ 0.2.0 拆开的三条流
 */

const { ENDPOINTS } = require('./host-bridge/endpoints.js');
const { muxFrames } = require('./host-bridge/event-synthesis.js');
const { unsupported, UNAVAILABLE } = require('./host-bridge/transport.js');

// ── 装配 ──────────────────────────────────────────────────────────────────

/**
 * 把端点表铺成旧的 `apiProxy.<ns>.<method>` 形状。
 *
 * 键表直接从 ENDPOINTS 推，不再手写一份 `<ns>` → 方法名数组：两份表迟早会对不上，
 * 而对不上的后果不是报错，是 `ctx.apiProxy.<ns>.<method> is not a function` 这种在
 * 别的模块、别的请求里炸出来的 TypeError（新增 sessions.projections 时就漏登记过一次，
 * /session/stats 会跟着一起挂）。现在新增端点只改 ENDPOINTS 一处。
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

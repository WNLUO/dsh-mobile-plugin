'use strict';

/**
 * 调宿主 apiProxy 的两扇门：`sessions.*` 与 `agentPresets.*`。
 *
 * 抽出来是因为这两扇门此前各有两份实现——sessions.js 一份、agent-presets.js 一份
 * callAgentPresets（逐字相同），而 callSessions 是 sessions.js 内部 21 处的公共依赖，
 * 一旦 sessions.js 被拆分，21 处调用就得跟着搬家。
 *
 * 这里收的不只是「转发」：callSessions 还带两件必须跟着转发走的语义。
 *
 * 1. signal 必须显式传。宿主 `sessions.<method>(request, signal)` 的第二个参数是
 *    取消信号，宿主内部 `isAborted(signal)` 直接读 `signal.aborted`、不做
 *    undefined 兜底：search 这类会查 signal 的方法不传就抛
 *    `Cannot read properties of undefined (reading 'aborted')`。
 * 2. list 的在途合流。sessions.list 会扫描所有压缩日志；同一个 Host 可能同时收到
 *    桌面 completion、移动端列表和通知监控的请求，不合流就是一次刷新被放大成 N 次
 *    磁盘扫描。**但写后刷新（?fresh=1）不能搭在途 list 的车**：被合流到的那个请求
 *    发起于写入之前，拿回来的是旧列表，于是「刚改完又显示成改之前」。
 *
 * 依赖方向：rpc.js → history-derive（只为 rpcId 前缀常量），是叶子之上的薄层。
 */

const { MOBILE_PROMPT_RPC_PREFIX } = require('./history-derive.js');

// 移动端提示词的 rpcId 约定与 user 消息回溯共用，前缀常量定义放在没有依赖的
// history-derive 里（history-derive 要用 clientMessageIdFromSource，而会话模块
// 又 require 它；反向引用会成环——历史上就是这个函数在 history-derive 里找不到
// 定义，历史路径一有 user 消息就报 "clientMessageIdFromSource is not defined"）。
function mobilePromptRpcId(clientMessageId) {
  return clientMessageId ? `${MOBILE_PROMPT_RPC_PREFIX}${clientMessageId}` : 'mobile';
}

/**
 * 调宿主 apiProxy.agentPresets.*（Agent 预设列表 / 选择）。
 * 注意：宿主 list 声明不接 signal，select 接第二个参数；这里统一不传，避免把
 * undefined 交给内部会读 signal 的方法。
 */
function callAgentPresets(ctx, method, payload) {
  return ctx.apiProxy.agentPresets[method]({ rpcId: 'mobile', method: `agentPreset.${method}`, payload });
}

// sessions.list 的在途合流表按 ctx 隔离（不同宿主 / 测试上下文各算各的）。
const sessionListInFlight = new WeakMap();

function callSessions(ctx, method, payload, rpcId = 'mobile', signal, options) {
  const invoke = () => ctx.apiProxy.sessions[method]({ rpcId, method: `session.${method}`, payload }, signal);
  if (method !== 'list') return invoke();
  if (options && options.fresh) return invoke();

  const existing = sessionListInFlight.get(ctx);
  if (existing) return existing;

  let request;
  try {
    request = Promise.resolve(invoke());
  } catch (error) {
    // 同步抛出的也要变成 rejected promise：下面要挂 .then 清理并把它交给调用方，
    // 否则同步异常会绕过 tracked 的回收，永久把这次合流卡在表里。
    request = Promise.reject(error);
  }
  const tracked = request.then(
    value => {
      if (sessionListInFlight.get(ctx) === tracked) sessionListInFlight.delete(ctx);
      return value;
    },
    error => {
      if (sessionListInFlight.get(ctx) === tracked) sessionListInFlight.delete(ctx);
      throw error;
    },
  );
  sessionListInFlight.set(ctx, tracked);
  return tracked;
}

module.exports = { callSessions, callAgentPresets, mobilePromptRpcId };

'use strict';

/**
 * 宿主 apiProxy 的回执信封。
 *
 * 宿主所有 `apiProxy.*` 调用都回同一个形状：
 *   成功 `{ result: { ok: true,  value } }`
 *   失败 `{ result: { ok: false, error: { code, message, details? } } }`
 *   异常（只有 envelope.js 之外的调用方会碰到）`{ result: { ok: true, value } }` 的缺位形态
 *
 * 以前这个拆信封的动作在仓库里有 6 种写法：history-derive.js / workspaces.js /
 * agent-presets.js 三份逐字相同；session-cleanup.cjs 是「只取 value」的变体；
 * plugins.js / references.js 在此之上又叠了各自的字段校验与错误码
 * （那两个是有意的领域解码，不算重复）；auto-archive.cjs 则干脆绕过信封直接读
 * `response?.value?.items`——它读的那一层压根不是信封，是 bug。
 *
 * 把唯一实现收到这里，是因为 5 个模块为了拿这 5 行去 require 一个 1400 行、
 * 带 9 个模块级 WeakMap 的 sessions.js——那才是 sessions.js 拆不动的真正原因：
 * 它同时扮演了会话领域、缓存中心、RPC 封装和公共工具库四个角色。
 *
 * 依赖方向：envelope.js 是叶子模块，不 require 任何东西。
 */

/**
 * 拆信封，返回 `{ value }` 或 `{ error }`——**永远只返回其中一个键**，
 * 调用方要么解构 `const { value, error } = unwrap(r)` 再判 `error`，
 * 要么直接用 `unwrap(r).value`（已知成功路径）。
 *
 * 空响应与「宿主没给出 code」都归一成 `{ code, message }` 的形状，
 * 免得每个 handler 各写一遍兜底文案。
 */
function unwrap(resp) {
  if (!resp || !resp.result) return { error: { code: 'internal', message: '空响应' } };
  if (!resp.result.ok) return { error: resp.result.error || { code: 'unknown', message: '未知错误' } };
  return { value: resp.result.value };
}

/**
 * 只要值的变体：失败或空响应一律返回 null。
 *
 * 用在「拿不到就当没有」的只读旁路（自动归档扫描、清理任务的会话清单）——
 * 这些路径宁可什么都不做，也不该把错误抛给一个没人看日志的定时任务。
 * 注意它与 unwrap 的差别是**刻意的**：这里不产出 error 对象。
 */
function envelopeValue(resp) {
  const result = resp && resp.result;
  if (!result || result.ok !== true) return null;
  return result.value;
}

module.exports = { unwrap, envelopeValue };

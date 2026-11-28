'use strict';
// 2026-11-28：代读外壳能力契约的读取端；旧外壳不报版本时按「legacy」处理并降级。
/**
 * 外壳能力契约的**读取端**（住在代里，可热更）。
 *
 * 背景：外壳在启动时被 Node 冻住，改它要重启 DSH；而代是可热换的。所以真到必须改外壳时，
 * 新代得能在**旧外壳**上照常跑：先问外壳「你支持到哪一版、有哪些能力」，够的才开、不够的
 * 就把那项先收起来（降级）并如实报「重启 DSH 后可启用」，绝不让整代因为外壳旧就崩。
 *
 * 这份读法必须极稳：外壳服务可能不存在（无头部署 / 被直接挂载）、可能是老的（没有这两个
 * 字段，即本机制之前的外壳）、也可能字段是脏的。任何解析不出来的情况都退成
 * `apiVersion: 0`、`legacy: true`、`has() === false`，让调用方走降级，而不是抛错。
 *
 * @param {object|null} runtime 外壳服务（`ctx.get('dshMobilePluginRuntime')`），或它 status() 的结果。
 */
function readShellCompat(runtime) {
  let raw = runtime || null;
  if (raw && typeof raw.status === 'function') {
    try { raw = raw.status() || {}; } catch { raw = {}; }
  }
  if (!raw || typeof raw !== 'object') raw = {};
  const version = Number.isInteger(raw.shellApiVersion) && raw.shellApiVersion >= 0 ? raw.shellApiVersion : 0;
  const list = Array.isArray(raw.shellCapabilities) ? raw.shellCapabilities.filter((name) => typeof name === 'string') : [];
  const capabilities = new Set(list);
  return {
    /** 运行中外壳的接口版本；0 = 没报（本机制之前的老外壳）。 */
    apiVersion: version,
    /** 老外壳：读不到能力契约，只能按最保守的功能集跑。 */
    legacy: version === 0,
    /** 外壳是否提供某项能力。 */
    has: (name) => capabilities.has(name),
    /** 外壳接口版本是否达到某一级。 */
    atLeast: (need) => version >= (Number(need) || 0),
    /** 读到（并过滤过）的能力清单，便于诊断/上报。 */
    capabilities: [...capabilities],
  };
}

module.exports = { readShellCompat };

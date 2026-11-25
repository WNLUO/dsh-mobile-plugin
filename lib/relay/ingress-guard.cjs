// 2026-11-25：新增回环入口判据：端口有效性、漂移/遮蔽信号、三条线路落点与兜底原因码，只判据不碰进程。
'use strict';

/**
 * 回环入口判据（方案任务 A）。
 *
 * 只回答四个问题，全部是纯计算：专属入口端口有没有效；端口是不是没按预期工作；
 * Cloudflare / frp / ZeroNews 各自该把本地端口设成多少；面板该显示哪个兜底原因码。
 *
 * 两条口径不能挪：
 *  - **探测失败就是没证据**。`loopbackBlocked` 只有严格等于 true 才算被遮蔽；undefined、null、
 *    数字、探测异常都不许切成 true —— 否则一次超时就会把好端端的隧道切到备用入口。
 *  - **老 ZeroNews 隧道不删不改**。它落在旧端口上，这里就继续报旧端口；它坏掉由自带
 *    Cloudflare 兜底，绝不为了「统一落点」去重建一条官方没有公开删除参数的隧道。
 *
 * `noteLoopback` / `snapshot` 是自检与本模块之间唯一的一点记忆：自检把回环 health 的结论记进来，
 * 状态视图读它。判据本身不改 connection-check.js 里既有回环判据的任何语义。
 */

/** 运行时落盘字段：手机配置口不开放，只在 worker 绑定后由宿主写回。 */
const INGRESS_PORT_FIELD = 'tunnelIngressPort';

function validPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : 0;
}

/** 专属入口端口：正整数才算有，缺失 / 0 / 坏值一律当还没分配。 */
function ingressPortOf(state) {
  return validPort(state && state[INGRESS_PORT_FIELD]);
}

/**
 * 两个信号任一成立就要绕开：局域网绑定漂移（被占后换号），或回环 health 回来的不是本插件。
 *
 * `drifted` 可显式传入，给已有一份漂移账的调用方（lanPorts.adjusted()）用；不传时按
 * requestedPort ≠ boundPort 自己算。遮蔽优先于占用：两者都在时面板要说的是「回环被抢」。
 */
function signalsOf(input = {}) {
  const requested = validPort(input.requestedPort);
  const bound = validPort(input.boundPort);
  const derived = requested > 0 && bound > 0 && requested !== bound;
  const drifted = typeof input.drifted === 'boolean' ? input.drifted : derived;
  const shadowed = input.loopbackBlocked === true;
  const needsBypass = drifted || shadowed;
  const conflict = shadowed ? 'shadowed' : drifted ? 'occupied' : '';
  return { drifted, shadowed, needsBypass, conflict };
}

/**
 * 线路本地端口：需要绕开且专属入口已就绪时用它，否则维持局域网端口。
 * 已经有隧道在某个端口上时（`existingTunnelPort`）一律沿用它 —— 把在用的隧道改到新端口会
 * 被判成「旧隧道指向旧端口」，而官方 CLI 没公开删除参数，重建有风险。这条对三家都成立：
 * Cloudflare 与 frp 每次重连都按当前值重建，只有 zeronews 有云端隧道的身份。
 */
function tunnelPortOf(input = {}) {
  const lanPort = validPort(input.lanPort);
  const ingressPort = validPort(input.ingressPort);
  const existing = validPort(input.existingTunnelPort);
  if (existing > 0) return existing;
  if (input.signals && input.signals.needsBypass === true && ingressPort > 0) return ingressPort;
  return lanPort;
}

/**
 * 兜底原因码。没有绕开需要、或已经有可用公网线路时永远返回空 —— 不重复起第二条隧道。
 *
 * 前四个参数是对外约定；后三个是可选的细化输入（老 ZeroNews / 外部软件手填目标），
 * 调用方不带它们时只回通用的 port-conflict，不影响既有用法。
 */
function fallbackReasonOf(input = {}) {
  const signals = input.signals || {};
  if (signals.needsBypass !== true) return '';
  if (input.hasUsableRoute === true) return '';
  if (input.cloudflareAvailable !== true) return 'cloudflare-unavailable';
  if (input.provider === 'zeronews' && Boolean(input.hasLegacyTunnel)) return 'zeronews-stale';
  if (input.externalTarget === true) return 'external-target';
  if (input.portLocked === true) return 'port-locked';
  return 'port-conflict';
}

const KNOWN_STATES = new Set(['ok', 'blocked', 'unknown']);
let noted = { state: '', reason: '', at: 0 };

/** 自检把回环 health 的判据记进来；探测没做 / 没结果时清掉，绝不凭空记成被抢。 */
function noteLoopback(verdict) {
  if (!verdict || typeof verdict !== 'object') {
    noted = { state: '', reason: '', at: 0 };
    return snapshot();
  }
  noted = {
    state: typeof verdict.state === 'string' && KNOWN_STATES.has(verdict.state) ? verdict.state : 'unknown',
    reason: typeof verdict.reason === 'string' ? verdict.reason : '',
    at: Date.now(),
  };
  return snapshot();
}

/** 状态视图读到的那份回环判据；每次回副本，免得调用方就地改了它。 */
function snapshot() {
  return { ...noted };
}

module.exports = {
  INGRESS_PORT_FIELD,
  ingressPortOf,
  signalsOf,
  tunnelPortOf,
  fallbackReasonOf,
  noteLoopback,
  snapshot,
};

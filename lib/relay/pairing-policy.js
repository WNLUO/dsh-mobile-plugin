'use strict'

/**
 * 配对授权策略。
 *
 * 无头宿主没有弹窗确认界面，授权改由本地策略决定。两条链路都汇聚到父进程的
 * `/api/relay/internal/approval`：隧道收到 pairRequest 时，以及局域网代理的 onApprove。
 * sidecar 只接受显式 true，所以 'deny' 与恒定返回 `{ approved: false }` 等价。
 *
 *   'code' — 凭配对码放行。两条链路在询问宿主之前都已用恒定时间比较校验过配对码，中转还有
 *            失败锁定；配对码只在用户主动索取时展示，可用 `/api/relay/regenerate` 轮换、
 *            用 `/api/relay/revoke-all` 连同 lanSecret 一并作废。
 *   'deny' — 拒绝一切新配对。
 */

const POLICIES = ['code', 'deny']
const DEFAULT_POLICY = 'code'

/** 缺失或未知取值回落到默认值；settings schema 会在入口处挡掉其它取值。 */
function normalize(value) {
  return POLICIES.includes(value) ? value : DEFAULT_POLICY
}

/**
 * @param {unknown} value 存储的 pairingPolicy
 * @param {unknown} [device] 配对设备元信息，仅用于审计输出
 * @returns {{ approved: boolean, policy: string, reason: string, device: string, ip: string }}
 */
function evaluate(value, device) {
  const policy = normalize(value)
  const meta = device && typeof device === 'object' ? device : {}
  const approved = policy === 'code'
  return {
    approved,
    policy,
    reason: approved ? 'pairing code verified' : 'pairing policy is deny',
    device: typeof meta.name === 'string' && meta.name ? meta.name : 'unknown',
    ip: typeof meta.ip === 'string' ? meta.ip : '',
  }
}

/**
 * 宿主的系统标识（`process.platform` 的取值：darwin / win32 / linux …）。
 *
 * 与 status 那条路同源，但**送达时机完全不同**：status 要走轮询，手机刚绑好、
 * 还没轮到第一次探测时读不到；图标却要在设备行出现的那一刻就画得出来。
 * 配对是一台设备「是什么」这个事实唯一的确定时刻，所以在这里就把它交给手机，
 * 由手机存进设备记录。轮询回来的平台值只当补充（老设备补登记用），不再承担首次绘制。
 *
 * @returns {{ platform: string }}
 */
function hostPlatform() {
  return { platform: process.platform }
}

module.exports = { POLICIES, DEFAULT_POLICY, normalize, evaluate, hostPlatform }

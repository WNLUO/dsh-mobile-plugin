'use strict'

/**
 * 配对授权策略。
 *
 * 被删除的桌面端用弹窗逐次确认；无头宿主没有这个界面，授权改由本地策略决定。
 * 两条链路都汇聚到父进程的 /api/relay/internal/approval：隧道收到 pairRequest 时，
 * 以及局域网代理的 onApprove。sidecar 只接受显式 true，所以 'deny' 与原来恒定
 * 返回 { approved: false } 的行为完全一致。
 *
 *   'code' — 凭配对码放行。中转（dsh-mobile-server/server.js:400）与局域网
 *            （lib/relay/lan-proxy.js:243）在询问宿主之前都已用恒定时间比较校验过
 *            配对码，中转还有失败锁定；配对码只在用户主动索取时展示，可用
 *            /api/relay/regenerate 轮换、用 /api/relay/revoke-all 连同 lanSecret
 *            一并作废。
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

module.exports = { POLICIES, DEFAULT_POLICY, normalize, evaluate }

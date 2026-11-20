// 固定端口设置随远程连接配置一并保存和投影。
// 远程控制配置的 schema 与投影：装配层从这里取，不把实现搬回去（状态仓外壳仍在 impl.js）。
'use strict';

const z = require('@deepseek-ai/schemastery');
const core = require('./core.js');
const pairingApproval = require('./pairing-policy.js');

const RemoteControlSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  relayUrl: z.string().default(''),
  // 完整的中转地址列表，`relayUrls[0]` 恒等于 `relayUrl`（见 docs/relay-multi-address.md）。
  // 宿主从列表选择并注册一条线路，中选地址写回首项；手机只跟随当前注册线路。
  relayUrls: z.array(z.string()).default([]),
  lanEnabled: z.boolean().default(true),
  lanPort: z.number().step(1).min(1024).max(65535).default(18787),
  // 外部穿透软件的固定目标由用户声明；插件内配置的穿透另外自动锁定。
  lanPortFixed: z.boolean().default(false),
  name: z.string().default(''),
  // Pairing approval policy; see lib/relay/pairing-policy.js for the two modes and
  // why 'code' is not the old popup. Kept in the config schema so /api/relay/config
  // can change it, and so an unknown value is rejected on write.
  pairingPolicy: z.union(pairingApproval.POLICIES.map(value => z.const(value))).default(pairingApproval.DEFAULT_POLICY),
  // 是否把本机网络地址加密上报给「总控」（地址目录）。默认开 = 与历史行为一致；
  // 关掉后宿主不再跑总控上报客户端，手机换网后拿不到这台电脑的新地址（见 relay/control.js）。
  controlReportEnabled: z.boolean().default(true),
  // 桌面设置页那两颗侧边栏图标（手机 / 电脑）的可见性。默认全开；老 relay.json 没这两格时
  // 由 configOf 收成 true，界面不会在升级后突然少一颗。只给桌面控制面写，手机端配置口不收。
  desktopPhoneIcon: z.boolean().default(true),
  desktopComputerIcon: z.boolean().default(true),
  // 中转注册密钥（对偶于中转的 TUNNEL_REGISTER_SECRET）。桌面版拿不到 shell
  // 环境变量，所以它和其他配置一样存在 relay.json（0600），由 /api/relay/config
  // 在回环上写入；status / pairing / 二维码都不回显它。
  registerSecret: z.string().max(512).default(''),
  // 手机优先用哪条地址：空 = 不指定（按宿主网卡优先级排）。选择只挪候选顺序、不删候选，
  // 理由与边界见 relay/lan-network.cjs 的 orderCandidates 与 relay.json 那条地图条目。
  preferredLanAddress: z.string().max(64).default(''),
  // 用户手填的直连地址（`manualLanUrl`，内网穿透域名）也随二维码一起走，见 lan-network.cjs。
  manualLanUrl: z.string().max(200).default(''),
  // 用户手填的 IPv6 直连地址（`manualIpv6Url`，形如 `http://[240e::1]:18787`）：与上一条并列，
  // 只是拨的是 IPv6；网卡扫不到的那条固定地址靠它兜底，候选口径见 lan-network.cjs。
  manualIpv6Url: z.string().max(200).default(''),
  // 用户手填的「TCP 直连」目标（`manualTcpUrl`，形如 `主机:端口` / `http://主机:端口`，IPv6 方括号）。
  // 与上面两条并列、同样不进 sidecar；它只决定手机用裸 TCP 拨哪个目标（详见 lan-network.cjs）。
  manualTcpUrl: z.string().max(200).default(''),
})


function configOf(state) {
  // 两格必须一起算：`relayUrls` 是完整列表、`relayUrl` 是它的首项（契约见
  // docs/relay-multi-address.md），任何一处只写一个都会让读的一方看到矛盾的两份值。
  const relay = core.relayAddressesOf(state)
  return {
    enabled: Boolean(state.enabled),
    relayUrl: relay.relayUrl,
    relayUrls: relay.relayUrls,
    lanEnabled: Boolean(state.lanEnabled),
    lanPort: Number.isInteger(state.lanPort) ? state.lanPort : 18787,
    lanPortFixed: state.lanPortFixed === true,
    name: typeof state.name === 'string' ? state.name : '',
    // The schema rejects anything outside the enum, so in practice this only
    // ever normalises a value written before pairingPolicy existed.
    pairingPolicy: pairingApproval.normalize(state.pairingPolicy),
    // 只有明确写成 false 才算关；老状态文件没这一格时按开（与历史行为一致）。
    controlReportEnabled: state.controlReportEnabled !== false,
    // 没写过的老配置按显示处理：这两颗是入口，不因为升级就凭空消失。
    desktopPhoneIcon: state.desktopPhoneIcon !== false,
    desktopComputerIcon: state.desktopComputerIcon !== false,
    // 密钥只往 sidecar 和状态文件走：status() / pairingPayload() 都单独取字段，
    // 不会把它回显给手机、二维码或日志。
    registerSecret: typeof state.registerSecret === 'string' ? state.registerSecret : '',
    preferredLanAddress: typeof state.preferredLanAddress === 'string' ? state.preferredLanAddress : '',
    manualLanUrl: typeof state.manualLanUrl === 'string' ? state.manualLanUrl : '',
    manualIpv6Url: typeof state.manualIpv6Url === 'string' ? state.manualIpv6Url : '',
    manualTcpUrl: typeof state.manualTcpUrl === 'string' ? state.manualTcpUrl : '',
  }
}

module.exports = { RemoteControlSettingsSchema, configOf };

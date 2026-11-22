// 固定端口设置随远程连接配置一并保存和投影。
// 远程控制配置的 schema 与投影：装配层从这里取，不把实现搬回去（状态仓外壳仍在 impl.js）。
// 通用线路清单只在运行时写入 schema、手机配置口不开放；形状在这里归一，杜绝半截线路进总控。
// ZeroNews 隧道地址同样是运行时字段（插件自己读本机 API），不开放给手机改。
'use strict';

const z = require('@deepseek-ai/schemastery');
const core = require('./core.js');
const pairingApproval = require('./pairing-policy.js');

/** 通用线路清单最多几条：总控信封有上限，写多了只会拖慢每次同步。 */
const CUSTOM_ROUTES_LIMIT = 16;

/**
 * 第三方线路清单的形状归一：只留有地址、传输类型认不出按 http、按地址去重、限量。
 * 这是运行时字段（接入方写入），不经手机配置口，但要挡住半截/重复数据进总控信封。
 */
function customRoutesOf(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const url = typeof row.url === 'string' ? row.url.trim() : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      name: typeof row.name === 'string' ? row.name.trim().slice(0, 80) : '',
      transport: row.transport === 'tcp' ? 'tcp' : 'http',
    });
    if (out.length >= CUSTOM_ROUTES_LIMIT) break;
  }
  return out;
}

const RemoteControlSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  relayUrl: z.string().default(''),
  // 用户显式「停用公用中转」（issue #27）：为真时保存与读盘都不再补回公用地址，允许只走直连 / 局域网。
  publicRelayDisabled: z.boolean().default(false),
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
  // 用户手填的公网 IPv4 地址（形如 `http://1.2.3.4:18787`）：只认 IPv4 字面量，域名/其它交给直连地址。
  manualIpv4Url: z.string().max(200).default(''),
  // 用户手填的「TCP 直连」目标（`manualTcpUrl`，形如 `主机:端口` / `http://主机:端口`，IPv6 方括号）。
  // 与上面两条并列、同样不进 sidecar；它只决定手机用裸 TCP 拨哪个目标（详见 lan-network.cjs）。
  manualTcpUrl: z.string().max(200).default(''),
  // Cloudflare 兜底隧道拿到的快速隧道地址（空 = 没起 / 没拿到）。**纯运行时写入**：由
  // `cloudflared/wiring.cjs` 在 runner 报地址时 `settings.update` 落进来，手机端配置口
  // （`relay-control.js` 的 configView / configPatch）**不开放**这一格，只能由运行时写。
  cloudflareUrl: z.string().max(200).default(''),
  // 通用线路引擎：第三方线路清单（运行时写入，手机配置口不开放，见 core.js 默认状态）。
  customRoutes: z.array(z.object({
    url: z.string().max(300),
    name: z.string().max(80).default(''),
    transport: z.union([z.const('http'), z.const('tcp')]).default('http'),
  })).default([]),
  // ZeroNews 本机隧道地址（运行时写入，手机配置口不开放，见 core.js 默认状态）。
  zeroNewsUrl: z.string().max(300).default(''),
  // ZeroNews 是否启用：用户在面板点「连接」置真、断开置假。随状态落盘，DSH 重启后据此自动重连。
  // 手机配置口不开放这一格——它只反映面板的动作，不是手填设置。
  zeroNewsEnabled: z.boolean().default(false),
  // 节点小宝那条 TCP 线路的外网地址（`域名:端口`，空 = 没接）。用户在面板填一次，之后随通用线路
  // 清单上报。手机配置口同样不开放：设备端和线路都在节点小宝那边，手机端只该看到一条线路。
  jdxbUrl: z.string().max(300).default(''),
})


function configOf(state) {
  // 两格必须一起算：`relayUrls` 是完整列表、`relayUrl` 是它的首项（契约见
  // docs/relay-multi-address.md），任何一处只写一个都会让读的一方看到矛盾的两份值。
  const relay = core.relayAddressesOf(state)
  return {
    enabled: Boolean(state.enabled),
    relayUrl: relay.relayUrl,
    relayUrls: relay.relayUrls,
    // 只有明确写成 true 才是「用户显式停用公用中转」；老状态文件没这一格时按未停用处理。
    publicRelayDisabled: state.publicRelayDisabled === true,
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
    manualLanUrl: typeof state.manualLanUrl === 'string' ? state.manualLanUrl.trim().replace(/\/+$/, '') : '',
    manualIpv6Url: typeof state.manualIpv6Url === 'string' ? state.manualIpv6Url.trim().replace(/\/+$/, '') : '',
    manualIpv4Url: typeof state.manualIpv4Url === 'string' ? state.manualIpv4Url.trim().replace(/\/+$/, '') : '',
    manualTcpUrl: typeof state.manualTcpUrl === 'string' ? state.manualTcpUrl.trim().replace(/\/+$/, '') : '',
    // 运行时写入的 Cloudflare 隧道地址；缺失时按空串（还没起 / 没拿到）。
    cloudflareUrl: typeof state.cloudflareUrl === 'string' ? state.cloudflareUrl : '',
    // 运行时线路清单：读盘/写入都过同一层归一，坏值退化成空表（不阻断其它配置）。
    customRoutes: customRoutesOf(state.customRoutes),
    // 插件自己读到的 ZeroNews 隧道地址；缺失按空串（没装 / 没起 / 没建隧道）。
    zeroNewsUrl: typeof state.zeroNewsUrl === 'string' ? state.zeroNewsUrl : '',
    zeroNewsEnabled: state.zeroNewsEnabled === true,
    // 用户手填的节点小宝线路地址；同样按空串兜底（没接这条线路）。
    jdxbUrl: typeof state.jdxbUrl === 'string' ? state.jdxbUrl.trim() : '',
  }
}

module.exports = { RemoteControlSettingsSchema, configOf, customRoutesOf };

/**
 * 插件实现（随包发布的基础代）：装配路由、移动端 API 网关与 sidecar 生命周期。
 * 只做装配——镜像推送在 `lib/mirror/pusher.cjs`、sidecar 生命周期在
 * `lib/sidecar-lifecycle.cjs`、路由表在 `lib/routes/*`，这些实现不许搬回来
 * （`test/assembly-layer.test.cjs` 钉着）。
 */
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

const require = createRequire(import.meta.url)
const core = require('./relay/core.js')
const pairingApproval = require('./relay/pairing-policy.js')
const { sendJson, sendHtml } = require('./shared/http-util.js')
// 控制面守卫（localOnly）与移动端守卫（guarded）都住在这里；两套守卫并排放，
// 「控制面多挡跨站与 method、移动端只挡 token」这个不对称一眼可见。
const { localOnly, trustedLocalUi, readJson, createGuarded } = require('./http/routing.js')
const { registerMobileRoutes } = require('./routes/mobile-api.js')
const { registerControlPlaneRoutes } = require('./routes/control-plane.js')
const { hostMetadata, createStatusView } = require('./relay/status.js')
const { authorized, authOutcome, presentedCredential } = require('./mobile/auth.js')
const { readRawBody } = require('./shared/e2ee-request')
const streamRegistry = require('./mobile/stream-registry.js')
const { viaChannel } = require('./shared/via-header')
const { createSidecarLifecycle } = require('./sidecar-lifecycle.cjs')
const { createMirrorPusher } = require('./mirror/pusher.cjs')
const { randomBytes } = require('node:crypto')
const { lanUrls, advertisedCandidates, phoneCandidates, ipv6Candidates } = require('./relay/lan-network.cjs')
const { resolvePort } = require('./relay/port-allocator.cjs')
const { createPreviewService } = require('./relay/preview.js')
// 本机设备凭据库：/api/relay/revoke-all 必须同时吊销局域网直连的 dshc_ 凭据，
// 否则「撤销全部授权」只清了中转侧，同网设备仍能用旧凭据直连宿主。
// 入口按两条盘上布局分别找（嵌在插件包内 / 与插件包同级），见 shared/credentials-entry.js。
const credentials = require('./shared/credentials-entry.js').credentialsEntry()
const { createApiProxy } = require('./mobile/host-bridge.js')
const { installApprovalBridge } = require('./mobile/approvals.js')
const { installQuestionBridge } = require('./mobile/questions.js')
// 「手机上最近来过没有」：守卫记、控制面状态读。单独一个模块，装配层只转交。
const activity = require('./mobile/activity.cjs')
const { installAutoArchive } = require('./auto-archive.cjs')
const { installSessionCleanup } = require('./session-cleanup.cjs')
// 扩展卡的宿主侧：`extension_present` 工具与卡状态账本（见 mobile/extensions.js）。
const { installExtensions } = require('./mobile/extensions.js')
const { activeGuard } = require('./host-guard.cjs')
// 桌面端侧栏展开态的快照存储。桌面把这份状态只记在浏览器 localStorage 里，宿主必须
// 有一个落盘处：客户端半边（lib/client.js）上报 → 这里 → 移动端读取。

export const name = 'dsh-mobile-plugin'
// The mobile API runs headless inside the Cordis Host. `webServer` and
// `sessions` are the services it needs to serve /api/mobile/v1.
//
// 0.2.0 移除了 `settings.register(namespace, schema, { base, applies })` 这套 API
// （`@deepseek-ai/dsh-settings` 现在只导出 SettingsForms / redactSecrets /
// SettingsConflictError），所以这里不再注入 `settings`，配置改由插件自己的
// relay.json 存储负责 —— 见下面 createConfigStore。
//
// 0.2.0 里也没有 `apiProxy` 这个服务（整个 asar 零命中）：宿主 RPC 全部走
// `ctx.get('typertGateway')` 的 `invoke({ namespace, method, args })`，见
// mobile/plugins.js、mobile/references.js 里同款封装。留着 apiProxy 只会让插件永远
// pending —— 服务不存在时 loader 不会激活这一行，于是路由、sidecar、中转全都不出现，
// 而日志只有一行 "pending (waiting for service: apiProxy)"。
//
// 所以 `apiProxy` 是**按运行时二选一**的：
//   旧运行时（自带 @deepseek-ai/dsh-host-apiproxy）→ 注入它，读宿主那份真服务；
//   0.2.0                                        → 不注入，改由 apply 在本 fiber 上
//                                                  provide 兼容桥（fiber.store 里
//                                                  有，get trap 第一站就命中）。
// 漏了这两个分支里的任何一个，读 `ctx.apiProxy` 都会抛
// `cannot get property "apiProxy" without inject`：服务器宿主上 mirror 推送曾整条挂掉。
//
// `typertGateway` 必须出现在 inject 里（0.2.0 那一支）：宿主 RPC 全部经它派发，
// 而它是**后于本插件**装载的服务。只 `ctx.get('typertGateway')` 而不注入，取到的是
// 装载那一刻的空值，于是每一条事件流都抛「当前宿主版本没有提供该能力」——服务器宿主
// 上实时推送整条挂掉，而收发消息、会话列表这些走普通请求的功能一切正常，看着像只有
// 「刷新不实时」的小毛病。注入之后 cordis 会等服务就绪再激活本插件。
// 旧运行时那一支不加：那版没有这个服务，注入只会让这一行永远 pending。
export const inject = runtimeProvidesApiProxy()
  ? ['webServer', 'apiProxy', 'sessions']
  : ['webServer', 'sessions', 'typertGateway']

export const REMOTE_CONTROL_SETTINGS_NAMESPACE = 'mobile-remote-control'
export const RemoteControlSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  relayUrl: z.string().default(''),
  lanEnabled: z.boolean().default(true),
  lanPort: z.number().step(1).min(1024).max(65535).default(18787),
  name: z.string().default(''),
  // Pairing approval policy; see lib/relay/pairing-policy.js for the two modes and
  // why 'code' is not the old popup. Kept in the settings schema so the host UI and
  // /api/relay/config can change it, and so an unknown value is rejected on write.
  pairingPolicy: z.union(pairingApproval.POLICIES.map(value => z.const(value))).default(pairingApproval.DEFAULT_POLICY),
  // 中转注册密钥（对偶于中转的 TUNNEL_REGISTER_SECRET）。桌面版拿不到 shell
  // 环境变量，所以它和其他配置一样存在 relay.json（0600），由 /api/relay/config
  // 在回环上写入；status / pairing / 二维码都不回显它。
  registerSecret: z.string().max(512).default(''),
  // 手机优先用哪条地址：空 = 不指定（按宿主网卡优先级排）。选择只挪候选顺序、不删候选，
  // 理由与边界见 relay/lan-network.cjs 的 orderCandidates 与 relay.json 那条地图条目。
  preferredLanAddress: z.string().max(64).default(''),
  // 用户手填的直连地址（`manualLanUrl`，内网穿透域名）也随二维码一起走，见 lan-network.cjs。
  manualLanUrl: z.string().max(200).default(''),
})


function configOf(state) {
  return {
    enabled: Boolean(state.enabled),
    relayUrl: typeof state.relayUrl === 'string' ? state.relayUrl : '',
    lanEnabled: Boolean(state.lanEnabled),
    lanPort: Number.isInteger(state.lanPort) ? state.lanPort : 18787,
    name: typeof state.name === 'string' ? state.name : '',
    // The schema rejects anything outside the enum, so in practice this only
    // ever normalises a value written before pairingPolicy existed.
    pairingPolicy: pairingApproval.normalize(state.pairingPolicy),
    // 密钥只往 sidecar 和状态文件走：status() / pairingPayload() 都单独取字段，
    // 不会把它回显给手机、二维码或日志。
    registerSecret: typeof state.registerSecret === 'string' ? state.registerSecret : '',
    preferredLanAddress: typeof state.preferredLanAddress === 'string' ? state.preferredLanAddress : '',
    manualLanUrl: typeof state.manualLanUrl === 'string' ? state.manualLanUrl : '',
  }
}

// 0.2.0 之前这份配置注册在宿主 settings 的 `mobile-remote-control` 命名空间里
// （`ctx.settings.register(ns, schema, { base: configOf(state), applies: 'live' })`），
// 写入路径只有 `settings.update()` / `settings.watch()`。0.2.0 里那套 API 已经不存在，
// 于是这里用插件自己的状态文件实现等价的三件事：
//
//   get()    —— 读当前值（就是 relay.json 里那几项）
//   update() —— 按 schema 校验后写回 relay.json（和旧 settings.update 一样拒绝非法值）
//   watch()  —— 进程内变更通知（旧的 settings.watch 用来触发 applyServices）
//
// 代价：桌面「设置」页里不再出现「远程控制」这一项，宿主侧的设置 UI 也不能改它；
// 控制面（/api/relay/config、/api/relay/toggle）和手机端读到的值完全不受影响，
// 因为它们本来就都走这个 store。另一个差别是这里只监听进程内写入，直接在进程外编辑
// relay.json 需要重启宿主才会生效（旧实现同样不会热读文件）。
function createConfigStore(state) {
  const listeners = new Set()
  const notify = () => {
    const next = configOf(state)
    for (const listener of [...listeners]) {
      try { listener(next) } catch { /* 单个订阅者出错不该中断其余订阅者 */ }
    }
  }
  return {
    get: () => configOf(state),
    /**
     * 写配置。`notify: false` 只落盘、不通知订阅者 —— 手机端改中转地址时要用它：
     * 订阅者一跑就会重配隧道，而那一发响应还没吐完（详见 mobile/relay-control.js）。
     */
    notify() { notify() },
    async update(patch, options = {}) {
      const next = configOf(state)
      for (const [key, value] of Object.entries(patch || {})) {
        if (value === undefined || !(key in next)) continue
        next[key] = value
      }
      let parsed
      try {
        parsed = RemoteControlSettingsSchema(next)
      } catch (error) {
        throw new Error(`invalid remote-control setting: ${error && error.message ? error.message : String(error)}`)
      }
      Object.assign(state, parsed)
      core.saveState(state)
      if (options.notify !== false) notify()
      return configOf(state)
    },
    watch(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

function pairingPayload(state, lanPort) {
  const port = Number.isInteger(lanPort) ? lanPort : state.lanPort
  // 面板上选过的「手机优先用这条」在这里兑现：只挪到最前，其余继续当兜底（App 按顺序挨个试）。
  const candidates = state.lanEnabled
    ? phoneCandidates(advertisedCandidates(port), { preferred: state.preferredLanAddress, manual: state.manualLanUrl })
    : []
  const urls = candidates.map(candidate => candidate.url).filter(Boolean)
  const relayUrl = state.relayUrl || ''
  const payload = {
    type: 'dsh-pair',
    version: 1,
    name: state.name || os.hostname(),
    instanceId: state.instanceId,
    code: state.pairingCode,
    // 协议版本与一次性票据（§8.3(1)）。
    //
    // `proto: 2` 由**宿主**写、也由宿主生成，中转没有任何机会改写它 —— 所以「新 App 被
    // 中转骗回明文」这个问题从一开始就不存在。`ticket` 是 32 字节随机数，手机拿它派生
    // 配对密钥；二维码是屏幕对摄像头，这条通道完全绕开中转。
    //
    // 老 App 只取自己认识的那几个字段，多出来的两个会被忽略 —— 一张二维码同时服务新旧两种。
    proto: 2,
    ticket: state.pairingTicket || '',
    relayUrl,
    lanUrls: urls,
    // 候选列表随二维码一起带走：App 配对后即使换了网段，也能按这份列表
    // 依次重试而不用先回到公网中转去问。
    lanCandidates: candidates.map(candidate => candidate.url).filter(Boolean),
    // IPv6 直连候选（理想情况下是手机**不在同一个 Wi-Fi 里**时唯一能拨到的地址）：不参与上面
    // 那份的排序，顺序由 App 侧拿它和公网中转实测比出来；直连监听没开就没有这条通道。
    ipv6Candidates: state.lanEnabled ? ipv6Candidates(port).map(candidate => candidate.url).filter(Boolean) : [],
  }
  return {
    payload,
    text: `dshpair://v1?data=${encodeURIComponent(JSON.stringify(payload))}`,
  }
}

// 上报给 App 的候选地址（私网优先、没有私网才退公网）住在 `./relay/lan-network.cjs`
// 的 `advertisedCandidates`：那是地址策略，不是装配。这里只把它转交给三处消费点。
// 「手机上最近来过没有」同理，住在 `./mobile/activity.cjs`（守卫记、控制面状态读）。

/**
 * 运行时是否自带 `@deepseek-ai/dsh-host-apiproxy`（即 `api-gateway` 那个入口）。
 *
 * 从本模块所在位置解析，而不是读 DSH 版本号：桌面端插件装在
 * `~/.dsh/profiles/<profile>/node_modules/dsh-mobile-plugin` 里，那里只有 `ws`，
 * 一路往上也碰不到 DSH 的依赖树（它在 app.asar 里）→ 解析不到 → 用兼容桥；
 * 无头宿主直接跑在插件包里，包内 `node_modules` 有整套 `@deepseek-ai/*` → 解析得到
 * → 用宿主自己那份。解析失败只是「没有」，不该把插件带崩。
 *
 * 这个函数在模块顶层就被 `export const inject` 用了一次，所以它必须是函数声明
 * （提升），不能写成 `const` 箭头函数 —— 那会撞上 TDZ。
 */
function runtimeProvidesApiProxy() {
  try {
    require.resolve('@deepseek-ai/dsh-host-apiproxy/package.json')
    return true
  } catch {
    return false
  }
}

function apply(ctx) {
  // 0.2.0 删掉了 `apiProxy` 服务（宿主 RPC 全走 ctx.get('typertGateway')），但插件里
  // 17 个移动端模块历史上都是 `ctx.apiProxy.<ns>.<method>({rpcId,method,payload}, signal)`
  // + `{result:{ok,value}|{ok:false,error}}` 这一套。这里在自己的 fiber 上把同形状的
  // 兼容服务 provide 出去（cordis 的 Context get trap 会先查 fiber.store，所以**在 0.2.0 上**
  // 不用把它加进 inject —— 加进去反而会因为「服务不存在」让这一行永远 pending），
  // 内部由 mobile/host-bridge.js 翻译成 gateway 调用。
  //
  // 不用 `class X extends Service`：cordis 的 loader 只对「模块本身就是类」的插件
  // 走 new（api-gateway 就是这么挂 typertGateway 的），本模块有 apply，走不到那条路。
  //
  // 但**旧运行时（≤ 0.1.x）自带 `apiProxy`**（`@deepseek-ai/dsh-host-apiproxy` 的
  // ApiProxyService，由 dsh-web-app 那一层供给），这时再 provide 一次会让整棵树加载
  // 失败：`service "apiProxy" has been registered at <dsh-mobile-plugin>`，报错挂在
  // 后到的 api-gateway 入口上，服务器宿主曾因此完全起不来。而且旧运行时的桥也翻译不动
  // —— host-bridge.js 是翻译到 0.2.0 的 `ctx.get('typertGateway')` 的。所以按运行时
  // 有没有这个包二选一：有就用宿主那份真 apiProxy，没有才装兼容服务。
  // （不能靠 `ctx.get('apiProxy')` 判断：宿主是后于本插件装载的，那时它还不在。）
  // 这两条二选一，判据同源：0.1.x 宿主自带真 apiProxy（审批帧与回答都还走得通），
  // 0.2.x 才需要兼容桥，也才需要审批桥（见 mobile/approvals.js 的文件头）。
  const hasHostApiProxy = runtimeProvidesApiProxy()
  if (!hasHostApiProxy) ctx.reflect.provide('apiProxy', createApiProxy(ctx))

  const state = core.loadState()
  // 0.2.0 之前是 `ctx.settings.register(REMOTE_CONTROL_SETTINGS_NAMESPACE,
  // RemoteControlSettingsSchema, { base: configOf(state), applies: 'live' })`，
  // relay.json 是这个命名空间的种子。现在由 createConfigStore 直接以 relay.json
  // 为准（见那里的说明与代价）。
  const settings = createConfigStore(state)
  Object.assign(state, settings.get())

  // 局域网直连端口自适应。
  //
  // 18787 这个默认端口在这台机器上已经被 `billion-context` 占着，于是 LAN 代理的
  // listen 必然 EADDRINUSE，手机配对时能看到的局域网候选全是死地址。旧实现只有
  // `lan.state='error'` 一句 truthfully 的报错，没有任何自愈。
  //
  // 这里在第一次同步 sidecar 之前探一次：首选端口空闲就用它（什么都不变），被占就
  // 让内核分一个空闲端口，并把实际端口落到三处——relay.json（下次启动继续用它，
  // 免得二维码/收藏的地址每次重启都变）、下发给 sidecar 的配置、以及状态接口和
  // 配对二维码（否则二维码里带的仍是没在监听的死端口）。
  let lanPortAdjusted = false
  let effectiveLanPort = Number.isInteger(state.lanPort) ? state.lanPort : 18787
  let lanPortProbe = null
  const lanPortInUse = () => (state.lanEnabled && effectiveLanPort > 0 ? effectiveLanPort : state.lanPort)
  const advertisedLanPort = () => (state.lanEnabled ? sidecarLifecycle.getAdvertisedLanPort() : state.lanPort) // 对外报地址用实绑端口，见 lifecycle
  // 每次同步前都跑一次探测，而不是只在启动时探一次：`/api/relay/config` 改了
  // lanPort 之后同样要走这条路（否则新端口被占时又会退回死地址）。并发调用复用
  // 在飞的那次——探测要占一个监听句柄，重复触发没有意义。
  // ⚠️ `ours` 必须传：**自己占着的号不是「被占」**，不认它就会把落盘端口漂走（判据、
  // 代价与现场见 sidecar-lifecycle 的 getOwnLanPort；只读的二维码路由也会触发）。
  const resolveLanPort = () => {
    if (!state.lanEnabled) { lanPortProbe = null; return Promise.resolve(state.lanPort) }
    if (lanPortProbe) return lanPortProbe
    lanPortProbe = resolvePort(state.lanPort, '0.0.0.0', { ours: sidecarLifecycle.getOwnLanPort() })
      .then(resolved => {
        lanPortAdjusted = Boolean(resolved.adjusted)
        if (resolved.adjusted && resolved.port > 0) {
          state.lanPort = resolved.port
          try { core.saveState(state) } catch { /* 落盘失败只影响下次启动的端口选择 */ }
        }
        effectiveLanPort = Number.isInteger(resolved.port) ? resolved.port : state.lanPort
        return effectiveLanPort
      })
      .catch(() => { effectiveLanPort = state.lanPort; return effectiveLanPort })
      .finally(() => { lanPortProbe = null })
    return lanPortProbe
  }

  // sidecar 子进程的全部生命周期：起停、配置下发、自重启、健康轮询。
  const sidecarLifecycle = createSidecarLifecycle({
    ctx,
    lanPortInUse,
    resolveLanPort,
    // 本代实现所在的 lib/。默认值能推对，但代际目录里那份推出来的是它自己，
    // 显式传入能让「re-fork 前清的是不是正在跑的那份缓存」不依赖巧合。
    pluginLibDir: path.dirname(fileURLToPath(import.meta.url)),
    // 下发给 worker 的配置：这里的字段集就是 sidecar 的启动契约，改名要同步 worker。
    //
    // `pairingTicket` 与 `pairingCode` 都必须在这里：局域网代理的配对要拿票据派生配对
    // 密钥（协议 v2 的请求在旁路里解封）。漏了票据时旁路读到的是空串，任何一次扫码配对
    // 都回「配对码错误或桌面端已拒绝」，而主进程那条 `/pair` 一切正常 —— 症状是「同一个
    // 二维码，走中转能配、走局域网不能」。
    buildConfig: (lanPort) => ({ enabled: state.enabled, relayUrl: state.relayUrl, instanceId: state.instanceId, pairingCode: state.pairingCode, pairingTicket: state.pairingTicket || '', name: state.name, upstreamPort: ctx.webServer.port, lanPort, lanEnabled: state.lanEnabled, lanSecret: state.lanSecret, registerSecret: state.registerSecret }),
  })
  const { sidecarToken, syncSidecar, restartSidecar, tunnelConnected } = sidecarLifecycle

  // 镜像推送调度器：会话事件立即推，后台循环每个 tick 补推一个冷会话；凭据摘要由装配层给取值器（凭据库归本进程），中转靠它认离线缓存的读者。
  const mirror = createMirrorPusher({ ctx, tunnelConnected, getSidecar: sidecarLifecycle.getSidecar, lastMobileAt: activity.snapshot, credentialDigests: () => credentials.activeDigests(state.instanceId) })
  // 隧道刚连上时补推一次全量：未连通期间每轮推送都被 worker 以 503 拒绝。
  sidecarLifecycle.onTunnelUp(() => { void mirror.pushMirror(); })

  ctx.effect(() => sidecarLifecycle.start(), `${name}: facade sidecar`)
  ctx.effect(() => mirror.start(), `${name}: mobile mirror sync`)

  // Keep stale project conversations out of the host's session browser.
  // This is deliberately Host-side so it remains active even with no operator present.
  if (!hasHostApiProxy) ctx.effect(() => installApprovalBridge(ctx), `${name}: host approval bridge`)
  if (!hasHostApiProxy) ctx.effect(() => installQuestionBridge(ctx), `${name}: host question bridge`)
  ctx.effect(() => installAutoArchive(ctx), `${name}: automatic session archive`)
  ctx.effect(() => {
    // Profiles without the optional tools injection still support core remote control.
    try { installSessionCleanup(ctx) } catch (error) {
      if (!String(error).includes('without inject')) throw error
    }
    return undefined
  }, `${name}: session cleanup tool`)
  ctx.effect(() => {
    // 卡状态账本与三条路由不靠这个工具，所以缺 tools 注入时只少一个工具，别把整块装配丢掉。
    try { installExtensions(ctx) } catch (error) {
      if (!String(error).includes('without inject')) throw error
    }
    return undefined
  }, `${name}: extension tool`)

  const status = createStatusView({
    state,
    webServerPort: ctx.webServer.port,
    getSidecarSnapshot: sidecarLifecycle.getSnapshot,
    lanPortInUse: advertisedLanPort, // 手机该拨的端口：sidecar 实绑值
    getLanPortAdjusted: () => lanPortAdjusted,
    getSidecarState: sidecarLifecycle.getState,
    getSidecarRestarts: sidecarLifecycle.getRestarts,
    getSidecarRestartedAt: sidecarLifecycle.getRestartedAt,
    getSidecarRestartError: sidecarLifecycle.getRestartError,
    getMirrorPush: mirror.getMirrorPush,
  })
  function applyServices() {
    void syncSidecar().catch(() => undefined)
  }
  function registerRoute(route) {
    ctx.effect(() => ctx.webServer.register(route), `${name}: ${route.path}`)
  }

  registerControlPlaneRoutes({
    registerRoute,
    // 更新的机制住在外壳（`lib/index.js`）里，代这边只把它开成本机接口。取不到就如实报
    // 不可用（`lib/impl.js` 被单独挂载时就是这样）。
    getPluginRuntime: () => (typeof ctx.get === 'function' ? ctx.get('dshMobilePluginRuntime') : null),
    localOnly, trustedLocalUi,
    readJson,
    sendJson,
    // 面板页（lib/panel/index.html）整页吐给浏览器用；与控制面其它响应一样按注入传，不在这里 require，路由表才保持「只依赖注入项」。
    sendHtml,
    state,
    sidecarToken,
    status,
    settings,
    syncSidecar,
    // ⚠️ 必须传取值器：sidecar 会被自重启整体替换，传实例就是一份永远指向旧 facade 的快照。
    getSidecar: sidecarLifecycle.getSidecar,
    credentials,
    activeGuard,
    resolveLanPort,
    lanPortInUse: advertisedLanPort, // 二维码里的端口也必须是实绑值
    getLanPortAdjusted: () => lanPortAdjusted,
    pairingPayload,
    restartSidecar,
    // 「手机上最近来过没有」——控制面状态里补给面板用（见 ./mobile/activity.cjs）。
    mobileActivity: activity.snapshot,
    // 桌面端「我读过了」那条路由（/api/relay/desktop-read）要清掉宿主侧的完成提醒，
    // 需要插件 ctx 才能拿到按设备隔离的状态表。
    ctx,
    // 内存自检台账（`/api/relay/status` 的 `selfCheck`）的四个取值器：台账本体在
    // `lib/mobile/self-check.cjs`。侧车内存与两条路的流数都只有 worker 的 `/status`
    // 快照这一条既有通道（局域网那份由 lan-proxy 的 stats() 经快照带出来）。
    getSidecarSnapshot: sidecarLifecycle.getSnapshot,
    getMirrorPush: mirror.getMirrorPush,
    getMirrorPushFailures: mirror.getPushFailures,
    getLanProxyStats: () => sidecarLifecycle.getSnapshot()?.streams?.lan ?? null,
    // 吊销时收掉这台设备已经开着的流（§3.3）：token 换了只保证「下一次请求」被拒，
    // 一条已经开着的 SSE 不会自己停，被踢的手机还能继续收消息直到它自己重连。
    dropDeviceStreams: (deviceId) => streamRegistry.drop(deviceId),
  })


  /**
   * 协议 v2 信封的宿主侧钩子（§8.3(4)）。
   *
   * `keyFor` 按 **keyId** 查密钥，不按 deviceId：后者是手机自填的，克隆/迁移后会撞，
   * 撞了就变成「两台手机能用同一把密钥验签」。凭据库是唯一的密钥来源，而它只在宿主
   * 主进程里可写。
   */
  const envelope = {
    keyFor: (keyId) => credentials.findByKeyId(state.instanceId, keyId),
    readBody: (req) => readRawBody(req),
  }
  const guarded = createGuarded(ctx, authOutcome, activity.note, {
    // 鉴权通过后立刻记「最近连接 + 走的是哪条路」：两条代理都注入了 `x-dsh-via`。
    onAuthorized: (req) => {
      const presented = presentedCredential(req)
      if (!presented) return
      const record = credentials.lookup(presented, state.instanceId)
      if (record) credentials.touch(record, { channel: viaChannel(req) })
    },
    envelope,
  })

  // 内置浏览器预览的宿主端：手机按端口在它自己的环回上监听，把内置浏览器写下的原始
  // 字节通过 WebSocket 送到这里，这里与 `127.0.0.1:<port>` 对搬。
  //
  // `protectedPorts` 是取值器而不是快照：局域网端口会在运行中被自适应改掉
  // （见上面的 resolveLanPort），快照会让这道边界跟着失效。DSH 自身的 web 端口
  // （`ctx.webServer.port`，默认 3080）也从这里按身份排掉——预览这条管道刻意不做
  // 「把桌面端 GUI 搬进手机」这件事，所以不允许它连回宿主自己。
  const preview = createPreviewService({
    authorized,
    protectedPorts: () => {
      const ports = new Set([ctx.webServer.port, lanPortInUse()])
      ports.delete(0)
      return ports
    },
    onLog: (message) => ctx.logger?.info?.(`${name}: %s`, message),
  })
  ctx.effect(() => () => preview.close(), `${name}: preview pipes`)

  // 移动端路由表在 lib/routes/mobile-api.js：那里是一张可以对着 App 侧 apiPaths.ts
  // 核对的「路径 → handler」表，不用在 1000 行装配代码里翻。
  registerMobileRoutes({
    registerRoute,
    // 预览是 WebSocket 升级路由，走的是 webServer 的另一套名字空间；与 registerRoute
    // 一样必须包在 ctx.effect 里，否则插件重载时重复注册会直接抛错。
    registerUpgradeRoute: (route) => {
      ctx.effect(() => ctx.webServer.registerUpgrade(route), `${name}: ${route.path}`)
    },
    preview,
    guarded,
    state,
    hostMetadata,
    // 取值器而非快照对象：snapshot 会被 applySidecarConfig 整体替换，闭包捕获对象会让
    // 连接信息永远停在进程启动那一刻。
    //
    // 曾经这里写的是 `() => sidecarSnapshot` —— 那个标识符在本文件作用域里根本不存在
    // （它只在 lib/sidecar-lifecycle.cjs 内部），于是 GET /api/mobile/v1/connection-info
    // 一进来就 ReferenceError。同一个 apply() 里给 createStatusView 传的是
    // `sidecarLifecycle.getSnapshot`，两处不一致才让这个笔误活了下来。
    getSidecarSnapshot: sidecarLifecycle.getSnapshot,
    // 移动端那边的「局域网候选」：私网优先的清单 + 用户手填的直连地址（网卡扫不出的域名）。
    safeLanCandidates: (port) => phoneCandidates(advertisedCandidates(port), { manual: state.manualLanUrl }),
    // IPv6 直连候选单独一份：App 拿它单开一条通道、和公网中转比速度，不掺进上面那份的排序。
    safeIpv6Candidates: ipv6Candidates,
    lanPortInUse: advertisedLanPort, // LAN 候选用实绑端口
    // 配对那条路由自己要签凭据：core 是签 token 的实现，pairingApproval 决定这台机器
    // 收不收新设备（'deny' 时一律拒）。两者本文件都已有，透传给移动端路由。
    core,
    pairingApproval,
    // 配对成功之后换码 + 换票据（§5.1）：状态变更在 core 里，这里只补「让旁路重读」。
    rotatePairing: () => { core.rotatePairing(state); applyServices() },
    // 「这台设备的中转与连接配置」那十条（见 lib/mobile/relay-control.js）。
    // 它们与控制面 `/api/relay/*` 写的是**同一份** relay.json（同一个 `settings` store），
    // 只是入口不同：控制面只认本机，移动端认已配对 token。这里的每一项都是本文件已有的
    // 取值器/实例，没有一行实现搬进装配层。
    relayControl: {
      state,
      settings,
      syncSidecar,
      status,
      resolveLanPort,
      lanPortInUse: advertisedLanPort,
      getLanPortAdjusted: () => lanPortAdjusted,
      restartSidecar,
      // **取值器**：sidecar 会被自重启整体替换，存实例就是存一份指向已 stop 的 facade。
      getSidecar: sidecarLifecycle.getSidecar,
      credentials,
      activeGuard,
    },
  })
  ctx.effect(() => {
    const stopWatching = settings.watch(next => {
      Object.assign(state, next)
      core.saveState(state)
      applyServices()
    })
    applyServices()
    return () => {
      stopWatching()
      // 不在这里 `sidecar.stop()`：facade 的生命周期由上面 `${name}: facade sidecar`
      // 那个 effect 独占。两个 effect 都停一次会让 worker 在 dispose 期间收到
      // 两次 stop，第二次撞上已关闭的进程句柄并抛出未捕获异常。
    }
  }, `${name}: services`)
}

export { apply }
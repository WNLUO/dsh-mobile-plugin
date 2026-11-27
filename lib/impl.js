// 2026-11-27：线路级问题码搬进 relay/ingress-guard.cjs，装配层只交现状、不再写判断。
// 2026-11-26：零讯旧隧道落点端口失效时接线层清掉地址，通知 Cloudflare 兜底重新判定顶上。
// 2026-11-25：三条线路的本地端口接上回环入口判据；自检结论记入 ingress-guard，状态带出绕开与兜底原因。
// 热重载跨代：隧道助手/点对点的父地址取值器改为挂载时缓存，回滚或半装载后不再现读失效 ctx.webServer。
// 本次改动：网页版预览的宿主绑定地址随 ctx.webServer.host 传入，老宿主缺省时维持环回行为。
// 兼容服务挂不上时按本代装载失败处理，交给外壳重试，不再静默当成功。
// Cloudflare 兜底隧道：本地装配 cloudflared runner，把快速隧道地址写进独立字段 cloudflareUrl（作为新线路 kind:'cf' 上报，不再写直连格）。
// 身份变更同时迁移三类连接登记，主动重连独立于普通配置同步。
// apiProxy 兼容服务启动即提供（宿主那份晚到则自动接管），会话列表不再在启动瞬间报缺服务。
// 真实监听状态同步总控和穿透，固定入口约束自动换号。
// 配置 schema 与投影拆到 lib/relay/config-store.js，装配层只留装配与状态仓外壳（行数兜底）。
// 装配移动 API、设备吊销与独立直连生命周期，并向本机面板提供真实上报目的地。
/**
 * 插件实现（随包发布的基础代）：装配路由、移动端 API 网关与 sidecar 生命周期。
 * 只做装配——镜像推送在 `lib/mirror/pusher.cjs`、sidecar 生命周期在
 * `lib/sidecar-lifecycle.cjs`、路由表在 `lib/routes/*`，这些实现不许搬回来
 * （`test/assembly-layer.test.cjs` 钉着）。
 */
// 远程电脑入口独立装配，手机端路由与权限保持原有边界。
// 桌面侧边栏两颗图标的显示偏好也落在这份 relay.json 里（默认全开）。
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const core = require('./relay/core.js')
const { RemoteControlSettingsSchema, configOf } = require('./relay/config-store.js')
const pairingApproval = require('./relay/pairing-policy.js')
const { sendJson, sendHtml, htmlEtag } = require('./shared/http-util.js')
// 控制面守卫（localOnly）住外壳的地基里；移动端守卫（guarded）在 lib/mobile/guarded.js（代里），
// 「控制面多挡跨站与 method、移动端只挡 token」这个不对称一眼可见。
const { localOnly, trustedLocalUi, readJson } = require('./http/routing.js')
const { createGuarded } = require('./mobile/guarded.js')
const { registerMobileRoutes } = require('./routes/mobile-api.js')
const { registerControlPlaneRoutes } = require('./routes/control-plane.js')
const { hostMetadata, createStatusView } = require('./relay/status.js')
const { authorized, authOutcome, presentedCredential } = require('./mobile/auth.js')
const permissions = require('./mobile/permissions.js') // 权限位/档位/逐路由所需位（见 lib/mobile/permissions.js）
const { readRawBody } = require('./shared/e2ee-request')
const streamRegistry = require('./mobile/stream-registry.js')
const { viaChannel } = require('./shared/via-header')
const { deviceMetaFromHeaders } = require('./shared/device-headers.js')
const { createSidecarLifecycle, createRouteAdopter, createTunnelReconnector, sidecarFingerprint } = require('./sidecar-lifecycle.cjs')
const { createMirrorPusher } = require('./mirror/pusher.cjs')
const { randomBytes } = require('node:crypto')
const { lanUrls, advertisedCandidates, phoneCandidates, ipv6Candidates, withManualIpv6Candidate, setIpVersionPolicy } = require('./relay/lan-network.cjs')
// 配对二维码的载荷：面板与终端命令共用一份，拼装在 `./relay/pairing-payload.cjs`。
const { pairingPayload, pairingText } = require('./relay/pairing-payload.cjs')
// 总控上报客户端：把本机全部连接地址报给总控、拿回设备令牌（见 lib/relay/control.js）。
const { createControlClient, createAdoptedControlClient, controlFingerprint, CONTROL_BASE_URL } = require('./relay/control.js')
const { mountZeroNews } = require('./zeronews/wiring.cjs')
const { createIdentityRotator } = require('./relay/identity-rotate.cjs')
const { createLanPortPolicy, lanPortLockReason } = require('./relay/lan-port-policy.cjs')
const ingressGuard = require('./relay/ingress-guard.cjs') // 回环入口判据：漂移 / 遮蔽 / 线路落点 / 兜底原因码
const { mountTailcat, tailcatFingerprint } = require('./tailcat/wiring.cjs') // 直连隧道：入口 + 落点代理 + 助手会话 + 启停
const { mountP2P, p2pFingerprint } = require('./p2p/wiring.cjs') // 点对点隧道：助手会话 + 落点代理（连接从隧道里进来，不必开回环门）
// FRP 直连：用面板导入的配置拉起本地 frpc（见 lib/frpc/runner.cjs）。
const { createFrpcRunner, frpcFingerprint } = require('./frpc/runner.cjs')
// Cloudflare 兜底隧道：装配动作在 lib/cloudflared/wiring.cjs（进程在 runner.cjs）。
const { mountCloudflare } = require('./cloudflared/wiring.cjs')
const { createPreviewService } = require('./relay/preview.js')
const { createMuxService, createMuxAuthorizer, muxFingerprint } = require('./mobile/mux.js')
const { mountRemoteComputers } = require('./remote/runtime.cjs')
// 手机打开「电脑上的网页版」时用的那枚一次性登录令牌（见 mobile/host-web.js）。
const hostWeb = require('./mobile/host-web.js')
// 本机设备凭据库：/api/relay/revoke-all 必须同时吊销局域网直连的 dshc_ 凭据，
// 否则「撤销全部授权」只清了中转侧，同网设备仍能用旧凭据直连宿主。
// 入口按两条盘上布局分别找（嵌在插件包内 / 与插件包同级），见 shared/credentials-entry.js。
const credentials = require('./shared/credentials-entry.js').credentialsEntry()
const { createApiProxyService, runtimeProvidesApiProxy } = require('./mobile/host-bridge.js')
const { installApprovalBridge, setPushNotifier: setApprovalPushNotifier } = require('./mobile/approvals.js')
const { installQuestionBridge, setPushNotifier: setQuestionPushNotifier } = require('./mobile/questions.js')
const { createPushNotifier } = require('./mobile/push-notify.js')
const { installNarration } = require('./mobile/narration.js') // 过程播报：默认关，开关真值每步现读
// 「手机上最近来过没有」：守卫记、控制面状态读。单独一个模块，装配层只转交。
const activity = require('./mobile/activity.cjs')
const { installSessionCleanup } = require('./session-cleanup.cjs')
// 统计的定期采集：账本在 mobile/stats-ledger.cjs，采集规则在 stats-collect.cjs，定时器在
// stats-scheduler.cjs —— 装配层只挂一下（按天归属靠的就是这个节奏）。
const statsScheduler = require('./mobile/stats-scheduler.cjs')
// 扩展卡的宿主侧：`extension_present` 工具与卡状态账本（见 mobile/extensions.js）。
const { installExtensions } = require('./mobile/extensions.js')
// 给模型用的工作区 / 会话能力：列、读、发、停、新建与整理（见 mobile/workspace-tools.js）。
const { installWorkspaceTools } = require('./mobile/workspace-tools.js')
// 给模型用的反馈能力：AI 查清问题后直接提交到分发平台（见 mobile/feedback.js）。
const { installFeedback } = require('./mobile/feedback.js')
const { readCapabilityReport } = require('./host-capabilities.cjs')
const { activeGuard } = require('./host-guard.cjs')
// 桌面端侧栏展开态的快照存储。桌面把这份状态只记在浏览器 localStorage 里，宿主必须
// 有一个落盘处：客户端半边（lib/client.js）上报 → 这里 → 移动端读取。

export const name = 'dsh-mobile-plugin'
// 0.2.0 移除了 `settings.register(namespace, schema, { base, applies })` 那套 API，所以不再
// 注入 `settings`：配置改由插件自己的 relay.json 存储负责（见下面 createConfigStore）。
// 0.2.0 里也没有 `apiProxy` 这个服务，宿主 RPC 全走 `typertGateway`；`ctx.apiProxy` 的
// 旧形状由 apply 在本 fiber 上 provide 的兼容桥兜住（fiber.store 里就有，get trap 第一站
// 就命中）。漏了这条分支，读 `ctx.apiProxy` 会抛 "without inject"，服务器宿主上 mirror
// 推送曾整条挂掉。
//
// 只有 `webServer` 是硬依赖：没有它这个插件一行路由都注册不上，等不到就是真的没得做。
//
// 其余服务**一律不写进 inject**，改成用到时 `ctx.get`。cordis 的 inject 是「缺一个就整行
// pending」：`typertGateway` 由后装载的另一行提供、`sessions` 来自别的 bundle，任何一个被
// 别人关掉 / 换掉 / 延迟，注进去的代价都是路由、sidecar、配对、二维码**一起不出现**，日志
// 里只剩一行 pending —— 手机上表现为「装了插件但完全连不上」。
//
// 取不到时如实降级：宿主 RPC 那条回 `host-unavailable`（见 host-bridge/transport.js 的
// gatewayOf，它每次调用都现取），路由、局域网直连、控制面、镜像照常工作。实时流那条在
// 网关永远不出现时保持空闲 + 心跳（`host-stream-unavailable`），下一次重连就会接上。
//
// 旧运行时那一支多一个 `apiProxy`：宿主自己提供它（`@deepseek-ai/dsh-host-apiproxy` 装上
// 了，就一定会被提供），读 `ctx.apiProxy` 必须有 inject，否则 get trap 直接抛。
//
// **但「解析得到那个包」不等于「宿主一定会提供这个服务」**（2026-11-02 反馈 #11）：新版宿主
// 上包名仍然解析得到，服务却已经删了。把 apiProxy 写进 inject 的代价是这一行**永远 pending**
// —— apply 整个不跑，一条路由都不注册，手机上连「装了但连不上」都看不到。所以 inject 只剩
// `webServer`，apiProxy 改由 apply 里按「过一小会儿真服务还没来就自己兜」决定，见下面的装配段。
export const inject = ['webServer']

/**
 * 解析到包之后，等真服务的宽限期。
 *
 * 旧宿主在启动过程中就会 provide 出 apiProxy（本插件通常比它先挂），所以这段时间只用来看
 * 「服务到底来不来」。等不到就说明这是新版宿主：包在、服务没了，必须自己挂兼容桥。
 */
const API_PROXY_GRACE_MS = 3000

export const REMOTE_CONTROL_SETTINGS_NAMESPACE = 'mobile-remote-control'
export { RemoteControlSettingsSchema }

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
      const incoming = patch || {}
      for (const [key, value] of Object.entries(incoming)) {
        if (value === undefined || !(key in next)) continue
        next[key] = value
      }
      // 中转地址那两格要一起收敛：只写 `relayUrl` 而列表原样不动的话，落盘时的清洗会拿旧
      // 列表把新地址盖回去（「改了没生效」且不报错），规则在 `core.applyRelayAddressPatch`。
      core.applyRelayAddressPatch(next, incoming)
      let parsed
      try {
        parsed = RemoteControlSettingsSchema(next)
      } catch (error) {
        throw new Error(`invalid remote-control setting: ${error && error.message ? error.message : String(error)}`)
      }
      core.normalizeRelayAddresses(parsed)
      Object.assign(state, parsed)
      setIpVersionPolicy(state.ipVersionPolicy)
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

// 上报给 App 的候选地址（私网优先、没有私网才退公网）住在 `./relay/lan-network.cjs`
// 的 `advertisedCandidates`：那是地址策略，不是装配。这里只把它转交给三处消费点。
// 「手机上最近来过没有」同理，住在 `./mobile/activity.cjs`（守卫记、控制面状态读）。

function apply(ctx) {
  const hostContext = ctx
  ctx = ctx.isolate('apiProxy')
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
  // —— host-bridge.js 是翻译到 0.2.0 的 `ctx.get('typertGateway')` 的。因为兼容服务建在
  // 本代独立作用域里（`ctx.isolate`），和宿主的根作用域互不冲突，所以可以**启动即提供**，
  // 不必再等宿主那份出现：提供的对象优先取宿主的真 apiProxy，取不到才走兼容桥。
  // 判据仍同源：0.1.x 宿主自带真 apiProxy（审批帧与回答都还走得通），0.2.x 才需要兼容桥，
  // 也才需要审批桥（见 mobile/approvals.js 的文件头）。
  const hasHostApiProxy = runtimeProvidesApiProxy()
  /** 装配层自己的告警出口：拿不到 logger 也照样往下走，不打日志不是失败。 */
  const warn = (message, ...rest) => {
    try { ctx.logger?.warn?.(`${name}: ${message}`, ...rest) } catch { /* 日志本身不许反噬装配 */ }
  }
  /**
   * 每一块装配各自兜住：一块挂不上只留一行日志，剩下的照常启动。
   *
   * 代价说清楚：别人撞了同一个路由、先占了一个服务名，缺的必须是**那一块**，不能是整张
   * 移动 API —— 装配层里一个没兜住的 throw 会让 fiber 回滚，已经注册好的路由一起消失。
   */
  const mount = (label, fn) => {
    try { return fn() } catch (error) {
      warn(`${label} 没有挂上：%s`, error?.message || error)
      return undefined
    }
  }
  // 推送出口与镜像调度器都晚绑定：桥可能早于它们装，建好之后再往里填（标题取调度器的会话名）。
  let pushNotify = null, mirror = null
  const notifyInteraction = (sessionId, card, hints) => { if (pushNotify) { try { void pushNotify.notifyInteraction(sessionId, card, { ...(hints && typeof hints === 'object' ? hints : {}), title: mirror?.sessionTitleOf?.(sessionId) }) } catch { /* ignore */ } } }
  setApprovalPushNotifier(notifyInteraction); setQuestionPushNotifier(notifyInteraction)
  /**
   * 取宿主自己那份 apiProxy（旧运行时）。新版宿主上没有这个服务，取不到就回 null。
   *
   * 必须判 `typeof hostContext.get === 'function'`：老宿主上的 cordis 未必有 `ctx.get`，
   * 裸调会在定时器回调里抛出去（被进程级错误边界吞掉、进程不死），apiProxy 就再也补不上，
   * 手机侧会永久报「without inject」。本文件其它取宿主服务的地方都这么判。
   */
  const hostApiProxy = () => {
    try { return typeof hostContext.get === 'function' ? hostContext.get('apiProxy') : null } catch { return null }
  }
  /**
   * apiProxy **启动即提供**；走宿主真服务还是网关兼容桥由 host-bridge 的 createApiProxyService
   * 推迟到调用那一刻决定。插件刚启动 / 刚换代的瞬间被打到也不会读到「还没提供的服务」，不会抛
   * `cannot get property "apiProxy" without inject`（「加载会话列表失败」就是这条）。
   *
   * 这里刻意**不包 mount 的逐块兜住**：兼容服务没挂上，整张移动端读接口（会话、工作区…）都会
   * 一路 500。此时把这一代当「装载成功」是最坏的结果——外壳专为「apiProxy 晚到」准备的重试/
   * 回退再也触发不了，一次瞬时挂载失败会被固定成永久 500，只能手动重启。所以失败要如实抛出，
   * 让这一代按装载失败处理，交给外壳的重试接上。
   */
  const provideApiProxy = () => ctx.reflect.provide('apiProxy', createApiProxyService(ctx, hostApiProxy))
  /** 两条帧桥（审批 / 提问）：旧宿主自带真服务时由它处理、不装；新版宿主才补上。 */
  const installFrameBridges = () => {
    mount('审批桥', () => ctx.effect(() => installApprovalBridge(ctx), `${name}: host approval bridge`))
    mount('提问桥', () => ctx.effect(() => installQuestionBridge(ctx), `${name}: host question bridge`))
  }
  provideApiProxy()
  if (!hasHostApiProxy) installFrameBridges()
  else {
    // 解析到包只说明「宿主可能是旧版」：新版宿主上包名还在、`apiProxy` 服务已经没了
    // （2026-11-02 反馈 #11）。给它一会儿把真服务 provide 出来；到点还没有，就按新版宿主
    // 补上两条帧桥（apiProxy 本身上面已经提供，届时自动走兼容桥）。
    const timer = setTimeout(() => {
      if (hostApiProxy()) return
      warn('等不到宿主的 apiProxy，按新版宿主装配兼容桥')
      installFrameBridges()
    }, API_PROXY_GRACE_MS)
    timer.unref?.()
    ctx.effect(() => () => clearTimeout(timer), `${name}: host apiProxy grace timer`)
  }

  const state = core.loadState()
  // 先把出站协议族策略设进候选/上报那一层（本进程），httpOnly 时 IPv6 候选从这里起就不产出。
  setIpVersionPolicy(state.ipVersionPolicy)
  // 这台机器上是否还绑着远程电脑：关掉手机「局域网直连」时，只要还有远程电脑，局域网监听口
  // 仍要开着给它们用。启动时从凭据库读一次，之后由 add/remove 回调更新。
  let hasRemoteBindings = false
  try { hasRemoteBindings = credentials.listRemoteComputers(state.instanceId).length > 0 } catch { hasRemoteBindings = false }
  // 生成绑定信息时临时开局域网：第一台电脑绑定前还没有绑定记录，局域网口不会自动开，
  // 邀请里也就带不上内网地址；用户点「生成绑定信息」说明正要绑定，先开一段兜底。
  let inviteLanPending = false
  let inviteLanTimer = null
  // 有效局域网开关：手机自己的选择、还有远程电脑绑着，或正在生成绑定信息。
  const effectiveLanEnabled = () => Boolean(state.lanEnabled) || hasRemoteBindings || inviteLanPending
  function requestLanForInvite(ttlMs) {
    inviteLanPending = true
    clearTimeout(inviteLanTimer)
    inviteLanTimer = setTimeout(() => { inviteLanPending = false; void syncSidecar().catch(() => undefined) }, Math.max(1000, Number(ttlMs) || 10 * 60 * 1000))
    inviteLanTimer.unref?.()
    return Promise.resolve(syncSidecar()).catch(() => undefined)
  }
  // 0.2.0 之前是 `ctx.settings.register(REMOTE_CONTROL_SETTINGS_NAMESPACE,
  // RemoteControlSettingsSchema, { base: configOf(state), applies: 'live' })`，
  // relay.json 是这个命名空间的种子。现在由 createConfigStore 直接以 relay.json
  // 为准（见那里的说明与代价）。
  const settings = createConfigStore(state)
  Object.assign(state, settings.get())
  // 实例历史密钥（HK）的取值器：缺失时惰性生成并落盘（relay.json 单一真源）。配对响应、
  // `/api/mobile/v1/history-key` 与镜像推送三条路共用这一个入口。
  const getHistoryKey = () => core.ensureHistoryKey(state)

  // 原端口优先；只有 worker 已监听并完成本地发布后才采纳新入口。
  const lanPorts = createLanPortPolicy({ state, saveState: core.saveState })
  const lanPortInUse = lanPorts.port
  const resolveLanPort = lanPorts.resolve
  let syncNetwork = () => {}
  let forwardingConfigured = () => false
  const portLock = () => lanPortLockReason(state, forwardingConfigured())
  const onLanState = lan => {
    lanPorts.apply(lan)
    // 专属入口被占后内核另分的端口要落盘；notify:false 只写盘，不再触发一轮重配。
    const ingress = Number(lan?.ingressPort)
    if (Number.isInteger(ingress) && ingress > 0 && state.tunnelIngressPort !== ingress) {
      void settings.update({ tunnelIngressPort: ingress }, { notify: false }).catch(() => undefined)
    }
    syncNetwork()
  }
  const advertisedLanPort = () => sidecarLifecycle.getAdvertisedLanPort()
  // 总控上报客户端：把本机全部地址报给总控，拿回设备令牌交给 APP（见 relay/control.js）。
  // 生命周期挂在下面的 effect 上；配置变更由 applyServices → control.sync() 驱动。
  // 隧道状态取值器在下面 sidecar 装配完成后才拿到，这里先放占位，装配完换成权威那个。
  let relayConnectedOf = () => false
  // 总控上报客户端在 sidecar 装配之后创建（`advertisedLanPort` 依赖 sidecar），见下方。
  // 父进程地址（宿主 web 的端口 / 绑定地址）在这一代挂载时取一次缓存住。下面交给稳定外壳的
  // 隧道助手 / 点对点 provider 取值器会被外壳**跨代**持有并回调：换代回滚或半装载失败时，交出
  // 这些闭包的那一代 ctx 已 inactive，现读 `ctx.webServer` 会抛 "cannot get required service
  // webServer in inactive context"，经 tunnel-forwarder 的 forwardRequest 放大成 Host 致命异常
  // （GitHub issue #42）。宿主 web 端口 / 绑定地址在进程生命周期内固定，缓存值与现读一致。
  const webPortForSidecar = ctx.webServer.port
  const webHostForSidecar = ctx.webServer.host
  let tailcatHost = null
  try { tailcatHost = typeof ctx.get === 'function' ? ctx.get('dshMobileTransportTailcat') || null : null } catch { tailcatHost = null }
  // 直连隧道：优先用稳定外壳持有的那份（换代不重建入口/助手，直连不断）；外壳不在时本地挂载兜底。
  const tailcatProviders = { getState: () => state, saveState: s => core.saveState(s), lanEnabled: () => state.lanEnabled, lanPort: lanPortInUse, webPort: () => webPortForSidecar, webHost: () => webHostForSidecar, hostName: () => state.name }
  const tailcat = tailcatHost && typeof tailcatHost.ensure === 'function'
    ? tailcatHost.ensure({ providers: tailcatProviders, mount: mountTailcat, fingerprint: tailcatFingerprint() })
    : mountTailcat({ mount, warn, state, saveState: core.saveState, lanEnabled: () => state.lanEnabled, lanPort: lanPortInUse, webPort: () => webPortForSidecar, webHost: () => webHostForSidecar, hostName: () => state.name, ctx, name })
  let p2pHost = null
  try { p2pHost = typeof ctx.get === 'function' ? ctx.get('dshMobileTransportP2P') || null : null } catch { p2pHost = null }
  // 点对点隧道：优先用稳定外壳持有的那份（换代不重建助手/落点，直连不断）；外壳不在时本地挂载兜底。
  const p2pProviders = { getState: () => state, saveState: s => core.saveState(s), localPort: lanPortInUse, lanEnabled: () => state.lanEnabled, lanPort: lanPortInUse, webPort: () => webPortForSidecar, webHost: () => webHostForSidecar }
  const p2p = p2pHost && typeof p2pHost.ensure === 'function'
    ? p2pHost.ensure({ providers: p2pProviders, mount: mountP2P, fingerprint: p2pFingerprint() })
    : mountP2P({ mount, warn, state, saveState: core.saveState, localPort: lanPortInUse, lanEnabled: () => state.lanEnabled, lanPort: lanPortInUse, webPort: () => webPortForSidecar, webHost: () => webHostForSidecar, ctx, name })
  // 回环入口判据：漂移沿用端口策略已有的账，遮蔽只看自检记进来的结论（探测失败不算证据）。
  const ingressSignals = () => ingressGuard.signalsOf({
    requestedPort: state.lanPort, boundPort: lanPortInUse(),
    drifted: lanPorts.adjusted(), loopbackBlocked: ingressGuard.snapshot().state === 'blocked',
  })
  const tunnelPortFor = provider => ingressGuard.tunnelPortOf({
    ingressPort: ingressGuard.ingressPortOf(state), lanPort: lanPortInUse(),
    signals: ingressSignals(), provider,
  })
  // 有没有**别的**公网线路：兜底隧道自己那条不算。判「要不要再起一条兜底」只能用它，
  // 否则 Cloudflare 一拿到地址就被自己算成「已有线路」，刚起就停、来回抖。
  const hasOtherRoute = () => Boolean(state.frpUrl || state.zeroNewsUrl || state.jdxbUrl || state.customRoutes?.length)
    || relayConnectedOf() || tailcat?.status?.()?.ready === true || p2p?.status?.()?.ready === true
  // 面板那个原因码用这一份：兜底已经顶上了就不该再报「还有问题让用户处理」。
  const hasUsableRoute = () => hasOtherRoute() || Boolean(state.cloudflareUrl)

  // sidecar 子进程的全部生命周期：起停、配置下发、自重启、健康轮询。
  // **传输进程归稳定外壳**：优先取外壳持有的那份（换代时它不重启，隧道跨代存活）；外壳不在
  // （实现被单独挂载 / 测试）时退回本地创建，行为与从前一致。配置由这一代组装后交给它。
  // 下发配置的闭包同样会被外壳持有的 sidecar 跨代调用，沿用上面挂载时缓存的父端口 / 绑定地址，
  // 免得本代 ctx 已 inactive 时现读 ctx.webServer 抛错，把重启与配置下发全打挂（隧道、frpc、P2P）。
  const buildSidecarConfig = (lanPort) => ({ enabled: state.enabled, relayUrl: state.relayUrl, relayUrls: core.relayAddressesOf(state).relayUrls, instanceId: state.instanceId, previousInstanceId: state.previousInstanceId || '', pairingCode: state.pairingCode, pairingTicket: state.pairingTicket || '', pairingTier: permissions.isKnownTier(state.pairingTier) ? state.pairingTier : permissions.DEFAULT_TIER, name: state.name, upstreamPort: webPortForSidecar, upstreamHost: webHostForSidecar, lanPort, lanPortLockReason: portLock(), lanEnabled: effectiveLanEnabled(), lanSecret: state.lanSecret, registerSecret: state.registerSecret, tunnelIngressPort: state.tunnelIngressPort || 0, ipVersionPolicy: state.ipVersionPolicy })
  let hostedSidecar = null
  try { hostedSidecar = typeof ctx.get === 'function' ? ctx.get('dshMobileSidecarHost') || null : null } catch { hostedSidecar = null }
  // pluginLibDir 显式传本代目录（re-fork 前清的是正在跑的这份缓存）；buildConfig 字段集是 worker 启动契约
  // （pairingTicket/pairingCode 必传，漏了局域网配对会报错）。token 由外壳跨代给同一份。
  const makeSidecarLifecycle = ({ token } = {}) => createSidecarLifecycle({ ctx, lanPortInUse, resolveLanPort, onLanState, pluginLibDir: path.dirname(fileURLToPath(import.meta.url)), buildConfig: buildSidecarConfig, token })
  const sidecarLifecycle = !hostedSidecar ? makeSidecarLifecycle()
    : typeof hostedSidecar.adopt === 'function' ? hostedSidecar.adopt({ fingerprint: sidecarFingerprint(), create: makeSidecarLifecycle })
      : (hostedSidecar.lifecycle || hostedSidecar)
  // 把这一代的配置来源交给 sidecar（外壳持有的那份也走这里）。换代时新的一代重新注入，
  // 之后补推配置因签名不变不会重建隧道——连接不断。
  if (typeof sidecarLifecycle.setProviders === 'function') {
    sidecarLifecycle.setProviders({
      buildConfig: buildSidecarConfig,
      lanPortInUse,
      resolveLanPort,
      onLanState,
      pluginLibDir: path.dirname(fileURLToPath(import.meta.url)),
    })
  }
  const { sidecarToken, syncSidecar, restartSidecar, tunnelConnected } = sidecarLifecycle
  const reconnectTunnel = createTunnelReconnector(sidecarLifecycle, async () => { await resolveLanPort(); return buildSidecarConfig(lanPortInUse()) })
  relayConnectedOf = tunnelConnected

  // 身份冲突时换身份：实现在 relay/identity-rotate.cjs，装配层只把它挂上（含重入保护）。
  // 换号后把本机签发的设备凭据整体迁到新号（凭据库归本进程），否则换第二次会甩下更早配对的手机。
  const rotateNow = createIdentityRotator({ state, rotateIdentity: core.rotateIdentity, saveState: core.saveState, syncSidecar, syncControl: () => control.sync(), migrateCredentials: (toId) => credentials.reassignInstance(toId), migrateConnections: (fromId, toId) => { streamRegistry.reassignInstance(fromId, toId); preview.reassignInstance(fromId, toId); if (typeof mux.reassignInstance === 'function') mux.reassignInstance(fromId, toId); else mux.dropAll?.() } })

  // 总控上报：优先用**稳定外壳**持有的那份（换代不断开上报连接）；外壳不在时本地创建兜底。
  // getPort 依赖上面刚就位的 sidecar/advertisedLanPort，所以放在这里建。
  let controlHost = null
  try { controlHost = typeof ctx.get === 'function' ? ctx.get('dshMobileTransportControl') || null : null } catch { controlHost = null }
  // 总控转达的「请自检」要回的那份诊断：实例在移动端路由表里造（同一份内容，不另算一套），
  // 这里先留一个取值器，路由装好之后才接上。
  let relayDiagnosticsOf = null
  const controlDiagnostics = () => (typeof relayDiagnosticsOf === 'function' ? relayDiagnosticsOf() : null)
  const control = controlHost && typeof controlHost.adopt === 'function' ? controlHost.adopt({ fingerprint: controlFingerprint(), create: store => createAdoptedControlClient(store) }) : controlHost && controlHost.client ? controlHost.client : createControlClient({
    state,
    persist: () => core.saveState(state),
    getPort: advertisedLanPort,
    getHistoryKey: () => core.ensureHistoryKey(state),
    getRelayConnected: () => relayConnectedOf(),
    getConnectedRelay: () => { const tunnel = sidecarLifecycle.getSnapshot()?.tunnel; return tunnel?.state === 'connected' ? tunnel.relayUrl || tunnel.route?.url || '' : '' },
    getDiagnostics: controlDiagnostics, getProviderLines: require('./relay/provider-lines.cjs').providerLinesOf, getLanTools: require('./relay/lan-network.cjs'),
    log: warn,
    onIdentityConflict: rotateNow,
  })
  if (controlHost && controlHost.client && typeof controlHost.setProviders === 'function') {
    controlHost.setProviders({
      getState: () => state,
      persist: () => core.saveState(state),
      getPort: advertisedLanPort,
      getHistoryKey: () => core.ensureHistoryKey(state),
      getRelayConnected: () => relayConnectedOf(),
      getConnectedRelay: () => { const tunnel = sidecarLifecycle.getSnapshot()?.tunnel; return tunnel?.state === 'connected' ? tunnel.relayUrl || tunnel.route?.url || '' : '' },
      getDiagnostics: controlDiagnostics, getProviderLines: require('./relay/provider-lines.cjs').providerLinesOf, getLanTools: require('./relay/lan-network.cjs'),
      onIdentityConflict: rotateNow,
    })
  }

  // iOS / APNs 推送出口（完成/失败 + 审批/提问卡）：直接请求总控，中转不再管推送。
  // 鉴权用本机那枚总控设备令牌；还没拿到令牌（没连过总控）就不发，下次收尾再试。
  pushNotify = createPushNotifier({
    controlTarget: () => (state.controlToken && state.instanceId
      ? { baseUrl: CONTROL_BASE_URL, token: state.controlToken, instanceId: state.instanceId }
      : null),
    workspaceIdOf: ({ sessionId }) => require('./mobile/workspace-id.js').workspaceIdOf(ctx, { sessionId }),
  })
  // 镜像推送调度器：会话事件立即推，后台循环每个 tick 补推一个冷会话；凭据摘要由装配层给取值器（凭据库归本进程），中转靠它认离线缓存的读者。
  mirror = createMirrorPusher({ ctx, tunnelConnected, getSidecar: sidecarLifecycle.getSidecar, lastMobileAt: activity.snapshot, credentialDigests: () => credentials.activeDigests(state.instanceId), getHistoryKey, notifyTurnEnded: pushNotify.notifyTurnEnded })
  // 隧道刚连上时补推一次全量：未连通期间每轮推送都被 worker 以 503 拒绝。
  // 换线/连上后立刻把新地址报给总控：手机连不上时能马上查到本机挂在哪台中转后面，别等 60 秒心跳。
  const offTunnelUp = sidecarLifecycle.onTunnelUp(() => {
    void mirror.pushMirror()
    try { control.sync() } catch {}
  })
  // 择路选中了一条不是队首的地址 → 写回 `relay.json`（规则与理由见 sidecar-lifecycle 的 createRouteAdopter）。
  // 写回之后同样立刻把新地址报给总控，别等 60 秒心跳。
  const adoptRoute = createRouteAdopter({ state, settings, warn })
  const offRouteAdopted = sidecarLifecycle.onRouteAdopted((route) => {
    Promise.resolve(adoptRoute(route)).finally(() => { try { control.sync() } catch {} })
  })
  // 外壳持有传输进程时，订阅要随这一代退订：否则换代后旧的 mirror/control 闭包还挂在
  // 宿主订阅表里，隧道再连上会把已卸载对象当活的用。换代不 stop 隧道，只退订「这一代的东西」。
  ctx.effect(() => () => {
    try { if (typeof offTunnelUp === 'function') offTunnelUp() } catch { /* ignore */ }
    try { if (typeof offRouteAdopted === 'function') offRouteAdopted() } catch { /* ignore */ }
  }, `${name}: sidecar host subscriptions`)

  if (hostedSidecar) {
    // 启动幂等：首次由外壳那份 boot 完成（自带一次 sync）；换代再调只补推配置，因配置签名不变
    // worker 不会重建隧道——连接因此不断。
    const wasStarted = typeof sidecarLifecycle.isStarted === 'function' ? sidecarLifecycle.isStarted() : false
    sidecarLifecycle.start()
    if (wasStarted) void syncSidecar().catch(() => undefined)
  } else {
    mount('sidecar', () => ctx.effect(() => sidecarLifecycle.start(), `${name}: facade sidecar`))
  }
  // 总控上报：启用时连上去报地址，停用时断开。与 sidecar 各自独立，报的是本机地址不是隧道。
  if (!(controlHost && controlHost.client)) {
    mount('总控上报', () => ctx.effect(() => {
      control.start()
      return () => control.stop()
    }, `${name}: control client`))
  }
  mount('镜像推送', () => ctx.effect(() => mirror.start(), `${name}: mobile mirror sync`))

  // ZeroNews 线路：二进制获取、浏览器登录、建隧道与写回都在 wiring/runner/provision，装配层只挂一下。
  const zeroNews = mountZeroNews({ mount, settings, getState: () => state, control, warn, ctx, name, portOf: () => tunnelPortFor('zeronews'), onRouteStale: () => cloudflare?.reconcile?.() })
  // ZeroNews 状态 / 连接 / 断开给面板（见 lib/zeronews/wiring.cjs）。

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
  ctx.effect(() => {
    // 与上面两块同一口径：没有 tools 注入的 profile 只少这个工具。
    try { installWorkspaceTools(ctx) } catch (error) {
      if (!String(error).includes('without inject')) throw error
    }
    return undefined
  }, `${name}: workspace tool`)
  // 反馈工具：设备身份从凭据库取（手机每条请求都上报，宿主写回记录），提交到分发平台。
  // hostVersion 从同进程的宿主版本台账取（host.js 启动时写入），作为 Harness 版本上报。
  // 用 `ctx.inject` 挂一个等 `tools` 的子作用域，而不是直接 `ctx.get('tools')` 注册：注册记在
  // 这个子 fiber 名下，热重载换代时随旧代卸掉。直接注册只记在共享的服务上，下一次重载会被
  // 判「dsh_feedback 已经注册过」而整代装载失败。
  mount('反馈工具', () => ctx.inject(['tools'], (scoped) => {
    try { installFeedback(scoped, { credentials, instanceId: () => state.instanceId, hostVersion: () => readCapabilityReport()?.runtimeVersion || '' }) } catch (error) {
      if (!String(error).includes('without inject')) throw error
    }
  }))
  mount('统计采集', () => ctx.effect(() => statsScheduler.start(ctx), `${name}: stats collect`))
  mount('过程播报', () => ctx.effect(() => installNarration(ctx), `${name}: process narration`))

  const status = createStatusView({
    state,
    webServerPort: ctx.webServer.port,
    getSidecarSnapshot: sidecarLifecycle.getSnapshot,
    lanPortInUse: advertisedLanPort, // 手机该拨的端口：sidecar 实绑值
    getLanPortAdjusted: lanPorts.adjusted,
    getSidecarState: sidecarLifecycle.getState,
    getSidecarRestarts: sidecarLifecycle.getRestarts,
    getSidecarRestartedAt: sidecarLifecycle.getRestartedAt,
    getSidecarRestartError: sidecarLifecycle.getRestartError,
    getLanRecovery: lanPorts.recovery,
    getMirrorPush: mirror.getMirrorPush,
    // 直连隧道那一格：手机轮询 `/status` 时据此自己把通道加进来。
    getTailcat: () => (tailcat ? tailcat.status() : null),
    // 点对点隧道那一格：手机轮询 `/status` 时据此把这条通道也算进来。
    getP2P: () => (p2p ? p2p.status() : null),
    // 总控上报当前状态（地址、令牌、连没连上）：手机据此知道该不该、能不能去总控查。
    getControl: () => control.snapshot(),
    getLanPortLock: portLock,
    // 面板 / 手机读到的入口全景：实绑入口、是否被绕开、冲突类型、兜底原因码与线路级问题。
    // routeIssue 与 fallbackReason 分开：后者说「兜底也顶不上、要用户接着处理」，前者只说
    // 「这条线路自己落点不对」——兜底已经顶上时也要让用户看见旧隧道该去哪改。判据在 ingress-guard。
    getIngressView: () => {
      const signals = ingressSignals()
      const ingressPort = ingressGuard.ingressPortOf(state)
      const { fallbackReason, routeIssue } = ingressGuard.routeIssueOf({
        signals, ingressPort, hasUsableRoute: hasUsableRoute(),
        cloudflareAvailable: cloudflare.status().available === true,
        portLocked: Boolean(portLock()), externalTarget: portLock() === 'forwarding',
        provider: state.zeroNewsUrl ? 'zeronews' : '', hasLegacyTunnel: Boolean(state.zeroNewsUrl),
        legacyTunnelPort: tunnelPortFor('zeronews'),
      })
      return { ingressPort, bypassing: signals.needsBypass, conflict: signals.conflict,
        fallbackReason, routeIssue }
    },
  })
  function applyServices() {
    control.sync()
    void syncSidecar().catch(() => undefined)
  }
  /**
   * 一条路由挂不上只丢这一条。
   *
   * `webServer.register` 对重复地址是抛错（另一个插件用了同一个路径、上一代没卸干净都在
   * 这一类），而这个调用本来就在 effect 里 —— 让它抛出去会把整个 fiber 带走，连已经挂上
   * 的几百条一起消失。所以这里逐条兜住，日志里留下路径，别让手机端拿到一片 404。
   */
  const mountRoute = (route, upgrade) => mount(`路由 ${route.path}`, () => ctx.effect(() => {
    try { return upgrade ? ctx.webServer.registerUpgrade(route) : ctx.webServer.register(route) } catch (error) {
      warn('路由 %s 没挂上：%s', route.path, error?.message || error)
      return () => {}
    }
  }, `${name}: ${route.path}`))
  function registerRoute(route) {
    mountRoute(route)
  }

  // FRP 直连：用导入的配置拉起本地 frpc。端口每次启动都按插件的实绑端口对齐；宿主重启时
  // 若上次是启用状态就自动再拉起。**进程归稳定外壳**：换代不重启 frpc，直连不断；外壳不在
  // （实现被单独挂载 / 测试）时本地创建兜底，行为与从前一致。端口来源交回外壳，换代只更新它。
  let frpHost = null
  try { frpHost = typeof ctx.get === 'function' ? ctx.get('dshMobileTransportFrp') || null : null } catch { frpHost = null }
  const frpRunner = frpHost && typeof frpHost.adopt === 'function' ? frpHost.adopt({ fingerprint: frpcFingerprint(), create: createFrpcRunner }) : createFrpcRunner({ portOf: () => tunnelPortFor('frp') })
  // 兜底只在「需要绕开且没有别的公网线路」时由 wiring 自动起；落点同样走判据给出的端口。
  const cloudflare = mountCloudflare({ mount, warn, state, settings, portOf: () => tunnelPortFor('cloudflare'), signals: ingressSignals, hasUsableRoute: hasOtherRoute, ctx, name })
  forwardingConfigured = () => frpRunner.shouldAutoStart()
  syncNetwork = () => {
    control.sync()
    void frpRunner.syncLocalPort?.().catch(warn)
    void cloudflare.syncLocalPort?.().catch(warn)
  }
  syncNetwork()
  if (frpHost && typeof frpHost.setPortProvider === 'function') frpHost.setPortProvider(() => tunnelPortFor('frp'))
  mount('frpc 公网地址', () => ctx.effect(() => {
    if (typeof frpRunner.setAddressListener !== 'function') return () => {}
    const publish = async (address, isCurrent) => {
      if (isCurrent && !isCurrent()) return
      if (!address || state.frpUrl === address) return
      // FRP 是一条独立线路：地址只写进 `frpUrl`。
      // 「TCP 直连」是**用户自己配的**那一格，任何线路都不许往里写 —— 连清理也不行：
      // 用户可能就是要用它拨同一个目标，界面替他做主等于把他的配置删掉。
      await settings.update({ frpUrl: address })
    }
    frpRunner.setAddressListener((address, isCurrent) => publish(address, isCurrent))
    // 就地重载时 frpc 往往已经在跑（进程归外壳），这一代不会再发现一次：先拿它此刻的地址补上，
    // 否则重载到下一次重启之间，手机上会少掉 FRP 这条线路。
    const now = typeof frpRunner.status === 'function' ? frpRunner.status() : null
    if (now && now.running && now.remoteAddress) void publish(now.remoteAddress)
    return () => frpRunner.setAddressListener(null)
  }, `${name}: frpc address`))
  if (!(frpHost && frpHost.runner)) {
    mount('frpc 直连进程', () => ctx.effect(() => {
      if (frpRunner.shouldAutoStart()) void frpRunner.start()
      return () => { void frpRunner.dispose() }
    }, `${name}: frpc runner`))
  }

  // closed按唯一连接计数；仅承载本次回执的mux由service有界排空后关闭。
  const dropDeviceStreams = (deviceId, res) => {
    return streamRegistry.drop(deviceId, state.instanceId)
      + preview.dropDevice(deviceId, state.instanceId)
      + (mux.dropDevice?.(deviceId, state.instanceId, res) || 0)
  }
  const dropAllDeviceStreams = (res) => streamRegistry.dropAll(state.instanceId) + preview.dropAll(state.instanceId) + (mux.dropAll?.(state.instanceId, res) || 0)

  mount('控制面路由', () => registerControlPlaneRoutes({
    registerRoute,
    // 更新的机制住在外壳（`lib/index.js`）里，代这边只把它开成本机接口。取不到就如实报
    // 不可用（`lib/impl.js` 被单独挂载时就是这样）。
    getPluginRuntime: () => (typeof ctx.get === 'function' ? ctx.get('dshMobilePluginRuntime') : null),
    localOnly, trustedLocalUi,
    readJson,
    sendJson,
    // 面板页（lib/panel/index.html）整页吐给浏览器用；与控制面其它响应一样按注入传，不在这里 require，路由表才保持「只依赖注入项」。
    sendHtml,
    htmlEtag,
    state,
    sidecarToken,
    status,
    settings,
    syncSidecar,
    reconnectTunnel,
    // ⚠️ 必须传取值器：sidecar 会被自重启整体替换，传实例就是一份永远指向旧 facade 的快照。
    getSidecar: sidecarLifecycle.getSidecar,
    credentials,
    activeGuard,
    resolveLanPort,
    lanPortInUse: advertisedLanPort, // 二维码里的端口也必须是实绑值
    getLanPortAdjusted: lanPorts.adjusted,
    // 自检把回环判据记进 ingress-guard；巡检判定变了就立即让总控重报当前线路。
    noteLoopbackVerdict: ingressGuard.noteLoopback,
    onIngressVerdictChanged: () => { control.sync(); void syncSidecar().catch(() => undefined); void cloudflare.reconcile?.().catch(() => undefined) },
    pairingPayload,
    // 直连隧道：二维码要多带一段「去这个一次性节点换正式地址」，状态接口要多一行。
    tailcat,
    // 点对点隧道：二维码要多带一段「电脑的公钥与打洞候选」，配对后两端各持一半。
    p2p,
    // FRP 直连：导入配置后的启停与运行状态（见 lib/frpc/runner.cjs）。
    frp: frpRunner,
    // Cloudflare 兜底隧道：面板开关/状态用（见 lib/cloudflared/wiring.cjs）。
    cloudflare,
    // ZeroNews 线路：面板连接/断开与状态用（见 lib/zeronews/wiring.cjs）。
    zeroNews,
    getControlTargetUrl: () => control.targetUrl,
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
    dropDeviceStreams,
    dropAllDeviceStreams,
  }))


  /**
   * 协议 v2 信封的宿主侧钩子（§8.3(4)）。
   *
   * `keyFor` 按 **keyId** 查密钥，不按 deviceId：后者是手机自填的，克隆/迁移后会撞，
   * 撞了就变成「两台手机能用同一把密钥验签」。凭据库是唯一的密钥来源，而它只在宿主
   * 主进程里可写。
   */
  const envelope = {
    keyFor: (keyId) => {
      const live = credentials.findByKeyId(state.instanceId, keyId)
      if (live) return live
      // 换身份的过渡期：还没换过来的手机仍按旧号的 keyId 签名。
      const prev = typeof state.previousInstanceId === 'string' ? state.previousInstanceId : ''
      return prev ? credentials.findByKeyId(prev, keyId) : null
    },
    readBody: (req) => readRawBody(req),
  }
  const guarded = createGuarded(ctx, authOutcome, activity.note, {
    onAuthorized: (req) => {
      const presented = presentedCredential(req)
      if (!presented) return
      const record = credentials.lookup(presented, state.instanceId)
      if (record) {
        credentials.touch(record, { channel: viaChannel(req), meta: { ...deviceMetaFromHeaders(req), lanDiscovery: req.headers?.['x-dsh-lan-discovery'] === '1' ? 1 : 0 } })
        lanPorts.noteAuthorized(req, viaChannel(req))
      }
    },
    envelope,
    permission: { resolve: permissions.resolvePermission, has: permissions.hasPermission }, // 逐路由按设备权限子集校验
  })

  // 内置浏览器预览的宿主端：手机按端口在它自己的环回上监听，把内置浏览器写下的原始
  // 字节通过 WebSocket 送到这里，这里与 `127.0.0.1:<port>` 对搬。
  //
  // `protectedPorts` 是取值器而不是快照：局域网端口会在运行中被自适应改掉
  // （见上面的 resolveLanPort），快照会让这道边界跟着失效。DSH 自身的 web 端口
  // （`ctx.webServer.port`，默认 3080）也从这里按身份排掉——预览这条管道刻意不做
  // 「把桌面端 GUI 搬进手机」这件事。
  //
  // `ownWebPort` 是同一条边界上的唯一例外：用户显式要求手机能打开网页版（2026-11-03），
  // 所以 `mode=webapp` 那一档只放行这一个端口（目标主机还得是环回或宿主绑定地址）。同样用取值器。
  // `ownWebHost` 跟随宿主实际绑定地址：网页版管道必须拨它，否则宿主绑在局域网地址上时手机侧两发拨空。
  const preview = createPreviewService({
    authorized: (req) => {
      const outcome = authOutcome(req)
      if (!outcome.ok) return false
      req.__dshRecord = outcome.record
      req.__dshInstanceId = state.instanceId
      return true
    },
    protectedPorts: () => {
      const ports = new Set([ctx.webServer.port, lanPortInUse()])
      ports.delete(0)
      return ports
    },
    ownWebPort: () => ctx.webServer.port,
    ownWebHost: () => ctx.webServer.host,
    permission: permissions.createUpgradePermission({ credentials, instanceId: state.instanceId, presentedCredential }),
    onLog: (message) => ctx.logger?.info?.(`${name}: %s`, message),
  })
  ctx.effect(() => () => preview.close(), `${name}: preview pipes`)

  // 对话页长连接（mux）：一条手机 WS 上按 id 多路复用，逐条转成本地回环请求打到移动 API。
  // 升级先验设备凭据与查看权限；当前authorizer也覆盖外壳仍持旧service的热换代，逐路由仍由guarded判。
  // mux 只是搬运工，不另立权限面。帧契约见 `docs/mux-long-connection-design.md` §11。
  const muxAuthorize = createMuxAuthorizer(authOutcome)
  // mux 优先用**稳定外壳**持有的那份（换代时已建立的手机 WS 不断）；外壳不在时本地创建兜底。
  // 升级路由由外壳直接挂（见 shell/transport-host.js），这一代不再重复注册。
  let muxHost = null
  try { muxHost = typeof ctx.get === 'function' ? ctx.get('dshMobileTransportMux') || null : null } catch { muxHost = null }
  const mux = muxHost && typeof muxHost.adopt === 'function' ? muxHost.adopt({ fingerprint: muxFingerprint(), create: createMuxService }) : muxHost && muxHost.service ? muxHost.service : createMuxService({
    upstream: { host: ctx.webServer.host, port: ctx.webServer.port },
    authorize: muxAuthorize,
    onLog: (message) => ctx.logger?.info?.(`${name}: %s`, message),
  })
  if (muxHost && muxHost.service && typeof muxHost.setProviders === 'function') muxHost.setProviders({ authorize: muxAuthorize })
  const muxOwnedByShell = Boolean(muxHost && muxHost.service)

  // 远程电脑绑定增减后重算标志；变了就让 sidecar 跟着开/关局域网监听口（有绑定就保留）。
  async function syncLanBindings() {
    let next = hasRemoteBindings
    try { next = credentials.listRemoteComputers(state.instanceId).length > 0 } catch { next = hasRemoteBindings }
    if (next === hasRemoteBindings) return
    hasRemoteBindings = next
    await syncSidecar().catch(() => undefined)
  }

  const remoteComputers = mount('远程电脑', () => mountRemoteComputers({ ctx, state, credentials, registerRoute, lanPortInUse: advertisedLanPort, tailcat, p2p, lanAvailable: effectiveLanEnabled, onBindingsChanged: syncLanBindings, onInvite: requestLanForInvite, log: warn }))

  // 移动端路由表在 lib/routes/mobile-api.js：那里是一张可以对着 App 侧 apiPaths.ts
  // 核对的「路径 → handler」表，不用在 1000 行装配代码里翻。
  mount('移动端路由', () => registerMobileRoutes({
    registerRoute,
    // 同一份诊断的第二个出口（总控转达的「请自检」）：拿到实例就接到上面那个取值器上。
    bindRelayControl: (handlers) => { relayDiagnosticsOf = handlers && typeof handlers.diagnostics === 'function' ? handlers.diagnostics : null },
    remoteComputers,
    // 直连隧道：已配对的手机走这条拿到自己的入口地址，不用重新扫码。
    tailcat,
    // 点对点隧道：会合那一步（手机报上候选、这里把它拉起来并回自己的候选）。
    p2p,
    // Cloudflare 兜底隧道：`/status` 心跳里那一格取的就是它的 `status()`（与面板
    // `/api/relay/status` 同一个取值器）。少了这一格，手机永远按「没有这条线路」画。
    cloudflare,
    // 预览是 WebSocket 升级路由，走的是 webServer 的另一套名字空间；与 registerRoute
    // 一样必须包在 ctx.effect 里，否则插件重载时重复注册会直接抛错。
    registerUpgradeRoute: (route) => mountRoute(route, true),
    preview,
    mux,
    muxOwnedByShell,
    // 网页版登录令牌那条：handler 在这里造好、按依赖交给路由表，理由与 preview 一样——
    // 它要读的是本进程的 `ctx.webServer` 与 `ctx.get('connection')`。
    hostWeb: hostWeb.handleHostWeb,
    guarded,
    state,
    // 总控上报状态取值器：`/api/mobile/v1/status` 把它挂在心跳上，APP 据此拿令牌去查地址。
    getControl: () => control.snapshot(),
    hostMetadata,
    // 「这台电脑上还连着哪些手机」的两条路由（见 mobile/paired-devices.js）：凭据库真源 +
    // 吊销时收掉被踢设备在途的 SSE。
    credentials,
    dropDeviceStreams,
    dropAllDeviceStreams,
    // 取值器而非快照对象：snapshot 会被 applySidecarConfig 整体替换，闭包捕获对象会让
    // 连接信息永远停在进程启动那一刻。
    getSidecarSnapshot: sidecarLifecycle.getSnapshot,
    // 移动端那边的「局域网候选」：私网优先的清单 + 用户手填的直连地址（网卡扫不出的域名）。
    safeLanCandidates: (port) => phoneCandidates(advertisedCandidates(port), { manual: state.manualLanUrl }),
    // IPv6 直连候选单独一份：App 拿它单开一条通道、和公网中转比速度，不掺进上面那份的排序。
    // 手填的那条同样缀在最后（只追加、不删网卡候选），手机每次核对连接信息都重新拿到它。
    safeIpv6Candidates: (port) => withManualIpv6Candidate(ipv6Candidates(port), state.manualIpv6Url),
    lanPortInUse: advertisedLanPort, // LAN 候选用实绑端口
    // 配对那条路由自己要签凭据：core 是签 token 的实现，pairingApproval 决定这台机器
    // 收不收新设备（'deny' 时一律拒）。两者本文件都已有，透传给移动端路由。
    core,
    pairingApproval,
    // 配对成功之后换码 + 换票据（§5.1）：状态变更在 core 里，这里只补「让旁路重读」。
    rotatePairing: () => { core.rotatePairing(state); applyServices() },
    // 历史 blob 的实例密钥（HK）：配对封包与 `/api/mobile/v1/history-key` 都从这里取。
    getHistoryKey,
    // 「这台设备的中转与连接配置」那十条（见 lib/mobile/relay-control.js）。
    // 它们与控制面 `/api/relay/*` 写的是**同一份** relay.json（同一个 `settings` store），
    // 只是入口不同：控制面只认本机，移动端认已配对 token。这里的每一项都是本文件已有的
    // 取值器/实例，没有一行实现搬进装配层。
    relayControl: {
      state,
      settings,
      syncSidecar,
      reconnectTunnel,
      status,
      resolveLanPort,
      lanPortInUse: advertisedLanPort,
      getLanPortAdjusted: lanPorts.adjusted,
      restartSidecar,
      // **取值器**：sidecar 会被自重启整体替换，存实例就是存一份指向已 stop 的 facade。
      getSidecar: sidecarLifecycle.getSidecar,
      credentials,
      activeGuard,
      dropDeviceStreams,
      dropAllDeviceStreams,
      // 「立即同步」（POST /relay/control-sync）：催一发上报、读它的快照、以及它此刻会报上去的
      // 那份明文清单。三样都取自同一个 control 客户端，不另算一套（见 lib/relay/control.js）。
      getControl: () => control.snapshot(),
      syncControl: () => control.sync(),
      controlAddresses: () => control.addresses(),
      // 让「立即同步」在电脑端把总控存的那份也解开一并回给手机（见 relay-control.handleControlSync）。
      getHistoryKey,
    },
  }))
  mount('服务同步', () => ctx.effect(() => {
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
  }, `${name}: services`))
}

export { apply }
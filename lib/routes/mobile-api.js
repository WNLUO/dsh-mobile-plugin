'use strict';

/**
 * 移动端 API 路由表（`/api/mobile/v1/*`）。
 *
 * 它本身没有逻辑，绝大部分是「路径 → 已写好的 handler」的纯映射，只有 status /
 * connection-info / desktop-view 三条带一点内联逻辑。抽成一张表，是为了能一眼确认「App 打的
 * 某个地址到底注册没有」——历史上 `workspace/rename` 与 `workspace/archive-session` 就是
 * App 一直在打、插件从来没注册，手机端必然 404；这张表也能直接对着 App 侧 apiPaths.ts 核对。
 *
 * 依赖注入只留注册器、移动端守卫与几个收益于取值器的值；handler 们直接 require。
 */

const { sendJson } = require('../http/routing.js');
const { readJsonBody } = require('../shared/http-util.js');
const { orderCandidates, withManualCandidate, withManualIpv6Candidate } = require('../relay/lan-network.cjs');

const sessions = require('../mobile/sessions.js');
const sessionModelOptions = require('../mobile/session-model-options.js');
const sessionFile = require('../mobile/session-file.js');
const sessionLocalImage = require('../mobile/session-local-image.js');
const { promoReceiver: promoReceiverCoords } = require('../mobile/promo-receiver.cjs');
const sessionStep = require('../mobile/session-step.js');
const fileRead = require('../mobile/file-read.js');
const stats = require('../mobile/stats.js');
const agentPresets = require('../mobile/agent-presets.js');
const stream = require('../mobile/stream.js');
const events = require('../mobile/events.js');
const questions = require('../mobile/questions.js');
const approvals = require('../mobile/approvals.js');
const workspaces = require('../mobile/workspaces.js');
const directoryListing = require('../mobile/directory-listing.js');
const archiveClean = require('../mobile/archive-clean.js');
const sessionLog = require('../mobile/session-log.js');
const hostSettings = require('../mobile/host-settings.js');
const channels = require('../mobile/channels.js');
const modelCaps = require('../mobile/model-caps.js');
const deepSeekAccount = require('../mobile/deepseek-account.js');
const magpieWeb = require('../mobile/magpie-web.js');
const skills = require('../mobile/skills.js');
const mobileCredentials = require('../mobile/credentials.js');
const subagents = require('../mobile/subagents.js');
const monitor = require('../mobile/monitor.js');
const references = require('../mobile/references.js');
const schedule = require('../mobile/schedule.js');
const pushNotifyRoute = require('../mobile/push-notify-route.js');const plugins = require('../mobile/plugins.js');
const pluginUpdate = require('../mobile/plugin-update.js');
const pluginSelf = require('../mobile/plugin-self.js');
const pluginMarket = require('../mobile/plugin-market.js');
const { createRelayControlHandlers } = require('../mobile/relay-control.js');
const uploads = require('../mobile/uploads.js');
const canvasStore = require('../mobile/canvas-store.js');
const inboxClean = require('../mobile/inbox-clean.js');
// 过程播报开关（读 / 写同一条路径，由 req.method 分派）。默认关，见那个文件头。
const narration = require('../mobile/narration.js');
const git = require('../mobile/git.js');
const terminal = require('../mobile/terminal.js');
const pairing = require('../mobile/pairing.js');
// 设备批量同步（docs/device-batch-sync.md）：一次性入场券 + 密文收件箱。
const sync = require('../mobile/sync.js');
const { createTransferTickets } = require('../mobile/transfer-tickets.js');
const { createSyncInboxStore } = require('../mobile/sync-inbox-store.js');
const { credentialsEntry } = require('../shared/credentials-entry.js');
const { handleCredentialUpgrade } = require('../mobile/credential-upgrade.js');
const extensions = require('../mobile/extensions.js');
const extensionDev = require('../mobile/extension-dev.js');
const extensionCatalog = require('../mobile/extension-catalog.js');
const sessionDelivery = require('../mobile/session-delivery.js');
const { createPhoneRoutes } = require('../mobile/phone/routes.js');
// 公众号文章库（见 mobile/wechat.js）：AI 在对话里写、手机上翻阅。
const wechat = require('../mobile/wechat.js');
// 悬浮宠物的包目录（见 mobile/pets.js）：素材存在电脑上，手机连着哪台就看哪台。
const pets = require('../mobile/pets.js');
// 体检接口要自报身份：版本号只有一个来源，就是包自己的 package.json（与 relay/status.js 同）。
const pkg = require('../../package.json');
const desktopView = require('../desktop-view.cjs');

const API_VERSION = '1';

/**
 * @param {object} deps
 * @param {(route: object) => void} deps.registerRoute 交给 ctx.webServer 的注册器
 * @param {(handler: Function) => Function} deps.guarded 移动端守卫（token + 500 信封）
 * @param {object} deps.state 内存里的中转状态（本进程唯一真值）
 * @param {() => object} deps.hostMetadata 宿主元信息（隧道准入状态等）
 * @param {() => object} deps.getSidecarSnapshot 取快照的取值器，必须传函数：快照会被整体替换，
 *   闭包捕获对象会永远读到启动那一刻的旧快照。
 * @param {(port: number) => Array<object>} deps.safeLanCandidates 局域网候选地址
 * @param {(port: number) => Array<object>} deps.safeIpv6Candidates 公网 IPv6 直连候选，与上一份
 *   并列：手机拿它和中转比快慢，掺进局域网那份会共用失败退避。
 * @param {() => number} deps.lanPortInUse 手机该拨的局域网端口，必须用取值器：sidecar 实绑的
 *   端口可能与 state 里解析出的不同。
 * @param {(route: { path: string, handler: Function }) => void} deps.registerUpgradeRoute 升级路由
 *   注册器；与 registerRoute 是两套名字空间，同一 path 可以两者都有，但升级路由重复注册会抛错。
 * @param {object} deps.preview 预览字节管道服务。它自带鉴权与端口边界，不能包在 guarded 里——
 *   升级请求需要的是一次拒绝或一次握手，不是 JSON。
 * @param {Function} deps.hostWeb 网页版登录令牌那条（见 mobile/host-web.js）。令牌是凭据，
 *   所以它走 route() 即包 guarded。
 */
function registerMobileRoutes(deps) {
  const { registerRoute, tailcat, registerUpgradeRoute, guarded, state, hostMetadata, getSidecarSnapshot, safeLanCandidates, safeIpv6Candidates, lanPortInUse, preview, core, pairingApproval, rotatePairing, terminalService, cliService, phoneService } = deps;
  // CLI 会话（`cli-*`）在这张表上分派一次（见 mobile/cli/mobile.js）：它们是 ACP 子进程、
  // 不是宿主的会话，但手机上必须像普通会话一样可用 —— 列表 / 历史 / 发送 / 停止 / 流 /
  // 审批 / 模型全走宿主那套端点。分派发生在 `route()` 里面，下面每条注册都还是原样一行，
  // handler 一个都没抄；`sessionId` 不在 `cli-` 前缀上的请求原样交给原 handler。
  const cliMobile = cliService && cliService.mobile
  const route = (path, handler) => registerRoute({ kind: 'exact', path, handler: guarded(withCliSession(path, handler)) })
  /**
   * 哪些路径要过 CLI 分派。
   *
   * 只收「请求体是 JSON / 只读」的那批：`route()` 里的分派要先读一次 POST 的请求体才能看见
   * sessionId，二进制那条（`/session/file`、上传分片）一读就坏，所以它们不在名单里 ——
   * CLI 会话也没有那些东西。
   */
  const CLI_SESSION_PATHS = new Set([
    '/api/mobile/v1/session',
    '/api/mobile/v1/session/messages',
    '/api/mobile/v1/session/send',
    '/api/mobile/v1/session/attachment',
    '/api/mobile/v1/session/head',
    '/api/mobile/v1/session/stop',
    '/api/mobile/v1/session/rename',
    '/api/mobile/v1/session/fork',
    '/api/mobile/v1/session/models',
    '/api/mobile/v1/session/select-model',
    '/api/mobile/v1/session/model-option',
    '/api/mobile/v1/session/model-visibility',
    '/api/mobile/v1/session/stats',
    '/api/mobile/v1/session/read',
    '/api/mobile/v1/session/delivery',
    '/api/mobile/v1/session/search',
    '/api/mobile/v1/session/goal',
    '/api/mobile/v1/session/queue/update',
    '/api/mobile/v1/commands',
    '/api/mobile/v1/skills',
    '/api/mobile/v1/subagents',
    '/api/mobile/v1/file-references',
    '/api/mobile/v1/session-references',
    '/api/mobile/v1/extension/cards',
    // 导出：CLI 会话没有宿主日志，这条回一份空 ZIP（见 cli/mobile.js 的 handleExport）。
    '/api/mobile/v1/session-log',
  ])
  /**
   * 会话级开关里那四条「属于会话自己、不属于工作区」的写：归档 / 取消归档 / 置顶 /
   * 取消置顶。CLI 会话在宿主那本账里没有条目，原样透过去只会换一张错误卡，所以 `cli-*`
   * 由适配层自己记（内存账，跟 CLI 会话一起没）。
   */
  const CLI_SESSION_FLAGS = {
    '/api/mobile/v1/workspace/archive-session': 'archive',
    '/api/mobile/v1/workspace/unarchive-session': 'unarchive',
    '/api/mobile/v1/workspace/pin-session': 'pin',
    '/api/mobile/v1/workspace/unpin-session': 'unpin',
  }
  function withCliSession(path, handler) {
    if (!cliMobile) return handler
    if (path === '/api/mobile/v1/sessions') return cliMobile.wrapSessions(handler)
    if (CLI_SESSION_FLAGS[path]) return cliMobile.routeFlag(CLI_SESSION_FLAGS[path], handler)
    if (path === '/api/mobile/v1/workspace/clear-archived') return cliMobile.wrapClearArchived(handler)
    // 后台提醒视图：CLI 会话的「在跑 / 刚完成 / 待回话」也从这里出去（注入成取值器，
    // monitor.js 不认识 CLI 的任何细节，出口形状不变）。
    if (path === '/api/mobile/v1/monitor') {
      return (ctx, req, res) => handler(ctx, req, res, () => cliMobile.monitorItems())
    }
    if (path === '/api/mobile/v1/approval/respond') return cliMobile.wrapApprovalRespond(handler)
    if (path === '/api/mobile/v1/session/stream') {
      return (ctx, req, res) => {
        const sessionId = new URL(req.url || '/', 'http://x').searchParams.get('sessionId')
        return cliMobile.isCliSessionId(sessionId) ? cliMobile.handleStream(ctx, req, res) : handler(ctx, req, res)
      }
    }
    if (CLI_SESSION_PATHS.has(path)) return cliMobile.route(path, handler)
    return handler
  }
  // 中转配置那一组要**装配期已有的实例**（config store、sidecar 生命周期），不能靠模块级
  // 单例去拿：同一进程里两份 relay.json 的真值只会打架。所以这里按装配层给的依赖建一次。
  const relayControl = createRelayControlHandlers(deps.relayControl || {})

  // 设备批量同步的两份状态：一次性券表只活在内存（进程重启即清），收件箱按实例落 `$DSH_HOME`。
  // 页面能挂几次本函数就建几份；配对那条要用同一份券表，所以在这里建好、同时交给下面两处。
  const transferTickets = createTransferTickets()
  const syncInboxStore = createSyncInboxStore()
  const syncHandlers = sync.createSyncHandlers({
    state,
    ticketStore: transferTickets,
    inboxStore: syncInboxStore,
    safeLanCandidates,
    safeIpv6Candidates,
    lanPortInUse,
    // 面板那条回包用的是 pairingApproval.hostPlatform().platform（见 pairing.js），这里同源。
    hostPlatform: () => (pairingApproval && typeof pairingApproval.hostPlatform === 'function'
      ? pairingApproval.hostPlatform().platform
      : process.platform),
    log: (...args) => console.warn('[dsh-mobile-plugin] [sync]', ...args),
  })

  registerRoute({ kind: 'exact', path: '/api/mobile/v1/status', handler: guarded(async (_ctx, _req, res) => {
    // 内存 `state` 是本进程唯一的真值。旧实现这里 `loadRelayState()` 重新读盘，
    // 于是同一份状态出现两个来源：控制面改完内存立刻返回，而移动端读到的还是
    // 上一次落盘的内容（多实例/慢盘时甚至永久不一致）。
    //
    // `relayUrl` 挂在这条上，是因为**这里每台设备每 30 秒必发一发**（它是判断设备在不在线
    // 的心跳，与用户选的通道档位无关）。用户在插件里改了中转地址之后，手机手上还攥着旧
    // 地址，而旧中转上没有这台电脑、只会回「那台不在线」——它能学到新地址的唯一机会，
    // 是在还连得上宿主的那些时刻（局域网 / IPv6）从宿主嘴里听到。`/connection-info` 也有
    // 这个字段，但它只在「先探到一条局域网或 IPv6 地址」时才会被问，而「只走公网」那一档
    // 恰恰把这两条通道全排除了，于是那条路对她永远不会走。
    //
    // 所以这条不是「多带一个字段」，它是「改了地址之后，非局域网用户也能自己恢复」的那
    // 一发。`enabled` 关掉时给 null，表示「这台机器没有中转」，与「地址是空的」区分开。
    sendJson(res, 200, {
      ok: true,
      apiVersion: API_VERSION,
      instanceId: state.instanceId || null,
      name: state.name || null,
      remoteEnabled: Boolean(state.enabled),
      relayUrl: state.enabled ? (state.relayUrl || null) : null,
      ...hostMetadata(),
    })
  }) })
  // 地址体检：手机在**配对之前**就要问「这个地址上到底是谁」，那时它手上没有任何
  // 凭据，所以这条刻意不包 guarded（豁免与理由见 test/mobile-routes.test.cjs 的
  // PUBLIC_ROUTES）。它能说的话只有服务名与版本——没有实例信息、没有任何能力面。
  // 中转侧在同一路径上回 'dsh-mobile-relay'，App 靠这个字段分辨「填的是宿主还是中转」。
  //
  // ⚠️ 签名必须是 `(req, res)` **两个**参数：宿主 webServer 就是 `handler(req, res)` 调的，
  // 上面那条 `guarded(...)` 之所以能收 `(ctx, req, res)`，是因为那三个参数由 guarded 自己补。
  // 这里曾写成 `(_ctx, _req, res)`，于是 `res` 是 undefined，而 `sendJson` 的 catch 会把
  // TypeError 当成「连接已关闭」吞掉——既没报错也没回包，请求**永久挂住**；手机 5s 超时后
  // 退回探活接口拿到 ok，报「能连上但不是 DSH 移动端服务」。纯文本的路由表测试抓不到这类错。
  /**
   * 直连隧道：一台**已经配过对**的手机把自己的公钥发上来，换回它该拨的地址。
   *
   * 这是「插件更新之后老设备不用重新扫码」的那条路：手机手上本来就有这台电脑的凭据，
   * 只是不知道有隧道这回事。宿主把它的公钥加进白名单、把节点拉起来，再把地址回给它。
   * 隧道没开（或者这台机器上没有助手）就回 503 + `tunnel-unavailable`，手机照旧走原来的通道。
   */
  route('/api/mobile/v1/tunnel', async (_ctx, req, res) => {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false }); return }
    // 信封请求的明文在 `req.body`（守卫解开之后放那儿），原始流已经被守卫读掉了 —— 自己读流
    // 只会拿到空串，公钥永远为空、一律 400，手机那边看到的却是一句笼统的失败。
    const body = await readJsonBody(req, 64 * 1024)
    const publicKey = typeof body?.publicKey === 'string' ? body.publicKey.trim() : ''
    if (!/^nodekey:[0-9a-f]{64}$/.test(publicKey)) { sendJson(res, 400, { ok: false, error: { code: 'invalid-public-key' } }); return }
    const entry = tailcat && typeof tailcat.enroll === 'function' ? await tailcat.enroll(publicKey).catch(() => null) : null
    // 拿不到地址要回一个**非 2xx + 错误码**：手机那侧的 `unwrap` 见到 `ok:false` 会抛，和「请求
    // 根本没送到」在同一条 catch 里混成一团，界面上就只剩一句笼统的失败（真机上正是这么卡的）。
    if (!entry) { sendJson(res, 503, { ok: false, error: { code: 'tunnel-unavailable', message: '这台电脑现在给不出隧道地址' } }); return }
    sendJson(res, 200, { ok: true, address: entry.address, port: entry.port })
  })

  registerRoute({ kind: 'exact', path: '/api/mobile/v1/health', handler: async (_req, res) => {
    sendJson(res, 200, { ok: true, service: 'dsh-mobile-plugin', apiVersion: API_VERSION, version: pkg.version })
  } })
  // 配对：手机拿配对码换 token 与设备凭据。**这条归宿主**——「谁可以进这台机器」是宿主
  // 自己的判断，配对码本来就存在宿主的状态里，中转只按实例标识把请求转过来。
  //
  // 刻意**不**包 `guarded`：配对之前手机手上还没有任何凭据，包上就是死循环。豁免理由与
  // /health 一样登记在 test/mobile-routes.test.cjs 的 PUBLIC_ROUTES。
  //
  // 这条路径与局域网那条 `/__lan_pair` 是同一件事的两个入口，签发的是同一种 HMAC token；
  // 差别只在网络路径。旧实现把它长在独立的中转进程里，换成 Rust 中转时整块漏了搬，
  // 于是手机上点「配对并添加」收到的是宿主的 405。
  registerRoute({
    kind: 'exact',
    path: '/api/mobile/v1/pair',
    handler: pairing.createPairHandler({
      state,
      core,
      credentials: credentialsEntry(),
      pairingApproval,
      // 配对响应顺手把宿主当前的直连候选带回去（与 `/connection-info` 同一份取值）：
      // 手输公网地址配对时没有二维码，这是手机拿到内网地址的唯一机会。
      lanCandidates: safeLanCandidates,
      ipv6Candidates: safeIpv6Candidates,
      lanPort: lanPortInUse,
      // 批量同步导入的新手机带着 `ticketId` 来配：从这张券表取券当票据（一次性）。不传它就
      // 只认得面板二维码那张 state 票据。
      transferTickets,
      // 配对成功即换码 + 换票据（§5.1）：谁截了二维码，那张图从这一刻起就没用了。
      rotatePairing,
      log: (...args) => console.warn('[dsh-mobile-plugin] [pair]', ...args),
    }),
  })

  // 设备批量同步：申领一次性入场券 + 密文收件箱读写。三条端点、两条注册（inbox 按 method
  // 分派写 / 读，宿主 webServer 一个路径只能挂一个 handler），都走 route() 即包 guarded ——
  // 只有已配对设备才能领券或碰收件箱，否则任何人能领走配对资格、往这台机器里塞东西。
  route('/api/mobile/v1/sync/tickets', syncHandlers.handleMintTickets)
  route('/api/mobile/v1/sync/inbox', syncHandlers.handleInbox)
  // 局域网/中转连接信息。**这条由宿主自己回答**：中转只转发，不再代答。
  // 纯局域网配对（App 只扫到局域网二维码、完全不经中转）需要一个宿主自己回答的地址，
  // 否则 App 拿不到 lanCandidates，换网卡后就再也找不到这台机器；中转在中间时这条
  // 同样转发到这里，所以两条链路走的是同一份实现。
  // 设备凭据吊销 —— **手机自己解绑**这条路（§3.3）。由宿主应答，中转只转发：
  // 「哪台设备还能用」是宿主的判断。
  //
  // 旧实现回一句 `{ok:true}` 什么都不做：手机点了「删除设备」、本地删干净了，宿主那份
  // 凭据还活着，那枚 token 在到期之前仍然能用。现在按**出示的这枚凭据属于哪台**整台吊销。
  //
  // 为什么不按请求体里的 deviceId：手机手上只有自己的凭据，让它报 deviceId 等于允许吊销
  // 别人；deviceId 只从库里那条记录取，报别人的号根本没有入口。为什么不只吊销出示的那一枚
  // （2026-10-28 改）：同一台手机重配、升级之后名下有好几条活凭据，旧的那条仍然能用，于是
  // 「在手机上删设备」只把面板那一行的条数减一、行还在，用户以为删干净了其实没有。
  route('/api/mobile/v1/device-credential/revoke', async (_ctx, req, res) => {
    const presented = req.headers['x-dsh-device-credential']
      ? String(req.headers['x-dsh-device-credential'])
      : (/^Bearer\s+([^\s]+)$/.exec(req.headers.authorization || '') || [])[1]
    const store = credentialsEntry()
    const instanceId = String(state.instanceId || '')
    // 查不到记录（升级前那种纯 HMAC 通行证）就什么都不吊销：它没有记录、也就没有 deviceId，
    // 那种只能靠控制面的「吊销全部」轮换 lanSecret 收掉。
    const record = presented ? store.lookup(presented, instanceId) : null
    const count = record ? store.revokeDevice(instanceId, record.deviceId) : 0
    // 尽力而为的语义不变：手机那边失败也不阻断本地删除，所以这里始终回 ok，
    // 但把「到底吊销了几条」如实带上 —— 排查「删了还能用」时这一格是唯一线索。
    sendJson(res, 200, { ok: true, revoked: count > 0, count })
  })

  // 旧会话升级成 T1（§3.3）：新 App 每次启动幂等调一次。判据、密钥归属与「为什么密钥
  // 只能明文上行一次」都在 mobile/credential-upgrade.js 的文件头里。
  route('/api/mobile/v1/device-credential/upgrade', async (_ctx, req, res) => {
    // 必须 await：这条路要现读请求体（明文老会话的字节还挂在 socket 上，见 handler 文件头）。
    await handleCredentialUpgrade(req, res, { instanceId: String(state.instanceId || ''), store: credentialsEntry() })
  })

  route('/api/mobile/v1/connection-info', async (_ctx, _req, res) => {
    // 端口取「手机该拨的那个」（sidecar 真 bind 成的），不是配置里的首选端口：
    // 两者不一致时这里报出去的候选是死地址，手机只能退回公网中转。
    const port = typeof lanPortInUse === 'function' ? lanPortInUse() : state.lanPort
    // 用户在面板上选过的「手机优先用这条」（设置项 `preferredLanAddress`）在这里同样兑现：
    // 手机是按顺序挨个试的，所以只挪顺序、不删候选。选的那条不在了就退回宿主排序。
    // 手填的直连地址（穿透域名）缀在**最后**当兜底：它绕公网、比内网慢一个数量级，排在前面
    // 就等于让手机永远选中它、家里那条内网地址一次都不试（见 `withManualCandidate` 的注释）。
    const candidates = state.lanEnabled
      ? withManualCandidate(orderCandidates(safeLanCandidates(port), state.preferredLanAddress), state.manualLanUrl)
      : []
    // IPv6 直连候选：单独一份、**不参与**上面的排序 —— 它和中转谁更快只有手机实测得出，
    // 宿主无从判断对端走哪条路由。与局域网那份同一个开关管（那条监听挂在同一个代理上），
    // 关掉局域网直连就没有这条通道。
    //
    // 这份是手机配对之后**唯一**能拿到新 IPv6 地址的地方：二维码里带的候选只在配对那一刻
    // 是真值，而隐私地址按小时轮换、运营商换前缀之后旧的那条就拨不通了。少回这一格，
    // 手机上那条通道就只能靠配对当时的旧地址活着。手填的 IPv6 那条缀在**最后**当兜底
    // （只追加、不删网卡候选），理由与上面手填的直连地址同一条。
    const ipv6 = state.lanEnabled ? withManualIpv6Candidate(safeIpv6Candidates(port), state.manualIpv6Url) : []
    const lanUpdatedAt = getSidecarSnapshot()?.lan?.updatedAt || Date.now()
    sendJson(res, 200, {
      ok: true,
      instanceId: state.instanceId || null,
      name: state.name || null,
      relayUrl: state.enabled ? (state.relayUrl || null) : null,
      lanUrls: candidates,
      lanCandidates: candidates,
      ipv6Candidates: ipv6,
      updatedAt: lanUpdatedAt,
      lastSeen: lanUpdatedAt,
      // 商店素材的接收端（本机的 Mac-to-eagle 桌面程序）：手机端不用手填地址与密钥，
      // 这里一并交给它。没有那个程序 / 还没生成密钥时是 null（App 那边什么都不做）。
      promoReceiver: promoReceiverCoords({ lanCandidates: candidates }),
    })
  })

  route('/api/mobile/v1/sessions', sessions.handleSessions)
  // 后台提醒服务专用：只回「在跑 / 刚完成 / 待回话 / 上一轮失败」这几格，
  // 带 `?rev=` 条件刷新。它要替掉原生那边每 8 秒一发的完整清单（那份还得为 20 个
  // 会话各读一次 history 补预览），见 mobile/monitor.js。
  route('/api/mobile/v1/monitor', monitor.handleMonitor)
  // iOS 推送令牌上报：App 把 APNs 令牌交给宿主，宿主经隧道帧转交中转落表。中转没配
  // 密钥时那头静默忽略——这条路由照常回 ok，「推没推成」不是 App 要操心的事。
  // 判据（要不要收这个令牌）与配对同一把锁：guarded 已核过设备身份。
  route('/api/mobile/v1/push-token', pushNotifyRoute.createPushTokenHandler({ pushNotify: deps.pushNotify }))
  route('/api/mobile/v1/session', sessions.handleSession)
  route('/api/mobile/v1/session/messages', sessions.handleMessages)
  // 一步的过程详情：清单只带一行摘要，点开某一步才来这里取参数 / 输出 / diff / 思考全文。
  route('/api/mobile/v1/session/step', sessionStep.handleSessionStep)
  route('/api/mobile/v1/session/attachment', sessions.handleSessionAttachment)
  // 正文图的字节：按登记过的编号取，不是按路径读文件（见 mobile/local-images.js 的文件头）。
  route('/api/mobile/v1/session/local-image', sessionLocalImage.handleSessionLocalImage)
  // 会话文件：允许本会话 present 声明的路径及会话工作区内的文件（见 mobile/session-file.js）。
  route('/api/mobile/v1/session/file', sessionFile.handleSessionFile)
  // 文件浏览器按绝对路径取字节，范围是宿主已登记的工作区及当前会话的项目目录
  //（见 mobile/file-read.js 与 mobile/allowed-zone.js）。
  route('/api/mobile/v1/file/read', fileRead.handleFileRead)
  route('/api/mobile/v1/session/send', sessions.handleSend)
  // 「这一发到底进没进」：App 的离线发件箱在重发之前先问一句（按 clientMessageId 回查
  // 会话正文）。只读、只看最近一窗，见 mobile/session-delivery.js。
  route('/api/mobile/v1/session/delivery', sessionDelivery.handleSessionDelivery)
  // 正文水位探针：App 进对话前先问一句「这条会话的正文到哪个水位了」，跟本地缓存水位
  // 一比就知道要不要重拉全量历史（几十字节换几兆）。**只读信号快照**：信号里没有就如实
  // 回 known:false 让 App 退回全量，绝不现读一次历史——否则这探针就变成了它要省掉的那次请求。
  route('/api/mobile/v1/session/head', sessions.handleSessionHead)
  route('/api/mobile/v1/commands', sessions.handleCommands)
  route('/api/mobile/v1/session/read', sessions.handleSessionRead)
  route('/api/mobile/v1/session/stop', sessions.handleStop)
  route('/api/mobile/v1/session/rename', sessions.handleRename)
  route('/api/mobile/v1/session/fork', sessions.handleFork)
  route('/api/mobile/v1/session/models', sessions.handleModels)
  route('/api/mobile/v1/session/select-model', sessions.handleSelectModel)
  // 模型之外的附加选项（速度、输出详略……）：写一条已声明的行，落地是宿主自己的设置。
  route('/api/mobile/v1/session/model-option', sessionModelOptions.handleModelOption)
  // CLI 模型管理页的开关（只影响显示，真值存在那台电脑上，见 cli/model-visibility.js）。
  // 这条只对 CLI 会话有意义：宿主那套模型目录没有「跨手机一致」的要求，所以非 CLI 的
  // sessionId 一律回 400，不做静默成功。
  route('/api/mobile/v1/session/model-visibility', async (_ctx, _req, res) => {
    sendJson(res, 400, { ok: false, error: { code: 'cli-only', message: '这条接口只对 CLI 会话有效' } });
  })
  route('/api/mobile/v1/session/stats', sessions.handleStats)
  // 统计总览（统计页）。账本落在宿主家里（`$DSH_HOME/mobile-stats.json`），与会话日志
  // 无关：归档只是挪位置，清理删的是日志，历史数字都还在 —— 见 mobile/stats-ledger.cjs。
  route('/api/mobile/v1/stats/overview', stats.handleStatsOverview)
  // 正文检索（宿主 session.search 的移动端代理）：只回 { sessionId, snippet }，
  // 标题 / 工作区由 App 用自己轮询到的会话列表拼接，见 mobile/sessions.js。
  route('/api/mobile/v1/session/search', sessions.handleSessionSearch)
  // Agent 预设（宿主 agentPreset.list / agentPreset.select 的移动端代理）。桌面端
  // 会话头标签、设置行、hero 芯片都读这份名单；宿主未配置 roster 时 list 回空数组。
  route('/api/mobile/v1/agent-presets', sessions.handleAgentPresets)
  // Agent 预设管理（宿主 agentPreset.read / copy / remove 的移动端代理）：桌面端设置页
  // 那个「管理分区」——只读查看器、复制（桌面端唯一的创建入口）、删除。此前手机只能
  // 看到名单与当前档，既读不到预设正文也造不出自己的预设。
  route('/api/mobile/v1/agent-presets/read', agentPresets.handleAgentPresetRead)
  route('/api/mobile/v1/agent-presets/copy', agentPresets.handleAgentPresetCopy)
  route('/api/mobile/v1/agent-presets/remove', agentPresets.handleAgentPresetRemove)
  // 把某一档设成「新会话默认吃的那一档」：写宿主 settings 的 agent-preset-registry，
  // 与桌面端预设页那颗「设为默认」同一格（不是预设自己的属性）。
  route('/api/mobile/v1/agent-presets/default', agentPresets.handleAgentPresetDefault)
  route('/api/mobile/v1/session/new', sessions.handleNew)
  route('/api/mobile/v1/session/stream', stream.handleStream)
  route('/api/mobile/v1/events/stream', events.handleDeviceStream)
  route('/api/mobile/v1/question/respond', questions.handleQuestionRespond)
  route('/api/mobile/v1/approval/respond', approvals.handleApprovalRespond)
  route('/api/mobile/v1/session/goal', sessions.handleGoalAction)
  route('/api/mobile/v1/session/queue/update', sessions.handleQueueUpdate)
  route('/api/mobile/v1/workspaces', workspaces.handleWorkspaces)
  // 桌面端工作区展开态镜像（由页面内的客户端半边经 /api/relay/desktop-view 回传）。
  // 桌面端只把这份状态记在浏览器 localStorage 里，宿主读不到，所以这里给 App 的只是
  // 「宿主最近收到的快照」；从未收到过时返回 view: null，App 按桌面的折叠缺省处理。
  route('/api/mobile/v1/desktop-view', async (_ctx, _req, res) => sendJson(res, 200, { ok: true, view: desktopView.snapshot() }))
  route('/api/mobile/v1/directory/list', workspaces.handleListDirectory)
  // 盘符层：宿主 browse 后端只列目录内容、不枚举盘符，主目录在 C 盘时手机端看不到别的盘
  // （Windows 多硬盘现场）。枚举在被控端做，见 mobile/drive-roots.js。
  route('/api/mobile/v1/directory/roots', workspaces.handleDirectoryRoots)
  // 右栏文件浏览器要的那一份：文件与文件夹都列、带类型/大小/修改时间，见
  // mobile/directory-listing.js。与上面那条**并存**：那条是「挑工作区目录」用的，只列
  // 能进去的目录，行为不变。
  route('/api/mobile/v1/directory/listing', directoryListing.handleDirectoryListing)
  route('/api/mobile/v1/directory/create', workspaces.handleCreateDirectory)
  route('/api/mobile/v1/workspace/create', workspaces.handleCreateWorkspace)
  route('/api/mobile/v1/workspace/delete', workspaces.handleDeleteWorkspace)
  route('/api/mobile/v1/workspace/move', workspaces.handleMoveWorkspace)
  route('/api/mobile/v1/workspace/move-session', workspaces.handleMoveSession)
  route('/api/mobile/v1/workspace/rename', workspaces.handleRenameWorkspace)
  route('/api/mobile/v1/workspace/archive-session', workspaces.handleArchiveSession)
  // 会话级开关的反向动作：取消归档 / 置顶 / 取消置顶。桌面端这三件事都有入口
  // （行尾按钮 + 会话菜单），移动端此前一个都没有——归档错了只能回桌面端捞。
  route('/api/mobile/v1/workspace/unarchive-session', workspaces.handleUnarchiveSession)
  route('/api/mobile/v1/workspace/pin-session', workspaces.handlePinSession)
  route('/api/mobile/v1/workspace/unpin-session', workspaces.handleUnpinSession)
  // 「清理所有已归档的对话」（侧栏归档视图的文字按钮）：按 workspace.list 的归档集合全量清理，
  // 且 body 必须带 confirm: true（磁盘删除不可恢复）。
  route('/api/mobile/v1/workspace/clear-archived', archiveClean.handleClearArchived)
  // Git 管理器（docs/git-manager.md）：手机上的仓库概览 / 变更 / 历史 / 分支都是读，
  // 暂存 / 提交 / 切分支是写。能力面是一组固定命名的动词，不接受透传命令；每个请求都带
  // workspaceId 与（可选的）仓库根，插件再校验它确实属于这个项目识别出来的仓库。
  route('/api/mobile/v1/git/repo', git.handleGitRepo)
  route('/api/mobile/v1/git/status', git.handleGitStatus)
  route('/api/mobile/v1/git/diff', git.handleGitDiff)
  route('/api/mobile/v1/git/log', git.handleGitLog)
  route('/api/mobile/v1/git/show', git.handleGitShow)
  route('/api/mobile/v1/git/branches', git.handleGitBranches)
  route('/api/mobile/v1/git/overview', git.handleGitOverview)
  route('/api/mobile/v1/git/stage', git.handleGitStage)
  route('/api/mobile/v1/git/unstage', git.handleGitUnstage)
  route('/api/mobile/v1/git/commit', git.handleGitCommit)
  route('/api/mobile/v1/git/checkout', git.handleGitCheckout)
  // 推当前分支到它的上游：只做这一档，不收分支名 / 远端名 / force 开关。
  route('/api/mobile/v1/git/push', git.handleGitPush)
  // AI 写提交信息：只读 `git diff --cached`，调宿主 llm 服务，回一行文案；不提交、不推送。
  route('/api/mobile/v1/git/commit-message', git.handleGitCommitMessage)
  // 桌面端 `/export` 其实是两步：命令本身只留一行 transcript 标记，真正的下载由
  // @deepseek-ai/dsh-session-log-export 在浏览器侧监听 command/executed 后拉
  // `GET /api/session.export` 完成。手机端没有浏览器下载管理器，而那个端点绑在宿主
  // 的 127.0.0.1 上手机直连不到 —— 所以由插件代取（mobile/session-log.js），App 侧
  // 再落盘。
  route('/api/mobile/v1/session-log', sessionLog.handleSessionLog)
  // 宿主设置与模型提供方（宿主 settings.describe / llm.providers 的移动端只读代理）。
  // 桌面端「设置」里有默认模型、提供方配置、凭据是否已设；手机端此前完全没有这一块，
  // 只能看到 App 自己的偏好项。两个宿主接口本身已脱敏（secrets 只给 path 与 set），
  // 插件再丢掉对手机没用的 schema 树，见 mobile/host-settings.js。
  route('/api/mobile/v1/host-settings', hostSettings.handleHostSettings)
  // DeepSeek 账号只读投影：账户资料、钱包余额与官方用量/充值链接；不开放登录操作或凭据。
  route('/api/mobile/v1/deepseek-account', deepSeekAccount.handleDeepSeekAccount)
  // magpie 自带的网页版（Agents / Providers / Routing / Usage / Settings 全在里面）。
  // 手机那边把这一页整个嵌进来，不再自己画一套：它本来就是给手机做的，页面里写着
  // 「加到主屏后作为独立 App 打开」。网页版是独立进程，没在跑就在这里替用户拉起来。
  // key 是凭据，所以走 guarded，与 `host-web` 那条同一个口径。
  route('/api/mobile/v1/magpie/web', magpieWeb.handleMagpieWeb)
  // 改设置：与桌面端同一个 settings.mutate（按路径寻址的 op + expectedRevision 乐观并发）。
  route('/api/mobile/v1/host-settings/mutate', hostSettings.handleHostSettingsMutate)
  route('/api/mobile/v1/llm/providers', hostSettings.handleLlmProviders)
  // 宿主的模型目录（`llm.models`）：每个提供方下面真正可请求的模型 id，给「用哪个模型做
  // AI commit」这类选择器用 —— 它不需要活动会话，与 `/session/models` 不是一回事。
  route('/api/mobile/v1/llm/models', hostSettings.handleLlmModels)
  // 渠道管理（见 mobile/channels.js）：只对「本机自建」那一类（`llm-pi-ai` 里的路由）
  // 提供增删；插件 / 宿主注册的提供方只列出来，一个写操作都不做。获取模型由宿主代问
  // （端点常在内网，手机直连未必通），与桌面面板的 `discoverModels` 同一条路。
  // 模型能力配置（见 mobile/model-caps.js）：公开参数快照（App 拉一次、缓存后在 App 端搜索）
  // 与「把选中的那份写回这条自建渠道」。写只到 `providers.<id>`，与上面的渠道保存同一条
  // 边界 —— 内置渠道不在这份清单里，apply 一律 409。
  route('/api/mobile/v1/model-meta', modelCaps.handleModelMeta)
  route('/api/mobile/v1/model-meta/apply', modelCaps.handleModelMetaApply)
  route('/api/mobile/v1/channels', channels.handleChannels)
  route('/api/mobile/v1/channels/discover', channels.handleChannelDiscover)
  route('/api/mobile/v1/channels/save', channels.handleChannelSave)
  route('/api/mobile/v1/channels/delete', channels.handleChannelDelete)
  // 技能目录（宿主 skill.list 的移动端只读代理）。桌面端敲「/」时命令候选菜单里
  // 混着技能（@deepseek-ai/dsh-client-ui-skill 注册的 inputTriggers source），
  // 手机端此前只有 commands.list 的命令目录，技能一个都看不到，见 mobile/skills.js。
  route('/api/mobile/v1/skills', skills.handleSkills)
  // 宿主凭据（宿主 credentials.{describe,set,unset} 的移动端代理）。桌面端设置面板
  // 能往宿主写 API Key，手机端此前只能看到「1 项密钥未设置」却没有入口，见
  // mobile/credentials.js。密钥值只在这条路上出现一次，宿主从不回传值。
  route('/api/mobile/v1/credentials', mobileCredentials.handleCredentialsDescribe)
  route('/api/mobile/v1/credentials/set', mobileCredentials.handleCredentialsSet)
  route('/api/mobile/v1/credentials/unset', mobileCredentials.handleCredentialsUnset)
  // 子代理目录（宿主 subagent.list 的移动端只读代理）。桌面端会话标题栏挂着
  // 「N 个子代理」下拉，点进去能读子会话的完整记录；手机端把 origin === 'subagent'
  // 的行在侧栏里 continue 掉之后就再没有任何入口，见 mobile/subagents.js。
  route('/api/mobile/v1/subagents', subagents.handleSubagents)
  // 子代理续话与打断（宿主 subagent.prompt / subagent.interrupt 的移动端代理）。
  // 手机端的输入框只会发 session.send，而宿主对子会话一律回 agent-busy，所以给
  // 「可继续」子代理发消息必须换这条路由；一次性子代理宿主根本不收续话。
  route('/api/mobile/v1/subagents/prompt', subagents.handleSubagentPrompt)
  route('/api/mobile/v1/subagents/interrupt', subagents.handleSubagentInterrupt)
  // 引用发现（宿主 fileReferences.list / sessionReferenceResolver.candidates 的移动端
  // 代理）。桌面端输入 @ 会同时查这两个域，文件排在会话前面；手机端此前完全没有补全。
  // 和插件清单一样，这两个宿主服务不在 apiProxy 上，走 typertGateway，
  // 见 mobile/references.js。两个域各自独立降级，一个不可用不影响另一个。
  route('/api/mobile/v1/file-references', references.handleFileReferences)
  route('/api/mobile/v1/session-references', references.handleSessionReferences)

  // 定时任务（宿主 ScheduleService 的移动端代理）：目录、会话内 active 任务、运行记录、
  // 删除。桌面端有一套完整的定时任务面板，手机端此前一条都看不到；服务同进程直查
  // `ctx.get('schedule')`，宿主没有它时这四条统一回 503 而不是空列表，
  // 见 mobile/schedule.js。`update` 这一批没接：手机端还没有编辑入口。
  route('/api/mobile/v1/schedule/catalog', schedule.handleScheduleCatalog)
  route('/api/mobile/v1/schedule/list', schedule.handleScheduleList)
  route('/api/mobile/v1/schedule/history', schedule.handleScheduleHistory)
  route('/api/mobile/v1/schedule/delete', schedule.handleScheduleDelete)

  // 桌面端 设置 → 插件 的只读部署快照，由 dsh-host-plugin-inventory 拥有，
  // 经 typertGateway 命名空间 pluginInventory 取，见 mobile/plugins.js。
  route('/api/mobile/v1/plugins', plugins.handlePlugins)

  // 这台设备上的**中转与连接配置**（见 mobile/relay-control.js）。
  //
  // 这些项从前只有一个入口：电脑上的当机面板（`/api/relay/*`，全部 localOnly）。于是
  // 「手机上发现连不上、想改个中转地址」必须回电脑前坐下才能做，而那往往正是人不在电脑前
  // 的时候。它们与装/卸插件不是一类东西：**不会让插件代码变**，最坏只是这台从网上找不到，
  // 而重连的主动权在手机这一侧。所以能力面有意放开给已配对设备。
  //
  // 改地址 / 关遥控 / 吊销 / 重连 / 重启后台服务这五条会掐断承载本请求的那条隧道，全部
  // 「先回包再动手」，结果靠重连后读状态判 —— 与下面 `/plugin/update/apply` 同一个手感。
  route('/api/mobile/v1/relay/config', relayControl.handleRelayConfig)
  route('/api/mobile/v1/relay/config/save', relayControl.handleRelayConfigSave)
  route('/api/mobile/v1/relay/enabled', relayControl.handleRelayToggle)
  route('/api/mobile/v1/relay/pairing-code', relayControl.handleRelayRegenerate)
  route('/api/mobile/v1/relay/revoke-all', relayControl.handleRelayRevokeAll)
  route('/api/mobile/v1/relay/reconnect', relayControl.handleRelayReconnect)
  route('/api/mobile/v1/relay/restart-sidecar', relayControl.handleRelayRestartSidecar)
  route('/api/mobile/v1/relay/check-port', relayControl.handleRelayCheckPort)
  route('/api/mobile/v1/relay/probe', relayControl.handleRelayProbe)
  route('/api/mobile/v1/relay/diagnostics', relayControl.handleRelayDiagnostics)

  // 这台插件**自己**的版本现场与自动更新开关（见 mobile/plugin-self.js）。
  // 只管 dsh-mobile-plugin 这一个包：动别的插件会把承载 App 连接的那条链一起带走，而手机
  // 没有在电脑前的那双手。与下面那三条 `/plugin/update/*` 是同一份真源（外壳的
  // dshMobilePluginRuntime），这里补的是设备页要的另外几格：自动更新开关与回退结果。
  route('/api/mobile/v1/plugin/self', pluginSelf.handlePluginSelf)
  route('/api/mobile/v1/plugin/self/auto', pluginSelf.handlePluginAuto)

  // 这台电脑上**别的插件**：装了哪些、装 / 启用 / 升级（见 mobile/plugin-market.js）。
  //
  // 不自己跑包管理器：宿主里本来就有一套插件管理器（桌面端 设置 → 插件 那个页面就是它的
  // 界面），装包、版本兼容检查、依赖脚本授权、装失败回滚、要不要重启才生效，全由它判断。
  // 这里只搬结果。**没有卸载入口**：卸载要重启电脑上的 DSH，手机上没有在电脑前的那双手；
  // 承载手机连接的这个包另外不给停用，只留原有的自更新那条路。
  //
  // 装一次可能几十秒到几分钟，所以 install / update 只回 202 + requestId，进度另开一条
  // 轮询 —— 手机切后台、断线重连都不该把一次安装拖断。安装时的 npm 源由 registries 那条
  // 给选择器：主源 / 备用源 / pnpm 实际读到的那个都原样报上来。
  route('/api/mobile/v1/plugin/market', pluginMarket.handlePluginMarket)
  route('/api/mobile/v1/plugin/market/registries', pluginMarket.handlePluginMarketRegistries)
  route('/api/mobile/v1/plugin/market/inspect', pluginMarket.handlePluginMarketInspect)
  route('/api/mobile/v1/plugin/market/install', pluginMarket.handlePluginMarketInstall)
  route('/api/mobile/v1/plugin/market/update', pluginMarket.handlePluginMarketUpdate)
  route('/api/mobile/v1/plugin/market/progress', pluginMarket.handlePluginMarketProgress)
  route('/api/mobile/v1/plugin/market/cancel', pluginMarket.handlePluginMarketCancel)
  route('/api/mobile/v1/plugin/market/enabled', pluginMarket.handlePluginMarketEnabled)

  // 插件自更新：APP 的「应用更新」页给这台宿主升级插件版本（见 mobile/plugin-update.js）。
  // 与桌面控制面 `/api/relay/update/*` 同一套实现，差别只在入口：那三条 localOnly，手机
  // 永远打不到，而手机上聊天时「有对话在跑」那道闸几乎总关着 —— 自动更新等于不跑。
  // 能力面有意放开给已配对设备，来源判据（只放行 npm 装的）不放开，理由写在那个文件头。
  route('/api/mobile/v1/plugin/update/status', pluginUpdate.handlePluginUpdateStatus)
  route('/api/mobile/v1/plugin/update/check', pluginUpdate.handlePluginUpdateCheck)
  route('/api/mobile/v1/plugin/update/apply', pluginUpdate.handlePluginUpdateApply)

  // 扩展与当前这台宿主之间的三条（见 mobile/extensions.js）。
  //
  // 扩展的**产物与清单**不走这里 —— 那由 App 分发系统的公开接口提供，装与不装之前就要能读。
  // 这三条只处理「宿主认账」：哪些卡被回写过、扩展自己改自己那张卡、以及让宿主替它办一件事。
  //
  // 能力面同样是有意收窄的：宿主动作由那份硬编码登记表预先枚举，**现在一张都没登记**，
  // 所以第三条对任何动作名都回 403。将来放开时在登记表里逐条加，不在这里开透传口子 ——
  // 移动 API 不暴露 shell / 系统设置 / 任意文件读写，这条也一样。
  route('/api/mobile/v1/extension/cards', extensions.handleExtensionCards)
  route('/api/mobile/v1/extension/card-state', extensions.handleExtensionCardState)
  route('/api/mobile/v1/extension/action', extensions.handleExtensionAction)

  // 扩展**开发包**：作者放在电脑上的本地扩展目录（`$DSH_HOME/extension-dev`），手机上直接
  // 列包、取文件，不用每改一行都发一次分发系统（见 mobile/extension-dev.js）。
  //
  // 能力面只多「读这一个固定目录」：slug 与包内相对路径拼出来的路径，取文件前先 resolve
  // 再判前缀。仍然不暴露 shell、系统设置、任意文件读写 —— 不接受任意路径，也不给写。
  route('/api/mobile/v1/extension/dev/packages', extensionDev.handleDevPackages)
  route('/api/mobile/v1/extension/dev/file', extensionDev.handleDevFile)

  // 随插件 npm 包发布的已审核扩展（见 mobile/extension-catalog.js）：只读包内 extensions/
  // 这一个固定目录，catalog.json 是审核清单，只有登记过的 slug 才下发。文件清单的 size 与
  // sha256 由宿主扫目录现算，不信清单里的数字；取文件仍先 resolve 再判前缀，不接受任意路径。
  // 能力面与开发包那两条同一档 —— 不暴露 shell / 系统设置 / 任意文件读写，也不给写。
  route('/api/mobile/v1/extension/catalog', extensionCatalog.handleCatalog)
  route('/api/mobile/v1/extension/catalog/file', extensionCatalog.handleCatalogFile)

  // 分享文件的落地通道（App 把手机分享进来的文件分片传上来，见 mobile/uploads.js）。
  // 手机端没有「把文件交给宿主」的路：图片能进 session.send 的 base64 内容块，其它格式
  // 一律进不去。四条端点只做「收字节 → 落盘」：默认落到 `~/.dsh/mobile-inbox/<日期>/<文件名>`，
  // 落盘路径由 App 写成 @提及 再随消息发给宿主；带 `destPath` 时落到那个目录（右栏的
  // 「传到这里」），它必须在 mobile/allowed-zone.js 的允许区内。
  route('/api/mobile/v1/upload/begin', uploads.handleUploadBegin)
  route('/api/mobile/v1/upload/chunk', uploads.handleUploadChunk)
  route('/api/mobile/v1/upload/finish', uploads.handleUploadFinish)
  route('/api/mobile/v1/upload/abort', uploads.handleUploadAbort)

  // 无限画布的库（App 那页 WebView 里的项目与素材，见 mobile/canvas-store.js）。
  // 每个域一份清单、字节按内容哈希落在插件自己的目录里；手机推上来、拉下去都走这三条。
  // 素材字节不另开通道，走上面的分片上传（`purpose: 'canvas'`）—— 断点续传与片大小
  // 自适应那一套已经在那条路上，再写一份只是多一条会漂的实现。
  route('/api/mobile/v1/canvas/manifest', canvasStore.handleCanvasManifestGet)
  route('/api/mobile/v1/canvas/manifest/save', canvasStore.handleCanvasManifestSave)
  route('/api/mobile/v1/canvas/file', canvasStore.handleCanvasFile)
  // 同一个收件目录的出口：上面四条只往里放，这两条报占用、按龄清掉（见 mobile/inbox-clean.js）。
  // 落盘的文件不认识会话，所以没有「删掉这条对话就顺带清掉它传上来的文件」这条路 ——
  // 唯一的出口只能按龄，口径写在那个文件头。
  route('/api/mobile/v1/inbox/status', inboxClean.handleInboxStatus)
  route('/api/mobile/v1/inbox/clear', inboxClean.handleInboxClear)
  // 自动清理开关：默认关，打开后宿主每次启动顺手清一次（面板那颗按钮不受它管）。
  route('/api/mobile/v1/inbox/auto', inboxClean.handleInboxAuto)
  // 过程播报开关（GET 读、POST 写 `{enabled}`）。缺省关；关着时宿主一个钩子都不动手。
  // 与「自动清理」同一个位置：都是这台电脑自己的偏好，跟会话无关。
  route('/api/mobile/v1/narration', narration.handleNarration)

  // 电脑上的 DSH 网页版（见 mobile/host-web.js）：App 的内置浏览器要直接用它，而那个页面
  // 只绑在宿主自己的环回端口上、且要一枚一次性登录令牌。令牌是凭据，所以这条**必须**
  // 包 guarded（不是 PUBLIC_ROUTES）——只有已配对设备才拿得到。
  //
  // 它与下面的预览升级是同一件事的两半：这条给手机「去哪儿、带什么」，那条让字节真的流过去
  // （`mode=webapp` 那一档才允许拨回宿主自己的 web 端口）。
  route('/api/mobile/v1/host-web', deps.hostWeb)

  // 内置浏览器预览（App 侧「点 localhost 链接在内置浏览器里打开」的宿主端一半）。
  //
  // 这是一条 **WebSocket 升级**路由，不是普通 HTTP 路由：手机原生模块按端口在环回监听、
  // 把 WebView 写下的原始字节塞进 WS 二进制帧；宿主这边 lib/relay/preview.js 完成握手后
  // 与 `127.0.0.1:<port>` 双向对搬。中转与局域网代理都**不用改**——中转的升级分发只看
  // 鉴权不看路径，局域网代理更是把任意升级路径原样转给宿主 webServer。
  //
  // 端口用查询串带（`?port=3001`）：宿主的升级匹配按 pathname 精确匹配、**忽略查询串**，
  // 所以下面这个不带查询串的字面量就是那条路由本身。
  //
  // 路径字面量必须与 App 侧 apiPaths.ts 的 preview 一致：test/mobile-routes.test.cjs
  // 就是拿这张表反向核对 App 常量表的。
  // 远程终端（见 mobile/terminal.js）：白名单 CLI + 受管伪终端。
  //
  // 四条普通路由里只有 `agents` / `sessions` 是读，另两条是起与收；真正的字节流走下面的
  // 升级路由。`terminalService` 从装配层来（会话表要在插件重载时被一起收掉，不能是模块单例）。
  if (terminalService) {
    route('/api/mobile/v1/terminal/agents', terminalService.handleAgents)
    route('/api/mobile/v1/terminal/session', terminalService.handleCreate)
    route('/api/mobile/v1/terminal/close', terminalService.handleClose)
    route('/api/mobile/v1/terminal/sessions', terminalService.handleSessions)
  }
  registerUpgradeRoute({ path: '/api/mobile/v1/preview', handler: preview.handleUpgrade })
  // 终端字节流：与预览同一套升级机制（中转与局域网代理都不看路径）。
  if (terminalService) registerUpgradeRoute({ path: '/api/mobile/v1/terminal/stream', handler: terminalService.handleUpgrade })

  // CLI 对话（见 mobile/cli/service.js）：同一批白名单 CLI，但走 ACP —— 手机拿到的是结构化
  // 的消息 / 工具调用 / 审批请求，所以能像正常对话一样渲染，而不是一块终端屏幕。
  //
  // 与终端那组并列存在，不是替换：终端留着给「我要看原始 TUI」的那一档。`cliService` 同样
  // 从装配层来（会话表要在插件重载时被一起收掉，不能是模块单例）。
  if (cliService) {
    route('/api/mobile/v1/cli/agents', cliService.handleAgents)
    route('/api/mobile/v1/cli/session', cliService.handleCreate)
    route('/api/mobile/v1/cli/close', cliService.handleClose)
    route('/api/mobile/v1/cli/sessions', cliService.handleSessions)
    // 读一份全貌 + 三个写动作。WS 是快的那条路；隧道上偶尔「握手成了、帧进不来」，这一组
    // 是它的兜底（页面轮询 detail、发送走 HTTP），两边共用服务层同一份实现。
    route('/api/mobile/v1/cli/detail', cliService.handleDetail)
    route('/api/mobile/v1/cli/prompt', cliService.handlePrompt)
    route('/api/mobile/v1/cli/permission', cliService.handlePermission)
    route('/api/mobile/v1/cli/cancel', cliService.handleCancel)
    route('/api/mobile/v1/cli/config', cliService.handleConfig)
    // 「这个 CLI 以后按哪一套跑」：配置页读它、也写它。与上一条的区别是**不动正在跑的会话**，
    // 只决定下一次开局（ACP 的配置是会话级的，所以要提前存一份，见 cli/config-prefs.js）。
    route('/api/mobile/v1/cli/prefs', cliService.handlePrefs)
    registerUpgradeRoute({ path: '/api/mobile/v1/cli/stream', handler: cliService.handleUpgrade })
  }

  // 「让 AI 操作手机」（见 mobile/phone/）：三条状态路由与一条动作字节流的升级口。
  //
  // 状态那三条都只读账本或做收尾，**没有一条能往手机上发动作**。动作只有模型在会话里通过
  // `phone_*` 工具发得出去，而且只能是那一小张固定动作表里的 —— 这里刻意不开口子，
  // `test/mobile-routes.test.cjs` 也钉着这张表里不许出现 shell / exec 一类路径。
  if (phoneService) {
    const phoneRoutes = createPhoneRoutes({
      getService: () => phoneService,
      credentials: phoneService.credentials,
      instanceId: phoneService.instanceId,
    })
    route('/api/mobile/v1/phone/status', phoneRoutes.status)
    route('/api/mobile/v1/phone/devices', phoneRoutes.devices)
    route('/api/mobile/v1/phone/unbind', phoneRoutes.unbind)
    registerUpgradeRoute({ path: '/api/mobile/v1/phone/control', handler: phoneService.handleUpgrade })
  }

  // 公众号文章库（见 mobile/wechat.js）：文章存在这台电脑上，手机只读。
  //
  // 能力面只多「读这一个固定目录」：编号形状卡死（`wx` + 8 位十六进制）、图片名不含斜杠，
  // 路径全由宿主拼。写文章那条正常走 AI 的工具（`wechat_article_write`）；这里那条 POST
  // 是给以后「手机上改名 / 删除」留的，App 目前没有入口。
  route('/api/mobile/v1/wechat/articles', wechat.handleArticleList)
  route('/api/mobile/v1/wechat/article', wechat.handleArticleRead)
  route('/api/mobile/v1/wechat/media', wechat.handleArticleMedia)
  route('/api/mobile/v1/wechat/article/save', wechat.handleArticleWrite)
  route('/api/mobile/v1/wechat/article/delete', wechat.handleArticleDelete)

  // 悬浮宠物的包目录（见 mobile/pets.js）：内置包随插件包走、只读，用户包在
  // `$DSH_HOME/storages/mobile-plugin/pets/`。能力面只多「读这两个固定目录 + 删一个用户包」：
  // id 与文件名都卡成不含斜杠的形状，取文件还要对上列表里那一份，客户端给不了路径。
  // 建包走 AI 的工具（`pet_pack_write`）；删是人的动作，所以只有那一条 POST。
  route('/api/mobile/v1/pet/packs', pets.handlePackList)
  route('/api/mobile/v1/pet/pack/file', pets.handlePackFile)
  route('/api/mobile/v1/pet/pack/delete', pets.handlePackDelete)
}

module.exports = { registerMobileRoutes };

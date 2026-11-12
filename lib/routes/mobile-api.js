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
const { createP2PRendezvousHandler } = require('../p2p/rendezvous.cjs');
const { orderCandidates, withManualCandidate, withManualIpv6Candidate } = require('../relay/lan-network.cjs');
// 中转地址两格的收敛（`relayUrls[0] === relayUrl`）。直接 require 而不是走注入：它是纯函数，
// 而这两条路由里少一格就是「手机看到两个矛盾的地址」，不该依赖装配层有没有把它递进来。
const { relayAddressesOf } = require('../relay/core.js');

const sessions = require('../mobile/sessions.js');
const sessionModelOptions = require('../mobile/session-model-options.js');
const sessionFile = require('../mobile/session-file.js');
// 「这次的产出」：清单补 stat 与勾几份打包（见 mobile/session-artifacts.js）。两条都只读，
// 放行面直接复用 `/session/file` 那份判定 —— 能 stat / 打包的路径与能下载的完全重合。
const sessionArtifacts = require('../mobile/session-artifacts.js');
const sessionLocalImage = require('../mobile/session-local-image.js');
const sessionStep = require('../mobile/session-step.js');
// 停止后那份「本轮交代」：从这一轮的步骤流折成展示结构（见 mobile/session-stop-summary.js）。
// 只读步骤流、只算纯展示数据，不碰 shell / 系统设置 / 任意文件写。
const sessionStopSummary = require('../mobile/session-stop-summary.js');
// 一整次运行的时间线（`session/run-timeline`）：一轮跑过的每一步，给对话页那条
// 「过程 · 已跑 N 步」的整页版。**只读**：直播副本优先，落定的轮按轮回拉一小窗历史现折
// （见 mobile/run-timeline.js 的文件头，包括截图与标签两格为什么没有生产者）。
const runTimeline = require('../mobile/run-timeline.js');
// 回答下面那一行「来源」（这一轮读过哪些网页 / 文件 / 查询词）。纯挑选，不带正文，见那个文件头。
const answerSources = require('../mobile/answer-sources.js');
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
const skills = require('../mobile/skills.js');
// 技能编辑的写侧（列表 / 读全文 / 新建 / 保存 / 删除 / 回收站），见 mobile/skill-write.js。
// 落点只有「工作区 <projectRoot>/.dsh/skills」与「全局 <dshHome>/skills」两个固定根，
// 不收调用方给的路径，能力面没有「任意文件写」。
const skillWrite = require('../mobile/skill-write.js');
// 「项目写入暂停」的对外开关（见 mobile/project-writes.js）：右栏文件浏览器的工具栏读它 / 切它。
const projectWrites = require('../mobile/project-writes.js');
const mobileCredentials = require('../mobile/credentials.js');
const subagents = require('../mobile/subagents.js');
const monitor = require('../mobile/monitor.js');
const references = require('../mobile/references.js');
const schedule = require('../mobile/schedule.js');
// 定时任务的新建 / 编辑 / 暂停 / 恢复 / 立即执行（见 mobile/schedule-edit.js）：宿主
// ScheduleService 本来就有 create/edit/run，只是移动端一直没接 —— 手机上只能看和删。
// 暂停/恢复不是独立动词，就是 edit 的 patch.active=false/true。
const scheduleEdit = require('../mobile/schedule-edit.js');
// 文件的新建 / 删除 / 重命名（见 mobile/file-ops.js）：仍然只在 allowed-zone 里动，
// 符号链接一律拒（不顺着链接删目标）。
const fileOps = require('../mobile/file-ops.js');
// 后台任务的取消（见 mobile/jobs-control.js）：只做 cancel。启动走宿主内部 seam，
// 放开等于移动端能跑任意命令，撞「不暴露 shell」，所以那条恒 501。
const jobsControl = require('../mobile/jobs-control.js');
const pushNotifyRoute = require('../mobile/push-notify-route.js');const plugins = require('../mobile/plugins.js');
const pluginUpdate = require('../mobile/plugin-update.js');
const pluginSelf = require('../mobile/plugin-self.js');
const pluginMarket = require('../mobile/plugin-market.js');
// 社区精选清单（见 mobile/plugin-catalog.js）：手机侧「DSH 插件市场」的数据来源，只读外网 JSON。
const pluginCatalog = require('../mobile/plugin-catalog.js');
const { createRelayControlHandlers } = require('../mobile/relay-control.js');
const uploads = require('../mobile/uploads.js');
const inboxClean = require('../mobile/inbox-clean.js');
const perfTrace = require('../mobile/perf-trace.js');
// 过程播报开关（读 / 写同一条路径，由 req.method 分派）。默认关，见那个文件头。
const narration = require('../mobile/narration.js');
// 通知按事件类型分级（GET 读 / PUT 整表替换，按设备分桶）。见那个文件头。
const notificationPrefs = require('../mobile/notification-prefs.js');
const git = require('../mobile/git.js');
const pairing = require('../mobile/pairing.js');
// 设备批量同步（docs/device-batch-sync.md）：一次性入场券 + 密文收件箱。
const sync = require('../mobile/sync.js');
const { createTransferTickets } = require('../mobile/transfer-tickets.js');
const { createSyncInboxStore } = require('../mobile/sync-inbox-store.js');
const { credentialsEntry } = require('../shared/credentials-entry.js');
const { handleCredentialUpgrade } = require('../mobile/credential-upgrade.js');
// 手机自助降档：只许把自己这台设备的权限往下收，提权只能在电脑侧（见该文件头）。
const devicePermissions = require('../mobile/device-permissions.js');
const extensions = require('../mobile/extensions.js');
const extensionData = require('../mobile/extension-data.js');
const extensionDev = require('../mobile/extension-dev.js');
const extensionCatalog = require('../mobile/extension-catalog.js');
const sessionDelivery = require('../mobile/session-delivery.js');
// 体检接口要自报身份：版本号只有一个来源，就是包自己的 package.json（与 relay/status.js 同）。
const pkg = require('../../package.json');
// 「这一代运行时少挂了什么」（见 host-capabilities.cjs）：由 host.js 在启动时落账。
const { readCapabilityReport } = require('../host-capabilities.cjs');
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
/**
 * profile 的 `node_modules`：第三方插件自己带的扩展就在那底下（见 mobile/third-party-extensions.js）。
 *
 * 从运行时快照里取，而不是从 `lib/shell/manager.js` 直接 import：那一层是 ESM、只有外壳能装载，
 * 换成 OTA 代之后旧引用会指向已经不在盘上的目录。取不到就回 null —— 这时清单里只剩随本插件
 * 发布的那一档，读不到别人的扩展不算故障。
 */
function profileNodeModulesOf(ctx) {
  try {
    const runtime = typeof ctx?.get === 'function' ? ctx.get('dshMobilePluginRuntime') : null;
    const status = runtime && typeof runtime.status === 'function' ? runtime.status() : null;
    return typeof status?.profileNodeModules === 'string' ? status.profileNodeModules : null;
  } catch {
    return null;
  }
}

function registerMobileRoutes(deps) {
  const { registerRoute, tailcat, p2p, registerUpgradeRoute, guarded, state, hostMetadata, getSidecarSnapshot, safeLanCandidates, safeIpv6Candidates, lanPortInUse, preview, core, pairingApproval, rotatePairing, getHistoryKey } = deps;
  const route = (path, handler) => registerRoute({ kind: 'exact', path, handler: guarded(handler) })
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
    // 每次请求现算：`state` 是就地改的，注册那一刻算的一份会永远停在旧地址上。
    // `relayUrl` 那一格**照原样写**（`app/scripts/test-relay-address.js` 按字面钉着「关掉时给
    // null」这条兼容承诺）；列表那一格由收敛函数给，保证首项与它一致。
    const relayUrls = state.enabled ? relayAddressesOf(state).relayUrls : []
    sendJson(res, 200, {
      ok: true,
      apiVersion: API_VERSION,
      instanceId: state.instanceId || null,
      name: state.name || null,
      remoteEnabled: Boolean(state.enabled),
      // 两格一起报：`relayUrl` 是主用那条（老手机只认它，语义一个字没变），`relayUrls`
      // 是完整列表且首项恒等于前者。`enabled` 关掉时两格都是 null / []，表示「这台机器
      // 没有中转」，与「地址是空的」区分开。
      relayUrl: state.enabled ? (state.relayUrl || null) : null,
      relayUrls,
      ...hostMetadata(),
      // 点对点隧道这一格。
      //
      // **这是 App 知道「这台电脑上这条通道到底有没有」的唯一来源**：早先它没挂在这条心跳上，
      // 手机每 30 秒问一次、每次都只拿到上面那几格，于是「选择线路」里只能显示「未配置」、
      // 状态一句也同步不过来 —— 而电脑面板那边明明已经显示「等待手机接入」了。两边说的
      // 是同一件事，一边有数据一边没有，就是这里漏了一格。
      //
      // 形状与 `/api/relay/status` 的 `p2p` 完全一致（同一个 `getP2P()`），手机按该口的
      // `available / enabled / ready / started / path` 说话，不自己猜。
      p2p: p2p && typeof p2p.status === 'function' ? p2p.status() : null,
      // 这一代运行时少挂了什么（见 lib/host-capabilities.cjs）。
      //
      // 这一格存在的理由，是那类故障的形状：宿主起来、手机连上、会话能开，唯独某个工具
      // 不见了；模型只会说「这个工具不可用」，而宿主没有任何一处主动说过话。以前它只写在
      // 宿主 stderr 里——用户不会去翻，翻到了也未必看得懂「没解析到同代的一份」。
      //
      // `null` 表示**这一次启动没跑过本插件的对齐**（桌面 profile 走官方 `dsh web`，
      // 不经 host.js）；`{ missing: [] }` 表示查过、什么都没少。两者不能混成一个空数组：
      // 「没检查」和「检查了没问题」在界面上是两个意思。
      capabilities: readCapabilityReport(),
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

  // 历史 blob 的实例密钥（HK）：配对响应里已经随封包给过一次，这条是已配对设备的「按需补发」
  // 通道（换机、清了 Keychain、旧版没收到时补一次）。走 route() 即包 guarded —— 只有持有效
  // 凭据的设备才拿得到，协议 v2 的连接还会自动把响应封成信封。**这条不归中转**：中转的
  // blob 路径只存密文，HK 不进中转。
  route('/api/mobile/v1/history-key', async (_ctx, _req, res) => {
    const historyKey = typeof getHistoryKey === 'function' ? (getHistoryKey() || '') : ''
    sendJson(res, 200, { ok: true, historyKey })
  })
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
      // 协议 v2 的配对封包里要下发实例历史密钥（HK）。取值器惰性生成并落盘。
      getHistoryKey,
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

  // 手机自助降档：在「这台设备当前权限」里往下收，提不上去（提权只在电脑控制面）。任何
  // 已鉴权设备都能调（BASE，不受权限位约束）—— 收窄自己的权限本身不该被收窄挡住。
  route('/api/mobile/v1/device-credential/permissions', async (_ctx, req, res) => {
    await devicePermissions.handleDevicePermissions(req, res, { instanceId: String(state.instanceId || ''), store: credentialsEntry() })
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
    const relayUrls = state.enabled ? relayAddressesOf(state).relayUrls : []
    sendJson(res, 200, {
      ok: true,
      instanceId: state.instanceId || null,
      name: state.name || null,
      // 与心跳同一条形状：主用那条 + 完整列表，首项恒等。
      relayUrl: state.enabled ? (state.relayUrl || null) : null,
      relayUrls: state.enabled ? relayAddressesOf(state).relayUrls : [],
      lanUrls: candidates,
      lanCandidates: candidates,
      ipv6Candidates: ipv6,
      updatedAt: lanUpdatedAt,
      lastSeen: lanUpdatedAt,
    })
  })

  // 点对点隧道的会合：手机把打洞候选报上来，这里把电脑那半边拉起来、并把电脑自己的
  // 候选还回去。**没有这一步，两端谁也不知道对方的出口地址，这条通道一次都连不上**。
  // 它走这条路而不是另架服务：这一发就打在我们已经通着的链路上，只传几十个字节。
  route('/api/mobile/v1/p2p/rendezvous', createP2PRendezvousHandler({ p2p, lanPortInUse }))

  route('/api/mobile/v1/sessions', sessions.handleSessions)
  // 后台提醒服务专用：只回「在跑 / 刚完成 / 待回话 / 上一轮失败」这几格，
  // 带 `?rev=` 条件刷新。它要替掉原生那边每 8 秒一发的完整清单（那份还得为 20 个
  // 会话各读一次 history 补预览），见 mobile/monitor.js。
  route('/api/mobile/v1/monitor', monitor.handleMonitor)
  // iOS 推送令牌上报：App 把 APNs 令牌交给宿主，宿主经隧道帧转交中转落表。中转没配
  // 密钥时那头静默忽略——这条路由照常回 ok，「推没推成」不是 App 要操心的事。
  // 判据（要不要收这个令牌）与配对同一把锁：guarded 已核过设备身份。
  route('/api/mobile/v1/push-token', pushNotifyRoute.createPushTokenHandler({ pushNotify: deps.pushNotify }))
  route('/api/mobile/v1/perf-trace', perfTrace.handlePerfTrace)
  route('/api/mobile/v1/session', sessions.handleSession)
  route('/api/mobile/v1/session/messages', sessions.handleMessages)
  // 一步的过程详情：清单只带一行摘要，点开某一步才来这里取参数 / 输出 / diff / 思考全文。
  route('/api/mobile/v1/session/step', sessionStep.handleSessionStep)
  // 停止交代：用户按停止后那张「已停止 · 本轮交代」卡的数据源。直播副本优先，没有就走
  // 历史最近一轮的 turnProcess.steps。**只读**，取不到回空交代（App 不出卡，不当报错）。
  route('/api/mobile/v1/session/stop-summary', sessionStopSummary.handleStopSummary)
  // 运行时间线：一轮的每一步（状态 / 摘要 / 工具名 / 耗时 / 发生时刻）。直播副本优先，
  // 没有就按 `turn` 回拉一小窗历史现折；取不到回 404 一句人话，App 落空态。
  route('/api/mobile/v1/session/run-timeline', runTimeline.handleRunTimeline)
  // 回答下面那一行「来源」：这一轮读过哪些网页 / 文件 / 查询词，至多 6 条。
  // **来源由代码挑**（只认这些工具调用），只给指针不给正文 —— 与「工具参数 / 结果正文不下发」
  // 同一条边界。不带 turn 就是最近一轮，跑着的那一轮由直播副本答。见 mobile/answer-sources.js。
  route('/api/mobile/v1/session/answer-sources', answerSources.handleAnswerSources)
  route('/api/mobile/v1/session/attachment', sessions.handleSessionAttachment)
  // 正文图的字节：按登记过的编号取，不是按路径读文件（见 mobile/local-images.js 的文件头）。
  route('/api/mobile/v1/session/local-image', sessionLocalImage.handleSessionLocalImage)
  // 会话文件：允许本会话 present 声明的路径及会话工作区内的文件（见 mobile/session-file.js）。
  route('/api/mobile/v1/session/file', sessionFile.handleSessionFile)
  // 这次的产出：清单一屏要的 size / mtime（批量 stat，三档 ok / missing / denied）。
  // 一条失败只影响那一行，整条请求照旧 200 —— 它是「给清单补一格细节」，不是一次校验。
  route('/api/mobile/v1/session/artifacts', sessionArtifacts.handleSessionArtifacts)
  // 勾中的几份现打成一个 zip：手机只下一次，下完直接弹系统分享面板。放行面同上。
  route('/api/mobile/v1/session/archive', sessionArtifacts.handleSessionArchive)
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
  // 「这类以后都同意」的本机规则账：读列表 + 逐条撤销（撤销页用）。
  route('/api/mobile/v1/approval/rules', approvals.handleApprovalRules)
  route('/api/mobile/v1/approval/rules/revoke', approvals.handleApprovalRuleRevoke)
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
  // GitHub PR 一层：列本分支的 PR、看检查、标可评审、合并（只 squash / merge）、读评论。
  // 仍然是封闭动词 —— 不收 URL / host / method / GraphQL，REST 子路径写死在 lib/git/pr.js。
  route('/api/mobile/v1/git/prs', git.handleGitPrs)
  route('/api/mobile/v1/git/pr/checks', git.handleGitPrChecks)
  route('/api/mobile/v1/git/pr/ready', git.handleGitPrReady)
  route('/api/mobile/v1/git/pr/merge', git.handleGitPrMerge)
  route('/api/mobile/v1/git/pr/comments', git.handleGitPrComments)
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
  // 技能编辑（写侧，见 mobile/skill-write.js）：列表 / 读全文 / 新建 / 保存 / 删除 / 回收站。
  // 保存用 revision（正文 sha256）做 CAS，冲突回 409 带 base / current / submitted 三份正文。
  // 所有落点都是「固定技能根 + 合法技能名」拼出来的，不改技能目录以外的任何文件。
  route('/api/mobile/v1/skill/list', skillWrite.handleSkillList)
  route('/api/mobile/v1/skill/content', skillWrite.handleSkillContent)
  route('/api/mobile/v1/skill/create', skillWrite.handleSkillCreate)
  route('/api/mobile/v1/skill/save', skillWrite.handleSkillSave)
  route('/api/mobile/v1/skill/delete', skillWrite.handleSkillDelete)
  route('/api/mobile/v1/skill/trash', skillWrite.handleSkillTrash)
  route('/api/mobile/v1/skill/trash/restore', skillWrite.handleSkillTrashRestore)
  // 项目写入暂停（见 mobile/project-writes.js）：GET 读、POST 切。只影响插件自己发起的
  // 那三个写接口的排队，不落盘任何文件，所以归 view 而不是 files.write。
  route('/api/mobile/v1/project/writes', projectWrites.handleProjectWrites)
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
  // 写侧五条：新建、编辑、暂停、恢复、立即执行（见 mobile/schedule-edit.js）。
  // 宿主没有独立 pause/resume 动词，暂停恢复就是 edit 的 patch.active；CAS 用
  // expectedUpdatedAt 透传，冲突回 409。宿主没有 schedule 服务时统一 503。
  route('/api/mobile/v1/schedule/create', scheduleEdit.handleScheduleCreate)
  route('/api/mobile/v1/schedule/update', scheduleEdit.handleScheduleEdit)
  route('/api/mobile/v1/schedule/pause', scheduleEdit.handleSchedulePause)
  route('/api/mobile/v1/schedule/resume', scheduleEdit.handleScheduleResume)
  route('/api/mobile/v1/schedule/run', scheduleEdit.handleScheduleRun)

  // 文件的新建 / 删除 / 重命名（见 mobile/file-ops.js）：只在 allowed-zone（工作区 ∪ 当前
  // 会话目录）里动，realpath 校验堵软链逃逸，删除拒符号链接。能力面没有「任意文件写」。
  route('/api/mobile/v1/file/create', fileOps.handleFileCreate)
  route('/api/mobile/v1/file/delete', fileOps.handleFileDelete)
  route('/api/mobile/v1/file/rename', fileOps.handleFileRename)

  // 后台任务的取消（见 mobile/jobs-control.js）：只能取消，启动恒 501（宿主 start 是内部
  // seam，放开等于移动端跑任意命令，撞「不暴露 shell」）。
  route('/api/mobile/v1/jobs/cancel', jobsControl.handleJobsCancel)
  route('/api/mobile/v1/jobs/start', jobsControl.handleJobsStart)

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
  // 这里只搬结果。**卸载只对宿主说 `removable` 的包开放**（承载手机连接的那个、DSH 自带
  // 与安装提供的官方包一律不看这颗按钮）；停用同理。
  //
  // 装一次可能几十秒到几分钟，所以 install / update / remove 只回 202 + requestId，进度另开
  // 一条轮询 —— 手机切后台、断线重连都不该把一次安装拖断。安装时的 npm 源由 registries 那条
  // 给选择器：主源 / 备用源 / pnpm 实际读到的那个都原样报上来。
  route('/api/mobile/v1/plugin/market', pluginMarket.handlePluginMarket)
  route('/api/mobile/v1/plugin/market/registries', pluginMarket.handlePluginMarketRegistries)
  route('/api/mobile/v1/plugin/market/detail', pluginMarket.handlePluginMarketDetail)
  route('/api/mobile/v1/plugin/market/remove', pluginMarket.handlePluginMarketRemove)
  route('/api/mobile/v1/plugin/market/inspect', pluginMarket.handlePluginMarketInspect)
  route('/api/mobile/v1/plugin/market/install', pluginMarket.handlePluginMarketInstall)
  route('/api/mobile/v1/plugin/market/update', pluginMarket.handlePluginMarketUpdate)
  route('/api/mobile/v1/plugin/market/progress', pluginMarket.handlePluginMarketProgress)
  route('/api/mobile/v1/plugin/market/cancel', pluginMarket.handlePluginMarketCancel)
  route('/api/mobile/v1/plugin/market/enabled', pluginMarket.handlePluginMarketEnabled)

  // 「DSH 插件市场」那一页的清单（见 mobile/plugin-catalog.js）：社区精选清单收窄成手机要
  // 的形状，只读、带 10 分钟缓存。装的动作仍走上面已有的 `/plugin/market/install`。
  route('/api/mobile/v1/plugin/catalog', pluginCatalog.handlePluginCatalog)

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

  // 扩展页请宿主代取数据（能力 host.data，见 mobile/extension-data.js）。
  //
  // 通用通道：声明了 hostData 的扩展页（从本地 file:// 加载，够不到宿主服务）把命中的请求
  // 交给宿主，宿主按登记表去问目标服务、把结果原样带回。只到登记过的服务、只走它 allow 的
  // 路径前缀，不暴露 shell / 系统设置 / 任意文件读写 —— 与其余扩展路由同一档边界。
  route('/api/mobile/v1/extension/data', extensionData.handleExtensionData)

  // 扩展**开发包**：作者放在电脑上的本地扩展目录（`$DSH_HOME/extension-dev`），手机上直接
  // 列包、取文件，不用每改一行都发一次分发系统（见 mobile/extension-dev.js）。
  //
  // 能力面只多「读这一个固定目录」：slug 与包内相对路径拼出来的路径，取文件前先 resolve
  // 再判前缀。仍然不暴露 shell、系统设置、任意文件读写 —— 不接受任意路径，也不给写。
  route('/api/mobile/v1/extension/dev/packages', extensionDev.handleDevPackages)
  route('/api/mobile/v1/extension/dev/file', extensionDev.handleDevFile)
  // 整包：手机装开发包也只下这一个 zip，不再逐个拉几百个文件（回退那条已经封了）。
  route('/api/mobile/v1/extension/dev/archive', extensionDev.handleDevArchive)

  // 这一台电脑能给手机装的全部扩展（见 mobile/extension-catalog.js）：
  //  ① 随本插件发布的：只读包内 extensions/ 这一个固定目录，catalog.json 是审核清单；
  //  ② 第三方插件自己带的：profile 里哪个插件的 package.json 声明了 `dshMobileExtensions`，
  //     它那份目录里的每个子目录就是一个扩展，我们这边不认识作者、也不审。
  // 两档共用同一份「能不能装」的判据（入口页 / 体积 / 文件数），文件清单的 size 与 sha256
  // 由宿主扫目录现算，不信任何自报数字；取文件仍先 resolve 再判前缀，不接受任意路径。
  // 能力面与开发包那两条同一档 —— 不暴露 shell / 系统设置 / 任意文件读写，也不给写。
  route('/api/mobile/v1/extension/catalog', (ctx, req, res) => (
    extensionCatalog.handleCatalog(ctx, req, res, undefined, profileNodeModulesOf(ctx))
  ))
  route('/api/mobile/v1/extension/catalog/file', (ctx, req, res) => (
    extensionCatalog.handleCatalogFile(ctx, req, res, undefined, profileNodeModulesOf(ctx))
  ))
  // 整包一次下发（zip → base64），手机下载一个包再本地解包，不再逐文件拉几百次。
  // 随本插件发布那一档读产包脚本预先放好的 `<slug>.zip`；第三方插件自己带的那一档由宿主现打
  // （那台电脑上不会有别人替他打包），所以同样要把 profile 的 node_modules 传进去。
  route('/api/mobile/v1/extension/catalog/archive', (ctx, req, res) => (
    extensionCatalog.handleCatalogArchive(ctx, req, res, undefined, profileNodeModulesOf(ctx))
  ))

  // 分享文件的落地通道（App 把手机分享进来的文件分片传上来，见 mobile/uploads.js）。
  // 手机端没有「把文件交给宿主」的路：图片能进 session.send 的 base64 内容块，其它格式
  // 一律进不去。四条端点只做「收字节 → 落盘」：默认落到 `~/.dsh/mobile-inbox/<日期>/<文件名>`，
  // 落盘路径由 App 写成 @提及 再随消息发给宿主；带 `destPath` 时落到那个目录（右栏的
  // 「传到这里」），它必须在 mobile/allowed-zone.js 的允许区内。
  route('/api/mobile/v1/upload/begin', uploads.handleUploadBegin)
  route('/api/mobile/v1/upload/chunk', uploads.handleUploadChunk)
  route('/api/mobile/v1/upload/finish', uploads.handleUploadFinish)
  route('/api/mobile/v1/upload/abort', uploads.handleUploadAbort)

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
  // 通知按事件类型分级（GET 读、PUT 整表替换 `{events}`）。按设备的 `deviceId` 各存一份，
  // 同一条按方法分派（宿主注册器不分方法，与上面 narration 同一条路）。
  route('/api/mobile/v1/notification-prefs', notificationPrefs.handleNotificationPrefs)

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
  registerUpgradeRoute({ path: '/api/mobile/v1/preview', handler: preview.handleUpgrade })

}

module.exports = { registerMobileRoutes };

// 2026-11-25：专属回环入口随局域网代理一起启动，实绑端口上报宿主落盘；sidecar 白名单放行该运行时字段。
// 主动重连只重建中转隧道，手工换址先清掉过期的自动选路账。
// 绑定遵守固定入口策略，网卡变化及时通知宿主上报目录。
// blob分片等中转持久化确认，发送失败沿本机RPC返回生产者。
// 管理中转注册真值，以单调经过时间约束失败账和首连竞速，保留独立 IPv6 监听。
'use strict'
// LAN 生命周期等待旧监听释放，并由同一处绑定与发布入口。
// 转发给宿主 web 服务的上游地址跟随宿主实际绑定地址（不再写死回环）。

/**
 * sidecar worker：真正持有「中转隧道 + 局域网代理」的那个子进程。
 *
 * 宿主不自己开 WebSocket、也不自己监听局域网端口，而是 fork 出这个 worker，用环回 HTTP +
 * Bearer 令牌对话。隧道崩了、原生模块加载失败都只死一个子进程，宿主仍能如实回报状态。
 *
 * 四条不能忘的语义：
 * 1. 状态既要在 `/status` 上可查，也要在变化那一刻主动 `process.send` 给宿主：健康轮询是
 *    10s 一次，只靠轮询的话隧道真断后宿主最多 10s 仍以为连着；「断又连」落在两次轮询之间时
 *    那次全量补推也会漏掉。
 * 2. `/tunnel/send` 先把快照留在本地再尝试真发：局域网直连的手机读本地这份，隧道断了也不
 *    至于读到过期镜像。
 * 3. 请求体一律先量后读：`/configure` 与镜像帧都有字节上限，超限立刻 413。
 * 4. 换中转地址不是「拆了重建」：先在旧隧道上登记迁移，再建新隧道，注册不上要撤销
 *    （见 lib/relay/migrate.js）。这条顺序是「填错地址就把自己锁在外面」的唯一解。
 * 5. 无当前连接时按健康延迟与注册失败账排序，最多三条并行，第一条注册成功的当主用，
 *    全不通再退避；换成功只把它提到队首、报给宿主写回，**不发 migrate 帧**（自动换发生在旧地址已经
 *    连不上的时刻，旧中转上那台机器的隧道早就断了，没人需要被指路）。
 */

const http = require('node:http')
const { performance } = require('node:perf_hooks')
const { RelayTunnel } = require('./relay/tunnel.js')
const { T } = require('./relay/protocol.js')
const { switchRelay } = require('./relay/migrate.js')
const { createLanProxy } = require('./relay/lan-proxy.js')
const { createLanDiscovery, bindLanEndpoint } = require('./relay/lan-discovery.cjs')
const { lanUrls, ipv6Urls } = require('./relay/lan-network.cjs')
const core = require('./relay/core.js')
const { probeRelayHealth, createRelayRegistrationLedger, relayFailureMessage } = require('./relay/relay-probe.js')
const { createReconnectScheduler } = require('./reconnect-scheduler.cjs')
const { isMirrorSnapshotFresh } = require('./mirror-snapshot.cjs')
const { snapshotAuthorized, snapshotAuthRecord } = require('./relay/snapshot-auth.js')
// 凭据库在这个进程里**只读**（§3.7）：写盘只有宿主主进程一家。签发与吊销都经 IPC 交给它，
// 本地这份按文件指纹重载 —— 两个进程各持一份内存副本、各自整份覆写，后写的赢，于是
// 「经中转配上的手机回局域网 401」「吊销被回滚」这两条必然出现。
const credentials = require('./shared/credentials-entry.js').credentialsEntry()
if (typeof credentials.setReadOnly === 'function') credentials.setReadOnly(true)

const parentPort = Number(process.env.DSH_SIDECAR_PARENT_PORT)
const token = process.env.DSH_SIDECAR_TOKEN
const authorization = `Bearer ${token}`
let config = {}
/**
 * 按凭据查记录：先查当前号，过渡期再兜底旧号（见 core.rotateIdentity）。
 * 只用于「认不认这枚凭据」，配对签发仍只用当前号。
 */
function lookupAccepted(presented) {
  return credentials.lookup(presented, config.instanceId)
    || (config.previousInstanceId ? credentials.lookup(presented, config.previousInstanceId) : null)
}
/** 旧的无状态令牌验签：同样当前号优先、旧号兜底。 */
function verifyLanAccepted(presented) {
  return core.verifyLanToken(config.lanSecret, presented, config.instanceId)
    || (config.previousInstanceId ? core.verifyLanToken(config.lanSecret, presented, config.previousInstanceId) : false)
}
const sockets = new Set()
let tunnel = null
let lan = null
let tunnelState = 'off'
let tunnelError = null
// 当前这条隧道的对端存不存镜像（注册回执里报的）。false ⇒ 宿主只推摘要帧，正文不推。
// 未知与老中转一律按 true：那是原来的行为，别让一次漏字段把镜像功能悄悄降级。
let relayMirror = true
/**
 * 这一轮择路的账：试到第几条、当前连的是哪条、宿主要不要把它写回队首。
 *
 * 只报事实、不改行为：真正落盘的是宿主主进程（`relay.json` 只有它能写）。这里唯一被
 * 它影响的动作是「连上的不是队首时把中选的那条提到队首」，而且**只在本进程的 config
 * 上做**——不让宿主写回之后下发的列表与本进程记的顺序不同，那会让 `tunnelSignature`
 * 跟着变，刚连上的隧道被自己拆掉重建一次。
 *
 * @type {null | { url: string, index: number, tried: number, total: number, urls: string[], adopted: boolean }}
 */
let tunnelRoute = null
let connectedRelayUrl = null
/** 在飞注册由竞速独占；未 registered 的 close 不写业务状态，统一由注册 Promise 结账。 */
let relayRace = null
const relayRegistrations = createRelayRegistrationLedger()
const RELAY_RACE_CONCURRENCY = 3
const RELAY_RACE_TIMEOUT_MS = 10_000
/**
 * 每个候选地址最近一次实测的身份健康延迟（URL→毫秒；null = 不可达）。
 *
 * 电脑侧按实测延迟排序候选，最快的那台排前面先试。`relayLatencyAt` 是那次探测的时间戳，
 * 5 分钟保鲜期内沿用这份结果；过期了 `relayRoutePlan` 就退回配置原序，等下一次
 * `startTunnel` 重新探测再进来。
 */
let relayLatencyCache = new Map()
let relayLatencyAt = 0
/** 一轮探活里最多几条同时在探（地址池变大时的并发上限，见 refreshRelayLatency）。 */
const PROBE_CONCURRENCY = 6
/**
 * 隧道世代号：停止或手动换线时前进，旧代竞速与健康探测都不能再接管当前状态。
 * 同实例的迟到注册会顶掉新连接，所以旧代候选必须同时主动停止，不能只忽略回调。
 */
let tunnelGeneration = 0
let lanState = 'off'
let lanError = null
let lanDiscovery = null
let lanRequestedPort = 0
let lanGeneration = 0
// 对外入口只从实际监听的端口生成，未监听时不发布候选。
let lanBoundPort = 0
// 专属回环入口的实绑端口：与主入口无关，绑好就上报宿主保存，被占后内核另分的值也走这条路。
let lanIngressPort = 0
function lanUrlPort() { return lanBoundPort || config.lanPort }
/**
 * 隧道/局域网状态一变就**立刻**经 IPC 推给宿主，别等宿主那 10s 一次的健康轮询。
 *
 * 轮询仍然是权威（只有它能发现「worker 整个死了」——那时 IPC 也断了，没人会推），
 * 但它是滞后的：隧道真断之后宿主最多 10s 仍认为已连接，期间照常推镜像，每次撞
 * sidecar-facade 的 5s 超时，该会话的单飞门被占住，事件只能合并成一次补推。反过来，
 * 隧道「断又连」若整段落在两次轮询之间，宿主看不到跳变，onTunnelUp 那次全量补推会被漏掉。
 *
 * 所以：轮询继续做权威兜底，状态跳变由这里即时上报（见 lib/sidecar-lifecycle.cjs 的
 * applyTunnelState —— 两条来源共用一个边沿判定，不会重复触发补推）。
 */
function publishState() {
  process.send?.({
    type: 'state',
    // `route` 是这一轮择路的账：当前连的是哪条、是列表里第几条、试过几条。
    // 宿主拿它决定「该把中选的那条写回队首了」，手机拿它诊断「为什么不是我配的那条」。
    tunnel: { state: tunnelState, error: tunnelError, mirror: relayMirror, relayUrl: tunnelState === 'connected' ? connectedRelayUrl : null, ...(tunnelRoute ? { route: tunnelRoute } : {}) },
    lan: { enabled: Boolean(config.lanEnabled), port: lanUrlPort(), requestedPort: lanRequestedPort || config.lanPort, ingressPort: lanIngressPort, state: lanState, error: lanError, discovery: lanDiscovery?.snapshot() || { state: 'off', error: null } },
  })
}
let networkTimer = null
let configuring = Promise.resolve()
let localSnapshot = null // 桌面 pushSync 推来的移动端镜像快照（本机保留供读取隔离）
const NETWORK_POLL_MS = 5000
// 隧道重连间隔。onClose 与 start().catch 两条失败路径共用这个幂等调度器，
// 否则每次失败会排两个定时器（重连风暴）；幂等性由
// test/reconnect-scheduler.test.cjs 精确验证。
//
// 抖动 2s：中转重启后所有宿主在同一刻掉线，固定间隔会让它们踩着同一个点回来。
// 退避到 30s：中转没起来时不该每 5 秒敲一次；注册成功由 onRegistered 里的 reset 清账。
const RECONNECT_DELAY_MS = 5000
const RECONNECT_JITTER_MS = 2000
const RECONNECT_MAX_DELAY_MS = 30_000
const reconnect = createReconnectScheduler({
  delayMs: RECONNECT_DELAY_MS,
  jitterMs: RECONNECT_JITTER_MS,
  maxDelayMs: RECONNECT_MAX_DELAY_MS,
  onFire: () => startTunnel(),
})

/**
 * 被中转按「插件太旧」挡下来时的重连间隔。
 *
 * 这一档不是故障：链路是通的，是这台的插件版本低于中转的门槛（`MIN_PLUGIN_VERSION`）。
 * 按 5 秒退避重连一点用都没有——门槛不会因为多敲几次就降下来，而所有老宿主一起敲会把
 * 中转的握手与日志刷满。半小时一次既能让「装上新版之后半小时内自动恢复」，也不会给中转
 * 添负担。宿主重启（装完插件之后通常就是重启 DSH）会立刻重来一次。
 */
const OUTDATED_RETRY_MS = 30 * 60 * 1000

/**
 * 被中转以「插件太旧」挡下来时的收尾：状态另立成 `outdated`、记录那句话、三十分钟后再试。
 *
 * 单独成函数而不是散在两处回调里，是因为它必须**带实例身份闸**（`telemetry` 之外的任何
 * 状态写入点都要），而回调里那一行闸只管得到紧挨着的那一句；收成一个有闸的入口，
 * 两处调用就都只有一行、也不会漏。
 *
 * 返回 true 表示这一轮已经按「版本过旧」处理完了，调用方别再走普通断线那条路。
 */
function markOutdated(current) {
  if (tunnel !== current) return true
  const info = (current && current.lastControlError) || null
  if (!info || info.code !== 'plugin_too_old') return false
  tunnelState = 'outdated'
  tunnelError = info.message || '插件版本过旧，请更新'
  publishState()
  reconnect.cancel()
  reconnect.schedule(OUTDATED_RETRY_MS)
  return true
}

function send(res, code, value) {
  if (res.headersSent) return res.end()
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}
function authorized(req) { return typeof token === 'string' && token.length >= 64 && req.headers.authorization === authorization }
// 请求体超限要能和外层异常区分开：它是请求本身的问题（4xx），不是服务不可用。
// 旧实现在这里一律 reject(new Error('request too large'))，最后被 catch-all 兜成 503，
// 宿主侧记下来的就是一条没头没尾的「sidecar facade request failed: 503」。
class BodyTooLarge extends Error {}
/** /tunnel/send 的请求体上限。
 *
 * 这个接口收桌面推给移动端的镜像：整份会话列表、工作区、当前会话的完整消息与统计。桌面一次
 * 推送就超过 1MB，旧的 1MB 上限把有用的东西挡在门外。
 *
 * 依据是中转那侧的帧上限（默认 8MB）：一帧超过它，中转会以 1009 'frame too large' 直接关掉
 * 隧道。丢一次镜像可以恢复，隧道被关掉要等重连、期间手机端全瞎。所以留 64KB 余量给帧头，
 * 推得再大也只是这一次 413。
 */
const TUNNEL_SEND_MAX_BODY = 8 * 1024 * 1024 - 64 * 1024

/**
 * 推给中转的那一份镜像：只留中转真的会读的字段。
 *
 * 桌面推上来的整份载荷里有四块：`sessions`、`workspaces`、`messages`、`stats`/`models`。
 * 中转（`server/relay/rust/src/mirror.rs` 的 `remember`）只落**前两块**，另外三块
 * 解析完就丢——它只解决「宿主不在线时手机还看得见清单」，会话正文有自己那条
 * `/session/messages` 通道。而正文快照恰好是最大的一块：实测一个 200 条消息的会话
 * 快照约 58KB，而它在每个会话事件上都会被重推一次。
 *
 * 所以**上隧道的那一份裁掉三块，本地快照（localSnapshot）照旧留全份**——局域网直连的
 * 手机走 `snapshotRead` 读的就是本地那份，裁了它等于把读取隔离一起砍掉。
 *
 * 裁字段而不是改推送策略：宿主那侧「推什么、什么时候推」一个字都不用改，两侧版本
 * 不必同时上线（老 worker + 新宿主也照旧工作，只是白推；新 worker + 老宿主也照旧）。
 */
/**
 * 对端不存镜像时上隧道的那一帧：只留中转还会真的读的东西。
 *
 * 纯转发节点（`MIRROR_CACHE=0`）的 `mirror::remember` 只留凭据摘要与时间戳，两份清单正文
 * 解析完就丢——那是每台宿主每 5 秒几十 KB、一天上百 GB 的白推。所以对端在注册回执里说
 * `mirror:false` 之后，清单与工作区各只留 `ok` 和 `revision`：
 *
 * - `ok` 必须留着，中转用它判「这份镜像是不是畸形」；
 * - `revision` 必须留着，它是中转镜像账本里那一版的身份；
 * - `creds` 必须留着，`/push-token` 的鉴权真源就是这本账里的摘要，丢了它上报全 403。
 *
 * 本地快照不受影响：`localSnapshot` 在这一帧被裁之前就已经赋值，局域网直连的读取隔离
 * 读的是它（见 `/tunnel/send` 那一段）。
 */
function digestFrame(body) {
  const pick = (value) => {
    const out = { ok: true }
    if (value && typeof value === 'object' && typeof value.revision === 'string') out.revision = value.revision
    return out
  }
  return {
    kind: 'sync',
    at: body.at,
    sessions: pick(body.sessions),
    workspaces: pick(body.workspaces),
    creds: Array.isArray(body.creds) ? body.creds : [],
  }
}

function frameForTunnel(body, mirrorOff = false) {
  if (!body || typeof body !== 'object') return { kind: 'raw', data: body }
  if (body.kind !== 'sync') return body
  const { messages, stats, models, ...rest } = body
  return mirrorOff ? digestFrame(rest) : rest
}
// /configure 只送 relay.json 那几十个字段，给 64KB 绰绰有余；放宽只会让误用更难发现。
const CONFIGURE_MAX_BODY = 64 * 1024
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let raw = ''
    let size = 0
    let over = false
    req.on('data', chunk => {
      if (over) return
      size += chunk.length
      if (size > limit) {
        // 关键：拒了之后必须停止累积。旧实现在 reject 之后继续往 raw 上拼，
        // 一个已被判定超限的请求照样把整个 body 读进内存——上限反倒成了放大器。
        over = true
        raw = ''
        return reject(new BodyTooLarge(`request body too large (${size} > ${limit} bytes)`))
      }
      raw += chunk
    })
    req.on('end', () => { if (over) return; try { resolve(JSON.parse(raw || '{}')) } catch (error) { reject(error) } })
    req.on('error', reject)
  })
}
function parentRequest(path, body, signal) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: parentPort, path, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, timeout: 10000 }, resolve)
    req.on('error', reject)
    signal?.addEventListener('abort', () => req.destroy(), { once: true })
    req.end(JSON.stringify(body))
  })
}
async function parentJson(path, body, signal) {
  const res = await parentRequest(path, body, signal)
  let raw = ''; res.setEncoding('utf8'); for await (const chunk of res) raw += chunk
  let value; try { value = JSON.parse(raw || '{}') } catch { throw new Error('invalid parent RPC response') }
  if (res.statusCode !== 200) throw new Error(value.error?.message || value.error || `parent RPC failed: ${res.statusCode}`)
  return value.data ?? value
}
function upstream() {
  const host = config.upstreamHost || '127.0.0.1'
  // URL 里的 IPv6 字面量要方括号，否则 `new URL` 解析不出来。
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.upstreamPort}`
}
// 读取隔离：把移动端高频读请求（sessions/workspaces/messages/stats）从本地快照直接回，
// 不再打扰主进程。快照缺失或路径不在清单内时返回 null → 调用方回源主进程。
function snapshotRead(info) {
  // **协议 v2 的会话不走这条捷径**：这里直接回序列化好的 JSON，绕开了主进程的守卫 ——
  // 请求信封没验、响应也没封。表现是「加密会话的高频读（列表 / 工作区 / 消息 / 统计）
  // 全程明文过中转」，而且静默（App 收到明文只是降级，不报错）。回 null 让调用方回源
  // 主进程，那条路有 `rev` 条件刷新，稳态只回几十字节，比这里回 38KB 还省。
  const proto = info && info.headers ? String(info.headers['x-dsh-proto'] || info.headers['X-Dsh-Proto'] || '') : ''
  if (proto.trim() === '2') return null
  // 镜像只在中转连着时才会有新版本推来（原因见 mirror-snapshot.cjs 的说明）：冻结的快照必须
  // 回源主进程，否则中转一断、局域网仍健康时，新建的会话/工作区在 App 里永远不出现。
  if (!isMirrorSnapshotFresh(localSnapshot)) return null
  // **鉴权**：这条捷径绕开主进程守卫直接回快照，必须自己验一遍凭据。否则只要知道实例号
  // （印在配对二维码上），不带任何凭据也能经中转读到会话 / 工作区列表。验不过回 null 回源，
  // 交给主进程守卫如实驳回（401）；被吊销 / 已过期的凭据同样回落，吊销才不会在这条路上失效。
  if (!snapshotAuthorized(info && info.headers, {
    lookup: lookupAccepted,
    verifyLanToken: verifyLanAccepted,
  })) return null
  // **v2 绑定设备不能因中转删掉协议版本头就回明文快照**：这条捷径不封信封，一旦把一条
  // 绑了 `deviceKey` 的凭据当成老客户端，它要的列表 / 工作区就会以明文经中转送出去——
  // 主进程那条 `e2ee-required` 拦不到捷径这一层。认得出是设备密钥凭据就回源，交给主进程
  // 按「加密会话没带信封」如实驳回（见 lib/http/routing.js）。
  const boundRecord = snapshotAuthRecord(info && info.headers, {
    lookup: lookupAccepted,
  })
  if (boundRecord && boundRecord.deviceKey) return null
  let url
  try { url = new URL(String((info && info.path) || ''), 'http://127.0.0.1') } catch { return null }
  const pathname = url.pathname
  const body =
    pathname === '/api/mobile/v1/sessions' ? localSnapshot.sessions
    : pathname === '/api/mobile/v1/workspaces' ? localSnapshot.workspaces
    : pathname === '/api/mobile/v1/session/messages' ? (localSnapshot.messages || {})[url.searchParams.get('sessionId') || '']
    : pathname === '/api/mobile/v1/session/stats' ? (localSnapshot.stats || {})[url.searchParams.get('sessionId') || '']
    : null
  if (!body || typeof body !== 'object' || body.ok !== true) return null
  if (pathname === '/api/mobile/v1/session/messages') {
    // **按内容裁的入口窗口（`thin=1`）不走这条捷径**：镜像里存的是一份完整窗口
    // （最多 200 条消息），对着一轮跑过上百步的会话，它照样可能整条挤掉用户那句话 ——
    // 那正是「进对话只剩 AI 的半轮」这个缺陷本身。裁剪是主进程按轮算的，这里回 null 让它
    // 回源；入口那一发进对话只发一次，不是轮询。
    if (url.searchParams.get('thin') === '1') return null
    // 带 beforeSeq 的是**翻页**（往上翻历史 / 补取某一轮的过程明细）：镜像只有尾部一份窗口，
    // 它答不了「比这条更早」——早年这里直接回整份，调用方按 seq 自己过滤，看着能用，
    // 但只要一轮比镜像窗口还长，补取就会在原地转三圈什么也拿不到。回源主进程。
    const beforeSeqRaw = url.searchParams.get('beforeSeq')
    if (beforeSeqRaw !== null && beforeSeqRaw !== '') return null
    const afterSeqRaw = url.searchParams.get('afterSeq')
    if (afterSeqRaw !== null && afterSeqRaw !== '' && /^\d+$/.test(afterSeqRaw)) {
      const after = Number(afterSeqRaw)
      const items = Array.isArray(body.items) ? body.items.filter((it) => (typeof it?.seq === 'number' ? it.seq > after : true)) : body.items
      const lastSeq = items && items.length ? Math.max(...items.map((it) => it?.seq || 0)) : after
      return { ...body, items, lastSeq }
    }
  }
  return body
}
/**
 * 「这份配置里哪几项决定隧道要重建」。
 *
 * 只有决定**连到哪台、以谁的身份连**的字段在这里。配对码、名字、局域网候选都
 * 不在此列——它们能在现有连接上重报一次注册信息就生效（见 reannounceRegistration）。
 *
 * 为什么要把这条显式写出来：以前 `configure()` 是无条件 `stopServices()` 把隧道和
 * 局域网代理一起拆了重建，于是每次配置下发（哪怕一个字段没变）都是一次全断。真机
 * 现场就是「切个网络，接下来几秒点什么都失败」，宿主日志里是一串「隧道关闭 + 局域网
 * 代理开始监听」，跑几小时后内存堆到几个 G 把宿主撑爆。
 *
 * `relayUrls` 从这一轮起**要进签名**：地址组变了就得重新择路，不进签名那次下发会被判成
 * 「什么都没变」，隧道继续挂在一条已经不在这组里的旧地址上。上一轮刻意排除它是因为那时
 * 还没有择路；现在换了前提，别照着旧注释办。
 *
 * 签名比的是**顺序**，因为顺序就是优先级：把中选的那条提到队首本身就是一次「要重新择路」
 * 的信号。这也意味着写回队首之后**不能**再触发一次配置下发 —— 见 adoptRoute 那一段。
 */
function tunnelSignature(c) {
  return JSON.stringify([Boolean(c.enabled), c.relayUrl || '', Array.isArray(c.relayUrls) ? c.relayUrls : [], c.instanceId || '', c.upstreamPort || 0, c.upstreamHost || '', c.registerSecret || ''])
}
/** 「这份配置里哪几项决定局域网代理要重建」。 */
function lanSignature(c) {
  // **配对码与票据不在其中**：它们由 `currentPairing` 现读，改它们不该重建监听 ——
  // 配对成功就要换一次（§5.1），跟着重建会把刚握上的连接掐掉。
  return JSON.stringify([Boolean(c.enabled), Boolean(c.lanEnabled), c.lanPort || 0, c.upstreamPort || 0, c.upstreamHost || '', c.instanceId || '', c.previousInstanceId || '', c.lanSecret || '', c.pairingTier || 'full'])
}
/** 「这份配置里哪几项决定网络监视器要不要重排」。 */
function monitorSignature(c) {
  return JSON.stringify([Boolean(c.enabled), c.relayUrl || '', Boolean(c.lanEnabled)])
}
/** 当前应该上报给中转的局域网候选。 */
function currentLanUrls() { return config.lanEnabled && lanState === 'listening' ? lanUrls(lanBoundPort) : [] }
/**
 * 局域网候选变了：只重报注册信息，**不重建隧道**。
 *
 * 重建一次要把手机所有在途请求连同局域网监听一起拆掉，而这条路径（地址变化、实际
 * 端口与首选端口不一致）本来就只是「名片上的地址要更新」。隧道还没连上时不用额外
 * 做事：下一次 startTunnel 会按当前状态现算候选。
 */
function reannounceRegistration() {
  if (!tunnel) return
  tunnel.updateRegistration({ lanUrls: currentLanUrls() })
}
function stopNetworkMonitor() {
  if (networkTimer) { clearInterval(networkTimer); networkTimer = null }
}
function scheduleReconnect() { reconnect.schedule() }
function stopTunnel() {
  // 换代：任何还在探测 / 正在排队的旧 startTunnel 异步链据此作废，别再开新隧道（见 tunnelGeneration）。
  tunnelGeneration += 1
  reconnect.cancel()
  relayRace?.cancel()
  const previous = tunnel
  tunnel = null
  if (previous) previous.stop()
  connectedRelayUrl = null
  tunnelState = 'off'; tunnelError = null
  // 断开即忘掉上一台中转的口径：下次连的可能是另一台，别拿旧的判断去决定推不推正文。
  relayMirror = true
  // 这一轮择路的账一并作废：下次 startTunnel 会从头重新走一遍列表。
  tunnelRoute = null
  publishState()
}
function startNetworkMonitor() {
  stopNetworkMonitor()
  if (!config.enabled) return
  const addresses = () => [...(config.lanEnabled ? lanUrls(lanUrlPort()) : []), ...ipv6Urls(lanUrlPort())]
  let previous = addresses()
  networkTimer = setInterval(() => {
    const current = addresses()
    if (JSON.stringify(current) === JSON.stringify(previous)) return
    previous = current
    const publisher = lanDiscovery
    if (lanState === 'listening' && publisher) void publisher.publish(lanBoundPort)
    reannounceRegistration()
    publishState()
  }, NETWORK_POLL_MS)
}
async function stopLan() {
  lanGeneration += 1
  const previous = lan
  lan = null; lanState = 'off'; lanError = null; lanBoundPort = 0; lanIngressPort = 0
  await lanDiscovery?.stop()
  lanDiscovery = null
  if (previous) await previous.stop()
  publishState()
}
async function stopServices() { stopNetworkMonitor(); stopTunnel(); await stopLan() }

/**
 * 建一条隧道并把它设成当前实例，返回它的注册 Promise（resolve = 已 registered）。
 *
 * **不在这里吞错**：换中转地址那条路要拿到真实的失败原因去撤销迁移登记、并把错误回给调用方
 * （`configure` 的 503 会一路回到手机）。普通重建由 `startTunnel` 那一侧兜底 —— 状态置错 +
 * 排重连，与旧实现一字不差。
 */
function openTunnel(route, race = null) {
  if (!race) { tunnelGeneration += 1; relayRace?.cancel(); tunnelRoute = null }
  // 这一次尝试连的是哪一条。`configure()` 换地址那条路不走择路：它调的 openTunnel() 不带
  // route，连的仍是 config.relayUrl 那一条，且**不许**把队首提上来——那是人手填的地址，
  // 顺序归人管（见文件头第 4 条）。
  const targetUrl = route ? route.url : config.relayUrl
  let registered = false
  const current = new RelayTunnel({
    relayUrl: core.tunnelWsUrl(targetUrl), instanceId: config.instanceId,
    name: config.name, upstream: upstream(),
    registerSecret: config.registerSecret,
    lanUrls: currentLanUrls(),
    readSnapshot: snapshotRead,
    // 实例身份守卫：只有还活着的那个隧道实例才许改状态。onClose / onPairRequest /
    // start().catch 都有这道闸，只有 onRegistered 漏了——而它恰恰是最容易迟到的一个
    // （注册帧是在 ws 上异步回来的）。漏掉的后果是：configure() 或网络监视器重建隧道后，
    // 旧实例迟到的 registered 帧把 tunnelState 写成 'connected'，可此刻 tunnel 指向的
    // 是新实例、它的 ws 还停在 CONNECTING。于是 /status 报「已连接」、宿主据此放行镜像
    // 推送，worker 却按真值回 503，镜像一条也发不出去（现场：host.log 里
    // 「bg queue: sidecar facade request failed: 503」刷屏，而隧道其实在正常转发会话）。
    //
    // **择路时这道闸尤其不能松**：失败的几条各自是一个独立实例，它们后面陆续迟到的
    // registered / close 回调全部要被这道闸挡掉，只有最后成功的那个被认作 `tunnel`。
    onRegistered: () => {
      // 注册成功 = 链路真的通了：连续失败账清零，下次掉线重新从 5s 起算。
      // 回执里的镜像口径（`relayMirror`）跟着状态一起改、一起播，同样只在这道身份闸之内：
      // 旧实例迟到的回执不许改新连接的口径。
      //
      // 只有本代竞速接纳的唯一赢家可成为当前实例，并把真实 targetUrl 与注册状态一起发布。
      if (race && !race.accept(current)) return
      if (tunnel !== current) return; registered = true; reconnect.cancel(); reconnect.reset(); adoptRoute(route); connectedRelayUrl = targetUrl
      relayRegistrations.noteSuccess(targetUrl)
      if (tunnel !== current) return; tunnelState = 'connected'; tunnelError = null; relayMirror = current.relayMirror !== false; publishState()
    },
    onClose: (code, reason) => {
      if (tunnel !== current || !config.enabled || !registered) return
      if (markOutdated(current)) return
      relayRegistrations.noteFailure(targetUrl)
      const detail = current.lastCloseReason || String(reason || '').trim()
      const closed = `连接断开${code ? ` (${code})` : ''}${detail ? `：${detail}` : ''}`
      if (tunnel !== current) return; tunnelState = 'error'; tunnelError = relayFailureMessage(closed); publishState(); scheduleReconnect()
      // 中转在关掉之前说过「插件太旧」的话，这一档要改口径：状态另立成 outdated、复位成
      // 三十分钟一次。markOutdated 自带实例身份闸，改完直接盖掉上面那句「连接断开」。
      markOutdated(current)
    },
    onPairRequest: async (message) => {
      let result
      try {
        result = await parentJson('/api/relay/internal/approval', { device: message.device || {} })
      } catch (error) {
        // 与局域网那条同一个口径：内部没答上 ≠ 电脑拒绝。记下真因，别再静默当成拒绝。
        process.stderr.write(`[dsh-ai-hub sidecar] tunnel pair approval RPC failed: ${error && error.message ? error.message : error}\n`)
        if (tunnel === current) current.sendPairConfirm(message.requestId, false)
        return
      }
      if (tunnel !== current) return
      if (result.approved) current.sendPairConfirm(message.requestId, true, core.signLanToken(config.lanSecret, config.instanceId, core.MOBILE_BEARER_TTL_SEC), result.platform)
      else current.sendPairConfirm(message.requestId, false)
    },
    onLog: (...args) => process.stderr.write(`[dsh-ai-hub sidecar] ${args.join(' ')}\n`),
  })
  if (race) race.track(current, route)
  else tunnel = current
  const ready = current.start()
  // 挂了就如实报，并按 5s 起退避重连（旧实现在 startTunnel 的 catch 里做同一件事）。
  // 换地址失败时这里也会排一次：配置里已经是新地址，值得继续试它，而不是悄悄退回旧地址。
  ready.catch(error => {
    // 择路的**中间**那几条失败不吭声：状态只在「全部都不通」时才报 error。逐个报会让
    // /status 在 error / connecting 之间来回跳，宿主那边「隧道刚连上就补推一次全量」的
    // 边沿账会被这条假跳变带乱。它不改状态，所以排在实例身份闸前面无妨。
    if (race) return
    if (tunnel !== current) return
    if (markOutdated(current)) return
    relayRegistrations.noteFailure(targetUrl)
    if (tunnel !== current) return; tunnelState = 'error'; tunnelError = relayFailureMessage(error); publishState(); scheduleReconnect()
  })
  return ready
}
function startTunnel() {
  if (!config.enabled || !config.upstreamPort) return
  // 一条地址都没有 = 这台机器还没配中转，那不是故障：停成 `off`、不排重连（与旧实现
  // 「relayUrl 为空直接早退」一字不差）。把它报成 error 会让面板与手机对着一台本来就没
  // 打算连中转的机器闪红，还每 5 秒退避重连一次。
  if (!relayRoutePlan().length) { stopTunnel(); return }
  stopTunnel(); tunnelState = 'connecting'
  publishState()
  // 健康探测只作旁路证据，不再先扫完整个池才开始注册；旧代探测不能覆盖新代缓存。
  const generation = tunnelGeneration
  void refreshRelayLatency(generation).catch(() => {})
  void raceTunnels(generation)
}
/**
 * 一次配置里可以按优先级试的中转地址。
 *
 * 候选同时考虑最近健康延迟与独立注册失败证据；健康证据过期后保留失败账与配置原序。
 * 探测与注册并行，健康成功不能冲掉隧道注册失败，失败候选仍保留以供后续重试。
 *
 * `relayUrls` 缺席或为空（老宿主只下发 `relayUrl`）时退回单元素 —— 契约里那条兼容口径。
 * 已按 `core.normalizeRelayUrl` 规范化并用它拼 `tunnelWsUrl`，脏地址在这里就被丢掉而不是
 * 拖到连接阶段才逐个超时。
 */
function relayRoutePlan() {
  const declared = Array.isArray(config.relayUrls) && config.relayUrls.length
    ? config.relayUrls
    : [config.relayUrl]
  const seen = new Set()
  const urls = []
  for (const entry of declared) {
    const url = core.normalizeRelayUrl(entry)
    if (!url || seen.has(url)) continue
    // `tunnelWsUrl` 会拒掉不带 http(s) 的地址：那是这一条根本试不了的证据，直接跳过，
    // 别让它变成一次注定失败的 8 秒注册超时。
    try { core.tunnelWsUrl(url) } catch { continue }
    seen.add(url)
    urls.push(url)
  }
  // 延迟结果还在保鲜期就按最快优先给出候选顺序；过期就按原序，等下次 startTunnel 重探。
  // 只影响尝试顺序，不改地址本身，也不改去重 / 过滤的结果。
  return relayRegistrations.order(urls, performance.now() - relayLatencyAt < 300000 ? relayLatencyCache : new Map())
}
/**
 * 并发探当前候选中转的身份健康响应，把实测延迟写进缓存；不改变注册失败账。
 *
 * 每条独立超时（1500ms）；某条探测失败只是这条记成 null（不可达、排后面），不影响其它条，
 * 也不阻止这次连接（排序函数会把它们稳定地排在后面，失败仍由 raceTunnels 顺延到下一台）。
 */
async function refreshRelayLatency(generation) {
  const urls = relayRoutePlan()
  // 并发**分段**探，不一次性全打出去：地址池将来可能按地区变多，全并发会在同一瞬间打出一堆
  // 连接（对自己的中转也等于一次小 DDoS），把 worker 的连接/内存压垮。每段最多 6 条同时探，
  // 段内并发、段间顺序；每条的 1.5s 超时照旧只约束单条。
  const results = new Map()
  for (let index = 0; index < urls.length; index += PROBE_CONCURRENCY) {
    if (generation !== tunnelGeneration || !config.enabled) return
    const batch = urls.slice(index, index + PROBE_CONCURRENCY)
    const probed = await Promise.all(batch.map(async (url) => [url, await probeRelayHealth(url, { timeoutMs: 1500 })]))
    for (const [url, ms] of probed) results.set(url, ms)
  }
  if (generation !== tunnelGeneration || !config.enabled) return
  relayLatencyCache = results
  relayLatencyAt = performance.now()
}
/**
 * 这一轮选中的中转写成当前主用，并把它**提到队首**，其余条目相对顺序不动。
 *
 * 为什么非提不可：`relayUrls[0]` 恒等于 `relayUrl`（core 的 normalize 每次落盘都会这么收敛）。
 * 只把中选的地址写成 `relayUrl` 而列表原样不动，下一次读盘就被旧首项顶回去，写回等于没写。
 * 启用延迟排序之后，中选那条**未必**是配置里的首项（`index 0` 只表示它是排序队列里最快的），
 * 所以「要不要写回」改成看「写回后的顺序与当前 config 是否一致」，不是看「有没有从 0 挪到队首」。
 *
 * 两次账要一起结，漏一次就是「刚连上的隧道被自己拆掉」：
 *  - 本进程的 `config` 就地换成新顺序 —— 宿主随后会下发同一份（它从这份状态里读），
 *    两边一致时 `tunnelSignature` 不变，`configure()` 就不会重建隧道；
 *  - 写回是宿主主进程的事（`relay.json` 只有它能写），这里只报「该写回去了」。
 */
function adoptRoute(route) {
  // 人手换地址那条路（`configure` → `switchRelay` → `openTunnel()`）不带 route：
  // 顺序归人管，这里什么都不记。
  if (!route) return
  const remaining = route.urls.filter(url => url !== route.url)
  const next = [route.url, ...remaining]
  // 中选那条必须成为当前主用：它是此刻真的连上的那台。延迟排序后 `index 0` 不等于
  // `config.relayUrl`，若沿旧判据（index !== 0）就会漏写回，让 `/status` 与总控继续报那条
  // 可能已经死掉的旧主用 —— 手机连不上时查到的地址就是错的。
  const current = Array.isArray(config.relayUrls) ? config.relayUrls : []
  const sameOrder = next.length === current.length && next.every((url, index) => url === current[index])
  const adopted = !sameOrder
  config.relayUrl = next[0]
  if (adopted) config.relayUrls = next
  tunnelRoute = {
    url: route.url,
    index: route.index,
    tried: route.tried,
    total: route.urls.length,
    // 报出去的是**写回之后**的顺序：宿主拿它落盘，与本进程那份一字不差。
    urls: next,
    // 顺序与当前 config 不同才需要宿主写回；一致时落盘是多余的一次磁盘写。
    adopted,
  }
}
/** 无已连线路时最多三条并行注册；唯一赢家接管，输家与旧代立即停止。 */
async function raceTunnels(generation = tunnelGeneration) {
  if (!config.enabled) return false
  if (generation !== tunnelGeneration) return false
  const urls = relayRoutePlan()
  if (!urls.length) { stopTunnel(); return false }
  return new Promise((resolve) => {
    const active = new Map()
    const waiting = urls.map((url, index) => ({ url, index }))
    const authorityOf = (url) => { try { return new URL(url).host.toLowerCase() } catch { return url } }
    let next = 0
    let finished = false
    let lastError = new Error('中转注册失败')
    const latestStart = performance.now() + RELAY_RACE_TIMEOUT_MS - 8000
    const valid = () => generation === tunnelGeneration && config.enabled
    const stopOthers = (winner) => {
      for (const current of active.values()) if (current !== winner) { try { current.stop() } catch {} }
      active.clear()
    }
    const finish = (success, winner) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (relayRace === race) relayRace = null
      stopOthers(winner)
      resolve(success)
    }
    const failRound = () => {
      if (!valid()) { finish(false); return }
      finish(false)
      tunnelState = 'error'; tunnelError = relayFailureMessage(lastError)
      publishState(); scheduleReconnect()
    }
    const race = {
      track(current, route) { active.set(route, current) },
      accept(current) {
        if (finished || !valid() || ![...active.values()].includes(current)) { current.stop(); return false }
        tunnel = current
        finish(true, current)
        return true
      },
      cancel() { finish(false) },
    }
    relayRace = race
    const timer = setTimeout(() => {
      if (!valid()) { finish(false); return }
      // 只有仍在真实等待的注册才记超时；未启动候选与主动取消的输家不记失败。
      for (const [route] of active) relayRegistrations.noteFailure(route.url)
      lastError = new Error('中转择路超时')
      failRound()
    }, RELAY_RACE_TIMEOUT_MS)
    const launch = () => {
      if (finished) return
      if (!valid()) { finish(false); return }
      // 不在整轮将结束时新开一条只剩碎片预算的注册；未试到的候选留在下轮，失败账会轮换优先级。
      while (!finished && active.size < RELAY_RACE_CONCURRENCY && waiting.length && performance.now() <= latestStart) {
        const busy = new Set([...active.keys()].map(route => authorityOf(route.url)))
        const at = waiting.findIndex(candidate => !busy.has(authorityOf(candidate.url)))
        if (at < 0) break // 同一中转的多个入口串行，避免同实例注册互相顶替。
        const { url, index } = waiting.splice(at, 1)[0]
        const route = { url, index, tried: ++next, urls }
        let attempt
        try { attempt = openTunnel(route, race) } catch (error) {
          lastError = error
          relayRegistrations.noteFailure(route.url)
          const current = active.get(route)
          active.delete(route)
          try { current?.stop() } catch {}
          continue
        }
        const current = active.get(route)
        Promise.resolve(attempt).catch((error) => {
          if (finished) return
          if (!valid()) { finish(false); return }
          active.delete(route)
          lastError = error
          if (current?.lastControlError?.code === 'plugin_too_old') {
            // 版本门槛保持原有停轮与专用重试节奏，不把它当网络失败。
            finish(false)
            tunnel = current
            markOutdated(current)
            current.stop()
            return
          }
          relayRegistrations.noteFailure(route.url)
          try { current?.stop() } catch {}
          launch()
        })
      }
      if (!finished && !active.size) failRound()
    }
    launch()
  })
}
async function startLan() {
  await stopLan()
  if (!config.enabled || !config.upstreamPort) return
  const own = lanGeneration
  lanRequestedPort = config.lanPort
  lanState = 'connecting'
  const discovery = config.lanEnabled
    ? createLanDiscovery({ instanceId: config.instanceId, onChange: publishState })
    : { publish: async () => false, stop: async () => {}, snapshot: () => ({ state: 'off', error: null }) }
  lanDiscovery = discovery
  publishState()
  try {
    const result = await bindLanEndpoint({
      requestedPort: config.lanPort, lockReason: config.lanPortLockReason || '', discovery, store: credentials, instanceId: config.instanceId,
      isCurrent: () => own === lanGeneration,
      createProxy: port => createLanProxy({
        ipv4Enabled: Boolean(config.lanEnabled),
        lanPort: port,
        // 专属回环入口：首选值是宿主从 relay.json 带来的落盘值，0 表示让内核分配。
        ingressPort: config.tunnelIngressPort || 0,
        instanceId: config.instanceId, previousInstanceId: config.previousInstanceId || '', lanSecret: config.lanSecret,
        // 配对码与票据走取值器：配对成功之后宿主会换掉它们（§5.1），而重建局域网代理会把
        // 刚握上的连接全掐掉 —— 换值不该动监听。
        currentPairing: () => ({ code: config.pairingCode, ticket: config.pairingTicket || '' }),
        // 校验用的配对码 / 票据 / 实例号每次配对现向主进程要：二维码是主进程画的，旁车缓存那份
        // 只要和主进程错开，扫了正常的码也会被判「对不上」。取不到就退回上面的缓存（老宿主兼容）。
        authoritativePairing: async () => {
          try {
            const next = await parentJson('/api/relay/internal/pairing', {})
            return next && typeof next === 'object' ? next : null
          } catch { return null }
        },
        // 新配对权限档位（电脑侧选定）：局域网这条配对入口按它展开权限位。
        pairingTier: config.pairingTier || 'full',
        upstreamPort: config.upstreamPort,
        upstreamHost: config.upstreamHost || '127.0.0.1',
        // 手填直连地址：交给局域网代理按 Host 区分「外网穿透」与「局域网」，别再标成局域网。
        manualLanUrl: config.manualLanUrl || '',
        readSnapshot: snapshotRead,
        onLog: (...args) => process.stderr.write(`[dsh-ai-hub sidecar] ${args.join(' ')}\n`),
        // 配对成功之后换码 + 换票据：走宿主的控制面（那是唯一能写状态文件的地方）。
        onPaired: () => {
          void parentJson('/api/relay/internal/rotate-pairing', {}).catch(() => undefined)
        },
        // 签发交给主进程（唯一写方）：旁路自己写盘会和主进程那份互相覆盖。
        issueCredential: async (device, extra) => {
          const result = await parentJson('/api/relay/internal/issue-credential', { device: device || {}, extra: extra || {} })
          return result.data || result
        },
        onApprove: async (device) => {
          let result
          try {
            result = await parentJson('/api/relay/internal/approval', { device: device || {} })
          } catch (error) {
            // 「问主进程放不放行」这一发自己挂了（启动 / 重配那几秒、内部超时、父进程忙），
            // **不能**当成「电脑拒绝了这台手机」：那会把一次几秒钟的抖动说成用户解决不了的
            // 问题，手机上看到的还和真拒绝一字不差（「码不对 / 电脑拒绝新设备」）。抛出去，
            // 由接入层回一个「暂时没准备好」的失败让手机重试；真因写进日志，下次可观。
            process.stderr.write(`[dsh-ai-hub sidecar] lan pair approval RPC failed: ${error && error.message ? error.message : error}\n`)
            const wrapped = new Error('approval-unavailable')
            wrapped.code = 'approval-unavailable'
            throw wrapped
          }
          return {
            approved: Boolean(result.approved),
            token: result.approved ? core.signLanToken(config.lanSecret, config.instanceId, core.MOBILE_BEARER_TTL_SEC) : null,
            platform: typeof result.platform === 'string' ? result.platform : null,
          }
        },
      }),
    })
    if (own !== lanGeneration) { await result.proxy.stop(); await discovery.stop(); return }
    lan = result.proxy
    lanBoundPort = result.port
    lanIngressPort = typeof result.proxy.ingressPort === 'function' ? result.proxy.ingressPort() || 0 : 0
    // 端口被占后内核另分的那个值要落盘，下一次启动就稳定在它上面；发布状态让宿主写回。
    if (lanIngressPort && config.tunnelIngressPort !== lanIngressPort) config.tunnelIngressPort = lanIngressPort
    config.lanPort = result.port
    lanState = 'listening'
    publishState()
    reannounceRegistration()
  } catch (error) {
    if (own !== lanGeneration) return
    await discovery.stop()
    lanState = 'error'
    lanError = error instanceof Error ? error.message : String(error)
    publishState()
  }
}
async function configure(next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('invalid configuration')
  // `relayUrls` 在白名单里，而且从这一轮起**进签名**（见 tunnelSignature）：地址组或它的
  // 顺序变了就要重新择路。白名单缺了它，宿主下发这一格会直接抛 unknown configuration
  // field，整次配置下发失败。
  const allowed = ['enabled', 'relayUrl', 'relayUrls', 'instanceId', 'previousInstanceId', 'pairingCode', 'pairingTicket', 'pairingTier', 'name', 'upstreamPort', 'upstreamHost', 'lanPort', 'lanPortLockReason', 'lanEnabled', 'lanSecret', 'registerSecret', 'tunnelIngressPort']
  if (Object.keys(next).some(key => !allowed.includes(key))) throw new Error('unknown configuration field')
  if (typeof next.instanceId !== 'string' || next.instanceId.length > 128) throw new Error('invalid instanceId')
  if (next.previousInstanceId !== undefined && (typeof next.previousInstanceId !== 'string' || next.previousInstanceId.length > 128)) throw new Error('invalid previousInstanceId')
  if (typeof next.pairingCode !== 'string' || !/^\d{6}$/.test(next.pairingCode)) throw new Error('invalid pairingCode')
  if (next.pairingTicket !== undefined && (typeof next.pairingTicket !== 'string' || !/^[A-Za-z0-9_-]{0,64}$/.test(next.pairingTicket))) throw new Error('invalid pairingTicket')
  if (next.pairingTier !== undefined && !['readonly', 'approve', 'full'].includes(next.pairingTier)) throw new Error('invalid pairingTier')
  if (typeof next.upstreamPort !== 'number' || !Number.isInteger(next.upstreamPort) || next.upstreamPort < 1 || next.upstreamPort > 65535) throw new Error('invalid upstreamPort')
  if (next.upstreamHost !== undefined && (typeof next.upstreamHost !== 'string' || !next.upstreamHost || next.upstreamHost.length > 64)) throw new Error('invalid upstreamHost')
  if (next.lanPort !== undefined && (!Number.isInteger(next.lanPort) || next.lanPort < 1024 || next.lanPort > 65535)) throw new Error('invalid lanPort')
  // 专属入口端口是运行时字段（默认 0 = 内核分配）；坏值宁可退回分配，也不拿它去听一个死端口。
  if (next.tunnelIngressPort !== undefined && (!Number.isInteger(next.tunnelIngressPort) || next.tunnelIngressPort < 0 || next.tunnelIngressPort > 65535)) throw new Error('invalid tunnelIngressPort')
  if (next.registerSecret !== undefined && (typeof next.registerSecret !== 'string' || next.registerSecret.length > 512)) throw new Error('invalid registerSecret')
  // 只重建真正变了的那一半：
  //   - 决定隧道「连到哪台、以谁的身份连」的字段变了才重建隧道；
  //   - 决定局域网监听的字段变了才重建局域网代理；
  //   - 其余（配对码 / 名字 / 局域网候选）在现有连接上重报一次注册信息即可。
  // 无条件全拆全建就是「每隔几分钟断一次 + 内存一直涨」的根因，别改回去。
  const previous = config
  // 中转地址变了要**先登记迁移再重建**：还握着旧地址的设备只会在旧中转上找这台电脑。
  // 按规范形态比，避免只差一个尾斜杠就白跑一次迁移（那只是同一台中转）。
  // 「第一次配地址」不算换地址：旧中转上没有谁握着这台电脑的旧地址，没什么要登记的，
  // 更不该为了等注册把启动那次下发拖住。
  const previousRelayUrl = core.normalizeRelayUrl(previous.relayUrl)
  const relayUrlChanged = Boolean(previousRelayUrl) && previousRelayUrl !== core.normalizeRelayUrl(next.relayUrl)
  const tunnelNeedsRebuild = tunnelSignature(previous) !== tunnelSignature(next)
  const lanNeedsRebuild = lanSignature(previous) !== lanSignature(next)
  const monitorNeedsRestart = monitorSignature(previous) !== monitorSignature(next)
  config = { ...next }
  if (config.tunnelIngressPort === undefined) config.tunnelIngressPort = previous.tunnelIngressPort || 0
  if (tunnelNeedsRebuild) {
    if (relayUrlChanged && config.enabled && config.relayUrl && config.upstreamPort) {
      // 换地址这条路**等新隧道真的注册上**再返回：注册不上要把错误一路回给调用方，
      // 并在旧隧道上撤销迁移登记（顺序与理由见 lib/relay/migrate.js 文件头）。
      await switchRelay({
        oldTunnel: tunnel,
        relayUrl: config.relayUrl,
        open: () => {
          // 旧隧道还在，但重连定时器得先撤掉：否则它到点会把刚起来的新隧道又拆一遍。
          reconnect.cancel()
          tunnelRoute = null
          tunnelState = 'connecting'; tunnelError = null; publishState()
          return openTunnel()
        },
        drop: (old) => { if (old) { try { old.stop() } catch { /* 已经断开 */ } } },
      })
    } else {
      stopTunnel()
      startTunnel()
    }
  }
  if (lanNeedsRebuild || (config.enabled && lanState === 'error')) {
    await startLan()
  }
  if (!tunnelNeedsRebuild && tunnel) {
    const patch = {}
    // **配对码不再进注册帧**（§5.2）：中转从来没读过它（`ws.rs` 原文「不保存也不校验」），
    // 而带上它就等于把「谁能配这台机器」的一半凭证交给链路上的第三方。
    if (previous.name !== config.name) patch.name = config.name
    if (lanNeedsRebuild) patch.lanUrls = currentLanUrls()
    if (Object.keys(patch).length) tunnel.updateRegistration(patch)
  }
  if (monitorNeedsRestart) {
    stopNetworkMonitor()
    startNetworkMonitor()
  }
  return status()
}
function status() {
  // 自检台账（`/api/relay/status` 的 `selfCheck`）要的三样东西只有 worker 这边量得到：
  //   - `process.memoryUsage`：侧车是**另一个进程**，这是插件唯一能直接量到的自有内存；
  //   - `streams.lan`：局域网代理里此刻活着的上游流（手机半开连接攒起来时，只有它只涨不落）；
  //   - `streams.relaySseOpen`：中转路上活着的上游 SSE 条数。
  // 量不到的一律报 null、不拿 0 顶替：0 是「一条都没有」，与「不知道」是两件事。
  const lanStreams = lan && typeof lan.stats === 'function' ? lan.stats() : null
  const relaySseOpen = tunnel ? (typeof tunnel.upstreamSseCount === 'number' ? tunnel.upstreamSseCount : null) : 0
  // `tunnel.route` 只在「这一轮真的试过」时才给：老宿主/老面板读到多出来的一格无害，
  // 而宿主侧靠它判「当前连的不是队首 → 该写回了」。没试过（隧道没起来）时留空，
  // 别让一份上上轮的账一直挂在那儿。
  const route = tunnelRoute ? tunnelRoute : undefined
  return { ok: true, sidecar: true, enabled: Boolean(config.enabled), relayUrl: config.relayUrl || '', relayUrls: Array.isArray(config.relayUrls) ? config.relayUrls : [], instanceId: config.instanceId, name: config.name, localPort: config.upstreamPort, tunnel: { state: tunnelState, error: tunnelError, mirror: relayMirror, relayUrl: tunnelState === 'connected' ? connectedRelayUrl : null, ...(route ? { route } : {}) }, lan: { enabled: Boolean(config.lanEnabled), port: lanUrlPort(), requestedPort: lanRequestedPort || config.lanPort, ingressPort: lanIngressPort, state: lanState, error: lanError, discovery: lanDiscovery?.snapshot() || { state: 'off', error: null } }, process: { memoryUsage: process.memoryUsage() }, streams: { lan: lanStreams, relaySseOpen } }
}
const server = http.createServer(async (req, res) => {
  try {
    if (!authorized(req)) return send(res, 401, { ok: false, error: 'unauthorized' })
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, service: 'dsh-ai-hub-relay-sidecar', capabilities: ['relay-tunnel', 'lan-proxy', 'pairing-approval-rpc'] })
    if (req.method === 'GET' && req.url === '/status') return send(res, 200, status())
    if (req.method === 'POST' && req.url === '/configure') {
      const next = await readBody(req, CONFIGURE_MAX_BODY)
      const run = configuring.then(() => configure(next))
      // 串行链本身**不许被一次失败卡死**：`configuring` 一旦是 rejected，后续每一个
      // `.then(() => configure(...))` 都会跳过 configure 直接跟着失败 —— 一次地址填错
      // 就能让这台宿主从此不再接受任何配置下发（隧道永远起不来，只能重启 worker）。
      configuring = run.catch(() => undefined)
      return send(res, 200, await run)
    }
    if (req.method === 'POST' && req.url === '/reconnect') {
      const run = configuring.then(() => { startTunnel(); return status() })
      configuring = run.catch(() => undefined)
      return send(res, 200, await run)
    }
    if (req.method === 'POST' && req.url === '/tunnel/send') {
      const body = await readBody(req, TUNNEL_SEND_MAX_BODY);
      // 桌面→relay 主动推送（移动端镜像缓存）：复用隧道立即 sendJson；同时在本地保留快照供读取隔离。
      if (body && typeof body === 'object' && body.kind === 'sync') localSnapshot = body;
      if (tunnel && tunnel.connected) {
        // 历史 blob（HK 加密）：单独一条 `blobPut` 帧，中转只存密文、不解析内容。
        if (body && typeof body === 'object' && body.kind === 'blob') {
          const current = tunnel;
          const result = await current.pushBlob({
            scope: body.scope,
            key: body.key,
            creds: Array.isArray(body.creds) ? body.creds : [],
            cipher: body.cipher,
          });
          if (tunnel !== current || !current.connected) throw new Error('blob tunnel changed');
          return send(res, 200, result);
        }
        if (body && typeof body === 'object' && body.kind === 'blob-delete') {
          if (!tunnel.sendJson(T.blobDelete, 0, { scope: body.scope, key: body.key, keys: body.keys })) {
            throw new Error('blob delete backpressure or closed');
          }
          return send(res, 202, { ok: true });
        }
        tunnel.sendJson(T.sync, 0, frameForTunnel(body, relayMirror === false));
        return send(res, 202, { ok: true });
      }
      return send(res, 503, { ok: false, error: 'tunnel not connected' });
    }
    if (req.method === 'POST' && req.url === '/revoke-all') {
      // 清除所有授权：请求中转清空本实例全部设备授权（先于本机密钥轮换调用）。
      if (!(tunnel && tunnel.connected)) return send(res, 503, { ok: false, error: 'tunnel not connected' });
      try {
        const result = await tunnel.requestRevokeAll()
        return send(res, 200, { ok: true, revoked: result?.revoked || 0 })
      } catch (error) { return send(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) }) }
    }
    return send(res, 404, { ok: false, error: 'not found' })
  } catch (error) {
    // 体积超限归 4xx：它是请求本身装不下，不是这个服务不可用。兜成 503 的代价是
    // 宿主侧把「body 太大」和「隧道没连上」记成同一条错，两者都长得一模一样。
    if (error instanceof BodyTooLarge) return send(res, 413, { ok: false, error: error.message })
    return send(res, 503, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})
server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
server.listen(0, '127.0.0.1', () => { const address = server.address(); process.send?.({ type: 'ready', port: address.port }) })
let shuttingDown = false
const shutdown = () => {
  if (shuttingDown) return
  shuttingDown = true
  reconnect.cancel()
  server.close()
  for (const socket of sockets) socket.destroy()
  void stopServices()
  setTimeout(() => process.exit(0), 1000).unref()
}
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown)
process.on('message', message => { if (message?.type === 'shutdown') shutdown() })

/**
 * 父进程（宿主）没了就自己退出：否则这里会变成一具握着隧道的尸体。
 *
 * 宿主被 Cmd+Q、被系统清掉或被 SIGKILL 时，没有人会给这里发 SIGTERM，IPC 也只是静默 EOF。
 * worker 继续活着、继续握着那条注册成功过的隧道，中转的 instances 里那条记录就永不删除，
 * 手机侧栏的设备「在线」再也灭不掉。
 *
 * 两道判据互相兜底：`disconnect` 在宿主正常退出时立刻触发（最快）；ppid 巡检兜住 SIGKILL
 * （实测只看到 ppid 变成 1，不发 disconnect），启动时记下 ppid，之后对不上就退出。
 *
 * 整进程退出而不是只 `stopServices()`：隧道一关，中转要等心跳超时才删实例，这期间手机仍
 * 显示在线；孤儿进程没有存在的理由，退出是最快的收敛路径。
 */
const PARENT_WATCH_INTERVAL_MS = 2000
const parentPidAtStart = process.ppid
let parentWatchTimer = null
function watchParent() {
  if (parentWatchTimer) return
  parentWatchTimer = setInterval(() => {
    if (process.ppid === parentPidAtStart) return
    process.stderr.write('[dsh-mobile-plugin] parent process gone, sidecar shutting down\n')
    shutdown()
  }, PARENT_WATCH_INTERVAL_MS)
  // 看护本身不该把进程按在这里：宿主正常退出时靠 disconnect 收尾。
  if (typeof parentWatchTimer.unref === 'function') parentWatchTimer.unref()
}
process.once('disconnect', () => { process.stderr.write('[dsh-mobile-plugin] parent IPC closed, sidecar shutting down\n'); shutdown() })
watchParent()
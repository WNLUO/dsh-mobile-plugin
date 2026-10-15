'use strict'

/**
 * sidecar worker：真正持有「中转隧道 + 局域网代理」的那个子进程。
 *
 * 宿主不自己开 WebSocket、也不自己监听局域网端口，而是 fork 出这个 worker，用环回
 * HTTP + Bearer 令牌对话（见 lib/sidecar-facade.cjs）。这样隧道崩了、原生模块加载
 * 失败都只死一个子进程，宿主仍能如实把状态报给 /api/relay/status。
 *
 * 三条不能忘的语义：
 *  1. 状态既要在 `/status` 上按需可查，也要在**变化的那一刻**主动 `process.send` 给宿主
 *     （publishState）：宿主的健康轮询是 10s 一次，只靠轮询的话隧道真断后它最多 10s
 *     仍以为连着、继续往一条死隧道推镜像；而「断又连」整段落在两次轮询之间时，宿主
 *     连一次「刚连上」都观测不到，那次全量补推就永远不来。
 *  2. `/tunnel/send` 先把镜像快照留在本地（localSnapshot）再尝试真发：局域网直连的手机
 *     走 snapshotRead 读这份快照，隧道断了也不至于读到一份过期镜像。
 *  3. 请求体一律先量后读（readBody + 显式上限）：`/configure` 与镜像帧都有字节上限，
 *     超限立刻 413，别让一个畸形请求把内存吃光。
 */

const http = require('node:http')
const { RelayTunnel } = require('./relay/tunnel.js')
const { T } = require('./relay/protocol.js')
const { createLanProxy } = require('./relay/lan-proxy.js')
const { lanUrls } = require('./relay/lan-network.cjs')
const core = require('./relay/core.js')
const { createReconnectScheduler } = require('./reconnect-scheduler.cjs')
const { isMirrorSnapshotFresh } = require('./mirror-snapshot.cjs')

const parentPort = Number(process.env.DSH_SIDECAR_PARENT_PORT)
const token = process.env.DSH_SIDECAR_TOKEN
const authorization = `Bearer ${token}`
let config = {}
const sockets = new Set()
let tunnel = null
let lan = null
let tunnelState = 'off'
let tunnelError = null
let lanState = 'off'
let lanError = null
// 局域网代理**实际**在监听的端口。0 = 还没起来。首选端口被占时会退到内核分配的
// 空闲端口（见 lib/relay/port-allocator.cjs 与 lan-proxy 的 bind 兜底），所以凡是要
// 对外报地址的地方都必须用 lanUrlPort()，不能用 config.lanPort。
let lanBoundPort = 0
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
    tunnel: { state: tunnelState, error: tunnelError },
    lan: { enabled: Boolean(config.lanEnabled), port: lanUrlPort(), requestedPort: config.lanPort, state: lanState, error: lanError },
  })
}
let networkTimer = null
let configuring = Promise.resolve()
let localSnapshot = null // 桌面 pushSync 推来的移动端镜像快照（本机保留供读取隔离）
const NETWORK_POLL_MS = 5000
// 隧道重连间隔。onClose 与 start().catch 两条失败路径共用这个幂等调度器，
// 否则每次失败会排两个定时器（重连风暴）；幂等性由
// test/reconnect-scheduler.test.cjs 精确验证。
const RECONNECT_DELAY_MS = 5000
const reconnect = createReconnectScheduler({ delayMs: RECONNECT_DELAY_MS, onFire: () => startTunnel() })

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
 * 这个接口收的是桌面推给移动端的镜像：整份会话列表 + 工作区 + 当前会话的完整消息、
 * 统计与模型。实测桌面一次推送就超过 1MB，而中转清洗后真正留下的只有 ~114KB——
 * 旧的 1MB 上限是在把有用的东西挡在门外。
 *
 * 上限的依据是**中转那侧的帧上限**，不是「估个够大的数」：
 * dsh-mobile-server/lib/config.js 的 MAX_FRAME_BYTES 默认 8MB，一帧超过它，
 * 中转会以 1009 'frame too large' 直接关掉隧道（lib/protocol.js → onError）。
 * 丢一次镜像可以恢复，隧道被关掉要等重连、期间手机端全瞎——所以宁可拒也不能赌。
 * 留 64KB 余量给帧头。推得再大也只是这一次 413，隧道安然无恙。
 */
const TUNNEL_SEND_MAX_BODY = 8 * 1024 * 1024 - 64 * 1024
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
function upstream() { return `http://127.0.0.1:${config.upstreamPort}` }
// 读取隔离：把移动端高频读请求（sessions/workspaces/messages/stats）从本地快照直接回，
// 不再打扰主进程。快照缺失或路径不在清单内时返回 null → 调用方回源主进程。
function snapshotRead(info) {
  // 镜像只在中转连着时才会有新版本推来（原因见 mirror-snapshot.cjs 的说明）：冻结的快照必须
  // 回源主进程，否则中转一断、局域网仍健康时，新建的会话/工作区在 App 里永远不出现。
  if (!isMirrorSnapshotFresh(localSnapshot)) return null
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
function stopNetworkMonitor() {
  if (networkTimer) { clearInterval(networkTimer); networkTimer = null }
}
function scheduleReconnect() { reconnect.schedule() }
function stopTunnel() {
  reconnect.cancel()
  if (tunnel) tunnel.stop()
  tunnel = null; tunnelState = 'off'; tunnelError = null
  publishState()
}
function startNetworkMonitor() {
  stopNetworkMonitor()
  if (!config.enabled || !config.relayUrl || !config.lanEnabled) return
  let previous = lanUrls(lanUrlPort())
  networkTimer = setInterval(() => {
    const current = lanUrls(lanUrlPort())
    if (JSON.stringify(current) === JSON.stringify(previous)) return
    previous = current
    // lanUrls is sent during register; reconnect only after a real change.
    startTunnel()
  }, NETWORK_POLL_MS)
}
function stopLan() {
  if (lan) lan.stop()
  lan = null; lanState = 'off'; lanError = null; lanBoundPort = 0
  publishState()
}
async function stopServices() { stopNetworkMonitor(); stopTunnel(); stopLan() }
function startTunnel() {
  if (!config.enabled || !config.relayUrl || !config.upstreamPort) return
  stopTunnel(); tunnelState = 'connecting'
  publishState()
  const current = new RelayTunnel({
    relayUrl: core.tunnelWsUrl(config.relayUrl), instanceId: config.instanceId, pairingCode: config.pairingCode,
    name: config.name, upstream: upstream(),
    registerSecret: config.registerSecret,
    lanUrls: config.lanEnabled ? lanUrls(lanUrlPort()) : [],
    readSnapshot: snapshotRead,
    // 实例身份守卫：只有还活着的那个隧道实例才许改状态。onClose / onPairRequest /
    // start().catch 都有这道闸，只有 onRegistered 漏了——而它恰恰是最容易迟到的一个
    // （注册帧是在 ws 上异步回来的）。漏掉的后果是：configure() 或网络监视器重建隧道后，
    // 旧实例迟到的 registered 帧把 tunnelState 写成 'connected'，可此刻 tunnel 指向的
    // 是新实例、它的 ws 还停在 CONNECTING。于是 /status 报「已连接」、宿主据此放行镜像
    // 推送，worker 却按真值回 503，镜像一条也发不出去（现场：host.log 里
    // 「bg queue: sidecar facade request failed: 503」刷屏，而隧道其实在正常转发会话）。
    onRegistered: () => { if (tunnel !== current) return; tunnelState = 'connected'; tunnelError = null; publishState() },
    onClose: () => { if (tunnel === current && config.enabled) { tunnelState = 'error'; tunnelError = '连接断开'; publishState(); scheduleReconnect() } },
    onPairRequest: async (message) => {
      try {
        const result = await parentJson('/api/relay/internal/approval', { device: message.device || {} })
        if (tunnel !== current) return
        if (result.approved) current.sendPairConfirm(message.requestId, true, core.signLanToken(config.lanSecret, config.instanceId, core.MOBILE_BEARER_TTL_SEC), result.platform)
        else current.sendPairConfirm(message.requestId, false)
      } catch { if (tunnel === current) current.sendPairConfirm(message.requestId, false) }
    },
    onLog: (...args) => process.stderr.write(`[dsh-ai-hub sidecar] ${args.join(' ')}\n`),
  })
  tunnel = current
  current.start().catch(error => { if (tunnel === current) { tunnelState = 'error'; tunnelError = error instanceof Error ? error.message : String(error); publishState(); scheduleReconnect() } })
}
function startLan() {
  // 总开关关闭时不能只停隧道：旧实现漏了 `config.enabled`，于是 /api/relay/toggle
  // 关掉远程连接后，局域网代理仍监听 0.0.0.0:lanPort 继续接受配对。
  if (!config.enabled || !config.lanEnabled || !config.upstreamPort) return
  stopLan(); lanState = 'connecting'
  publishState()
  const current = createLanProxy({
    lanPort: config.lanPort, pairingCode: config.pairingCode, instanceId: config.instanceId, lanSecret: config.lanSecret,
    upstreamPort: config.upstreamPort,
    readSnapshot: snapshotRead,
    onLog: (...args) => process.stderr.write(`[dsh-ai-hub sidecar] ${args.join(' ')}\n`),
    onApprove: async (device) => {
      try {
        const result = await parentJson('/api/relay/internal/approval', { device: device || {} })
        return {
          approved: Boolean(result.approved),
          token: result.approved ? core.signLanToken(config.lanSecret, config.instanceId, core.MOBILE_BEARER_TTL_SEC) : null,
          platform: typeof result.platform === 'string' ? result.platform : null,
        }
      } catch { return { approved: false, token: null } }
    },
  })
  lan = current
  current.start().then(() => {
    if (lan !== current) return
    lanState = 'listening'
    const bound = typeof current.port === 'function' ? current.port() : 0
    const changed = bound > 0 && bound !== lanBoundPort
    if (bound > 0) lanBoundPort = bound
    publishState()
    // 实际端口和首选端口不同时，中转侧那份 lanUrls（注册时随 metadata 上报的）
    // 带的就是首选端口，手机从公网拿到的局域网候选全是死地址。重连一次隧道，让
    // 中转拿到真正的端口。
    if (changed && config.enabled && config.relayUrl) startTunnel()
  }).catch(error => { if (lan === current) { lanState = 'error'; lanError = error instanceof Error ? error.message : String(error); publishState() } })
}
async function configure(next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('invalid configuration')
  const allowed = ['enabled', 'relayUrl', 'instanceId', 'pairingCode', 'name', 'upstreamPort', 'lanPort', 'lanEnabled', 'lanSecret', 'registerSecret']
  if (Object.keys(next).some(key => !allowed.includes(key))) throw new Error('unknown configuration field')
  if (typeof next.instanceId !== 'string' || next.instanceId.length > 128) throw new Error('invalid instanceId')
  if (typeof next.pairingCode !== 'string' || !/^\d{6}$/.test(next.pairingCode)) throw new Error('invalid pairingCode')
  if (typeof next.upstreamPort !== 'number' || !Number.isInteger(next.upstreamPort) || next.upstreamPort < 1 || next.upstreamPort > 65535) throw new Error('invalid upstreamPort')
  if (next.lanPort !== undefined && (!Number.isInteger(next.lanPort) || next.lanPort < 1024 || next.lanPort > 65535)) throw new Error('invalid lanPort')
  if (next.registerSecret !== undefined && (typeof next.registerSecret !== 'string' || next.registerSecret.length > 512)) throw new Error('invalid registerSecret')
  await stopServices()
  config = { ...next }
  if (config.enabled) {
    startTunnel()
    startNetworkMonitor()
    if (config.lanEnabled) startLan()
  }
  return status()
}
function status() {
  return { ok: true, sidecar: true, enabled: Boolean(config.enabled), relayUrl: config.relayUrl || '', instanceId: config.instanceId, name: config.name, localPort: config.upstreamPort, tunnel: { state: tunnelState, error: tunnelError }, lan: { enabled: Boolean(config.lanEnabled), port: lanUrlPort(), requestedPort: config.lanPort, state: lanState, error: lanError } }
}
const server = http.createServer(async (req, res) => {
  try {
    if (!authorized(req)) return send(res, 401, { ok: false, error: 'unauthorized' })
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, service: 'dsh-ai-hub-relay-sidecar', capabilities: ['relay-tunnel', 'lan-proxy', 'pairing-approval-rpc'] })
    if (req.method === 'GET' && req.url === '/status') return send(res, 200, status())
    if (req.method === 'POST' && req.url === '/configure') { const next = await readBody(req, CONFIGURE_MAX_BODY); configuring = configuring.then(() => configure(next)); return send(res, 200, await configuring) }
    if (req.method === 'POST' && req.url === '/tunnel/send') {
      const body = await readBody(req, TUNNEL_SEND_MAX_BODY);
      // 桌面→relay 主动推送（移动端镜像缓存）：复用隧道立即 sendJson；同时在本地保留快照供读取隔离。
      if (body && typeof body === 'object' && body.kind === 'sync') localSnapshot = body;
      if (tunnel && tunnel.connected) {
        tunnel.sendJson(T.sync, 0, body && typeof body === 'object' ? body : { kind: 'raw', data: body });
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
const shutdown = () => {
  reconnect.cancel()
  server.close()
  for (const socket of sockets) socket.destroy()
  void stopServices()
  setTimeout(() => process.exit(0), 1000).unref()
}
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown)

/**
 * 父进程（宿主）没了就自己退出：否则这里会变成一具握着隧道的尸体。
 *
 * ~~Node 的 fork 子进程不会随父进程退出~~。宿主被 Cmd+Q / 被系统内存压力清掉 / 被
 * SIGKILL 时，没有任何人会给这里发 SIGTERM，IPC 通道也只是**静默 EOF**（Node 不会
 * 替我们发 disconnect）。于是 worker 继续活着、继续握着那条 `register` 成功过的中转
 * 隧道、继续如实回答 `/api/mobile/v1/status`（它知道的宿主身份还是那一份），中转的
 * `instances` 里那条记录就永不删除 —— 手机侧栏的设备「在线」从此再也灭不掉，正文
 * 镜像也停在最后一帧。2026-10-10 真机故障，根因就在这里。
 *
 * 两道判据都留着，互相兜底：
 *  - `disconnect`：宿主正常退出 / 主动销毁 IPC 时立刻触发，退出最快；
 *  - ppid 巡检：宿主被 SIGKILL 时**不发** disconnect（实测只看到 ppid 变成 1），
 *    只能靠定时对账。启动时记下 ppid，之后对不上就退出；间隔与宿主那边的健康轮询
 *    同量级（10s），2s 只是让「关掉桌面 → 手机显示离线」快一点。
 *
 * 为什么是整进程退出而不是只 `stopServices()`：隧道一关，中转最多 60s（心跳 pong
 * 超时）才删掉实例，这段时间手机仍显示在线；而孤儿进程本来就没有存在的理由，退出是
 * 最快的收敛路径（也让 `ps` 里不再留下一行认不出归属的 node 进程）。
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
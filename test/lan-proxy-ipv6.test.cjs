'use strict'

/**
 * 直连监听的 IPv6 守卫：宿主过去只在 `0.0.0.0` 上听，手机不在同一个 Wi-Fi 里、只有 IPv6
 * 时拨不进来。现在 IPv4 那条原样保留，另起一条 `::` + `ipv6Only` 的监听接同一个端口。
 * 这份测试启动**真实的 lan-proxy**，钉三件读代码看不出来的事：
 *
 *   1. 同一个实例上 IPv4（`127.0.0.1`）与 IPv6（`::1`）两边都通，且走到同一条 handler；
 *   2. 首选端口被占而退到内核端口时，IPv6 那条跟着**实绑**端口走，不守着那个没人监听的号；
 *   3. 配对接口收口：来源是原生全球单播 IPv6 时按「配对码错误」回（JSON、非 2xx，
 *      不暴露接口存在性、也不惊动桌面端授权），而 IPv4 来源照旧走完整个配对流程 ——
 *      公网 IPv4 直连配对是现有受支持用法（二维码里带 IPv4 候选），不能被一起拦掉。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

// 必须在 require credentials.js（lan-proxy 的依赖）之前指向临时文件，否则测试会污染真实凭据库。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lan-ipv6-'))
process.env.DEVICE_CREDENTIALS_FILE = path.join(tmp, 'relay-device-credentials.json')

const { createLanProxy } = require('../lib/relay/lan-proxy.js')
const core = require('../lib/relay/core.js')
const { isGlobalUnicastV6 } = require('../lib/relay/lan-network.cjs')

const INSTANCE = 'lanipv601'
const CODE = '246810'
const SECRET = 'lan-ipv6-secret-0123456789'
const HOST_TOKEN = core.signLanToken(SECRET, INSTANCE, core.MOBILE_BEARER_TTL_SEC)
/** 配对被拒时 lan-proxy 回的响应（`pairDenied`）：被拦下来的来源必须与它一字不差。 */
const PAIR_DENIED = { ok: false, error: '配对码错误或桌面端已拒绝' }

/** 本机是否真的能听 `::1`（IPv6 被关掉的机器上这条用例没有意义，跳过而不是失败）。 */
async function hasIpv6Loopback() {
  const probe = net.createServer()
  try {
    await new Promise((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(0, '::1', resolve)
    })
    return true
  } catch {
    return false
  } finally {
    try { probe.close() } catch { /* 没监听成 */ }
  }
}

/** 一次请求。`host` / `family` 决定走哪个协议族，`localAddress` 决定服务端看到的来源地址。 */
function request(port, { host = '127.0.0.1', family, localAddress, method = 'GET', path: p, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const options = { host, port, method, path: p, headers }
    if (family) options.family = family
    if (localAddress) options.localAddress = localAddress
    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** 打一次配对接口。不传 `code` 就是用正确的配对码。 */
function pair(port, { code = CODE, ...rest } = {}) {
  return request(port, {
    ...rest,
    method: 'POST',
    path: '/__lan_pair',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, device: { name: '测试手机', platform: 'ios' } }),
  })
}

/** 假宿主：只回「我来过」，用于证明请求真的被代理到了上游。 */
function startUpstream() {
  const seen = []
  const server = http.createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, upstream: true, path: req.url }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }))
  })
}

/**
 * 本机的原生全球单播 IPv6 地址：用它当**来源地址**，才可能在这台机器上真的验一次
 * 「公网 IPv6 打进来」。分类直接用宿主那一份判据，这里不另写一套。
 */
function globalV6Sources() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if ((item.family === 'IPv6' || item.family === 6) && isGlobalUnicastV6(item.address)) out.push(item.address)
    }
  }
  return out
}

/**
 * 占住一个端口（IPv4 上），用来逼代理走「首选端口被占 → 退到内核分配」那条自愈路径。
 */
function holdPort() {
  const holder = net.createServer()
  return new Promise((resolve) => {
    holder.listen(0, '0.0.0.0', () => resolve({ holder, port: holder.address().port }))
  })
}

/** 起一个真实的 lan-proxy（端口照旧走 listen(0)），并把日志收在数组里。 */
async function startProxy(upstreamPort, extra = {}) {
  const logs = []
  const proxy = createLanProxy({
    lanPort: 0,
    pairingCode: CODE,
    instanceId: INSTANCE,
    lanSecret: SECRET,
    upstreamPort,
    onLog: (...args) => logs.push(args.join(' ')),
    ...extra,
  })
  await proxy.start()
  return { proxy, logs, port: proxy.port() }
}

test('双栈：同一个实例上 IPv4 与 IPv6 都通，且走到同一条 handler', async (t) => {
  if (!(await hasIpv6Loopback())) {
    t.skip('本机没有 IPv6 环回')
    return
  }
  const upstream = await startUpstream()
  const { proxy, port } = await startProxy(upstream.port)
  try {
    assert.ok(port > 0, '借的是内核分配的空闲端口')

    // 无需鉴权的路径：两侧都得通（IPv6 那条监听起没起来，看的就是这一发）。
    const healthV4 = await request(port, { host: '127.0.0.1', path: '/healthz' })
    const healthV6 = await request(port, { host: '::1', family: 6, path: '/healthz' })
    assert.equal(healthV4.status, 200, 'IPv4 侧应通')
    assert.equal(healthV6.status, 200, 'IPv6 侧应通（`::` 那条监听）')
    assert.equal(healthV4.body, 'ok')
    assert.equal(healthV6.body, 'ok')

    // 鉴权过的路径：两侧都要被代理到同一个上游、响应同形 —— 「同一 handler」的证据。
    const authed = (host, family) => request(port, {
      host,
      family,
      path: '/api/mobile/v1/status',
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
    })
    const viaV4 = await authed('127.0.0.1')
    const viaV6 = await authed('::1', 6)
    assert.equal(viaV4.status, 200, 'IPv4 侧应被代理')
    assert.equal(viaV6.status, 200, 'IPv6 侧应被代理')
    assert.equal(viaV6.body, viaV4.body, '两侧响应必须同形')
    assert.equal(upstream.seen.length, 2, '两侧的请求都该到上游')
  } finally {
    proxy.stop()
    await new Promise((resolve) => upstream.server.close(resolve))
  }
})

test('首选端口被占时，两条监听都落到实绑的那个端口上', async (t) => {
  if (!(await hasIpv6Loopback())) {
    t.skip('本机没有 IPv6 环回')
    return
  }
  const held = await holdPort()
  const upstream = await startUpstream()
  const logs = []
  const proxy = createLanProxy({
    lanPort: held.port,
    pairingCode: CODE,
    instanceId: INSTANCE,
    lanSecret: SECRET,
    upstreamPort: upstream.port,
    onLog: (...args) => logs.push(args.join(' ')),
  })
  try {
    await proxy.start()
    const actual = proxy.port()
    assert.notEqual(actual, held.port, '首选端口被占，该退到内核分配的空闲端口')

    // IPv6 那条必须跟着**实绑**端口走，而不是还守着首选端口 —— 否则手机在 IPv6 上
    // 拨的是一个没人监听的号，比没有这条监听更坏。
    const health = await request(actual, { host: '::1', family: 6, path: '/healthz' })
    assert.equal(health.status, 200, 'IPv6 侧应通')
    assert.equal(health.body, 'ok')

    // 日志按 `server.address()` 如实报**每一条**实际绑上的 host+端口。
    const text = logs.join('\n')
    assert.ok(text.includes(`listening on 0.0.0.0:${actual}`), `IPv4 那条该报实绑端口，实际：\n${text}`)
    assert.ok(text.includes(`listening on [::]:${actual}`), `IPv6 那条该报实绑主机与端口，实际：\n${text}`)
  } finally {
    proxy.stop()
    await new Promise((resolve) => held.holder.close(resolve))
    await new Promise((resolve) => upstream.server.close(resolve))
  }
})

test('/__lan_pair：原生全球 IPv6 来源被拒，IPv4 来源照旧配对', async (t) => {
  if (!(await hasIpv6Loopback())) {
    t.skip('本机没有 IPv6 环回')
    return
  }
  const sources = globalV6Sources()
  if (sources.length === 0) {
    t.skip('本机没有全球单播 IPv6 地址')
    return
  }
  const upstream = await startUpstream()
  const approved = []
  const { proxy, port } = await startProxy(upstream.port, {
    onApprove: async (device) => {
      approved.push(device)
      return { approved: true, token: HOST_TOKEN }
    },
  })
  try {
    // 基准：配对码错时是什么响应。被拦下来的来源必须与它一字不差。
    const wrongCode = await pair(port, { code: '000000' })
    assert.equal(wrongCode.status, 401)
    assert.deepEqual(JSON.parse(wrongCode.body), PAIR_DENIED)

    // 原生全球 IPv6 来源：**配对码是对的**也一样拒 —— 拒的是来源，不是码。
    // 用它当源地址连接 `::1`：服务端 `remoteAddress` 就是这条公网地址。
    let banned = null
    let source = null
    for (const candidate of sources) {
      try {
        banned = await pair(port, { host: '::1', family: 6, localAddress: candidate })
        source = candidate
        break
      } catch { /* 临时地址可能刚被轮换掉，换一条再试 */ }
    }
    assert.ok(banned, '本机的全球 IPv6 地址一条都拨不通，这条用例没测到东西')
    assert.equal(banned.status, 401, `来源 ${source} 的配对必须被拒`)
    assert.deepEqual(JSON.parse(banned.body), PAIR_DENIED, '必须与「配对码错误」同形，不暴露接口存在性')
    assert.equal(banned.headers['set-cookie'], undefined, '被拒时不得下发 cookie')
    assert.equal(approved.length, 0, '被拒的来源根本不该走到桌面端授权')

    // IPv4 来源不受影响：同一个实例、同一个配对码，照旧走完整个配对流程。
    const granted = await pair(port)
    assert.equal(granted.status, 200, 'IPv4 来源的公网配对是现有受支持用法，不能被一起拦掉')
    const grant = JSON.parse(granted.body)
    assert.equal(grant.ok, true)
    assert.equal(grant.token, HOST_TOKEN)
    assert.match(grant.deviceCredential, /^dshc_/)
    // 配对响应要带回宿主自己的直连候选：手输公网地址（域名 / 公网 IP）配对时没有二维码，
    // 手机只记住那一个公网地址；回家后它若打不通（路由器不支持回环），这批候选是手机
    // 找到内网地址的唯一来源。
    assert.ok(Array.isArray(grant.lanUrls) && grant.lanUrls.length > 0, '配对响应要带回直连候选')
    assert.ok(grant.lanUrls.every((url) => /^http:\/\/[^/]+:\d+$/.test(url)), `候选形状不对：${JSON.stringify(grant.lanUrls)}`)
    if (grant.ipv6Candidates !== undefined) {
      assert.ok(Array.isArray(grant.ipv6Candidates), 'IPv6 候选若给出必须是数组')
    }
    assert.equal(approved.length, 1, 'IPv4 来源应照旧送达桌面端授权')
  } finally {
    proxy.stop()
    await new Promise((resolve) => upstream.server.close(resolve))
  }
})

/*
 * 这里没覆盖的一格：「IPv6 那条绑不上 → 只留 IPv4 直连」的软失败路径。这台机器上造不出
 * 那个局面：macOS 只要有一个 `::` 的 socket 占着某端口（哪怕显式 `ipv6Only`），同端口的
 * `0.0.0.0` 就再也绑不上 —— 于是「IPv6 被占、IPv4 空闲」根本不存在，占住 `::` 只会把
 * IPv4 一起拖走（代理转而去走「端口被占」那条自愈路径）。挡 IPv6 的机器上，那条监听会
 * 留一行 `IPv6 监听未建立（…）`，IPv4 照旧可用；分支见 lan-proxy.js 的 startV6。
 */

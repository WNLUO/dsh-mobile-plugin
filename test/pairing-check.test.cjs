// 2026-11-26：配对地址自检的守卫——码里每条地址真拨一次，拨自己的那条只算「本机回环」。
'use strict'

/**
 * 引导页第三页在出码前跑这一遍：全不通就别给一张扫了也白扫的码，只有自己拨自己通的时候
 * 也只能说「本机回环可达」。这里钉四件事：
 *   1. 码里会出现哪些地址、各算哪一类（同一串地址出现在两栏时只留说明力更强的那条）；
 *   2. 拨到 5xx 不算通（对面在，但那一层自己起不来），4xx 算通（门开没开，不问内容）；
 *   3. 汇总分得清「外部线路可达」与「只有本机回环可达」，两者不能混；
 *   4. 一条地址都没有时不算是失败，而是「没得查」。
 */

const assert = require('node:assert/strict')
const http = require('node:http')
const test = require('node:test')

const { pairingCheck, targetsOf, summarize, hostOf } = require('../lib/relay/pairing-check.cjs')

/** 起一台只听 127.0.0.1 的服务，返回端口与收摊的函数。 */
async function startServer(t, handler) {
  const sockets = new Set()
  const server = http.createServer(handler)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  })
  return server.address().port
}

/** 与 relay.json 同形的最小一份：只留拼码要读的那几格。 */
function stateOf(extra) {
  return {
    name: 'test',
    instanceId: 'instance-1',
    pairingCode: '123456',
    pairingTicket: 'ticket',
    lanEnabled: false,
    relayUrl: '',
    ...extra,
  }
}

test('码里要拨的地址：服务商线路优先于同名局域网副本，TCP 单独一类', () => {
  const targets = targetsOf({
    relayUrl: 'https://relay.example.com',
    lanUrls: ['http://192.168.1.5:18787', 'https://zeronews.example.com', 'http://192.168.1.5:18787/'],
    directUrl: 'http://my-house.example.com:18787',
    routes: [{ url: 'https://zeronews.example.com/', transport: 'http', name: 'ZeroNews' }],
    tcpUrl: '192.168.1.5:18787',
  })
  const zeronews = targets.filter((row) => row.url === 'https://zeronews.example.com')
  assert.equal(zeronews.length, 1, '同一串地址只拨一次')
  assert.equal(zeronews[0].kind, 'route', '留下带名字的服务商线路，不留匿名副本')
  assert.equal(zeronews[0].name, 'ZeroNews')
  assert.equal(targets.find((row) => row.kind === 'tcp').url, 'tcp://192.168.1.5:18787')
  assert.equal(targets.filter((row) => row.kind === 'lan').length, 1, '局域网条目末尾斜杠不影响去重')
})

test('IPv6 地址也能取出主机名', () => {
  assert.equal(hostOf('http://[240e:1:2::5]:18787'), '240e:1:2::5')
  assert.equal(hostOf('不是地址'), '')
})

test('汇总：全失败 / 只有自己拨自己 / 有外部线路通了', () => {
  assert.deepEqual(summarize([{ local: true, ok: false }, { local: false, ok: false }]), {
    total: 2, okCount: 0, remoteOk: false, localOk: false, allFailed: true, nothingToCheck: false,
  })
  const loopbackOnly = summarize([{ local: true, ok: true }, { local: false, ok: false }])
  assert.equal(loopbackOnly.localOk, true)
  assert.equal(loopbackOnly.remoteOk, false, '拨自己通了不等于外部线路通')
  assert.equal(loopbackOnly.allFailed, false)
  const remote = summarize([{ local: true, ok: true }, { local: false, ok: true }])
  assert.equal(remote.remoteOk, true)
  assert.equal(summarize([]).nothingToCheck, true, '一条都没有是「没得查」，不是失败')
  assert.equal(summarize([]).allFailed, false)
})

/** 拿一个确实没人听的端口：绑一下、记下号、马上关掉。 */
async function freePort() {
  const server = http.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

test('拨一次：4xx 算通、5xx 不算通、关着的端口算不通', async (t) => {
  const good = await startServer(t, (_req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  const bad = await startServer(t, (_req, res) => {
    res.writeHead(502, { 'content-type': 'text/plain' })
    res.end('bad gateway')
  })
  const dead = await freePort()

  const reachable = await pairingCheck(stateOf({ relayUrl: `http://127.0.0.1:${good}` }), { timeoutMs: 2000 })
  assert.equal(reachable.targets[0].ok, true, '404 也是门开了')

  const broken = await pairingCheck(stateOf({ relayUrl: `http://127.0.0.1:${bad}` }), { timeoutMs: 2000 })
  assert.equal(broken.targets[0].ok, false, '5xx 说明那一层自己起不来')
  assert.equal(broken.targets[0].detail, 'HTTP 502')

  const refused = await pairingCheck(stateOf({ relayUrl: `http://127.0.0.1:${dead}` }), { timeoutMs: 500 })
  assert.equal(refused.targets.length, 1)
  assert.equal(refused.targets[0].ok, false)
  assert.equal(refused.summary.allFailed, true)
})

test('拨自己：局域网地址算本机回环，外部地址不算', async (t) => {
  const port = await startServer(t, (_req, res) => res.end('ok'))
  // 把回环当成「本机网卡上的地址」喂进去，模拟 192.168.x.x 那种自己拨自己的情况。
  const result = await pairingCheck(stateOf({ relayUrl: `http://127.0.0.1:${port}` }), {
    timeoutMs: 2000,
    interfaces: { lo0: [{ address: '127.0.0.1', family: 'IPv4' }] },
  })
  assert.equal(result.targets[0].local, true)
  assert.equal(result.summary.localOk, true)
  assert.equal(result.summary.remoteOk, false, '自检不许把拨自己说成外部可达')
})

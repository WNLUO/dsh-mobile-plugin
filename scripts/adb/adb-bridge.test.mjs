import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// scripts/ 下没有自己的 package.json，也没有顶层 node_modules，ws 只存在于
// 三个子包里。测试与被测脚本都用 ADB_WS_MODULE_DIR / NODE_PATH 指到中转那一份，
// 避免为了跑一个守卫测试去改依赖布局。
const HERE = dirname(fileURLToPath(import.meta.url))
const MODULE_DIR = join(HERE, '..', 'node_modules')
const requireFromModules = createRequire(join(MODULE_DIR, 'noop.js'))
const { WebSocketServer } = requireFromModules('ws')

/**
 * 起一个 WebSocket 服务端，扮演「服务器侧桥」的对面。
 *
 * `upgradeDelayMs` 是关键：它**故意拖慢**握手，让 adb 那几包字节确定落在
 * WebSocket open 之前。没有这个延迟，本机回环上握手快到可能已经 open，
 * 断言就会在根本没走到「握手期队列」那条分支的情况下通过——那种守卫等于没有。
 */
async function startFakeServer(onConnection, { upgradeDelayMs = 0, serverPerMessageDeflate } = {}) {
  const http = createHttpServer((_req, res) => { res.writeHead(200); res.end() })
  const wss = new WebSocketServer(
    serverPerMessageDeflate === undefined ? { noServer: true } : { noServer: true, perMessageDeflate: serverPerMessageDeflate })
  http.on('upgrade', (req, socket, head) => {
    setTimeout(() => wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req)), upgradeDelayMs)
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  return { wss, port: http.address().port, close: () => new Promise((r) => http.close(r)) }
}

/** 起被测脚本：真正的 adb-ws-local-bridge.cjs 子进程。 */
async function startLocalBridge(wsPort, localPort) {
  const child = spawn(process.execPath, [join(HERE, 'adb-ws-local-bridge.cjs')], {
    env: {
      ...process.env,
      NODE_PATH: MODULE_DIR,
      ADB_WS_URL: `ws://127.0.0.1:${wsPort}/`,
      ADB_LOCAL_PORT: String(localPort),
      ADB_LOCAL_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines = []
  const collectOutput = (d) => lines.push(...String(d).split('\n'))
  child.stdout.on('data', collectOutput)
  child.stderr.on('data', collectOutput)
  // 等它真的开始监听，而不是靠固定 sleep 猜。
  await waitFor(() => lines.some((l) => l.includes(`tcp://127.0.0.1:${localPort}`)), 10000,
    () => `本机桥没起来：\n${lines.join('\n')}`)
  return { child, lines, stop: () => child.kill('SIGKILL') }
}

/** 连上本机桥的 TCP 端口，扮演 adb。 */
async function connectAsAdb(localPort) {
  const adb = connect({ host: '127.0.0.1', port: localPort })
  await once(adb, 'connect')
  return adb
}

// 这是本文件最关键的一条。adb 在 TCP 连上的瞬间就把版本查询发出去了，而
// WebSocket 握手是异步的——握手期收到的字节如果被直接丢弃，adb 永远等不到
// 服务端回应，表现为 `failed to check server version: protocol fault`。
// 早先的实现正是这么写的，理由是「adb 会重试」，但它不会重试。
test('握手期收到的字节在 WebSocket 连上后被补发，而不是丢弃', async () => {
  const got = []
  // 300ms 延迟握手，确保下面几段字节一定落在 open 之前。
  const server = await startFakeServer((ws) => {
    ws.on('message', (d) => got.push(d.toString()))
  }, { upgradeDelayMs: 300 })
  const bridge = await startLocalBridge(server.port, 15071)
  try {
    const adb = await connectAsAdb(15071)
    adb.write(Buffer.from('0009host:version'))
    // 分三次写、每次间隔一小段：同一次 write 的多个 chunk 会被 TCP 合并成
    // 一次读，pending 里就只剩一个元素，那样「补发顺序」根本没被真正验证。
    await new Promise((r) => setTimeout(r, 20))
    adb.write(Buffer.from('|AAA'))
    await new Promise((r) => setTimeout(r, 20))
    adb.write(Buffer.from('|BBB'))

    await waitFor(() => got.join('').length >= 21, 10000, () => `服务端只收到：${JSON.stringify(got.join(''))}`)
    assert.equal(
      got.join(''),
      '0009host:version|AAA|BBB',
      '握手期字节必须按原顺序补发，adb 靠固定长度包头做协议分发，乱序就解析不了',
    )
    adb.destroy()
  } finally {
    bridge.stop()
    await server.close()
  }
})

// 压缩会破坏 adb 的二进制流，所以本机桥必须显式关掉。
//
// 注意断言要怎么写才有意义：只有**服务端提供** permessage-deflate 时，客户端
// 的开关才起作用。真实桥是 `new WebSocketServer({ server })`，默认不提供，
// 此时把客户端改成 true 也协商不上，断言会假绿。所以这里让服务端显式提供，
// 断言客户端仍然不去协商——只有这样，改成 true 才会真的转红。
test('perMessageDeflate 关闭：即使服务端提供压缩也不去协商', async () => {
  let extensions = null
  const server = await startFakeServer((ws) => { extensions = ws.extensions },
    { serverPerMessageDeflate: true })
  const bridge = await startLocalBridge(server.port, 15072)
  try {
    const adb = await connectAsAdb(15072)
    await waitFor(() => extensions !== null, 10000, () => 'WebSocket 一直没建连')
    assert.equal(extensions, '', '客户端主动关掉了压缩，服务端即使提供也不协商')
    adb.destroy()
  } finally {
    bridge.stop()
    await server.close()
  }
})

test('回程数据从 WebSocket 透传回 adb 的 TCP 连接', async () => {
  const server = await startFakeServer((ws) => {
    ws.send(Buffer.from('OKAY'), { binary: true })
  })
  const bridge = await startLocalBridge(server.port, 15073)
  try {
    const adb = await connectAsAdb(15073)
    const chunks = []
    adb.on('data', (d) => chunks.push(d.toString()))
    await waitFor(() => chunks.join('') === 'OKAY', 10000, () => `adb 只收到：${JSON.stringify(chunks.join(''))}`)
    assert.equal(chunks.join(''), 'OKAY')
    adb.destroy()
  } finally {
    bridge.stop()
    await server.close()
  }
})

test('多条 adb 连接各自独立建通道，不会串到同一条 WebSocket 上', async () => {
  const server = await startFakeServer((ws) => {
    ws.on('message', (d) => ws.send(Buffer.from(`echo:${d.toString()}`), { binary: true }))
  })
  const bridge = await startLocalBridge(server.port, 15074)
  try {
    const a = await connectAsAdb(15074)
    const b = await connectAsAdb(15074)
    const seen = new Map()
    a.on('data', (d) => seen.set('a', (seen.get('a') || '') + d.toString()))
    b.on('data', (d) => seen.set('b', (seen.get('b') || '') + d.toString()))
    a.write(Buffer.from('one'))
    b.write(Buffer.from('two'))
    await waitFor(() => seen.get('a') === 'echo:one' && seen.get('b') === 'echo:two', 10000,
      () => `回显未分离：${JSON.stringify([...seen])}`)
    assert.equal(seen.get('a'), 'echo:one')
    assert.equal(seen.get('b'), 'echo:two')
    a.destroy()
    b.destroy()
  } finally {
    bridge.stop()
    await server.close()
  }
})

// --- 小工具 ---------------------------------------------------------------

/** 轮询直到条件成立；超时抛错而不是静默通过。 */
async function waitFor(predicate, timeoutMs, describe) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(describe ? describe() : `等待条件超时（${timeoutMs}ms）`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

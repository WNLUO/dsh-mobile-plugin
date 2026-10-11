'use strict'

/**
 * 回归：sidecar worker 的 stdout/stderr 必须被父进程消费。
 *
 * 现场（排查实时 SSE 时的观测盲区）：sidecar-facade.cjs 用
 * `stdio: ['ignore', 'ignore', 'pipe', 'ipc']` fork worker，只给 stderr 开了 pipe
 * 却从不读它 —— worker（隧道 + 局域网代理都在这里面）的全部诊断输出被静默丢弃。
 * 表现是「宿主日志里什么都没有，连崩溃都看不见」：排障时一度据此误判「插件根本没
 * 执行到那段代码」。更糟的是写入量涨过管道缓冲后，worker 的事件循环会被写阻塞卡死。
 *
 * 修法：stdout/stderr 都开 pipe 并原样转发到宿主自己的 stderr（systemd 收进
 * host.log）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { SidecarFacade } = require('../lib/sidecar-facade.cjs')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 借一个空闲端口后立刻还回去（lan-proxy 会真的 bind）。 */
async function freePort() {
  const server = http.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

test('源码契约：worker 的 stdout/stderr 都开 pipe 且都被转发', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sidecar-facade.cjs'), 'utf8')
  assert.match(src, /stdio:\s*\['ignore',\s*'pipe',\s*'pipe',\s*'ipc'\]/, 'stdout 与 stderr 都必须开 pipe')
  assert.match(src, /child\.stdout\?\.on\('data'/, '必须消费 child.stdout')
  assert.match(src, /child\.stderr\?\.on\('data'/, '必须消费 child.stderr')
})

test('行为：worker 写进 stderr 的日志会被转发到宿主 stderr', async () => {
  const parent = http.createServer((_req, res) => { res.writeHead(404); res.end('{}') })
  await new Promise((resolve) => parent.listen(0, '127.0.0.1', resolve))
  const lanPort = await freePort()
  const facade = new SidecarFacade({ parentPort: parent.address().port, token: randomBytes(32).toString('hex') })

  const chunks = []
  const originalWrite = process.stderr.write
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true }
  const text = () => chunks.join('')

  try {
    await facade.start()
    // 空 relayUrl → startTunnel 早退，只跑局域网代理；它起来时会通过 onLog 写一行
    // `[lan-proxy] listening on 0.0.0.0:<port>` —— 那正是旧实现里被丢弃的输出。
    await facade.configure({
      enabled: true,
      relayUrl: '',
      instanceId: 'i1',
      pairingCode: '123456',
      name: 'Test',
      upstreamPort: 12345,
      lanPort,
      lanEnabled: true,
      lanSecret: randomBytes(32).toString('hex'),
    })
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && !text().includes('[lan-proxy] listening')) await delay(50)
    assert.match(text(), /\[dsh-ai-hub sidecar\] \[lan-proxy\] listening on 0\.0\.0\.0:/,
      'worker 的 stderr 必须转发到宿主 stderr（旧实现只开 pipe 不读，输出被静默丢弃）')
  } finally {
    process.stderr.write = originalWrite
    try { await facade.stop() } catch { /* ignore */ }
    await new Promise((resolve) => parent.close(resolve))
  }
})

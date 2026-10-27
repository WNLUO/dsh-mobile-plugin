'use strict'

/**
 * SidecarFacade：宿主 ⇄ sidecar worker 的环回 HTTP 客户端 + 生命周期看守。
 *
 * fork worker、等 ready、把它的 stdout/stderr 转发到宿主 stderr（诊断只有这一条通道），之后
 * 按需 request('/status' | '/configure' | '/tunnel/send' | '/revoke-all')。
 *
 * 两条上报通道都是「宿主必须立刻知道」的事：onDown（worker 意外退出，否则隧道/局域网快照会
 * 永远冻在临死前那一帧）、onState（worker 在状态变化那一刻主动推的一帧）。
 *
 * 刻意不做重试：超时就是超时，由调用方决定是否重启；偷偷重试会把「隧道已死」拖成
 * 「偶尔能通」，更难诊断。
 */

const http = require('node:http')
const { fork } = require('node:child_process')
const { join } = require('node:path')

const worker = join(__dirname, 'sidecar-facade-worker.cjs')

/**
 * `/configure` 的等待上限。
 *
 * 换中转地址时 worker 会**等新隧道真的注册上**再回包（顺序见 lib/relay/migrate.js）：注册
 * 失败要撤销迁移、还要把错误一路回给手机上那一发请求。隧道自己的注册超时是 8s，所以这里
 * 比它宽一截；超时了宿主拿到的是「facade 超时」而不是真正的原因，那句话在手机上没法用。
 */
const CONFIGURE_TIMEOUT_MS = 12_000

class SidecarFacade {
  constructor(options) {
    this.parentPort = options.parentPort
    this.token = options.token
    this.child = null
    this.port = null
    this.pending = new Map()
    this.nextId = 1
    // worker 意外死掉时通知宿主。宿主那边有一份 sidecarSnapshot（隧道/局域网的
    // 最近一次快照），如果没人告诉它 worker 已经没了，这份快照就永远冻在临死前
    // 那一帧：/api/relay/status 会继续报 tunnel: connected、lan: listening，
    // 而局域网端口上早就没人监听了。状态乐观比状态难看危险得多——它会让宿主
    // 继续按「隧道是通的」去推镜像，然后一路 503。
    this.onDown = typeof options.onDown === 'function' ? options.onDown : null
    // 隧道/局域网状态**跳变**的即时上报（worker 侧 publishState()）。健康轮询仍然是权威
    // （只有它能发现「worker 整个没了」——那时 IPC 也断了），但轮询是 10s 一次的滞后快照：
    // 隧道真断之后宿主最多 10s 仍认为已连接，期间照推镜像、每次撞 5s 超时，该会话的单飞门
    // 被占住；反过来「断又连」整段落在两次轮询之间时，宿主看不到跳变，全量补推会被漏掉。
    // 这里只做转发，边沿判定在宿主侧（lib/sidecar-lifecycle.cjs 的 applyTunnelState），
    // 与轮询共用同一个判定，所以不会把一次重连算成两次补推。
    this.onState = typeof options.onState === 'function' ? options.onState : null
  }

  async start() {
    if (this.child) return
    const child = fork(worker, [], { env: { ...process.env, DSH_SIDECAR_PARENT_PORT: String(this.parentPort), DSH_SIDECAR_TOKEN: this.token }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    this.child = child
    // 意外退出必须立刻反映到宿主，不能等下一次健康轮询。这里带身份守卫：stop() 先把
    // this.child 置空，紧接着 start() 会产生新 child，旧 child 迟到的 exit 绝不能把
    // 刚起来的新实例又拉下水（和 worker 侧 tunnel 的 `tunnel === current` 同一道理）。
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      // port 也要清：留着它的话后续 request 会对着一个已经没人监听的端口发，
      // 报出来的是 ECONNREFUSED 之类天书，而不是「sidecar 已经不在了」。
      this.port = null
      if (this.onDown) this.onDown(new Error(signal ? `sidecar facade killed by ${signal}` : `sidecar facade exited ${code}`))
    })
    // 子进程的 stdout/stderr 必须有人消费。旧实现只给 stderr 开了 pipe 却从不读，
    // 于是隧道与局域网代理的全部诊断输出被静默丢弃（排障时表现为「宿主日志里
    // 什么都没有，连崩溃都看不见」）；写入量涨过管道缓冲后，worker 的事件循环
    // 还会被写阻塞卡死。这里原样转发到宿主自己的 stderr（systemd 收进 host.log）。
    child.stdout?.on('data', (chunk) => process.stderr.write(chunk))
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk))
    // 状态帧必须用常驻监听：下面 ready 用的是 child.once('message')，它会把第一条消息吃掉。
    // 状态上报与 ready 恰好都在启动窗口里发，用 once 会漏掉第一条（而且 after ready 的
    // 那些也永远收不到）。
    child.on('message', message => {
      if (!this.onState || !message || message.type !== 'state') return
      try { this.onState(message) } catch { /* 状态回写不能反过来弄挂 facade */ }
    })
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sidecar facade startup timeout')), 5000)
      child.once('message', message => {
        if (message?.type === 'ready') { clearTimeout(timer); this.port = message.port; resolve(message) }
      })
      child.once('error', reject)
      child.once('exit', code => { if (code !== 0) reject(new Error(`sidecar facade exited ${code}`)) })
    })
    await ready
    await this.request('/health')
  }

  // `timeoutMs` 可覆盖：隧道侧的 `/revoke-all` 要等中转逐个断开设备（调用方给 20s），
  // 而这里旧实现硬编码 5s，慢中转下宿主永远先超时、`/api/relay/revoke-all` 只好
  // 报 revoked:0（看起来像「撤销成功但一台都没撤」）。
  request(pathname, method = 'GET', body, timeoutMs = 5000) {
    if (!this.port) return Promise.reject(new Error('sidecar facade is not running'))
    return new Promise((resolve, reject) => {
      const headers = { authorization: `Bearer ${this.token}` }
      if (body !== undefined) headers['content-type'] = 'application/json'
      const req = http.request({ host: '127.0.0.1', port: this.port, path: pathname, method, headers }, res => {
        let raw = ''; res.setEncoding('utf8'); res.on('data', chunk => { raw += chunk }); res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            // 把 worker 侧返回的 error 原文带进异常。raw 这时已经在手上，却一直被丢掉，
            // 于是「请求体太大」「隧道没连上」「帧太大」在宿主侧全长成同一句
            // `sidecar facade request failed: 503`——排查时无从下手，只能反过来去
            // 读 worker 进程的 stderr。这一行是把整个镜像 503 查出来的关键。
            let detail = ''
            try {
              const parsed = JSON.parse(raw || '{}')
              if (parsed && typeof parsed.error === 'string' && parsed.error) detail = ` (${parsed.error})`
            } catch { /* 非 JSON 响应就只能留状态码 */ }
            return reject(new Error(`sidecar facade request failed: ${res.statusCode}${detail}`))
          }
          try { resolve(JSON.parse(raw || '{}')) } catch { reject(new Error('invalid sidecar facade response')) }
        })
      })
      const timer = setTimeout(() => req.destroy(new Error('sidecar facade request timeout')), timeoutMs)
      req.once('close', () => clearTimeout(timer))
      req.on('error', reject)
      if (body !== undefined) req.end(JSON.stringify(body)); else req.end()
    })
  }

  /** 桌面→relay 主动推送（移动端镜像缓存）：复用隧道 sendJson(T.sync)。 */
  pushSync(payload) {
    return this.request('/tunnel/send', 'POST', payload)
  }

  async configure(config) {
    // 换地址那一发要等新隧道注册，比默认 5s 久（见 CONFIGURE_TIMEOUT_MS）。
    return this.request('/configure', 'POST', config, CONFIGURE_TIMEOUT_MS)
  }

  async stop() {
    const child = this.child
    this.child = null
    this.port = null
    if (!child) return
    await new Promise(resolve => {
      let settled = false
      const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve() } }
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish() }, 1500)
      child.once('exit', finish)
      child.kill('SIGTERM')
    })
  }
}

module.exports = { SidecarFacade }
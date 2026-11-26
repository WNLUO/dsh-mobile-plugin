// 主动重连复用进程和LAN，先等待最新配置；完整重启仍覆盖退出与超时边界。
// 2026-11-26 需求变更：用户要求顶栏三颗按钮从前端撤掉，重启逻辑与路由都保留。
// 重启测试假体提供即时状态回写，覆盖重启后的 LAN 入口公布。
'use strict'

// 钉住 sidecar 自重启。
//
// sidecar worker 是本插件 fork 出去的子进程，代码完全由磁盘决定，re-fork 一次就是新的 ——
// 这一层从来不需要重启 DSH 宿主。facade 自己跑在宿主进程里，re-fork 换不掉，所以重启时
// 额外把本包 lib/ 从 require 缓存里摘掉再 require。
//
// 这组测试同时钉住那条**边界**：`/api/relay/status` 必须如实上报
// `scope.host === 'needs-host-restart'`。宿主侧模块（lib/index.js、lib/client.js、
// lib/mobile/*）已经挂在 fiber 上，摘不掉。假装「重启了等于全生效」会让人在改完宿主侧代码后
// 以为不用重启，然后对着旧行为找半天原因。

const { test } = require('node:test')
const Module = require('node:module')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { randomBytes } = require('node:crypto')

const PKG_DIR = path.join(__dirname, '..')
// sidecar 的起停、配置下发、自重启、健康轮询都已抽到 lib/sidecar-lifecycle.cjs；
// lib/impl.js 只剩装配（建 lifecycle、挂两个 ctx.effect、注册路由）。
const LIFECYCLE = path.join(PKG_DIR, 'lib', 'sidecar-lifecycle.cjs')
const CLIENT = path.join(PKG_DIR, 'lib', 'client.js')

const read = (file) => fs.readFileSync(file, 'utf8')

test('restart-sidecar 路由注册在 localOnly 守卫后面', () => {
  // 控制面路由已抽到 lib/routes/control-plane.js。
  const src = read(path.join(__dirname, '..', 'lib', 'routes', 'control-plane.js'))
  const at = src.indexOf("path: '/api/relay/restart-sidecar'")
  assert.notEqual(at, -1, '应注册 POST /api/relay/restart-sidecar')
  // localOnly 在同一行的 handler 位置，不在 path 之前。
  const lineEnd = src.indexOf('\n', at)
  assert.match(src.slice(at, lineEnd), /localOnly\('POST'/, '重启是本机运维动作，必须过 localOnly 守卫')
})

test('sidecar 实例是 let，重启才换得掉', () => {
  const src = read(LIFECYCLE)
  assert.match(src, /let sidecar = new SidecarFacade\(/, 'sidecar 必须是 let，否则换实例后调用点还握着旧的')
  // 换实例的前提是没人把 facade 的方法/引用提前摘出来存进别的 const。
  assert.doesNotMatch(
    src,
    /const\s+\{[^}]*\}\s*=\s*sidecar\b|const\s+\w+\s*=\s*sidecar\./,
    '有人把 sidecar 的成员摘进别的 const，自重启会漏掉那些调用点',
  )
})

test('自重启不读失效的 ctx.webServer，端口在构造时缓存', () => {
  const src = read(LIFECYCLE)
  // 换代后旧 context 已 inactive，重启时再读 ctx.webServer 会抛错，导致 TCP/P2P 都起不来。
  assert.match(src, /const parentPort = ctx\.webServer\.port/, '父进程端口构造时取一次');
  assert.doesNotMatch(src, /new (?:SidecarFacade|Fresh)\(\{ parentPort: ctx\.webServer\.port/, '重启不许再读 ctx.webServer');
  assert.match(src, /new Fresh\(\{ parentPort,/, '重启用缓存的端口');
})

test('status 如实上报重启范围，不把宿主侧模块说成可重启', () => {
  // status 视图已挪到 lib/relay/status.js：重启范围是它如实上报的，别再盯 index.js。
  const src = read(path.join(__dirname, '..', 'lib', 'relay', 'status.js'))
  assert.match(src, /worker:\s*'restartable'/, 'worker 应标为可重启')
  assert.match(src, /facade:\s*'restartable'/, 'facade 靠清 require 缓存重载，应标为可重启')
  assert.match(src, /host:\s*'needs-host-restart'/, '宿主侧模块摘不掉，必须标为需要重启宿主')
})

test('重启失败要留痕，不能悄悄成功', () => {
  const src = read(LIFECYCLE)
  assert.match(src, /sidecarRestartError/, '失败原因要记下来给状态接口和设置页看')
  // 起不来就把状态留在 error：后续 /tunnel/send 会明确报 facade 没跑，而不是
  // 继续用 503 装作「隧道没连上」。
  assert.match(
    src,
    /sidecarState = `error: \$\{sidecarRestartError\}`/,
    '重启失败时 sidecar 状态必须变成 error',
  )
})

test('并发重启必须串行，否则两次重启会互相 stop 掉对方刚起的 worker', () => {
  const src = read(LIFECYCLE)
  assert.match(src, /if \(restartInFlight\) return restartInFlight/, '重启要串行化')
  assert.match(src, /restartInFlight = null[\s\S]*?\}\)\(\)\n\s*return restartInFlight/, 'finally 里必须清掉 in-flight 标记')
})

test('重启按钮在控制台顶栏，失败时在界面上显式标红', () => {
  // 从 0.1.48 起界面搬进宿主吐的网页（React/）；2026-10 又撤掉「插件更新」那张卡，设置项
  // 只剩一个网页入口。**2026-11-24 用户要求**：重启与检查更新从更新卡挪到控制台顶栏，
  // 做成图标按钮。按钮的 JSX 与文案仍留在更新卡里（借 portal 画到顶栏），所以断言钉的是
  // 「更新卡里有字典键 + 顶栏有落脚点」，别把守卫删掉 —— 它管的是「界面上必须能触发重启，
  // 而且失败必须看得见」。
  // 宿主面一点没变：路由还在，只是页面不再由 lib/client.js 画。
  const routes = read(path.join(PKG_DIR, 'lib', 'routes', 'control-plane.js'))
  assert.match(routes, /'\/api\/relay\/restart-sidecar'/, '宿主仍要提供重启路由')
  const app = read(path.join(PKG_DIR, 'React', 'src', 'Console.tsx'))
  assert.match(app, /apiPost<\{ status: StatusView \}>\('\/api\/relay\/restart-sidecar'\)/, '网页版要能触发重启')
  assert.match(app, /<Alert variant="error">/, '重启失败要在界面上显式标红')
  // 2026-10-24 海外发布这轮把面板**整页**国际化了（正是 2026-10-11 说的「要国际化就整页
  // 一起做」）：文案搬进 `React/src/lib/i18n/messages/`，组件里只留键。所以这条断言改成
  // 钉「那颗按钮用的是字典键」，原话在 `panel.update.restartSidecar` 里（五门语言各一份）。
  const card = read(path.join(PKG_DIR, 'React', 'src', 'components', 'UpdateCard.tsx'))
  assert.ok(card.includes('panel.update.restartSidecar'), '图标按钮的文案要来自字典（重启 sidecar 那条键）')
  // 2026-11-26 需求变更：用户要求顶栏按钮从前端撤掉，重启的逻辑与这条路由都保留。
  const panel = read(path.join(PKG_DIR, 'React', 'src', 'Console.tsx'))
  assert.doesNotMatch(panel, /setUpdateActionsSlot/, '顶栏不再给更新按钮留落脚点')
  assert.equal(
    fs.existsSync(path.join(PKG_DIR, 'React', 'src', 'lib', 'i18n.ts')),
    false,
    '旧的单文件字典已经删掉了；现在的字典在 lib/i18n/ 目录里，别把那个单文件加回来',
  )
  // 「可重启范围 / 已重启次数」那段说明按用户要求删掉了。宿主面的事实没变
  // （/api/relay/status 仍把 worker/facade 标成 restartable、host 标成 needs-host-restart），
  // 只是页面不再把它写出来 —— 别顺手把那段文案加回来。
  const src = read(CLIENT)
  assert.equal(/restartScopeBody:/.test(src), false, '设置页不再写「可重启范围」那段说明')
  // CSS 类不能只写不定义——没有定义的类名在界面上会静默退化成无样式的行。
  // 现在这一半只有两样东西：侧边栏那颗图标（宽条 / 窄条）与它点出来的诊断弹窗。
  // 图标是 react 元素（`className: '…'`），弹窗是命令式 DOM（`className = '…'` 与
  // `make(tag, '…')`），三种写法都要收进来，否则漏掉一个类名不会有任何测试红。
  const used = new Set()
  const addTokens = (value) => {
    for (const token of String(value).split(/\s+/)) if (token.startsWith('dshm_')) used.add(token)
  }
  for (const m of src.matchAll(/className:\s*'([^']+)'/g)) addTokens(m[1])
  for (const m of src.matchAll(/className = '([^']+)'/g)) addTokens(m[1])
  for (const m of src.matchAll(/make\('[a-z]+', '([^']+)'/g)) addTokens(m[1])
  assert.ok(used.has('dshm_footAction'), '图标的类名要在')
  assert.ok(used.has('dshm_overlay') && used.has('dshm_dialog'), '诊断弹窗的类名要在')
  for (const token of used) {
    assert.ok(new RegExp(`\\.${token}\\{`).test(src), `${token} 被用了却没有样式`)
  }
  assert.equal(/\.dshm_noteBad\{/.test(src), false, 'dshm_noteBad 只属于撤掉的更新卡片，样式该一起删')
})

test('中英文案键完全对齐', () => {
  const src = read(CLIENT)
  // 按大括号配平切出字典本体。直接切到 en 块末尾会把后面别的对象
  // （表单字段之类）的键也算进来，报出 name/lanEnabled 这种假差异。
  const blockAt = (marker) => {
    const start = src.indexOf(marker) + marker.length - 1
    let depth = 0
    for (let i = start; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1
      else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1) }
    }
    throw new Error(`${marker} 的大括号没配平`)
  }
  const keys = (block) => {
    const out = new Set()
    for (const m of block.matchAll(/^\s{8}([A-Za-z0-9_]+):/gm)) out.add(m[1])
    return out
  }
  const zh = keys(blockAt('zh: {'))
  const en = keys(blockAt('en: {'))
  const missing = [...zh].filter((k) => !en.has(k))
  const extra = [...en].filter((k) => !zh.has(k))
  assert.deepEqual(missing, [], `en 缺这些键: ${missing.join(', ')}`)
  assert.deepEqual(extra, [], `en 多了这些键: ${extra.join(', ')}`)
  // 键配平是兜底；再点几个这一半**真的在用**的键，防止有人把字典清空后配平照样通过。
  // （restartSidecar/restartFailed 随重启按钮搬去网页版了，网页版的文案是直接写死的中文，
  // 不走这套字典 —— 所以那两个键不再要求出现在这里。）
  for (const k of ['footerOpen', 'footerPending', 'footerLoadMissing', 'diagTitleLoad', 'diagCopy']) {
    assert.ok(zh.has(k) && en.has(k), `${k} 应中英都有`)
  }
})

// ── 行为面：跑 lib/sidecar-lifecycle.cjs 里的**真** restartSidecar ─────────
//
// 上一版这里栽了跟头：测试是照着 restartSidecar 的逻辑**重演一遍**，结果验的是
// 测试自己写的 require.resolve 路径，不是生产代码里那条。真代码写成了
// require('../sidecar-facade.cjs')（从 lib/ 出发 ../ 是包根目录，那里没这文件），
// 线上直接 worker exited 1、服务整个停摆，而测试一路绿灯。
//
// 现在改成把真源码抠出来 eval，并且注入一个**锚在生产文件上**的 require：
// 相对路径怎么解析跟生产环境完全一致，写错路径在测试里就会以同样的方式失败。
const LIB = path.join(PKG_DIR, 'lib')

const waitUntil = async (fn, what) => {
  for (let i = 0; i < 100; i += 1) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`超时：${what}`)
}

function reconnectHarness(mutate = source => source) {
  const source = mutate(read(LIFECYCLE))
  const from = source.indexOf('  const reconnectTunnel = async () => {')
  const to = source.indexOf('  // ── sidecar 自重启', from)
  assert.ok(from > 0 && to > from)
  const calls = [], applied = []
  let release, reject, followup
  const configured = new Promise((resolve, fail) => { release = resolve; reject = fail })
  const snapshot = { tunnel: { state: 'connecting' }, lan: { state: 'listening', port: 18787 } }
  const deps = { calls, applied, snapshot, configured, followup: () => followup }
  const factory = new Function('deps', `
    let started = true, syncInFlight = null, sidecarSnapshot = {}, stateFromPoll = true, sidecarState = 'off'
    const syncSidecar = async () => { deps.calls.push('sync'); await deps.configured; syncInFlight = deps.followup(); if (syncInFlight) void syncInFlight.then(() => { syncInFlight = null }) }
    let sidecar = { child: {}, request: async (...args) => { deps.calls.push(args); return deps.snapshot } }
    const applyTunnelState = value => deps.applied.push(value)
    ${source.slice(from, to)}
    return { reconnectTunnel, stop: () => { started = false }, state: () => ({sidecarSnapshot,stateFromPoll,sidecarState}) }
  `)
  return { ...factory(deps), calls, applied, snapshot, release, reject, setFollowup: value => { followup = value } }
}
async function reconnectContract(mutate) {
  const h = reconnectHarness(mutate)
  let finishFollowup
  const followup = new Promise(resolve => { finishFollowup = resolve })
  h.setFollowup(followup)
  const pending = h.reconnectTunnel()
  assert.deepEqual(h.calls, ['sync'])
  h.release(); await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(h.calls, ['sync'], '合并的新配置未完成前不重连')
  // 生产的finally会清syncInFlight；假体也让等待下一轮时读到完成事实。
  h.setFollowup(null); finishFollowup()
  const result = await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('reconnect did not finish')), 1000))])
  assert.deepEqual(h.calls[1], ['/reconnect', 'POST'])
  assert.equal(h.calls.length, 2, '没有stop/start进程或LAN操作')
  assert.equal(result, h.snapshot)
  assert.equal(h.state().sidecarSnapshot.tunnel.state, 'connecting')
  assert.equal(h.applied.length, 1)
  const failed = reconnectHarness()
  const rejected = assert.rejects(failed.reconnectTunnel(), /configuration failed/)
  failed.reject(new Error('configuration failed')); await rejected
  assert.equal(failed.calls.length, 1, '配置失败不能执行重连')
  const stopped = reconnectHarness(); stopped.stop()
  await assert.rejects(stopped.reconnectTunnel(), /sidecar stopped/)
  assert.equal(stopped.calls.length, 0)
}
test('主动重连等待配置和合并配置，再用同进程独立动作回写真实快照', () => reconnectContract())
test('变异：主动重连不调用独立worker动作会被行为断言拒绝', async () => {
  await assert.rejects(reconnectContract(source => {
    const changed = source.replace("await current.request('/reconnect', 'POST')", 'await Promise.resolve({})')
    assert.notEqual(changed, source, '变异必须命中真实重连调用')
    return changed
  }), assert.AssertionError)
})

const extractRestartBlock = () => {
  const src = read(LIFECYCLE)
  const from = src.indexOf('  const pluginLibDirPrefix =')
  const to = src.indexOf('  // ── 健康轮询', from)
  assert.ok(from > 0 && to > from, '应能在 lib/sidecar-lifecycle.cjs 里定位到重启代码块')
  return src.slice(from, to)
}

const buildRestartHarness = (deps) => {
  const body = extractRestartBlock()
  const factory = new Function('deps', `
    const { require, ctx, sidecarToken, syncSidecar } = deps
    // 生产代码在 createSidecarLifecycle 构造期缓存父端口，重启块直接用它；这里补上同一份。
    const parentPort = ctx.webServer.port
    // 被抠出来的块产自 lib/sidecar-lifecycle.cjs，里面的 __dirname 指的是 lib/；
    // path 也来自那个模块顶部的 require('node:path')，块里要用 path.sep。
    const __dirname = deps.pluginLibDir
    const path = require('node:path')
    // 阶段 A 起 pluginLibDir 走可变 providers（外壳持有时换代更新）；块里读它。
    const providers = { pluginLibDir: deps.pluginLibDir }
    let sidecar = deps.sidecar
    let sidecarState = 'starting'
    let sidecarSnapshot = { tunnel: { state: 'off', error: null }, lan: { state: 'off', error: null } }
    let sidecarRestarts = 0, sidecarRestartedAt = 0, sidecarRestartError = null, restartInFlight = null
    let started = true, sidecarExitError = null
    // 与 lib/sidecar-lifecycle.cjs 里那个同义：facade 交上来的 onDown 回调。
    const applyTunnelState = (message) => { if (message.lan) sidecarSnapshot.lan = message.lan }
    const markSidecarDown = (error) => {
      const message = error instanceof Error ? error.message : String(error)
      sidecarState = 'error: ' + message
      sidecarSnapshot = { tunnel: { state: 'off', error: message }, lan: { state: 'off', error: message } }
    }
    const handleSidecarExit = markSidecarDown
${body}
    return {
      restartSidecar,
      purge: purgePluginLibCache,
      // 要交出当前 facade：重启会换掉 sidecar 变量，只 stop 最初那一个的话，
      // 重启后的 worker 会一直活着，teardown 永远等不到 wss.close() 返回。
      current: () => sidecar,
      stats: () => ({ restarts: sidecarRestarts, state: sidecarState, error: sidecarRestartError, restartedAt: sidecarRestartedAt }),
    }
  `)
  return factory(deps)
}

test('生命周期模块默认目录能解析到 facade，重启从当前代目录加载', () => {
  const anchored = Module.createRequire(LIFECYCLE)
  assert.equal(typeof anchored(path.join(LIB, 'sidecar-facade.cjs')).SidecarFacade, 'function')
  assert.match(extractRestartBlock(), /require\(path\.join\(providers\.pluginLibDir, 'sidecar-facade\.cjs'\)\)/)
})

test('真跑一遍 restartSidecar：worker 换新、隧道自己接回来', { timeout: 60_000 }, async (t) => {
  const { SidecarFacade } = require('../lib/sidecar-facade.cjs')
  const { T, jsonFrame } = require('../lib/relay/protocol.js')
  const { WebSocketServer } = require('ws')

  const token = randomBytes(32).toString('hex')
  // 假中转：注册握手必须真的完成，否则 worker 里的隧道起不来，重启后自然也就是
  // disconnected —— 那测的是「起不来」而不是「重启」。
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  wss.on('connection', (ws) => {
    ws.on('message', () => {})
    setTimeout(() => ws.send(jsonFrame(T.registered, 0, {})), 30)
  })
  await new Promise((resolve) => wss.once('listening', resolve))
  const relayPort = wss.address().port

  const parent = http.createServer((_req, res) => res.end('ok'))
  await new Promise((resolve) => parent.listen(0, '127.0.0.1', resolve))
  const parentPort = parent.address().port

  const baseConfig = () => ({
    enabled: true,
    relayUrl: `http://127.0.0.1:${relayPort}`,
    instanceId: 'i1',
    pairingCode: '123456',
    name: 'Test',
    upstreamPort: relayPort,
    lanPort: 18787,
    lanEnabled: false,
    lanSecret: randomBytes(32).toString('hex'),
  })

  const waitFor = async (fn, what) => {
    for (let i = 0; i < 100; i += 1) {
      const v = await fn()
      if (v) return v
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`超时：${what}`)
  }

  let harness = null
  const first = new SidecarFacade({ parentPort, token })
  harness = buildRestartHarness({
    // 锚在 lib/sidecar-lifecycle.cjs 上，路径解析与生产完全一致。
    require: Module.createRequire(LIFECYCLE),
    pluginLibDir: LIB,
    ctx: { webServer: { port: parentPort } },
    sidecarToken: token,
    sidecar: first,
    // 只能通过 harness.current() 拿 facade：重启会把 sidecar 变量换掉，写死 first
    // 等于给一个已经 stop 掉的对象 configure，startTunnel() 永远等不到配置。
    syncSidecar: async () => { await harness.current().configure(baseConfig()) },
  })

  t.after(async () => {
    await first.stop()
    if (harness) await harness.current().stop()
    // 先掐连接再 close：wss.close() 会等所有 client 自己断开，而 worker 那边还在
    // 等心跳，整套 teardown 能拖到一分半钟。terminate 掉就干净了。
    for (const client of wss.clients) client.terminate()
    await new Promise((resolve) => wss.close(resolve))
    await new Promise((resolve) => parent.close(resolve))
  })

  await first.start()
  // 必须先 configure：startTunnel() 在没有 relayUrl / upstreamPort 时直接早退，
  // 隧道压根不会起 —— 那测的就不是「重启前后都通」而是「压根没通」。
  await first.configure(baseConfig())
  await waitFor(async () => (await first.request('/status')).tunnel.state === 'connected', '重启前隧道应连上')
  const portBefore = first.port
  assert.ok(portBefore, 'worker 应当已就绪')

  const r1 = await harness.restartSidecar()
  assert.equal(r1.ok, true, `第一次重启应成功，实际：${r1.error}`)
  assert.ok(r1.purgedModules >= 1, '应当至少清掉 facade 自己的缓存')
  assert.equal(harness.stats().restarts, 1)

  const reloaded = await waitFor(
    async () => {
      const s = await harness.current().request('/status').catch(() => null)
      return s && s.tunnel.state === 'connected' ? s : null
    },
    '重启后隧道应自己接回来',
  )
  assert.equal(reloaded.tunnel.state, 'connected')
  assert.equal(harness.stats().state, 'healthy')
  assert.equal(harness.stats().error, null)

  // 再重启一次：这一条验的是「可重复」——真机上第一次成功不代表第二次不会
  // 把自己 stop 掉之后再也起不来。
  const r2 = await harness.restartSidecar()
  assert.equal(r2.ok, true, `第二次重启应成功，实际：${r2.error}`)
  assert.equal(harness.stats().restarts, 2)
  await waitFor(
    async () => {
      const s = await harness.current().request('/status').catch(() => null)
      return s && s.tunnel.state === 'connected'
    },
    '第二次重启后隧道仍应连上',
  )
})

// ── worker 死了，状态不许冻在最后一帧 ────────────────────────────────────────
//
// 现场（0.1.12）：worker exited 1 之后，/api/relay/status 里 tunnel 仍是
// connected、lan 仍是 listening，而 0.0.0.0:lanPort 上早就没人监听了。宿主于是
// 照着「隧道是通的」继续推镜像，一路 503。根因是宿主那份 10s 健康轮询的
// catch 是空的：打不通就吞掉，sidecarSnapshot 永远停在最后一次成功的那一帧。
test('worker 意外退出：立刻报 off 并说清原因，不再冻在最后一帧', async () => {
  const { SidecarFacade } = require('../lib/sidecar-facade.cjs')
  const parent = http.createServer((_req, res) => res.end('ok'))
  await new Promise((resolve) => parent.listen(0, '127.0.0.1', resolve))

  const downs = []
  const facade = new SidecarFacade({
    parentPort: parent.address().port,
    token: randomBytes(32).toString('hex'),
    onDown: (error) => downs.push(error),
  })
  try {
    await facade.start()
    assert.ok(facade.port, 'worker 应当已就绪')

    facade.child.kill('SIGKILL')
    await waitUntil(() => downs.length > 0, '应当收到 onDown 回调')

    assert.match(downs[0].message, /sidecar facade (exited|killed by)/, `onDown 应当说清退出原因，实际：${downs[0].message}`)
    assert.equal(facade.port, null, '端口必须清掉：留着它会对着没人监听的端口发，报出天书般的 ECONNREFUSED')
    await assert.rejects(() => facade.request('/status'), /sidecar facade is not running/, 'worker 没了就该直说没了')
  } finally {
    await facade.stop()
    await new Promise((resolve) => parent.close(resolve))
  }
})

test('主动 stop() 不算掉线，不该触发 onDown', async () => {
  const { SidecarFacade } = require('../lib/sidecar-facade.cjs')
  const parent = http.createServer((_req, res) => res.end('ok'))
  await new Promise((resolve) => parent.listen(0, '127.0.0.1', resolve))
  let downs = 0
  const facade = new SidecarFacade({
    parentPort: parent.address().port,
    token: randomBytes(32).toString('hex'),
    onDown: () => { downs += 1 },
  })
  try {
    await facade.start()
    await facade.stop()
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(downs, 0, '主动 stop 是运维动作，不是掉线——否则每次重启都先把状态打成红色')
  } finally {
    await new Promise((resolve) => parent.close(resolve))
  }
})

test('宿主把 onDown 接到了两处 facade 构造上，健康轮询失败也不再吞异常', () => {
  const src = read(LIFECYCLE)
  // 两处 new SidecarFacade / new Fresh 都要交 onDown：漏一处，重启后崩了就没人报。
  const constructions = src.match(/new (SidecarFacade|Fresh)\(\{[^}]*\}\)/g) || []
  assert.ok(constructions.length >= 2, `应能找到两处 facade 构造，实际 ${constructions.length} 处`)
  for (const c of constructions) {
    assert.match(c, /onDown: handleSidecarExit/, `构造时必须交真实退出回调：${c}`)
  }
  // 健康轮询的 catch 必须调 markSidecarDown，不能是空的。
  const poll = src.slice(src.indexOf('healthTimer = setInterval'))
  assert.match(poll, /catch \(error\) \{[\s\S]*?markSidecarDown\(error\)/, '健康轮询失败必须把状态打回 off')
  assert.doesNotMatch(poll, /catch \{ \/\* ignore \*\/ \}/, '空的 catch 就是谎报的根源，不能再出现')
})

test('轮询自己写上去的 error 必须自愈，配置/重启失败的 error 不许被轮询抹掉', () => {
  const src = read(LIFECYCLE)
  const flat = (s) => s.replace(/\s+/g, ' ')
  // 一次回环 reset（worker 正在被换掉、socket 抖一下）只该红到下一次轮询为止。原来的
  // 写法只有失败分支会写状态、成功分支不回写，于是那行红字会一直挂到用户来点重启。
  const poll = flat(src.slice(src.indexOf('healthTimer = setInterval')))
  assert.match(
    poll,
    /if \(stateFromPoll\) \{ sidecarState = 'healthy'; stateFromPoll = false \}/,
    '轮询通了必须把轮询自己写上去的 error 抹回 healthy',
  )
  assert.match(
    flat(src.slice(src.indexOf('const markSidecarDown'))),
    /stateFromPoll = true/,
    'markSidecarDown 必须把这一格标记成「轮询自己写的」，成功分支才知道能不能抹',
  )
  // 「配置没生效」是另一回事：worker 活得好好的也照样是坏的，轮询不许顺手抹成 healthy。
  const apply = flat(src.slice(src.indexOf('const syncSidecar'), src.indexOf('const restartSidecar')))
  assert.match(apply, /stateFromPoll = false sidecarState = `error:/, '下发配置失败必须标明「不是轮询写的」')
  const restart = flat(src.slice(src.indexOf('const restartSidecar'), src.indexOf('const onTunnelUp')))
  assert.match(restart, /stateFromPoll = false sidecarState = `error:/, '重启失败必须标明「不是轮询写的」')
})

test('首次起不来会自动重试一次，不用人点重启（Windows 冷启动撞上启动预算时）', () => {
  const src = read(LIFECYCLE)
  const botAt = src.indexOf('const boot = async () => {')
  assert.ok(botAt > 0, 'start() 里应有一段可重试的 boot —— 起一次就放弃等于把瞬态问题钉成永久故障')
  const block = src.slice(botAt, src.indexOf('void boot()', botAt))
  assert.match(block, /catch \(error\)/, 'boot 必须接住首次启动失败，才有机会重试')
  assert.match(block, /await restartSidecar\(\)/, '首次起不来要自动重启一次（restartSidecar 负责重新 fork 并重下发配置）')
})

const flushLifecycle = () => new Promise(setImmediate)
function lifecycleFixture(mutate = source => source) {
  const calls = { start: 0, stop: 0, configure: 0, loaded: [], requests: [], configs: [] }
  const instances = []
  const polls = []
  const behavior = { startError: null, requestError: null, startWait: null, configureError: null, onlyOldConfigureError: false, configureWait: null, reconnectWait: null }
  const nextLib = path.join(PKG_DIR, '.test-next', 'lib')
  class FakeFacade {
    constructor(options) { this.options = options; this.running = false; instances.push(this) }
    async start() {
      calls.start += 1
      if (behavior.startWait) await behavior.startWait
      if (behavior.startError) throw new Error(behavior.startError)
      this.running = true
      this.child = {}
    }
    async stop() { calls.stop += 1; this.running = false; this.child = null }
    async configure(config) {
      calls.configure += 1
      calls.configs.push(config)
      if (behavior.configureWait) await behavior.configureWait
      if (behavior.configureError && (!behavior.onlyOldConfigureError || this === instances[0])) throw new Error(behavior.configureError)
      return { tunnel: { state: 'connected' }, lan: { state: 'listening', port: 18787 } }
    }
    async request(route, method) {
      calls.requests.push([route, method])
      if (behavior.requestError) throw new Error(behavior.requestError)
      if (!this.running) throw new Error('sidecar facade is not running')
      if (route === '/reconnect' && behavior.reconnectWait) return await behavior.reconnectWait
      return { tunnel: { state: route === '/reconnect' ? 'connecting' : 'connected' }, lan: { state: 'listening', port: 18787 } }
    }
    exit(message) { this.running = false; this.options.onDown(new Error(message)) }
  }
  const anchored = Module.createRequire(LIFECYCLE)
  const localRequire = name => {
    if (name === './sidecar-facade.cjs' || name === path.join(nextLib, 'sidecar-facade.cjs')) {
      calls.loaded.push(name)
      return { SidecarFacade: FakeFacade }
    }
    if (name === './relay/apply-ledger.cjs') return { recordSuccess() {}, recordFailure() {} }
    return anchored(name)
  }
  localRequire.cache = {}
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', '__dirname', 'setInterval', 'clearInterval', mutate(read(LIFECYCLE)))(
    localRequire, loaded, loaded.exports, LIB, fn => { polls.push(fn); return 1 }, () => {},
  )
  const lifecycle = loaded.exports.createSidecarLifecycle({
    ctx: { webServer: { port: 1234 } }, pluginLibDir: nextLib,
    resolveLanPort: async () => 18787, lanPortInUse: () => 18787,
    buildConfig: () => ({ lanPort: 18787, relayUrl: 'https://relay.example' }),
  })
  lifecycle.start()
  return { lifecycle, calls, instances, polls, behavior, nextLib }
}

async function assertCurrentGenerationRestart(mutate) {
  const h = lifecycleFixture(mutate)
  try {
    await flushLifecycle()
    assert.equal((await h.lifecycle.restartSidecar()).ok, true)
    assert.equal(h.calls.loaded.at(-1), path.join(h.nextLib, 'sidecar-facade.cjs'))
    assert.equal(h.calls.start, 2)
  } finally { await h.lifecycle.stop() }
}

async function assertReconnectGeneration(mode, mutate) {
  const h = lifecycleFixture(mutate)
  try {
    await flushLifecycle()
    let release
    h.behavior.reconnectWait = new Promise(resolve => { release = resolve })
    const pending = h.lifecycle.reconnectTunnel()
    const rejected = assert.rejects(pending, /sidecar changed during reconnect/)
    await flushLifecycle()
    assert.deepEqual(h.calls.requests.at(-1), ['/reconnect', 'POST'])
    if (mode === 'restart') await h.lifecycle.restartSidecar()
    else { await h.lifecycle.stop(); h.lifecycle.start(); await flushLifecycle() }
    const fresh = h.lifecycle.getSnapshot()
    release({ tunnel: { state: 'connected', marker: 'stale' }, lan: { state: 'off' } })
    await rejected
    assert.equal(h.lifecycle.getSnapshot(), fresh, '旧worker回执不得覆盖新代快照')
  } finally { await h.lifecycle.stop() }
}
test('主动重连在途遇重启或stop/start不得接受旧worker回执', async () => {
  await assertReconnectGeneration('restart')
  await assertReconnectGeneration('stop-start')
})
test('变异：回执只验started会被跨进程代次行为捕获', async () => {
  await assert.rejects(assertReconnectGeneration('restart', source => source.replaceAll(
    '!started || sidecar !== current || current.child !== child', '!started',
  )), assert.AssertionError)
})
test('主动重连等待同步时停止，不向停掉的worker发请求', async () => {
  const h = lifecycleFixture()
  try {
    await flushLifecycle()
    let release
    h.behavior.configureWait = new Promise(resolve => { release = resolve })
    const pending = h.lifecycle.reconnectTunnel()
    const rejected = assert.rejects(pending, /sidecar changed during reconnect/)
    await flushLifecycle(); await h.lifecycle.stop(); release()
    await rejected
    assert.equal(h.calls.requests.some(([route]) => route === '/reconnect'), false)
  } finally { await h.lifecycle.stop() }
})
test('热换代旧生命周期只在明确缺动作时升级worker，普通失败不重启', async () => {
  const { createTunnelReconnector } = require('../lib/sidecar-lifecycle.cjs')
  const calls = [], first = { child: {} }
  let current = first, started = true, fail = 'sidecar facade request failed: 404 (not found)'
  first.configure = async config => { calls.push(['configure', config]) }
  first.request = async () => { calls.push('request'); if (fail) throw new Error(fail); return { tunnel: { state: 'connecting' } } }
  const lifecycle = { isStarted: () => started, getSidecar: () => current, syncSidecar: async () => { calls.push('sync') },
    restartSidecar: async () => { calls.push('restart'); current = { child: {} }; return { ok: true } },
    getSnapshot: () => ({ tunnel: { state: 'connecting' } }) }
  const reconnect = createTunnelReconnector(lifecycle, async () => ({ relayUrl: 'latest' }))
  assert.equal((await reconnect()).tunnel.state, 'connecting')
  assert.deepEqual(calls, ['sync', ['configure', { relayUrl: 'latest' }], 'request', 'restart'])
  current = first; calls.length = 0; fail = 'sidecar facade request timeout'
  await assert.rejects(reconnect(), /request timeout/)
  assert.equal(calls.includes('restart'), false)
  started = false; await assert.rejects(reconnect(), /sidecar stopped/)
})

test('手动重启从 providers 当前代加载 facade，不回到外壳启动目录', async () => {
  await assertCurrentGenerationRestart()
})

async function assertRuntimeExitRecovers(mutate) {
  const h = lifecycleFixture(mutate)
  try {
    await flushLifecycle()
    h.instances[0].exit('sidecar facade exited 7')
    assert.match(h.lifecycle.getState(), /exited 7/)
    await flushLifecycle()
    assert.equal(h.calls.start, 2, '真实退出后应自动启动一次')
    assert.equal(h.calls.configure, 2, '恢复后必须重新下发配置')
    assert.equal(h.lifecycle.getState(), 'healthy')
    h.instances.at(-1).exit('sidecar facade exited 8')
    await flushLifecycle()
    for (let i = 0; i < 3; i += 1) await h.polls[0]()
    assert.equal(h.calls.start, 2, '同一次运行最多自动恢复一次，避免退出循环')
    assert.match(h.lifecycle.getState(), /exited 8/, '后续轮询不得把退出原因盖成 not running')
  } finally { await h.lifecycle.stop() }
}

test('运行中真实退出只恢复一次，再退出保留真实原因', async () => {
  await assertRuntimeExitRecovers()
})

async function assertRejectedConfigRecovers(mutate) {
  const h = lifecycleFixture(mutate)
  try {
    await flushLifecycle()
    h.behavior.configureError = 'sidecar facade request failed: 503 (unknown configuration field)'
    h.behavior.onlyOldConfigureError = true
    await h.lifecycle.syncSidecar()
    assert.equal(h.calls.start, 2, '旧进程明确拒绝新字段时更换一次')
    assert.equal(h.calls.loaded.at(-1), path.join(h.nextLib, 'sidecar-facade.cjs'))
    assert.equal(h.lifecycle.getState(), 'healthy')
    await h.lifecycle.syncSidecar()
    assert.equal(h.calls.start, 2, '新进程接受配置后不再重复更换')
  } finally { await h.lifecycle.stop() }
}

test('旧 worker 拒绝新配置时从当前代恢复，不等待自身同步也不重复重启', async () => {
  await assertRejectedConfigRecovers()
})

test('配置错误只在明确的旧字段拒绝时恢复，新进程仍拒绝就报错', async () => {
  const h = lifecycleFixture()
  try {
    await flushLifecycle()
    h.behavior.configureError = 'invalid lanPort'
    await assert.rejects(h.lifecycle.syncSidecar(), /invalid lanPort/)
    assert.equal(h.calls.start, 1)
    h.behavior.configureError = 'unknown configuration field'
    await assert.rejects(h.lifecycle.syncSidecar(), /unknown configuration field/)
    assert.equal(h.calls.start, 2, '新进程同样拒绝时本次不得无限重启')
  } finally { await h.lifecycle.stop() }
})

test('变异：去掉旧配置拒绝后的恢复会被同一行为断言发现', async () => {
  await assert.rejects(assertRejectedConfigRecovers(source => source.replace(
    'started && !restartInFlight && /unknown configuration field/', 'false && /unknown configuration field/',
  )), /unknown configuration field/)
})

test('普通请求超时不算退出，也不会启动新 worker', async () => {
  const h = lifecycleFixture()
  try {
    await flushLifecycle()
    h.behavior.requestError = 'sidecar facade request timeout'
    await h.polls[0]()
    await flushLifecycle()
    assert.equal(h.calls.start, 1)
    assert.match(h.lifecycle.getState(), /request timeout/)
    h.behavior.requestError = null
    await h.polls[0]()
    assert.equal(h.lifecycle.getState(), 'healthy')
  } finally { await h.lifecycle.stop() }
})

test('恢复已经开始时 stop 不会留下新 worker', async () => {
  const h = lifecycleFixture()
  await flushLifecycle()
  let release
  h.behavior.startWait = new Promise(resolve => { release = resolve })
  h.instances[0].exit('sidecar facade exited 9')
  await flushLifecycle()
  assert.equal(h.calls.start, 2)
  await h.lifecycle.stop()
  release()
  await flushLifecycle()
  assert.equal(h.instances.at(-1).running, false)
  assert.equal(h.calls.configure, 1, '停止期间恢复出来的进程不许继续 configure')
  const starts = h.calls.start
  h.instances.at(-1).exit('sidecar facade exited 0')
  await flushLifecycle()
  assert.equal(h.calls.start, starts, '停止后真实退出也不许复活')
})

test('自动恢复失败后轮询仍保留原退出码', async () => {
  const h = lifecycleFixture()
  try {
    await flushLifecycle()
    h.behavior.startError = 'startup timeout'
    h.instances[0].exit('sidecar facade exited 13')
    await flushLifecycle()
    await h.polls[0]()
    assert.equal(h.calls.start, 2)
    assert.match(h.lifecycle.getState(), /exited 13/)
    assert.match(h.lifecycle.getRestartError(), /exited 13.*startup timeout/)
  } finally { await h.lifecycle.stop() }
})

test('变异：旧目录重启和删掉退出恢复都会被同一行为断言拒绝', async () => {
  await assert.rejects(assertCurrentGenerationRestart(source => source.replace(
    "require(path.join(providers.pluginLibDir, 'sidecar-facade.cjs'))", "require('./sidecar-facade.cjs')",
  )), { name: 'AssertionError' })
  await assert.rejects(assertRuntimeExitRecovers(source => source.replace(
    'started ? restartSidecar() : undefined', 'undefined',
  )), { name: 'AssertionError' })
})

test('启动超时给足冷启动预算，且超时要收掉子进程（不留占端口的孤儿）', () => {
  const src = read(path.join(PKG_DIR, 'lib', 'sidecar-facade.cjs'))
  const m = src.match(/const STARTUP_TIMEOUT_MS = ([\d_]+)/)
  assert.ok(m, '启动超时要是一个具名常量，别再写死 5000 —— 那对 Windows 冷启动太紧')
  const ms = Number(m[1].replace(/_/g, ''))
  assert.ok(ms >= 15000, `启动预算要留够 Windows 冷启动，当前只有 ${ms}ms`)
  assert.match(src, /if \(this\.child === child\) await this\.stop\(\)/, '启动失败必须等停止流程回收子进程，不能边重启边留下旧监听')
})

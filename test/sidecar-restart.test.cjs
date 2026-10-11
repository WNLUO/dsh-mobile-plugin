'use strict'

// 钉住 sidecar 自重启。
//
// 为什么需要它：sidecar worker 是本插件 fork 出去的子进程，代码完全由磁盘决定，
// re-fork 一次就是新的——这一层从来不需要重启 DSH 宿主。facade 自己跑在宿主进程里，
// re-fork 换不掉，所以重启时额外把本包 lib/ 从 require 缓存里摘掉再 require。
//
// 这组测试同时钉住那条**边界**：`/api/relay/status` 必须如实上报
// `scope.host === 'needs-host-restart'`。宿主侧模块（lib/index.js、lib/client.js、
// lib/mobile/*）已经挂在 fiber 上，摘不掉。假装「重启了等于全生效」会让人在
// 改完宿主侧代码后以为不用重启，然后对着旧行为找半天原因。

const { test } = require('node:test')
const Module = require('node:module')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { randomBytes } = require('node:crypto')

const PKG_DIR = path.join(__dirname, '..')
// sidecar 的起停、配置下发、自重启、健康轮询都已抽到 lib/sidecar-lifecycle.cjs；
// lib/impl.js 只剩装配（建 lifecycle、挂两个 ctx.effect、注册路由）。lib/index.js 自
// 「热替换」起是稳定外壳，连装配都不在了。
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

test('重启按钮在网页版设置页里，失败时在界面上显式标红', () => {
  // 从 0.1.48 起界面搬进宿主吐的网页（React/）；2026-10 又撤掉「插件更新」那张卡，设置项
  // 只剩一个网页入口，但重启 sidecar 这个更轻的动作仍留在网页版那张卡片上。
  // 宿主面一点没变：路由还在，只是页面不再由 lib/client.js 画 —— 所以断言跟着搬家，
  // 别把这条守卫删掉（它钉的是「界面上必须能触发重启，而且失败必须看得见」）。
  const routes = read(path.join(PKG_DIR, 'lib', 'routes', 'control-plane.js'))
  assert.match(routes, /'\/api\/relay\/restart-sidecar'/, '宿主仍要提供重启路由')
  const app = read(path.join(PKG_DIR, 'React', 'src', 'App.tsx'))
  assert.match(app, /apiPost<\{ status: StatusView \}>\('\/api\/relay\/restart-sidecar'\)/, '网页版要能触发重启')
  assert.match(app, /<Alert variant="error">/, '重启失败要在界面上显式标红')
  // 2026-10-11 按用户要求删掉了面板的中英字典（`React/src/lib/i18n.ts`），文案回到组件里
  // 直接写中文 —— 所以这条断言跟着搬回组件上：按钮文案仍在，只是不再经过一层字典。
  const card = read(path.join(PKG_DIR, 'React', 'src', 'components', 'UpdateCard.tsx'))
  assert.ok(card.includes("'重启 sidecar'"), '网页版那颗按钮的中文文案要写在更新卡片里')
  assert.equal(
    fs.existsSync(path.join(PKG_DIR, 'React', 'src', 'lib', 'i18n.ts')),
    false,
    '字典已按用户要求删除，别把它加回来（要国际化就整页一起做）',
  )
  // 「可重启范围 / 已重启次数」那段说明按用户要求删掉了。宿主面的事实没变
  // （/api/relay/status 仍把 worker/facade 标成 restartable、host 标成 needs-host-restart），
  // 只是页面不再把它写出来 —— 别顺手把那段文案加回来。
  const src = read(CLIENT)
  assert.equal(/restartScopeBody:/.test(src), false, '设置页不再写「可重启范围」那段说明')
  // CSS 类不能只写不定义——没有定义的 className 在设置项上会静默退化成无样式的行。
  // 逐个数更结实：列死两个类名的话，加了新类却忘了写样式这种情况照样漏过去。
  const used = new Set()
  for (const m of src.matchAll(/className:\s*'([^']+)'/g)) {
    for (const token of m[1].split(/\s+/)) if (token.startsWith('dshm_')) used.add(token)
  }
  assert.ok(used.size >= 4, `设置项至少用到几个类名，实得 ${[...used].join(',')}`)
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
  for (const k of ['nav', 'cardPanel', 'openPanel', 'openHint', 'panelPending', 'loadFailed']) {
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

const extractRestartBlock = () => {
  const src = read(LIFECYCLE)
  const from = src.indexOf('  const PLUGIN_LIB_DIR =')
  const to = src.indexOf('  // ── 健康轮询', from)
  assert.ok(from > 0 && to > from, '应能在 lib/sidecar-lifecycle.cjs 里定位到重启代码块')
  return src.slice(from, to)
}

const buildRestartHarness = (deps) => {
  const body = extractRestartBlock()
  const factory = new Function('deps', `
    const { require, ctx, sidecarToken, syncSidecar } = deps
    // 被抠出来的块产自 lib/sidecar-lifecycle.cjs，里面的 __dirname 指的是 lib/；
    // path 也来自那个模块顶部的 require('node:path')，块里要用 path.sep。
    const __dirname = deps.pluginLibDir
    const path = require('node:path')
    let sidecar = deps.sidecar
    let sidecarState = 'starting'
    let sidecarSnapshot = { tunnel: { state: 'off', error: null }, lan: { state: 'off', error: null } }
    let sidecarRestarts = 0, sidecarRestartedAt = 0, sidecarRestartError = null, restartInFlight = null
    // 与 lib/sidecar-lifecycle.cjs 里那个同义：facade 交上来的 onDown 回调。
    const markSidecarDown = (error) => {
      const message = error instanceof Error ? error.message : String(error)
      sidecarState = 'error: ' + message
      sidecarSnapshot = { tunnel: { state: 'off', error: message }, lan: { state: 'off', error: message } }
    }
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

test('生命周期模块里的 require 路径能真的解析到 facade（上一版栽在这）', () => {
  // 单独钉一条：模块住在 lib/ 下，'./' 才是同目录，'../' 会跑到包根目录去。
  const src = read(LIFECYCLE)
  const m = src.match(/require\((['"])(\.[^'"]*sidecar-facade\.cjs)\1\)/)
  assert.ok(m, '应能找到 require sidecar-facade 的那一句')
  assert.equal(m[2], './sidecar-facade.cjs', `路径应为 './sidecar-facade.cjs'，实际是 '${m[2]}'（从 lib/ 出发 '../' 指向包根目录，那里没有这个文件）`)
  // 用锚在该模块上的 require 实际解析一次：写错的话这里直接抛。
  const anchored = Module.createRequire(LIFECYCLE)
  assert.equal(typeof anchored('./sidecar-facade.cjs').SidecarFacade, 'function')
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
    assert.match(c, /onDown: markSidecarDown/, `构造时必须交 onDown：${c}`)
  }
  // 健康轮询的 catch 必须调 markSidecarDown，不能是空的。
  const poll = src.slice(src.indexOf('const healthTimer = setInterval'))
  assert.match(poll, /catch \(error\) \{[\s\S]*?markSidecarDown\(error\)/, '健康轮询失败必须把状态打回 off')
  assert.doesNotMatch(poll, /catch \{ \/\* ignore \*\/ \}/, '空的 catch 就是谎报的根源，不能再出现')
})

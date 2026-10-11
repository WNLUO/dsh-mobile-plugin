// Source-contract tests for mirror push accounting and failure outcomes.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

// /api/relay/status 的 mirror 字段是判断「镜像是否还在更新」的唯一抓手。
// 曾出现两类谎报：后台队列推送完全不记账（明明在推、pushedAt 不动），
// 以及快照构建失败时静默 return（镜像已冻结却毫无信号）。
// 这里用源码契约把「所有推送路径都必须记账」钉死，防止再被绕开。
// 推送调度器已抽到 lib/mirror/pusher.cjs（index.js 只剩装配与两行 ctx.effect）。
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mirror', 'pusher.cjs'), 'utf8')

const countOf = (needle) => SOURCE.split(needle).length - 1

test('镜像推送只有一个出口，且该出口负责记账', () => {
  assert.equal(countOf('getSidecar().pushSync('), 1, '出现绕过记账的直接 pushSync 调用')
  const wrapper = SOURCE.indexOf('const pushMirrorPayload =')
  assert.notEqual(wrapper, -1, '缺少 pushMirrorPayload 包装')
  const callSite = SOURCE.indexOf('getSidecar().pushSync(')
  assert.ok(callSite > wrapper, 'pushSync 调用不在 pushMirrorPayload 内')
  assert.ok(SOURCE.includes('recordMirrorPush(false, error instanceof Error'), '包装器失败未记账')
  assert.ok(SOURCE.includes('recordMirrorPush(true, null)'), '包装器成功未记账')
})

test('镜像推送状态只在 recordMirrorPush 内写入', () => {
  const declaration = countOf('let mirrorPushAt =')
  assert.equal(declaration, 1, '缺少 mirrorPushAt 声明')
  const assignments = countOf('mirrorPushAt =') - declaration
  assert.equal(assignments, 1, 'mirrorPushAt 被多处直接赋值，状态可被绕过')
  assert.ok(SOURCE.includes('const recordMirrorPush = (ok, error) => {'), '缺少 recordMirrorPush')
})

test('三条推送路径都记账（成功、失败、跳过）', () => {
  // 会话路径的推送体是 pushSessionNow；它先进入全局调度槽，再运行 async 回调。
  // pushSessionImmediately 只是单飞门（见 mirror-push-coalescing.test.cjs）。
  const bodyOf = (fn) => {
    const start = SOURCE.indexOf(`const ${fn} =`)
    assert.notEqual(start, -1, `缺少 ${fn}`)
    const asyncStart = SOURCE.indexOf('async ', start)
    assert.notEqual(asyncStart, -1, `${fn} 缺少 async 实现`)
    const endMarker = fn === 'pushSessionNow' ? '\n  });' : '\n  };'
    const end = SOURCE.indexOf(endMarker, asyncStart)
    assert.notEqual(end, -1, `${fn} 函数边界无法识别`)
    return SOURCE.slice(asyncStart, end)
  }
  for (const fn of ['pushSessionNow', 'pushMirror', 'processBgQueue']) {
    const body = bodyOf(fn)
    assert.ok(
      body.includes('pushMirrorPayload(') || body.includes('recordMirrorPush('),
      `${fn} 没有任何记账调用`,
    )
  }
  // 跳过分支的阻断理由现在是变量（guardWorkspaces 的返回值），不能再靠数引号里的
  // 字面量，改成逐个函数核对：每条推送路径在「快照不可用」时都必须调 recordMirrorPush
  // 报失败。绑定到函数体比在全文件里数出现次数更严——谁漏了记账会直接定位到那个函数。
  for (const fn of ['pushSessionNow', 'pushMirror', 'processBgQueue']) {
    const body = bodyOf(fn)
    assert.ok(
      /recordMirrorPush\(false,/.test(body),
      `${fn} 的跳过分支没有记账（静默 return 会让镜像冻结无声）`,
    )
  }
  const skips = SOURCE.match(/recordMirrorPush\(false, [^)]*未推送/g) || []
  assert.ok(skips.length >= 2, '跳过理由未透出「未推送」，运维看不出镜像为何冻住')
})

test('status() 暴露的镜像字段来自记账器', () => {
  // 状态视图已挪到 lib/relay/status.js，镜像三字段由 getMirrorPush() 取值器喂进来。
  const status = fs.readFileSync(path.join(__dirname, '..', 'lib', 'relay', 'status.js'), 'utf8');
  assert.ok(
    status.includes('mirror: { pushedAt: mirrorPush.pushedAt || 0, ok: mirrorPush.ok, error: mirrorPush.error }'),
    'status() 未暴露推送状态',
  );
  assert.ok(
    /getMirrorPush: \(\) => \(\{[\s\S]{0,400}?pushedAt: mirrorPushAt, ok: mirrorPushOk, error: mirrorPushError,/.test(
      fs.readFileSync(path.join(__dirname, '..', 'lib', 'mirror', 'pusher.cjs'), 'utf8'),
    ),
    '推送调度器必须用取值器把镜像记账喂给状态视图',
  );
  // 「正文缺失、清单照推」是与「镜像还在不在更新」**分开**的诊断字段：把它并进
  // ok/pushedAt 就会重现 0.1.51 的误判（一次正文缺失把成功的清单推送翻成失败，
  // mirror.ok 长期 false，看的人以为镜像死了）。这里钉住两者没有混在一个布尔里。
  const pusher = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mirror', 'pusher.cjs'), 'utf8');
  assert.ok(/skippedBodies: mirrorBodySkipCount, skipReason: mirrorBodySkipReason/.test(pusher), '缺少正文缺失的独立诊断字段');
  const skippedStart = pusher.indexOf('const recordMirrorPushSkipped =');
  const skipped = pusher.slice(skippedStart, skippedStart + 260);
  assert.ok(skippedStart !== -1 && !/mirrorPushOk|mirrorPushAt/.test(skipped), '正文缺失不许改写 ok/pushedAt');
})

// 隧道没连上时，sidecar 的 `/tunnel/send` 一律回 503 tunnel not connected。
// 旧实现不判状态照推：bgTimer 每 500ms 完整构建一次会话快照再撞 503，宿主日志
// 被「sidecar facade request failed: 503」刷屏（实测 20s 涨 2.6KB、约 2 行/秒），
// 而手机侧一条镜像都收不到。这里把「先看权威状态再推」钉死。
test('隧道未连接时镜像推送先短路，不请求也不刷屏', () => {
  // 权威判定随生命周期一起搬到了 lib/sidecar-lifecycle.cjs；这里只要求推送侧**用它**。
  const LIFECYCLE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sidecar-lifecycle.cjs'), 'utf8')
  assert.ok(
    LIFECYCLE.includes("const tunnelConnected = () => sidecarSnapshot?.tunnel?.state === 'connected'"),
    '缺少 tunnelConnected 权威状态判定',
  )
  assert.ok(SOURCE.includes('tunnelConnected'), '推送侧必须先问权威状态再动手')
  const wrapper = SOURCE.indexOf('const pushMirrorPayload =')
  assert.notEqual(wrapper, -1, '缺少 pushMirrorPayload')
  const body = SOURCE.slice(wrapper, SOURCE.indexOf('\n  }', wrapper))
  const gate = body.indexOf('if (!tunnelConnected())')
  const send = body.indexOf('getSidecar().pushSync(')
  assert.notEqual(gate, -1, 'pushMirrorPayload 没有按隧道状态短路')
  assert.ok(send > gate, '短路必须发生在 pushSync 之前')
  assert.ok(
    body.includes("recordMirrorPush(false, '隧道未连接，镜像未推送')"),
    '短路路径未记账（镜像冻结会无声）',
  )
})

test('后台队列 tick 在「隧道未连接且没人在听变更信号」时早退', () => {
  const start = SOURCE.indexOf('const processBgQueue = async')
  assert.notEqual(start, -1, '缺少 processBgQueue')
  const body = SOURCE.slice(start, SOURCE.indexOf('\n  };', start))
  // 早退条件多了「有没有人在听变更信号」这一半：隧道断着但手机仍连着 SSE 时，
  // 这个 tick 仍然要构建清单、判定 revision 变化并广播 —— 手机因此不必靠 60s 兜底轮询
  // 才能发现「会话跑完了」。没有人听才保留原来的空转早退（省构建、也避免每 tick 记一次假故障）。
  const gate = body.indexOf('if (!online && !listSignal.watching()) return;')
  const busy = body.indexOf('bgQueueBusy = true')
  assert.notEqual(gate, -1, 'processBgQueue 没有按「隧道状态 + 有没有观众」早退')
  assert.ok(gate < busy, '早退必须发生在置忙/构建快照之前')
  assert.ok(!body.includes('sidecar.pushSync('), 'processBgQueue 不应绕过 pushMirrorPayload 直接推送')
  // 离线但有人听：只广播、不推送也不记账（否则 500ms 一条假故障）。
  const offline = body.indexOf('if (!online) {')
  assert.notEqual(offline, -1, '离线分支必须显式分流，不能顺手把推送状态记成失败')
  assert.ok(offline < body.indexOf('pushMirrorPayload('), '离线分支必须在推送之前返回')
  // 在线：先把镜像推进中转、再广播，手机紧跟信号的那次读取才不会读到旧镜像。
  const announce = body.lastIndexOf('announceSessionsRevision(')
  assert.ok(announce > body.indexOf('pushMirrorPayload('), '在线路径必须先推镜像、后广播信号')
})

test('清单变更信号只有一个出口，且必须同时丢掉本地列表缓存', () => {
  const start = SOURCE.indexOf('const announceSessionsRevision = (')
  assert.notEqual(start, -1, '缺少 announceSessionsRevision')
  const body = SOURCE.slice(start, SOURCE.indexOf('\n  };', start))
  assert.ok(body.includes('listSignal.bump(revision)'), '缺少信号广播')
  assert.ok(body.includes('dropSessionListCache(ctx)'), '广播前必须丢掉 /sessions 那层 10s 缓存')
  assert.ok(
    !body.includes('invalidateSessionList('),
    '必须用 drop 而不是 invalidate：后者抬 completion generation，会让 completed/红点永远不亮',
  )
  // 基准只在真正广播时前移：失败路径不该消耗掉一次变更。
  assert.ok(
    body.indexOf('lastSignalRevision = revision') > body.indexOf('if (!revision || revision === lastSignalRevision) return false'),
    '基准必须在幂等判定之后才前移',
  )
  assert.equal(countOf('listSignal.bump('), 1, '信号广播被多处调用，幂等与缓存丢弃会分叉')
})

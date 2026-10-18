// 镜像推送事件通道与单飞合并的源码契约和行为回归测试。
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

// 镜像推送是「事件驱动」的：每一条会话事件都会重建五份全量快照（sessions /
// workspaces / messages / stats / models）并推一次 sidecar。一轮生成里
// assistant/chunk 可达上千条，若原样透传就形成推送风暴。这里把两道闸门钉死：
//   1) 逐块流式增量不进镜像推送（轮次收尾的 assistant/message 会带完整消息）；
//   2) 同一会话的立即推送按会话单飞合并，在途期间只置一次待推标记。
// mux 消费循环随推送调度器一起搬到了 lib/mirror/pusher.cjs。
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mirror', 'pusher.cjs'), 'utf8')

const countOf = (needle) => SOURCE.split(needle).length - 1

test('逐块流式增量不触发镜像推送', () => {
  // 两处都必须锚定在 mux 消费循环内：单飞门的 .finally 里也有一次
  // pushSessionImmediately 调用，全局 indexOf 会先撞上它。
  const loop = SOURCE.indexOf('for await (const frame of ctx.apiProxy.events.mux(')
  assert.notEqual(loop, -1, '缺少 mux 消费循环')
  const skip = SOURCE.indexOf("if (p?.event?.type === 'assistant/chunk') continue;", loop)
  assert.notEqual(skip, -1, 'assistant/chunk 未被跳过，每条增量都会推一次全量快照')
  const observed = SOURCE.indexOf('observeCompletionEvent(ctx, sessionId, p?.event);', loop)
  assert.notEqual(observed, -1, 'turn/start 未进入完成状态跟踪')
  const push = SOURCE.indexOf('void pushSessionImmediately(sessionId);', loop)
  assert.notEqual(push, -1, '缺少会话事件推送')
  assert.ok(observed < skip && skip < push, '完成边沿要先记录，chunk 再跳过，其他事件继续推送')
})

test('会话立即推送按会话单飞合并', () => {
  const wrapper = SOURCE.indexOf('const pushSessionImmediately = (sessionId) => {')
  assert.notEqual(wrapper, -1, 'pushSessionImmediately 必须是同步单飞门，不能再是 async 直推')
  const body = SOURCE.slice(wrapper, SOURCE.indexOf('\n  };', wrapper))
  assert.ok(body.includes('sessionPushInFlight.get(sessionId)'), '缺少在途检查')
  assert.ok(body.includes('sessionPushQueued.add(sessionId)'), '在途期间未置待推标记')
  assert.ok(body.includes('sessionPushQueued.delete(sessionId)'), '推送结束后未消费待推标记')
  assert.ok(body.includes('void pushSessionImmediately(sessionId)'), '推送结束后未补推')
  // 真正的推送体只能被单飞门调用一次；多一处直调就绕开了合并。
  assert.equal(countOf('pushSessionNow(sessionId)'), 1, 'pushSessionNow 存在绕过单飞门的调用')
})

test('事件帧的类型必须从 payload 读（0.2.0 兼容桥的帧形状）', () => {
  // 真机故障（2026-10-10）：桥产出的帧是 `{ payload: { type, sessionId } }`，顶层没有
  // type；旧实现只读 `frame?.type` ⇒ 每一帧都被 continue 丢掉，「变化即推」整条通道
  // 是哑的，只剩 500ms 冷轮转在推，而它明确跳过 5 分钟内动过的会话（isHighPriority）。
  // 净效果：用户在电脑上刚发过消息的那个会话永远轮不到推送，手机列表要等好几秒。
  // 这条断言钉住「payload 优先、顶层兜底」这个读法。
  const loop = SOURCE.indexOf('for await (const frame of ctx.apiProxy.events.mux(')
  assert.notEqual(loop, -1, '缺少 mux 消费循环')
  const head = SOURCE.slice(loop, loop + 2000)
  assert.match(
    head,
    /const type = typeof frame\?\.type === 'string' \? frame\.type : \(p && typeof p\.type === 'string' \? p\.type : ''\);/,
    '帧类型必须兼容 payload 形状，否则 0.2.0 兼容桥下每一帧都被丢掉',
  )
  assert.ok(!/const type = frame\?\.type;/.test(head), '退回只读顶层 type 就是又把事件通道关掉')
})

test('喂一帧「只有 payload」的帧真的会推（行为级，不只是源码契约）', async () => {
  // 源码契约能被人换个写法绕过去，这条直接跑真 pusher：起 mux → 吐一帧桥形状的
  // session/event → 断言 pushSync 多收到一份。内容必须先真的变化，否则会被
  // 「内容未变，跳过重复推送」判重挡掉（那会让这条用例假绿）。
  const { createMirrorPusher } = require('../lib/mirror/pusher.cjs')
  const SID = 'bridge-frame-session'
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-frame-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const pushed = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const state = {
    items: [{ sessionId: SID, cwd: '/ws/a', updatedAt: Date.now(), running: true, blank: false, projections: { values: { title: 't' } } }],
    events: [{ event: { type: 'assistant/message', seq: 7, time: 1, data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } } } }],
  }
  const passthrough = (overrides) => new Proxy(overrides, {
    get(target, prop) {
      if (prop in target || typeof prop !== 'string') return target[prop]
      return async () => ({ result: { ok: true, value: {} } })
    },
  })
  const intervals = []
  const realSetInterval = global.setInterval
  global.setInterval = (fn, ms) => { const handle = { fn, ms }; intervals.push(handle); return handle }
  try {
    const pusher = createMirrorPusher({
      ctx: {
        apiProxy: {
          sessions: passthrough({
            list: async () => ({ result: { ok: true, value: { items: state.items } } }),
            history: async () => ({ result: { ok: true, value: { events: state.events } } }),
            projections: async () => ({ result: { ok: true, value: { values: {} } } }),
          }),
          workspace: passthrough({ list: async () => ({ result: { ok: true, value: { items: [{ workspaceId: 'w1', path: '/ws/a', title: 'a', sessionIds: [] }], archivedSessionIds: [] } } }) }),
          events: {
            mux: async function* () {
              await gate
              yield { payload: { type: 'session/event', sessionId: SID, event: { type: 'assistant/message', seq: 11 } } }
              await new Promise(() => {})
            },
          },
        },
      },
      tunnelConnected: () => true,
      getSidecar: () => ({ pushSync: async (payload) => { pushed.push(payload) } }),
    })
    const stop = pusher.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    const before = pushed.length
    // 正文真的长了：否则这次推送会被「内容未变」判重跳过，用例会假绿。
    state.events = [...state.events, { event: { type: 'assistant/message', seq: 11, time: 2, data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'again' }] } } } }]
    release()
    await new Promise((resolve) => setTimeout(resolve, 60))
    stop()
    assert.ok(pushed.length > before, `只有 payload 的帧没有触发推送（${before} → ${pushed.length}）：事件通道是哑的`)
  } finally {
    global.setInterval = realSetInterval
    fs.rmSync(home, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

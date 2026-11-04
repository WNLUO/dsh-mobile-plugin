'use strict';

/**
 * `cli-*` 会话的移动端适配层（`lib/mobile/cli/mobile.js`）。
 *
 * 钉的是「它真的长成宿主会话的样子」，不是「翻译代码长什么样」：
 *   1. 列表摘要字段与普通会话一致，且带上 `cliAgent` / `workspaceId`（侧栏分组与
 *      「⋯ → 终端」靠这两格）；
 *   2. 块表 → 历史消息（用户 / 正文 / 工具 / 提示）与模型目录形状；
 *   3. 路由分派：`cli-*` 进适配层、别的 sessionId 原样交回宿主 handler（POST 的请求体
 *      只读一次，读到的挂回 `req.body`）；
 *   4. SSE 帧的字面：`turn/start` / `user/message` / `assistant/chunk` / `turn/end` /
 *      `assistant/message`，外加审批卡的帧级 `rpcId` 与回答映射。
 */

const { Readable } = require('node:stream');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createCliMobile, isCliSessionId } = require('../lib/mobile/cli/mobile.js');
const { handleMonitor } = require('../lib/mobile/monitor.js');

function fakeRes(req) {
  const out = { status: 0, body: null }
  return {
    req,
    out,
    writeHead(status) { out.status = status; return this },
    end(chunk) { out.body = chunk === undefined ? null : JSON.parse(String(chunk)) },
    write() { return true },
    on() {},
  }
}

function fakeReq({ method = 'GET', url = '/', body } = {}) {
  const req = { method, url }
  if (body !== undefined) req.body = body
  return req
}

function makeSession(overrides = {}) {
  const session = {
    id: 'cli-1',
    workspaceId: 'ws-1',
    agentId: 'codex',
    label: 'Codex',
    cwd: '/tmp/proj',
    title: 'Codex',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    configOptions: [],
    commands: [],
    permissionFrames: new Map(),
    sinks: new Set(),
    blocks: null,
    ...overrides,
  }
  return session
}

function makeBlockLog(blocks) {
  return { list: () => blocks.map((block) => ({ ...block })) }
}

function makeBridge({ session, runPrompt, answerPermission, cancelTurn, setTitle } = {}) {
  const sessions = new Map()
  const calls = { prompts: [], answered: [], cancelled: 0, titles: [], forgotten: [] }
  if (session) sessions.set(session.id, session)
  const bridge = createCliMobile({
    sessions,
    runPrompt: (target, message) => {
      calls.prompts.push(message)
      return runPrompt ? runPrompt(target, message) : { ok: true }
    },
    answerPermission: (target, id, optionId) => { calls.answered.push({ id, optionId }); return answerPermission ? answerPermission(target, id, optionId) : true },
    cancelTurn: () => { calls.cancelled += 1; return cancelTurn ? cancelTurn() : undefined },
    setTitle: (target, title) => { calls.titles.push(title); return setTitle ? setTitle(target, title) : undefined },
    watch: (target, sink) => {
      target.sinks.add(sink)
      return () => target.sinks.delete(sink)
    },
    forget: (sessionId) => {
      calls.forgotten.push(sessionId)
      return sessions.delete(sessionId)
    },
  })
  return { bridge, sessions, calls }
}

function push(session, frame) {
  for (const sink of session.sinks) sink(frame)
}

test('会话 id 形状：只认 cli- 前缀（宿主 uuid 不会被误判）', () => {
  assert.equal(isCliSessionId('cli-abc'), true)
  assert.equal(isCliSessionId('6f2a9c1e-0000-4000-8000-000000000000'), false)
  assert.equal(isCliSessionId(''), false)
  assert.equal(isCliSessionId(undefined), false)
})

test('列表摘要：字段与普通会话一致，带 cliAgent / workspaceId', () => {
  const session = makeSession({
    title: '重构一下侧栏',
    blocks: makeBlockLog([
      { id: 'u1', kind: 'user', text: '重构一下侧栏', at: 10 },
      { id: 't1', kind: 'text', text: '好的，先看代码', at: 20 },
    ]),
  })
  const { bridge } = makeBridge({ session })
  const summary = bridge.summaryOf(session)
  assert.equal(summary.sessionId, 'cli-1')
  assert.equal(summary.title, '重构一下侧栏')
  assert.equal(summary.running, false)
  assert.equal(summary.cwd, '/tmp/proj')
  assert.equal(summary.workspaceId, 'ws-1')
  assert.equal(summary.cliAgent, 'codex')
  assert.equal(summary.blank, false)
  assert.deepEqual(summary.lastMessage, { role: 'assistant', text: '好的，先看代码', at: 20 })
})

test('列表合并：宿主那几行照发，CLI 会话并进去且 revision 重算', () => {
  const session = makeSession({ blocks: makeBlockLog([{ id: 'u1', kind: 'user', text: 'hi', at: 1 }]) })
  const { bridge } = makeBridge({ session })
  const body = { ok: true, items: [{ sessionId: 'host-1', title: '宿主会话' }], revision: 'r1', emptyConfirmed: false }
  // 合并逻辑走 wrapSessions：用最小 res 桩跑一遍
  const req = fakeReq({ method: 'GET', url: '/api/mobile/v1/sessions' })
  const res = fakeRes(req)
  const handler = async (_ctx, _req, target) => {
    target.writeHead(200, {})
    target.end(JSON.stringify(body))
  }
  return bridge.wrapSessions(handler)({}, req, res).then(() => {
    assert.equal(res.out.status, 200)
    assert.equal(res.out.body.items.length, 2)
    assert.ok(res.out.body.items.some((item) => item.sessionId === 'cli-1'))
    assert.notEqual(res.out.body.revision, 'r1', '并进新行之后 revision 必须变')
    // App 在安卓上默认带 accept-encoding: gzip，原 handler 真的会压：合并前得先解开，
    // 否则列表会被当成坏响应整份丢掉。
    const gzReq = fakeReq({ method: 'GET', url: '/api/mobile/v1/sessions' })
    const gzRes = fakeRes(gzReq)
    const gzHandler = async (_ctx, _req, target) => {
      target.writeHead(200, { 'content-encoding': 'gzip' })
      target.end(require('node:zlib').gzipSync(JSON.stringify(body)))
    }
    return bridge.wrapSessions(gzHandler)({}, gzReq, gzRes).then(() => {
      assert.equal(gzRes.out.body.items.length, 2)
    })
  })
})

test('历史消息：用户 / 正文 / 工具 / 提示各成一行，流式正文留给实时帧', () => {
  const session = makeSession({
    blocks: makeBlockLog([
      { id: 'u1', kind: 'user', text: '跑个命令', at: 10 },
      { id: 't1', kind: 'text', text: '正在跑…', at: 20, streaming: true },
      { id: 'c1', kind: 'tool', callId: 'call-1', name: 'bash', title: 'ls', state: 'ok', argsRaw: '{"cmd":"ls"}', output: 'a.txt', at: 30 },
      { id: 'n1', kind: 'notice', level: 'info', text: '适配器提示', at: 40 },
    ]),
  })
  const { bridge } = makeBridge({ session })
  const items = bridge.itemsOf(session)
  assert.deepEqual(items.map((item) => item.role), ['user', 'assistant', 'assistant'])
  assert.equal(items[0].text, '跑个命令')
  // 还在流的那一段不在历史里（重连时由 SSE 用当前全量补成一段增量）。
  assert.ok(!items.some((item) => item.id === 't1'))
  const tool = items.find((item) => item.id === 'c1')
  assert.deepEqual(tool.blocks[0], {
    type: 'tool-call', callId: 'call-1', name: 'bash', argsRaw: '{"cmd":"ls"}', state: 'ok', output: 'a.txt',
  })
  assert.equal(items.find((item) => item.id === 'n1').text, '适配器提示')
  // seq 单调递增，App 按落点排序才不会乱。
  const seqs = items.map((item) => item.seq)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
})

test('模型目录：ACP 的 configOptions[category=model] 映射成宿主形状；拿不到就退化一项', () => {
  const withModel = makeSession({
    configOptions: [{
      id: 'model', category: 'model', currentValue: 'gpt-5',
      options: [{ value: 'gpt-5', name: 'GPT-5' }, { value: 'o4', name: 'o4' }],
    }],
    blocks: makeBlockLog([]),
  })
  const { bridge } = makeBridge({ session: withModel })
  const body = bridge.modelsBodyOf(withModel)
  assert.equal(body.ok, true)
  assert.deepEqual(body.current, { provider: 'codex', model: 'gpt-5' })
  assert.deepEqual(body.groups[0].models.map((model) => model.id), ['gpt-5', 'o4'])

  // 进程还没握手完（`starting`）：**不能**回一份带 default 的假目录 —— App 会把它当真话
  // 写进缓存，那个会话之后 20 秒都只显示 default（2026-11-04 用户报「模型一直出不来」）。
  const starting = makeSession({ status: 'starting', configOptions: [], blocks: makeBlockLog([]) })
  const pending = bridge.modelsBodyOf(starting)
  assert.equal(pending.pending, true)
  assert.equal(pending.routable, false)
  assert.deepEqual(pending.groups, [])

  // 握手成功、这家 CLI 确实没声明模型项：这时给一枚占位才是真话。
  const bare = makeSession({ configOptions: [], blocks: makeBlockLog([]) })
  const degraded = bridge.modelsBodyOf(bare)
  assert.equal(degraded.groups[0].models.length, 1)
  assert.equal(degraded.groups[0].models[0].id, 'default')
  assert.equal(degraded.current.model, 'default')
})

test('路由分派：cli-* 走适配层，别的 sessionId 原样交回宿主 handler', async () => {
  const session = makeSession({
    blocks: makeBlockLog([{ id: 'u1', kind: 'user', text: 'hi', at: 1 }]),
  })
  const { bridge, calls } = makeBridge({ session })
  let fallbackCalls = 0
  const handler = bridge.route('/api/mobile/v1/session/messages', () => { fallbackCalls += 1 })

  const cliRes = fakeRes(fakeReq({ url: '/api/mobile/v1/session/messages?sessionId=cli-1' }))
  await handler({}, cliRes.req, cliRes)
  assert.equal(cliRes.out.status, 200)
  assert.equal(cliRes.out.body.items.length, 1)

  const hostRes = fakeRes(fakeReq({ url: '/api/mobile/v1/session/messages?sessionId=host-1' }))
  await handler({}, hostRes.req, hostRes)
  assert.equal(fallbackCalls, 1)

  // 已经不在了的 CLI 会话：正文类接口回空，页面不会整屏报错。
  const goneRes = fakeRes(fakeReq({ url: '/api/mobile/v1/session/messages?sessionId=cli-gone' }))
  await handler({}, goneRes.req, goneRes)
  assert.deepEqual(goneRes.out.body.items, [])
  assert.equal(fallbackCalls, 1)
})

test('POST 分派：请求体只读一次，命中 CLI 就发一轮，不命中时原 handler 照常读到 body', async () => {
  const session = makeSession({ blocks: makeBlockLog([]) })
  const { bridge, calls } = makeBridge({ session })
  let seen = null
  const handler = bridge.route('/api/mobile/v1/session/send', (_ctx, req, _res) => { seen = req.body })

  const cliRes = fakeRes(fakeReq({ method: 'POST', body: { sessionId: 'cli-1', text: '你好' } }))
  await handler({}, cliRes.req, cliRes)
  assert.deepEqual(calls.prompts, ['你好'])

  const hostRes = fakeRes(fakeReq({ method: 'POST', body: { sessionId: 'host-1', text: 'x' } }))
  await handler({}, hostRes.req, hostRes)
  assert.deepEqual(seen, { sessionId: 'host-1', text: 'x' })
})

test('停止 / 改名：stop 转 ACP cancel，rename 改得了标题', async () => {
  const session = makeSession({ blocks: makeBlockLog([]) })
  const { bridge, calls } = makeBridge({ session })
  const stop = bridge.route('/api/mobile/v1/session/stop', () => {})
  const stopRes = fakeRes(fakeReq({ method: 'POST', body: { sessionId: 'cli-1' } }))
  await stop({}, stopRes.req, stopRes)
  assert.equal(calls.cancelled, 1)

  const rename = bridge.route('/api/mobile/v1/session/rename', () => {})
  const renameRes = fakeRes(fakeReq({ method: 'POST', body: { sessionId: 'cli-1', title: '新名字' } }))
  await rename({}, renameRes.req, renameRes)
  assert.deepEqual(calls.titles, ['新名字'])
  assert.equal(renameRes.out.body.title, '新名字')
})

test('投递去重：同一 clientMessageId 再发不喂第二遍，delivery 照实回「收下了」', async () => {
  const session = makeSession({ blocks: makeBlockLog([]) })
  const { bridge, calls } = makeBridge({ session })
  const send = bridge.route('/api/mobile/v1/session/send', () => { throw new Error('不该走宿主') })
  const delivery = bridge.route('/api/mobile/v1/session/delivery', () => { throw new Error('不该走宿主') })

  const first = fakeRes(fakeReq({ method: 'POST', body: { sessionId: 'cli-1', text: '你好', clientMessageId: 'm-1' } }))
  await send({}, first.req, first)
  assert.equal(first.out.body.accepted, true)
  assert.deepEqual(calls.prompts, ['你好'])

  const probe = async (cid) => {
    const res = fakeRes(fakeReq({ method: 'GET', url: `/api/mobile/v1/session/delivery?sessionId=cli-1&clientMessageId=${cid}` }))
    await delivery({}, res.req, res)
    return res.out.body.delivered
  }
  assert.equal(await probe('m-1'), true)
  assert.equal(await probe('m-2'), false)

  // 同一个投递 id 再来一次：按成功收，但**不再发第二轮**（超时重发不能把同一句喂两遍）。
  const again = fakeRes(fakeReq({ method: 'POST', body: { sessionId: 'cli-1', text: '你好', clientMessageId: 'm-1' } }))
  await send({}, again.req, again)
  assert.equal(again.out.body.accepted, true)
  assert.deepEqual(calls.prompts, ['你好'])
})

test('SSE：块变化翻成 App 认的帧，序门靠单调 seq', () => {
  const session = makeSession({
    status: 'running',
    blocks: makeBlockLog([]),
  })
  const { bridge } = makeBridge({ session })
  const writes = []
  // 直接用 route 之外的 attach 面：handleStream 需要整条响应桩，这里模拟它接到的那一份写入
  const res = fakeRes(fakeReq({ url: '/api/mobile/v1/session/stream?sessionId=cli-1' }))
  res.on = () => {}
  res.socket = null
  bridge.handleStream({}, fakeReq({ url: '/api/mobile/v1/session/stream?sessionId=cli-1' }), res)
  // 会话流把帧写进 res.write；把 write 换成一个收集器（心跳帧也会进来）
  res.write = (text) => { writes.push(text); return true }
  // 接上之后再广播一整套：用户块 → 正文增量 → 工具 → 状态收口
  const blocks = [
    { id: 'u1', kind: 'user', text: '做个事', at: 10 },
    { id: 't1', kind: 'text', text: '好的', at: 20, streaming: true },
  ]
  session.blocks = makeBlockLog(blocks)
  push(session, { t: 'block', block: blocks[0] })
  push(session, { t: 'block', block: blocks[1] })
  push(session, { t: 'status', status: 'running' })
  // 收口：块先落定（不再是 streaming），再发 idle —— 顺序与 service 里一致。
  session.blocks = makeBlockLog([
    blocks[0],
    { ...blocks[1], streaming: false },
  ])
  push(session, { t: 'status', status: 'idle' })
  const frames = writes
    .map((chunk) => chunk.split('\n').find((line) => line.startsWith('data: ')))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(6)))
    .filter((frame) => frame && frame.type && frame.type !== 'session/heartbeat')
  const types = frames.map((frame) => frame.type)
  assert.ok(types.includes('turn/start'))
  assert.ok(types.includes('user/message'))
  assert.ok(types.includes('assistant/chunk'))
  assert.ok(types.includes('turn/end'))
  assert.ok(types.includes('assistant/message'))
  // 落定的 assistant/message 必须带 seq（否则 App 排不到位置上），且 id 与块 id 一致。
  const settled = frames.find((frame) => frame.type === 'assistant/message')
  assert.equal(settled.data.message.id, 't1')
  assert.equal(typeof settled.seq, 'number')
  // 带 seq 的帧序号必须单调：App 的序门只认「比上次大」。
  const seqs = frames.filter((frame) => typeof frame.seq === 'number').map((frame) => frame.seq)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
})

test('收口顺序：状态帧先到、块落定帧后到，正文照样落成消息（且只发一次）', () => {
  const session = makeSession({ status: 'running', blocks: makeBlockLog([]) })
  const { bridge } = makeBridge({ session })
  const res = fakeRes(fakeReq({ url: '/api/mobile/v1/session/stream?sessionId=cli-1' }))
  res.socket = null
  bridge.handleStream({}, fakeReq({ url: '/api/mobile/v1/session/stream?sessionId=cli-1' }), res)
  const writes = []
  res.write = (text) => { writes.push(text); return true }

  const blocks = [
    { id: 'u1', kind: 'user', text: '做个事', at: 10 },
    { id: 't1', kind: 'text', text: '做完了', at: 20, streaming: true },
  ]
  session.blocks = makeBlockLog(blocks)
  push(session, { t: 'block', block: blocks[0] })
  push(session, { t: 'block', block: blocks[1] })
  push(session, { t: 'status', status: 'running' })
  // service 里 status 是立即广播、块落定走攒批：先到的一定是 status。
  push(session, { t: 'status', status: 'idle' })
  push(session, { t: 'block', block: { ...blocks[1], streaming: false } })
  // 再来一次同样的落定帧：同一块不许补第二遍消息。
  push(session, { t: 'block', block: { ...blocks[1], streaming: false } })

  const frames = writes
    .map((chunk) => chunk.split('\n').find((line) => line.startsWith('data: ')))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(6)))
    .filter((frame) => frame && frame.type)
  assert.equal(frames.filter((frame) => frame.type === 'assistant/message' && frame.data.message.id === 't1').length, 1)
})

test('晚接上的连接也要收尾：发送之后才连流，turn/end 照样发得出去', () => {
  // 现场（2026-11-04）：发送 → 进页面晚 / 断线重连 / 熄屏回来 → 这条流挂上时这一轮已经在跑。
  // 早先 status 只记在会话上、收尾却只认这条连接的 turnOpen，于是这个连接一句 turn/end 都不发，
  // 页面上的「深度求索中」永久挂着（正文早就到了）。
  const session = makeSession({ status: 'running', blocks: makeBlockLog([]) })
  const { bridge } = makeBridge({ session })
  const writes = []
  const res = fakeRes(fakeReq({ url: '/api/mobile/v1/session/stream?sessionId=cli-1' }))
  res.socket = null
  res.on = () => {}
  res.write = (text) => { writes.push(text); return true }
  bridge.handleStream({}, fakeReq({ url: '/api/mobile/v1/session/stream?sessionId=cli-1' }), res)

  // 会话级观察者先看到了 running（真实顺序：块帧和状态帧都在连接挂上之前就广播过）。
  push(session, { t: 'status', status: 'running' })
  session.blocks = makeBlockLog([
    { id: 'u1', kind: 'user', text: '做个事', at: 10 },
    { id: 't1', kind: 'text', text: '做完了', at: 20, streaming: false },
  ])
  // 收尾帧到达这条**没有经历过 running** 的连接。
  push(session, { t: 'status', status: 'idle' })

  const frames = writes
    .map((chunk) => chunk.split('\n').find((line) => line.startsWith('data: ')))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(6)))
    .filter((frame) => frame && frame.type && frame.type !== 'session/heartbeat')
  assert.ok(frames.some((frame) => frame.type === 'turn/end'), '晚接上的连接也必须收到 turn/end');
  assert.ok(frames.some((frame) => frame.type === 'assistant/message' && frame.data.message.id === 't1'));
})

test('收口之后到的增量只补消息、不再发草稿（否则 App 会把这一轮重新认成在跑）', () => {
  // 现场（2026-11-04「AI 已经回复了，这边还在深度求索中」）：状态帧立即广播、块帧走 60ms 攒批，
  // 于是 idle 先到、turn/end 当场发出去，紧接着攒批里最后一段正文的块帧才到。它要是当
  // assistant/chunk 发出去，App 会按带回合号的增量把这一轮重新认成在跑，而这一轮再也不会
  // 有第二次 turn/end。
  const session = makeSession({ status: 'running', blocks: makeBlockLog([]) })
  const { bridge } = makeBridge({ session })
  const writes = []
  const res = fakeRes(fakeReq({ url: '/api/mobile/v1/session/stream?sessionId=cli-1' }))
  res.socket = null
  res.on = () => {}
  res.write = (text) => { writes.push(text); return true }
  bridge.handleStream({}, fakeReq({ url: '/api/mobile/v1/session/stream?sessionId=cli-1' }), res)

  const userBlock = { id: 'u1', kind: 'user', text: '做个事', at: 10 }
  session.blocks = makeBlockLog([userBlock])
  push(session, { t: 'block', block: userBlock })
  push(session, { t: 'status', status: 'running' })
  // 收口：正文先落定、状态变 idle
  const textBlock = { id: 't1', kind: 'text', text: '做完了', at: 20, streaming: false }
  session.blocks = makeBlockLog([userBlock, textBlock])
  push(session, { t: 'status', status: 'idle' })
  // 收尾那一刻正文已经按消息补出去了（turn/end 之后补发，见 settleTurn）。
  assert.ok(writes.join('').includes('"id":"t1"'), '这一轮的正文必须落成 assistant/message');

  const before = writes.length
  // 攒批里最后那段正文的块帧现在才到（顺序与 service 里一致：块可能是先 mark 后 flush 的）
  push(session, { t: 'block', block: textBlock })

  const after = writes.slice(before)
    .map((chunk) => chunk.split('\n').find((line) => line.startsWith('data: ')))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(6)))
    .filter((frame) => frame && frame.type)
  assert.equal(after.filter((frame) => frame.type === 'assistant/chunk').length, 0, '收口之后不许再发草稿帧');
  // 同一块也不许补第二遍消息（App 按 id 合并，但重复发只是白花流量）。
  assert.equal(after.filter((frame) => frame.type === 'assistant/message').length, 0, '同一块只补一次');
})

/** 把一次 `/sessions` 合并跑完，返回回包。 */
async function listVia(bridge, url, hostItems = []) {
  const req = fakeReq({ url })
  const res = fakeRes(req)
  const handler = async (_ctx, _req, target) => {
    target.writeHead(200, {})
    target.end(JSON.stringify({ ok: true, items: hostItems, revision: 'host-rev', emptyConfirmed: hostItems.length === 0 }))
  }
  await bridge.wrapSessions(handler)({}, req, res)
  return res.out.body
}

async function flagVia(bridge, kind, sessionId) {
  const res = fakeRes(fakeReq({ method: 'POST', body: { sessionId } }))
  await bridge.routeFlag(kind, () => { throw new Error('cli 会话不该透给宿主') })({}, res.req, res)
  return res.out.body
}

test('归档：等于关掉这条 CLI —— 进程收了、列表里消失、不进已归档视图', async () => {
  const session = makeSession({ blocks: makeBlockLog([{ id: 'u1', kind: 'user', text: 'hi', at: 1 }]) })
  const { bridge, sessions, calls } = makeBridge({ session })
  assert.equal((await listVia(bridge, '/api/mobile/v1/sessions')).items.length, 1)

  const body = await flagVia(bridge, 'archive', 'cli-1')
  assert.equal(body.ok, true)
  assert.equal(body.closed, true)
  assert.deepEqual(calls.forgotten, ['cli-1'], '归档必须真的收掉那条会话（进程跟着走）')
  assert.equal(sessions.size, 0)
  assert.equal((await listVia(bridge, '/api/mobile/v1/sessions')).items.length, 0)
  // 关掉的 CLI 不该在「已归档」那一页露头：那边归档的是宿主的会话文件，CLI 没有东西可回来。
  assert.equal((await listVia(bridge, '/api/mobile/v1/sessions?archived=1')).items.length, 0)
})

test('归档一条已经关掉的 CLI：按成功回，不弹错（幂等）', async () => {
  const { bridge, calls } = makeBridge({})
  const body = await flagVia(bridge, 'archive', 'cli-gone')
  assert.equal(body.ok, true)
  assert.deepEqual(calls.forgotten, [])
})

test('置顶：排在最前，且带上 pinned 字段（App 画图钉）', async () => {
  const a = makeSession({ id: 'cli-1', updatedAt: 1_000, blocks: makeBlockLog([{ id: 'u1', kind: 'user', text: 'a', at: 1 }]) })
  const b = makeSession({ id: 'cli-2', updatedAt: 2_000, blocks: makeBlockLog([{ id: 'u2', kind: 'user', text: 'b', at: 2 }]) })
  const { bridge, sessions } = makeBridge({ session: a })
  sessions.set(b.id, b)

  assert.equal((await flagVia(bridge, 'pin', 'cli-1')).ok, true)
  const body = await listVia(bridge, '/api/mobile/v1/sessions', [{ sessionId: 'host-1', title: '宿主' }])
  const ids = body.items.map((item) => item.sessionId)
  assert.equal(ids[0], 'cli-1', '置顶的必须排最前')
  assert.equal(body.items[0].pinned, true)
  assert.deepEqual(ids, ['cli-1', 'host-1', 'cli-2'])

  assert.equal((await flagVia(bridge, 'unpin', 'cli-1')).ok, true)
  const after = await listVia(bridge, '/api/mobile/v1/sessions', [{ sessionId: 'host-1', title: '宿主' }])
  assert.equal(after.items[0].sessionId, 'host-1')
  assert.ok(!after.items.some((item) => item.pinned === true))
})

test('会话收掉之后置顶那本账跟着清掉（账挂在会话上，不单独存活）', async () => {
  const session = makeSession({ blocks: makeBlockLog([{ id: 'u1', kind: 'user', text: 'hi', at: 1 }]) })
  const { bridge, sessions, calls } = makeBridge({ session })
  await flagVia(bridge, 'pin', 'cli-1')
  sessions.delete('cli-1') // 相当于 service 的 forget
  assert.deepEqual(calls.forgotten, [])
  assert.equal((await listVia(bridge, '/api/mobile/v1/sessions')).items.length, 0)
  assert.equal(bridge.monitorItems().length, 0)
})

test('清空归档不掺和 CLI 那半：归档就是关掉，这里没有可清的', async () => {
  const session = makeSession({ blocks: makeBlockLog([{ id: 'u1', kind: 'user', text: 'hi', at: 1 }]) })
  const { bridge, sessions, calls } = makeBridge({ session })
  const req = fakeReq({ method: 'POST', body: { confirm: true } })
  const res = fakeRes(req)
  const host = async (_ctx, _req, target) => {
    target.writeHead(200, {})
    target.end(JSON.stringify({ ok: true, deleted: 2 }))
  }
  await bridge.wrapClearArchived(host)({}, req, res)
  assert.deepEqual(calls.forgotten, [], '清空归档不该顺手关掉还活着的 CLI')
  assert.equal(sessions.size, 1)
  assert.equal(res.out.body.deleted, 2)
})

test('monitor：CLI 会话的在跑 / 待回话 / 刚完成都进得来（形状与宿主逐字一致）', async () => {
  const session = makeSession({ status: 'running', title: '改侧栏', blocks: makeBlockLog([]) })
  const { bridge } = makeBridge({ session })

  // 先让会话级观察者挂上（第一次触达会话状态时挂）。
  bridge.monitorItems()
  const user = { id: 'u1', kind: 'user', text: '做个事', at: 10 }
  session.blocks = makeBlockLog([user])
  push(session, { t: 'status', status: 'running' })
  push(session, { t: 'block', block: user })

  let item = bridge.monitorItems().find((entry) => entry.sessionId === 'cli-1')
  assert.ok(item)
  assert.equal(item.running, true)
  assert.equal(item.title, '改侧栏')
  assert.equal(item.pendingCard, null)

  // 挂起审批：pendingInteraction 与卡本体都要有（原生靠它回前台时先要卡）。
  const request = { id: 'p1', title: '执行命令', detail: '', options: [{ optionId: 'a1', kind: 'allow_once' }] }
  session.permissionFrames.set('p1', request)
  push(session, { t: 'permission', request })
  item = bridge.monitorItems().find((entry) => entry.sessionId === 'cli-1')
  assert.equal(item.pendingInteraction, 'approval')
  assert.match(item.pendingCard.rpcId, /^cli:/)
  assert.equal(item.pendingCard.approvalId, 'p1')

  // 跑完了：没有连接开着也要记上（后台提醒的全部意义就在这儿）。
  session.status = 'idle'
  session.permissionFrames.clear()
  push(session, { t: 'status', status: 'idle' })
  item = bridge.monitorItems().find((entry) => entry.sessionId === 'cli-1')
  assert.equal(item.running, false)
  assert.equal(item.completed, true)
  assert.equal(item.lastTurn.status, 'completed')
  assert.equal(item.pendingCard, null)

  // 读过之后不再算「刚完成」。
  const readRes = fakeRes(fakeReq({ method: 'POST', body: { sessionId: 'cli-1' } }))
  await bridge.route('/api/mobile/v1/session/read', () => {})({}, readRes.req, readRes)
  item = bridge.monitorItems().find((entry) => entry.sessionId === 'cli-1')
  assert.equal(item.completed, false)
})

test('monitor 端点：CLI 会话与宿主会话并进同一份视图（不新增接口）', async () => {
  const session = makeSession({ status: 'running', title: '跑起来了', blocks: makeBlockLog([]) })
  const { bridge } = makeBridge({ session })
  const ctx = {
    apiProxy: {
      sessions: { list: async () => ({ result: { ok: true, value: { items: [{ sessionId: 'host-1', running: false, blank: false, updatedAt: 1, projections: { values: { title: '宿主' } } }] } } }) },
      workspace: { list: async () => ({ result: { ok: true, value: { items: [], archivedSessionIds: [] } } }) },
    },
  }
  const req = Readable.from([Buffer.from('{}')])
  req.url = '/api/mobile/v1/monitor'
  req.headers = {}
  const res = { writeHead(status) { this.status = status }, end(payload) { this.body = JSON.parse(payload) } }
  await handleMonitor(ctx, req, res, () => bridge.monitorItems())
  assert.equal(res.status, 200)
  const ids = res.body.items.map((item) => item.sessionId).sort()
  assert.deepEqual(ids, ['cli-1', 'host-1'])
  const cli = res.body.items.find((item) => item.sessionId === 'cli-1')
  assert.equal(cli.running, true)
  assert.equal(cli.title, '跑起来了')
})

test('工具块的实时消息用宿主形状（id / arguments）：否则 tool/result 补丁配不上它', () => {
  const session = makeSession({ status: 'running', blocks: makeBlockLog([]) })
  const { bridge } = makeBridge({ session })
  const res = fakeRes(fakeReq({ url: '/api/mobile/v1/session/stream?sessionId=cli-1' }))
  res.socket = null
  bridge.handleStream({}, fakeReq({ url: '/api/mobile/v1/session/stream?sessionId=cli-1' }), res)
  const writes = []
  res.write = (text) => { writes.push(text); return true }

  const user = { id: 'u1', kind: 'user', text: '跑一下', at: 10 }
  const tool = { id: 'c1', kind: 'tool', callId: 'call-9', name: 'bash', state: 'ok', argsRaw: '{"cmd":"ls"}', output: 'a', at: 20 }
  session.blocks = makeBlockLog([user, tool])
  push(session, { t: 'block', block: user })
  push(session, { t: 'status', status: 'running' })
  push(session, { t: 'status', status: 'idle' })
  push(session, { t: 'block', block: tool })

  const frames = writes
    .map((chunk) => chunk.split('\n').find((line) => line.startsWith('data: ')))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(6)))
    .filter((frame) => frame && frame.type === 'assistant/message')
  const toolMessage = frames.find((frame) => frame.data.message.id === 'c1')
  assert.ok(toolMessage, '工具块没有补成消息')
  const block = toolMessage.data.message.content[0]
  assert.equal(block.id, 'call-9')
  assert.equal(block.arguments, '{"cmd":"ls"}')
  assert.equal(block.state, 'ok')
})

test('导出会话日志：CLI 没有宿主日志，回一份合法空 ZIP（不是错误卡）', async () => {
  const session = makeSession({ blocks: makeBlockLog([]) })
  const { bridge } = makeBridge({ session })
  const out = { status: 0, headers: null, body: null, ended: false }
  const req = fakeReq({ url: '/api/mobile/v1/session-log?sessionId=cli-1' })
  const res = {
    req,
    writeHead(status, headers) { out.status = status; out.headers = headers; return this },
    end(chunk) { out.ended = true; out.body = chunk },
    write() { return true },
    on() {},
  }
  await bridge.route('/api/mobile/v1/session-log', () => { throw new Error('不该走宿主') })({}, req, res)
  assert.equal(out.status, 200)
  assert.match(out.headers['content-type'], /zip/)
  // 空 ZIP：EOCD 签名 `PK\x05\x06` + 18 字节 0。
  assert.equal(Buffer.isBuffer(out.body), true)
  assert.equal(out.body.length, 22)
  assert.deepEqual([...out.body.subarray(0, 4)], [0x50, 0x4b, 0x05, 0x06])
})

test('审批：卡片帧照宿主形状（帧级 rpcId），回答按 ACP option 映射', async () => {
  const session = makeSession({ blocks: makeBlockLog([]) })
  const { bridge, calls } = makeBridge({ session })
  const res = fakeRes(fakeReq({ url: '/api/mobile/v1/session/stream?sessionId=cli-1' }))
  res.socket = null
  bridge.handleStream({}, fakeReq({ url: '/api/mobile/v1/session/stream?sessionId=cli-1' }), res)
  const writes = []
  res.write = (text) => { writes.push(text); return true }

  const request = {
    id: 'p1',
    title: '执行 rm -rf',
    detail: '危险命令',
    options: [{ optionId: 'a1', kind: 'allow_once', name: '允许一次' }, { optionId: 'r1', kind: 'reject_once', name: '拒绝' }],
  }
  session.permissionFrames.set('p1', request)
  push(session, { t: 'permission', request })
  const frame = writes
    .map((chunk) => chunk.split('\n').find((line) => line.startsWith('data: ')))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(6)))
    .find((item) => item.type === 'approval/requested')
  assert.ok(frame, '审批卡帧没发出去')
  assert.match(frame.rpcId, /^cli:/)
  assert.equal(frame.approvalId, 'p1')
  assert.equal(frame.toolName, '执行 rm -rf')

  let fellBack = 0
  const respond = bridge.wrapApprovalRespond(() => { fellBack += 1 })
  const okRes = fakeRes(fakeReq({ method: 'POST', body: { sessionId: 'cli-1', rpcId: frame.rpcId, approvalId: 'p1', outcome: 'allowed-once' } }))
  await respond({}, okRes.req, okRes)
  assert.deepEqual(calls.answered, [{ id: 'p1', optionId: 'a1' }])
  assert.equal(fellBack, 0)

  // 不是我们铸的 rpcId → 原样交回宿主那条桥。
  const hostRes = fakeRes(fakeReq({ method: 'POST', body: { sessionId: 'host-1', rpcId: 'm-xxx', approvalId: 'x', outcome: 'rejected' } }))
  await respond({}, hostRes.req, hostRes)
  assert.equal(fellBack, 1)
})

test('档位与其它会话级下拉：ACP 的 thought_level 摊到每个模型上，其余变成附加选项行', () => {
  const session = makeSession({
    configOptions: [
      {
        id: 'model', name: 'Model', category: 'model', currentValue: 'gpt-6-luna',
        options: [{ value: 'gpt-6-luna', name: '6 Luna' }, { value: 'gpt-6-astra', name: '6 Astra' }],
      },
      {
        id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', currentValue: 'low',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      },
      {
        id: 'fast-mode', name: 'Fast mode', category: 'model_config', currentValue: 'off',
        options: [{ value: 'off', name: 'Off' }, { value: 'on', name: 'On' }],
      },
    ],
    blocks: makeBlockLog([]),
  })
  const { bridge } = makeBridge({ session })
  const body = bridge.modelsBodyOf(session)

  // 档位挂在每个模型上（App 的滑轨只认 model.reasoning.efforts）。
  for (const model of body.groups[0].models) {
    assert.deepEqual(model.reasoning.efforts.map((effort) => effort.id), ['low', 'medium', 'high'])
  }
  // 当前选的那一档要能读出来，否则滑轨每次打开都停在第一档。
  assert.equal(body.current.reasoningEffort, 'low')
  // 快速档这类（`model_config`）走附加选项行，App 早就会画。
  assert.deepEqual(body.options.map((row) => row.id), ['fast-mode'])
  assert.equal(body.options[0].value, 'off')
  assert.deepEqual(body.options[0].choices.map((choice) => choice.id), ['off', 'on'])

  // 这家 CLI 不给档位时，`reasoning` 与 `reasoningEffort` 都不出现 —— 滑轨整个不画。
  const plain = makeSession({
    configOptions: [{
      id: 'model', name: 'Model', category: 'model', currentValue: 'x',
      options: [{ value: 'x', name: 'X' }],
    }],
    blocks: makeBlockLog([]),
  })
  const plainBody = makeBridge({ session: plain }).bridge.modelsBodyOf(plain)
  assert.equal(plainBody.groups[0].models[0].reasoning, undefined)
  assert.equal(plainBody.current.reasoningEffort, undefined)
  assert.equal(plainBody.options, undefined)
})

test('列表变更信号：标题 / 状态 / 置顶一改就报一次，同样的内容不重复报', async () => {
  const { listSignal } = require('../lib/shared/list-signal.js');
  const session = makeSession({ blocks: makeBlockLog([]) })
  const { bridge } = makeBridge({ session })
  bridge.summaryOf(session) // 建立会话级观察者（`observe`）

  const seen = []
  const release = listSignal.onBump((event) => seen.push(event.revision))
  const before = seen.length

  push(session, { t: 'title', title: '重构一下侧栏' })
  assert.ok(seen.length > before, '标题变了却没报清单变更（侧栏会停在 CLI 的名字上）')
  const afterTitle = seen.length

  // 同一份内容再报一次不该再广播（`bump` 幂等）。
  push(session, { t: 'title', title: '重构一下侧栏' })
  assert.equal(seen.length, afterTitle)

  release()
})

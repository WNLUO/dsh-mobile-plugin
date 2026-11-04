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
      sessions.delete(sessionId)
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

test('归档：默认视图里不出现，只出现在 ?archived=1；取消归档就回来', async () => {
  const session = makeSession({ blocks: makeBlockLog([{ id: 'u1', kind: 'user', text: 'hi', at: 1 }]) })
  const { bridge } = makeBridge({ session })
  assert.equal((await listVia(bridge, '/api/mobile/v1/sessions')).items.length, 1)

  assert.equal((await flagVia(bridge, 'archive', 'cli-1')).ok, true)
  assert.equal((await listVia(bridge, '/api/mobile/v1/sessions')).items.length, 0, '归档后默认视图不该再有它')
  assert.equal((await listVia(bridge, '/api/mobile/v1/sessions?archived=1')).items.length, 1, '已归档视图里要有它')

  assert.equal((await flagVia(bridge, 'unarchive', 'cli-1')).ok, true)
  assert.equal((await listVia(bridge, '/api/mobile/v1/sessions')).items.length, 1)
  assert.equal((await listVia(bridge, '/api/mobile/v1/sessions?archived=1')).items.length, 0)
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

test('会话收掉之后归档 / 置顶那两份账一起清掉', async () => {
  const session = makeSession({ blocks: makeBlockLog([{ id: 'u1', kind: 'user', text: 'hi', at: 1 }]) })
  const { bridge, sessions, calls } = makeBridge({ session })
  await flagVia(bridge, 'archive', 'cli-1')
  await flagVia(bridge, 'pin', 'cli-1')
  sessions.delete('cli-1') // 相当于 service 的 forget
  assert.deepEqual(calls.forgotten, [])
  assert.equal((await listVia(bridge, '/api/mobile/v1/sessions?archived=1')).items.length, 0)
  assert.equal(bridge.monitorItems().length, 0)
})

test('清空归档：把 CLI 的归档会话一起收掉，deleted 数字两头加总', async () => {
  const session = makeSession({ blocks: makeBlockLog([{ id: 'u1', kind: 'user', text: 'hi', at: 1 }]) })
  const { bridge, sessions, calls } = makeBridge({ session })
  await flagVia(bridge, 'archive', 'cli-1')
  const req = fakeReq({ method: 'POST', body: { confirm: true } })
  const res = fakeRes(req)
  const host = async (_ctx, _req, target) => {
    target.writeHead(200, {})
    target.end(JSON.stringify({ ok: true, deleted: 2 }))
  }
  await bridge.wrapClearArchived(host)({}, req, res)
  assert.deepEqual(calls.forgotten, ['cli-1'])
  assert.equal(sessions.size, 0)
  assert.equal(res.out.body.deleted, 3)
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

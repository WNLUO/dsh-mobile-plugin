'use strict';

/**
 * `cli-*` 会话的移动端适配层：让一条 CLI 对话走宿主普通会话那一整套接口。
 *
 * CLI 会话不是宿主的会话 —— 它是一条 ACP 子进程，块表在 `cli/blocks.js` 里。但对手机来说
 * 它必须长得跟普通会话一模一样：出现在侧栏列表里、点进去有历史、能发、能停、能选模型、
 * 会弹审批卡。所以这一层只做两个方向的翻译，不新造任何接口：
 *
 *   1. **请求方向**：`sessionId` 以 `cli-` 开头的，路由层先看一眼再交给这里（见
 *      `lib/routes/mobile-api.js`）。`sessionId` 在查询串（GET）或请求体（POST）里，所以
 *      分派只发生一次，不抄任何 handler。
 *   2. **帧方向**：ACP 的块表 → 宿主那套 `session/event` 帧。App 认哪几种、缺哪个就转圈，
 *      是按 `app/src/hooks/streamFrame.ts` 与 `app/src/utils/frameWatermark.ts` 逐条对出来的：
 *      `turn/start` / `turn/end` / `user/message` / `assistant/chunk` / `tool/result` /
 *      `approval/*` / `session/title` / `session/heartbeat`。
 *
 * 三条刻意的减法（都比着「App 到底靠什么落地」做的，不是省事）：
 *
 *   - **正文与工具的过程用草稿帧，落定的内容一律走历史。** 草稿（`assistant/chunk`）不需要
 *     seq、不会被序门丢掉；一轮结束先发 `turn/end`（reason=completed），再把这一轮每个块
 *     以稳定 id 发一条 `assistant/message`。id 与 `/session/messages` 的行 id 是同一个
 *     （块的 id），所以重连 / resync 按 id 合并，不会出现两遍。`assistant/message` 放在
 *     `turn/end` **之后**：App 在「当前回合」收尾时会把这条消息当成终局消息再收一次尾，
 *     先发 turn/end 就只是就地更新，不会提前把这一轮判成结束。
 *   - **审批卡照抄宿主那一种形状**（帧级 `rpcId` + payload `approvalId`，见 `approvals.js`）。
 *     App 只认这种卡；新造一种等于卡片永远不出现。回答仍走 `/approval/respond`，在这一层
 *     按 rpcId 找回 ACP 的挂起项。
 *   - **拿不到的字段给合理缺省，不报错。** 模型目录拿不到就回只有一项的清单；统计、队列、
 *     搜索这类一律回空；这条会话在每种接口上都可用，比「主链路通了、点别的报错」重要。
 *
 * 会话本身仍归 `cli/service.js` 托管（进程、块表、审批挂起项都在那儿），这里只拿它的
 * 只读门面。
 */

const { Readable } = require('node:stream')
const { readJsonBody, sendJson } = require('../../shared/http-util')
const { chunksHeaders, pipeEncrypted } = require('../../shared/e2ee-chunks.js')
const { listRevision } = require('../../shared/list-revision.js')
const { writeSse, waitForDrain, ssePadding } = require('../../shared/sse-write.js')
const streamRegistry = require('../stream-registry.js')
const { createFrameSealer } = require('../stream.js')

/** 会话 id 的形状：`cli-*`。宿主自己的会话 id 是 uuid，不会撞。 */
const CLI_PREFIX = 'cli-'
/**
 * POST 分派要先读一次请求体才能看见 sessionId，所以上限必须盖住 `/session/send` 那一档
 * （图片 base64），不能拿默认的 344KB —— 否则带图的那一发会在分派这一步被截断。
 */
const BODY_MAX = 16 * 1024 * 1024
const HEARTBEAT_MS = 15_000
const MESSAGE_TEXT_MAX = 200
const SSE_PADDING_BYTES = 2048

function isCliSessionId(value) {
  return typeof value === 'string' && value.startsWith(CLI_PREFIX)
}

function textOf(value) {
  return typeof value === 'string' ? value : ''
}

function queryOf(req) {
  return new URL(req.url || '/', 'http://x').searchParams
}

/** 会话状态访问器：每个服务进程一份，按会话对象挂状态（会话被收掉时它自然一起没）。 */
function createState() {
  return {
    /** 已经发出去的帧序号。App 的序门只认「比上次大」，所以每发一帧就抬一次。 */
    seq: 0,
    /** 轮号：每出现一个用户块 +1。 */
    turn: 0,
    /** 块 id → 轮号。 */
    turnByBlock: new Map(),
    /** 块 id → 块序号（`assistant/chunk` 的 index）。 */
    blockIndex: new Map(),
    /** 这一轮开着（`turn/start` 已发、`turn/end` 还没发）。 */
    turnOpen: false,
    /** 上一轮事实：侧栏的红点 / 黄点靠它，与宿主 `lastTurn` 同形。 */
    lastTurn: null,
    /**
     * 这一份会话自己的两道账：归档与置顶。
     *
     * 宿主那本账里没有 CLI 会话（它本来就不是宿主会话），所以四条 `workspace/*-session`
     * 动作在这一层自己记。**代价：账活在宿主进程内存里，DSH 重启就没了** —— 但那跟 CLI
     * 会话本身（ACP 子进程、块表、审批挂起项）一起没，不是缺陷，别为它落盘。
     */
    archived: false,
    pinned: false,
    /** 这台设备读过的那一轮（`/session/read` 记），`completed` 提醒按它判「新」。 */
    readAt: 0,
  }
}

/**
 * 把块表扫一遍，补齐轮号 / 块序号 / 消息 seq。
 *
 * 消息 seq 在这里按**块表顺序**一次性分配（包括还在流式的那一段）：历史与实时帧必须拿到
 * 同一个值，否则同一条消息在两边算不出同一个落点，重连之后整段会挪位。后进来的块追加在
 * 后面，已分配的值不动。
 */
function syncState(session, state) {
  const blocks = session.blocks.list()
  let turn = state.turn
  blocks.forEach((block, index) => {
    if (!state.blockIndex.has(block.id)) state.blockIndex.set(block.id, index)
    if (block.kind === 'user' && !state.turnByBlock.has(block.id)) turn += 1
    if (!state.turnByBlock.has(block.id)) state.turnByBlock.set(block.id, turn)
  })
  state.turn = turn
}

function nextSeq(state) {
  state.seq += 1
  return state.seq
}

/** 一条块 → App 认的内容块（与 `history-derive.js` 给历史用的那一组同形）。 */
function toolBlockOf(block) {
  return {
    type: 'tool-call',
    callId: block.callId,
    name: block.name || undefined,
    argsRaw: block.argsRaw || undefined,
    state: block.state === 'ok' ? 'ok' : block.state === 'error' ? 'error' : 'running',
    ...(typeof block.output === 'string' && block.output ? { output: block.output } : {}),
  }
}

/** 一条块 → 历史消息（setttled 的块才出，正在流的那一段交给实时帧）。 */
function messageOf(block, state, force = false) {
  const turn = state.turnByBlock.get(block.id) || 0
  const base = {
    id: block.id,
    role: 'assistant',
    text: '',
    blocks: [],
    // 历史里的落点用**块表顺序号**：块只增不改序，所以同一个块每次算出来的落点都一样，
    // App 的 `bySeq` 才排得稳。实时帧另用单调的事件序号（见 onBlock）。
    seq: (state.blockIndex.get(block.id) || 0) + 1,
    time: block.at,
    ...(turn > 0 ? { turn } : {}),
  }
  if (block.kind === 'text') {
    if ((block.streaming && !force) || !block.text) return null
    return { ...base, text: block.text, blocks: [{ type: 'text', text: block.text }] }
  }
  if (block.kind === 'reasoning') {
    if ((block.streaming && !force) || !block.text) return null
    return { ...base, blocks: [{ type: 'reasoning', text: block.text }] }
  }
  if (block.kind === 'tool') return { ...base, blocks: [toolBlockOf(block)] }
  if (block.kind === 'notice') {
    const text = textOf(block.text)
    if (!text) return null
    return { ...base, text, blocks: [{ type: 'text', text }] }
  }
  // 计划整表替换在对话页没有对应呈现；它仍留在 CLI 自己的详情里（`cli/detail`）。
  return null
}

function userMessageOf(block, state) {
  const turn = state.turnByBlock.get(block.id) || 0
  const text = textOf(block.text)
  return {
    id: block.id,
    role: 'user',
    text,
    blocks: text ? [{ type: 'text', text }] : [],
    seq: (state.blockIndex.get(block.id) || 0) + 1,
    time: block.at,
    ...(turn > 0 ? { turn } : {}),
  }
}

/** 侧栏那一行要的「最后一条可见内容」。 */
function lastMessageOf(items) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    const text = textOf(item.text) || (item.blocks || []).map(blockText).filter(Boolean).join(' ')
    if (!text) continue
    return { role: item.role, text: text.slice(0, MESSAGE_TEXT_MAX), at: item.time || 0 }
  }
  return null
}

function blockText(block) {
  if (!block || typeof block !== 'object') return ''
  if (block.type === 'text' || block.type === 'reasoning') return textOf(block.text)
  if (block.type === 'tool-call') return textOf(block.name) || textOf(block.title)
  return ''
}

/**
 * 模型目录：ACP 的 `configOptions` 里 `category === 'model'` 的那一项。
 *
 * 拿不到就退化成一个只有一项的清单（当前 CLI 的名字），而不是报错 —— 输入条的模型芯片
 * 打开时不该是一片红字。
 */
function modelsBodyOf(session) {
  const options = Array.isArray(session.configOptions) ? session.configOptions : []
  const modelOption = options.find((option) => option && option.category === 'model')
    || options.find((option) => option && typeof option.id === 'string' && /model/i.test(option.id))
  const listed = modelOption && Array.isArray(modelOption.options) ? modelOption.options : []
  const models = listed
    .filter((item) => item && item.value !== undefined)
    .map((item) => ({
      id: String(item.value),
      name: textOf(item.name) || String(item.value),
      ...(textOf(item.description) ? { description: textOf(item.description) } : {}),
    }))
  if (models.length === 0) models.push({ id: 'default', name: session.label || 'CLI' })
  const current = modelOption && modelOption.currentValue !== undefined
    ? String(modelOption.currentValue)
    : models[0].id
  return {
    ok: true,
    current: { provider: session.agentId, model: current },
    routable: true,
    groups: [{ id: session.agentId, name: session.label || 'CLI', models }],
    failures: [],
  }
}

/**
 * @param {object} deps 由 `cli/service.js` 交进来的受控门面（见那边的返回值）
 */
function createCliMobile(deps) {
  const { sessions, runPrompt, answerPermission, cancelTurn, setTitle, watch, forget } = deps
  /** 会话对象 → 适配状态。 */
  const states = new WeakMap()
  /** rpcId → { session, requestId }：`/approval/respond` 靠它找回 ACP 的挂起项。 */
  const approvals = new Map()

  function stateOf(session) {
    let state = states.get(session)
    if (!state) {
      state = createState()
      states.set(session, state)
      observe(session, state)
    }
    return state
  }

  /**
   * 会话级观察者：**不开流也要记的账**。
   *
   * 上一轮什么时候结束、成没成，是 `/monitor`（安卓后台提醒）与侧栏红点的唯一依据，
   * 而手机退到后台时根本没有 SSE 连接。所以这一份挂在会话自己身上：收口帧一到就落账，
   * 与谁在看无关。每帧该发什么仍然由各条连接自己的 `conn` 决定。
   */
  function observe(session, state) {
    watch(session, (frame) => {
      if (frame.t === 'status') {
        if (frame.status === 'running') state.turnOpen = true
        else if (frame.status === 'idle' || frame.status === 'error') closeTurn(session, state, frame.status)
      } else if (frame.t === 'exit') {
        closeTurn(session, state, 'error')
      }
    })
  }

  /** 这一轮收口（记账，幂等）：轮号取「这一轮实际是第几轮」，块表可能有攒批没同步的。 */
  function closeTurn(session, state, status) {
    if (!state.turnOpen) return
    state.turnOpen = false
    syncState(session, state)
    const turn = Math.max(1, state.turn)
    const failed = status === 'error'
    state.lastTurn = {
      turn,
      endedAt: Date.now(),
      status: failed ? 'failed' : 'completed',
      ...(failed ? { message: 'CLI 报错了' } : {}),
    }
  }

  function sessionOf(sessionId) {
    return isCliSessionId(sessionId) ? sessions.get(sessionId) || null : null
  }

  // ── 摘要（列表 / 详情共用一份投影） ────────────────────────────────────────

  function summaryOf(session) {
    const state = stateOf(session)
    syncState(session, state)
    const items = itemsOf(session, state)
    const blocks = session.blocks.list()
    return {
      sessionId: session.id,
      title: session.title,
      running: session.status === 'running',
      ...(session.permissionFrames.size > 0 ? { pendingInteraction: 'approval' } : {}),
      blank: !blocks.some((block) => block.kind === 'user'),
      cwd: session.cwd,
      // 侧栏按 workspaceId 分组：给不准就会把 CLI 会话扔进「未分组」。
      workspaceId: session.workspaceId,
      // 对话页「⋯ → 终端」靠这两格：哪个 CLI、在哪个目录。
      cliAgent: session.agentId,
      updatedAt: session.updatedAt || 0,
      // 置顶与宿主同一个字段：App 的行尾图钉读它（排序见 mergeList）。
      ...(state.pinned ? { pinned: true } : {}),
      lastMessage: lastMessageOf(items),
      ...(state.lastTurn ? { lastTurn: state.lastTurn } : {}),
      ...(session.status === 'error' ? { lastTurnError: { turn: state.lastTurn ? state.lastTurn.turn : 0, message: 'CLI 退出了' } } : {}),
    }
  }

  function itemsOf(session, state = stateOf(session)) {
    syncState(session, state)
    const out = []
    for (const block of session.blocks.list()) {
      if (block.kind === 'user') {
        out.push(userMessageOf(block, state))
        continue
      }
      const message = messageOf(block, state)
      if (message) out.push(message)
    }
    return out
  }

  // ── 帧：块表 / 状态 / 审批 → App 认的会话事件 ──────────────────────────────

  /**
   * 一条块变化 → 实时帧。
   *
   * 只有用户消息是「消息事件」；正文与工具走草稿（`assistant/chunk`），落定的版本在
   * `turn/end` 之后按稳定 id 补发（见 `settleTurn`）。
   */
  function onBlock(session, conn, block) {
    const state = stateOf(session)
    syncState(session, state)
    const turn = state.turnByBlock.get(block.id) || 0
    const index = state.blockIndex.get(block.id) || 0

    if (block.kind === 'user') {
      if (conn.emitted.has(block.id)) return
      conn.emitted.add(block.id)
      state.turnOpen = true
      conn.turnOpen = true
      conn.write({ type: 'turn/start', sessionId: session.id, seq: nextSeq(state), data: { turn } })
      conn.write({ type: 'user/message', sessionId: session.id, seq: nextSeq(state), data: userMessageOf(block, state) })
      return
    }

    if (block.kind === 'text' || block.kind === 'reasoning') {
      const full = textOf(block.text)
      const sent = conn.sent.get(block.id) || 0
      if (full.length <= sent) return
      conn.sent.set(block.id, full.length)
      conn.write({
        type: 'assistant/chunk',
        sessionId: session.id,
        data: {
          turn,
          step: 0,
          chunk: {
            index,
            type: block.kind === 'text' ? 'text-delta' : 'reasoning-delta',
            text: full.slice(sent),
          },
        },
      })
      // 收口的帧可能比「块落定」先到（status 立即广播、块是攒批发的）：这一轮已经结束的话，
      // 这块也要按消息补出去，否则正文只活在草稿里、turn/end 之后被清掉。
      if (!block.streaming && !state.turnOpen) emitSettled(session, conn, block, state, true)
      return
    }

    if (block.kind === 'tool') {
      const key = `${block.state}|${textOf(block.output)}|${textOf(block.argsRaw)}`
      const prev = conn.tool.get(block.id)
      if (prev === key) return
      conn.tool.set(block.id, key)
      const first = prev === undefined
      if (first) {
        conn.write({
          type: 'assistant/chunk',
          sessionId: session.id,
          data: {
            turn,
            step: 0,
            chunk: { index, type: 'tool-call-delta', id: block.callId, name: block.name || '', argumentsDelta: textOf(block.argsRaw) },
          },
        })
      }
      if (block.state === 'running' && !first) return
      conn.write({ type: 'assistant/chunk', sessionId: session.id, data: { turn, step: 0, chunk: { index, type: 'block-end' } } })
      if (block.state !== 'running') {
        conn.write({
          type: 'tool/result',
          sessionId: session.id,
          seq: nextSeq(state),
          data: {
            message: {
              source: { callId: block.callId },
              content: textOf(block.output) ? [{ type: 'text', text: block.output }] : [],
              isError: block.state === 'error',
            },
          },
        })
      }
      return
    }

    if (block.kind === 'notice') {
      // 提示块只当正文草稿流露一手；落定的那一份由 `turn/end` 之后的消息补上（见 settleTurn）。
      if (conn.emitted.has(block.id)) return
      conn.emitted.add(block.id)
      const text = textOf(block.text)
      if (!text) return
      conn.write({
        type: 'assistant/chunk',
        sessionId: session.id,
        data: { turn, step: 0, chunk: { index, type: 'text-delta', text: `${text}\n` } },
      })
    }
  }

  /**
   * 历史块 → 实时帧的块形状。
   *
   * 历史那一条是 App 的 `ChatMessage.blocks`（`callId` / `argsRaw`），而 SSE 的
   * `assistant/message` 要过 App 的 `parseChatBlocks`（宿主形状：`id` / `arguments`）。
   * 两种形状是同一件事的两套写法，发之前翻译一次；不转的话实时那条工具卡没有 callId，
   * 后面到的 `tool/result` 补丁就配不上它。
   */
  function wireBlocksOf(blocks) {
    return (blocks || []).map((block) => {
      if (block.type !== 'tool-call') return block
      return {
        type: 'tool-call',
        ...(block.callId ? { id: block.callId } : {}),
        ...(block.name ? { name: block.name } : {}),
        ...(block.argsRaw ? { arguments: block.argsRaw } : {}),
        ...(block.state ? { state: block.state } : {}),
        ...(block.output ? { output: block.output } : {}),
      }
    })
  }

  /** 一条块落定后补发 `assistant/message`（同一块只发一次；历史里同 id 的行与它合并）。 */
  function emitSettled(session, conn, block, state, force = false) {
    if (block.kind === 'user' || block.kind === 'plan') return
    if (conn.messaged.has(block.id)) return
    const message = messageOf(block, state, force)
    if (!message) return
    conn.messaged.add(block.id)
    conn.write({
      type: 'assistant/message',
      sessionId: session.id,
      seq: nextSeq(state),
      data: { message: { id: message.id, role: 'assistant', content: wireBlocksOf(message.blocks) } },
    })
  }

  /**
   * 一轮收口：先 `turn/end`，再把这一轮每个落定的块按稳定 id 发一条 `assistant/message`。
   *
   * 顺序是刻意的：App 在「当前回合」里收到 assistant/message 会就地再收一次尾，先发
   * turn/end 就只是「把这一轮的终局交出去」，不触发重复收尾。
   */
  function settleTurn(session, conn, reason) {
    const state = stateOf(session)
    // 这一轮在**这条连接**上开着才算要收尾：没有连接看着的时候，账由会话级观察者落。
    if (!conn.turnOpen) return
    conn.turnOpen = false
    syncState(session, state)
    closeTurn(session, state, reason === 'error' ? 'error' : 'idle')
    const turn = Math.max(1, state.turn)
    conn.write({
      type: 'turn/end',
      sessionId: session.id,
      seq: nextSeq(state),
      data: { turn, reason: { kind: reason === 'error' ? 'error' : 'completed' } },
    })
    syncState(session, state)
    // `force`：service 里「块落定」与「状态变 idle」是两条广播，快照里的 streaming 标记
    // 可能还没跟上。这一轮已经结束了，正文按当前内容落定，别再等下一次块帧。
    for (const block of session.blocks.list()) emitSettled(session, conn, block, state, true)
  }

  function onStatus(session, conn, status) {
    if (status === 'running') {
      // 记账那半由会话级观察者做；这里只认这一轮在**这条连接**上开着（块帧可能还在攒批）。
      stateOf(session).turnOpen = true
      return
    }
    if (status === 'idle' || status === 'error') settleTurn(session, conn, status === 'error' ? 'error' : 'done')
  }

  function approvalFrameOf(session, request) {
    return {
      type: 'approval/requested',
      sessionId: session.id,
      rpcId: rpcIdOf(request),
      approvalId: request.id,
      toolName: request.title,
      ...(request.detail ? { reason: request.detail } : {}),
    }
  }

  function rpcIdOf(request) {
    return `cli:${request.id}`
  }

  /** 一条会话产生的帧 → 这个连接的写入。返回解绑函数。 */
  function attach(session, write) {
    const conn = {
      write,
      sent: new Map(),
      tool: new Map(),
      emitted: new Set(),
      /** 已经按 id 发过楼定消息的块：历史里已有它们，别重发。 */
      messaged: new Set(),
      /** 这条连接上「这一轮」开着没有（帧该不该发只看它，记账在会话级观察者里）。 */
      turnOpen: false,
    }
    const state = stateOf(session)
    syncState(session, state)
    // 接上时补「正在发生的那一轮」：还在流的正文按**当前全量**当一段增量发出去（历史里
    // 没有它），这样页面重进 / 断线重连回来能接着看，而落定的旧内容靠历史铺。
    if (state.turnOpen) {
      conn.turnOpen = true
      write({ type: 'turn/start', sessionId: session.id, seq: nextSeq(state), data: { turn: Math.max(1, state.turn) } })
    }
    for (const block of session.blocks.list()) {
      if ((block.kind === 'text' || block.kind === 'reasoning') && block.streaming && textOf(block.text)) {
        const index = state.blockIndex.get(block.id) || 0
        conn.sent.set(block.id, block.text.length)
        write({
          type: 'assistant/chunk',
          sessionId: session.id,
          data: {
            turn: state.turnByBlock.get(block.id) || 0,
            step: 0,
            chunk: { index, type: block.kind === 'text' ? 'text-delta' : 'reasoning-delta', text: block.text },
          },
        })
      }
      if (block.kind === 'tool') conn.tool.set(block.id, `${block.state}|${textOf(block.output)}|${textOf(block.argsRaw)}`)
      if (block.kind === 'user' || block.kind === 'notice') conn.emitted.add(block.id)
      // 落定的块历史里已经有了：接上时不再按消息补一遍，避免同一段话画两遍。
      if (block.kind !== 'user' && block.kind !== 'plan' && !block.streaming) conn.messaged.add(block.id)
    }
    for (const request of session.permissionFrames.values()) {
      approvals.set(rpcIdOf(request), { sessionId: session.id, requestId: request.id })
      write(approvalFrameOf(session, request))
    }
    const unwatch = watch(session, (frame) => {
      if (frame.t === 'block') onBlock(session, conn, frame.block)
      else if (frame.t === 'status') onStatus(session, conn, frame.status)
      else if (frame.t === 'title') write({ type: 'session/title', sessionId: session.id, seq: nextSeq(state), data: { title: frame.title } })
      else if (frame.t === 'permission') {
        approvals.set(rpcIdOf(frame.request), { sessionId: session.id, requestId: frame.request.id })
        write(approvalFrameOf(session, frame.request))
      } else if (frame.t === 'permission-resolved') {
        approvals.delete(`cli:${frame.id}`)
        write({ type: 'approval/resolved', sessionId: session.id, approvalId: frame.id })
      } else if (frame.t === 'exit') {
        settleTurn(session, conn, 'error')
      }
    })
    // 会话已经退出过的：把结局当场说清楚，页面不会一直转圈。
    if (session.status === 'error' && !state.turnOpen) {
      write({ type: 'session/heartbeat', sessionId: session.id, at: Date.now() })
    }
    return () => {
      unwatch()
      conn.sent.clear()
    }
  }

  /**
   * CLI 会话的「导出日志」：没有宿主的会话日志可导（那本账是宿主记的），但这条入口
   * 挂在对话页的「⋯」里，报错就会变成一张错误卡。回一份合法的空 ZIP，App 正常落盘。
   */
  function handleExport(session, req, res) {
    // 空 ZIP 的 EOCD：`PK\x05\x06` + 18 个 0。只有 22 字节，不需要任何压缩库。
    const empty = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)])
    const filename = `dsh-session-${String(session.id).replace(/[^A-Za-z0-9_-]/g, '_')}.zip`
    const opened = req && req.__dshE2ee
    if (opened && opened.keys && opened.req) {
      res.writeHead(200, chunksHeaders({
        'content-disposition': `attachment; filename="${filename}"`,
        'x-dsh-content-type': 'application/zip',
      }))
      void pipeEncrypted(req, res, Readable.from([empty]))
      return
    }
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
      'content-length': String(empty.length),
      'cache-control': 'no-store',
      'content-encoding': 'identity',
    })
    res.end(empty)
  }

  // ── 各端点 ──────────────────────────────────────────────────────────────

  function sendJsonQuiet(res, body) {
    sendJson(res, 200, { ok: true, ...body })
  }

  function handlersOf(session, path, req, res, body) {
    const state = stateOf(session)
    switch (path) {
      case '/session':
        sendJsonQuiet(res, {
          session: {
            sessionId: session.id,
            cwd: session.cwd,
            title: session.title,
            blank: !session.blocks.list().some((block) => block.kind === 'user'),
            lastSeq: stateOf(session).seq,
            lastMessage: lastMessageOf(itemsOf(session)),
          },
        })
        return
      case '/session/head':
        // 不知道就老实说不知道：App 会退回整份拉取，比给一个假水位便宜。
        sendJsonQuiet(res, { seq: 0, known: false })
        return
      case '/session/messages': {
        // 游标一律不认：App 手上的 `afterSeq` 是**实时事件序号**，而这里的 `seq` 是块表
        // 顺序号（两个空间）。CLI 会话本来就短，整份给回去由 App 按 id 合并，比按一个
        // 对不上的游标过滤安全。
        const items = itemsOf(session)
        sendJsonQuiet(res, {
          items,
          hasMore: false,
          lastSeq: stateOf(session).seq,
          ...(items.length ? { oldestSeq: items[0].seq } : {}),
        })
        return
      }
      case '/session/stats':
        sendJsonQuiet(res, { projections: {} })
        return
      case '/session-log':
        handleExport(session, req, res)
        return
      case '/session/models':
        sendJson(res, 200, modelsBodyOf(session))
        return
      case '/session/select-model': {
        void applyModelChoice(session, body)
        sendJsonQuiet(res, {})
        return
      }
      case '/session/model-option':
        void applyModelOption(session, body)
        sendJsonQuiet(res, {})
        return
      case '/commands':
        sendJsonQuiet(res, { items: (session.commands || []).map((command) => ({
          name: command.name,
          description: command.description,
          ...(command.hint ? { input: { hint: command.hint } } : {}),
        })) })
        return
      case '/skills':
        sendJsonQuiet(res, { skills: [] })
        return
      case '/session/search':
        sendJsonQuiet(res, { items: [], hasMore: false })
        return
      case '/session/references':
      case '/file-references':
      case '/session-references':
        sendJsonQuiet(res, { items: [] })
        return
      case '/session/read':
        // 与宿主那条同口径：读过之后这一轮就不再算「刚完成」，后台不该再为它响。
        state.readAt = Date.now()
        sendJsonQuiet(res, {})
        return
      case '/session/queue/update':
      case '/session/attachment':
        sendJsonQuiet(res, {})
        return
      case '/session/goal':
        sendJsonQuiet(res, {})
        return
      case '/session/delivery':
        sendJsonQuiet(res, { delivered: false })
        return
      case '/session/rename': {
        const title = textOf(body && body.title).trim()
        if (title) setTitle(session, title)
        sendJson(res, 200, { ok: true, title: title || session.title, seq: 0 })
        return
      }
      case '/session/fork':
        // CLI 会话没有可分叉的宿主日志：回一个「还在这条」的成功，页面不会被错误卡挡住。
        sendJson(res, 200, { ok: true, sessionId: session.id })
        return
      case '/session/stop':
        cancelTurn(session)
        sendJson(res, 200, { ok: true, accepted: true })
        return
      case '/session/send': {
        const message = textOf(body && body.text) || textOfContent(body && body.content)
        if (!message) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '这一发没有正文' } })
        const result = runPrompt(session, message)
        if (!result.ok) return sendJson(res, 409, { ok: false, error: { code: 'cli-busy', message: result.error || '这一轮还没结束' } })
        sendJson(res, 200, { ok: true, accepted: true })
        return
      }
      case '/session/step':
        sendJsonQuiet(res, { step: { kind: textOf(queryOf(req).get('kind')) || 'tool', text: '' } })
        return
      case '/subagents':
        sendJsonQuiet(res, { entries: [], parentAvailable: true })
        return
      case '/extension-cards':
        sendJsonQuiet(res, { cards: [] })
        return
      default:
        sendJsonQuiet(res, {})
    }
  }

  async function applyModelChoice(session, body) {
    if (!session.handle || !body) return
    const model = textOf(body.model)
    const options = Array.isArray(session.configOptions) ? session.configOptions : []
    const modelOption = options.find((option) => option && option.category === 'model')
      || options.find((option) => option && typeof option.id === 'string' && /model/i.test(option.id))
    try {
      if (model && modelOption) await session.handle.setConfigOption(modelOption.id, model)
      const effort = textOf(body.reasoningEffort)
      if (effort) {
        const effortOption = options.find((option) => option && typeof option.id === 'string' && /thought|reasoning|effort/i.test(`${option.id} ${textOf(option.name)}`))
        if (effortOption) await session.handle.setConfigOption(effortOption.id, effort)
      }
    } catch { /* 选不动就维持原样：下一次读 models 会回真实值 */ }
  }

  async function applyModelOption(session, body) {
    if (!session.handle || !body) return
    try {
      const optionId = textOf(body.optionId) || textOf(body.id)
      if (optionId) await session.handle.setConfigOption(optionId, body.value)
    } catch { /* 同上 */ }
  }

  function textOfContent(content) {
    if (!Array.isArray(content)) return ''
    return content.filter((block) => block && block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n').trim()
  }

  // ── 路由层要的两个入口 ────────────────────────────────────────────────────

  /**
   * 会话域端点的一次分派：`sessionId` 是 `cli-*` 就交给这里，否则原样交回原 handler。
   *
   * `sessionId` 在 GET 的查询串、POST 的请求体里。POST 要先读一次体 —— 读到的对象挂回
   * `req.body`（`readJsonBody` 认它），原 handler 再读是零成本的，请求流不会被读空两次。
   */
  function route(path, fallback) {
    return async (ctx, req, res) => {
      const method = String((req && req.method) || 'GET').toUpperCase()
      let sessionId = null
      let body = null
      if (method === 'GET' || method === 'HEAD') {
        sessionId = queryOf(req).get('sessionId')
      } else {
        body = await readJsonBody(req, BODY_MAX)
        if (!body || typeof body !== 'object') {
          // 请求体读不出来（不是 JSON / 超限）：与各 handler 自己的判定同口径回一句人话。
          return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '请求体不是合法的 JSON' } })
        }
        req.body = body
        sessionId = body.sessionId
      }
      if (!isCliSessionId(sessionId)) return fallback(ctx, req, res)
      const session = sessionOf(sessionId)
      if (!session) {
        // 会话已经不在了（宿主重启 / 用户收掉）：正文类接口回空，动作类接口回人话，
        // 别把 App 的对话页整屏变成错误卡。
        if (method === 'GET') return sendJsonQuiet(res, { items: [], hasMore: false, lastSeq: 0, skills: [], steps: [] })
        return sendJson(res, 404, { ok: false, error: { code: 'cli-session-not-found', message: '这条 CLI 会话已经不在了' } })
      }
      return handlersOf(session, path.replace(/^\/api\/mobile\/v1/, ''), req, res, body)
    }
  }

  /**
   * `/sessions`：宿主列表照原样构建，把还活着的 CLI 会话并进去。
   *
   * `archivedOnly` 与宿主那条 `?archived=1` 的语义**逐字一致**：默认视图里归档的不出现，
   * 归档视图里只出现归档的。两边的账各记各的（宿主那本在 workspace 注册表，CLI 这本在
   * 这里的会话状态上），但视图规则只有一条。
   */
  function mergeList(body, archivedOnly = false) {
    if (!body || body.ok !== true) return body
    const items = Array.isArray(body.items) ? body.items : null
    // `unchanged` 那一份没有 items：CLI 会话是活的（运行态会变），不能回「没变」。
    if (!items) return body
    const mine = []
    for (const session of sessions.values()) {
      const state = stateOf(session)
      if (state.archived !== archivedOnly) continue
      mine.push(summaryOf(session))
    }
    // 置顶的排最前（宿主那边置顶就是排在各工作区最前）；其余按最近更新，排在宿主那批后面
    // —— 宿主行有自己的工作区顺序，不该被 CLI 行整批顶到后面。
    mine.sort((a, b) => (Number(b.pinned === true) - Number(a.pinned === true)) || (b.updatedAt - a.updatedAt))
    const pinned = mine.filter((item) => item.pinned === true)
    const rest = mine.filter((item) => item.pinned !== true)
    const merged = [...pinned, ...items, ...rest]
    return {
      ...body,
      items: merged,
      revision: listRevision(merged),
      emptyConfirmed: merged.length === 0,
    }
  }

  /** `/sessions` 的处理器包装：接住原 handler 的 JSON，合并后自己写出去。 */
  function wrapSessions(handler) {
    return async (ctx, req, res) => {
      // 一条 CLI 会话都没有时（绝大多数手机、绝大多数时间）：原样交给宿主那条，不接响应、
      // 不重算 revision —— 合并只在真有行要并进来时才值得付那一次反序列化。
      if (sessions.size === 0) return handler(ctx, req, res)
      const url = new URL(req.url || '/', 'http://x')
      const archivedOnly = url.searchParams.get('archived') === '1'
      // 条件刷新那一发只带 revision、不带 items，合并就没法做：去掉 rev 让原 handler
      // 构建整份（10 秒缓存照样在），CLI 行才不会被一句 unchanged 吞掉。
      if (url.searchParams.has('rev')) {
        url.searchParams.delete('rev')
        req.url = `${url.pathname}${url.search}`
      }
      const captured = capture(res)
      await handler(ctx, req, captured.res)
      if (!captured.done) return
      sendJson(res, captured.status || 200, mergeList(captured.body, archivedOnly))
    }
  }

  function capture(res) {
    const box = { done: false, status: 200, body: null, headers: null }
    const proxy = Object.create(res)
    proxy.writeHead = (status, headers) => { box.status = status; box.headers = headers || null; return proxy }
    proxy.end = (chunk) => {
      box.done = true
      box.body = decodeBody(chunk, box.headers)
      return proxy
    }
    proxy.write = () => true
    box.res = proxy
    return box
  }

  /**
   * 接住原 handler 写出来的 JSON。
   *
   * 客户端声明了 `accept-encoding: gzip` 时 `sendJson` 会真的压：列表是几十 KB 的那一档，
   * 明文解析不出来 —— 那不是「没有 items」，而会在合并时被当成坏响应丢掉。
   */
  function decodeBody(chunk, headers) {
    try {
      if (chunk === undefined || chunk === null) return null
      let text = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
      const encoding = headers && typeof headers['content-encoding'] === 'string' ? headers['content-encoding'] : ''
      if (/gzip/i.test(encoding)) text = require('node:zlib').gunzipSync(text)
      return JSON.parse(text.toString('utf8'))
    } catch {
      return null
    }
  }

  /**
   * `/approval/respond`：rpcId 是这里铸的（`cli:<requestId>`）就答 ACP，否则交回宿主那条。
   */
  function wrapApprovalRespond(fallback) {
    return async (ctx, req, res) => {
      const body = await readJsonBody(req, BODY_MAX)
      if (body && typeof body === 'object') req.body = body
      const rpcId = textOf(body && body.rpcId)
      const pending = approvals.get(rpcId)
      if (!pending) return fallback(ctx, req, res)
      const session = sessionOf(pending.sessionId)
      const request = session && session.permissionFrames.get(pending.requestId)
      if (!session || !request) {
        approvals.delete(rpcId)
        return sendJson(res, 409, { ok: false, error: { code: 'approval-not-pending', message: '这条审批已经不在了' } })
      }
      const optionId = chooseOption(request, textOf(body.outcome))
      if (!optionId) return sendJson(res, 409, { ok: false, error: { code: 'approval-not-pending', message: '这张卡没有可选答案' } })
      answerPermission(session, request.id, optionId)
      approvals.delete(rpcId)
      sendJson(res, 200, { ok: true, accepted: true })
    }
  }

  // ── 归档 / 置顶 / 清空归档：CLI 会话自己记账 ──────────────────────────────

  /**
   * 四条 `workspace/*-session` 的分派。
   *
   * 宿主那本账（`workspace.list` 的 archivedSessionIds / pinnedSessionIds）里没有 CLI 会话，
   * 原样透过去只会换回一张错误卡。这里只改会话自己那份状态，`/sessions` 的投影跟着走：
   * 归档的只在 `?archived=1` 那一路出现，置顶的排最前（见 `mergeList`）。
   */
  function routeFlag(kind, fallback) {
    return async (ctx, req, res) => {
      const body = await readJsonBody(req, BODY_MAX)
      if (!body || typeof body !== 'object') {
        return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '请求体不是合法的 JSON' } })
      }
      req.body = body
      if (!isCliSessionId(body.sessionId)) return fallback(ctx, req, res)
      const session = sessionOf(body.sessionId)
      // 会话已经被收掉了：这个动作本身是幂等的，按成功回，App 不必弹错。
      if (!session) return sendJson(res, 200, { ok: true })
      const state = stateOf(session)
      if (kind === 'archive') state.archived = true
      else if (kind === 'unarchive') state.archived = false
      else if (kind === 'pin') state.pinned = true
      else if (kind === 'unpin') state.pinned = false
      sendJson(res, 200, { ok: true })
    }
  }

  /** 还有没有归档着的 CLI 会话（`/workspace/clear-archived` 决定要不要掺和）。 */
  function hasArchived() {
    for (const session of sessions.values()) {
      if (stateOf(session).archived) return true
    }
    return false
  }

  /**
   * `POST /workspace/clear-archived`：宿主那半照原逻辑删它那本账，CLI 这半把归档的会话
   * 直接收掉（`forget`）—— CLI 没有磁盘日志可清，收掉进程、从列表里消失就是「清理」。
   * 回包的 `deleted` 把两边加起来，App 那边看到的数字才对得上它刚才点了什么。
   */
  function wrapClearArchived(handler) {
    return async (ctx, req, res) => {
      if (!hasArchived()) return handler(ctx, req, res)
      const captured = capture(res)
      await handler(ctx, req, captured.res)
      if (!captured.done || !captured.body) return
      if (captured.status !== 200 || captured.body.ok !== true) {
        return sendJson(res, captured.status || 200, captured.body)
      }
      let cleared = 0
      for (const session of [...sessions.values()]) {
        if (!stateOf(session).archived) continue
        forget(session.id)
        cleared += 1
      }
      const deleted = Number(captured.body.deleted)
      sendJson(res, 200, { ...captured.body, deleted: (Number.isSafeInteger(deleted) ? deleted : 0) + cleared })
    }
  }

  /**
   * `/monitor` 里要并进去的那几条（安卓后台提醒服务读的那份视图）。
   *
   * 字段与宿主那套逐字一致（sessionId / title / running / completed / pendingInteraction /
   * pendingCard / lastTurn / lastTurnError），不新增接口、不改出口形状。归档的不进提醒
   * —— 与宿主那条 `!archived.has()` 同一条判据。
   */
  function monitorItems() {
    const out = []
    for (const session of sessions.values()) {
      const state = stateOf(session)
      if (state.archived) continue
      syncState(session, state)
      const items = itemsOf(session, state)
      const running = session.status === 'running'
      const last = state.lastTurn
      // 「刚完成」按设备算：这一轮结束在这台手机读过之后才算新。
      const settled = last != null && last.endedAt > (state.readAt || 0)
      const item = {
        sessionId: session.id,
        title: session.title,
        running,
        completed: Boolean(last && !running && last.status === 'completed' && settled),
      }
      if (session.permissionFrames.size > 0) {
        item.pendingInteraction = 'approval'
        const request = [...session.permissionFrames.values()][0]
        if (request) item.pendingCard = approvalFrameOf(session, request)
      } else {
        // 显式 null 是「这台宿主认识这一格」的记号，原生靠它撤掉已经答掉的旧卡。
        item.pendingCard = null
      }
      if (last) {
        const failed = last.status === 'failed' && settled
        item.lastTurn = {
          turn: last.turn,
          endedAt: last.endedAt,
          status: last.status,
          ...(last.status === 'failed' ? { code: null, message: last.message ?? null } : {}),
        }
        if (failed) item.lastTurnError = { turn: last.turn, code: null, message: last.message ?? null }
      }
      // 横幅正文只给「可能要提醒」的那几条补一句，与宿主那份同一个判据。
      if (item.completed || item.lastTurnError || item.pendingInteraction) {
        const preview = lastMessageOf(items)
        if (preview && preview.role === 'assistant' && preview.text) {
          item.lastMessage = { role: 'assistant', text: preview.text.slice(0, 200) }
        }
      }
      out.push(item)
    }
    return out
  }

  // ── SSE：给 CLI 会话发一份与宿主同形状的流 ────────────────────────────────

  function handleStream(ctx, req, res) {
    const sessionId = queryOf(req).get('sessionId')
    const session = sessionOf(sessionId)
    if (!session) {
      return sendJson(res, 404, { ok: false, error: { code: 'cli-session-not-found', message: '这条 CLI 会话已经不在了' } })
    }
    const sealFrame = createFrameSealer(req)
    const head = {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'content-encoding': 'identity',
      ...(sealFrame ? { 'x-dsh-proto': '2' } : {}),
    }
    try {
      res.writeHead(200, head)
    } catch {
      return
    }
    res.write(': connected\n\n')
    const untrack = streamRegistry.track(req.__dshRecord && req.__dshRecord.deviceId, res)
    let closed = false
    let detach = () => {}
    const teardown = () => {
      if (closed) return
      closed = true
      clearInterval(keepAlive)
      detach()
      untrack()
      try { res.end() } catch { /* 已经走了 */ }
    }
    const write = (payload) => {
      if (closed) return null
      const sent = writeSse(res, payload, { sealFrame, padding: ssePadding(SSE_PADDING_BYTES) })
      if (!sent.ok) { teardown(); return null }
      if (sent.needDrain) waitForDrain(res, new AbortController().signal).catch(() => {})
      return payload
    }
    const keepAlive = setInterval(() => {
      const sent = writeSse(res, { type: 'session/heartbeat', sessionId: session.id, at: Date.now() }, { sealFrame })
      if (!sent.ok) teardown()
    }, HEARTBEAT_MS)
    if (keepAlive && typeof keepAlive.unref === 'function') keepAlive.unref()
    res.on('close', teardown)
    res.on('error', teardown)
    detach = attach(session, write)
  }

  function chooseOption(request, outcome) {
    const options = Array.isArray(request.options) ? request.options : []
    if (options.length === 0) return ''
    const wantAllow = outcome !== 'rejected'
    const matched = options.find((option) => {
      const kind = textOf(option.kind)
      return wantAllow ? kind.startsWith('allow') : kind.startsWith('reject')
    })
    return (matched || options[0]).optionId
  }

  return {
    route,
    routeFlag,
    wrapSessions,
    wrapClearArchived,
    wrapApprovalRespond,
    handleStream,
    monitorItems,
    summaryOf,
    itemsOf,
    modelsBodyOf,
    isCliSessionId,
  }
}

module.exports = { createCliMobile, isCliSessionId, CLI_PREFIX }

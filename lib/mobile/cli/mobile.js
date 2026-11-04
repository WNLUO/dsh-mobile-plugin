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

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const { Readable } = require('node:stream')
const { readJsonBody, sendJson } = require('../../shared/http-util')
const { chunksHeaders, pipeEncrypted } = require('../../shared/e2ee-chunks.js')
const { listRevision } = require('../../shared/list-revision.js')
const { listSignal } = require('../../shared/list-signal.js')
const { writeSse, waitForDrain, ssePadding } = require('../../shared/sse-write.js')
const streamRegistry = require('../stream-registry.js')
const { createFrameSealer } = require('../stream.js')
const { imageBlockOf, metaOf, openImage, saveImage, MAX_IMAGE_BYTES, MEDIA_EXT } = require('./images.js')
const { resolveFinishedUpload } = require('../uploads.js')
const { rememberModel } = require('./model-prefs.js')
const { statsOf } = require('./usage.js')
const { hiddenOf, setVisible } = require('./model-visibility.js')
const { lookupModelMeta } = require('../model-meta.js')
const { identifyVendor, vendorLogoOf } = require('../model-vendors.js')

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
     * 这一份会话自己那本账：置顶。
     *
     * 宿主那本账里没有 CLI 会话（它本来就不是宿主会话），所以 `workspace/*-session` 这几条
     * 动作在这一层自己记。**代价：账活在宿主进程内存里，DSH 重启就没了** —— 但那跟 CLI
     * 会话本身（ACP 子进程、块表、审批挂起项）一起没，不是缺陷，别为它落盘。
     *
     * **没有归档这一格**：「归档」在这条链上等于关掉那条 CLI，会话对象直接没了，没有第二档
     * 状态要记（见 `routeFlag`）。
     */
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

/**
 * 用户消息：正文 + 这一发带的图片。
 *
 * 图片两种形状都要给：`images`（历史项直接用，气泡读它）与 `blocks` 里的 image 块（实时帧
 * 走 App 的 `messageFromEvent`，它按内容块提图）。只给一种的话，同一张图会「重进会话看得见、
 * 刚发出去那一下看不见」，或者反过来。
 */
function userMessageOf(block, state) {
  const turn = state.turnByBlock.get(block.id) || 0
  const text = textOf(block.text)
  const imageBlocks = (Array.isArray(block.images) ? block.images : [])
    .map((meta) => imageBlockOf(meta))
    .filter(Boolean)
  const images = imageBlocks.map((image) => ({
    mediaType: image.mediaType,
    attachmentId: image.attachment.attachmentId,
    ...(image.name ? { name: image.name } : {}),
    ...(image.width && image.height ? { width: image.width, height: image.height } : {}),
  }))
  return {
    id: block.id,
    role: 'user',
    text,
    blocks: [...imageBlocks, ...(text ? [{ type: 'text', text }] : [])],
    ...(images.length ? { images } : {}),
    seq: (state.blockIndex.get(block.id) || 0) + 1,
    time: block.at,
    ...(turn > 0 ? { turn } : {}),
  }
}

/**
 * 计划 → `stats` 的 `todos` 投影（TodoDock 的数据源）。
 *
 * ACP 的 `plan` 事件是**整表替换**，块表里因此永远只有一条 `kind === 'plan'` 的块，它的
 * `steps` 就是当前这份计划。没有计划事件就回空对象 —— 不造一份空计划，那会让计划条以
 * 「0 / 0」的形式挂出来。
 */
function planProjection(session) {
  const plan = (session.blocks.list() || []).find((block) => block && block.kind === 'plan')
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : []
  if (steps.length === 0) return {}
  return {
    todos: steps.map((step) => ({
      content: textOf(step.text),
      status: step.status === 'completed' ? 'completed' : step.status === 'in_progress' ? 'in_progress' : 'pending',
    })).filter((item) => item.content),
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
 * 两个退化档必须分开，这一条是被真机坑出来的（2026-11-04 用户报「模型一直出不来」）：
 *
 *   - **进程还在 `starting`**：适配器没握手完，`configOptions` 必然是空数组，此刻**不知道**
 *     有哪些模型。所以回 `routable:false` + 空目录，一枚占位都不给。给一份 `default` 会被
 *     App 当成真目录写进缓存，那个会话之后 20 秒都只会显示 `default` —— 而适配器其实一秒
 *     就起来了（本机实测 opencode 约 0.9s，codex / claude 首次还要 npx 下载）。
 *   - **握手已经成功、这家 CLI 确实没声明模型项**：给一枚当前 CLI 名的占位。这说的是真话，
 *     芯片打开时不该是一片红字。
 */
function modelsBodyOf(session) {
  const options = Array.isArray(session.configOptions) ? session.configOptions : []
  const modelOption = options.find((option) => option && option.category === 'model')
    || options.find((option) => option && typeof option.id === 'string' && /model/i.test(option.id))
  const listed = modelOption && Array.isArray(modelOption.options) ? modelOption.options : []
  const hidden = hiddenOf(session.agentId)
  const hiddenModels = new Set(hidden.models)
  const hiddenGroups = new Set(hidden.configs)
  const vendors = {}
  const models = listed
    .filter((item) => item && item.value !== undefined)
    .map((item) => {
      const id = String(item.value)
      const shown = modelLabelOf(id, textOf(item.name))
      // 能不能读图：ACP 的选项里没有这一格，只有名字。公开参数表（`model-meta`）按名字查得到，
      // 查不到就**不给这一格**（三态，别写成 false —— 那会让 App 拒掉一张其实是能看的图）。
      const vision = visionOfModel(shown.name || id, id)
      // 厂商：与宿主那套模型目录共用同一个识别器（`model-vendors.js`），所以这一页的徽标
      // 与首页那台设备的模型列表长得一样。认不出就不给，App 退回首字母。
      const vendor = identifyVendor({ modelName: shown.name, model: id, providerName: session.label, provider: session.agentId })
      if (vendor) {
        const logo = vendorLogoOf(vendor)
        if (logo) vendors[vendor] = logo
      }
      // 这一条属于哪一组（模型 id 里斜杠前那一段），以及用户有没有把它关掉。
      // `hidden` 只交给 App 的展示层过滤：管理页要能看见全部，选择器只画没关的。
      const group = id.includes('/') ? id.slice(0, id.indexOf('/')) : ''
      return {
        id,
        name: shown.name || id,
        ...(shown.tag ? { tag: shown.tag } : {}),
        ...(group ? { group } : {}),
        ...(vendor ? { vendor } : {}),
        ...(textOf(item.description) ? { description: textOf(item.description) } : {}),
        ...(vision === undefined ? {} : { vision }),
        ...(hiddenModels.has(id) || (group && hiddenGroups.has(group)) ? { hidden: true } : {}),
      }
    })
  // 还没起来：老实说「现在还不知道」，别给一份会被当成真目录的占位（见上面那段）。
  if (session.status === 'starting') {
    return {
      ok: true,
      current: { provider: session.agentId, model: '' },
      routable: false,
      groups: [],
      pending: true,
      failures: [],
    }
  }
  if (models.length === 0) models.push({ id: 'default', name: session.label || 'CLI' })
  const current = modelOption && modelOption.currentValue !== undefined
    ? String(modelOption.currentValue)
    : models[0].id
  const chosen = models.find((item) => item.id === current)
  // 档位与其它会话级下拉：ACP 把它们与模型并列给（`thought_level` / `mode` / `model_config`），
  // App 那边认的是「挂在模型上的档位」+「一排附加选项行」，所以在这里换形状。
  //
  // 档位摊到**每一个**模型上：ACP 的档位是会话级的，换模型不会重置它，摊上去就与真实现状一致。
  // 其它项（模式 / 协作模式 / 快速档）交给 `options` 那排 —— App 早已会画、也会写回。
  const thought = thoughtOptionOf(options)
  const reasoning = reasoningOf(thought)
  if (reasoning) for (const model of models) model.reasoning = reasoning
  const rows = []
  for (const option of options) {
    if (!option || option === modelOption) continue
    if (reasoning && option === thought) continue
    if (option.category === 'model') continue
    const row = optionRowOf(option)
    if (row) rows.push(row)
  }
  return {
    ok: true,
    current: {
      provider: session.agentId,
      model: current,
      ...(reasoning && thought && thought.currentValue !== undefined ? { reasoningEffort: String(thought.currentValue) } : {}),
    },
    routable: true,
    groups: [{ id: session.agentId, name: session.label || 'CLI', models }],
    ...(rows.length ? { options: rows } : {}),
    ...(Object.keys(vendors).length ? { vendors } : {}),
    // 当前这个模型认不认图：App 发图前靠它拦一句人话，而不是把图发过去让模型自己说「我看不到」。
    ...(chosen && typeof chosen.vision === 'boolean' ? { currentVision: chosen.vision } : {}),
    failures: [],
  }
}

/**
 * 模型名去掉那层「渠道前缀」，剩下的才是模型自己。
 *
 * opencode 给的名字是 `OpenCode Go/DeepSeek V4.1 Flash`、`OpenCode/Big Pickle` —— 斜杠前
 * 是它自己的渠道（带 `Go` 的是订阅那一档），后面才是模型。原样铺在列表里，每一行都以
 * 同一个词开头，厂商徽标也就认不出来了（全都命中 `opencode` 那个词）；把前缀去掉之后
 * 名字直接就是模型名，识别照旧走 `model-vendors.js`（2026-11-04 用户要求）。
 *
 * 前缀不丢，转成后面那枚小标签（`tag`）：**「Go 订阅」这一档还要能分出来**，只是不该占着
 * 名字的位置。判定只看斜杠前那一段，取它最后一块（`OpenCode Go` → `Go`）；与 CLI 自己的
 * 名字完全相同的那一段（`OpenCode/`）是「默认渠道」，不挂标签 —— 那种前缀什么也没多说。
 *
 * 别家 CLI 的名字里带斜杠也会走这里：名字里本来就有斜杠、却不像 `渠道/模型` 的（两边有空格、
 * 或者前缀里有多个词且不认识）时原样留着 —— 猜错前缀比留着前缀难看得多。
 */
function modelLabelOf(id, name) {
  const raw = textOf(name) || id
  const at = raw.indexOf('/')
  if (at <= 0) return { name: raw, tag: '' }
  const prefix = raw.slice(0, at).trim()
  const rest = raw.slice(at + 1).trim()
  if (!prefix || !rest) return { name: raw, tag: '' }
  // 前缀的**第一段**是 CLI 自己的名字时才算渠道前缀（`OpenCode Go` / `OpenCode`）；
  // 其余一切（`Some Vendor/Model`、`A/B`）原样留着 —— 猜错前缀比留着前缀难看得多。
  const words = prefix.split(/\s+/).filter(Boolean)
  const head = words[0] || ''
  const agentish = /^(opencode|codex|claude|gemini|cline|copilot|qwen|cursor|amp|kiro)$/i
  if (!agentish.test(head)) return { name: raw, tag: '' }
  // 剩下的那几段才是要留成标签的东西（`Go` = 订阅那一档）；没有就什么都不挂。
  return { name: rest, tag: words.slice(1).join(' ') }
}

/**
 * 名字 → 能不能读图。三态：`true` / `false` / `undefined`（公开库里没有这条）。
 *
 * **查到但没有视觉标记 = 不能读图**（`false`），不是「不知道」。公开参数表里 `i:1` 才是
 * 「能读图」，一行查到了却没这个标记，就是说得清清楚楚的「它不认图」—— 2026-11-04 现场
 * 就是这一格弄反了：默认的 `Big Pickle` 在表里查得到、没有视觉标记，被当成「不知道」放行，
 * 于是图发过去、模型回一句「我看不到」，用户看到的是「发了但没反应」。
 *
 * 只有**整条查不到**才是 `undefined`：那种情况放行，别替一个陌生模型拒掉它也许能看的图。
 */
function visionOfModel(name, id) {
  const meta = lookupModelMeta(name) || lookupModelMeta(id)
  if (!meta) return undefined
  return meta.vision === true
}

/**
 * 当前选中的模型能不能读图。三态，判据同 `visionOfModel`。
 *
 * 只用来在**发图之前**拦一句人话。`undefined`（公开库里没这条）放行 —— 替模型拒一张它其实
 * 能看的图，比让它自己说一句「我看不到」更糟（后者用户至少能换个模型立刻重发）。
 */
function currentVisionOf(session) {
  const options = Array.isArray(session.configOptions) ? session.configOptions : []
  const modelOption = options.find((option) => option && option.category === 'model')
    || options.find((option) => option && typeof option.id === 'string' && /model/i.test(option.id))
  const listed = modelOption && Array.isArray(modelOption.options) ? modelOption.options : []
  const current = modelOption && modelOption.currentValue !== undefined
    ? String(modelOption.currentValue)
    : (listed[0] && listed[0].value !== undefined ? String(listed[0].value) : '')
  const entry = listed.find((item) => item && item.value !== undefined && String(item.value) === current)
  if (!entry) return undefined
  // 与 `modelsBodyOf` 同一条口径：查表用的是去掉渠道前缀之后的模型名。
  return visionOfModel(modelLabelOf(current, textOf(entry.name)).name || current, current)
}

/**
 * ACP 的 `thought_level` 那一项 → App 认的 `reasoning`。
 *
 * ACP 把「思考档」定成会话级的**一个下拉**（codex 的 `reasoning_effort`: low / medium / high /
 * xhigh / max），而宿主那套目录把它挂在**模型**上（`model.reasoning.efforts`）。App 的档位滑轨
 * 只认后者，所以这一层把它摊到每个模型上：ACP 那边本来就是「这条会话用哪一档」，与选哪个模型
 * 无关，摊上去不失真。
 *
 * 没有这一项就返回 undefined —— 那正是「这家 CLI 不提供档位」，App 不画滑轨。
 */
function reasoningOf(option) {
  if (!option || !Array.isArray(option.options)) return undefined
  const efforts = option.options
    .filter((item) => item && item.value !== undefined)
    .map((item) => ({
      id: String(item.value),
      name: textOf(item.name) || String(item.value),
      ...(textOf(item.description) ? { description: textOf(item.description) } : {}),
    }))
  if (efforts.length === 0) return undefined
  return { efforts }
}

/** 会话级配置项里「档位」那一项的 id（codex 叫 `reasoning_effort`，别家可能是别的名字）。 */
function thoughtOptionOf(options) {
  return options.find((option) => option && option.category === 'thought_level')
    || options.find((option) => option && typeof option.id === 'string' && /thought|reasoning|effort/i.test(`${option.id} ${textOf(option.name)}`))
    || null
}

/**
 * 一条 ACP 配置项 → App 的「附加选项行」。
 *
 * 除了模型与档位，ACP 还可能给模式（`mode`：codex 的 Read-only / Full access）、协作模式
 * （`collaboration_mode`：Default / Plan）、模型附加项（`model_config`：codex 的 Fast mode）。
 * 这些在宿主那套里就是「速度 / 输出详略」那一排下拉（`ModelOptionRow`），App 早就会画、也会
 * 写回同一套接口 —— 所以这里照那个形状交出去，一行 UI 都不用新写。
 */
function optionRowOf(option) {
  if (!option || typeof option.id !== 'string' || !Array.isArray(option.options)) return null
  const choices = option.options
    .filter((item) => item && item.value !== undefined)
    .map((item) => ({
      id: String(item.value),
      name: textOf(item.name) || String(item.value),
      ...(textOf(item.description) ? { description: textOf(item.description) } : {}),
    }))
  if (choices.length === 0) return null
  const value = option.currentValue === undefined ? '' : String(option.currentValue)
  return { id: option.id, title: textOf(option.name) || option.id, value, choices }
}

/**
 * @param {object} deps 由 `cli/service.js` 交进来的受控门面（见那边的返回值）
 */
function createCliMobile(deps) {
  const { sessions, runPrompt, answerPermission, cancelTurn, setTitle, watch, forget } = deps
  /**
   * 告诉手机「列表变了」。
   *
   * CLI 会话不在宿主那本账里，镜像推送调度器每 500ms 比对的也是**宿主**那份清单，所以它
   * 变了之后没人吭声 —— 手机只能等兜底轮询（推送活着时是 3 分钟）。真机现象就是「对话页
   * 标题都出来了，侧栏那一行还写着 CLI 的名字」（2026-11-04 用户报）。
   *
   * 只报「变了」不报内容：清单仍然由 App 自己来拉，与宿主那条信号同一个口径。指纹按行上
   * 会变的那几项算，用同一个值重复报会被 `bump` 幂等掉。
   */
  function bumpList() {
    const rows = []
    for (const session of sessions.values()) {
      const state = stateOf(session)
      rows.push([session.id, session.title, session.status, state.pinned ? 1 : 0, state.lastTurn ? state.lastTurn.turn : 0])
    }
    rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    listSignal.bump(listRevision(rows))
  }

  /** 会话对象 → 适配状态。 */
  const states = new WeakMap()
  /** rpcId → { session, requestId }：`/approval/respond` 靠它找回 ACP 的挂起项。 */
  const approvals = new Map()
  /**
   * 投递去重账：`${sessionId}:${clientMessageId}` → 收下的时刻。
   *
   * CLI 这条发送没有宿主那本日志，`/session/delivery` 早先恒回 `delivered:false` —— 于是 App
   * 在一发超时后会认为「没送到」再发一次；若这一轮刚好结束，就会真的把同一句喂给模型两遍。
   * 这里记一笔：`/session/send` 见到同一个投递 id 直接按成功收（幂等），`/session/delivery`
   * 照实回「早就收下了」。只留最近若干条，旧的自然淘汰。
   */
  const deliveries = new Map()
  const DELIVERIES_MAX = 300
  function rememberDelivery(key) {
    deliveries.set(key, Date.now())
    while (deliveries.size > DELIVERIES_MAX) {
      const oldest = deliveries.keys().next().value
      if (oldest === undefined) break
      deliveries.delete(oldest)
    }
  }

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
        bumpList()
      } else if (frame.t === 'exit') {
        closeTurn(session, state, 'error')
        bumpList()
      } else if (frame.t === 'title') {
        bumpList()
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
      /**
       * 这一轮**已经收口**之后到的增量，只补消息、不再发草稿。
       *
       * 现场（2026-11-04 用户报「AI 已经回复了，这边还在深度求索中」）：状态帧是立即广播的、
       * 块帧走 60ms 攒批，于是 `status: idle` 会先到、`turn/end` 当场发出去；紧接着攒批里
       * 最后那一段正文的块帧才到。它先被当成 `assistant/chunk` 发出去 —— App 收到带回合号的
       * 增量会把这一轮重新认成「在跑」（`adoptTurn`），而这一轮再也不会有第二次 `turn/end`，
       * 状态行就永久挂着。所以收口之后只发 `assistant/message`。
       */
      if (!state.turnOpen) {
        emitSettled(session, conn, block, state, true)
        return
      }
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
      return
    }

    if (block.kind === 'tool') {
      const key = `${block.state}|${textOf(block.output)}|${textOf(block.argsRaw)}`
      const prev = conn.tool.get(block.id)
      if (prev === key) return
      conn.tool.set(block.id, key)
      const first = prev === undefined
      // 收口之后到的工具块同理（见正文那一段）：草稿帧会把这一轮重新认成「在跑」，
      // 所以只补 `assistant/message` 与结果，不再发 `assistant/chunk`。
      if (state.turnOpen) {
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
      }
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
      if (!state.turnOpen) emitSettled(session, conn, block, state, true)
      return
    }

    if (block.kind === 'notice') {
      // 提示块只当正文草稿流露一手；落定的那一份走 `assistant/message`。
      if (conn.emitted.has(block.id)) return
      conn.emitted.add(block.id)
      const text = textOf(block.text)
      if (!text) return
      if (!state.turnOpen) {
        emitSettled(session, conn, block, state, true)
        return
      }
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
  /**
   * 一轮收口：先 `turn/end`，再把这一轮每个落定的块按稳定 id 发一条 `assistant/message`。
   *
   * 顺序是刻意的：App 在「当前回合」里收到 assistant/message 会就地再收一次尾，先发
   * turn/end 就只是「把这一轮的终局交出去」，不触发重复收尾。
   *
   * 判据是**会话这一轮开着**，不是「这条连接上开着」。2026-11-04 现场：手机在发送之后才接上
   * 流（进页面晚、断线重连、屏幕熄灭后回来），这条连接的 `turnOpen` 一直是假，于是收尾时
   * 一句 `turn/end` 都不发 —— 页面上的「深度求索中」永久挂着，而正文早就到了。
   */
  function settleTurn(session, conn, reason) {
    const state = stateOf(session)
    if (!state.turnOpen && !conn.turnOpen) return
    state.turnOpen = false
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
      // 两处都要记：会话那一份是「这一轮还没收口」的事实，连接那一份只影响这一条流上
      // 补不补 `turn/start`。早先这里只写会话、收尾却只认连接，晚接上的那条流永远收不了尾。
      stateOf(session).turnOpen = true
      conn.turnOpen = true
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

  async function handlersOf(session, path, req, res, body) {
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
        // 两块真数据并在一起：
        //   - 计划：ACP 的 `plan` 事件整表替换落在块表里（`kind === 'plan'`），计划条读 `todos`；
        //   - 用量：`usage_update` 与 prompt 回包记下的上下文 / token / 耗时（见 `cli/usage.js`），
        //     底部那行「tok/s · 缓存命中 · 上下文」读它。
        // 没报上来的项照样缺席 —— 缺席就是「没有」，别编成 0。
        sendJsonQuiet(res, { projections: { ...statsOf(session.usage), ...planProjection(session) } })
        return
      case '/session-log':
        handleExport(session, req, res)
        return
      case '/session/models':
        sendJson(res, 200, modelsBodyOf(session))
        return
      /**
       * 选模型 / 换思考档：**等 ACP 真的改完再回包**。
       *
       * 早先是 `void applyModelChoice(...)` 立刻回 200（跟宿主那条学，宿主那边 select 是排进
       * 队列的写）。但对 CLI 这条定时不安全：App 收到 200 就会刷新目录，而 ACP 的
       * `set_config_option` 可能还没跑到，那一刷拿回的是旧值 —— 界面上就是「选了，没生效」；
       * 更糟的是紧接着「新建一条对话」，`preferredModel` 那时候还没写进去，于是新会话套不上。
       * 现在改成真实的往返：改完（并记下账）再回，App 那一次刷新读到的就是新值。
       */
      case '/session/select-model': {
        await applyModelChoice(session, body)
        sendJsonQuiet(res, { models: modelsBodyOf(session) })
        return
      }
      case '/session/model-option':
        await applyModelOption(session, body)
        sendJsonQuiet(res, {})
        return
      /**
       * 模型管理页的开关：`{ sessionId, kind: 'model'|'config', id, visible }`。
       *
       * 真值写在这台电脑上（`cli/model-visibility.js`，按 CLI 记账），所以换一台手机看到的是
       * 同一份 —— ACP 那边根本不知道有这回事，它给的目录原样不动，我们只决定「画不画」。
       * 回包里带上改完的整份目录，管理页与选择器都能就地刷新。
       */
      case '/session/model-visibility': {
        setVisible(session.agentId, textOf(body && body.kind) === 'config' ? 'config' : 'model', textOf(body && body.id), body && body.visible !== false)
        sendJson(res, 200, modelsBodyOf(session))
        return
      }
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
        sendJsonQuiet(res, {})
        return
      case '/session/attachment':
        await handleAttachment(req, res, body)
        return
      case '/session/goal':
        sendJsonQuiet(res, {})
        return
      case '/session/delivery': {
        // App 的离线发件箱超时后回查这一发到底收下没有（见 useOutboxFlush）：照实回答，
        // 免得它再发一遍。没有 clientMessageId 的老客户端只能回「不知道」。
        const cid = textOf(queryOf(req).get('clientMessageId'))
        sendJsonQuiet(res, { delivered: Boolean(cid && deliveries.has(`${session.id}:${cid}`)) })
        return
      }
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
        const content = Array.isArray(body && body.content) ? body.content : []
        const message = textOf(body && body.text) || textOfContent(content)
        // 同一个投递 id 再来一次就是重发：早就收下了，直接按成功回（幂等），别再喂模型一遍。
        const clientMessageId = textOf(body && body.clientMessageId)
        const deliveryKey = clientMessageId ? `${session.id}:${clientMessageId}` : ''
        if (deliveryKey && deliveries.has(deliveryKey)) {
          sendJson(res, 200, { ok: true, accepted: true })
          return
        }
        // 这一发带的图：先认下字节（手机发上来时已经落在收件箱里），块表里只记元数据。
        const sent = await saveImages(content)
        // 图的毛病先说清楚（上传过期 / 读不出来），比「这一发没有正文」有用得多。
        if (sent.problem) {
          return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: sent.problem } })
        }
        /**
         * 这个模型明确不收图时，**当场说清楚**，别把图塞过去让模型自己回一句「我看不到」。
         *
         * 2026-11-04 用户现场「发图片它还是看不到」：链路上图片确实到了（换一个能读图的模型
         * 立刻答对了颜色），但默认那个模型 `vision: false`，适配器照样收下、模型再回一句
         * 「当前模型不支持图片输入」。用户看到的是「发了但没反应」，而实际问题一句话就能说清。
         * 用与宿主同一组 reason（`MODEL_DOES_NOT_SUPPORT_IMAGES`），App 那边有现成文案。
         */
        if (sent.images.length > 0 && currentVisionOf(session) === false) {
          return sendJson(res, 400, {
            ok: false,
            error: {
              code: 'attachment-error',
              message: '当前模型不支持图片，请切换支持图片的模型',
              details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
            },
          })
        }
        if (!message && sent.images.length === 0) {
          return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '这一发没有正文' } })
        }
        const result = runPrompt(session, message, sent.images)
        if (!result.ok) return sendJson(res, 409, { ok: false, error: { code: 'cli-busy', message: result.error || '这一轮还没结束' } })
        if (deliveryKey) rememberDelivery(deliveryKey)
        sendJson(res, 200, { ok: true, accepted: true })
        return
      }
      case '/session/step':
        sendJsonQuiet(res, { step: { kind: textOf(queryOf(req).get('kind')) || 'tool', text: '' } })
        return
      case '/subagents':
        sendJsonQuiet(res, { entries: [], parentAvailable: true })
        return
      case '/extension/cards':
        sendJsonQuiet(res, { cards: [] })
        return
      default:
        sendJsonQuiet(res, {})
    }
  }

  /**
   * 这一发带的图 → 存好的元数据。
   *
   * App 的图片块有两种写法：`uploadId`（分片上传，字节已经落在收件箱）与内联 `data`
   * （老客户端、子会话那种）。两种都要认 —— 只认一种的话，换一个客户端发图就静默丢掉。
   *
   * 存的时候按内容哈希去重（同一张图发两次只有一份），块表里只留 `attachmentId`：历史与实时
   * 帧都只下发引用，字节等手机真的要看时再按 id 来取。
   */
  async function saveImages(content) {
    const out = []
    for (const block of Array.isArray(content) ? content : []) {
      if (!block || block.type !== 'image') continue
      let bytes = null
      let name = textOf(block.name) || ''
      if (typeof block.data === 'string' && block.data) {
        try { bytes = Buffer.from(block.data, 'base64') } catch { bytes = null }
      } else if (typeof block.uploadId === 'string' && block.uploadId) {
        const record = resolveFinishedUpload(block.uploadId)
        // 画布素材那份只带哈希没有路径，不能拿来内联（与宿主那条同一个判定）。
        if (!record || !record.path) return { images: out, problem: '这张图片的上传已过期，请重新发送' }
        try { bytes = await fsp.readFile(record.path) } catch { bytes = null }
        if (!name) name = textOf(record.name)
      }
      if (!bytes || bytes.length === 0) return { images: out, problem: '这张图片读不出来，请重新选择' }
      const mediaType = textOf(block.mediaType) || 'image/png'
      if (!MEDIA_EXT[mediaType]) return { images: out, problem: '这个格式的图片发不了' }
      if (bytes.length > MAX_IMAGE_BYTES) return { images: out, problem: '这张图片太大了' }
      const saved = await saveImage({ bytes, mediaType, name })
      if (!saved) return { images: out, problem: '这张图片存不下来' }
      out.push(saved)
    }
    return { images: out, problem: '' }
  }

  /**
   * `/session/attachment`：手机上按 `attachmentId` 来取一张图的字节。
   *
   * 三种回法与宿主那条逐字一致（App 的 `useAttachmentUri` 与原生通道只认这几种）：
   *   - `dims:true`  只要宽高，不搬字节；
   *   - `raw:true`   原始字节走分块信封（不解包不许走：那是明文传输）；
   *   - 默认         整份 base64。
   */
  async function handleAttachment(req, res, body) {
    const attachmentId = textOf(body && body.attachmentId)
    const meta = metaOf(attachmentId)
    const opened = openImage(attachmentId)
    if (!meta || !opened) {
      return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '这张图片已经不在了' } })
    }
    if (body && body.dims === true) {
      if (!meta.width || !meta.height) {
        return sendJson(res, 404, { ok: false, error: { code: 'no-dims', message: '这张图的文件头里量不出宽高' } })
      }
      return sendJson(res, 200, { ok: true, mediaType: meta.mediaType, width: meta.width, height: meta.height })
    }
    if (body && body.raw === true) {
      const e2ee = req && req.__dshE2ee
      if (!e2ee || !e2ee.keys || !e2ee.req) {
        return sendJson(res, 400, { ok: false, error: { code: 'e2ee-required', message: '这条会话是加密的，请用信封重发' } })
      }
      res.writeHead(200, chunksHeaders({ 'x-dsh-content-type': meta.mediaType, 'x-dsh-file-size': String(opened.size) }))
      const stream = fs.createReadStream(opened.path)
      res.on('close', () => stream.destroy())
      await pipeEncrypted(req, res, stream)
      return
    }
    let data = ''
    try { data = (await fsp.readFile(opened.path)).toString('base64') } catch { data = '' }
    if (!data) return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '这张图片已经不在了' } })
    sendJson(res, 200, {
      ok: true,
      mediaType: meta.mediaType,
      data,
      ...(meta.name ? { name: meta.name } : {}),
    })
  }

  async function applyModelChoice(session, body) {
    if (!session.handle || !body) return
    const model = textOf(body.model)
    const options = Array.isArray(session.configOptions) ? session.configOptions : []
    const modelOption = options.find((option) => option && option.category === 'model')
      || options.find((option) => option && typeof option.id === 'string' && /model/i.test(option.id))
    try {
      if (model && modelOption) {
        await session.handle.setConfigOption(modelOption.id, model)
        // 记住它：下次在这个 CLI 上开新会话时自动套上（见 service 的 applyPreferredModel）。
        rememberModel(session.agentId, modelOption.id, model)
      }
      // 档位：ACP 把它放在一条会话级配置项里（见 `thoughtOptionOf`），与模型是两个独立的下拉。
      const effort = textOf(body.reasoningEffort)
      if (effort) {
        const effortOption = thoughtOptionOf(options)
        if (effortOption) await session.handle.setConfigOption(effortOption.id, effort)
      }
    } catch { /* 选不动就维持原样：下一次读 models 会回真实值 */ }
  }

  async function applyModelOption(session, body) {
    if (!session.handle || !body) return
    try {
      const optionId = textOf(body.optionId) || textOf(body.id)
      if (!optionId) return
      // 档位在这一层也是「一条附加选项」，只是 App 的滑轨走的是上面那条 `select-model`。
      // 两条都认同一项，写进去的是同一个 ACP 配置。
      const updated = await session.handle.setConfigOption(optionId, body.value)
      if (updated && Array.isArray(updated.configOptions)) session.configOptions = updated.configOptions
      const option = (session.configOptions || []).find((item) => item && item.id === optionId)
      if (option && option.category === 'model') rememberModel(session.agentId, optionId, textOf(body.value))
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
      return await handlersOf(session, path.replace(/^\/api\/mobile\/v1/, ''), req, res, body)
    }
  }

  /**
   * `/sessions`：宿主列表照原样构建，把还活着的 CLI 会话并进去。
   *
   * **CLI 会话不参与归档视图**：这条链上「归档」等于关掉那条 CLI（见 `routeFlag`），关掉之后
   * 进程、块表、会话一起没了，没有「已归档」这一档可列。所以 `?archived=1` 那一发原样交给
   * 宿主，一条 CLI 行都不并 —— 不在这里造一个点不回去的假归档。
   */
  function mergeList(body, archivedOnly = false) {
    if (!body || body.ok !== true) return body
    if (archivedOnly) return body
    const items = Array.isArray(body.items) ? body.items : null
    // `unchanged` 那一份没有 items：CLI 会话是活的（运行态会变），不能回「没变」。
    if (!items) return body
    const mine = []
    for (const session of sessions.values()) {
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
      // `archive` 在这条链上等于**关掉这条 CLI**（`forget` 收进程、从列表里消失）。
      //
      // 为什么不照宿主的语义「挪进已归档视图」：宿主那边归档的是一条会话文件，进程早就不在
      // 了，撤销归档就是把它从账本里拿回来；CLI 这边恰恰相反 —— 会话背后挂着一个真进程，
      // 「收起来」唯一说得通的意思就是把它停掉。留一个还能从「已归档」点回来的假归档，点
      // 回来的是一个已经死掉的子进程壳，比关掉更糟（2026-11-04 用户定的）。
      //
      // `unarchive` 仍收：老版本的 App 上点过「取消归档」的历史记录还会打过来，这个动作对
      // 不存在的会话本来就是幂等成功。
      if (kind === 'archive') {
        const closed = forget(session.id)
        bumpList()
        return sendJson(res, 200, closed ? { ok: true, closed: true } : { ok: true, closed: false })
      }
      if (kind === 'pin') state.pinned = true
      else if (kind === 'unpin') state.pinned = false
      bumpList()
      sendJson(res, 200, { ok: true })
    }
  }

  /**
   * `POST /workspace/clear-archived` 原样交给宿主。
   *
   * CLI 会话不进归档视图（见 `mergeList`），所以这边没有可清的：这条链上「归档」就是关掉，
   * 在按下那一刻进程已经收了。曾经这里会把归档着的 CLI 会话一起 `forget`，现在那一档不
   * 存在了，掺和进来只会把 `deleted` 数改得跟用户看到的对不上。
   */
  function wrapClearArchived(handler) {
    return handler
  }

  /**
   * `/monitor` 里要并进去的那几条（安卓后台提醒服务读的那份视图）。
   *
   * 字段与宿主那套逐字一致（sessionId / title / running / completed / pendingInteraction /
   * pendingCard / lastTurn / lastTurnError），不新增接口、不改出口形状。活着的 CLI 会话都在
   * 这里 —— 关掉的那些已经不在这张表上了，没有第二档要滤。
   */
  function monitorItems() {
    const out = []
    for (const session of sessions.values()) {
      const state = stateOf(session)
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
    bumpList,
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

module.exports = { createCliMobile, isCliSessionId, CLI_PREFIX, modelLabelOf }

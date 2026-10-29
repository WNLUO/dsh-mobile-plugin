'use strict';

/**
 * 会话历史的纯派生逻辑：从 host history 事件折叠出 v1 移动端的消息/结构化项。
 *
 * 本模块只做「事件 → 展示结构」的纯计算，不碰 ctx、不发 RPC，因此可以单独测；
 * 原先这些函数与路由 handler 混在 lib/mobile/sessions.js 里（该文件 1964 行），
 * 拆出来后 handler 层只负责 HTTP 与宿主交互。
 *
 * 「什么不下发手机」（推理 / 工具参数 / 工具结果正文与 diff）的唯一规则在 `wire-cut.js`，
 * 这里只负责把留下的事件折成消息结构 —— 直播间那条路调的是同一份。
 */

const { cutAssistantBlock, cutToolResultEvent, createToolNameIndex } = require('./wire-cut.js');
const {
  reasoningStepSummary,
  toolStepSummary,
  toolStepState,
} = require('./step-index.js');

/**
 * 从 session.list 摘要行取会话标题（与桌面端侧栏同源，不再从 history 窗口猜）：
 *  - 优先读 title 投影（dsh-session-title 在「完整日志」上折叠的最新 session/title
 *    事件，正是桌面端侧栏显示的同一个值；空白会话恒为 ''，由前端显示「新会话」占位）；
 *  - 无正式标题时回退到工作区目录 basename，最后回退到 sessionId
 *    （对齐 dsh-client-runtime displayTitleOf 的兜底链）。
 * 注意：不能从 history 的 30 条窗口里找标题——长会话会把标题事件挤出窗口（桌面端无此问题）。
 */
function listTitle(s) {
  if (!s || s.blank) return '';
  const t = s.projections && s.projections.values ? s.projections.values.title : undefined;
  if (typeof t === 'string' && t !== '') return t;
  if (typeof s.cwd === 'string' && s.cwd !== '') {
    const base = s.cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
    if (base !== undefined && base !== '') return base;
  }
  return s.sessionId || '';
}

/**
 * tool/result 的可见内容：两种形状都认。
 *
 * - 当前形状：`message.content` 直接就是内容块数组，成败在 `message.isError`；
 * - 旧形状：`message.content[0]` 是 `{ isError, content: [内容块] }` 信封。
 *
 * 曾经只认旧形状，于是真实结果里的图片（`{type:'image', attachment}`）被当成信封剥掉、
 * 整张图丢失，结果级 isError 也读不到（失败的工具显示成成功）。
 */
function toolResultParts(msg) {
  const direct = Array.isArray(msg.content) ? msg.content : [];
  const envelope = direct.length === 1 && direct[0] && typeof direct[0] === 'object'
    && typeof direct[0].type !== 'string' ? direct[0] : null;
  if (!envelope) return { parts: direct, isError: msg.isError === true };
  return {
    parts: Array.isArray(envelope.content) ? envelope.content : [],
    isError: envelope.isError === true || msg.isError === true,
  };
}

/**
 * 图片块 → 移动端图片条目（`ChatMessage.images[]` / 工具块的 `images[]` 同一个形状）。
 *
 * 两条互斥的出口：
 *  - 块上有 `attachmentId`：下发**引用** `{ mediaType, name?, width?, height?, attachmentId }`，
 *    **不带 data**。字节由手机端要画的时候按 attachmentId 单张去取（`/session/attachment`），
 *    历史响应因此不再背着几十张截图的 base64。
 *  - 块里本来就只有内联 `data`、没有 attachmentId：照旧下发 `{ mediaType, data, name?, width?, height? }`。
 *    这条兜底不能删——老日志、工具结果里存在这种直接带字节的图片块。
 *
 * 宽高两格见 `imageDimsOf`：那是「手机能不能在挂载那一帧就占好位置」的前提。
 *
 * 两条都要求 mediaType 可读（块上没有就退到 attachment 上的），否则 App 认不出来、
 * 也没有可显示的动作，返回 null 让调用方丢掉它。
 */
function imageEntryOf(block) {
  if (!block || typeof block !== 'object') return null;
  const attachment = block.attachment && typeof block.attachment === 'object' ? block.attachment : {};
  const attachmentId = typeof attachment.attachmentId === 'string' ? attachment.attachmentId : '';
  const mediaType = typeof block.mediaType === 'string' && block.mediaType
    ? block.mediaType
    : (typeof attachment.mediaType === 'string' ? attachment.mediaType : '');
  if (!mediaType) return null;
  const name = typeof block.name === 'string'
    ? block.name
    : (typeof attachment.name === 'string' ? attachment.name : undefined);
  const dims = imageDimsOf(block, attachment);
  if (attachmentId) return { mediaType, ...(name !== undefined ? { name } : {}), ...dims, attachmentId };
  if (typeof block.data === 'string' && block.data) return { mediaType, data: block.data, ...(name !== undefined ? { name } : {}), ...dims };
  return null;
}

/**
 * 图片的原始宽高 —— 宿主的附件里本来就有（`attachment.width` / `attachment.height`）。
 *
 * **不许省掉这一格。** 手机侧要靠它把图片行的高度在**挂载那一帧就占好**：没有宽高，那一行
 * 只能先按 240 方盒占位、等图解码完 onLoad 再改成真比例；而行高在挂载之后变高，正是对话页
 * 「先落到底、再被顶回去」的来源（贴底列表上方一变高，屏幕上的内容就往下退一段）。
 * 宽高非法（缺失 / 非正数）时整格不出现，调用方仍按旧兜底盒处理。
 */
function imageDimsOf(block, attachment) {
  const pick = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined);
  const width = pick(block.width) ?? pick(attachment.width);
  const height = pick(block.height) ?? pick(attachment.height);
  if (width === undefined || height === undefined) return {};
  return { width, height };
}

/** 把 tool/result 的图片块收成移动端图片条目（两种出口见 imageEntryOf）。 */
function toolResultImages(parts) {
  const out = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object' || part.type !== 'image') continue;
    const entry = imageEntryOf(part);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * 预扫描 tool/result 事件，构建 callId → 状态/图片 映射（对接桌面 toolRowModel 状态派生）。
 *
 * 每条结果先过 `wire-cut.js`：正文与结果上的 `meta`（已应用 diff）都不下发，只留状态与图片，
 * 正文只给定时任务卡要解析的 `schedule_create` 留着。工具名从同一批事件里攒
 * （`tool/call`、assistant 的 tool-call 块），攒不到就按「不留正文」处理。
 */
function buildToolResultMap(events) {
  const map = new Map();
  const toolNames = createToolNameIndex();
  toolNames.absorbAll(events);
  for (const entry of events) {
    const e = entry.event || entry;
    if (e.type !== 'tool/result' || !e.data || !e.data.message) continue;
    const msg = e.data.message;
    const src = msg.source;
    if (!src || typeof src.callId !== 'string') continue;
    const kept = cutToolResultEvent(e, toolNames.nameOf(src.callId));
    const { parts, isError } = toolResultParts(kept.data.message);
    const code = kept.data.error && typeof kept.data.error.code === 'string' ? kept.data.error.code : undefined;
    const output = parts.map((part) => {
      if (part && typeof part.text === 'string') return part.text;
      return '';
    }).filter(Boolean).join('');
    const images = toolResultImages(parts);
    // `seq` 只给「按需取详情」用：手机点开这一步时拿它去回拉那一小窗事件。
    map.set(src.callId, {
      isError,
      code,
      ...(Number.isSafeInteger(e.seq) ? { seq: e.seq } : {}),
      ...(output ? { output } : {}),
      ...(images.length ? { images } : {}),
    });
  }
  return map;
}

/**
 * 把整窗工具结果折成客户端补丁（`/session/messages` 顶层的 `toolResults`）。
 *
 * 补丁本身必须取自整个窗口：调用方游标可能已经越过结果 seq，而调用块还停在 running，
 * 客户端按 callId 幂等打补丁。但**已经随消息块下发的**那份结果不再重复带料 ——
 * `items` 里的 tool-call 块本来就是同一张表构出来的，图片与定时任务卡要的那份正文再传一遍
 * 等于同一份内容在一条响应里走两趟。客户端打补丁时状态照写、料只在给了的时候才覆盖，所以
 * 那几格省掉是安全的；消息块不在这份窗口里时才带全。
 *
 * `bodies: false`（增量拉取）连「消息块不在这份窗口里」的那些也只回状态。理由是同一个：
 * 增量拉取的调用方手上已经有一份完整的会话，缺的只是「这几次调用结束了没有」。
 */
function toolResultPatchesFor(events, items, options = {}) {
  const bodies = options.bodies !== false;
  const delivered = new Set();
  for (const item of items || []) {
    if (!item || !Array.isArray(item.blocks)) continue;
    for (const block of item.blocks) {
      if (block && block.type === 'tool-call' && typeof block.callId === 'string' && block.callId) {
        delivered.add(block.callId);
      }
    }
  }
  return [...buildToolResultMap(events).entries()].map(([callId, result]) => {
    const state = result.isError ? (result.code === 'interrupted' ? 'stopped' : 'error') : 'ok';
    if (!bodies || delivered.has(callId)) return { callId, state };
    return {
      callId,
      state,
      ...(result.output ? { output: result.output } : {}),
      ...(result.images && result.images.length ? { images: result.images } : {}),
    };
  });
}

/** 把 assistant message.content 解析为一个结构块数组（text/tool-call/image）。 */
function parseBlocks(blocks, toolResults) {
  if (!Array.isArray(blocks)) return [];
  const out = [];
  for (const raw of blocks) {
    // 推理不下发、tool-call 收成骨架（三张轮尾卡的工具留 arguments）—— 与直播间同一条规则。
    const b = cutAssistantBlock(raw);
    if (!b || typeof b.type !== 'string') continue;
    if (b.type === 'text' && typeof b.text === 'string' && b.text) {
      out.push({ type: 'text', text: b.text });
    } else if (b.type === 'image' && b.dataUnavailable === true) {
      // The image attachment resolver marked this block as unavailable. Keep it out of
      // visible text; pushMessage projects its retry metadata onto unavailableImages.
      continue;
    } else if (b.type === 'image') {
      // 有 attachmentId 走引用、只有内联 data 的走兜底（见 imageEntryOf）。两者都认不出
      // 就整块丢掉——与旧行为一致，绝不能把它兜底成一段 JSON 文本。
      const entry = imageEntryOf(b);
      if (entry) out.push({ type: 'image', ...entry });
    } else if (b.type === 'tool-call') {
      // 块已被上面那条规则收过：非白名单工具只剩 `{ id, name }`，所以 argsRaw 只有三张
      // 轮尾卡的工具才有（App 从它读计划/扩展/定时任务的料）。
      const callId = b.id != null ? String(b.id) : undefined;
      let state;
      let output;
      let images;
      if (callId && toolResults) {
        const result = toolResults.get(callId);
        if (result) {
          output = result.output;
          images = result.images;
          // 对齐桌面 toolRowModel 状态派生：error.code === 'interrupted' → stopped, isError → error, ok
          if (result.isError) {
            state = result.code === 'interrupted' ? 'stopped' : 'error';
          } else {
            state = 'ok';
          }
        }
      }
      out.push({
        type: 'tool-call',
        callId,
        name: typeof b.name === 'string' ? b.name : undefined,
        argsRaw: typeof b.arguments === 'string' ? b.arguments : (b.arguments != null ? JSON.stringify(b.arguments) : undefined),
        ...state ? { state } : {},
        ...typeof output === 'string' && output ? { output } : {},
        ...images && images.length ? { images } : {},
      });
    } else {
      // 桌面端对未知 assistant block 使用 JsonBlock 兜底；移动端没有对应组件，
      // 先保留原始内容为可见文本，避免历史重同步后该节点整体消失。
      out.push({ type: 'text', text: `[未支持的内容块]\n${JSON.stringify(b)}` });
    }
  }
  return out;
}

/**
 * 一条消息里 write/edit 成功写过的文件路径。
 *
 * 参数不下发手机（见 `wire-cut.js`），但「这一轮动过哪些文件」仍要在本机从**原始**块的
 * `arguments` 里派生出来：App 拿这份清单解析收尾正文里的行内文件引用。
 */
function writtenPaths(content, toolResults) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const b of content) {
    if (!b || typeof b !== 'object' || b.type !== 'tool-call') continue;
    if (b.name !== 'write' && b.name !== 'edit') continue;
    const callId = b.id != null ? String(b.id) : undefined;
    const result = callId && toolResults ? toolResults.get(callId) : undefined;
    if (!result || result.isError) continue;
    const raw = typeof b.arguments === 'string' ? b.arguments : (b.arguments != null ? JSON.stringify(b.arguments) : '');
    try {
      const args = JSON.parse(raw || '{}');
      const path = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : null;
      if (typeof path === 'string' && path) out.push(path);
    } catch { /* 参数不是 JSON：这条调用不算产出，与「没有参数」同处理 */ }
  }
  return out;
}

/** 从结构块里拼接纯文本（列表预览/标题回退用，仍只取 text 块）。 */
function blocksToText(blocks) {
  return blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

/** 从 compaction/summary 的 summary 字段提取展示文本（数组=文本块列表，字符串直接取；空→null）。 */
function compactionSummaryText(summary) {
  if (Array.isArray(summary)) {
    const text = summary.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
    return text.trim() === '' ? null : text;
  }
  if (typeof summary === 'string') return summary.trim() === '' ? null : summary;
  return null;
}

/** 从 shadowedSeqs 取被压缩条数（数组长度；缺失→null）。 */
function shadowedCount(seqs) {
  return Array.isArray(seqs) ? seqs.length : null;
}

/** 取安全非负整数的 token 数（与桌面端同口径：safe integer 且 >= 0，否则 null）。 */
function shadowedTokens(n) {
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** retry failure 字段：{code?, message?} 或 null（字段缺失/非字符串则省略）。 */
function retryFailure(failure) {
  if (!failure || typeof failure !== 'object') return null;
  const out = {};
  if (typeof failure.code === 'string' && failure.code !== '') out.code = failure.code;
  if (typeof failure.message === 'string' && failure.message !== '') out.message = failure.message;
  return out.code !== undefined || out.message !== undefined ? out : null;
}

/** 列表/概览的 lastMessage 预览只取有 role 的消息项（结构化行不参与预览）。 */
function lastMessageOf(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role) return messages[i];
  }
  return null;
}

/**
 * 一份历史事件里所有**交付声明**过的路径（`deliverables/presented` 的 `files[].path`）。
 *
 * 与下面的按轮归并同一批事件、同一个形状兼容（`entry.event || entry`）：交付文件取字节
 * 那条路由（`session-file.js`）用它做白名单 —— 只有模型显式交出来的文件才允许手机上取。
 * 单独一个函数而不是从消息里翻 `presentedFiles`：声明事件可能落在消息窗口之外，按轮挂在
 * 消息上的那份不一定在。
 */
function presentedPathsOf(events) {
  const paths = new Set();
  for (const entry of events) {
    const e = entry && (entry.event || entry);
    if (!e || e.type !== 'deliverables/presented' || !e.data || !Array.isArray(e.data.files)) continue;
    for (const raw of e.data.files) {
      if (raw && typeof raw.path === 'string' && raw.path.trim() !== '') paths.add(raw.path);
    }
  }
  return paths;
}

/**
 * 从 history 事件折叠出消息与「结构化行」（wire v1 扩展，向后兼容）：
 *  - 普通消息：{ id, seq, time, role, text, blocks?, images?, clientMessageId? }；
 *  - compaction：渲染成 compaction 行而不是用户气泡，id=compactionId；同 compactionId 的
 *    compaction/summary 补 counts，compaction/end 落定 state（带 error 即 failed）；
 *    同一轮的多次尝试只占一行，新尝试原地顶替还没落定的那条；
 *  - retry：{ kind:'retry', id: retryId, status:'scheduled'|'started', retry, maxRetries, … }；
 *  - turn-error / max-tokens：id 为 `turn-<turn>`；
 *  - command：command/run 发出行，command/done 原地升级。
 * 结构化项与消息按 seq 升序混排；旧载荷字段缺失时跳过对应项，绝不抛错。
 */
function deriveMessages(events) {
  const out = [];
  // 预扫描 tool/result 事件（同批次事件内，结果可能在调用块之前/之后出现）。
  const toolResults = buildToolResultMap(events);
  // 预扫描 compaction/summary：检查点 user/message 与 summary 事件在日志里的先后不固定，
  // 用 compactionId → summary 数据把 counts 补全到同一压缩行上。
  const summaries = new Map();
  for (const entry of events) {
    const e = entry.event || entry;
    if (e.type !== 'compaction/summary' || !e.data || typeof e.data.compactionId !== 'string') continue;
    summaries.set(e.data.compactionId, e.data);
  }
  // 交付声明预扫描（`deliverables/presented`）：模型调 `present` 声明「这几份请你收下」时，
  // 宿主的 dsh-tool-present 会往会话日志追一条这个事件。桌面那张「交付文件」卡只认它 ——
  // **不是**「这一轮改过哪些文件」。手机第一版从 write/edit 反推，于是「每改一次都冒卡、
  // 命令行改的却一张都没有」。这里按 **turn** 归并，
  // 同一个路径后声明的覆盖先声明的（桌面 `presentedForClosing` 的 `files.set` 同口径）。
  const presentedByTurn = new Map();
  for (const entry of events) {
    const e = entry.event || entry;
    if (e.type !== 'deliverables/presented') continue;
    const data = e.data;
    if (!data || typeof data !== 'object' || typeof data.turn !== 'number' || !Array.isArray(data.files)) continue;
    const bucket = presentedByTurn.get(data.turn) || [];
    for (const raw of data.files) {
      if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string' || raw.path.trim() === '') continue;
      const file = {
        path: raw.path,
        ...(typeof raw.description === 'string' && raw.description.trim() !== '' ? { description: raw.description } : {}),
      };
      const at = bucket.findIndex((item) => item.path === file.path);
      if (at >= 0) bucket[at] = file;
      else bucket.push(file);
    }
    if (bucket.length > 0) presentedByTurn.set(data.turn, bucket);
  }

  /**
   * 这一轮**被 write / edit 动过**的文件，按轮攒。
   *
   * 为什么按轮而不是按单条消息：一份文件是一轮里某一步写的，而收尾答复那条消息自己一个
   * 写操作都没有 —— 按消息算的话，正文里提到刚写好的文件时那份清单永远是空的。
   * 桌面 `dsh-client-ui-deliverables` 的 `selectProducedFiles(owner)` 也是按**整轮**取。
   *
   * 攒完在循环之后回填：同一轮里先发的消息也要能看到这一轮后几步才写出来的文件。
   */
  const producedByTurn = new Map();
  const producedItems = [];

  // 单步计时预扫描：为每条 assistant 消息派生「本轮」的 ttft / decode / 输出 token
  // （对齐桌面 turn-metrics/assistant-timing：ttftMs = 首个非空 delta − step/start；
  // decodeMs = 落定 − 首个 delta；outputTokens = assistant/message.usage.outputTokens）。
  // 会话累计 stats 属于输入区常驻统计条，绝不能拿来冒充单轮指标（否则每条历史消息
  // 都会显示同一份累计行并随轮询刷新——正是移动端此前「统计行一直出现」的根因）。
  const stepStartTime = new Map();
  const turnStartTime = new Map();
  const turnEndTime = new Map();
  const firstDeltaTime = new Map();
  const stepOutputTokens = new Map();
  const stepKey = (turn, step) => `${turn}:${step}`;
  for (const entry of events) {
    const e = entry.event || entry;
    if (!e || typeof e.data !== 'object' || e.data === null) continue;
    const turn = e.data.turn;
    const step = e.data.step;
    if (typeof turn !== 'number') continue;
    if (e.type === 'turn/start') turnStartTime.set(turn, e.time);
    if (e.type === 'turn/end') turnEndTime.set(turn, e.time);
    if (typeof step !== 'number') continue;
    if (e.type === 'step/start') {
      const k = stepKey(turn, step);
      if (!stepStartTime.has(k)) stepStartTime.set(k, e.time);
    } else if (e.type === 'assistant/chunk' && e.data.chunk) {
      const c = e.data.chunk;
      if (c.type === 'text-delta' || c.type === 'reasoning-delta' || c.type === 'tool-call-delta') {
        const k = stepKey(turn, step);
        if (!firstDeltaTime.has(k)) firstDeltaTime.set(k, e.time);
      }
    } else if (e.type === 'assistant/message' && e.data.usage) {
      const tokens = e.data.usage.outputTokens;
      if (typeof tokens === 'number' && tokens > 0) {
        const k = stepKey(turn, step);
        if (!stepOutputTokens.has(k)) stepOutputTokens.set(k, tokens);
      }
    }
  }
  /** 派生一条 assistant 消息所在 step 的单轮计时；缺记录（非流式落定/无 step 边界）返回 undefined。 */
  const timingOf = (e) => {
    if (!e || typeof e.data !== 'object' || e.data === null) return undefined;
    const turn = e.data.turn;
    const step = e.data.step;
    if (typeof turn !== 'number' || typeof step !== 'number') return undefined;
    const k = stepKey(turn, step);
    const start = stepStartTime.get(k);
    const first = firstDeltaTime.get(k);
    const timing = {};
    const turnStart = turnStartTime.get(turn);
    const turnEnd = turnEndTime.get(turn);
    if (turnStart != null && turnEnd != null && turnEnd >= turnStart) timing.runMs = turnEnd - turnStart;
    if (start == null || first == null) return Object.keys(timing).length > 0 ? timing : undefined;
    const ttftMs = Math.max(0, first - start);
    if (ttftMs > 0) timing.ttftMs = ttftMs;
    const decodeMs = Math.max(0, e.time - first);
    if (decodeMs > 0) timing.decodeMs = decodeMs;
    const outputTokens = stepOutputTokens.get(k);
    if (typeof outputTokens === 'number' && outputTokens > 0) timing.outputTokens = outputTokens;
    return Object.keys(timing).length > 0 ? timing : undefined;
  };
  // 结构化行按 id 唯一：compactionId → 行索引（检查点行原地替换 start 行）、retryId → 行索引（原地升级）。
  const compactionAt = new Map();
  // 一轮里的压缩尝试行（turn → 行索引表）：同一轮的多次尝试共用一行，见 pendingCompactionAt。
  const compactionTurns = new Map();
  const retryAt = new Map();
  // 命令行按 commandId 唯一：command/run 发出行，command/done 原地升级（保 run 的 name，位置随 done 事件 seq 归位）。
  const commandAt = new Map();

  /**
   * 每一轮的「过程清单」：一步一行摘要，正文仍然一个字节都不下发。
   *
   * 清单挂在**这一轮开头那条消息**上（App 的头条行就是它派生的），收口后点开清单再按
   * `seq` / `resultSeq` 去 `/session/step` 取那一步的详情 —— 这就是「按需获取」的那一半。
   * 只做摘要不做正文：一条推理正文平均几万字、一次 `write` 的参数就是整份文件，把它们
   * 塞进消息响应里正是 2026-10-27 砍掉它的理由。
   */
  const stepsByTurn = new Map();
  const openerByTurn = new Map();
  let lastOpener = null;
  const collectSteps = (content, e) => {
    if (!Array.isArray(content)) return;
    const turn = e.data && typeof e.data.turn === 'number' ? e.data.turn : undefined;
    if (turn === undefined) return;
    if (!openerByTurn.has(turn) && lastOpener) openerByTurn.set(turn, lastOpener);
    const list = stepsByTurn.get(turn) || [];
    content.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object') return;
      if (raw.type === 'reasoning') {
        const text = typeof raw.text === 'string' ? raw.text : '';
        // 空推理块（只有零宽字符那种）不算一步：App 点开一条什么都没有的行没有意义。
        if (text.trim() === '') return;
        list.push({
          kind: 'think',
          ...(Number.isSafeInteger(e.seq) ? { seq: e.seq } : {}),
          index,
          summary: reasoningStepSummary(text),
        });
        return;
      }
      if (raw.type !== 'tool-call') return;
      const callId = raw.id != null ? String(raw.id) : undefined;
      const result = callId ? toolResults.get(callId) : undefined;
      const rawArgs = typeof raw.arguments === 'string'
        ? raw.arguments
        : (raw.arguments != null ? JSON.stringify(raw.arguments) : '');
      list.push({
        kind: 'tool',
        ...(callId ? { callId } : {}),
        ...(typeof raw.name === 'string' && raw.name ? { name: raw.name } : {}),
        summary: toolStepSummary(raw.name, rawArgs),
        state: toolStepState(result),
        ...(Number.isSafeInteger(e.seq) ? { seq: e.seq } : {}),
        ...(result && Number.isSafeInteger(result.seq) ? { resultSeq: result.seq } : {}),
      });
    });
    if (list.length > 0) stepsByTurn.set(turn, list);
  };

  // 普通消息（user/assistant）沿用原折叠逻辑。
  const pushMessage = (msg, e) => {
    collectSteps(msg.content, e);
    const parsed = parseBlocks(msg.content, toolResults);
    // 工具产出的图挂成这条消息的图片附件：App 把它画在气泡上方（缩略图 + 文件名，点开全屏），
    // 与用户自己发的图同一种形状。工具卡里不再重复画同一张图 —— 一张图两处画会把字节也翻倍。
    const toolImages = [];
    const blocks = parsed.map((block) => {
      if (block.type !== 'tool-call' || !Array.isArray(block.images) || block.images.length === 0) return block;
      toolImages.push(...block.images);
      const { images: _movedToAttachments, ...rest } = block;
      return rest;
    });
    const text = blocksToText(blocks);
    // 图片条目统一投影：引用模式带 attachmentId 不带 data，内联兜底带 data 不带 attachmentId。
    //
    // **宽高必须一起带上**（`imageDimsOf` 的口径）：手机侧靠它在挂载那一帧就把图片行的高度占好，
    // 少这两格就只能先占 240 方盒、等解码完再改，而贴底列表上方一变高，屏幕上看到的内容就
    // 往下退一段 —— 这正是「先落到底、再被顶回去」那一跳。
    const images = [
      ...blocks.filter((b) => b.type === 'image'),
      ...toolImages,
    ].map(({ mediaType, data, name, attachmentId, width, height }) => ({
      mediaType,
      ...(typeof name === 'string' ? { name } : {}),
      ...(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : {}),
      ...(typeof attachmentId === 'string' && attachmentId ? { attachmentId } : {}),
      ...(typeof attachmentId === 'string' && attachmentId ? {} : { data }),
    }));
    const unavailableImages = (Array.isArray(msg.content) ? msg.content : [])
      .filter((block) => block && block.type === 'image' && block.dataUnavailable === true)
      .map((block) => {
        const attachment = block.attachment && typeof block.attachment === 'object' ? block.attachment : {};
        return {
          attachmentId: typeof attachment.attachmentId === 'string' ? attachment.attachmentId : '',
          ...(typeof block.mediaType === 'string' ? { mediaType: block.mediaType } : {}),
          ...(typeof block.name === 'string' ? { name: block.name } : {}),
        };
      })
      .filter((image) => image.attachmentId !== '');
    // 只要存在可识别或保留的 block 就入列表；纯推理/工具调用也必须保留，
    // 否则流式标签在重同步时会消失。
    const hasContent = blocks.length > 0 || unavailableImages.length > 0;
    if (!hasContent) return;
    const clientMessageId = msg.role === 'user' ? clientMessageIdFromSource(msg.source, msg) : undefined;
    const item = {
      id: String(msg.id),
      role: msg.role || 'assistant',
      text,
      blocks,
      images: images.length > 0 ? images : undefined,
      ...(unavailableImages.length > 0 ? { unavailableImages } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
      seq: e.seq,
      time: e.time,
    };
    // 这一轮的轮号（老日志没有）：产出清单与交付声明都按它归并。
    const turn = e.data && typeof e.data.turn === 'number' ? e.data.turn : undefined;
    // 本条消息自己写 / 改过的文件：并进**这一轮**的那一份，不单独挂在它自己头上。
    // 从原始块的 arguments 算（那些参数不下发手机）。
    const ownWrites = writtenPaths(msg.content, toolResults);
    if (turn !== undefined && ownWrites.length > 0) {
      const bucket = producedByTurn.get(turn) || new Set();
      for (const path of ownWrites) bucket.add(path);
      producedByTurn.set(turn, bucket);
    }
    // 回填要等循环跑完（这一轮后面几步写的也要算进来），先把这条记下来。
    if (turn !== undefined) producedItems.push({ item, turn });
     // 这一轮模型显式声明的交付文件：轮尾那张交付卡的唯一依据（与产出的清单分开）。
    if (turn !== undefined) {
       const presented = presentedByTurn.get(turn);
       if (presented && presented.length > 0) item.presentedFiles = presented.map((file) => ({ ...file }));
     }
     // 单轮计时只挂 assistant 消息（user/message 无 step 计时）。
    if (item.role !== 'user') {
      const timing = timingOf(e);
      if (timing) item.timing = timing;
    }
    out.push(item);
    // 这一轮的过程清单挂在**开启这一轮的那条消息**上：App 的头条行按它派生。
    if (item.role === 'user') lastOpener = item;
  };

  // 放入一行 compaction：同一 compactionId 只保留一行，检查点行原地替换 start 行（最终按 seq 排序归位）。
  const placeCompaction = (item) => {
    let index = compactionAt.get(item.id);
    if (index === undefined) {
      index = out.length;
      out.push(item);
    } else out[index] = item;
    compactionAt.set(item.id, index);
    if (typeof item.turn === 'number') {
      const list = compactionTurns.get(item.turn);
      if (list === undefined) compactionTurns.set(item.turn, [index]);
      else if (!list.includes(index)) list.push(index);
    }
    return index;
  };

  // 同一轮里的多次压缩尝试只占一行：宿主一步重试一次、每次一个新 compactionId，按 id 找必然
  // 「每次都新增一条」——一次跑几十步就是一个回合几十条「正在压缩…」。新尝试顶替这一轮里还
  // 没落定的那条（running / failed），已经落地（done）的不顶替：那是真压过一次的记录。
  const pendingCompactionAt = (turn, id) => {
    if (compactionAt.has(id)) return compactionAt.get(id);
    if (typeof turn !== 'number') return -1;
    for (const index of compactionTurns.get(turn) || []) {
      const row = out[index];
      if (row && row.kind === 'compaction' && (row.state === 'running' || row.state === 'failed')) return index;
    }
    return -1;
  };

  for (const entry of events) {
    const e = entry.event || entry;
    const seq = e.seq;
    const time = e.time;
    if (e.type === 'user/message' && e.data) {
      const msg = e.data;
      const src = msg.source;
      if (src && typeof src === 'object' && src.kind === 'plugin' && src.plugin === 'compact') {
        // 压缩检查点本身是一条 user/message，绝不能渲染成用户气泡，渲染成 compaction 行。
        const id = typeof src.compactionId === 'string' && src.compactionId !== ''
          ? src.compactionId
          : (msg.id != null ? String(msg.id) : null);
        if (id === null) continue;
        const s = summaries.get(id);
        placeCompaction({
          id,
          kind: 'compaction',
          state: 'done',
          summary: s ? compactionSummaryText(s.summary) : null,
          shadowedItemCount: s ? shadowedCount(s.shadowedSeqs) : null,
          shadowedTokenCount: s ? shadowedTokens(s.shadowedTokenCount) : null,
          seq,
          time,
        });
        continue;
      }
      if (src && typeof src === 'object' && src.kind === 'schedule') {
        // 定时任务投递的提醒：桌面画成 `turn-trigger` 节点，手机这里落成一行 kind:'wake'
        // （与 App 的 userMessageOrigin 同口径，见 app/src/utils/structuralItems.ts）。
        // 以前把它并进下面那条「非 user 来源一律不下发」里丢掉，于是每一轮自动执行在重进
        // 会话后一点痕迹都没有。正文是宿主拼的提醒框架，原样收下、不解析。
        const wakeBlocks = parseBlocks(msg.content, toolResults);
        const wakeText = blocksToText(wakeBlocks);
        if (wakeText) {
          out.push({
            id: String(msg.id),
            kind: 'wake',
            wakeSource: 'schedule',
            text: wakeText,
            seq: e.seq,
            time: e.time,
          });
        }
        continue;
      }
      if (src && typeof src === 'object' && src.kind !== 'user') {
        // 上下文注入/召回（session-reference→召回，其余 kind→注入）：桌面 `isVisibleChatNode`
        // 只放行携带 tool-addition/tool-removal 的上下文节点，这类提示一律不显示 —— 不下发。
        continue;
      }
      // 普通用户消息（source 缺失或 kind==='user'）沿用原折叠。
      pushMessage(msg, e);
    } else if (e.type === 'assistant/message' && e.data && e.data.message && e.data.message.content) {
      pushMessage(e.data.message, e);
    } else if (e.type === 'compaction/start' && e.data && typeof e.data.compactionId === 'string' && e.data.compactionId !== '') {
      // 行已由检查点发出（done）时跳过，避免重复行。同一轮里已有没落定的行就**原地顶替**
      // （换 id/状态，位置留在第一次尝试那一处）—— 否则一次跑几十步就是几十条行。
      const idx = pendingCompactionAt(e.data.turn, e.data.compactionId);
      if (idx < 0) {
        placeCompaction({
          id: e.data.compactionId,
          kind: 'compaction',
          state: 'running',
          summary: null,
          shadowedItemCount: null,
          shadowedTokenCount: null,
          seq,
          time,
          ...(typeof e.data.turn === 'number' ? { turn: e.data.turn } : {}),
        });
      } else {
        const existing = out[idx];
        out[idx] = {
          ...existing,
          id: e.data.compactionId,
          state: 'running',
          error: null,
          ...(typeof e.data.turn === 'number' ? { turn: e.data.turn } : {}),
        };
        compactionAt.set(e.data.compactionId, idx);
      }
    } else if (e.type === 'compaction/end' && e.data && typeof e.data.compactionId === 'string' && e.data.compactionId !== '') {
      // 这次尝试的落定：无 error → done（summary / 检查点随后补齐 counts）、有 error → failed
      // 带原因。这条以前整条丢掉，于是被拒绝的压缩永远停在「正在压缩…」，失败一次都看不见。
      const error = typeof e.data.error === 'string' && e.data.error !== '' ? e.data.error : null;
      const idx = pendingCompactionAt(e.data.turn, e.data.compactionId);
      if (idx < 0) {
        placeCompaction({
          id: e.data.compactionId,
          kind: 'compaction',
          state: error ? 'failed' : 'done',
          error,
          summary: null,
          shadowedItemCount: null,
          shadowedTokenCount: null,
          seq,
          time,
          ...(typeof e.data.turn === 'number' ? { turn: e.data.turn } : {}),
        });
      } else {
        const existing = out[idx];
        out[idx] = {
          ...existing,
          id: e.data.compactionId,
          state: error ? 'failed' : 'done',
          error,
        };
        compactionAt.set(e.data.compactionId, idx);
      }
    } else if (e.type === 'compaction/summary' && e.data && typeof e.data.compactionId === 'string' && e.data.compactionId !== '') {
      // 已有同 compactionId 的行（start 或检查点发出）→ 升级为 done 并补 counts；否则新增 done 行。
      const id = e.data.compactionId;
      const existing = compactionAt.has(id) ? out[compactionAt.get(id)] : null;
      if (existing) {
        existing.state = 'done';
        existing.error = null;
        existing.summary = compactionSummaryText(e.data.summary);
        existing.shadowedItemCount = shadowedCount(e.data.shadowedSeqs);
        existing.shadowedTokenCount = shadowedTokens(e.data.shadowedTokenCount);
      } else {
        placeCompaction({
          id,
          kind: 'compaction',
          state: 'done',
          summary: compactionSummaryText(e.data.summary),
          shadowedItemCount: shadowedCount(e.data.shadowedSeqs),
          shadowedTokenCount: shadowedTokens(e.data.shadowedTokenCount),
          seq,
          time,
        });
      }
    } else if (e.type === 'llm/retry' && e.data && typeof e.data.retryId === 'string' && e.data.retryId !== '' && typeof e.data.retry === 'number') {
      // 同 retryId 的后续重试（retry=2…）原地更新，保持一行。
      const id = e.data.retryId;
      const existing = retryAt.has(id) ? out[retryAt.get(id)] : null;
      if (existing) {
        existing.status = 'scheduled';
        existing.retry = e.data.retry;
        if (typeof e.data.maxRetries === 'number') existing.maxRetries = e.data.maxRetries;
        if (typeof e.data.delayMs === 'number') existing.delayMs = e.data.delayMs;
        existing.failure = retryFailure(e.data.failure);
      } else {
        const item = {
          id,
          kind: 'retry',
          status: 'scheduled',
          retry: e.data.retry,
          maxRetries: typeof e.data.maxRetries === 'number' ? e.data.maxRetries : null,
          failure: retryFailure(e.data.failure),
          seq,
          time,
        };
        if (typeof e.data.delayMs === 'number') item.delayMs = e.data.delayMs;
        retryAt.set(id, out.length);
        out.push(item);
      }
    } else if (e.type === 'llm/retry-started' && e.data && typeof e.data.retryId === 'string' && e.data.retryId !== '' && typeof e.data.retry === 'number') {
      const id = e.data.retryId;
      const existing = retryAt.has(id) ? out[retryAt.get(id)] : null;
      if (existing) existing.status = 'started';
      else {
        retryAt.set(id, out.length);
        out.push({
          id,
          kind: 'retry',
          status: 'started',
          retry: e.data.retry,
          maxRetries: typeof e.data.maxRetries === 'number' ? e.data.maxRetries : null,
          failure: null,
          seq,
          time,
        });
      }
    } else if (e.type === 'command/run' && e.data && typeof e.data.commandId === 'string' && e.data.commandId !== '' && typeof e.data.name === 'string') {
      // 命令行：root 行（running）。同 commandId 重复 run（罕见）只更新位置字段。
      const id = e.data.commandId;
      const item = { id, kind: 'command', name: e.data.name, status: 'running', seq, time };
      const existing = commandAt.has(id) ? out[commandAt.get(id)] : null;
      if (existing) Object.assign(existing, { status: 'running', seq, time });
      else {
        commandAt.set(id, out.length);
        out.push(item);
      }
    } else if (e.type === 'command/done' && e.data && typeof e.data.commandId === 'string' && e.data.commandId !== '') {
      // 升级同 commandId 行（name 保 run 的）；done 先到（罕见）则按 done 内容建行。
      const id = e.data.commandId;
      const done = { kind: 'command', status: 'done', seq, time };
      if (e.data.kind === 'error' || e.data.kind === 'success') done.resultKind = e.data.kind;
      if (typeof e.data.text === 'string' && e.data.text !== '') done.text = e.data.text;
      const existing = commandAt.has(id) ? out[commandAt.get(id)] : null;
      if (existing) Object.assign(existing, done);
      else {
        commandAt.set(id, out.length);
        out.push(done);
      }
    } else if (e.type === 'turn/end' && e.data && e.data.reason && e.data.turn != null) {
      // turn/end 每轮一次，一条消息只对应一条行：error → turn-error；max-tokens → max-tokens；
      // aborted → turn-aborted；其余 kind 忽略。
      if (e.data.reason.kind === 'error') {
        const err = e.data.reason.error;
        if (!err || typeof err.message !== 'string') continue;
        const item = { id: `turn-${e.data.turn}`, kind: 'turn-error', message: err.message, seq, time };
        if (typeof err.code === 'string' && err.code !== '') item.code = err.code;
        out.push(item);
      } else if (e.data.reason.kind === 'max-tokens') {
        out.push({ id: `turn-${e.data.turn}`, kind: 'max-tokens', seq, time });
      } else if (e.data.reason.kind === 'aborted') {
        // 用户点了停止（或被宿主打断）。这一行不带正文，只让 App 把那一轮标成「已停止」并摊开：
        // 桌面口径是 aborted / error 不折叠，App 收不到这个信号就只能当成正常结束，把整轮收进
        // 一行「已完成，用时 …」里 —— 跑了几十步、最后没有收尾答复的那一轮会整轮从屏幕上消失。
        out.push({ id: `turn-${e.data.turn}`, kind: 'turn-aborted', seq, time });
      }
    }
    // tool/result 等其余类型照旧忽略（工具结果在预扫描里配对回填；compaction 行由 start/end 发出）。
  }
  // 过程清单按轮回填：`steps` 只带摘要与位置，正文要用户点开某一步时再去取。
  if (stepsByTurn.size > 0) {
    for (const [turn, steps] of stepsByTurn) {
      const opener = openerByTurn.get(turn);
      if (!opener || steps.length === 0) continue;
      opener.turnProcess = {
        ...(opener.turnProcess && typeof opener.turnProcess === 'object' ? opener.turnProcess : {}),
        count: steps.length,
        steps,
        ...(Number.isSafeInteger(opener.seq) ? { startSeq: opener.seq } : {}),
      };
    }
  }
  // 产出清单按轮回填：这一轮所有 write / edit 的并集，挂到这一轮每条 assistant 消息上。
  // 挂「整轮」而不是「从写那一刻起」，与桌面 `selectProducedFiles(owner)` 同口径；正文里
  // 提到这一轮写的文件就能解析成可点（App 侧按文件名或整条路径唯一命中才画，见
  // `viewmodels/file-mentions`）。
  if (producedItems.length > 0) {
    for (const { item, turn } of producedItems) {
      const bucket = producedByTurn.get(turn);
      if (bucket && bucket.size > 0) item.producedFiles = [...bucket];
    }
  }
  // 压缩行带一个空正文：直播侧的同款行本来就带 `text: ''`（App 的 `structuralItems`
  // 一条不落），历史这边少这一格时，没跟上判空修复的旧安装包会在这条行上直接读正文、
  // 当场抛错、整页崩掉（2026-10-27 真机）。标题与摘要照旧按 kind 走，不读这个字段；
  // 其它结构行刻意不带（与 `history-turn-end` 守卫钉的形状一致）。
  for (const item of out) {
    if (item.kind === 'compaction' && typeof item.text !== 'string') item.text = '';
  }
  // 严格按事件 seq 升序（与消息混排；compaction 行升级/替换后位置以最终事件为准）。
  out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return out;
}

/**
 * 入口窗口的「内容化」裁剪（`GET /session/messages?thin=1`，只对不带 beforeSeq / afterSeq 的
 * 一次性入口窗口生效；往上翻页与增量补拉保持完整）。
 *
 * 入口原来按「消息条数」截尾巴，而宿主每跑一个 agent 步就落一条 assistant 消息，长回合最后
 * 几十条可能全是过程消息，用户自己那句话被挤出窗口。现在按「轮」分组，只留用户消息、助手
 * 正文、带图消息与结构化行；过程明细不下发，每轮裁掉多少项挂在开头那条用户消息的
 * `turnProcess` 上，点开时按 startSeq / endSeq 回头要那一轮的事件。
 *
 * 窗口最老那一组没有起点（截断正好切在一轮中间）时整组丢掉，否则会画出「凭空冒出的 AI
 * 发言」，它会被「加载更早」整轮补回。
 *
 * 三种「出卡」工具（定时任务 / 计划 / 扩展卡）的调用块要留一条，轮尾那几张卡是从工具块现算
 * 的，整块丢掉会让卡凭空不见。新增一种轮尾卡时要同步这里。
 */
const ENTRY_OUTCOME_TOOLS = new Set(['schedule_create', 'exit_plan_mode', 'extension_present']);

/** 一轮的起点：用户自己发的消息，或定时任务唤醒的那一行。 */
function isEntryTurnOpener(item) {
  return Boolean(item) && typeof item === 'object'
    && (item.role === 'user' || item.kind === 'wake');
}

function thinEntryMessages(items, options = {}) {
  if (!Array.isArray(items) || items.length === 0) return items;
  const hasMore = options.hasMore === true;
  const groups = [];
  let group = null;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (isEntryTurnOpener(item) || group === null) {
      group = { opener: isEntryTurnOpener(item) ? item : null, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  const out = [];
  for (let index = 0; index < groups.length; index += 1) {
    const { opener, items: groupItems } = groups[index];
    // 最老那半轮：没有用户消息当起点，整组丢掉（交给「加载更早」）。整页只有这一组时不丢 ——
    // 那是「单独一轮就超过入口上限」的极端形状，丢了等于入口全空，宁可先摊开这一轮的文字。
    if (opener === null && hasMore && index === 0 && groups.length > 1) continue;
    let processCount = 0;
    let hasKeptAssistant = false;
    const kept = [];
    for (const item of groupItems) {
      // 结构化行与唤醒行原样保留：体量小，而且「已停止 / 处理失败 / 已压缩」是这一轮的状态。
      if (isEntryTurnOpener(item) || item.kind !== undefined) {
        kept.push(item);
        continue;
      }
      if (item.role === 'user') { kept.push(item); continue; }
      if (item.role !== 'assistant') { kept.push(item); continue; }
      const blocks = Array.isArray(item.blocks) ? item.blocks : [];
      const keptBlocks = [];
      let stripped = 0;
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        // **每一个过程块都记进 processCount**，包括因为要出轮尾卡而留下的那几个 ——
        // 这个数是给 App 的「这一轮一共多少项过程」用的，它按自己派生出的过程项递减；
        // 只数「被摘掉的」会让保留的那几块扣不掉，App 那边提前减到 0、加载入口消失，
        // 真正没载入的过程反倒没处点了。
        // 空推理块在 deriveMessages 里就被丢掉了（`parseBlocks` 只留有文字的），这里也
        // 不能数 —— 数了 App 就少扣一项，那一轮的加载入口永远差着数。
        if (block.type === 'reasoning') {
          if (typeof block.text === 'string' && block.text) { processCount += 1; stripped += 1; }
          continue;
        }
        if (block.type === 'tool-call') {
          processCount += 1;
          if (typeof block.name === 'string' && ENTRY_OUTCOME_TOOLS.has(block.name)) keptBlocks.push(block);
          else stripped += 1;
          continue;
        }
        keptBlocks.push(block);
      }
      const hasText = typeof item.text === 'string' && item.text !== '';
      const hasContent = hasText
        || keptBlocks.some((block) => block.type === 'image' || block.type === 'tool-call')
        || (Array.isArray(item.images) && item.images.length > 0)
        || (Array.isArray(item.unavailableImages) && item.unavailableImages.length > 0);
      if (!hasContent) continue;
      kept.push(stripped > 0 ? { ...item, blocks: keptBlocks } : item);
      hasKeptAssistant = true;
    }
    // 一轮里一条助手消息都没留下（整轮只在跑工具、被停止）：交付声明照样得留个落脚处。
    if (opener !== null && !hasKeptAssistant) {
      const presented = groupItems
        .filter((item) => Array.isArray(item.presentedFiles) && item.presentedFiles.length > 0)
        .flatMap((item) => item.presentedFiles);
      if (presented.length > 0) {
        const at = kept.indexOf(opener);
        if (at >= 0) kept[at] = { ...opener, presentedFiles: presented };
      }
    }
    if (opener !== null && processCount > 0 && Number.isSafeInteger(opener.seq)) {
      const last = groupItems[groupItems.length - 1];
      const endSeq = Number.isSafeInteger(last.seq) ? last.seq : opener.seq;
      const at = kept.indexOf(opener);
      if (at >= 0) {
        // 清单（`steps`）随入口窗口一起下发：过程正文不在线上，这一行摘要就是用户
        // 「值不值得点开」的全部依据，摘掉它这一轮就没法点开了。
        const steps = opener.turnProcess && Array.isArray(opener.turnProcess.steps)
          ? opener.turnProcess.steps
          : null;
        kept[at] = {
          ...kept[at],
          turnProcess: {
            startSeq: opener.seq,
            endSeq,
            count: steps ? steps.length : processCount,
            ...(typeof last.time === 'number' ? { endTime: last.time } : {}),
            ...(steps ? { steps } : {}),
          },
        };
      }
    }
    for (const item of kept) out.push(item);
  }
  return out;
}

// 信封拆解的唯一实现在 lib/mobile/envelope.js。这里只是为了让既有
// `require('./history-derive.js').unwrap` 继续可用（对外导出面不变）。
const { unwrap } = require('./envelope.js');

const MODEL_UNAVAILABLE_ERROR = {
  code: 'model-unavailable',
  message: '当前没有可用的模型，请先在模型选择器中选择一个可用模型',
};

/**
 * 宿主错误的 details 原样透传。移动端据此把 attachment-error 映射成中文提示，
 * 读的是与桌面端 attachmentErrorText 同一个 details.reason 契约
 * （MODEL_DOES_NOT_SUPPORT_IMAGES / TOO_MANY_IMAGES / IMAGE_TOO_LARGE …）。
 * 只接受纯对象：Error 实例、数组一律丢弃，避免污染 JSON 响应。
 */
function errorDetails(error) {
  const details = error && typeof error === 'object' ? error.details : undefined;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const proto = Object.getPrototypeOf(details);
  if (proto !== Object.prototype && proto !== null) return undefined;
  return details;
}

function promptErrorObject(error) {
  if (error && typeof error === 'object') {
    const code = typeof error.code === 'string' ? error.code : '';
    const message = typeof error.message === 'string' ? error.message : '';
    const text = `${code} ${message}`.toLowerCase();
    if (
      ['no-model', 'model-unavailable', 'model-not-found', 'model-not-routable', 'no-provider', 'provider-unavailable', 'not-routable'].includes(code.toLowerCase())
      || /no (?:usable |available |selected |configured )?model|model[^\n]*(?:unavailable|not found|not configured|not routable|missing|required)|no provider|provider[^\n]*(?:unavailable|not found|not configured|missing|required)|没有(?:可用的)?模型|模型[^\n]*(?:不可用|未配置|不存在|缺失|必需)|提供商[^\n]*(?:不可用|未配置|缺失)/i.test(text)
    ) return { ...MODEL_UNAVAILABLE_ERROR };
    if (code || message) {
      const details = errorDetails(error);
      return {
        ...(code ? { code } : { code: 'prompt-failed' }),
        message: message || '消息发送失败',
        ...(details ? { details } : {}),
      };
    }
  }
  const message = error instanceof Error ? error.message : String(error || '');
  const text = message.toLowerCase();
  if (/no (?:usable |available |selected |configured )?model|no provider|没有(?:可用的)?模型|模型[^\n]*(?:不可用|未配置|不存在|缺失)/i.test(text)) return { ...MODEL_UNAVAILABLE_ERROR };
  return { code: 'prompt-failed', message: message || '消息发送失败' };
}

/**
 * 移动端提示词用的 rpcId 前缀。宿主把 source.rpcId 原样回带在 user 消息上，
 * 移动端据此把乐观行和历史里的真消息对上号。
 */
const MOBILE_PROMPT_RPC_PREFIX = 'mobile:';

/**
 * 从 user 消息里取回移动端的 clientMessageId。优先用显式字段；老宿主只把它塞在
 * source.rpcId 里，两条路都认，历史重同步才不会把乐观行变成重复行。
 */
function clientMessageIdFromSource(source, message) {
  if (message && typeof message.clientMessageId === 'string' && message.clientMessageId) return message.clientMessageId;
  if (!source || typeof source !== 'object' || source.kind !== 'user' || typeof source.rpcId !== 'string') return undefined;
  return source.rpcId.startsWith(MOBILE_PROMPT_RPC_PREFIX)
    ? source.rpcId.slice(MOBILE_PROMPT_RPC_PREFIX.length) || undefined
    : undefined;
}

module.exports = {
  listTitle,
  presentedPathsOf,
  deriveMessages,
  thinEntryMessages,
  unwrap,
  errorDetails,
  promptErrorObject,
  MODEL_UNAVAILABLE_ERROR,
  buildToolResultMap,
  toolResultPatchesFor,
  parseBlocks,
  blocksToText,
  lastMessageOf,
  MOBILE_PROMPT_RPC_PREFIX,
  clientMessageIdFromSource,
};

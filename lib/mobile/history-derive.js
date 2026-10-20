'use strict';

/**
 * 会话历史的纯派生逻辑：从 host history 事件折叠出 v1 移动端的消息/结构化项。
 *
 * 本模块只做「事件 → 展示结构」的纯计算，不碰 ctx、不发 RPC，因此可以单独测；
 * 原先这些函数与路由 handler 混在 lib/mobile/sessions.js 里（该文件 1964 行），
 * 拆出来后 handler 层只负责 HTTP 与宿主交互。
 */

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

/** 单文件一行文本的传输上限：整文件 create/overwrite 的 newText 可能极大，超出即截断并标记。 */
const DIFF_TEXT_MAX_LINES = 400;
/** 一次工具调用最多回传的 diff 文件数（对齐桌面「一行一张卡」的粒度，避免畸形 meta 撑爆载荷）。 */
const DIFF_MAX_FILES = 20;

/** 按行数截断一段 diff 文本；未超限原样返回，超限保留前 MAX 行并标记 truncated。 */
function capDiffText(text) {
  if (typeof text !== 'string') return undefined;
  let lines = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
    if (lines >= DIFF_TEXT_MAX_LINES) {
      return { text: text.slice(0, i), truncated: true };
    }
  }
  return { text, truncated: false };
}

/**
 * 收窄 tool/result 的 `data.meta`（write/edit 的 FsDiffMeta）为可回传的 diff 列表。
 *
 * 桌面 diff 卡的数据源头就是这里：fs 工具把「已应用的分块上下文 diff」挂在
 * `result.meta` 上（dsh-tool-fs 的 computeHunkDiffs，DIFF_CONTEXT=3），
 * agent loop 原样写进 tool/result 事件（dsh-agent-loop/lib/index.js:313
 * `...result.meta !== void 0 ? { meta: result.meta } : {}`），并随会话日志持久化。
 * 此前移动端投影只读 message.content，把 meta 整个丢掉——于是 App 里 write/edit
 * 只剩一坨 JSON 参数，而桌面显示的是真正改了什么。
 *
 * 只接受形状正确的条目（path 非空字符串、newText 字符串、oldText 字符串或 null），
 * 畸形数据返回 undefined 让调用方退回通用卡片，绝不抛错。
 */
function normalizeResultDiffs(meta) {
  if (!meta || typeof meta !== 'object' || !Array.isArray(meta.diffs)) return undefined;
  const out = [];
  for (const raw of meta.diffs) {
    if (!raw || typeof raw !== 'object') continue;
    const path = typeof raw.path === 'string' && raw.path !== '' ? raw.path : undefined;
    const newText = capDiffText(raw.newText);
    if (path === undefined || newText === undefined) continue;
    const oldText = typeof raw.oldText === 'string' ? capDiffText(raw.oldText) : undefined;
    if (raw.oldText !== null && raw.oldText !== undefined && typeof raw.oldText !== 'string') continue;
    out.push({
      path,
      oldText: oldText === undefined ? null : oldText.text,
      newText: newText.text,
      ...newText.truncated || (oldText && oldText.truncated) ? { truncated: true } : {},
    });
    if (out.length >= DIFF_MAX_FILES) break;
  }
  return out.length > 0 ? out : undefined;
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
 *  - 块上有 `attachmentId`：下发**引用** `{ mediaType, name?, attachmentId }`，**不带 data**。
 *    字节由手机端要画的时候按 attachmentId 单张去取（`/session/attachment`），
 *    历史响应因此不再背着几十张截图的 base64。
 *  - 块里本来就只有内联 `data`、没有 attachmentId：照旧下发 `{ mediaType, data, name? }`。
 *    这条兜底不能删——老日志、工具结果里存在这种直接带字节的图片块。
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
  if (attachmentId) return { mediaType, ...(name !== undefined ? { name } : {}), attachmentId };
  if (typeof block.data === 'string' && block.data) return { mediaType, data: block.data, ...(name !== undefined ? { name } : {}) };
  return null;
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

/** 预扫描 tool/result 事件，构建 callId → {isError, code} 映射（对接桌面 toolRowModel 状态派生）。 */
function buildToolResultMap(events) {
  const map = new Map();
  for (const entry of events) {
    const e = entry.event || entry;
    if (e.type !== 'tool/result' || !e.data || !e.data.message) continue;
    const msg = e.data.message;
    const src = msg.source;
    if (!src || typeof src.callId !== 'string') continue;
    const { parts, isError } = toolResultParts(msg);
    const code = e.data.error && typeof e.data.error.code === 'string' ? e.data.error.code : undefined;
     const output = parts.map((part) => {
       if (part && typeof part.text === 'string') return part.text;
       if (part && typeof part === 'object' && part.type === 'image') return '';
        try { return JSON.stringify(part); } catch { return ''; }
     }).filter(Boolean).join('');
     const images = toolResultImages(parts);
      const diffs = normalizeResultDiffs(e.data.meta);
      map.set(src.callId, { isError, code, ...(output ? { output } : {}), ...(images.length ? { images } : {}), ...(diffs ? { diffs } : {}) });
  }
  return map;
}

/** 把 assistant message.content 解析为一个结构块数组（text/reasoning/tool-call/image）。 */
function parseBlocks(blocks, toolResults) {
  if (!Array.isArray(blocks)) return [];
  const out = [];
  for (const b of blocks) {
    if (!b || typeof b.type !== 'string') continue;
    if (b.type === 'text' && typeof b.text === 'string' && b.text) {
      out.push({ type: 'text', text: b.text });
    } else if (b.type === 'reasoning') {
      // Reasoning blocks may be emitted as empty placeholders when the provider
      // does not expose chain-of-thought. They are known blocks, not unsupported
      // content; silently omit empty placeholders and avoid leaking their JSON.
      if (typeof b.text === 'string' && b.text) out.push({ type: 'reasoning', text: b.text });
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
      // tool-call 块字段为 id/name/arguments（与 harness toAssistantBlock 同口径）。
      const callId = b.id != null ? String(b.id) : undefined;
      let state;
       let output;
       let images;
       let diffs;
      if (callId && toolResults) {
        const result = toolResults.get(callId);
        if (result) {
          output = result.output;
           images = result.images;
           // write/edit 的已应用分块 diff（桌面 diff 卡的数据源）；结果侧权威，
           // 有它就替换掉仅凭 arguments 猜出来的调用态。
           diffs = result.diffs;
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
         ...diffs && diffs.length ? { diffs } : {},
      });
    } else {
      // 桌面端对未知 assistant block 使用 JsonBlock 兜底；移动端没有对应组件，
      // 先保留原始内容为可见文本，避免历史重同步后该节点整体消失。
      out.push({ type: 'text', text: `[未支持的内容块]\n${JSON.stringify(b)}` });
    }
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
 * 从 history 事件折叠出消息与「结构化行」（wire v1 扩展，向后兼容）：
 *  - 普通消息维持现状：{ id, seq, time, role, text, blocks?, images?, clientMessageId? }（user/assistant）；
 *  - compaction：{ kind:'compaction', id, seq, time, state:'running'|'done'|'failed', error?, turn?,
 *    summary?, shadowedItemCount?, shadowedTokenCount? }；
 *    压缩检查点 user/message（source.kind==='plugin' && source.plugin==='compact'）绝不渲染成用户气泡，
 *    渲染成 compaction 行（id=compactionId，state='done'），并用同 compactionId 的 compaction/summary 补 counts；
 *    compaction/end 给这次尝试落定（带 error → state='failed' + error 原文，否则 'done'）；
 *    **同一轮里的多次尝试只占一行**（新尝试原地顶替还没落定的那条）—— 宿主一步重试一次，
 *    不并就是几十条「正在压缩…」；
 *  - retry：{ kind:'retry', id: retryId, seq, time, status:'scheduled'|'started', retry, maxRetries, delayMs?, failure? }；
 *  - turn-error / max-tokens：{ kind:'turn-error', id:'turn-<turn>', message, code? } / { kind:'max-tokens', id:'turn-<turn>' }；
 *  - command：{ kind:'command', id:commandId, name, status:'running'|'done', resultKind?, text? }
 *    （command/run 发出行，command/done 原地升级：name 保 run 的，resultKind/text 取 done 的）。
 * 结构化项与消息按事件 seq 升序混排返回；旧载荷字段缺失时跳过对应项，绝不抛错。
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

  // 普通消息（user/assistant）沿用原折叠逻辑。
  const pushMessage = (msg, e) => {
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
    const images = [
      ...blocks.filter((b) => b.type === 'image'),
      ...toolImages,
    ].map(({ mediaType, data, name, attachmentId }) => ({
      mediaType,
      ...(typeof name === 'string' ? { name } : {}),
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
    const producedFiles = blocks.filter((block) => block.type === 'tool-call' && (block.name === 'write' || block.name === 'edit') && block.state === 'ok').map((block) => {
       try {
         const args = JSON.parse(block.argsRaw || '{}');
         return typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : null;
       } catch { return null; }
     }).filter((path) => typeof path === 'string');
     if (producedFiles.length > 0) item.producedFiles = [...new Set(producedFiles)];
     // 单轮计时只挂 assistant 消息（user/message 无 step 计时）。
    if (item.role !== 'user') {
      const timing = timingOf(e);
      if (timing) item.timing = timing;
    }
    out.push(item);
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
      // turn/end 每轮一次，一条消息只对应一条行：error → turn-error；max-tokens → max-tokens；其余 kind 忽略。
      if (e.data.reason.kind === 'error') {
        const err = e.data.reason.error;
        if (!err || typeof err.message !== 'string') continue;
        const item = { id: `turn-${e.data.turn}`, kind: 'turn-error', message: err.message, seq, time };
        if (typeof err.code === 'string' && err.code !== '') item.code = err.code;
        out.push(item);
      } else if (e.data.reason.kind === 'max-tokens') {
        out.push({ id: `turn-${e.data.turn}`, kind: 'max-tokens', seq, time });
      }
    }
    // tool/result 等其余类型照旧忽略（工具结果在预扫描里配对回填；compaction 行由 start/end 发出）。
  }
  // 严格按事件 seq 升序（与消息混排；compaction 行升级/替换后位置以最终事件为准）。
  out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
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
  deriveMessages,
  unwrap,
  errorDetails,
  promptErrorObject,
  MODEL_UNAVAILABLE_ERROR,
  capDiffText,
  normalizeResultDiffs,
  buildToolResultMap,
  parseBlocks,
  blocksToText,
  lastMessageOf,
  MOBILE_PROMPT_RPC_PREFIX,
  clientMessageIdFromSource,
};

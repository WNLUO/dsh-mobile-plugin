'use strict';

/**
 * 移动线路的减法：宿主事件里哪些字段不下发给手机。
 *
 * App 的对话页不看「过程」（跑了哪些命令、读了哪些文件），所以推理、工具参数、工具结果的
 * 正文与 write/edit 的 diff 都不上线路。工具参数这一笔两头都要收：落定的 tool-call 块只剩
 * 骨架，流式 `tool-call-delta` 里逐帧推的那份 `argumentsDelta`（`write` / `edit` 就是整份
 * 文件内容）也只留帧、不留内容。留下三样：工具结果里的图片（渲染层要画），以及三张轮尾卡的
 * 料 —— 计划卡读 `exit_plan_mode` 的 `plan`、扩展卡读 `extension_present` 的 `extension`、
 * 定时任务卡解析 `schedule_create` 结果的 JSON。
 *
 * 直播帧循环（stream.js）与历史派生（history-derive.js）调的是同一份实现。同一条规则写两份，
 * 迟早漂成「直播里还带着推理、拉一次历史又没有了」。
 */

/**
 * 三张轮尾卡要用的工具：只有它们的 `arguments` 原文留着。
 *
 * 与 `history-derive.js` 的 `ENTRY_OUTCOME_TOOLS`（薄入口给哪些出卡调用留一行）不是同一张
 * 表：那张管「一轮只留几条调用」，这张管「参数发不发」，只是成员恰好一样。新增轮尾卡时
 * 两边都要看一眼。
 */
const ARGUMENT_KEEP_TOOLS = new Set(['exit_plan_mode', 'extension_present', 'schedule_create']);

/**
 * 结果正文唯一保留的一项：定时任务卡解析它上面的 JSON，解不出来就不出卡（见 App 的
 * `turn-tail-cards`），所以这份正文一个字都不能少、也不能截断。
 */
const OUTPUT_KEEP_TOOLS = new Set(['schedule_create']);

/** 这一块内容是不是图片（附件引用、内联字节、还原失败三种形状都算）。 */
function isImagePart(part) {
  return Boolean(part) && typeof part === 'object' && part.type === 'image';
}

/** 工具结果的内容块：只留图片块，正文（text 与其它一切）整条不要。 */
function cutToolResultParts(parts) {
  if (!Array.isArray(parts)) return parts;
  const kept = parts.filter(isImagePart);
  return kept.length === parts.length ? parts : kept;
}

/**
 * 工具结果的内容：两种形状都认（当前是块数组、老日志是 `{ isError, content }` 信封），
 * 信封壳必须原样留着 —— 结果级失败态挂在它上面（与 `history-derive.js` 的 `toolResultParts`
 * 同一口径），剥掉壳子失败的工具就会显示成成功。
 */
function cutToolResultContent(content) {
  if (!Array.isArray(content)) return content;
  const first = content[0];
  const envelope = content.length === 1 && first && typeof first === 'object' && typeof first.type !== 'string' ? first : null;
  if (!envelope) return cutToolResultParts(content);
  const inner = Array.isArray(envelope.content) ? envelope.content : [];
  const kept = cutToolResultParts(inner);
  return kept === inner ? content : [{ ...envelope, content: kept }];
}

/**
 * 一条 `tool/result` 事件：只留 callId、状态与图片（`state` 由 `message.isError` 与
 * `data.error.code` 派生，两者都要留着），正文只给 `OUTPUT_KEEP_TOOLS` 里的工具留着，
 * `data.meta`（write/edit 的已应用 diff）整条丢掉。
 */
function cutToolResultEvent(event, toolName) {
  const data = event && event.data;
  if (!data || typeof data !== 'object') return event;
  const message = data.message;
  if (!message || typeof message !== 'object') return event;
  const content = OUTPUT_KEEP_TOOLS.has(toolName) ? message.content : cutToolResultContent(message.content);
  if (content === message.content && data.meta === undefined) return event;
  const { meta: _droppedDiffs, ...rest } = data;
  return { ...event, data: { ...rest, message: content === message.content ? message : { ...message, content } } };
}

/**
 * 一块 assistant 内容：推理整块不要，tool-call 收成骨架 `{ type, id, name }`。
 * 返回 `null` 表示这一块不下发；返回原对象表示原样下发。
 */
function cutAssistantBlock(block) {
  if (!block || typeof block !== 'object') return block;
  if (block.type === 'reasoning') return null;
  if (block.type !== 'tool-call') return block;
  if (ARGUMENT_KEEP_TOOLS.has(block.name)) return block;
  const skeleton = { type: 'tool-call' };
  if (block.id !== undefined) skeleton.id = block.id;
  if (block.name !== undefined) skeleton.name = block.name;
  return skeleton;
}

/** assistant/message 的内容块：逐块过上面那一条规则（没改动的帧原样返回，省一次复制）。 */
function cutAssistantContent(content) {
  if (!Array.isArray(content)) return content;
  let changed = false;
  const out = [];
  for (const block of content) {
    const kept = cutAssistantBlock(block);
    if (kept !== block) changed = true;
    if (kept !== null) out.push(kept);
  }
  return changed ? out : content;
}

/** 一条 `assistant/message` 事件：content 过上面那一条规则。 */
function cutAssistantEvent(event) {
  const data = event && event.data;
  const message = data && data.message;
  if (!message || typeof message !== 'object' || !Array.isArray(message.content)) return event;
  const content = cutAssistantContent(message.content);
  if (content === message.content) return event;
  return { ...event, data: { ...data, message: { ...message, content } } };
}

/**
 * 一条 `tool/call` 事件：与 tool-call 块同一条规则 —— 只为三张轮尾卡的工具留 `arguments`
 * （其余一律只留 `callId` / `name`）。宿主把这条事件原样追进会话日志，手机今天收得到每一次
 * 调用的完整参数（bash 命令行、文件路径都在里面），而 App 对这条事件没有任何消费者。
 * 认不出工具名时按「不留」处理：宁可少一份参数，也不把别的调用原样发出去。
 */
function cutToolCallEvent(event) {
  const data = event && event.data;
  if (!data || typeof data !== 'object') return event;
  if (typeof data.name === 'string' && ARGUMENT_KEEP_TOOLS.has(data.name)) return event;
  if (data.arguments === undefined) return event;
  const { arguments: _droppedArguments, ...rest } = data;
  return { ...event, data: rest };
}

/**
 * 一块流式增量：`tool-call-delta` 的参数正文不下发，帧本身照留（App 靠它知道有工具开始了，
 * `index` / `id` / `name` 也就是配对要用的那几个字段）。这条是整个减法里最贵的一笔 ——
 * `write` / `edit` 的参数就是整份文件内容，按 token 一帧地推给手机。
 */
function cutAssistantChunkEvent(event) {
  const data = event && event.data;
  const chunk = data && data.chunk;
  if (!chunk || typeof chunk !== 'object' || chunk.type !== 'tool-call-delta') return event;
  if (chunk.argumentsDelta === undefined) return event;
  const { argumentsDelta: _droppedArguments, ...rest } = chunk;
  return { ...event, data: { ...data, chunk: rest } };
}

/**
 * 事件类型 → 这条事件该怎么减：能减的类型走对应的一条规则，其余原样透传。
 * 直播帧循环与回放都调它，一次判完，避免两处各判一半。
 */
function cutEvent(event, names) {
  if (!event || typeof event !== 'object') return event;
  if (event.type === 'assistant/message') return cutAssistantEvent(event);
  if (event.type === 'assistant/chunk') return cutAssistantChunkEvent(event);
  if (event.type === 'tool/result') {
    const source = event.data && event.data.message && event.data.message.source;
    return cutToolResultEvent(event, names && source ? names.nameOf(source.callId) : undefined);
  }
  if (event.type === 'tool/call') return cutToolCallEvent(event);
  return event;
}

/**
 * callId → 工具名。
 *
 * `tool/result` 自己不带动工具名（只有 `source.callId`），而「这条结果的正文要不要留」
 * 取决于工具名，所以要在事件流里把配对攒起来。三个来源：`tool/call` 事件、assistant 消息
 * 里的 tool-call 块、流式 tool-call 增量。攒不到名字就按「不留正文」处理 —— 宁可少一张
 * 定时任务卡（权威历史那条路会补上），也不能把别的工具输出当成卡的料发出去。
 */
function createToolNameIndex() {
  const byCallId = new Map();
  const remember = (rawId, rawName) => {
    if (rawId === undefined || rawId === null) return;
    const callId = typeof rawId === 'string' ? rawId : String(rawId);
    if (!callId || typeof rawName !== 'string' || rawName === '') return;
    byCallId.set(callId, rawName);
  };
  const absorb = (event) => {
    const data = event && event.data;
    if (!data || typeof data !== 'object') return;
    if (event.type === 'tool/call') {
      remember(data.callId, data.name);
      return;
    }
    if (event.type === 'assistant/chunk') {
      const chunk = data.chunk;
      if (chunk && typeof chunk === 'object') remember(chunk.id, chunk.name);
      return;
    }
    if (event.type !== 'assistant/message') return;
    const content = data.message && Array.isArray(data.message.content) ? data.message.content : null;
    if (!content) return;
    for (const block of content) {
      if (block && block.type === 'tool-call') remember(block.id, block.name);
    }
  };
  return {
    absorb,
    /** 一次把一批事件（回放取回的历史窗口）吸进来。 */
    absorbAll: (events) => { for (const entry of events || []) absorb(entry && entry.event ? entry.event : entry); },
    nameOf: (callId) => (callId === undefined || callId === null ? undefined : byCallId.get(typeof callId === 'string' ? callId : String(callId))),
  };
}

module.exports = {
  ARGUMENT_KEEP_TOOLS,
  OUTPUT_KEEP_TOOLS,
  cutEvent,
  cutAssistantBlock,
  cutAssistantContent,
  cutAssistantEvent,
  cutToolCallEvent,
  cutToolResultContent,
  cutToolResultEvent,
  createToolNameIndex,
};

'use strict';

/**
 * ACP 的 `session/update` 事件 → 手机对话页认识的块（`CliBlock`）。
 *
 * 这一层就是整个「对话式 CLI」的翻译器，它之所以能这么薄，是因为 ACP 本身就是照着
 * 「编辑器里的一个对话」设计的：正文、思考、工具调用、计划、审批各是独立事件，不需要
 * 去猜终端屏幕。
 *
 * 两条只在这里成立的口径：
 *
 *   - **流式正文按 `messageId` 合并成一条块**。ACP 的 `agent_message_chunk` 是逐段推的，
 *     同一个 `messageId` 的若干 chunk 属于同一条消息；换成新 `messageId`（或没有 id）才
 *     另起一条。块的 `id` 直接由它派生成 `a:<messageId>`，所以重连重放与实时增量落到同一处。
 *   - **不加 `user_message_chunk`**。宿主自己记得用户发过什么（`pushUser`），ACP 那边回显
 *     的那一份要是也画出来，手机上每条提问都会出现两遍。
 *
 * 块只增不改顺序：工具调用按 `callId` 原地更新，计划整表替换（ACP 就是这么定的）。
 */

let autoSeq = 0;

function nextId(prefix) {
  autoSeq += 1;
  return `${prefix}:${Date.now().toString(36)}-${autoSeq.toString(36)}`;
}

/** ACP 的工具状态四档 → 手机的三档（pending / in_progress 都还是「在跑」）。 */
function toolState(status) {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'error';
  return 'running';
}

/** 工具内容的正文：ACP 允许文本 / diff / 终端引用三种，手机上只画文本那一种。 */
function textOfToolContent(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'content' && item.content && item.content.type === 'text' && typeof item.content.text === 'string') {
      parts.push(item.content.text);
    } else if (item.type === 'diff' && typeof item.path === 'string') {
      parts.push(item.path);
    }
  }
  return parts.join('\n');
}

/**
 * 工具调用的正文。
 *
 * 优先取结构化的 `content`（ACP 里是文本 / diff / 终端引用），没有就退到 `rawOutput`：
 * codex 那边执行结果只出现在 `rawOutput` 里，`content` 一直是空的 —— 只认前者的话手机上
 * 每一条工具卡都不带结果。
 */
function outputOf(update) {
  const fromContent = textOfToolContent(update.content);
  if (fromContent) return fromContent;
  const raw = update.rawOutput;
  if (typeof raw === 'string') return clip(raw, 4000);
  if (raw && typeof raw === 'object') return clip(JSON.stringify(raw), 4000);
  return '';
}

function textOfBlock(block) {
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'text' && typeof block.text === 'string') return block.text;
  if (block.type === 'resource_link' && typeof block.uri === 'string') return block.uri;
  return '';
}

function clip(value, max) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * 一条会话的块表。
 *
 * `apply` 只改表并把「变了的块」交出来，广播由服务层做 —— 它才知道该不该攒批。
 */
function createBlockLog() {
  /** 有序块；`index` 存同一批对象的引用，改属性即改表里那一份。 */
  const blocks = [];
  const index = new Map();

  function put(block) {
    blocks.push(block);
    index.set(block.id, block);
    return block;
  }

  function appendText(id, kind, text, at) {
    const existing = index.get(id);
    if (!existing) return put({ id, kind, text, at, streaming: true });
    existing.text += text;
    existing.streaming = true;
    return existing;
  }

  return {
    /** 只读快照（`hello` 帧用），复制一层免得调用方改了表里的对象。 */
    list() {
      return blocks.map((block) => ({ ...block }));
    },

    size() {
      return blocks.length;
    },

    /** 用户发出去的这一条（我们自己的记录，见文件头）。 */
    pushUser(text, at) {
      return put({ id: nextId('u'), kind: 'user', text, at });
    },

    notice(level, text, at) {
      return put({ id: nextId('n'), kind: 'notice', level, text, at });
    },

    /** 一轮结束了：把还在流式的正文收口（否则那一行永远带着光标）。 */
    settle(at) {
      const changed = [];
      for (const block of blocks) {
        if (!block.streaming) continue;
        block.streaming = false;
        block.at = at || block.at;
        changed.push(block);
      }
      return changed;
    },

    /**
     * 收下一条 `session/update`。
     *
     * 返回 `{ block }`（有块变了，广播它）、`{ title }`（只改了标题）、或 `null`（不关心）。
     */
    apply(update, at) {
      if (!update || typeof update !== 'object') return null;
      const kind = update.sessionUpdate;

      if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
        const text = textOfBlock(update.content);
        if (!text) return null;
        const isText = kind === 'agent_message_chunk';
        const id = `${isText ? 't' : 'r'}:${update.messageId || 'main'}`;
        return { block: appendText(id, isText ? 'text' : 'reasoning', text, at) };
      }

      if (kind === 'tool_call') {
        const id = `c:${update.toolCallId}`;
        const block = {
          id,
          kind: 'tool',
          callId: update.toolCallId,
          name: typeof update.name === 'string' ? update.name : '',
          title: typeof update.title === 'string' ? update.title : '',
          state: toolState(update.status),
          argsRaw: update.rawInput === undefined ? '' : clip(JSON.stringify(update.rawInput), 2000),
          output: outputOf(update),
          at,
        };
        const existing = index.get(id);
        if (!existing) return { block: put(block) };
        Object.assign(existing, block, { at: existing.at });
        return { block: existing };
      }

      if (kind === 'tool_call_update') {
        const id = `c:${update.toolCallId}`;
        const existing = index.get(id);
        if (!existing) return null;
        if (typeof update.title === 'string' && update.title) existing.title = update.title;
        if (typeof update.name === 'string' && update.name) existing.name = update.name;
        if (update.status) existing.state = toolState(update.status);
        if (update.rawInput !== undefined) existing.argsRaw = clip(JSON.stringify(update.rawInput), 2000);
        const output = outputOf(update);
        if (output) existing.output = output;
        return { block: existing };
      }

      if (kind === 'plan') {
        const entries = Array.isArray(update.entries) ? update.entries : [];
        const steps = entries.map((entry) => ({
          text: typeof entry.content === 'string' ? entry.content : '',
          status: typeof entry.status === 'string' ? entry.status : 'pending',
        }));
        const existing = index.get('plan');
        if (existing) {
          existing.steps = steps;
          existing.at = at;
          return { block: existing };
        }
        return { block: put({ id: 'plan', kind: 'plan', steps, at }) };
      }

      if (kind === 'session_info_update') {
        const title = typeof update.title === 'string' ? update.title.trim() : '';
        return title ? { title } : null;
      }

      if (kind === 'notice') {
        const title = typeof update.title === 'string' ? update.title : '';
        const detail = typeof update.description === 'string' ? update.description : '';
        if (!title && !detail) return null;
        return {
          block: put({
            id: nextId('n'),
            kind: 'notice',
            level: update.severity === 'error' ? 'error' : 'info',
            text: detail ? `${title}：${detail}` : title,
            at,
          }),
        };
      }

      // `usage_update` / `available_commands_update` / 压缩那几档这一版不画。
      return null;
    },
  };
}

module.exports = { createBlockLog, toolState };

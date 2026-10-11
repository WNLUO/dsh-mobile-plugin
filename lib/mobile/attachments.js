'use strict';

/**
 * 图片归一：会话历史存的是 `{type:'image', attachment}` 而不是内联字节，
 * 手机端拿到后要经 session attachment RPC 把图片取回来。
 *
 * 宿主事件里图片可能出现在四处：message/content、inserted 上下文项、
 * assistant chunk 的 block，以及更深的嵌套 content。全部在这里归一，
 * 这样历史与 SSE 暴露给手机端的内联图片形状是同一个。
 *
 * 另外一类图片在正文里：`![](/abs/path.png)` 这种指向**宿主本机文件**的写法
 * （本机绝对路径、file://、~）在手机上取不到字节，也会被 App 当成非 http 图片降级成字面
 * markdown。这里顺手按同一形状内联成 data URI（实现与预算见 local-images.js）。
 */

const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');
const { inlineTextImages, createTextImageBudget } = require('./local-images.js');

/**
 * Resolve durable image references before exposing messages to mobile clients.
 * Session history stores `{type:'image', attachment}` rather than inline bytes;
 * the mobile client resolves these through the session attachment RPC.
 *
 * Host events can carry content in several places: message/content, inserted
 * context items, or an assistant/chunk block. Keep this normalization here so
 * history and SSE expose the same inline-image shape to mobile clients.
 *
 * Text blocks additionally get local-file image syntax inlined as data URIs
 * (see local-images.js); `opts.budget` is a shared per-response budget so one
 * paged history response or mirror snapshot stays bounded.
 */
async function resolveEventAttachments(ctx, sessionId, event, opts = {}) {
  if (!event || !event.data || typeof event.data !== 'object') return event;
  const data = event.data;
  const budget = opts.budget || createTextImageBudget();
  let nextData = data;
  let eventChanged = false;

  const resolveBlock = async (block) => {
    if (!block || typeof block !== 'object') return block;
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = await inlineTextImages(block.text, budget);
      return text === block.text ? block : { ...block, text };
    }
    if (block.type === 'image' && !block.data && block.attachment) {
      const attachmentId = block.attachment.attachmentId;
      if (typeof attachmentId !== 'string' || !attachmentId) return block;
      let result;
      try {
        result = unwrap(await callSessions(ctx, 'attachment', { sessionId, attachmentId }));
      } catch {
        return block;
      }
      if (result.error || !result.value || typeof result.value.data !== 'string') return block;
      const attachment = result.value.attachment || block.attachment;
      return {
        type: 'image',
        attachment,
        mediaType: attachment.mediaType || block.attachment.mediaType,
        data: result.value.data,
        ...(typeof attachment.name === 'string' ? { name: attachment.name } : {}),
      };
    }
    if (Array.isArray(block.content)) {
      const nested = await Promise.all(block.content.map(resolveBlock));
      return nested.some((part, index) => part !== block.content[index]) ? { ...block, content: nested } : block;
    }
    return block;
  };

  const resolveContent = async (content) => {
    if (!Array.isArray(content)) return content;
    const resolved = await Promise.all(content.map(resolveBlock));
    return resolved.some((part, index) => part !== content[index]) ? resolved : content;
  };

  const replaceContent = async (owner, key = 'content') => {
    if (!owner || typeof owner !== 'object' || !Array.isArray(owner[key])) return;
    const content = await resolveContent(owner[key]);
    if (content === owner[key]) return;
    eventChanged = true;
    return { ...owner, [key]: content };
  };

  if (data.message && typeof data.message === 'object') {
    const message = await replaceContent(data.message);
    if (message) nextData = { ...nextData, message };
  }
  const root = await replaceContent(nextData);
  if (root) nextData = root;

  if (Array.isArray(nextData.inserted)) {
    const inserted = await Promise.all(nextData.inserted.map(async (entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      return (await replaceContent(entry)) || entry;
    }));
    if (inserted.some((entry, index) => entry !== nextData.inserted[index])) {
      eventChanged = true;
      nextData = { ...nextData, inserted };
    }
  }

  const chunk = nextData.chunk;
  if (chunk && typeof chunk === 'object' && chunk.block && typeof chunk.block === 'object') {
    const block = await resolveBlock(chunk.block);
    if (block !== chunk.block) {
      eventChanged = true;
      nextData = { ...nextData, chunk: { ...chunk, block } };
    }
  }

  return eventChanged ? { ...event, data: nextData } : event;
}

module.exports = { resolveEventAttachments };

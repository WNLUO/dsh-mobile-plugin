'use strict';

/**
 * 图片归一：会话历史存的是 `{type:'image', attachment}` 而不是内联字节。
 *
 * 宿主事件里图片可能出现在四处：message/content、inserted 上下文项、assistant chunk 的
 * block，以及更深的嵌套 content；全部在这里归一，历史与 SSE 暴露给手机的图片形状才一致。
 *
 * 默认（`referencesOnly`）不取字节：图片块留着 `attachment` 引用，由 history-derive 投影成
 * `{mediaType, name?, attachmentId}`，手机按 attachmentId 单张去取。每张都内联 base64 会把
 * 一页 200 条带截图的响应推到近 10MB。只有显式 `referencesOnly: false` 才取回字节，取不到
 * 的打 `dataUnavailable` 标。
 *
 * 正文里 `![](/abs/path.png)` 这类指向宿主本机文件的写法另有内联（见 local-images.js），
 * 与附件引用是两件事：它没有 attachmentId。
 */

const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');
const { cwdOf } = require('./session-cwd.js');
const { inlineTextImages, createTextImageBudget, hasRelativeImage } = require('./local-images.js');

/**
 * 取不到字节的图片块：原样留着，只加一个标记。
 *
 * 这里绝不能抛，也绝不能返回 null：结果会直接摊进整段历史响应或一整帧 SSE，一个 null
 * 或异常会让整页消息一起挂掉。加标记是因为「附件取不到」和「本来就没有这张图」在 App 侧
 * 长得一样，不加标记就只能静默消失，用户也不知道有过一张图。
 */
function dataUnavailableBlock(block) {
  return { ...block, dataUnavailable: true };
}

async function resolveEventAttachments(ctx, sessionId, event, opts = {}) {
  if (!event || !event.data || typeof event.data !== 'object') return event;
  const data = event.data;
  const budget = opts.budget || createTextImageBudget();
  // 引用模式（默认）：图片块只留 attachment 引用，**一次宿主 RPC 都不发**。
  // 只有显式 referencesOnly:false 才走下面那条把字节取回来的老路。
  const referencesOnly = opts.referencesOnly !== false;
  let nextData = data;
  let eventChanged = false;

  const resolveBlock = async (block) => {
    if (!block || typeof block !== 'object') return block;
    if (block.type === 'text' && typeof block.text === 'string') {
      // 相对地址的图片按会话工作区解析（与桌面端同口径）：只有正文里真的出现这种写法时
      // 才去查一次会话列表，同一份 budget（一条响应）只查一次。
      if (budget.cwd === undefined && hasRelativeImage(block.text)) budget.cwd = await cwdOf(ctx, sessionId);
      const text = await inlineTextImages(block.text, budget);
      return text === block.text ? block : { ...block, text };
    }
    if (block.type === 'image' && !block.data && block.attachment) {
      const attachmentId = block.attachment.attachmentId;
      if (typeof attachmentId !== 'string' || !attachmentId) return block;
      // 引用模式到此为止：块原样返回，字节由手机端按 attachmentId 单张去取。
      if (referencesOnly) return block;
      let result;
      try {
        result = unwrap(await callSessions(ctx, 'attachment', { sessionId, attachmentId }));
      } catch {
        return dataUnavailableBlock(block);
      }
      if (result.error || !result.value || typeof result.value.data !== 'string') return dataUnavailableBlock(block);
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

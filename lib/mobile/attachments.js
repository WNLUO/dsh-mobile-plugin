'use strict';

/**
 * 图片归一：会话历史存的是 `{type:'image', attachment}` 而不是内联字节。
 *
 * 宿主事件里图片可能出现在四处：message/content、inserted 上下文项、
 * assistant chunk 的 block，以及更深的嵌套 content。全部在这里归一，
 * 这样历史与 SSE 暴露给手机端的图片形状是同一个。
 *
 * **默认（引用模式 `opts.referencesOnly`）不取字节**：图片块原样留着 `attachment`
 * 引用，由 history-derive 投影成 `{mediaType, name?, attachmentId}`，手机端要画的时候
 * 按 attachmentId 单张去取（`/session/attachment`）。此前这里把每张图都换成内联 base64，
 * 一页 200 条带十几张截图的响应接近 10MB，每次进会话都要重传一遍。
 *
 * 只有显式传 `referencesOnly: false` 时才回到「经 session attachment RPC 取回字节」的
 * 老行为；取不回字节的块打 `dataUnavailable` 标（语义不变，见 dataUnavailableBlock）。
 *
 * 另外一类图片在正文里：`![](/abs/path.png)` 这种指向**宿主本机文件**的写法
 * （本机绝对路径、file://、~）在手机上取不到字节，也会被 App 当成非 http 图片降级成字面
 * markdown。这里顺手按同一形状内联成 data URI（实现与预算见 local-images.js）。
 * 这条与附件引用是两件事：它走的是正文里的路径、没有 attachmentId，预算与行为保持原样。
 */

const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');
const { inlineTextImages, createTextImageBudget } = require('./local-images.js');

/**
 * Resolve durable image references before exposing messages to mobile clients.
 *
 * Session history stores `{type:'image', attachment}` rather than inline bytes.
 * By default (`referencesOnly`) the block is left as a reference and the mobile
 * client fetches the bytes per attachment (`/session/attachment`); no host RPC
 * happens on this path at all. Pass `referencesOnly: false` for the legacy
 * inline-bytes shape.
 *
 * Host events can carry content in several places: message/content, inserted
 * context items, or an assistant/chunk block. Keep this normalization here so
 * history and SSE expose the same image shape to mobile clients.
 *
 * Text blocks additionally get local-file image syntax inlined as data URIs
 * (see local-images.js); `opts.budget` is a shared per-response budget so one
 * paged history response or mirror snapshot stays bounded.
 */
/**
 * 取不到字节的图片块：原样留着，只加一个标记。
 *
 * 这里**绝不能抛，也绝不能返回 null**：resolveBlock 的结果会直接摊进整段历史响应或
 * 一整帧 SSE，一个 null/异常会让整页消息一起挂掉（见 dev-map A3-33 的刻意设计）。
 * 加标记是因为「附件取不到」和「这条消息本来就没有这张图」在 App 侧长得一样（都只有
 * attachment 没有 data），不加标记就只能跟着静默消失——用户既不知道有过一张图，
 * 也没有任何重试入口。
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

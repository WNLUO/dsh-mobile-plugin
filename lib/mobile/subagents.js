// rc.5 子代理目录与 prompt 约定：external 只展示，续话能力由宿主能力探测决定。
'use strict';

/**
 * 移动端「子代理」API：把某个会话派出去的子代理目录转给手机。
 *
 * 手机侧栏把 `origin === 'subagent'` 的行直接跳过，于是用户既不知道会话派过子代理，也没有
 * 入口打开它。子会话在普通消息接口里只有带 durable parent address（parentSessionId + mode）
 * 才能读，而 /sessions 只给 origin/parentSessionId，mode 来自这里的子代理目录。
 *
 * 0.2.0 没有 subagent.list 这个 RPC，目录由 host-bridge.js 从会话投影的 subagentCatalog
 * 重建（形状仍是 entries + parentAvailable）；本文件只做形状收敛、限长与限条数。
 */

const crypto = require('node:crypto');
const { sendJson, readJsonBody } = require('../shared/http-util');
const { unwrap } = require('./sessions.js');
const { promptOnceFor } = require('./session-cache.js');
const { inlineUploadedImageBlocks } = require('./uploads.js');
const { subagentPromptCapabilities } = require('./host-bridge/endpoints.js');

// 子代理条数上限。长程会话实测能派到两百多个（反馈 #19 / #20），早先的 100 会把后面的整段
// 静默截掉、手机上看不见也点不进。现在按实际数量取，只留一个防异常宿主的兜底量级。
const SUBAGENT_MAX_ENTRIES = 2000;
const SUBAGENT_ID_MAX = 200;       // 会话 id 长度上限
const SUBAGENT_LABEL_MAX = 200;    // 条目显示名截断长度
// 0.2.0 的会话投影多了第三种 mode 'unknown'：目录说这条子会话存在，但宿主还没读到
// 它的子代理身份（session/subagent 投影没算出来），所以既不能当成一次性也不能当成
// 可继续。桌面端对它的处理是当只读 + 显示「模式未知」，这里跟着放行。
const SUBAGENT_MODES = new Set(['one-shot', 'continuable', 'unknown', 'external']);
const SUBAGENT_ACTIVITIES = new Set(['running', 'inactive']);
const SUBAGENT_REASONS = new Set(['corrupt', 'unsupported', 'unavailable']);
const SUBAGENT_PROMPT_MAX_BODY = Math.ceil(8 * 1024 * 1024 * 4 / 3);  // 与主会话图片请求同档，宿主再做附件限制
const SUBAGENT_PROMPT_MAX_BLOCKS = 32;        // content 块数上限
const SUBAGENT_PROMPT_MAX_TEXT = 64 * 1024;   // 单条 text 块字符上限
const SUBAGENT_INTERRUPT_MAX_BODY = 64 * 1024;

/** 会话 id：必须是非空字符串；超长截断（纯防御异常宿主）。 */
function normalizeId(value) {
  if (typeof value !== 'string') return '';
  const id = value.trim();
  if (!id) return '';
  return id.length > SUBAGENT_ID_MAX ? id.slice(0, SUBAGENT_ID_MAX) : id;
}

/** 显示名：非字符串或空白当「没有」；超长截断补省略号。 */
function normalizeLabel(value) {
  if (typeof value !== 'string') return undefined;
  const label = value.trim();
  if (!label) return undefined;
  return label.length > SUBAGENT_LABEL_MAX ? `${label.slice(0, SUBAGENT_LABEL_MAX)}…` : label;
}

/**
 * 把 subagent.list 的一条条目压成手机需要的形状；坏条目直接丢掉。
 *
 * 两种 kind 的必填字段不同：child 要 mode/activity/hasChildren 都合法才留，
 * diagnostic 只要有 id + 认识的 reason。child 的 label 保持可选（宿主对
 * continuable 才保证有），App 侧缺省回落到 id —— 与桌面端 `entry.label ?? entry.id`
 * 一致，猜一个假名字反而会误导用户。
 */
function normalizeSubagentEntry(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const id = normalizeId(item.id);
  if (!id) return null;

  if (item.kind === 'diagnostic') {
    if (!SUBAGENT_REASONS.has(item.reason)) return null;
    const relation = {};
    for (const key of ['name', 'description', 'path']) {
      const text = normalizeLabel(item[key]);
      if (text !== undefined) relation[key] = text;
    }
    const parentSessionId = normalizeId(item.parentSessionId || item.parentId);
    if (parentSessionId) Object.assign(relation, { parentId: parentSessionId, parentSessionId });
    if (Number.isInteger(item.depth) && item.depth >= 1 && item.depth <= 128) relation.depth = item.depth;
    return { kind: 'diagnostic', id, reason: item.reason, ...relation };
  }

  if (item.kind !== 'child') return null;
  if (!SUBAGENT_MODES.has(item.mode)) return null;
  if (!SUBAGENT_ACTIVITIES.has(item.activity)) return null;
  if (typeof item.hasChildren !== 'boolean') return null;

  const label = normalizeLabel(item.label);
  const name = normalizeLabel(item.name);
  const description = typeof item.description === 'string' && item.description.trim() ? item.description.trim() : undefined;
  const parentSessionId = normalizeId(item.parentSessionId || item.parentId);
  const path = typeof item.path === 'string' && item.path.trim() ? item.path.trim() : undefined;
  const depth = Number.isInteger(item.depth) && item.depth >= 1 && item.depth <= 128 ? item.depth : undefined;
  return {
    kind: 'child', id, mode: item.mode, activity: item.activity, hasChildren: item.mode === 'external' ? false : item.hasChildren,
    ...(name === undefined ? {} : { name }),
    ...(label === undefined ? {} : { label }),
    ...(description === undefined ? {} : { description }),
    ...(parentSessionId === '' ? {} : { parentSessionId, parentId: parentSessionId }),
    ...(path === undefined ? {} : { path }),
    ...(depth === undefined ? {} : { depth }),
    ...(item.mode !== 'continuable' ? { targetAvailable: false } : typeof item.targetAvailable === 'boolean' ? { targetAvailable: item.targetAvailable } : item.targetAvailable === null ? { targetAvailable: null } : {}),
  };
}

/**
 * 收敛 subagent.list 的 value：非数组当空目录，坏条目丢掉，按 id 去重（保留先出现的），
 * 再截到上限。parentAvailable 用严格比较 —— 宿主漏字段时按「父会话不在线」处理，
 * 与桌面端「父会话不在线 → 只读」的判定方向一致，猜真值会让手机端误以为还能发消息。
 */
function normalizeSubagentList(value) {
  const raw = value && typeof value === 'object' && Array.isArray(value.entries) ? value.entries : [];
  const entries = [];
  const seen = new Set();
  for (const item of raw) {
    const entry = normalizeSubagentEntry(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
    if (entries.length >= SUBAGENT_MAX_ENTRIES) break;
  }
  const rootSessionId = normalizeId(value && value.rootSessionId);
  const rootAvailable = value && value.rootAvailable;
  return {
    entries,
    parentAvailable: Boolean(value && value.parentAvailable === true),
    ...(rootSessionId ? { rootSessionId } : {}),
    ...(typeof rootAvailable === 'boolean' || rootAvailable === null ? { rootAvailable } : {}),
  };
}

/** GET /api/mobile/v1/subagents?sessionId=… —— 这个会话派出去的子代理目录（只读）。 */
async function handleSubagents(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const sessionId = (url.searchParams.get('sessionId') || '').trim();
  if (!sessionId) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 sessionId' } });

  const controller = new AbortController();
  // 注意命名空间是复数 subagents（apiProxy.subagents.list），而 RPC 方法名是单数
  // subagent.list —— 宿主两处不对称，写错只会得到 "Cannot read properties of
  // undefined (reading 'list')" 这种 500，所以这里别按方法名顺手改成单数。
  const { value, error } = unwrap(await ctx.apiProxy.subagents.list({
    rpcId: 'mobile',
    method: 'subagent.list',
    payload: { parentSessionId: sessionId },
  }, controller.signal));
  if (error) return sendJson(res, 400, { ok: false, error });

  sendJson(res, 200, { ok: true, ...normalizeSubagentList(value), capabilities: subagentCapabilities(ctx) });
}

/** 从请求体里取一个必填的会话 id（trim 后仍为空就当没给）。 */
function readId(body, key) {
  const value = body && body[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 把续话请求的 content 收敛成宿主 subagent.prompt 认的形状。
 *
 * 图片仅在宿主严格 prompt descriptor 明确支持时开放；未知与旧宿主保留原来的拒绝码。
 * uploadId 只在插件上传暂存区解析，最终字节仍交宿主附件服务做准入与持久化。
 */
function subagentCapabilities(ctx) {
  return subagentPromptCapabilities(ctx);
}

function normalizePromptContent(body, options = {}) {
  let content;
  if (Array.isArray(body.content)) content = body.content;
  else if (typeof body.text === 'string' && body.text.trim()) content = [{ type: 'text', text: body.text }];
  else return { error: { code: 'bad-request', message: '需要 content 数组或 text' } };

  if (content.length === 0) return { error: { code: 'bad-request', message: 'content 不能为空' } };
  if (content.length > SUBAGENT_PROMPT_MAX_BLOCKS) {
    return { error: { code: 'bad-request', message: `content 一次最多 ${SUBAGENT_PROMPT_MAX_BLOCKS} 块` } };
  }

  const blocks = [];
  for (const block of content) {
    if (!block || typeof block.type !== 'string') {
      return { error: { code: 'bad-request', message: 'content 块缺少 type' } };
    }
    if (block.type === 'image') {
      if (options.images !== true) return { error: { code: 'attachment-error', message: '子代理续话不支持图片输入。', details: { reason: 'SUBAGENT_IMAGE_UNSUPPORTED' } } };
      const mediaTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
      const inline = typeof block.data === 'string' && block.data.length > 0;
      const uploaded = typeof block.uploadId === 'string' && block.uploadId.length > 0;
      if (!mediaTypes.includes(block.mediaType) || (!inline && !uploaded)) return { error: { code: 'bad-request', message: 'image 块需合法 mediaType 与 base64 data 或 uploadId' } };
      blocks.push({ type: 'image', mediaType: block.mediaType, ...(inline ? { data: block.data } : { uploadId: block.uploadId }), ...(typeof block.name === 'string' && block.name ? { name: block.name } : {}) });
      continue;
    }
    if (block.type !== 'text') {
      return { error: { code: 'bad-request', message: `不支持的 content 块类型: ${block.type}` } };
    }
    if (typeof block.text !== 'string' || !block.text.trim()) {
      return { error: { code: 'bad-request', message: 'text 块内容为空' } };
    }
    if (block.text.length > SUBAGENT_PROMPT_MAX_TEXT) {
      return { error: { code: 'bad-request', message: `text 块最长 ${SUBAGENT_PROMPT_MAX_TEXT} 个字符` } };
    }
    blocks.push({ type: 'text', text: block.text });
  }
  return { blocks };
}

/**
 * POST /api/mobile/v1/subagents/prompt —— 给「可继续」子代理续一条消息。
 *
 * 手机端的输入框平时只会发 session.send，而宿主对子会话的 session.prompt /
 * session.models 一律回 agent-busy（"use subagent delivery for this child session"），
 * 所以续话必须走 subagent.prompt。mode 固定 continuable：一次性子代理宿主压根
 * 不接受续话（桌面端也是先判 one-shot 再拒绝），这里不给客户端挑的机会。
 *
 * 新宿主按真实树根投递，创建者可以离线；目录中的 rootAvailable 仅供界面提示，
 * 最终投递准入仍由宿主校验，拒绝码原样返回。
 */
async function handleSubagentPrompt(ctx, req, res) {
  const body = await readJsonBody(req, SUBAGENT_PROMPT_MAX_BODY);
  const parentSessionId = readId(body, 'parentSessionId');
  const childSessionId = readId(body, 'childSessionId');
  if (!parentSessionId || !childSessionId) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'bad-request', message: '需要 { parentSessionId, childSessionId, content | text }' },
    });
  }
  const capabilities = subagentCapabilities(ctx);
  const delivery = body.delivery === undefined ? 'queue' : body.delivery;
  if (delivery !== 'queue' && delivery !== 'steer') return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: "delivery 必须为 'queue' 或 'steer'" } });
  if (delivery === 'steer' && capabilities.steer !== true) return sendJson(res, 400, { ok: false, error: { code: 'subagent-prompt-unsupported', message: '这台宿主未确认支持子代理插话投递', details: { reason: 'SUBAGENT_STEER_UNSUPPORTED' } } });
  const normalized = normalizePromptContent(body, capabilities);
  if (normalized.error) return sendJson(res, 400, { ok: false, error: normalized.error });
  const expired = await inlineUploadedImageBlocks(normalized.blocks);
  if (expired) return sendJson(res, 400, { ok: false, error: { code: 'upload-not-found', message: expired } });
  for (const block of normalized.blocks) if (block.type === 'image') delete block.uploadId;

  const clientTimeZone = typeof body.clientTimeZone === 'string' && body.clientTimeZone.trim()
    ? body.clientTimeZone.trim()
    : undefined;
  const clientMessageId = typeof body.clientMessageId === 'string' ? body.clientMessageId.trim() : '';
  const requestId = typeof body.requestId === 'string' && body.requestId.trim() ? body.requestId.trim() : clientMessageId || `mobile-subagent-${crypto.randomUUID()}`;

  const controller = new AbortController();
  const call = () => ctx.apiProxy.subagents.prompt({
    rpcId: 'mobile',
    method: 'subagent.prompt',
    payload: {
      parentSessionId,
      childSessionId,
      mode: 'continuable',
      content: normalized.blocks,
      ...(capabilities.delivery === true || body.requestId ? { requestId, delivery } : {}),
      ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
    },
  }, controller.signal);
  // 续话与主会话发送走同一条重试链路（乐观行 + 超时后自动 / 手点重发），所以同样按
  // `clientMessageId` 去重：没有它，超时的那一发多半已经在子会话里说过了，重试会说第二遍
  // （口径见 session-cache 的 `promptOnceFor`）。
  const response = clientMessageId
    ? await promptOnceFor(ctx, `subagent:${parentSessionId}:${childSessionId}:${clientMessageId}`, call)
    : await call();
  const { error } = unwrap(response);
  if (error) return sendJson(res, 400, { ok: false, error });

  // 宿主回的是 { messageId }，但手机端自己生成乐观行的 clientMessageId，用不上它。
  sendJson(res, 200, { ok: true, accepted: true });
}

/**
 * POST /api/mobile/v1/subagents/interrupt —— 打断可继续子代理当前这一轮。
 *
 * 宿主的 subagents.interrupt(request) 只声明了一个形参（与 prompt 不同），所以这里
 * 不传 signal —— 多传一个参数不会报错，但会让人误以为它有取消语义。
 */
async function handleSubagentInterrupt(ctx, req, res) {
  const body = await readJsonBody(req, SUBAGENT_INTERRUPT_MAX_BODY);
  const parentSessionId = readId(body, 'parentSessionId');
  const childSessionId = readId(body, 'childSessionId');
  if (!parentSessionId || !childSessionId) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'bad-request', message: '需要 { parentSessionId, childSessionId }' },
    });
  }

  const { error } = unwrap(await ctx.apiProxy.subagents.interrupt({
    rpcId: 'mobile',
    method: 'subagent.interrupt',
    payload: { parentSessionId, childSessionId, mode: 'continuable' },
  }));
  if (error) return sendJson(res, 400, { ok: false, error });

  sendJson(res, 200, { ok: true, accepted: true });
}

module.exports = {
  handleSubagents,
  handleSubagentPrompt,
  handleSubagentInterrupt,
  normalizeSubagentEntry,
  normalizeSubagentList,
  normalizePromptContent,
  subagentCapabilities,
};

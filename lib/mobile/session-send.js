'use strict';

/**
 * 发消息、slash 命令、会话的读/停/改名/分叉。
 *
 * promptOnce 的去重是这里唯一非平凡的逻辑：手机端发消息时网络重试与用户连点会产生
 * 同一个 clientMessageId 的多次请求，同一会话内它们共享同一个 prompt，而不是让模型跑
 * 两遍。成功之后记录一直留着（不按时间窗过期）：请求超时的那一发很可能已经交给宿主了，
 * 用户隔几分钟再点一次重试，过期的窗口正好把同一条消息又发一遍。
 * **只缓存成功**：失败必须能被重试，不能把一次瞬时错误固化成一条永远发不出去的消息。
 *
 * 文本块恰好一个且以 / 开头时派发为 slash 命令（commands.execute，不发给模型）；
 * 未知命令或网关未组合时回退普通消息，与桌面 miss 落入默认 sink 的行为一致。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');
const { inlineUploadedImageBlocks } = require('./uploads.js');
const { unwrap } = require('./envelope.js');
const { callSessions, mobilePromptRpcId } = require('./rpc.js');
const {
  canonicalDeviceKey, invalidateSessionList, invalidateSessionModels,
  markCompletionRead, promptOnceFor,
} = require('./session-cache.js');
const { promptErrorObject, MODEL_UNAVAILABLE_ERROR } = require('./history-derive.js');
const { withIdempotency, requestIdOf } = require('./idempotency.js');
const { invoke, UNAVAILABLE: GATEWAY_UNAVAILABLE } = require('./host-bridge/transport.js');
const readReceipt = require('../read-receipt.cjs');
const { recordSessionRead } = require('./session-last-turn.js');

/**
 * `/send` 的请求体上限（**明文**字节，图片 base64）。
 *
 * 原来是 8MB。协议 v2 的信封让线上变成 4/3，按线上长度直接卡等于砍掉四分之一额度，
 * 所以按 §8.3(9) 抬到 10.7MB；线上那一侧另有 `MAX_SEALED_BODY` 兜着。
 */
const SEND_MAX_BODY = Math.ceil(8 * 1024 * 1024 * 4 / 3);

/** 仅当 content 恰好为一个文本块时返回其文本，否则 null（带图片/多块不回退命令路径）。 */
function singleTextOf(content) {
  if (!Array.isArray(content) || content.length !== 1) return null;
  const block = content[0];
  if (!block || block.type !== 'text' || typeof block.text !== 'string') return null;
  return block.text;
}

/**
 * 经网关执行 slash 命令（commands.execute——桌面 Web 端同一条派发路径：
 * 命令注册表命中才执行，绝不经 session.prompt 发给模型；agent 由 agentId 经同一
 * agent 查找器解析，与 session.prompt 的 turnAgentFor 同源，支持冷会话自动 resume）。
 *
 * ⚠️ args 的键名必须**恰好**是宿主 descriptor 的 wire 名（typertGateway 的
 * assertExactArguments 只认这组名字，多一个少一个都是 gateway/arguments-invalid）。
 * descriptor：`@deepseek-ai/dsh-commands#commands/execute`，scope wire = agentId，
 * 参数 = line + submittedAttachments（encoded images 与 staged file receipts，
 * 按提交顺序排列，纯命令调用传空数组即可）。
 * 这里曾经写成 `images: []`——少了 submittedAttachments 又多了 images，导致
 * /permission、/plan 等**所有** slash 命令 400；形状守卫见
 * test/commands-execute-shape.test.cjs（改这里必须同步那张表）。
 *
 * @returns {execution} 派发成功（CommandExecution|undefined，undefined=未知命令/语法不符）
 *   | {error} 查找或派发失败 | {missing} 网关服务未组合（调用方回退普通消息）
 */
async function executeCommand(ctx, sessionId, line) {
  // 走 host-bridge/transport.js 的 invoke：Peer 身份与「服务/方法不存在」的收敛都在
  // 那里。这里只把「网关没组合」翻成 {missing}，让调用方回退普通消息。
  const called = await invoke(ctx, 'commands', 'execute', { agentId: sessionId, line, submittedAttachments: [] });
  if (called.error) {
    return called.error.code === GATEWAY_UNAVAILABLE.code ? { missing: true } : { error: called.error };
  }
  return { execution: called.value };
}

/**
 * POST /api/mobile/v1/session/send（token）
 * 兼容两种格式：
 *   旧：{sessionId, text}
 *   新：{sessionId, content:[{type:'text',text} | {type:'image',mediaType,data(base64),name?}], mode?:'queue'|'steer'}
 * 恰为单个文本块且以 / 开头时派发为 slash 命令（commands.execute，不发给模型）；
 * 其余原样透传给 harness 的 session.prompt（图片块需模型支持，不支持时错误原样返回）。
 */
function promptOnce(ctx, clientMessageId, payload) {
  const rpcId = mobilePromptRpcId(clientMessageId);
  // 把这一发认回去的身份一起送进宿主的 prompt 请求（`request.requestId`，见
  // host-bridge/endpoints.js）。宿主要是不认识它，user 消息的 `source.rpcId` 就是那个
  // 端点自己生成的 `mobile-prompt-<uuid>` —— App 那边 `clientMessageId` 永远对不上，
  // 只能靠「同文本 + 同图数」猜着认领乐观行（2026-10-20 真机：自己发的图一直「发送中」，
  // 因为实时帧里的图还被漏读，张数一对不上就彻底认领不了）。
  const request = clientMessageId ? { ...payload, requestId: rpcId } : payload;
  if (!clientMessageId) return callSessions(ctx, 'prompt', request, rpcId);
  // 同一个 clientMessageId 在本会话里只承诺一次：内核重试、以及隔了几分钟用户手点的
  // 那次，都拿同一份结果（口径见 session-cache 的 `promptOnceFor`）。
  return promptOnceFor(ctx, `${payload.sessionId}:${clientMessageId}`, () => callSessions(ctx, 'prompt', request, rpcId));
}

async function handleSend(ctx, req, res) {
  const body = await readJsonBody(req, SEND_MAX_BODY);
  if (!body || typeof body.sessionId !== 'string' || !body.sessionId) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { sessionId, content | text }' } });
  }
  const mode = body.mode;
  if (mode !== undefined && mode !== 'queue' && mode !== 'steer') {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: "mode 必须为 'queue' 或 'steer'" } });
  }
  let content;
  if (Array.isArray(body.content)) {
    content = body.content;
  } else if (typeof body.text === 'string' && body.text.trim()) {
    content = [{ type: 'text', text: body.text }];
  } else {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 content 数组或 text' } });
  }
  if (content.length === 0) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'content 不能为空' } });
  }
  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  for (const block of content) {
    if (!block || typeof block.type !== 'string') {
      return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'content 块缺少 type' } });
    }
    if (block.type === 'text') {
      if (typeof block.text !== 'string' || !block.text.trim()) {
        return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'text 块内容为空' } });
      }
    } else if (block.type === 'image') {
      // 两种形状都认：老客户端的 `data`（内联 base64），新客户端的 `uploadId`
      // （先走分片上传，再由宿主自己读盘）。后者是为了绕开 `session/send` 那 8 秒预算 ——
      // 4MB 照片内联上传线上接近 7MB，弱网必超时。
      const inline = typeof block.data === 'string' && block.data.length > 0;
      const uploaded = typeof block.uploadId === 'string' && block.uploadId.length > 0;
      if (!IMAGE_TYPES.has(block.mediaType) || (!inline && !uploaded)) {
        return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'image 块需合法 mediaType 与 base64 data 或 uploadId' } });
      }
    } else {
      return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: `不支持的 content 块类型: ${block.type}` } });
    }
  }
  // ── uploadId → 内联字节（实现在 uploads.js：字节本来就是那边落的盘）──
  const uploadExpired = await inlineUploadedImageBlocks(content);
  if (uploadExpired) {
    return sendJson(res, 400, { ok: false, error: { code: 'upload-not-found', message: uploadExpired } });
  }

  // ── Slash 命令派发 ─────────────────────────────────────────────
  // 已知命令：注册表执行（command/run + command/done 随事件流回传），响应标注 handledAs 供
  // 客户端跳过「乐观 pending 气泡 + running 态」；未知命令/语法不符（execute 返回 undefined）
  // 与网关未组合时回退普通消息（对齐桌面 miss 落入默认 sink，`/foo` 仍按文本发送）。
  const singleText = singleTextOf(content);
  if (singleText !== null && singleText.trim().startsWith('/')) {
    const outcome = await executeCommand(ctx, body.sessionId, singleText.trim());
    if (outcome.error) {
      const failure = outcome.error.failure
        || { code: 'command-error', message: outcome.error.message || String(outcome.error), details: {} };
      return sendJson(res, 400, { ok: false, error: failure });
    }
    if (outcome.execution !== undefined) {
      return sendJson(res, 200, { ok: true, accepted: true, handledAs: 'command' });
    }
  }
  let promptResponse;
  try {
    promptResponse = await promptOnce(ctx, typeof body.clientMessageId === 'string' ? body.clientMessageId : '', {
      sessionId: body.sessionId,
      ...(mode !== undefined ? { mode } : {}),
      content,
    });
  } catch (error) {
    const normalized = promptErrorObject(error);
    if (normalized.code === MODEL_UNAVAILABLE_ERROR.code) invalidateSessionModels(ctx, req, body.sessionId);
    return sendJson(res, 400, { ok: false, error: normalized });
  }
  const { error } = unwrap(promptResponse);
  if (error) {
    const normalized = promptErrorObject(error);
    if (normalized.code === MODEL_UNAVAILABLE_ERROR.code) invalidateSessionModels(ctx, req, body.sessionId);
    return sendJson(res, 400, { ok: false, error: normalized });
  }
  sendJson(res, 200, { ok: true, accepted: true });
}

/** GET /api/mobile/v1/commands?sessionId=…（token）：会话有效命令目录（与桌面 Web 端命令面板
 * 同源——commands.list，即服务端命令注册表对该 agent 生效的完整清单）。
 * 响应：{ ok, items:[{name, description, input?:{hint}}] }；网关未组合或失败时降级为空清单，
 * 客户端菜单据此只展示真实可执行的命令（不再硬编码）。
 *
 * 失败一律降级成空清单是**刻意设计**：输入区不能因为目录拉不到就报错。代价是这个端点
 * 出问题时手机上看不出任何提示，「+」菜单静默只剩媒体与文件两行 —— 2026-10 宿主升到
 * 0.2.1 要求每个请求自带 Peer，这条路径没跟上，用户看到的就是「目标、计划、指令全没了」。 */
async function handleCommands(ctx, req, res) {
  const sessionId = new URL(req.url, 'http://x').searchParams.get('sessionId');
  if (!sessionId) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 sessionId' } });
  const called = await invoke(ctx, 'commands', 'list', { agentId: sessionId });
  const descriptors = called.error ? null : called.value;
  const items = Array.isArray(descriptors)
    ? descriptors
        .filter((d) => d && typeof d.name === 'string' && d.name && typeof d.description === 'string')
        .map((d) => ({
          name: d.name,
          description: d.description,
          ...(d.input && typeof d.input === 'object' && typeof d.input.hint === 'string' && d.input.hint
            ? { input: { hint: d.input.hint } }
            : {}),
        }))
    : [];
  sendJson(res, 200, { ok: true, items });
}

/** POST /api/mobile/v1/session/read（token）{sessionId}：清除完成提醒。 */
async function handleSessionRead(ctx, req, res, fallbackDeviceKey = 'legacy') {
  const body = await readJsonBody(req);
  if (!body || typeof body.sessionId !== 'string' || !body.sessionId) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { sessionId }' } });
  }
  const deviceKey = canonicalDeviceKey(req, fallbackDeviceKey);
  // 只清这台设备自己的提醒；水位留在状态里，读过的轮次就不会再亮回来。
  markCompletionRead(ctx, deviceKey, body.sessionId);
  // 「这一轮被读过了」还要记一笔**设备无关**的水位：列表要喂镜像快照（全局一份），
  // 上面那份按设备的提醒进不了下行清单，App 那边根本看不到这次已读（见 session-last-turn.js）。
  recordSessionRead(ctx, body.sessionId);
  // Invalidate the cache and any build already reading history. Its generation
  // check prevents a stale build from restoring `completed` after this ack.
  invalidateSessionList(ctx, deviceKey);
  // 桌面端的未读绿点不在宿主里（它在浏览器渲染进程的内存里），这里只记一条水位，
  // 由插件的客户端半边拉走、在桌面页面里就地清掉。写盘失败不该让「已读」这个动作失败。
  try {
    readReceipt.recordRead(body.sessionId);
  } catch {
    // 回执台账只是尽力而为的旁路，读不到/写不动都不影响本次已读本身。
  }
  sendJson(res, 200, { ok: true, accepted: true });
}

/** POST /api/mobile/v1/session/stop（token）{sessionId} */
async function handleStop(ctx, req, res) {
  const body = await readJsonBody(req);
  if (!body || typeof body.sessionId !== 'string') {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { sessionId }' } });
  }
  const { error } = unwrap(await callSessions(ctx, 'cancel', { sessionId: body.sessionId }));
  if (error) return sendJson(res, 400, { ok: false, error });
  sendJson(res, 200, { ok: true, accepted: true });
}

/** POST /api/mobile/v1/session/rename（token）{sessionId, title} */
async function handleRename(ctx, req, res) {
  const body = await readJsonBody(req);
  if (!body || typeof body.sessionId !== 'string' || typeof body.title !== 'string' || !body.title.trim()) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { sessionId, title }' } });
  }
  // 改名结果本身是收敛的（同标题重放得到同一状态），但仍然按 requestId 重放：
  // 重投不该再打一次宿主 RPC，也不该让 App 多等一次往返。
  const outcome = await withIdempotency(ctx, canonicalDeviceKey(req), requestIdOf(req, body), async () => {
    const { value, error } = unwrap(await callSessions(ctx, 'rename', { sessionId: body.sessionId, title: body.title }));
    if (error) return { status: 400, body: { ok: false, error } };
    // 改完名字立刻丢掉列表缓存：App 保存后会马上 load(true)，那一次拉到的如果还是
    // 10 秒窗口内的旧行，用户看到的就是「保存了但侧栏没变」。
    invalidateSessionList(ctx);
    return { status: 200, body: { ok: true, ...value } };
  });
  sendJson(res, outcome.status, outcome.body);
}

/** POST /api/mobile/v1/session/fork（token）{sessionId} → {ok, sessionId(新)} */
async function handleFork(ctx, req, res) {
  const body = await readJsonBody(req);
  if (!body || typeof body.sessionId !== 'string' || !body.sessionId
    || (body.atSeq !== undefined && (!Number.isSafeInteger(body.atSeq) || body.atSeq < 0))) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { sessionId, atSeq? }' } });
  }
  const payload = { sessionId: body.sessionId,
    ...(body.atSeq === undefined ? {} : { atSeq: body.atSeq, increaseTitle: body.increaseTitle !== false }) };
  // 分叉是**非幂等**写：重投一次就多一个子会话。带 requestId 时重投拿回同一次分叉的 id。
  const outcome = await withIdempotency(ctx, canonicalDeviceKey(req), requestIdOf(req, body), async () => {
    const { value, error } = unwrap(await callSessions(ctx, 'fork', payload));
    if (error) return { status: 400, body: { ok: false, error } };
    // 新分叉出来的会话要立刻出现在列表里。
    invalidateSessionList(ctx);
    return { status: 200, body: { ok: true, ...value } };
  });
  sendJson(res, outcome.status, outcome.body);
}

/**
 * POST /api/mobile/v1/session/attachment（token）{sessionId, attachmentId}
 * → {ok, mediaType, data, name?}
 *
 * 单张图片附件重取。App 在「认得出这张图、但上一次没取回字节」时给一个重试按钮，
 * 按 attachmentId 只补这一张。不复用 /session/messages 重拉历史：那条按游标重装整个
 * 消息列表，会把用户已经向上翻出去的更早几页丢掉。
 */
async function handleSessionAttachment(ctx, req, res) {
  const body = await readJsonBody(req);
  if (!body || typeof body.sessionId !== 'string' || !body.sessionId
    || typeof body.attachmentId !== 'string' || !body.attachmentId) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { sessionId, attachmentId }' } });
  }
  const { value, error } = unwrap(await callSessions(ctx, 'attachment', { sessionId: body.sessionId, attachmentId: body.attachmentId }));
  if (error) return sendJson(res, 400, { ok: false, error });
  const data = value && typeof value.data === 'string' ? value.data : '';
  // 附件已被会话清理掉时宿主回的是空字节：这不是「稍后再试就好」，如实回 404，
  // 让 App 那边把重试按钮的失败说清楚，而不是转圈到超时。
  if (!data) return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '附件已不可读' } });
  const attachment = (value && value.attachment) || {};
  sendJson(res, 200, {
    ok: true,
    mediaType: typeof attachment.mediaType === 'string' && attachment.mediaType ? attachment.mediaType : 'image/png',
    data,
    ...(typeof attachment.name === 'string' ? { name: attachment.name } : {}),
  });
}

module.exports = { singleTextOf, executeCommand, promptOnce, handleSend, handleCommands, handleSessionRead, handleSessionAttachment, handleStop, handleRename, handleFork };

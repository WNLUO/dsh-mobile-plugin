'use strict';

/**
 * 移动端「子代理」API：把某个会话派出去的子代理目录转给手机。
 *
 * 桌面端会话标题栏里挂着一个「N 个子代理」下拉（@deepseek-ai/dsh-client-ui-subagent
 * 的 SubagentHeaderLineage）：父会话头部按 `origin === "subagent" && parentId ===
 * 当前会话` 把子代理收成一棵树，点进去能读子会话的完整记录。手机端此前把
 * `origin === 'subagent'` 的行在侧栏里直接 continue 掉（app/src/drawerGroups.ts:122），
 * 于是用户既不知道这个会话派过子代理，也没有任何入口能打开它 —— 子代理在手机上
 * 等于不存在。
 *
 * 子会话在普通消息接口中只有携带 durable parent address 才能读取（parentSessionId + mode）；
 * /sessions 只给 origin/parentSessionId，mode 则来自这里的子代理目录。缺的只是
 * 「这个会话有哪些子代理」——
 * 那正是 subagent.list 的返回值（entries + parentAvailable），这里只做形状收敛、
 * 限长与限条数，避免异常宿主把手机端列表撑爆。
 *
 * 宿主 subagent.list 的第二个形参是取消信号（内部 listChildren 会读 signal），
 * 故与 session.search 一样显式传一个 AbortController 的 signal，不裸传 undefined。
 *
 * DSH 0.2.0 没有 subagent.list 这个 RPC 了，目录改由 host-bridge.js 从会话投影的
 * subagentCatalog 重建（形状仍是 entries + parentAvailable），本文件对它的形状收敛、
 * 限长与限条数一字未动。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');
const { unwrap } = require('./sessions.js');
const { promptOnceFor } = require('./session-cache.js');

const SUBAGENT_MAX_ENTRIES = 100;  // 子代理条数上限（正常宿主只有个位数）
const SUBAGENT_ID_MAX = 200;       // 会话 id 长度上限
const SUBAGENT_LABEL_MAX = 200;    // 条目显示名截断长度
// 0.2.0 的会话投影多了第三种 mode 'unknown'：目录说这条子会话存在，但宿主还没读到
// 它的子代理身份（session/subagent 投影没算出来），所以既不能当成一次性也不能当成
// 可继续。桌面端对它的处理是当只读 + 显示「模式未知」，这里跟着放行。
const SUBAGENT_MODES = new Set(['one-shot', 'continuable', 'unknown']);
const SUBAGENT_ACTIVITIES = new Set(['running', 'inactive']);
const SUBAGENT_REASONS = new Set(['corrupt', 'unsupported', 'unavailable']);
const SUBAGENT_PROMPT_MAX_BODY = 256 * 1024;  // 续话请求体上限（只有文本，图片已拒）
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
    return { kind: 'diagnostic', id, reason: item.reason };
  }

  if (item.kind !== 'child') return null;
  if (!SUBAGENT_MODES.has(item.mode)) return null;
  if (!SUBAGENT_ACTIVITIES.has(item.activity)) return null;
  if (typeof item.hasChildren !== 'boolean') return null;

  const label = normalizeLabel(item.label);
  return {
    kind: 'child',
    id,
    mode: item.mode,
    activity: item.activity,
    hasChildren: item.hasChildren,
    ...(label === undefined ? {} : { label }),
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
  return { entries, parentAvailable: Boolean(value && value.parentAvailable === true) };
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

  sendJson(res, 200, { ok: true, ...normalizeSubagentList(value) });
}

/** 从请求体里取一个必填的会话 id（trim 后仍为空就当没给）。 */
function readId(body, key) {
  const value = body && body[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 把续话请求的 content 收敛成宿主 subagent.prompt 认的形状。
 *
 * 与 /session/send 同一套规则，但**图片一律拒绝**：桌面端在路由之前就把带 image 的
 * 续话判成 attachment-error / SUBAGENT_IMAGE_UNSUPPORTED（runtime 的 subagent 分支
 * 只把 text 块 flatMap 出去，图片根本到不了宿主）。这里跟着拒，免得静默丢块让用户
 * 以为图发出去了。
 */
function normalizePromptContent(body) {
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
      return {
        error: {
          code: 'attachment-error',
          message: '子代理续话不支持图片输入。',
          details: { reason: 'SUBAGENT_IMAGE_UNSUPPORTED' },
        },
      };
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
 * 宿主还要求父会话「在线」（ctx.agents.get(parentSessionId) 有值），否则回
 * subagent-parent-unavailable —— 这一条原样透传给 App，由它决定提示什么。
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
  const normalized = normalizePromptContent(body);
  if (normalized.error) return sendJson(res, 400, { ok: false, error: normalized.error });

  const clientTimeZone = typeof body.clientTimeZone === 'string' && body.clientTimeZone.trim()
    ? body.clientTimeZone.trim()
    : undefined;
  const clientMessageId = typeof body.clientMessageId === 'string' ? body.clientMessageId.trim() : '';

  const controller = new AbortController();
  const call = () => ctx.apiProxy.subagents.prompt({
    rpcId: 'mobile',
    method: 'subagent.prompt',
    payload: {
      parentSessionId,
      childSessionId,
      mode: 'continuable',
      content: normalized.blocks,
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
};

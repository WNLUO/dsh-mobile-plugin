'use strict';

/**
 * 移动端「引用发现」API：把桌面端输入框里的 @文件 / @会话 补全补齐到手机上。
 *
 * 两个宿主服务（fileReferences、sessionReferenceResolver）不在 apiProxy 上，是 Typert
 * Remote 服务，手机侧经 host-bridge/transport.js 的 `invoke` 到达。
 *
 * 两条接口只转发发现域，不做排序或截断之外的加工：
 *  - GET /file-references → fileReferences.list
 *  - GET /session-references → sessionReferenceResolver.candidates
 *
 * 参数按宿主 wire 名精确校验（都是 `{ agentId, query }`）。语义透传：空 query 列出全部；
 * 会话候选的 mention 必须原样发送，不能拿 label 重建；两个域各自独立降级。
 */

const { sendJson } = require('../shared/http-util');
const { invoke, UNAVAILABLE: GATEWAY_UNAVAILABLE } = require('./host-bridge/transport.js');

const REFERENCE_ID_MAX_CHARS = 200;       // sessionId 长度上限
const REFERENCE_QUERY_MAX_CHARS = 200;    // 查询串长度上限（宿主 schema 只要求 string）
const REFERENCE_MAX_ITEMS = 50;           // 与宿主 session-reference 的 candidateLimit 默认值一致
const REFERENCE_KINDS = new Set(['file', 'directory']);

/** 网关缺失/命名空间缺失对客户端是同一件事：宿主这个能力没装。 */
const UNAVAILABLE = Object.freeze({
  code: 'reference-unavailable',
  message: '宿主没有组合引用发现服务（dsh-file-reference / dsh-session-reference / dsh-api-gateway）',
});

/** 网关自己抛的错（不是业务失败）的文字化。 */
function errorText(error) {
  if (!error) return '未知错误';
  if (typeof error.message === 'string' && error.message) return error.message;
  return String(error);
}

/**
 * 经网关调一次引用发现。
 *
 * 走 host-bridge/transport.js 的 `invoke`：Peer 身份与「服务/方法不存在」的收敛都在那里。
 * 不要自己直连网关 —— 0.2.1 起每个请求都要自带 Peer，绕过去就是对 undefined 读 `.signal`。
 *
 * 网关回的是 decode 后的业务结果本体，`{ok,value}` 外壳是浏览器传输加的：messageFeedback
 * 声明的是联合，回 `{ok:true,value}`；fileReferences.list 声明的是数组，回裸数组。两个都认。
 *
 * @returns {Promise<{value?: unknown, error?: {code: string, message: string}}>}
 */
async function callReference(ctx, namespace, method, agentId, query) {
  // 两个方法的声明参数都是 agent(wire=agentId) + query(wire=query)，args 必须精确匹配；
  // 末位 signal 是可选的取消边界（gateway 会补 NEVER_ABORTED_SIGNAL），这里给真的，
  // 客户端断开时能让宿主那次发现提前收工。
  const called = await invoke(ctx, namespace, method, { agentId, query }, new AbortController().signal);
  if (called.error) {
    if (called.error.code === GATEWAY_UNAVAILABLE.code) return { error: { ...UNAVAILABLE } };
    return { error: { code: 'reference-error', message: errorText(called.error) } };
  }
  const result = called.value;
  // 正常形状：裸数组（宿主声明的 result 就是数组）
  if (Array.isArray(result)) return { value: result };
  if (result && typeof result === 'object') {
    if (result.ok === true) return { value: result.value };
    if (result.ok === false) {
      const raw = result.error && typeof result.error === 'object' ? result.error : {};
      const code = typeof raw.code === 'string' && raw.code ? raw.code : 'reference-error';
      return { error: { code, message: errorText(raw) } };
    }
  }
  return { error: { code: 'reference-error', message: '宿主引用发现服务返回了意外的结果' } };
}

/** 文件/目录候选：宿主只承诺 { path, kind }，别的形状一律丢掉。 */
function normalizeFileCandidate(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  if (typeof row.path !== 'string' || !row.path) return null;
  if (!REFERENCE_KINDS.has(row.kind)) return null;
  return { path: row.path, kind: row.kind };
}

/**
 * 会话候选：mention 是宿主的规范写法（@[label](dsh-session:…)），客户端必须原样发送，
 * 所以没有 mention 的行等于不可用，直接丢；label 缺失时退回 sessionId。
 */
function normalizeSessionCandidate(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  if (typeof row.sessionId !== 'string' || !row.sessionId) return null;
  if (typeof row.mention !== 'string' || !row.mention) return null;
  const label = typeof row.label === 'string' && row.label ? row.label : row.sessionId;
  return {
    sessionId: row.sessionId,
    label,
    mention: row.mention,
    ...(typeof row.cwd === 'string' && row.cwd ? { cwd: row.cwd } : {}),
    createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0,
  };
}

/** 会话 id 校验：空/超长直接拒绝，不把垃圾转发给宿主。 */
function normalizeId(value, label) {
  if (value === null || value === undefined) return { error: `缺少 ${label}` };
  if (typeof value !== 'string') return { error: `${label} 必须是字符串` };
  const id = value.trim();
  if (!id) return { error: `缺少 ${label}` };
  if (id.length > REFERENCE_ID_MAX_CHARS) return { error: `${label} 过长` };
  return { id };
}

/** 查询串：缺失等同空串（列出全部）；只截长度，内容原样交给宿主筛选。 */
function normalizeQuery(value) {
  if (value === null || value === undefined) return { query: '' };
  if (typeof value !== 'string') return { error: 'query 必须是字符串' };
  if (value.length > REFERENCE_QUERY_MAX_CHARS) return { error: `query 过长（上限 ${REFERENCE_QUERY_MAX_CHARS} 字符）` };
  return { query: value };
}

/** 能力缺失是 503，其余都是 400。 */
function statusOf(error) {
  if (!error) return 400;
  if (error.code === UNAVAILABLE.code) return 503;
  return 400;
}

/** 两条 GET 路由共用的骨架：校验 → 转发 → 规范化 → 限量。 */
async function handleReferenceList(ctx, req, res, spec) {
  const params = new URL(req.url, 'http://x').searchParams;
  const session = normalizeId(params.get('sessionId'), 'sessionId');
  if (session.error) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: session.error } });
  const query = normalizeQuery(params.get('query'));
  if (query.error) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: query.error } });

  const { value, error } = await callReference(ctx, spec.namespace, spec.method, session.id, query.query);
  if (error) return sendJson(res, statusOf(error), { ok: false, error });

  const rows = Array.isArray(value) ? value : [];
  const items = [];
  for (const row of rows) {
    const item = spec.normalize(row);
    if (item) items.push(item);
    if (items.length >= REFERENCE_MAX_ITEMS) break;
  }
  sendJson(res, 200, { ok: true, items });
}

/** GET /api/mobile/v1/file-references?sessionId=…&query=… → { ok, items:[{path,kind}] }。 */
function handleFileReferences(ctx, req, res) {
  return handleReferenceList(ctx, req, res, {
    namespace: 'fileReferences',
    method: 'list',
    normalize: normalizeFileCandidate,
  });
}

/**
 * GET /api/mobile/v1/session-references?sessionId=…&query=… →
 * { ok, items:[{sessionId,label,mention,cwd?,createdAt}] }。
 */
function handleSessionReferences(ctx, req, res) {
  return handleReferenceList(ctx, req, res, {
    namespace: 'sessionReferenceResolver',
    method: 'candidates',
    normalize: normalizeSessionCandidate,
  });
}

module.exports = {
  handleFileReferences,
  handleSessionReferences,
  normalizeFileCandidate,
  normalizeSessionCandidate,
  normalizeId,
  normalizeQuery,
  statusOf,
  REFERENCE_QUERY_MAX_CHARS,
  REFERENCE_MAX_ITEMS,
  REFERENCE_UNAVAILABLE: UNAVAILABLE,
};

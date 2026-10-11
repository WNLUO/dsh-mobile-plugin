'use strict';

/**
 * 会话正文检索：透传宿主 session.search（只搜 user/assistant 正文）。
 *
 * sanitizeSearchQuery 与桌面端同口径：去 NUL、去首尾空白，超过 500 个 UTF-16 码元时
 * 截断，且不把代理对劈成两半——宿主 schema 按码元算上限，截出残缺高位代理直接 400。
 *
 * 标题 / 工作区这类本地元数据不在这里拼：桌面端同样是「本地元数据匹配 + 宿主检索页」
 * 两路合并后再渲染，手机端沿用同一分工，App 拿 sessionId 回自己的列表取标题。
 */

const { sendJson } = require('../shared/http-util');
const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');

const SEARCH_QUERY_MAX_CODE_UNITS = 500;

/**
 * 与桌面端 sanitizeSearchQuery 同口径：去 NUL、去首尾空白，超过 500 个 UTF-16
 * 码元时截断，且不把代理对（surrogate pair）劈成两半 —— 宿主 schema 的上限按
 * 码元算，截出一个残缺的高位代理会让它直接 400。
 */
function sanitizeSearchQuery(value) {
  const cleaned = String(value == null ? '' : value).replace(/\0/g, '').trim();
  if (cleaned.length <= SEARCH_QUERY_MAX_CODE_UNITS) return cleaned;
  let end = SEARCH_QUERY_MAX_CODE_UNITS;
  const last = cleaned.charCodeAt(end - 1);
  const next = cleaned.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return cleaned.slice(0, end);
}

/**
 * GET /api/mobile/v1/session/search?query=…（token）→ { ok, items, hasMore }
 *
 * 透传宿主 session.search（正文检索 user/assistant 消息）。宿主只回
 * { items: [{ sessionId, snippet }], hasMore }（最多 20 条，snippet ≤ 240 码点），
 * 标题 / 工作区这类本地元数据不在这里拼：桌面端同样是「本地元数据匹配 + 宿主检索页」
 * 两路合并后再渲染，移动端沿用同一分工 —— App 拿 sessionId 回自己的会话列表取标题，
 * 取不到（已归档 / 子会话）就整条丢弃，可见性与侧栏一致。
 *
 * 注意：本部署的宿主把 session-query-sqlite 配成 `openAt: never`（正文检索是显式
 * 开启的），此时宿主以错误回应而不是空结果。这里如实透传错误，让 App 能区分
 * 「没有命中」和「这台宿主没开正文检索」，而不是把两者都显示成空列表。
 */
async function handleSessionSearch(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const query = sanitizeSearchQuery(url.searchParams.get('query'));
  if (!query) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 query' } });
  // 手机端断开时让宿主的检索循环尽快收手（宿主每个分页都会查 signal.aborted）。
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const { value, error } = unwrap(await callSessions(ctx, 'search', { query }, 'mobile', ac.signal));
  if (error) return sendJson(res, 400, { ok: false, error });
  const raw = value && Array.isArray(value.items) ? value.items : [];
  const items = [];
  for (const item of raw) {
    if (!item || typeof item.sessionId !== 'string' || !item.sessionId) continue;
    items.push({ sessionId: item.sessionId, snippet: typeof item.snippet === 'string' ? item.snippet : '' });
  }
  sendJson(res, 200, { ok: true, items, hasMore: Boolean(value && value.hasMore) });
}

module.exports = { sanitizeSearchQuery, handleSessionSearch };

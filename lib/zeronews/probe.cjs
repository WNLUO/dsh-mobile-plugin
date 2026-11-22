// 从本机 ZeroNews 客户端读取「已建好的隧道公网地址」，给面板的「一键填入直连地址」用。
'use strict';

/**
 * ZeroNews 是账号制内网穿透：隧道由用户自己在它的控制台/客户端建好，插件不碰账号、不建隧道、
 * 不占它「一个免费账号一条隧道」的限额。这里只做一件只读的事——问本机那个已经跑着的
 * ZeroNews 客户端「你现在有哪些可用的 HTTPS 隧道」，把公网地址交给面板填进「直连地址」栏。
 *
 * 为什么走宿主而不是面板直接 fetch：ZeroNews 本地 API 监听 127.0.0.1:37271，面板在浏览器里
 * 跨域读它会被 CORS 挡下（实测无 Access-Control-Allow-* 头）；宿主是本机 node 进程，读本地
 * 回环地址没有跨域问题，而且这条路径本身是 localOnly 控制面，只有本机面板能调。
 *
 * 只认 HTTPS、只认 active 的 endpoint：TCP 隧道是「主机:端口」不是 http(s) 地址，填进直连栏
 * 会被当成域名解析而失败；非 active 的（建到一半 / 已断开）填进去是个当下就拨不通的地址。
 * 一条都没有就返回空清单，面板据此说「本机没有可用的 ZeroNews 隧道」。
 */

/** ZeroNews 客户端本地 API 默认监听地址与端点路径。 */
const DEFAULT_BASE = 'http://127.0.0.1:37271';
const ENDPOINTS_PATH = '/api/v1/endpoints';
/** 本地回环读取也要设超时：客户端没起 / 端口被别的程序占住时不能让面板一直转。 */
const DEFAULT_TIMEOUT_MS = 3000;

/**
 * 一条地址长得像不像能填进「直连地址」的 https URL。
 * 复用Config 那侧的口径：只认 http(s)、必须能解析出主机。这里更严一点只收 https——
 * ZeroNews 对外就是 https 域名，明文 http 的隧道没有意义，也不该被一键填进去。
 */
function httpsUrlOf(value) {
  if (typeof value !== 'string') return '';
  const url = value.trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^\s/]+/i.test(url)) return '';
  try {
    if (!new URL(url).hostname) return '';
  } catch {
    return '';
  }
  return url;
}

/**
 * 从 ZeroNews 本地 API 的响应体里挑出可用的 HTTPS 公网地址。
 * 兼容两种形状：官方文档的 `{ code:200, data:{ items:[...] } }`，以及某些版本回的裸数组 / `{ endpoints:[...] }`。
 * 每条 endpoint 的域名可能在 `domain` 或 `public_url`；端口由 ZeroNews 自己管，域名不带端口。
 */
function extractEndpoints(payload) {
  const data = payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
  let items = [];
  if (Array.isArray(data)) items = data;
  else if (data && Array.isArray(data.items)) items = data.items;
  else if (data && Array.isArray(data.endpoints)) items = data.endpoints;
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const status = String(item.status || '').toLowerCase();
    if (status && status !== 'active') continue;
    const type = String(item.type || '').toUpperCase();
    if (type && type !== 'HTTPS') continue;
    const domain = typeof item.domain === 'string' && item.domain
      ? item.domain
      : typeof item.public_url === 'string' ? item.public_url : '';
    const url = httpsUrlOf(domain.includes('://') ? domain : `https://${domain}`);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * 读本机 ZeroNews 的可用隧道地址。
 *
 * @param {object} [options]
 * @param {string} [options.base] 本地 API 根地址（测试可注入）。
 * @param {(url: string, init: object) => Promise<any>} [options.fetchImpl] fetch 注入（测试用）。
 * @param {number} [options.timeoutMs] 读取超时。
 * @returns {Promise<{ ok: boolean, urls: string[], error: string, available: boolean }>}
 *   available=false 表示本机 API 连不上（客户端没装 / 没起）；连得上但没有可用隧道时
 *   ok=true、urls 为空。两种情况面板给不同提示。
 */
async function readZeroNewsEndpoints(options = {}) {
  const base = String(options.base || DEFAULT_BASE).replace(/\/+$/, '');
  const url = `${base}${ENDPOINTS_PATH}`;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const doFetch = typeof options.fetchImpl === 'function'
    ? options.fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  if (!doFetch) {
    return { ok: false, urls: [], available: false, error: '当前环境没有可用的 fetch' };
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await doFetch(url, {
      headers: { accept: 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response || response.ok !== true) {
      const status = response && response.status ? ` HTTP ${response.status}` : '';
      return { ok: false, urls: [], available: false, error: `本机 ZeroNews 客户端没有回应${status}` };
    }
    const payload = await response.json();
    // code 是 ZeroNews 的业务码：非 200 一律当读失败，别把错误体当隧道清单。
    if (payload && typeof payload === 'object' && 'code' in payload && payload.code !== 200) {
      return { ok: false, urls: [], available: true, error: 'ZeroNews 客户端返回了错误' };
    }
    return { ok: true, urls: extractEndpoints(payload), available: true, error: '' };
  } catch (error) {
    if (controller && controller.signal.aborted) {
      return { ok: false, urls: [], available: false, error: '读取本机 ZeroNews 超时，请确认客户端正在运行' };
    }
    const raw = error && error.message ? error.message : String(error);
    return { ok: false, urls: [], available: false, error: `连不上本机 ZeroNews 客户端：${raw}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_BASE,
  ENDPOINTS_PATH,
  httpsUrlOf,
  extractEndpoints,
  readZeroNewsEndpoints,
};

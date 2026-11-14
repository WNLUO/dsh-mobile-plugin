// 本地远程网页的边界校验与双向头隔离。
'use strict';

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const CONTROL = new Set(['authorization', 'cookie', 'host', 'origin', 'referer', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']);

function sameOrigin(req, origin, bootstrap = false) {
  if (req.headers.host !== origin.slice(7)) return false;
  if (req.rawHeaders) {
    const hosts = req.rawHeaders.filter((_, index) => index % 2 === 0).filter((name) => name.toLowerCase() === 'host');
    if (hosts.length !== 1) return false;
  }
  if (req.headers.origin !== undefined && req.headers.origin !== origin) return false;
  const site = req.headers['sec-fetch-site'];
  const navigation = req.method === 'GET' && !req.headers.origin && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
  if (site !== undefined && site !== 'same-origin' && !((bootstrap || navigation) && (site === 'none' || site === 'same-site'))) return false;
  if (bootstrap && req.headers['sec-fetch-mode'] && req.headers['sec-fetch-mode'] !== 'navigate') return false;
  if (!bootstrap && !navigation && req.headers.referer) {
    try { if (new URL(req.headers.referer).origin !== origin) return false; } catch { return false; }
  }
  return true;
}

function cookieOf(header, name) {
  const pairs = String(header || '').split(';').map((part) => part.trim());
  const values = pairs.filter((pair) => pair.startsWith(`${name}=`)).map((pair) => pair.slice(name.length + 1));
  return values.length === 1 ? values[0] : '';
}

function requestPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\r\n]/.test(value)) return null;
  try { const parsed = new URL(value, 'http://remote'); return parsed.pathname + parsed.search; } catch { return null; }
}

function upstreamHeaders(incoming, host, jar, upgrade = false) {
  const connection = new Set(String(incoming.connection || '').toLowerCase().split(',').map((part) => part.trim()));
  const headers = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || CONTROL.has(key) || HOP.has(key) || connection.has(key) || key.startsWith('x-dsh-') || key.startsWith('sec-fetch-')) continue;
    headers[key] = value;
  }
  const authority = `127.0.0.1:${host.port}`;
  headers.host = authority;
  if (incoming.origin) headers.origin = `http://${authority}`;
  if (incoming.referer) {
    try { const url = new URL(incoming.referer); headers.referer = `http://${authority}${url.pathname}${url.search}`; } catch { /* 无效引用不转发 */ }
  }
  const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  if (cookie) headers.cookie = cookie;
  if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = incoming.upgrade || 'websocket'; }
  return headers;
}

function rememberCookies(jar, raw) {
  for (const cookie of Array.isArray(raw) ? raw : raw ? [raw] : []) {
    const first = String(cookie).split(';')[0];
    const at = first.indexOf('=');
    if (at < 1) continue;
    const name = first.slice(0, at).trim();
    const value = first.slice(at + 1);
    if (!value || /;\s*max-age=0(?:;|$)/i.test(cookie)) jar.delete(name);
    else jar.set(name, value);
  }
}

function responseHeaders(incoming, localOrigin, host, upgrade = false) {
  const headers = {};
  const connection = new Set(String(incoming.connection || '').toLowerCase().split(',').map((part) => part.trim()));
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || key === 'set-cookie' || key.startsWith('x-dsh-') || HOP.has(key) || connection.has(key)) continue;
    headers[key] = value;
  }
  if (headers.location) {
    try {
      const value = String(headers.location);
      const url = new URL(value, `http://127.0.0.1:${host.port}`);
      if (url.hostname === '127.0.0.1' && Number(url.port) === Number(host.port)) {
        url.searchParams.delete('token');
        headers.location = `${localOrigin}${url.pathname}${url.search}${url.hash}`;
      } else if (value.includes(host.token)) delete headers.location;
    } catch { delete headers.location; }
  }
  if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = incoming.upgrade || 'websocket'; }
  return headers;
}

function safeRoutes(routes) {
  const seen = new Set();
  return (Array.isArray(routes) ? routes : []).flatMap((route) => {
    try {
      const url = new URL(route.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return [];
      const row = { url: url.href.replace(/\/$/, ''), channel: String(route.channel || '') };
      const key = `${row.channel}|${row.url}`;
      if (!row.channel || seen.has(key)) return [];
      seen.add(key);
      return [row];
    } catch { return []; }
  });
}

module.exports = { sameOrigin, cookieOf, requestPath, upstreamHeaders, rememberCookies, responseHeaders, safeRoutes };

// 只监听本机的远程网页入口：一次性打开链接、访问租期与按窗口自动续期。
// 每台网关各管各的租期；续期只延长期限，不重发入口地址、不动已建立的连接。
// 壳会话另发一枚只读标记：只给桌面窗口启用官方自带的让位与拖动排版。
// 2026-11-19：重签入口时保留还没被用过的一次性 ticket，避免第二个窗口的入口把先开窗口的入口覆盖掉。
// 2026-11-23：主文档首次打开先回一屏过渡页，等隧道建好再跳真实页面，桌面窗口不再空等一片白。
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { sameOrigin, cookieOf, requestPath } = require('./local-headers.cjs');
const { createUpstream } = require('./local-upstream.cjs');
const { noticeScript, createNoticeTransform } = require('./browser-notice.cjs');
const { loadingPageHtml, READY_PATH, READY_PARAM } = require('./loading-page.cjs');

const LEASE_MS = 60 * 60 * 1000;
const OPEN_MS = 60 * 1000;
const ACTIVE_MS = 5 * 60 * 1000;
const RENEW_AHEAD_MS = 5 * 60 * 1000;
const RENEW_CHECK_MS = 30 * 1000;
// 判定「桌面窗口还连着」的宽限：刚有过请求也算连着，避免页面加载空档被误判成已关闭。
const ATTACH_GRACE_MS = 4 * 1000;
const OPEN_PATH = '/__dsh_remote_open';

// 顶层文档导航才出过渡页：优先看 Fetch Metadata，缺头时退回 Accept 是否要 HTML。
// 普通子资源（脚本 / 图片 / 接口）与测试里只带 cookie 的请求都不满足，照常直接转发。
function wantsDocument(req) {
  if (req.method !== 'GET') return false;
  const dest = req.headers['sec-fetch-dest'];
  if (dest) return dest === 'document';
  return String(req.headers.accept || '').includes('text/html');
}

function createLocalGateway({ connect, expiresAt, now = Date.now, onExpire = () => {}, onError, onRenew = () => {}, platform = process.platform }) {
  const live = new Set();
  const cookieName = `dsh_remote_${crypto.randomBytes(12).toString('hex')}`;
  const shellCookie = `${cookieName}_shell`;
  const session = crypto.randomBytes(32).toString('base64url');
  let ticket = crypto.randomBytes(32).toString('base64url');
  let ticketExpiresAt = now() + OPEN_MS;
  let deadline = Math.min(Number(expiresAt) || now() + LEASE_MS, now() + LEASE_MS);
  let lastActivity = now();
  let port = 0;
  let closed = false;
  let timer = null;
  let renewing = false;
  let starting = null;
  const origin = () => `http://127.0.0.1:${port}`;
  const active = () => !closed && now() < deadline;
  const inUse = (time = now()) => !closed && (live.size > 0 || time - lastActivity < ACTIVE_MS);
  // 共享池里的加密流同样进 live，续期与到期销毁都统一走这里。
  const upstream = createUpstream({ connect, active, live, origin, expiresAt: () => deadline, onError, noticeTransform: createNoticeTransform });
  const server = http.createServer(handle);
  server.requestTimeout = 0;
  server.headersTimeout = 15000;
  server.on('connection', (socket) => {
    live.add(socket);
    lastActivity = now();
    socket.once('close', () => live.delete(socket));
    socket.on('error', () => {});
  });
  server.on('upgrade', (req, socket, head) => {
    const path = requestPath(req.url);
    if (!active() || !path || !sameOrigin(req, origin()) || cookieOf(req.headers.cookie, cookieName) !== session) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    lastActivity = now();
    req.url = path;
    void upstream.upgrade(req, socket, head);
  });
  server.on('clientError', (_error, socket) => socket.destroy());

  function reply(res, status, text) {
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
      'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    });
    res.end(text);
  }

  async function handle(req, res) {
    const path = requestPath(req.url);
    if (!path || !active()) return reply(res, 410, '本次访问已到期，请在本机面板重新打开。');
    const url = new URL(path, origin());
    const bootstrap = url.pathname === OPEN_PATH;
    if (!sameOrigin(req, origin(), bootstrap)) return reply(res, 403, '只允许从本机入口访问。');
    if (bootstrap) {
      const value = url.searchParams.get('ticket');
      if (req.method !== 'GET' || !ticket || now() >= ticketExpiresAt || value !== ticket) return reply(res, 403, '打开链接已失效，请在本机面板重新打开。');
      ticket = '';
      const cookies = [`${cookieName}=${session}; Path=/; HttpOnly; SameSite=Strict`];
      // 只有从桌面壳打开的那一次入口带它；同一个入口用普通浏览器打开时保持网页版。
      if (url.searchParams.get('shell') === '1') cookies.push(`${shellCookie}=1; Path=/; HttpOnly; SameSite=Strict`);
      res.writeHead(303, {
        location: '/', 'set-cookie': cookies,
        'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      });
      res.end(); return;
    }
    if (cookieOf(req.headers.cookie, cookieName) !== session) return reply(res, 401, '请从本机面板打开这台电脑。');
    lastActivity = now();
    if (url.pathname === '/__dsh_remote_status' || url.pathname === '/__dsh_remote_notice.js') {
      if (req.method !== 'GET') return reply(res, 405, '只读入口。');
      const status = url.pathname === '/__dsh_remote_status';
      res.writeHead(200, { 'content-type': status ? 'application/json; charset=utf-8' : 'application/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      if (status) { res.end(JSON.stringify({ expiresAt: deadline, serverNow: now() })); return; }
      const shell = cookieOf(req.headers.cookie, shellCookie) === '1';
      res.end(noticeScript({ shell, platform })); return;
    }
    // 过渡页的就绪探测：这里才真正建起加密流，成不成如实回给页面。
    if (url.pathname === READY_PATH) {
      if (req.method !== 'GET') return reply(res, 405, '只读入口。');
      const type = 'application/json; charset=utf-8';
      try {
        await upstream.prime();
        if (closed || res.destroyed) return;
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(JSON.stringify({ ok: true, expiresAt: deadline }));
      } catch (error) {
        if (closed || res.destroyed) return;
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(JSON.stringify({ ok: false, code: error?.code || 'REMOTE_CONNECT' }));
      }
      return;
    }
    // 顶层文档还没建好隧道时先给过渡页，别让桌面窗口空等一片白。
    if (url.pathname === '/' && wantsDocument(req) && !url.searchParams.has(READY_PARAM) && !upstream.isReady()) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
      });
      res.end(loadingPageHtml()); return;
    }
    // 过渡页跳转带来的内部标记不转给远端。
    if (url.searchParams.has(READY_PARAM)) {
      url.searchParams.delete(READY_PARAM);
      req.url = url.pathname + url.search;
    } else req.url = path;
    void upstream.forward(req, res);
  }

  function arm() {
    clearTimeout(timer);
    const remaining = Math.max(1, deadline - now());
    timer = setTimeout(checkExpiry, Math.min(remaining, RENEW_CHECK_MS));
    timer.unref?.();
  }

  function close() {
    if (closed) return;
    closed = true;
    ticket = '';
    clearTimeout(timer);
    upstream.close();
    for (const stream of live) stream.destroy();
    live.clear();
    if (server.listening) server.close();
  }

  function checkExpiry() {
    if (closed) return false;
    if (now() >= deadline) { close(); onExpire(); return true; }
    void autoRenew(now());
    arm(); return false;
  }

  /** 临期且窗口还在用就原地续：只推期限，不重发入口、不动已建立的连接，页面不会刷新。 */
  async function autoRenew(time = now()) {
    if (closed || renewing || !active() || deadline - time > RENEW_AHEAD_MS || !inUse(time)) return false;
    renewing = true;
    try { await renew(); onRenew(deadline); return true; }
    catch { return false; }
    finally { renewing = false; }
  }

  async function renew(value = now() + LEASE_MS) {
    if (!active()) { checkExpiry(); throw Object.assign(new Error('访问已到期，请重新打开'), { code: 'REMOTE_EXPIRED' }); }
    let next = Math.min(Number(value) || now() + LEASE_MS, now() + LEASE_MS);
    const streams = [...live].filter((stream) => typeof stream.renew === 'function' && !stream.destroyed);
    const accepted = await Promise.all(streams.map((stream) => stream.renew(next)));
    const added = [...live].filter((stream) => !streams.includes(stream) && typeof stream.renew === 'function' && !stream.destroyed);
    accepted.push(...await Promise.all(added.map((stream) => stream.renew(next))));
    if (!active()) { checkExpiry(); throw Object.assign(new Error('访问已到期，请重新打开'), { code: 'REMOTE_EXPIRED' }); }
    for (const result of accepted) if (Number.isFinite(result)) next = Math.min(next, result);
    deadline = next;
    arm(); return { expiresAt: deadline };
  }

  return {
    start() {
      if (starting) return starting;
      starting = new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          if (closed) { server.close(); reject(Object.assign(new Error('访问已停止'), { code: 'REMOTE_CONNECT' })); return; }
          server.on('error', () => close());
          port = server.address().port;
          server.unref?.(); arm();
          resolve({ url: `${origin()}${OPEN_PATH}?ticket=${ticket}`, expiresAt: deadline });
        });
      });
      return starting;
    },
    openLink() {
      if (!active()) throw Object.assign(new Error('访问已到期，请重新打开'), { code: 'REMOTE_EXPIRED' });
      // 还没被任何窗口用掉的 ticket 保留：同一个入口再点一次也还是它，先开的窗口不会因为
      // 第二个窗口重签拿到失效入口；只有用完（ticket 已清空）或过期才换新的。
      if (!ticket || now() >= ticketExpiresAt) {
        ticket = crypto.randomBytes(32).toString('base64url');
        ticketExpiresAt = now() + OPEN_MS;
      }
      return { url: `${origin()}${OPEN_PATH}?ticket=${ticket}`, expiresAt: deadline };
    },
    renew,
    expiresAt: () => deadline,
    /** 桌面窗口此刻是否连着：有活连接，或刚有过请求（关闭判定给 4 秒宽限，避免加载空档误报）。 */
    attached() { return !closed && (live.size > 0 || now() - lastActivity < ATTACH_GRACE_MS); },
    inUse,
    autoRenew,
    disconnect() { for (const stream of live) stream.destroy(); live.clear(); upstream.close(); },
    checkExpiry, close,
  };
}

module.exports = { createLocalGateway, LEASE_MS, OPEN_MS };

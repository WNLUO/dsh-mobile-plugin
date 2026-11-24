// 远程网页的加密上游：共享一条 keep-alive 池复用加密流，WebSocket 单独一条；仅宿主会话存内存。
// 2026-11-23：对外补 prime / isReady，供过渡页在真实页面之前先把首条加密流建好。
// 2026-11-24：注入的提示按本次会话生成，文档不进浏览器缓存；静态资源沿用上游自己的缓存头。
'use strict';

const http = require('node:http');
const { upstreamHeaders, responseHeaders, rememberCookies } = require('./local-headers.cjs');

function createUpstream({ connect, active, live, origin, expiresAt, noticeTransform, onError = () => {} }) {
  const jar = new Map();
  let identity = '';
  let authenticating = null;
  let host = null;    // 当前远端的 port/token；一旦变化就作废旧池重建
  let agent = null;   // 共享 keep-alive 池，底层每条 socket 就是一条加密流
  let pending = null; // 首次连接先建好、待交给池子复用的加密流
  let ensuring = null;

  function resetPool() {
    if (pending) { const stream = pending; pending = null; stream.destroy(); }
    if (agent) { const pool = agent; agent = null; pool.destroy(); }
  }

  async function connection() {
    if (!active()) throw Object.assign(new Error('访问已结束'), { code: 'REMOTE_EXPIRED' });
    const before = expiresAt?.();
    const result = await connect();
    const next = result?.host;
    if (!result?.stream || !Number.isInteger(next?.port) || next.port < 1 || next.port > 65535 || typeof next.token !== 'string' || !next.token) {
      result?.stream?.destroy();
      throw new Error('远程网页握手无效');
    }
    if (!active()) { result.stream.destroy(); throw Object.assign(new Error('访问已结束'), { code: 'REMOTE_EXPIRED' }); }
    // 池子保活/复用时会调这些 net.Socket 方法；加密流没有，补空实现即可照常复用。
    const stream = result.stream;
    if (typeof stream.setKeepAlive !== 'function') stream.setKeepAlive = () => {};
    if (typeof stream.setTimeout !== 'function') stream.setTimeout = () => {};
    if (typeof stream.unref !== 'function') stream.unref = () => {};
    if (typeof stream.ref !== 'function') stream.ref = () => {};
    // 目标变了就不复用旧池，避免把上一台电脑的连接交给新会话。
    if (host && (host.port !== next.port || host.token !== next.token)) resetPool();
    host = next;
    live.add(result.stream);
    result.stream.once('close', () => live.delete(result.stream));
    result.stream.on('error', () => {});
    if (expiresAt && before !== expiresAt() && typeof result.stream.renew === 'function') {
      await result.stream.renew(expiresAt());
      if (!active()) { result.stream.destroy(); throw Object.assign(new Error('访问已结束'), { code: 'REMOTE_EXPIRED' }); }
    }
    return result;
  }

  function ensureAgent() {
    if (agent) return agent;
    const pool = new http.Agent({ keepAlive: true, maxSockets: 6, maxFreeSockets: 2 });
    pool.createConnection = (_options, callback) => {
      if (pending) { const stream = pending; pending = null; callback(null, stream); return; }
      connection().then(({ stream }) => callback(null, stream), callback);
    };
    agent = pool;
    return agent;
  }

  // 首次请求前先建一条连接探出真实 host，并把它留作池里第一条流。
  async function ensureHost() {
    if (host) return host;
    if (!ensuring) {
      ensuring = connection()
        .then((result) => { pending = result.stream; return result.host; })
        .finally(() => { ensuring = null; });
    }
    return ensuring;
  }

  function request(target, options, receive) {
    return http.request({ hostname: '127.0.0.1', port: target.port, ...options, agent: ensureAgent() }, receive);
  }

  // WebSocket 升级要一条独占加密流，不能和普通请求共用 keep-alive 池。
  function dedicated(conn, options, receive) {
    const pool = new http.Agent({ keepAlive: false });
    pool.createConnection = (_options, callback) => { callback(null, conn.stream); return conn.stream; };
    const req = http.request({ hostname: '127.0.0.1', port: conn.host.port, ...options, agent: pool }, receive);
    req.once('close', () => pool.destroy());
    return req;
  }

  async function cookies() {
    const target = await ensureHost();
    const key = `${target.port}:${target.token}`;
    if (identity === key && jar.size) return target;
    if (authenticating) { await authenticating; if (identity === key && jar.size) return target; }
    authenticating = (async () => {
      jar.clear();
      await new Promise((resolve, reject) => {
        // 认证也走共享池，成功后的这条流直接留给后续页面请求复用。
        const req = request(target, {
          method: 'GET', path: `/?token=${encodeURIComponent(target.token)}`,
          headers: { host: `127.0.0.1:${target.port}`, accept: 'text/html' },
        }, (res) => {
          rememberCookies(jar, res.headers['set-cookie']);
          res.resume();
          if (res.statusCode >= 400 || !jar.size) reject(new Error('远程网页认证失败'));
          else { identity = key; resolve(); }
        });
        const timer = setTimeout(() => req.destroy(new Error('远程网页认证超时')), 8000);
        timer.unref?.();
        req.once('close', () => clearTimeout(timer));
        req.once('error', reject);
        req.end();
      });
    })();
    try { await authenticating; } catch (error) {
      // 认证失败往往意味着会话或连接已坏：整池作废，下次请求重新握手。
      resetPool(); host = null; identity = '';
      throw error;
    } finally { authenticating = null; }
    return target;
  }

  async function forward(req, res) {
    let target;
    try {
      target = await cookies();
      if (res.destroyed || !active()) return;
      const outgoing = upstreamHeaders(req.headers, target, jar);
      outgoing['accept-encoding'] = 'identity';
      const up = request(target, {
        method: req.method, path: req.url, headers: outgoing,
      }, (remote) => {
        rememberCookies(jar, remote.headers['set-cookie']);
        if (remote.statusCode === 401) { jar.clear(); identity = ''; }
        const output = responseHeaders(remote.headers, origin(), target);
        const main = req.method === 'GET' && (req.headers['sec-fetch-dest'] === 'document' || (!req.headers['sec-fetch-dest'] && String(req.headers.accept || '').includes('text/html')));
        const html = String(remote.headers['content-type'] || '').toLowerCase().startsWith('text/html');
        const plain = !remote.headers['content-encoding'] || remote.headers['content-encoding'] === 'identity';
        const notice = noticeTransform && main && html && plain ? noticeTransform() : null;
        // 提示脚本带壳标记与会话期限，缓存下来会串到别的窗口；静态资源仍用上游的缓存头。
        if (notice) { delete output['content-length']; delete output.etag; delete output['last-modified']; output['cache-control'] = 'no-store'; }
        output['referrer-policy'] = 'no-referrer';
        output['x-frame-options'] = 'SAMEORIGIN';
        res.writeHead(remote.statusCode, output);
        res.flushHeaders?.();
        remote.on('error', () => res.destroy());
        if (notice) { notice.on('error', () => res.destroy()); remote.pipe(notice).pipe(res); }
        else remote.pipe(res);
      });
      up.once('error', (error) => fail(error));
      req.once('aborted', () => up.destroy());
      res.once('close', () => { if (!res.writableEnded) up.destroy(); });
      req.pipe(up);
    } catch (error) { fail(error); }
    function fail(error) {
      onError(error);
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(error.code === 'REMOTE_EXPIRED' ? 410 : 502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(error.code === 'REMOTE_EXPIRED' ? '本次访问已到期，请在本机面板重新打开。' : '远程连接暂时不可用。');
    }
  }

  async function upgrade(req, socket, head) {
    let conn;
    try {
      const target = await cookies();
      conn = await connection();
      if (socket.destroyed || !active()) { conn.stream.destroy(); return; }
      const up = dedicated(conn, { method: req.method, path: req.url, headers: upstreamHeaders(req.headers, target, jar, true) });
      const drop = () => { socket.destroy(); conn.stream.destroy(); };
      up.once('error', (error) => { onError(error); drop(); });
      up.once('response', (remote) => { remote.resume(); drop(); });
      up.once('upgrade', (remote, stream, upstreamHead) => {
        rememberCookies(jar, remote.headers['set-cookie']);
        const headers = responseHeaders(remote.headers, origin(), target, true);
        const lines = [`HTTP/1.1 ${remote.statusCode} ${remote.statusMessage || 'Switching Protocols'}`];
        for (const [key, value] of Object.entries(headers)) {
          for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`);
        }
        socket.write(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) stream.write(head);
        stream.on('error', drop);
        socket.on('error', drop);
        socket.once('close', () => stream.destroy());
        stream.once('close', () => socket.destroy());
        socket.pipe(stream); stream.pipe(socket);
      });
      socket.once('close', () => up.destroy());
      up.end();
    } catch (error) { onError(error); conn?.stream.destroy(); socket.destroy(); }
  }

  // 是否已建立并认证好上游：过渡页据它决定要不要先出一屏内容。
  function isReady() { return Boolean(host) && Boolean(identity) && identity === `${host.port}:${host.token}`; }

  // 主动把首条加密流建好（认证也一并完成），供过渡页的就绪探测调用；失败原样抛出。
  async function prime() { await cookies(); }

  return { forward, upgrade, prime, isReady, close() { jar.clear(); identity = ''; host = null; resetPool(); } };
}

module.exports = { createUpstream };

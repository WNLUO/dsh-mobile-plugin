// 每次 HTTP 或 WebSocket 连接使用独立加密流，宿主会话只存内存。
'use strict';

const http = require('node:http');
const { upstreamHeaders, responseHeaders, rememberCookies } = require('./local-headers.cjs');

function createUpstream({ connect, active, live, origin, expiresAt, noticeTransform, onError = () => {} }) {
  const jar = new Map();
  let identity = '';
  let authenticating = null;

  async function connection() {
    if (!active()) throw Object.assign(new Error('访问已结束'), { code: 'REMOTE_EXPIRED' });
    const before = expiresAt?.();
    const result = await connect();
    const host = result?.host;
    if (!result?.stream || !Number.isInteger(host?.port) || host.port < 1 || host.port > 65535 || typeof host.token !== 'string' || !host.token) {
      result?.stream?.destroy();
      throw new Error('远程网页握手无效');
    }
    if (!active()) { result.stream.destroy(); throw Object.assign(new Error('访问已结束'), { code: 'REMOTE_EXPIRED' }); }
    live.add(result.stream);
    result.stream.once('close', () => live.delete(result.stream));
    result.stream.on('error', () => {});
    if (expiresAt && before !== expiresAt() && typeof result.stream.renew === 'function') {
      await result.stream.renew(expiresAt());
      if (!active()) { result.stream.destroy(); throw Object.assign(new Error('访问已结束'), { code: 'REMOTE_EXPIRED' }); }
    }
    return result;
  }

  function request({ stream, host }, options, receive) {
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = (_options, callback) => { callback(null, stream); return stream; };
    const req = http.request({ hostname: '127.0.0.1', port: host.port, ...options, agent }, receive);
    req.once('close', () => agent.destroy());
    return req;
  }

  async function cookies(host) {
    const key = `${host.port}:${host.token}`;
    if (identity === key && jar.size) return;
    if (authenticating) { await authenticating; if (identity === key && jar.size) return; }
    authenticating = (async () => {
      jar.clear();
      const upstream = await connection();
      if (upstream.host.port !== host.port || upstream.host.token !== host.token) { upstream.stream.destroy(); throw new Error('远程网页会话已改变'); }
      await new Promise((resolve, reject) => {
        const req = request(upstream, {
          method: 'GET', path: `/?token=${encodeURIComponent(host.token)}`,
          headers: { host: `127.0.0.1:${host.port}`, accept: 'text/html', connection: 'close' },
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
    try { await authenticating; } finally { authenticating = null; }
  }

  async function forward(req, res) {
    let conn;
    let up;
    try {
      conn = await connection();
      await cookies(conn.host);
      if (res.destroyed || !active()) { conn.stream.destroy(); return; }
      const outgoing = upstreamHeaders(req.headers, conn.host, jar);
      outgoing['accept-encoding'] = 'identity';
      up = request(conn, {
        method: req.method, path: req.url, headers: outgoing,
      }, (remote) => {
        rememberCookies(jar, remote.headers['set-cookie']);
        if (remote.statusCode === 401) { jar.clear(); identity = ''; }
        const output = responseHeaders(remote.headers, origin(), conn.host);
        const main = req.method === 'GET' && (req.headers['sec-fetch-dest'] === 'document' || (!req.headers['sec-fetch-dest'] && String(req.headers.accept || '').includes('text/html')));
        const html = String(remote.headers['content-type'] || '').toLowerCase().startsWith('text/html');
        const identity = !remote.headers['content-encoding'] || remote.headers['content-encoding'] === 'identity';
        const notice = noticeTransform && main && html && identity ? noticeTransform() : null;
        if (notice) { delete output['content-length']; delete output.etag; }
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
    } catch (error) { conn?.stream.destroy(); fail(error); }
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
      conn = await connection();
      await cookies(conn.host);
      if (socket.destroyed || !active()) { conn.stream.destroy(); return; }
      const up = request(conn, { method: req.method, path: req.url, headers: upstreamHeaders(req.headers, conn.host, jar, true) });
      const drop = () => { socket.destroy(); conn.stream.destroy(); };
      up.once('error', (error) => { onError(error); drop(); });
      up.once('response', (remote) => { remote.resume(); drop(); });
      up.once('upgrade', (remote, stream, upstreamHead) => {
        rememberCookies(jar, remote.headers['set-cookie']);
        const headers = responseHeaders(remote.headers, origin(), conn.host, true);
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

  return { forward, upgrade, close() { jar.clear(); identity = ''; } };
}

module.exports = { createUpstream };

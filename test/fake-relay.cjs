'use strict';

/**
 * 进程内最简假中转：只做「一个地址能不能用」所必需的那一层。
 *
 * 真实中转是 Rust 写的那一大坨（隧道、分发、镜像、控制台）。多地址这件事要验证的只有三件：
 * 这条地址活没活着、连上去能不能注册上、挂了之后能不能被发现。所以这里只给：
 *
 *   - `GET /healthz` → 200 ok，`GET /api/mobile/v1/health` → 带上 `service: dsh-mobile-relay`
 *     （与 lib/routes/control-plane.js 的 `probe-relays` 同一个判据，宿主能拿它当真中转测）；
 *   - `/tunnel` 的 WSS 握手，收 `register` 回 `registered`，其余帧一律不回（不转发请求）；
 *   - `fail()`：已有隧道立刻被踢、新的健康检查回 503、新的握手直接断 —— 用来模拟「这条挂了」；
 *   - `recover()`：同一条端口重新可用，端口不变（换了端口就不是「同一条地址又活了」）。
 *
 * 形状抄 `test/relay-verify.test.cjs` 里那个假中转：同样用 `lib/relay/protocol.js` 编解码，
 * 同样只认 register / registered 两帧。**不复刻真实中转的协议**，那属于中转仓库的事。
 */

const http = require('node:http');
const { WebSocketServer } = require('ws');

const { T, encodeFrame, createFrameDecoder, parseJson } = require('../lib/relay/protocol.js');

/** 注册回执里带的服务名：与中转自己 `/api/mobile/v1/health` 报的一致。 */
const SERVICE = 'dsh-mobile-relay';

/**
 * 起一条假中转。
 *
 * @param {{port?: number, healthy?: boolean, host?: string, version?: string}} [opts]
 * @returns {Promise<{
 *   url: string, port: number, requests: string[], connections: object[],
 *   healthy: boolean, fail: () => void, recover: () => void, close: () => Promise<void>,
 * }>}
 */
async function startFakeRelay({ port = 0, healthy = true, host = '127.0.0.1', version = '0.0.0-fake' } = {}) {
  let up = healthy;
  const requests = [];
  const connections = [];
  const sockets = new Set();

  const sendJson = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };

  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (!up) return sendJson(res, 503, { ok: false, error: 'relay is down' });
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('ok');
    }
    if (req.url === '/api/mobile/v1/health') {
      return sendJson(res, 200, { ok: true, service: SERVICE, version });
    }
    return sendJson(res, 404, { ok: false });
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    requests.push(`${req.url} upgrade`);
    // 挂了的表现：握手阶段就断，调用方拿到的是「连不上」，而不是「连上了又掉」。
    if (!up || req.url !== '/tunnel') {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    const entry = { registrations: [], closed: false, closeReason: '' };
    connections.push(entry);
    sockets.add(ws);
    const push = createFrameDecoder((frame) => {
      // 心跳：真中转是应用层 ping/pong，长测试里回一句能让隧道别被自己判死。
      if (frame.type === T.ping) {
        ws.send(encodeFrame(T.pong, 0, Buffer.alloc(0)));
        return;
      }
      if (frame.type !== T.register) return;
      entry.registrations.push(parseJson(frame.payload));
      if (!up) {
        ws.close(1008, 'relay down');
        return;
      }
      ws.send(encodeFrame(T.registered, 0, Buffer.alloc(0)));
    });
    ws.on('message', (data) => push(Buffer.isBuffer(data) ? data : Buffer.from(data)));
    ws.on('close', (code, reason) => {
      entry.closed = true;
      entry.closeReason = String(reason || '');
      sockets.delete(ws);
    });
    ws.on('error', () => { sockets.delete(ws); });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;

  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    requests,
    connections,
    get healthy() { return up; },
    /** 模拟这条中转挂了：在连的隧道全断，新的健康检查 503、新的握手被拒。 */
    fail() {
      up = false;
      for (const ws of sockets) {
        try { ws.close(1012, 'relay down'); } catch { /* 已经断了 */ }
      }
    },
    /** 同一条地址重新可用（端口不变）。 */
    recover() { up = true; },
    async close() {
      for (const ws of sockets) {
        try { ws.terminate(); } catch { /* 已经断了 */ }
      }
      sockets.clear();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startFakeRelay, SERVICE };

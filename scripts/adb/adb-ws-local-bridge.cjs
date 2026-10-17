#!/usr/bin/env node
/**
 * adb WebSocket 桥（本机侧）：把 adb 的 TCP 连接包进 WebSocket，
 * 经 wss://<后端域名>/adb/<令牌>/ 送到服务器上的桥，再转发给那台机器
 * 的 adb server。监听本机端口后，adb 用 -H/-P 指过来即可。
 *
 * 用法：
 *   ADB_WS_URL=wss://<后端域名>/adb/<令牌>/ \
 *   ADB_LOCAL_PORT=15037 node adb-ws-local-bridge.cjs
 *
 * 为什么不直接用 SSH 端口转发：SSH 隧道要求本机常驻一个 ssh 进程，断线重连、
 * 换网都要人管；走后端域名的 443 端口则与 App 连的是同一套入口，行为一致。
 */
'use strict';

const net = require('net');
const { WebSocket } = require('ws');

const WS_URL = process.env.ADB_WS_URL;
const LOCAL_PORT = Number(process.env.ADB_LOCAL_PORT || 15037);
const LOCAL_HOST = process.env.ADB_LOCAL_HOST || '127.0.0.1';

if (!WS_URL) {
  console.error('缺少 ADB_WS_URL，例如 wss://<后端域名>/adb/<令牌>/');
  process.exit(1);
}

function log(...args) {
  console.log(new Date().toISOString(), '[adb-ws-local]', ...args);
}

// adb server 用固定长度的小包头做协议分发，如果把一次 TCP 读当成一个
// WebSocket 帧发出去，粘包/拆包会让 adb 解析出乱序的响应。这里不做任何
// 重新分帧——WebSocket 的 message 边界由两端各自的写入决定，服务端桥是
// 逐个 TCP chunk 转发，本机侧再逐帧写回 socket，边界天然对齐。
const server = net.createServer((socket) => {
  log('本地 adb 连接接入', socket.remoteAddress || '(unix)');
  const ws = new WebSocket(WS_URL, { perMessageDeflate: false });
  let ready = false;
  // WebSocket 握手是异步的，而 adb 在 TCP 连上的瞬间就把版本查询发出去了。
  // 早先这里直接丢弃握手期收到的字节，理由是「adb 会重试」——**它不会**：
  // 握手只发一次，丢掉就再也等不到服务端回应，表现为
  // `adb: failed to check server version: protocol fault (couldn't read status)`。
  // 所以必须排队，连上后按序补发。
  const pending = [];

  ws.on('open', () => {
    ready = true;
    log('WebSocket 已连上，通道就绪');
    if (pending.length) {
      log(`补发握手期缓存的 ${pending.length} 段数据`);
      for (const chunk of pending) ws.send(chunk, { binary: true });
      pending.length = 0;
    }
  });

  ws.on('message', (data) => {
    if (!socket.destroyed) socket.write(data);
  });

  socket.on('data', (chunk) => {
    if (ready && ws.readyState === WebSocket.OPEN) {
      ws.send(chunk, { binary: true });
    } else {
      pending.push(chunk);
    }
  });

  const teardown = (reason) => {
    log('通道关闭:', reason);
    if (!socket.destroyed) socket.destroy();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try { ws.close(); } catch { /* 已断开 */ }
    }
  };

  ws.on('error', (err) => { log('WebSocket 错误:', err.message); teardown('ws-error'); });
  ws.on('close', () => teardown('ws-close'));
  socket.on('error', () => teardown('socket-error'));
  socket.on('close', () => teardown('socket-close'));
});

server.listen(LOCAL_PORT, LOCAL_HOST, () => {
  log(`监听 tcp://${LOCAL_HOST}:${LOCAL_PORT} → ${WS_URL.replace(/\/[^/]*\/$/, '/<token>/')}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); });
}

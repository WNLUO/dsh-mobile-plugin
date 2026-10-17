#!/usr/bin/env node
/**
 * adb WebSocket 桥（服务器侧）。
 *
 * 为什么需要它：模拟器所在的主机上，adb server 只监听 127.0.0.1:5037。
 * 从外面用 `adb connect` 连不到，SSH 端口转发能用但要求本机一直挂着 ssh 进程。
 * 这里把 adb server 那一段 TCP 流原样包进 WebSocket，再由 nginx 以
 * `/adb/` 路径经 443 端口反代出去——这样从任意机器只要能访问后端域名，
 * 配合一个本地 ws→tcp 桥就能直接驱动模拟器，不需要 SSH 会话。
 *
 * 安全边界：只监听 127.0.0.1，公网侧只能经 nginx 进来；公网入口必须带不可猜的
 * 路径令牌（见 README「App 端到端测试」）。adb 协议等价于完整的设备控制权
 * （可装卸应用、读文件、执行 shell），不要把它当成公开接口暴露。
 *
 * 用法（systemd 环境下由 unit 注入环境变量）：
 *   ADB_WS_PORT=18790 ADB_TARGET_HOST=127.0.0.1 ADB_TARGET_PORT=5037 node adb-ws-bridge.cjs
 */
'use strict';

const http = require('http');
const net = require('net');
const path = require('path');
// `ws` 取插件自己那份依赖：这个脚本已经搬进插件仓库，不再依赖中转的 node_modules。
// 环境变量仍可覆盖，给「把脚本单独拷到服务器上跑」的场景留口子。
const { WebSocketServer } = require(path.join(
  process.env.ADB_WS_MODULE_DIR || path.resolve(__dirname, '..', '..', 'node_modules'), 'ws'));

const PORT = Number(process.env.ADB_WS_PORT || 18790);
const TARGET_HOST = process.env.ADB_TARGET_HOST || '127.0.0.1';
const TARGET_PORT = Number(process.env.ADB_TARGET_PORT || 5037);
const HOST = process.env.ADB_WS_HOST || '127.0.0.1';

function log(...args) {
  console.log(new Date().toISOString(), '[adb-ws-bridge]', ...args);
}

const server = http.createServer((req, res) => {
  // 只做存活探针用：GET 返回一行说明，不参与隧道。
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('adb-ws-bridge ok; websocket upgrade required\n');
});

// 不在这里按 path 过滤：桥只监听 127.0.0.1，公网进不来，访问控制统一由
// nginx 的 location 路径令牌负责（令牌不出现在本进程配置里，便于单独轮换）。
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const peer = req.socket.remoteAddress;
  log('连接建立', peer, '→ 转发到', `${TARGET_HOST}:${TARGET_PORT}`);

  const upstream = net.connect({ host: TARGET_HOST, port: TARGET_PORT });
  // adb 协议是长连接流，握手可能稍慢；给足超时避免 nginx 先断。
  upstream.setTimeout(0);
  upstream.setNoDelay(true);

  let closed = false;
  function teardown(reason) {
    if (closed) return;
    closed = true;
    log('连接关闭', reason);
    try { upstream.destroy(); } catch { /* 已断开 */ }
    try { ws.close(); } catch { /* 已断开 */ }
  }

  upstream.on('connect', () => {
    log('上游 adb server 已连上', `${TARGET_HOST}:${TARGET_PORT}`);
  });

  upstream.on('data', (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
  });

  upstream.on('error', (err) => {
    log('上游错误:', err.message);
    teardown('upstream-error');
  });

  upstream.on('close', () => teardown('upstream-close'));

  ws.on('message', (data, isBinary) => {
    if (upstream.destroyed) return;
    upstream.write(isBinary ? data : Buffer.from(data));
  });

  ws.on('error', (err) => {
    log('WebSocket 错误:', err.message);
    teardown('ws-error');
  });

  ws.on('close', () => teardown('ws-close'));
});

server.listen(PORT, HOST, () => {
  log(`监听 http://${HOST}:${PORT}/adb （上游 ${TARGET_HOST}:${TARGET_PORT}）`);
});

// 退出前不留下半开的连接，避免 systemd 反复重启时端口被占。
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`收到 ${sig}，退出`);
    for (const client of wss.clients) {
      try { client.terminate(); } catch { /* 忽略 */ }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

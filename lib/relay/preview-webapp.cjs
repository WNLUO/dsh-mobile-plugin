// 解析网页版管道中的每次 HTTP/WS 请求，覆盖可信转发标记并保留流式背压。
'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { createWebSocketStream } = require('ws');
const { withViaHeader } = require('../shared/via-header');

const OUTPUT_DRAIN_TIMEOUT_MS = 5000;

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function openWebappPipe(ws, { port, scheme, hosts, servername, onClose = () => {} }) {
  const stream = createWebSocketStream(ws);
  const sockets = new Set();
  const requests = new Set();
  const secure = scheme === 'https';
  const transport = secure ? https : http;
  const agent = new transport.Agent({ keepAlive: false });
  let closed = false;
  let ending = false;
  let drainTimer = null;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(drainTimer);
    for (const request of requests) request.destroy();
    for (const socket of sockets) socket.destroy();
    agent.destroy();
    stream.destroy();
    onClose();
  };
  const endStream = stream.end.bind(stream);
  stream.end = (...args) => {
    if (!ending && !closed) {
      ending = true;
      drainTimer = setTimeout(close, OUTPUT_DRAIN_TIMEOUT_MS);
      drainTimer.unref?.();
    }
    return endStream(...args);
  };
  const finishOutput = () => {
    if (closed || stream.writableEnded) return;
    // Duplex的final会等各次ws.send回调后发Close，正常EOF不销毁尚未排空的输出。
    stream.end();
  };
  stream.on('error', close);
  stream.on('close', close);
  ws.on('close', close);
  ws.on('error', close);

  // 环回目标沿用普通预览的双栈拨号顺序，只在尚未连接时换下一个地址。
  const connect = (callback) => {
    let index = 0;
    const next = (lastError) => {
      if (closed) return callback(new Error('预览管道已关闭'));
      if (index >= hosts.length) return callback(lastError || new Error('网页版上游不可达'));
      const host = hosts[index++];
      const socket = secure
        ? tls.connect({ host, port, servername, rejectUnauthorized: false })
        : net.connect({ host, port });
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      const timer = setTimeout(() => socket.destroy(new Error('网页版上游连接超时')), 10_000);
      timer.unref?.();
      socket.once('close', () => clearTimeout(timer));
      const failed = (error) => { clearTimeout(timer); socket.destroy(); next(error); };
      socket.once('error', failed);
      socket.once(secure ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        socket.off('error', failed);
        if (closed) { socket.destroy(); return; }
        callback(null, socket);
      });
    };
    next();
  };
  agent.createConnection = (_options, callback) => { connect(callback); };
  const headersFor = (req, upgrade = false) => {
    const headers = withViaHeader(
      Object.fromEntries(Object.entries(req.headers).filter(([name]) => upgrade || !HOP_BY_HOP.has(name))),
      'preview-webapp', `localhost:${port}`,
    );
    // Node已经拆掉入站chunk边界，GET/HEAD也必须重新分帧，不能把正文裸写成第二请求。
    if (!upgrade && req.headers['content-length'] === undefined && req.headers['transfer-encoding']) {
      headers['transfer-encoding'] = 'chunked';
    }
    return headers;
  };
  const optionsFor = (req, upgrade = false) => ({
    host: 'localhost', port, method: req.method, path: req.url, headers: headersFor(req, upgrade), agent,
  });
  const trackRequest = (request) => {
    requests.add(request);
    request.once('close', () => requests.delete(request));
    return request;
  };
  const server = http.createServer({ requestTimeout: 0, headersTimeout: 0, keepAliveTimeout: 0 }, (req, res) => {
    const upstream = trackRequest(transport.request(optionsFor(req), (reply) => {
      res.writeHead(reply.statusCode || 502, Object.fromEntries(Object.entries(reply.headers).filter(([name]) => !HOP_BY_HOP.has(name))));
      res.flushHeaders();
      reply.on('error', close);
      reply.pipe(res);
    }));
    upstream.on('error', () => {
      if (closed) return;
      if (res.headersSent) { close(); return; }
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
      res.once('finish', finishOutput);
      res.end('网页版上游不可达');
    });
    req.on('aborted', () => upstream.destroy());
    req.on('error', close);
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  });
  server.on('clientError', close);
  server.on('upgrade', (req, socket, head) => {
    const upstream = trackRequest(transport.request(optionsFor(req, true)));
    upstream.on('error', close);
    upstream.on('response', (reply) => {
      socket.write(`HTTP/1.1 ${reply.statusCode || 502} ${reply.statusMessage || 'Bad Gateway'}\r\nconnection: close\r\n\r\n`);
      reply.pipe(socket);
    });
    upstream.on('upgrade', (reply, target, upstreamHead) => {
      sockets.add(target);
      target.once('end', finishOutput);
      target.once('close', (hadError) => {
        sockets.delete(target);
        if (hadError || !target.readableEnded) close();
        else finishOutput();
      });
      target.on('error', close);
      if (closed) { target.destroy(); return; }
      const lines = [`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}`];
      for (let i = 0; i + 1 < reply.rawHeaders.length; i += 2) lines.push(`${reply.rawHeaders[i]}: ${reply.rawHeaders[i + 1]}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    upstream.end();
  });
  server.emit('connection', stream);
  return { close };
}

module.exports = { openWebappPipe, OUTPUT_DRAIN_TIMEOUT_MS };

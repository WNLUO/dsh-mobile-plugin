'use strict';

/**
 * 隧道数据的落脚代理：隧道里进来的请求先到这里，打上转发标记，再转给宿主 web 端口。
 *
 * 为什么不能让隧道直接连 web 端口：直连隧道（tailcat）与点对点隧道（p2p）在局域网关闭时，
 * 原本把连接原样透传到 `ctx.webServer.port` —— 一条裸 TCP 连接，请求上不带任何「我是被
 * 转发进来的」记认。而控制面（`localOnly`）的判据只落在转发标记与 Host 上、不校验来源
 * IP，于是一台已配对的手机经隧道打 `/api/relay/revoke-all`、`/api/relay/config`、
 * `/api/relay/update/apply`，会被当成「本机设置页」照单执行。
 *
 * 这里做的是与局域网代理（`lan-proxy.js`）同一件事里最小的那一份：转发前删掉客户端自带
 * 的 `x-dsh-via`、写入自己的值（`shared/via-header.js` 的 `withViaHeader`），控制面见到
 * 它就按远程处理。移动 API 那条路一条都不受影响 —— 它只认 token，不看转发标记。
 *
 * 只绑 127.0.0.1：连进来的只有本进程内的隧道助手，不对外多开一个口。鉴权与配对不在这里
 * 做（隧道助手有白名单、移动 API 有 token），这条路的职责只有「打标记 + 转发」。
 *
 * 升级请求（内置浏览器预览 `/api/mobile/v1/preview`、手机控制）必须原样穿过去：那是隧道
 * 上真实会走的流量，握手头要连 `connection` / `upgrade` 一起带给上游，所以升级这条自己
 * 拼请求行，不套 HTTP 转发那份逐跳头过滤。
 */

const http = require('node:http');
const net = require('node:net');
const { VIA_HEADER, VIA_TUNNEL, withViaHeader } = require('../shared/via-header');

const UPSTREAM_HOST = '127.0.0.1';

// 与局域网代理同一份逐跳头名单：两条路转给同一个上游，头的处理口径必须一致。
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
]);

/**
 * @param {object} options
 * @param {() => number} options.upstreamPort 宿主 web 端口（每次请求现读，允许变化）
 * @param {(message: string) => void} [options.log]
 */
function createTunnelForwarder(options) {
  const upstreamPort = options.upstreamPort;
  const log = options.log || (() => {});
  let server = null;
  let port = 0;
  let starting = null;
  const live = new Set();

  const upstreamOf = () => `${UPSTREAM_HOST}:${Number(upstreamPort())}`;

  /** 转发用的头：与局域网代理同源，客户端自带的同名标记会被覆盖掉。 */
  function forwardedHeaders(incoming) {
    return withViaHeader(
      Object.fromEntries(Object.entries(incoming).filter(([key, value]) => !HOP_BY_HOP.has(key) && value !== undefined)),
      VIA_TUNNEL,
      upstreamOf(),
    );
  }

  function forwardRequest(req, res) {
    const up = http.request(
      { hostname: UPSTREAM_HOST, port: Number(upstreamPort()), method: req.method, path: req.url, headers: forwardedHeaders(req.headers) },
      (ures) => {
        const out = {};
        for (const [key, value] of Object.entries(ures.headers)) {
          // `content-length` 不是逐跳头，照原样转出去：丢了它每一发响应都退化成 chunked，
          // 手机侧判断「这份文件收完了没有」就没了依据（与局域网代理同一条理由）。
          if (!HOP_BY_HOP.has(key) || key === 'content-length') out[key] = value;
        }
        res.writeHead(ures.statusCode, out);
        // 流的第一段（响应头）立刻走：等工作攒满一个段会把「流建好了」拖到十几秒之后。
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        ures.pipe(res);
      },
    );
    up.on('error', (error) => {
      log('隧道转发失败：', error.message);
      try {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`upstream error: ${error.message}`);
      } catch { /* 手机侧已经断开 */ }
    });
    // 手机走了就把上游这条请求一起拆掉，否则宿主那边的流订阅永远等不到收尾。
    res.on('close', () => {
      if (res.writableEnded) return;
      try { up.destroy(); } catch { /* 已经断开 */ }
    });
    if (req.method === 'GET' || req.method === 'HEAD') up.end();
    else req.pipe(up);
  }

  /**
   * 升级请求的原始头：按 `rawHeaders` 逐条搬，只换掉 `host` 与 `x-dsh-via`。
   *
   * 不能走 `forwardedHeaders`：那份要滤掉 `connection` / `upgrade`，而握手恰恰靠这两条。
   */
  function upgradeHead(req) {
    const replace = new Set(['host', VIA_HEADER]);
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let at = 0; at + 1 < req.rawHeaders.length; at += 2) {
      if (replace.has(String(req.rawHeaders[at]).toLowerCase())) continue;
      lines.push(`${req.rawHeaders[at]}: ${req.rawHeaders[at + 1]}`);
    }
    lines.push(`Host: ${upstreamOf()}`);
    lines.push(`${VIA_HEADER}: ${VIA_TUNNEL}`);
    // 头是按字节传的，Node 的 rawHeaders 就是 latin1 解出来的，按同一个编码写回。
    return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
  }

  function forwardUpgrade(req, socket, head) {
    const upstream = net.connect({ host: UPSTREAM_HOST, port: Number(upstreamPort()) });
    live.add(socket);
    live.add(upstream);
    const drop = () => {
      live.delete(socket);
      live.delete(upstream);
      socket.destroy();
      upstream.destroy();
    };
    socket.on('error', drop);
    upstream.on('error', drop);
    socket.on('close', drop);
    upstream.on('close', drop);
    upstream.on('connect', () => {
      upstream.write(upgradeHead(req));
      if (head && head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
  }

  return {
    /**
     * 把回环端口开起来，拿到端口之后才算成；失败回 0。
     *
     * 异步与成对取值器都是必须的：`listen(0)` 之后 `address()` 要等 `listening` 才有值，
     * 同步读回来恒是 null —— 隧道那边于是拿到端口 0，整条通道静默不可用。
     */
    start() {
      if (starting) return starting;
      server = http.createServer(forwardRequest);
      server.on('upgrade', forwardUpgrade);
      server.on('error', (error) => {
        log(`隧道落点代理没有开起来：${error && error.message ? error.message : error}`);
      });
      starting = new Promise((resolve) => {
        try {
          server.listen(0, UPSTREAM_HOST, () => {
            // 这条监听不该把进程钉住：它只是个转发口，真正撑住宿主的是别的东西。
            server.unref?.();
            const address = server.address();
            port = address && typeof address === 'object' ? address.port : 0;
            resolve(port);
          });
        } catch (error) {
          log(`隧道落点代理监听失败：${error && error.message ? error.message : error}`);
          resolve(0);
        }
      });
      return starting;
    },
    port: () => port,
    close() {
      for (const socket of live) socket.destroy();
      live.clear();
      if (server) {
        try {
          server.close();
        } catch { /* 已经关了 */ }
      }
      server = null;
      port = 0;
      starting = null;
    },
  };
}

module.exports = { createTunnelForwarder };

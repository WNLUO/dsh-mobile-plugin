'use strict';

/**
 * 预览字节管道（宿主侧）。
 *
 * 手机 App 的内置浏览器要能看到桌面机上「开发中的网页」，而那些 dev server 只监听
 * 宿主机的 127.0.0.1:<port>。手机、中转、局域网代理都够不着它，所以链路上必须有一
 * 段跑在宿主进程里的搬运工——就是这里。
 *
 * 为什么是**字节管道**而不是又一个 HTTP 代理：
 * 一个页面不是「一次请求」而是「几百次请求」——ES 模块、CSS、图片、XHR、还有 HMR
 * 那条活着的 WebSocket。浏览器引擎自己发这些请求，App 侧的 JS 拦不住。所以端口只在
 * 建立管道时协商一次，之后这管道对内容一无所知，只搬字节。
 *
 * 这么做的收益是结构性的：内置浏览器地址栏里是 `http://localhost:3001/`，宿主机上
 * 的 dev server 看到的 Host 也是 `localhost:3001`——两边对「我在哪」的认知完全一致。
 * 于是 dev server 生成的一切绝对地址（资源路径、接口地址、跳转 Location、HMR 连接
 * 地址）都自动闭环，**dev server 零配置**。反过来说，如果这里做半吊子的路径改写，
 * `/assets/app.js` 这类绝对路径立刻全 404。
 *
 * 这一层刻意「不认识」HTTP 与 WebSocket：
 *
 *   - 手机侧的原生模块把 WebView 写下的原始字节塞进 WebSocket 的二进制帧；
 *   - 这里 `net.connect(<环回地址>, port)` 之后双向对搬。环回地址要**双栈**试：macOS 上
 *     不少 dev server（Vite 等）默认只监听 `::1`，只拨 `127.0.0.1` 会连不上；
 *   - 中间任何一层都不解析、不改写，所以 WS 升级、SSE、分块传输、自定义子协议全都
 *     原样穿过（HMR 不用砍也不用绕——浏览器和 Vite 自己完成握手与分帧）。
 *
 * 代价要说清楚：正因为宿主无法审查内容，**端口就是这里唯一的边界**，所以下面有
 * `protectedPorts()` 那道按身份的拒绝（DSH 自身的 web 端口永远不许从预览进来）。
 *
 * 与仓库里 `dsh-mobile-server/scripts/adb-ws-bridge.cjs` 是同一个套路（原始 TCP 流包进 WebSocket 帧），
 * 那个先例证明这条路在本项目里走得通。
 */

const net = require('node:net');
const { WebSocketServer } = require('ws');

/**
 * 同一个宿主上同时在跑的预览连接上限。
 *
 * 浏览器对单个源本就有 6 条左右的并发连接限制（HTTP 与 WebSocket 各算），所以一个
 * 正常页面根本到不了这个数；这个上限只是防止某个页面失控时把宿主的 fd 吃光。
 */
const MAX_PREVIEW_STREAMS = 32;

/** 单条 WS 消息上限，与中转侧 MAX_WS_MESSAGE_BYTES / MAX_FRAME_BYTES 对齐。 */
const MAX_PREVIEW_MESSAGE_BYTES = 8 * 1024 * 1024;

/** 往手机方向的水位：缓冲超了就把 dev server 那头按住，落下来再放开。 */
const SEND_HIGH_WATER_BYTES = 4 * 1024 * 1024;
const SEND_LOW_WATER_BYTES = 1 * 1024 * 1024;
const SEND_RESUME_POLL_MS = 20;

/** 连上游的一发超时：只覆盖「还没握上」这一段；握上之后是长连接，不能有读超时。 */
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;

/**
 * WS 握手已成、但上游 `net.connect` 还没连上的那几百微秒里，手机已经发出来的字节
 * 最多攒这么多。浏览器不会等我们连好上游才发请求，所以这段字节必须存住；攒过头说明
 * 上游根本连不上，这时宁可断掉这条管道，也不能无限吃内存。
 */
const MAX_PREVIEW_PENDING_BYTES = 1024 * 1024;

/**
 * 从升级请求的查询串里取 port。
 *
 * 中转的升级分发（`server.js` 的 `server.on('upgrade')`）不看路径，只做鉴权后把
 * `req.url` 原样交给隧道；宿主的 webServer 又只按 pathname 匹配升级路由、忽略查询串
 * ——所以端口只能这么带，也只能这么读。
 *
 * @returns {number|null} 合法端口，或 null（缺参数、非数字、越界都算非法）
 */
function parsePreviewPort(req) {
  let params;
  try {
    params = new URL(req && req.url ? req.url : '/', 'http://preview.invalid').searchParams;
  } catch {
    return null;
  }
  const raw = params.get('port');
  if (raw === null || !/^[0-9]{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

const HTML_HEAD = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>预览未建立</title><style>'
  + 'body{margin:0;padding:28px 20px;font:15px/1.7 -apple-system,"PingFang SC","Noto Sans CJK SC",sans-serif;'
  + 'background:#14161a;color:#e6e8ec}'
  + 'h1{margin:0 0 10px;font-size:17px;font-weight:600}'
  + 'p{margin:0 0 10px;color:#a9b0bb}'
  + 'code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#f0b849}'
  + '</style></head><body>';

/**
 * 失败页。由**宿主**生成再借这条字节管道发给内置浏览器——手机原生模块只是个哑管道，
 * 它没有能力编出人话；而原因只有宿主知道（端口没人监听？被拒？）。
 */
function renderFailureHtml({ title, detail, port }) {
  return `${HTML_HEAD}<h1>${title}</h1><p>${detail}</p>`
    + `<p>端口：<code>${port}</code></p>`
    + '</body></html>';
}

/** 升级**之前**的拒绝：握手还没成，所以按普通 HTTP 应答，对方的 WS 客户端会看到状态码。 */
function refuseUpgrade(socket, status, reason, text) {
  if (!socket || socket.destroyed) return;
  const body = Buffer.from(renderFailureHtml({ title: text, detail: '', port: '' }), 'utf8');
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n`
    + 'Content-Type: text/html; charset=utf-8\r\n'
    + `Content-Length: ${body.length}\r\n`
    + 'Connection: close\r\n\r\n',
  );
  socket.end(body);
}

/**
 * @param {object} deps
 * @param {(req: object) => boolean} deps.authorized 移动端鉴权（lib/mobile/auth.js 的 authorized）
 * @param {() => Set<number>} deps.protectedPorts DSH 自身占用的端口，永远不许从预览进来
 * @param {(message: string) => void} [deps.onLog]
 */
function createPreviewService({ authorized, protectedPorts, onLog }) {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_PREVIEW_MESSAGE_BYTES,
  });

  /**
   * 走过这道门的端口。这张表是「预览到底碰过什么」的唯一记录，内存态、随宿主重启清空
   * ——端口本身不是长期授权，是一次使用留下的痕迹，用于手机端展示与排查。
   */
  const grants = new Map();
  let activeStreams = 0;
  let closed = false;

  const log = (message) => { try { onLog?.(message); } catch { /* 日志失败不该影响搬运 */ } };

  function noteGrant(port) {
    const now = Date.now();
    const grant = grants.get(port);
    if (grant) {
      grant.streams += 1;
      grant.lastUsedAt = now;
    } else {
      grants.set(port, { port, firstUsedAt: now, lastUsedAt: now, streams: 1 });
    }
  }

  /**
   * 一条管道：完成 WebSocket 握手，然后把它与 `127.0.0.1:<port>` 对搬。
   */
  function openPipe(ws, port) {
    activeStreams += 1;
    noteGrant(port);

    let upstream = null;
    let finished = false;
    let resumeTimer = null;
    let upstreamReady = false;
    let pendingBytes = 0;
    /** 上游还没连上时手机先发过来的字节，见 MAX_PREVIEW_PENDING_BYTES。 */
    const pending = [];

    const finish = () => {
      if (finished) return;
      finished = true;
      activeStreams -= 1;
      if (resumeTimer) { clearInterval(resumeTimer); resumeTimer = null; }
      pending.length = 0;
      pendingBytes = 0;
      try { ws.close(); } catch { /* 可能已经关了 */ }
      if (upstream && !upstream.destroyed) upstream.destroy();
    };

    /** 手机 → dev server；`write` 返回 false 表示内核缓冲满了，此时按住 WS 的读端。 */
    const writeToUpstream = (chunk) => {
      if (finished || !upstream || upstream.destroyed) return;
      if (!upstream.write(chunk)) ws.pause();
    };

    /** 发往手机方向的水位控制：`ws` 没有 drain 事件，只能轮询 bufferedAmount。 */
    const startResumePoll = () => {
      if (resumeTimer || finished) return;
      resumeTimer = setInterval(() => {
        if (finished || ws.readyState !== ws.OPEN) {
          clearInterval(resumeTimer); resumeTimer = null; return;
        }
        if (ws.bufferedAmount <= SEND_LOW_WATER_BYTES) {
          clearInterval(resumeTimer); resumeTimer = null;
          if (upstream && !upstream.destroyed) upstream.resume();
        }
      }, SEND_RESUME_POLL_MS);
      if (typeof resumeTimer.unref === 'function') resumeTimer.unref();
    };

    // 这两个监听必须**立刻**挂上，不能等 `upstream.on('connect')`：手机在 WS 握手一
    // 完成就会把 HTTP 请求字节发出来，而上游 TCP 往往还在路上。挂晚了这几百微秒内的
    // 字节会被直接丢掉——表现就是「页面时好时坏、偶尔整页空白」，且只在真机上偶发。
    ws.on('message', (data) => {
      if (finished) return;
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (chunk.length === 0) return;
      if (upstreamReady) { writeToUpstream(chunk); return; }
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes > MAX_PREVIEW_PENDING_BYTES) finish();
    });
    ws.on('close', finish);
    ws.on('error', finish);

    // 上游必须**双栈**拨号：macOS 上 Vite 之类的 dev server 默认只监听 `::1`，只连
    // `127.0.0.1` 必然是 ECONNREFUSED，用户看到的就是「电脑上这个端口没有服务」。
    // 两个地址都是环回，谁在听就用谁；只有在前一个「还没连上就失败」时才换下一个。
    const upstreamHosts = ['127.0.0.1', '::1'];
    let hostIndex = 0;
    let connectTimer = null;
    let lastError = 'ECONNREFUSED';

    const clearConnectTimer = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    };

    /** 两个环回地址都连不上：握手已经成了，没法再用 HTTP 状态码，只能借管道送失败页。 */
    const failUpstream = () => {
      log(`preview port ${port}: ${lastError}`);
      // 这条管道本来就是透明的，索性由宿主写一段 502 响应借它送进内置浏览器——比让
      // WebView 显示系统错误页清楚得多。
      if (ws.readyState === ws.OPEN) {
        const body = Buffer.from(renderFailureHtml({
          title: '电脑上这个端口没有服务',
          detail: lastError === 'ECONNREFUSED'
            ? '开发服务可能已经停了。回到 DSH 重新启动它，再刷新这个页面。'
            : `宿主连不上 127.0.0.1:${port}，也连不上 [::1]:${port}（${lastError}）。`,
          port,
        }), 'utf8');
        const head = Buffer.from(
          'HTTP/1.1 502 Bad Gateway\r\n'
          + 'Content-Type: text/html; charset=utf-8\r\n'
          + `Content-Length: ${body.length}\r\n`
          + 'Connection: close\r\n\r\n',
          'utf8',
        );
        try { ws.send(Buffer.concat([head, body]), { binary: true }); } catch { /* 已经断了 */ }
      }
      finish();
    };

    /** 换下一个环回地址；都试过了就按失败收场。 */
    const advanceHost = () => {
      if (finished) return;
      hostIndex += 1;
      if (hostIndex < upstreamHosts.length) { dialUpstream(); return; }
      failUpstream();
    };

    function dialUpstream() {
      const host = upstreamHosts[hostIndex];
      const socketToUpstream = net.connect({ host, port });
      upstream = socketToUpstream;

      // 握上手之前给一发超时；连上之后这条 TCP 就是长连接（SSE、HMR 都从它过），
      // 不能再有任何读超时。
      connectTimer = setTimeout(() => {
        connectTimer = null;
        if (finished || upstreamReady || socketToUpstream !== upstream) return;
        lastError = 'ETIMEDOUT';
        log(`preview port ${port}: ${host} 连接超时`);
        try { socketToUpstream.destroy(); } catch { /* 可能已经断了 */ }
        advanceHost();
      }, UPSTREAM_CONNECT_TIMEOUT_MS);
      if (typeof connectTimer.unref === 'function') connectTimer.unref();

      socketToUpstream.on('error', (error) => {
        if (finished || socketToUpstream !== upstream) return;
        lastError = (error && error.code) || (error && error.message) || 'unknown';
        clearConnectTimer();
        if (!upstreamReady) {
          log(`preview port ${port}: ${host} 连不上（${lastError}）`);
          advanceHost();
          return;
        }
        failUpstream();
      });

      socketToUpstream.on('connect', () => {
        clearConnectTimer();
        log(`preview port ${port}: 管道已接通（${host}）`);
        upstreamReady = true;

        socketToUpstream.on('drain', () => { if (!finished && ws.readyState === ws.OPEN) ws.resume(); });

        // dev server → 手机。
        socketToUpstream.on('data', (chunk) => {
          if (finished || ws.readyState !== ws.OPEN) return;
          if (ws.bufferedAmount > SEND_HIGH_WATER_BYTES) {
            socketToUpstream.pause();
            startResumePoll();
          }
          ws.send(chunk, { binary: true });
        });

        socketToUpstream.on('close', finish);

        // 冲掉「连上之前」攒下的字节（顺序不变）。
        for (const chunk of pending) {
          if (finished) break;
          writeToUpstream(chunk);
        }
        pending.length = 0;
        pendingBytes = 0;
      });
    }

    dialUpstream();
  }

  /**
   * 宿主 webServer 的升级处理器（`ctx.webServer.registerUpgrade`）。
   *
   * 拒绝一定要发生在 `handleUpgrade` **之前**：那时 socket 还是一条普通 HTTP 连接，
   * 可以老实回 401/403；一旦完成握手，就只能靠管道里塞失败页了。
   */
  function handleUpgrade(req, socket, head) {
    if (closed) return refuseUpgrade(socket, 503, 'Service Unavailable', '预览管道已关闭');

    const port = parsePreviewPort(req);
    if (port === null) return refuseUpgrade(socket, 400, 'Bad Request', '缺少或非法的 port 参数');

    let allowed = false;
    try { allowed = Boolean(authorized(req)); } catch { allowed = false; }
    if (!allowed) return refuseUpgrade(socket, 401, 'Unauthorized', '移动端凭据无效');

    // DSH 自身的端口按**身份**拒绝，不是按数字拉黑。3080 是宿主 web 服务的实际端口
    // （`ctx.webServer.port`，可能被配置改过），从预览进来等于把桌面端 GUI/API 搬到了
    // 手机内置浏览器里——那条路刻意不做，所以在这里用同一个真值掐掉。
    if (protectedPorts().has(port)) {
      return refuseUpgrade(socket, 403, 'Forbidden', `端口 ${port} 属于 DSH 自身，不允许预览`);
    }

    if (activeStreams >= MAX_PREVIEW_STREAMS) {
      return refuseUpgrade(socket, 503, 'Service Unavailable', '预览连接数已达上限');
    }

    wss.handleUpgrade(req, socket, head, (ws) => openPipe(ws, port));
  }

  return {
    handleUpgrade,
    /** 「预览碰过哪些端口」的快照，供状态接口展示。 */
    grants: () => [...grants.values()].sort((a, b) => a.port - b.port).map((grant) => ({ ...grant })),
    stats: () => ({ activeStreams, maxStreams: MAX_PREVIEW_STREAMS }),
    close: () => {
      closed = true;
      for (const client of wss.clients) {
        try { client.terminate(); } catch { /* 已经断了 */ }
      }
      wss.close();
    },
  };
}

module.exports = {
  MAX_PREVIEW_STREAMS,
  MAX_PREVIEW_MESSAGE_BYTES,
  createPreviewService,
  parsePreviewPort,
  renderFailureHtml,
};
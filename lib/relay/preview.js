'use strict';

/**
 * 预览字节管道（宿主侧）。
 *
 * 手机 App 的内置浏览器要看到桌面机上「开发中的网页」，而那些 dev server 只在某一块网卡的
 * 某个端口上，手机、中转、局域网代理都够不着。所以链路上有一段跑在宿主进程里的搬运工。
 *
 * 是字节管道而不是 HTTP 代理：一个页面是几百次请求加一条活着的 HMR WebSocket，目标在建立
 * 管道时协商一次，之后完全不解析内容。于是内置浏览器的地址栏与实际 Host 都是
 * `localhost:3001`，dev server 生成的绝对地址自动闭环、零配置；做路径改写反而会立刻全 404。
 *
 * 目标（`host` / `scheme` / `port`）由手机从查询串带过来，解析与拨号都发生在电脑这一侧：
 * 手机永远只跟自己的 localhost 说明文，证书、ATS、明文限制那套就彻底与它无关了。https 的
 * TLS 也在这里发起——目标是本机或私网，自签证书是本地开发的常态。
 *
 * 环回目标要双栈试（macOS 上不少 dev server 只监听 `::1`）；别的目标只拨那一个。
 * WS 升级、SSE、分块传输原样穿过。
 *
 * 代价：宿主无法审查内容，边界只有「端口」与「目标主机」两道。前者由 `protectedPorts()` 按
 * 身份拒绝——DSH 自身的 web 端口永远不许从预览进来；后者由 `isAllowedPreviewHost` 收到本机、
 * 私网与保留域名——放开公网，这条管道就等于一台任意目标的连接中转，移动 API 的能力面就扩了。
 */

const net = require('node:net');
const tls = require('node:tls');
const { WebSocketServer } = require('ws');
const { ipv4Number, ipv6Number } = require('./lan-network.cjs');

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
 * WS 握手已成、但上游还没连上的那几百微秒里，手机已经发出来的字节
 * 最多攒这么多。浏览器不会等我们连好上游才发请求，所以这段字节必须存住；攒过头说明
 * 上游根本连不上，这时宁可断掉这条管道，也不能无限吃内存。
 */
const MAX_PREVIEW_PENDING_BYTES = 1024 * 1024;

/**
 * 从升级请求的查询串里取 port。
 *
 * 中转的升级分发（Rust relay 的 upgrade 入口）不看路径，只做鉴权后把
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

/** 环回类主机：这些写法都指「电脑自己」，拨号要走双栈（见 `previewDialTargets`）。 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '::']);

/**
 * 能从预览拨过去的 IPv4 段。
 *
 * 比 `lan-network.cjs` 的「局域网候选」多两段：100.64/10（运营商级 NAT，VPN 与容器网段常用）
 * 与 169.254/16（链路本地）——它们不该当直连候选，但都是开发服务真的会绑上去的地址。
 */
const ALLOWED_IPV4_RANGES = [
  [0x0a000000, 0x0affffff], // 10/8
  [0xac100000, 0xac1fffff], // 172.16/12
  [0xc0a80000, 0xc0a8ffff], // 192.168/16
  [0x64400000, 0x647fffff], // 100.64/10
  [0xa9fe0000, 0xa9feffff], // 169.254/16
  [0x7f000000, 0x7fffffff], // 127/8 回环
];

/**
 * 只有内网 DNS / mDNS 才解析得了的保留后缀。
 *
 * `.test`、`.localhost` 是 RFC 留给本机测试的，`.local` 是 mDNS，`.internal` / `.lan` /
 * `.home.arpa` 是各家路由器与公司内网的惯例。公网域名一律不放，哪怕它此刻解析到私网地址
 * ——解析结果随时会变，白名单必须是静态可判的。
 */
const RESERVED_HOST_SUFFIXES = ['.localhost', '.test', '.local', '.internal', '.lan', '.home.arpa'];

/**
 * 这个主机能不能从预览拨过去（能力边界，和 App 侧「哪条地址该进内置浏览器」是同一条线）。
 *
 * @param {string} host 已经归一化（小写、无方括号）的主机
 */
function isAllowedPreviewHost(host) {
  if (LOOPBACK_HOSTS.has(host)) return true;
  const v4 = ipv4Number(host);
  if (v4 !== null) return ALLOWED_IPV4_RANGES.some(([start, end]) => v4 >= start && v4 <= end);
  const v6 = ipv6Number(host);
  if (v6 !== null) {
    // fc00::/7 是唯一本地地址（内网自己编的前缀），fe80::/10 只在本链路内通。
    return v6 >> 121n === 0x7en || v6 >> 118n === 0x3fan;
  }
  return RESERVED_HOST_SUFFIXES.some((suffix) => host.length > suffix.length && host.endsWith(suffix));
}

/**
 * 依次要拨的地址。
 *
 * 环回一律**双栈**：macOS 上 Vite 之类的 dev server 默认只监听 `::1`，只连 `127.0.0.1`
 * 必然是 ECONNREFUSED，用户看到的就是「电脑上这个端口没有服务」。两个地址都是电脑自己，
 * 谁在听就用谁。别的目标只拨它自己那一个——换地址重试就是把「连不上」变成「连上了另一台
 * 机器」，那比失败更糟。
 *
 * @returns {string[]} 有顺序的拨号目标，前一个「还没连上就失败」才换下一个
 */
function previewDialTargets(host) {
  return LOOPBACK_HOSTS.has(host) ? ['127.0.0.1', '::1'] : [host];
}

/**
 * 从升级请求的查询串里取 host 与 scheme。
 *
 * 和 `port` 一样只能靠查询串带（中转的升级分发不看路径，宿主的升级匹配又按 pathname 精确、
 * 忽略 query）。缺省是「电脑自己的环回 + 明文」，也就是内置浏览器最常见的那个形状。
 *
 * @returns {{host: string, scheme: 'http'|'https'}|null} host 为空、scheme 认不出都算非法
 */
function parsePreviewTarget(req) {
  let params;
  try {
    params = new URL(req && req.url ? req.url : '/', 'http://preview.invalid').searchParams;
  } catch {
    return null;
  }
  const rawHost = params.get('host');
  // 地址栏那种方括号写法（`[::1]`）会原样带过来，剥掉再判：留着它既不是环回、也拼不出地址。
  const host = (rawHost === null ? 'localhost' : rawHost.trim().toLowerCase()).replace(/^\[|\]$/g, '');
  if (host === '') return null;
  const rawScheme = params.get('scheme');
  const scheme = rawScheme === null || rawScheme === '' ? 'http' : rawScheme.trim().toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return null;
  return { host, scheme };
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
   * 一条管道：完成 WebSocket 握手，然后把它与目标对搬。
   *
   * @param {{port: number, scheme: 'http'|'https', hosts: string[], servername?: string}} target 拨号计划
   */
  function openPipe(ws, { port, scheme, hosts, servername }) {
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

    // 拨号计划在进门时就定好了（见 `previewDialTargets`）：环回两个地址依次试，别的只拨一个。
    let hostIndex = 0;
    let connectTimer = null;
    let lastError = 'ECONNREFUSED';

    /** 失败页与日志里怎么写「拨的是哪儿」：IPv6 带方括号，https 连协议一起写。 */
    const describeTarget = (host) => {
      const address = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
      return scheme === 'https' ? `https://${address}` : address;
    };

    const clearConnectTimer = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    };

    /** 计划里的地址都连不上：握手已经成了，没法再用 HTTP 状态码，只能借管道送失败页。 */
    const failUpstream = () => {
      log(`preview port ${port}: ${lastError}`);
      // 这条管道本来就是透明的，索性由宿主写一段 502 响应借它送进内置浏览器——比让
      // WebView 显示系统错误页清楚得多。目标要照实写：用户得知道电脑去连的是哪儿。
      if (ws.readyState === ws.OPEN) {
        const unreachable = hosts.map(describeTarget).join('，也连不上 ');
        const body = Buffer.from(renderFailureHtml({
          title: '电脑上这个端口没有服务',
          detail: lastError === 'ECONNREFUSED'
            ? `宿主连不上 ${unreachable}：开发服务可能已经停了。回到 DSH 重新启动它，再刷新这个页面。`
            : `宿主连不上 ${unreachable}（${lastError}）。`,
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

    /** 换计划里的下一个地址；都试过了就按失败收场。 */
    const advanceHost = () => {
      if (finished) return;
      hostIndex += 1;
      if (hostIndex < hosts.length) { dialUpstream(); return; }
      failUpstream();
    };

    function dialUpstream() {
      const host = hosts[hostIndex];
      // https 的 TLS 在这里发起，手机那侧始终只看到自己环回上的明文。`rejectUnauthorized`
      // 必须关掉：目标是本机或私网，自签证书是本地开发的常态。SNI 用手机点名的那个主机
      // （见 `servername`）——浏览器访问 `localhost:5173` 发的就是 `localhost`，哪怕实际
      // 拨过去的是 127.0.0.1。
      const socketToUpstream = scheme === 'https'
        ? tls.connect({ host, port, rejectUnauthorized: false, servername })
        : net.connect({ host, port });
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

      // TLS 的「连上了」以握手完成为准：`connect` 在 TLSSocket 上只代表 TCP 通了。
      socketToUpstream.on(scheme === 'https' ? 'secureConnect' : 'connect', () => {
        clearConnectTimer();
        log(`preview port ${port}: 管道已接通（${describeTarget(host)}）`);
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

    const target = parsePreviewTarget(req);
    if (target === null) return refuseUpgrade(socket, 400, 'Bad Request', '非法的 host 或 scheme 参数');

    let allowed = false;
    try { allowed = Boolean(authorized(req)); } catch { allowed = false; }
    if (!allowed) return refuseUpgrade(socket, 401, 'Unauthorized', '移动端凭据无效');

    // 目标白名单与端口同一个道理：这条管道只负责把手机的一条连接接到电脑这一侧，能拨到
    // 哪儿就是它能做成什么。公网目标在这里掐掉（见文件头与 `isAllowedPreviewHost`）。
    if (!isAllowedPreviewHost(target.host)) {
      return refuseUpgrade(socket, 403, 'Forbidden',
        `目标 ${target.host} 不在预览允许的范围内（只允许本机、私网与保留域名）`);
    }

    // DSH 自身的端口按**身份**拒绝，不是按数字拉黑。3080 是宿主 web 服务的实际端口
    // （`ctx.webServer.port`，可能被配置改过），从预览进来等于把桌面端 GUI/API 搬到了
    // 手机内置浏览器里——那条路刻意不做，所以在这里用同一个真值掐掉。
    if (protectedPorts().has(port)) {
      return refuseUpgrade(socket, 403, 'Forbidden', `端口 ${port} 属于 DSH 自身，不允许预览`);
    }

    if (activeStreams >= MAX_PREVIEW_STREAMS) {
      return refuseUpgrade(socket, 503, 'Service Unavailable', '预览连接数已达上限');
    }

    wss.handleUpgrade(req, socket, head, (ws) => openPipe(ws, {
      port,
      scheme: target.scheme,
      hosts: previewDialTargets(target.host),
      // IP 字面量不给 SNI：Node 直接把 IP 当 servername 判成非法参数，环回双栈掉落出来的
      // 地址也一样——所以这里取的是手机点名的那个主机。
      servername: net.isIP(target.host) ? undefined : target.host,
    }));
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
  isAllowedPreviewHost,
  parsePreviewPort,
  previewDialTargets,
  renderFailureHtml,
};
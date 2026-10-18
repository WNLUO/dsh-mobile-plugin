'use strict';

/**
 * 局域网直连代理：手机在同一个 Wi-Fi 下直接访问
 * http://<电脑IP>:<lanPort>，带上配对拿到的令牌后代理到本机 dsh web。
 *
 * 只服务 App：未认证的请求一律 JSON 401，不给任何网页。曾经的 HTML 配对页
 * 与配对后能进入的网页本体已删除（见 docs/decisions.md 2026-10-19）。
 *
 * 与中转隧道的关系：同网用本代理（零延迟、不依赖公网），
 * 异地走 dsh-mobile-server 中转。两者互不影响，可同时开启。
 */

const http = require('node:http');
const { WebSocketServer, WebSocket } = require('ws');
const core = require('./core.js');
const { safeEqual } = require('../shared/dshtoken');
const { isFreshRequest } = require('../shared/fresh-request');
const credentials = require('../shared/credentials-entry.js').credentialsEntry();

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
]);

const PAIR_MAX_FAILS = 5;
const PAIR_LOCK_MS = 60_000;
// 上游 WS 握手的一发超时：连上之后这条连接就是长连接（HMR、SSE 都从它过），
// 所以只在「还没握上」这段时间里计时。
const WS_UPSTREAM_HANDSHAKE_MS = 10_000;
// 上游已经握上、手机的握手还没完成的这一瞬间，上游先推过来的字节最多攒这么多。
// 它兜的是一个**停不下来的源头**（页面在自增、在循环 push，而手机那头永远不来握手），
// 不是「一轮推送有多大」：预览页面一次推几 MB 很正常，按 1MiB 判超限只会把正常的页面
// 判成 502。
const WS_UPSTREAM_PENDING_MAX_BYTES = 32 * 1024 * 1024;
// 局域网直连允许同时活着的上游 SSE 条数。它兜的是**半开连接**：手机走了但 TCP 还没
// 被拆掉（飞机模式、睡死、拔线都不会发 FIN），只有这种情况才需要一道闸。
// 与中转路的同名上限（tunnel.js 的 16）刻意不是一个量级：那边所有设备共用一条隧道，
// 设备多就得挤；这边每台设备各有自己的 TCP，实测 3 台设备正常十来条。所以这里留出
// 成倍余量，只当失控闸——正常使用不该碰到它。
const MAX_UPSTREAM_SSE_CONNECTIONS = 64;

function createLanProxy(opts) {
  const {
    lanPort,
    pairingCode,
    instanceId,
    lanSecret,
    upstreamPort,
    upstreamHost = '127.0.0.1',
    onLog = () => {},
    /**
     * 桌面用户授权回调：async (device) => ({ approved, token? })。
     * 默认**拒绝**。旧实现默认 `{ approved: true }`，任何忘了传 onApprove 的调用方
     * 都会退化成「知道 6 位配对码即可直连」的 fail-open——授权判断必须显式给出。
     */
    onApprove = async () => ({ approved: false }),
    /** 读取隔离：本地镜像快照读取回调，命中时直接回（不再连主进程）。 */
    readSnapshot = () => null,
    /** 上游 SSE 的失控闸，默认见 MAX_UPSTREAM_SSE_CONNECTIONS。 */
    maxUpstreamSse = MAX_UPSTREAM_SSE_CONNECTIONS,
  } = opts;

  let server = null;
  let wss = null;
  // 活着的上游请求计数（自检台账与失控闸消费）：见 proxyToUpstream 的拆除注释。
  let upstreamOpen = 0;
  let upstreamSseOpen = 0;
  // 实际监听的端口。首选端口被占时（见 lib/relay/port-allocator.cjs）会退到内核
  // 分配的空闲端口，这时对外必须报 `actualPort` 而不是 `lanPort`，否则状态接口和
  // 配对二维码里带的都是那个根本没在监听的死端口。
  let actualPort = lanPort;
  // 配对失败限流：ip -> { fails, lockedUntil }（与 relay 侧策略一致：5 次失败锁 60s）
  const pairLocks = new Map();

  function log(...args) {
    onLog('[lan-proxy]', ...args);
  }

  function isPairLocked(ip) {
    const l = pairLocks.get(ip);
    return !!l && l.lockedUntil > Date.now();
  }
  function recordPairFail(ip) {
    const l = pairLocks.get(ip) || { fails: 0, lockedUntil: 0 };
    l.fails += 1;
    if (l.fails >= PAIR_MAX_FAILS) {
      l.lockedUntil = Date.now() + PAIR_LOCK_MS;
      l.fails = 0;
    }
    pairLocks.set(ip, l);
  }
  function clearPairFails(ip) {
    pairLocks.delete(ip);
  }

  /**
   * 请求出示的设备凭据（`dshc_…`），取不到返回 null。
   *
   * App 把设备凭据放在独立的 `X-Dsh-Device-Credential` 头里，`Authorization`
   * 留给宿主 token（`app/src/services/authHeaders.ts`）。旧实现只从
   * `Authorization` 里找 `dshc_`，于是本函数对真实 App 流量恒为 null，
   * 「吊销能作用于局域网直连」从未落地。`Authorization` 分支仅用于兼容早期
   * 客户端，保留但不作为主路径。
   */
  function presentedCredential(req) {
    const raw = req.headers['x-dsh-device-credential'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (typeof header === 'string' && header.startsWith('dshc_')) return header;
    const m = /^Bearer\s+([^\s]+)$/.exec(req.headers.authorization || '');
    return m && m[1].startsWith('dshc_') ? m[1] : null;
  }
  /** 当前仍然有效的本机设备凭据；用于把该设备对应的宿主 token 转发给上游。 */
  function credential(req) {
    const presented = presentedCredential(req);
    return presented ? credentials.find(presented, instanceId) : null;
  }
  /**
   * 无状态凭据校验：dsh_lan cookie 或 `Authorization: Bearer <token>`。两者同源
   * 同格式，均为 lanSecret 签名的 HMAC token；RN 在部分平台会丢弃手动 Cookie
   * 头，故 Bearer 兜底。
   */
  function cookieValid(req) {
    const m = /dsh_lan=([^;]+)/.exec(req.headers.cookie || '');
    return m ? core.verifyLanToken(lanSecret, m[1], instanceId) : false;
  }
  function bearerValid(req) {
    const m = /^Bearer\s+([^\s]+)$/.exec(req.headers.authorization || '');
    return !!m && core.verifyLanToken(lanSecret, m[1], instanceId);
  }
  /**
   * 鉴权。
   *
   * 顺序是这里唯一的要点：出示了**本机签发过**的设备凭据时以它为准，一旦被吊销
   * 或过期就直接拒绝，不再回退到无状态 token —— HMAC token 有效期一年，允许回退
   * 就等于吊销永远不生效。
   *
   * 但「本机不认识这张凭据」必须回退：公网配对时凭据由中转签发并存在中转的凭据
   * 库里（`dsh-mobile-server/lib/tunnel-handler.js`），宿主这里查不到。若一律拒绝，
   * 「公网配对后回到局域网直连」这个主要用法会直接 401。
   */
  function authorized(req) {
    const presented = presentedCredential(req);
    if (presented) {
      const known = credentials.lookup(presented, instanceId);
      if (known) return credentials.isLive(known);
    }
    return cookieValid(req) || bearerValid(req);
  }
  /**
   * 配对失败的统一响应。
   *
   * 旧实现把「配对码错误」答成 401、把「配对码正确但桌面端拒绝」答成 403，
   * 于是 `deny` 策略下任何人都能拿状态码逐位试探出真实配对码。两种情况现在
   * 返回完全相同的状态码与响应体，配对码不再可被探测。
   */
  function pairDenied(res) {
    try {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '配对码错误或桌面端已拒绝' }));
    } catch { /* 客户端已断开 */ }
  }

  function setCookie(res) {
    res.setHeader(
      'set-cookie',
      `dsh_lan=${core.signLanToken(lanSecret, instanceId, core.MOBILE_TOKEN_TTL_SEC)}`
      + `; Path=/; HttpOnly; SameSite=Lax; Max-Age=${core.MOBILE_TOKEN_TTL_SEC}`,
    );
  }
  /**
   * 未认证的请求一律回 JSON 401，与移动 API 的鉴权失败保持同一种形状 ——
   * App 据此显示可读的「缺少或无效的移动 token」，而不是「请求失败 (HTTP 200)」。
   *
   * 浏览器导航也走这条路：这里**不再**提供网页版的配对页与配对后进入的网页本体，
   * 手机端只有 App 一条路。给网页回 200 HTML 曾是刻意行为，但 App 的
   * `app/src/api.ts` 会把 `response.ok` 当成功、把连接通道钉在局域网并重置熔断，
   * 随后 `res.json()` 解析失败，桌面端换过 lanSecret 或凭据被吊销之后就永久卡住 ——
   * 一个「谁都能打开的页面」换来的这点便利不值这条风险。
   */
  function sendUnauthorized(res) {
    try {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: '缺少或无效的移动 token' } }));
    } catch { /* 客户端已断开 */ }
  }

  function proxyToUpstream(req, res) {
    // 读取隔离：命中本地镜像快照时直接回，不再连主进程。
    // 例外：带 ?fresh=1 的写后刷新必须回源——镜像最多旧 500ms，撞上写操作会把刚做完的
    // 事显示成没生效（判定与实测见 lib/shared/fresh-request.js）。
    const body = isFreshRequest(req.url) ? null : readSnapshot({ method: req.method, path: req.url });
    if (body && body.ok) {
      try {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
      } catch { /* 已关闭 */ }
      return;
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k)) headers[k] = v;
    }
    // 保留手机端原始 Host（信任围栏按 Host 判定，配合桌面壳 --trusted-host 本机 IP）；缺省回退本地上游
    if (!headers.host) headers.host = `${upstreamHost}:${upstreamPort}`;
    const isSse = String(req.headers.accept || '').toLowerCase().includes('text/event-stream');
    if (isSse && upstreamSseOpen >= maxUpstreamSse) {
      // 留一行日志：否则事后只看到手机端「连不上」，看不出是被这道闸挡的。
      log(`上游 SSE 已达上限 ${maxUpstreamSse}，拒绝新流（手机侧会重连）`);
      try {
        res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '2' });
        res.end('局域网直连的上游长流已达上限，请稍后重连\n');
      } catch { /* 已关闭 */ }
      return;
    }
    upstreamOpen += 1;
    if (isSse) upstreamSseOpen += 1;
    const up = http.request(
      { hostname: upstreamHost, port: upstreamPort, method: req.method, path: req.url, headers },
      (ures) => {
        const out = {};
        for (const [k, v] of Object.entries(ures.headers)) {
          if (!HOP_BY_HOP.has(k)) out[k] = v;
        }
        res.writeHead(ures.statusCode, out);
        ures.pipe(res);
      },
    );
    // 计数只在这里退：ClientRequest 的 close 一定会来（正常收尾、报错、被 destroy 都算）。
    up.on('close', () => {
      upstreamOpen -= 1;
      if (isSse) upstreamSseOpen -= 1;
    });
    up.on('error', (err) => {
      log('proxy error:', err.message);
      try {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`upstream error: ${err.message}`);
      } catch { /* 已关闭 */ }
    });
    /**
     * 手机走了，必须把上游这条请求一起拆掉。
     *
     * 旧实现只挂了 `error`：手机断开之后上游请求还活着，宿主那边的响应就永远等不到
     * `close`，于是 events 流与每条会话流的订阅**永不退订**——宿主继续往一条没人读的
     * 连接上生成帧与正文。2026-10-19 实测：一台机器 12 条手机连接攒出 216 条上游长流，
     * 宿主进程涨到 3.5～5G、CPU 30～40%，重启后回到 530M。同一个插件的中转路径有
     * `httpCancel` 帧负责拆（tunnel.js），只有局域网这条路漏了。
     *
     * `res.writableEnded` 是判据：正常活完的响应结束时就已置位，不该再去动上游；
     * 只有「客户端提前走」才会落到 false。
     */
    res.on('close', () => {
      if (res.writableEnded) return;
      try { up.destroy() } catch { /* 已断开 */ }
    });
    req.pipe(up);
  }

  /** 升级还没被 ws 接管时的普通 HTTP 应答（对方看到的是握手失败与状态码）。 */
  function refuseSocket(socket, status, message) {
    const safe = String(message).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const body = Buffer.from(
      `<!doctype html><meta charset="utf-8"><title>预览未建立</title><p>${safe}</p>`,
      'utf8',
    );
    try {
      socket.write(
        `HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Error'}\r\n`
        + 'Content-Type: text/html; charset=utf-8\r\n'
        + `Content-Length: ${body.length}\r\n`
        + 'Connection: close\r\n\r\n',
      );
      socket.end(body);
    } catch { /* 对端可能已经走了 */ }
  }

  /**
   * 局域网里的 WebSocket 升级。
   *
   * 两条与 HTTP 路径（proxyToUpstream）必须一致的规则，缺一条内置浏览器就打不开：
   *
   *   1. **转发头**：丢掉逐跳头、补 host，并按本机为该设备保存的凭据补上宿主 token。
   *      什么都不带地连上游，宿主的预览管道会判定「没有移动端凭据」直接回 401。
   *   2. **先连上游、连上再对手机回 101**。手机侧的原生管道只在「握手根本没成」时才换
   *      下一条候选地址（见 app/android/app/src/main/java/com/dsh/mobile/PreviewModule.kt
   *      的 Pipe.connect）；一旦回了 101，它就把这条连接当成可用，之后再断只会关掉整个
   *      内置浏览器，永远不回退到中转那条路。上游拒绝时状态码必须原样回给手机。
   *   3. **上游先推过来的字节要么还给手机，要么跟着这条连接一起放掉**。上游连上之后、
   *      手机收到 101 之前，上游推来的东西只能暂存在 `pending` 里；凡是这条连接已经
   *      废掉（手机走了、上游断了、攒不下）的地方都必须清空它。少一次，这份缓冲就
   *      永久留在闭包里，几小时后宿主整进程 OOM。
   */
  function handleUpgrade(req, socket, head) {
    if (!authorized(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(key) && value !== undefined) headers[key] = value;
    }
    if (!headers.host) headers.host = `${upstreamHost}:${upstreamPort}`;
    const device = credential(req);
    if (device?.hostToken) headers.authorization = `Bearer ${device.hostToken}`;

    let up;
    try {
      up = new WebSocket(`ws://${upstreamHost}:${upstreamPort}${req.url}`, {
        headers,
        handshakeTimeout: WS_UPSTREAM_HANDSHAKE_MS,
      });
    } catch (err) {
      refuseSocket(socket, 502, `无法连接上游：${err.message}`);
      return;
    }

    /** 是否已经给手机回过响应（成功或失败），保证只回一次。 */
    let settled = false;
    let phoneWs = null;
    let upstreamReady = false;
    let pendingBytes = 0;
    /** 上游已连上、手机握手还没完成时先到达的字节。 */
    const pending = [];

    const dropUpstream = () => { try { up.terminate(); } catch { /* 可能还没连上 */ } };

    /**
     * 丢暂存：这条路已经废了（手机走了、上游断了、攒不下）。
     *
     * 少这一次释放，每失败一次预览就永久留一份这份缓冲——手机那头不来握手的窗口里它
     * 能涨到上限。凡是「这段窗口结束且不再交出去」的地方都必须走这里。
     */
    const dropPending = () => {
      pending.length = 0;
      pendingBytes = 0;
    };

    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      log(`ws 升级未建立：${status} ${message}`);
      dropPending();
      dropUpstream();
      refuseSocket(socket, status, message);
    };

    // 手机在等上游的时候先走了：别白连上游。这两个监听还兼着兜底 socket 错误——
    // 这段窗口里 socket 是我们在拿着，没有人接 'error' 会冒泡成未捕获异常。
    const abandon = () => {
      if (settled) return;
      settled = true;
      dropPending();
      dropUpstream();
    };
    socket.on('error', abandon);
    socket.on('close', abandon);

    up.on('unexpected-response', (_req, res) => {
      const status = res.statusCode || 502;
      try { res.resume(); } catch { /* 读掉就走 */ }
      fail(status, `上游拒绝了这次升级（${status}）`);
    });

    up.on('message', (data) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (phoneWs) {
        if (phoneWs.readyState === WebSocket.OPEN) phoneWs.send(chunk);
        return;
      }
      pendingBytes += chunk.length;
      if (pendingBytes > WS_UPSTREAM_PENDING_MAX_BYTES) {
        fail(502, '上游数据积压超过上限');
        return;
      }
      pending.push(chunk);
    });

    up.on('open', () => {
      upstreamReady = true;
      if (settled) return;
      // 暂停并**同步**把握手交给 `ws` 办：它是先读掉握手响应、再在 socket 上回调，上游
      // 紧跟着推的第一帧此刻已经在缓冲里。中间插一次 await 或 setTimeout，`message` 就
      // 可能先于握手回调到达，那一帧落进暂存分支之后再没人发出去。预览页面刚加载正是
      // 这种推送节奏。
      up.pause();
      wss.handleUpgrade(req, socket, head, (ws) => {
        settled = true;
        phoneWs = ws;
        try {
          // 先补发暂存、再放行上游：暂停期间挂监听不会丢，恢复才一次性派发。
          for (const chunk of pending) {
            if (ws.readyState !== WebSocket.OPEN) break;
            ws.send(chunk);
          }
          dropPending();
          up.resume();
        } catch { /* 已断开 */ }
        ws.on('message', (data) => {
          if (up.readyState === WebSocket.OPEN) up.send(data);
        });
        ws.on('close', () => { try { up.close(); } catch { /* ignore */ } });
        ws.on('error', () => { try { up.terminate(); } catch { /* ignore */ } });
        up.on('close', () => { try { ws.close(); } catch { /* ignore */ } });
      });
    });

    up.on('error', (err) => {
      const code = (err && err.code) || (err && err.message) || 'unknown';
      if (!upstreamReady) {
        const status = /timeout/i.test(String(code)) ? 504 : 502;
        fail(status, `连不上上游 ${upstreamHost}:${upstreamPort}（${code}）`);
        return;
      }
      log(`ws 上游中断：${code}`);
      // 上游已经出局，暂存再没有去处。
      dropPending();
      if (phoneWs && phoneWs.readyState === WebSocket.OPEN) {
        try { phoneWs.close(1011, 'upstream error'); } catch { /* ignore */ }
      }
    });
  }

  function start() {
    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://lan.local');
        try {
          if (url.pathname === '/__lan_pair' && req.method === 'POST') {
            const ip = req.socket.remoteAddress || '';
            let b = '';
            req.on('data', (c) => (b += c));
            req.on('end', () => {
              try {
                let code = '';
                try { code = (JSON.parse(b || '{}').code || '').trim(); } catch { /* ignore */ }
                // 长度不符直接判错（timingSafeEqual 长度不同会抛异常，曾导致整个 dsh web 崩溃）
                if (!/^\d{6}$/.test(code)) {
                  res.writeHead(400, { 'content-type': 'application/json' });
                  res.end(JSON.stringify({ ok: false, error: '配对码需为 6 位数字' }));
                  return;
                }
                if (isPairLocked(ip)) {
                  res.writeHead(429, { 'content-type': 'application/json' });
                  res.end(JSON.stringify({ error: '尝试过于频繁，请稍后再试' }));
                  return;
                }
                if (!safeEqual(code, String(pairingCode))) {
                  recordPairFail(ip);
                  pairDenied(res);
                  return;
                }
                // 配对码正确 → 桌面端授权（TeamViewer 模型）。保留旧版
                // 仅传 code 的请求，同时透传手机端完整设备元数据。
                // 注意：这里**不**清限流计数——被拒绝的尝试同样要计数，否则
                // 猜对配对码但被拒的一方可以无限次重试。
                const input = JSON.parse(b || '{}')
                const suppliedDevice = input && typeof input.device === 'object' && input.device !== null
                  ? input.device
                  : {
                    name: input?.name,
                    platform: input?.platform,
                    osVersion: input?.osVersion,
                    version: input?.version,
                    appVersion: input?.appVersion,
                    id: input?.id,
                    deviceId: input?.deviceId,
                  }
                const device = {
                  ...Object.fromEntries(Object.entries(suppliedDevice).filter(([, value]) => value !== undefined)),
                  ip: suppliedDevice.ip || ip,
                }
                onApprove(device)
                  .then(({ approved, token, platform }) => {
                    if (!approved) {
                      // 与「配对码错误」返回同一响应，配对码不再可通过状态码探测。
                      pairDenied(res);
                      return;
                    }
                    clearPairFails(ip);
                    const issued = credentials.issue(instanceId, device, token);
                    const cookieValue = core.signLanToken(lanSecret, instanceId, core.MOBILE_TOKEN_TTL_SEC);
                    setCookie(res);
                    res.writeHead(200, { 'content-type': 'application/json' });
                    // cookie 同时放进 body：RN fetch 读不到 Set-Cookie 响应头，App 需自行携带
                    res.end(JSON.stringify({
                      ok: true,
                      instanceId,
                      token: token || '',
                      cookie: `dsh_lan=${cookieValue}`,
                      deviceId: issued.deviceId,
                      deviceCredential: issued.credential,
                      credentialExpiresAt: issued.expiresAt,
                      // 宿主自己的系统标识，不是手机的。手机把它存进设备记录，
                      // 好让设备行在第一次 status 轮询之前就画得出图标。
                      ...(platform ? { hostPlatform: platform } : {}),
                    }));
                  })
                  .catch((err) => {
                    log('approve error:', err.message);
                    try {
                      res.writeHead(500, { 'content-type': 'application/json' });
                      res.end(JSON.stringify({ error: 'internal error' }));
                    } catch { /* ignore */ }
                  });
              } catch (err) {
                log('pair error:', err.message);
                try {
                  res.writeHead(500, { 'content-type': 'application/json' });
                  res.end(JSON.stringify({ error: 'internal error' }));
                } catch { /* ignore */ }
              }
            });
            return;
          }
          if (url.pathname === '/healthz') {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('ok');
            return;
          }
          // 地址体检要和 /healthz 一样在鉴权之前放行：手机在配对之前就要问「这个地址上
          // 是宿主还是中转」，那时候它没有任何 token（上游那一条也没有 guarded）。
          // 它只回服务名与版本，不是能力面。
          if (url.pathname === '/api/mobile/v1/health') {
            proxyToUpstream(req, res);
            return;
          }
          if (!authorized(req)) {
            sendUnauthorized(res);
            return;
          }
          const c = credential(req);
           if (c?.hostToken) req.headers.authorization = `Bearer ${c.hostToken}`;
           proxyToUpstream(req, res);
        } catch (err) {
          log('request error:', err.message);
          try {
            res.writeHead(500);
            res.end('internal error');
          } catch { /* ignore */ }
        }
      });

      wss = new WebSocketServer({ noServer: true });
      server.on('upgrade', handleUpgrade);

      // Node 的一个坑：一次 listen 失败之后再对同一个 server 调用 listen，**前一次**
      // listen 注册的 listening 回调也会跟着跑一遍。所以每次 bind 都用 settled 守卫，
      // 谁先谁后无所谓，每次尝试最多只认一次成功——否则一次端口回退会被当成两次成功
      // 绑定，状态上报和日志都跟着说谎。
      const bind = (port) => new Promise((onBound, onFailed) => {
        let settled = false
        const onError = (err) => {
          if (settled) return
          settled = true
          server.off('error', onError)
          onFailed(err)
        }
        const onListening = () => {
          if (settled) return
          settled = true
          server.off('error', onError)
          server.on('error', (err) => log('server error:', err.message))
          const address = server.address()
          actualPort = address && typeof address.port === 'number' ? address.port : port
          log(`listening on 0.0.0.0:${actualPort}`)
          onBound()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, '0.0.0.0')
      })

      // 端口自适应：首选端口在探测之后、真正 listen 之前被别的进程抢走时（另一个
      // 实例刚起、或者上一轮 stop() 还没释放干净），退到内核分配的空闲端口，而不是
      // 让一次 EADDRINUSE 把整条 LAN 直连带走。
      // 成功路径必须在这里就 resolve：只挂 .catch 的话，bind(lanPort) 成功时
      // catch 分支根本不会执行，外层那个 Promise 就永远 pending——服务器确实在监听，
      // 但调用方拿到的 start() 永不落定，lan.state 永远停在 connecting、error 还是
      // null。端口回退是兜底，不是主路径。
      bind(lanPort).then(() => resolve(), async (error) => {
        if (!error || error.code !== 'EADDRINUSE') return reject(error);
        log(`port ${lanPort} busy (${error.code}), falling back to an OS-assigned port`);
        try { await bind(0); resolve() } catch (retryError) { reject(retryError) }
      });
    });
  }

  function stop() {
    if (wss) {
      // 旧实现只 close()：已经建立的手机 WebSocket 会继续占着 lanPort，
      // 配置变更重启时 listen 直接 EADDRINUSE，于是「局域网开关」失效。
      for (const client of wss.clients) {
        try { client.terminate(); } catch { /* ignore */ }
      }
      try { wss.close(); } catch { /* ignore */ }
      wss = null;
    }
    if (server) {
      try { server.close(); } catch { /* ignore */ }
      // 还在飞的 keep-alive 连接会让端口迟迟不释放，直接断掉。
      try { server.closeAllConnections?.(); } catch { /* ignore */ }
      server = null;
    }
  }

  // 对外只暴露「实际在监听的端口」。配置端口仍是 `lanPort`（那只是首选值）。
  const port = () => actualPort;

  return {
    start,
    stop,
    port,
    /**
     * 自检用：此刻活着的上游请求数，以及其中 SSE 的条数。
     * 两个数都该跟着手机连接一起涨落；只涨不落就说明拆除那一环又断了。
     */
    stats: () => ({ upstreamOpen, sseOpen: upstreamSseOpen }),
  };
}

module.exports = { createLanProxy };

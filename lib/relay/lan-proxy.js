'use strict';

/**
 * 局域网直连代理：手机在同一个 Wi-Fi 下直接访问
 * http://<电脑IP>:<lanPort>，带上配对拿到的令牌后代理到本机 dsh web。
 *
 * 只服务 App：未认证的请求一律 JSON 401，不给任何网页（网页版配对页与网页本体已删除）。
 *
 * 与中转隧道的关系：同网走本代理（零延迟、不依赖公网），异地走 dsh-mobile-server 中转；
 * 两者互不影响，可同时开启。
 */

const http = require('node:http');
const { WebSocketServer, WebSocket } = require('ws');
const core = require('./core.js');
const { advertisedCandidates, ipv6Candidates, isGlobalUnicastV6 } = require('./lan-network.cjs');
const { safeEqual } = require('../shared/dshtoken');
const { isFreshRequest } = require('../shared/fresh-request');
const { encodeJsonBody } = require('../shared/http-util');
const { withViaHeader } = require('../shared/via-header');
const { createPairThrottle } = require('../shared/pair-throttle');
const { openSealedPairRequest, sealPairResponse } = require('../shared/e2ee-pair');
const credentials = require('../shared/credentials-entry.js').credentialsEntry();

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
]);

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
// 与中转路的上限（tunnel.js 的 MAX_UPSTREAM_SSE_CONNECTIONS，同为 64）取同一个数：两条路
// 通向同一个宿主、同一种资源，一台手机的几个被丢弃连接不该把另一条路挡在 429 外面。
// 这边每台设备各有自己的 TCP，实测 3 台设备正常十来条，所以这个数只当失控闸——正常使用
// 不该碰到它。
const MAX_UPSTREAM_SSE_CONNECTIONS = 64;

function createLanProxy(opts) {
  const {
    lanPort,
    pairingCode,
    pairingTicket = '',
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
    /**
     * 配对成功之后调一次：换码 + 换票据（§5.1）。来回调交回装配层，因为「换」这件事要
     * 同时写宿主状态并让旁路重读配置，不是这个代理的职责。
     */
    onPaired = null,
    /** 读取隔离：本地镜像快照读取回调，命中时直接回（不再连主进程）。 */
    readSnapshot = () => null,
    /** 上游 SSE 的失控闸，默认见 MAX_UPSTREAM_SSE_CONNECTIONS。 */
    maxUpstreamSse = MAX_UPSTREAM_SSE_CONNECTIONS,
  } = opts;

  let server = null;
  // IPv6 那条监听（`::`，ipv6Only）。它可能压根没建立（机器没有 IPv6），所以单独存一份。
  let v6Server = null;
  let wss = null;
  // 活着的上游请求计数（自检台账与失控闸消费）：见 proxyToUpstream 的拆除注释。
  let upstreamOpen = 0;
  let upstreamSseOpen = 0;
  // 实际监听的端口。首选端口被占时（见 lib/relay/port-allocator.cjs）会退到内核
  // 分配的空闲端口，这时对外必须报 `actualPort` 而不是 `lanPort`，否则状态接口和
  // 配对二维码里带的都是那个根本没在监听的死端口。
  let actualPort = lanPort;
  // 配对失败限流：ip -> { fails, lockedUntil }（与 relay 侧策略一致：5 次失败锁 60s）
  /**
   * 配对闸门（§10.4）。局域网这条**不用分来源**：来源就是手机真实的局域网地址，
   * 而按来源分桶只解决「一个人打错把所有人锁死」；这里换成不看来源的全局令牌桶，
   * 与宿主那条完全同口径（`shared/pair-throttle.js`）。
   *
   * 两份状态各自独立：这条跑在旁路子进程里、那条跑在主进程里，跨进程共享要么加锁
   * 要么走 RPC，而两条路的网络含义本来就不同。
   */
  const pairThrottle = createPairThrottle();

  /**
   * 签发凭据。**在旁路子进程里必须走 IPC**（§3.7）：这个进程拿的是凭据库的只读副本，
   * 自己写盘只会和主进程那份互相覆盖（旁路签的吊销会被回滚、主进程签的在旁路查不到，
   * 经中转配上的手机回局域网就是 401）。装配层传进来就走它，测试里不传就用本地库。
   */
  const issueCredential = typeof opts.issueCredential === 'function'
    ? opts.issueCredential
    : (device, extra) => credentials.issue(instanceId, device, '', undefined, extra);

  /**
   * 当前配对码与票据。
   *
   * **必须是取值而不是快照**：配对成功之后宿主会立刻换码 + 换票据（§5.1），而重建局域网
   * 代理会把刚握上的连接全掐掉。传入的是取值器就只换值、不动监听。
   */
  const currentPairing = typeof opts.currentPairing === 'function'
    ? opts.currentPairing
    : () => ({ code: pairingCode, ticket: pairingTicket });

  function log(...args) {
    onLog('[lan-proxy]', ...args);
  }
  /** 日志里的监听地址：IPv6 按 URL 习惯套方括号（`[::]`），IPv4 原样。 */
  function formatHost(host) {
    const text = String(host);
    return text.includes(':') ? `[${text}]` : text;
  }

  /** 闸门状态重置（测试用）。 */
  function resetPairThrottle() {
    pairThrottle.noteSuccess();
  }

  /**
   * 请求出示的凭据原文，取不到返回 null。
   *
   * 接受**任意非空串**，不再只认 `dshc_` 前缀（§3.2）：T1 是 `<实例号>.<exp>.<随机>`，
   * 旧版是 `dshc_…`，升级前的老 App 还有 HMAC Bearer —— 三种都从这里过，由查库结果决定
   * 走哪条路。App 把设备凭据放在独立的 `X-Dsh-Device-Credential` 头里，`Authorization`
   * 留给宿主 token；`Authorization` 分支是给「只有一枚 Bearer 的旧客户端」的兜底。
   *
   * 旧实现只在这两处找 `dshc_`，于是本函数对真实 App 的 T1 流量恒为 null，
   * 「吊销能作用于局域网直连」永远落不了地。
   */
  function presentedCredential(req) {
    const raw = req.headers['x-dsh-device-credential'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (typeof header === 'string' && header.trim()) return header.trim();
    const m = /^Bearer\s+([^\s]+)$/.exec(req.headers.authorization || '');
    return m ? m[1] : null;
  }
  /**
   * 这条请求对应的凭据记录（可能来自凭据头、Bearer 或 cookie）。
   *
   * 换上游令牌用（§3.3）：
   *  - 新 T1 记录**不带 `hostToken`**，代理把请求里出示的那一枚原样设成上游 `Authorization`；
   *  - 旧的 HMAC 记录仍用存下来的 `hostToken`（它那一枚是宿主的无状态令牌，规整不了）。
   * 只有 cookie、没有 Bearer/头的请求（预览这类）也要能从 cookie 查记录，否则那条路径
   * 换不到上游令牌，只能拿无状态 token 硬顶。
   */
  function credential(req) {
    const presented = presentedCredential(req);
    if (presented) {
      const found = credentials.lookup(presented, instanceId);
      if (found) return { record: found, presented };
      // 本机不认识这一枚（中转签的 / 升级前的 HMAC），往下按 cookie 再找一次。
    }
    const m = /dsh_lan=([^;]+)/.exec(req.headers.cookie || '');
    const token = m ? m[1] : '';
    if (!token) return null;
    const byCookie = credentials.lookup(token, instanceId);
    return byCookie ? { record: byCookie, presented: token } : null;
  }
  /** 上游要带的 `Authorization` 值：新记录用出示的那一枚，旧记录用存下的宿主令牌。 */
  function upstreamTokenOf(found) {
    if (!found) return null;
    if (found.record && found.record.hostToken) return found.record.hostToken;
    return found.presented || null;
  }
  /**
   * 无状态凭据校验：dsh_lan cookie 或 `Authorization: Bearer <token>`。两者同源
   * 同格式，均为 lanSecret 签名的 HMAC token；RN 在部分平台会丢弃手动 Cookie
   * 头，故 Bearer 兜底。**只在凭据库查不到之后才走这里**：新配对发的是 T1，
   * 而 T1 不是 HMAC 签名，验签必然不过。
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
   * 鉴权结果，**带上被拒原因**（§3.8）：被吊销 / 已过期 / 只是没有凭据。
   *
   * 顺序是这里唯一要紧的东西（§3.3）：**凭据头 → Bearer → cookie → 旧 HMAC**。前三种
   * 都按「整串拿去查库」处理 —— 查到就按记录判（吊销/过期立即拒绝、绝不回退），查不到才
   * 往下走。
   *
   * 「本机不认识这一枚」必须能回退：公网配对时凭据可能是中转签的（那条库在中转那边），
   * 宿主这里查不到；升级前的老 App 手上还有一枚 HMAC token。两种都靠无状态校验兜住，
   * 若一律拒绝，「公网配对后回到局域网直连」这个主要用法会直接 401。
   *
   * 局域网这条也要分原因：被踢的手机回家连局域网，只回一句 401 的话用户看到的还是
   * 「请求失败」，而它其实已经不能做任何事了。
   */
  function authOutcome(req) {
    const candidates = [];
    const headerRaw = req.headers['x-dsh-device-credential'];
    const header = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
    if (typeof header === 'string' && header.trim()) candidates.push(header.trim());
    const bearer = /^Bearer\s+([^\s]+)$/.exec(req.headers.authorization || '');
    if (bearer) candidates.push(bearer[1]);
    const cookie = /dsh_lan=([^;]+)/.exec(req.headers.cookie || '');
    if (cookie) candidates.push(cookie[1]);
    // 候选里有**任何一枚**是本机签发过的，就以它为准：三种出示方式里只要有一枚能查到记录，
    // 「这台设备被吊销了」就是答案，不能靠另外两枚里更宽松的那个绕过它。
    for (const candidate of candidates) {
      const known = credentials.lookup(candidate, instanceId);
      if (!known) continue;
      if (known.revokedAt) return { ok: false, reason: 'revoked' };
      if (known.expiresAt && known.expiresAt <= Date.now()) return { ok: false, reason: 'expired' };
      // 还剩不到一半就顺手续期（§3.9）。
      try { credentials.renew(known); } catch { /* 续期失败不影响这一次 */ }
      return { ok: true, record: known };
    }
    if (cookieValid(req) || bearerValid(req)) return { ok: true };
    return { ok: false, reason: 'unauthorized' };
  }

  function authorized(req) {
    return authOutcome(req).ok;
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

  /**
   * 下发 cookie。**值必须是请求里要返回的那一枚凭据**（§3.3）：新配对发 T1，
   * 一边 T1 一边 HMAC 会让「浏览器侧」与「App 侧」拿到两种不同身份的东西。
   *
   * `Max-Age` 是浏览器侧的事，服务端一律以记录的到期为准，所以这里沿用 30 天；
   * App 不受它影响（它自己带着 Bearer）。
   */
  function setCookie(res, credentialValue) {
    res.setHeader(
      'set-cookie',
      `dsh_lan=${credentialValue}`
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
  /**
   * 未认证的统一出口。
   *
   * **绝不能回 200 HTML**：App 的 `response.ok` 会为真、把连接通道永久钉在局域网并重置
   * 熔断，随后 `res.json()` 失败报「请求失败 (HTTP 200)」，既不回退中转也不提示重配。
   *
   * 被吊销 / 已过期的要说清是哪一种（§3.8）：只回一句「缺少或无效的移动 token」时，
   * 用户看到的还是「请求失败」，而它其实已经不能做任何事了。
   */
  function sendUnauthorized(res, reason = 'unauthorized') {
    const body = reason === 'revoked'
      ? { ok: false, error: { code: 'device-revoked', message: '这台设备已被解除绑定，请重新扫码' } }
      : reason === 'expired'
        ? { ok: false, error: { code: 'device-expired', message: '这台设备的授权已过期，请重新扫码' } }
        : { ok: false, error: { code: 'unauthorized', message: '缺少或无效的移动 token' } };
    try {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    } catch { /* 客户端已断开 */ }
  }

  function proxyToUpstream(req, res) {
    // 读取隔离：命中本地镜像快照时直接回，不再连主进程。
    // 例外：带 ?fresh=1 的写后刷新必须回源——镜像最多旧 500ms，撞上写操作会把刚做完的
    // 事显示成没生效（判定与实测见 lib/shared/fresh-request.js）。
    // 带上请求头：工人侧靠 `x-dsh-proto` 判「这条会话是不是加密的」，加密的必须回源主进程
    // （快照那把捷径不封信封，见 sidecar-facade-worker 的 snapshotRead）。
    const body = isFreshRequest(req.url) ? null : readSnapshot({ method: req.method, path: req.url, headers: req.headers });
    if (body && body.ok) {
      try {
        // 与中转那条同一条捷径：列表 / 工作区 / 消息 / 统计都在这里回，压缩才省得下来。
        const encoded = encodeJsonBody(JSON.stringify(body), req.headers['accept-encoding']);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          vary: 'accept-encoding',
          ...(encoded.gzip ? { 'content-encoding': 'gzip' } : {}),
        });
        res.end(encoded.body);
      } catch { /* 已关闭 */ }
      return;
    }
    const headers = withViaHeader(
      Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP_BY_HOP.has(k))),
      'lan',
      `${upstreamHost}:${upstreamPort}`,
    );
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
          // `content-length` 照原样转出去（**它不是逐跳头**，见 `HOP_BY_HOP` 上面那条说明）：
          // 丢了它，每一发响应都退化成 chunked，客户端拿不到长度 —— 小到进度条、大到
          // 「这份文件收完了没有」都无从判断。中转那条路早就这么处理了
          //（`dsh-mobile-server` 的 `headers.rs` 里那个 `forwardable_response_header`），
          // 两条路对同一个宿主必须给同一份头，否则同一个文件在 Wi-Fi 下和在外面表现不一样。
          if (!HOP_BY_HOP.has(k) || k === 'content-length') out[k] = v;
        }
        res.writeHead(ures.statusCode, out);
        // SSE 的第一段（`: connected` 与响应头）要立刻到手机，别等内核攒够一个段。
        // 少了这一下，弱网 / 代理缓冲会把「流建好了」拖到十几秒之后。
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
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
     * 只挂 `error` 的话，手机断开后上游请求还活着，宿主那边的响应永远等不到 `close`，events
     * 流与每条会话流的订阅就永不退订，宿主继续往一条没人读的连接上生成帧与正文。中转路径有
     * `httpCancel` 帧负责拆，局域网这条路同样要有。
     *
     * 判据是 `res.writableEnded`：正常活完的响应结束时就已置位，只有客户端提前走才落到 false。
     */
    res.on('close', () => {
      if (res.writableEnded) return;
      try { up.destroy() } catch { /* 已断开 */ }
    });
    // GET/HEAD 没有请求体：直接收尾发出去，不要依赖 `req` 的 `end` 事件 —— SSE 客户端的
    // 那条连接未必会像普通 fetch 一样把请求流收掉，`pipe` 一直不 end，上游就永远不处理。
    if (req.method === 'GET' || req.method === 'HEAD') up.end();
    else req.pipe(up);
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

    const headers = withViaHeader(
      Object.fromEntries(Object.entries(req.headers).filter(([key, value]) => !HOP_BY_HOP.has(key) && value !== undefined)),
      'lan',
      `${upstreamHost}:${upstreamPort}`,
    );
    // 上游要认得这条请求：新 T1 记录没有存下来的宿主令牌，就把请求里出示的那一枚
    // 原样带上去；旧 HMAC 记录仍用它自己的 hostToken。
    const upstreamToken = upstreamTokenOf(credential(req));
    if (upstreamToken) headers.authorization = `Bearer ${upstreamToken}`;

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
      /**
       * v4 / v6 两条监听共用的请求处理器。协议族只影响 `req.socket.remoteAddress` 的
       * 形状（IPv4 是 `::ffff:a.b.c.d` 或 `a.b.c.d`，IPv6 是原生地址），路由与鉴权完全一致。
       */
      const handleRequest = (req, res) => {
        const url = new URL(req.url, 'http://lan.local');
        try {
          if (url.pathname === '/__lan_pair' && req.method === 'POST') {
            const ip = req.socket.remoteAddress || '';
            // 双栈之后这个**不需要凭据**的接口在公网 IPv6 上也够得着，而它本来是「同一个
            // Wi-Fi 内的手机直接配对」用的。原生全球单播 IPv6 来源一律按「配对码错误」回
            // （`pairDenied`：JSON、401，与码错完全同形，不承认这个接口为谁而开）——刚好
            // 也是地图 A3-12 那条刻意设计要的形状：未认证请求绝不能回 2xx，否则 App 会把
            // 连接通道钉在直连并重置熔断，随后 json 解析失败，既不回退中转也不提示重配。
            //
            // 不记限流计数：按源地址计数在 IPv6 上等于按 /128 计数，换个源地址就是新桶，
            // 记了没用、白留痕迹。
            //
            // 只收这一格：只有公网 IPv4 的机器上，手机经公网 IPv4 打进来的配对是**现有受
            // 支持流程**（配对二维码里就带公网 IPv4 候选），判据必须是「原生全球 IPv6」
            // 而不是「公网地址」——后者会把那条正常用法一起拦掉。判据在 lan-network.cjs。
            if (isGlobalUnicastV6(ip)) {
              pairDenied(res);
              return;
            }
            let b = '';
            req.on('data', (c) => (b += c));
            req.on('end', () => {
              try {
                const gate = pairThrottle.take();
                if (!gate.allowed) {
                  res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(gate.retryAfterSec) });
                  res.end(JSON.stringify({ ok: false, error: '尝试过于频繁，请稍后再试' }));
                  return;
                }
                const input = JSON.parse(b || '{}')
                // 两种形状（§8.3(2)）：带 `sealed` 是协议 v2，带 `code` 是旧 App。
                const sealed = typeof input?.sealed === 'string' ? input.sealed.trim() : '';
                // 与 `/pair` 同一条收口（§10.4(d)）：认得协议（请求里带 `proto`）却还带
                // 六位码，只可能是过期的旧二维码 —— 那条形状逐位可试，不值得继续开门。
                if (!sealed && input?.proto !== undefined) {
                  res.writeHead(400, { 'content-type': 'application/json' });
                  res.end(JSON.stringify({
                    ok: false,
                    code: 'legacy-pairing-retired',
                    error: '这张二维码已过期，请重新扫一下电脑面板上当前的二维码',
                  }));
                  return;
                }
                let suppliedDevice;
                let issuedExtra;
                let pairKey = null;
                if (sealed) {
                  const opened = openSealedPairRequest({
                    ticket: currentPairing().ticket || '',
                    instanceId,
                    sealed,
                    claimedInstanceId: typeof input.instanceId === 'string' ? input.instanceId : '',
                  });
                  if (!opened.ok) {
                    // 解不开就是「配对失败」，与「配对码错误」同形，不给探测空间。
                    pairThrottle.noteFail();
                    pairDenied(res);
                    return;
                  }
                  suppliedDevice = opened.device;
                  issuedExtra = { deviceKey: opened.deviceKey, keyId: opened.keyId };
                  pairKey = opened.pairKey;
                } else {
                  const code = typeof input?.code === 'string' ? input.code.trim() : '';
                  // 长度不符直接判错（timingSafeEqual 长度不同会抛异常，曾导致整个 dsh web 崩溃）
                  if (!/^\d{6}$/.test(code)) {
                    res.writeHead(400, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: '配对码需为 6 位数字' }));
                    return;
                  }
                  if (!safeEqual(code, String(currentPairing().code || ''))) {
                    pairThrottle.noteFail();
                    pairDenied(res);
                    return;
                  }
                  suppliedDevice = input && typeof input.device === 'object' && input.device !== null
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
                }
                // 配对码正确 / 票据解得开 → 桌面端授权（TeamViewer 模型）。透传手机端完整设备元数据。
                // 注意：这里**不**清限流计数——被拒绝的尝试同样要计数，否则
                // 猜对配对码但被拒的一方可以无限次重试。
                const device = {
                  ...Object.fromEntries(Object.entries(suppliedDevice || {}).filter(([, value]) => value !== undefined)),
                  ip: (suppliedDevice && suppliedDevice.ip) || ip,
                }
                onApprove(device)
                  .then(({ approved, token, platform }) => {
                    if (!approved) {
                      // 与「配对码错误」返回同一响应，配对码不再可通过状态码探测。
                      pairDenied(res);
                      return;
                    }
                    pairThrottle.noteSuccess();
                    // 新签发的是每设备凭据本身，它同时当 Bearer、cookie 与 deviceCredential
                    // （§3.2）。旁路子进程里这一步要打到主进程（唯一写方，§3.7）。
                    return Promise.resolve(issueCredential(device, issuedExtra)).then((issued) => {
                      const credentialValue = issued.credential;
                      setCookie(res, credentialValue);
                      // 配对成功即换码 + 换票据（§5.1）。谁截了二维码，那张图从这一刻起就作废。
                      if (typeof onPaired === 'function') {
                        try { onPaired(); } catch (error) { log('rotate pair failed:', error && error.message); }
                      }
                      // 宿主自己那批直连候选一起回给手机：手输公网地址（域名 / 公网 IP）配对时，
                      // 二维码那条路没有、也就只有这一处能拿到内网地址。回家后如果那个公网地址
                      // 打不通（路由器不支持回环 / 域名只在外网解析），手机还能靠这批候选找到这台
                      // 机器，否则只能删设备重配。App 的 `doPair` 本来就合并响应里的 `lanUrls`
                      // 与 `ipv6Candidates`，这里不回它就只能记住手输的那一个地址。
                      const directCandidates = advertisedCandidates(actualPort).map((candidate) => candidate.url).filter(Boolean);
                      const v6Candidates = ipv6Candidates(actualPort).map((candidate) => candidate.url).filter(Boolean);
                      const payload = {
                        ok: true,
                        proto: pairKey ? 2 : 1,
                        instanceId,
                        token: credentialValue,
                        cookie: `dsh_lan=${credentialValue}`,
                        // 手机拿它对一次时钟（§8.3(7)）：时钟偏太多会被当成重放，
                        // 而用户完全不知道「这个 App 连不上」的原因是手机时间不准。
                        serverTime: Date.now(),
                        ...(directCandidates.length ? { lanUrls: directCandidates } : {}),
                        ...(v6Candidates.length ? { ipv6Candidates: v6Candidates } : {}),
                        deviceId: issued.deviceId,
                        deviceCredential: issued.credential,
                        credentialExpiresAt: issued.expiresAt,
                        // 宿主自己的系统标识，不是手机的。手机把它存进设备记录，
                        // 好让设备行在第一次 status 轮询之前就画得出图标。
                        ...(platform ? { hostPlatform: platform } : {}),
                      };
                      // 新协议的回包必须加密：里面有 token / cookie / deviceCredential，
                      // 明文回包等于让链路上的任何人顺手拿到这台设备未来一年的通行证。
                      if (pairKey) {
                        try {
                          res.writeHead(200, { 'content-type': 'application/json' });
                          res.end(JSON.stringify(sealPairResponse(pairKey, instanceId, payload)));
                          return;
                        } catch (error) {
                          log('pair seal failed:', error && error.message);
                          res.writeHead(500, { 'content-type': 'application/json' });
                          res.end(JSON.stringify({ ok: false, error: 'internal error' }));
                          return;
                        }
                      }
                      res.writeHead(200, { 'content-type': 'application/json' });
                      // cookie 同时放进 body：RN fetch 读不到 Set-Cookie 响应头，App 需自行携带
                      res.end(JSON.stringify(payload));
                      })
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
          const auth = authOutcome(req);
          if (!auth.ok) {
            sendUnauthorized(res, auth.reason);
            return;
          }
          const upstreamToken = upstreamTokenOf(credential(req));
          if (upstreamToken) req.headers.authorization = `Bearer ${upstreamToken}`;
          proxyToUpstream(req, res);
        } catch (err) {
          log('request error:', err.message);
          try {
            res.writeHead(500);
            res.end('internal error');
          } catch { /* ignore */ }
        }
      };

      server = http.createServer(handleRequest);

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
          const boundHost = address && address.address ? address.address : '0.0.0.0'
          log(`listening on ${formatHost(boundHost)}:${actualPort}`)
          onBound()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, '0.0.0.0')
      })

      /**
       * IPv6 那条监听：拿 IPv4 实绑的端口，`::` + 显式 `ipv6Only: true`。
       *
       * 不合成一条双栈监听：`impl.js` 的端口占用探测真去 `listen(port, '0.0.0.0')` 试探，
       * 一条双栈的 `::` 会把首选端口一律探成「被占」，于是落到内核随机端口、端口每次启动都
       * 可能漂；把探测也改成 `::`，关掉 IPv6 的机器上又会因 EAFNOSUPPORT 永远判「被占」。
       * 各管一个协议族就没这个问题。
       *
       * 它是软的：只有「手机不在同一 Wi-Fi、只有 IPv6」时才用得上，绑不上就记一行、只留 IPv4。
       */
      const startV6 = () => new Promise((onDone) => {
        const v6 = http.createServer(handleRequest);
        v6.on('upgrade', handleUpgrade);
        v6.once('error', (err) => {
          log(`IPv6 监听未建立（${err.code || err.message}），只保留 IPv4 直连`);
          onDone();
        });
        v6.once('listening', () => {
          v6.on('error', (err) => log('IPv6 server error:', err.message));
          v6Server = v6;
          const address = v6.address();
          log(`listening on ${formatHost(address.address)}:${address.port}`);
          onDone();
        });
        try {
          // options 必须整个作为**第一个**参数传：`listen(port, host, backlog)` 的第三位
          // 是 backlog（数字），传对象进去会被忽略 —— 于是 `ipv6Only` 从来没生效过。
          // macOS / BSD 的 v6 套接字默认就是 v6only，所以这条在本机一直"看着正常"；
          // Linux 默认是双栈，它会跟上面那条 `0.0.0.0` 撞成 EADDRINUSE，整条 IPv6
          // 监听静默不建立（GitHub Actions 上就是这么红的）。
          v6.listen({ port: actualPort, host: '::', ipv6Only: true });
        } catch (err) {
          log(`IPv6 监听未建立（${err.code || err.message}），只保留 IPv4 直连`);
          onDone();
        }
      });

      // 端口自适应：首选端口在探测之后、真正 listen 之前被别的进程抢走时（另一个
      // 实例刚起、或者上一轮 stop() 还没释放干净），退到内核分配的空闲端口，而不是
      // 让一次 EADDRINUSE 把整条 LAN 直连带走。
      // 成功路径必须在这里就 resolve：只挂 .catch 的话，bind(lanPort) 成功时
      // catch 分支根本不会执行，外层那个 Promise 就永远 pending——服务器确实在监听，
      // 但调用方拿到的 start() 永不落定，lan.state 永远停在 connecting、error 还是
      // null。端口回退是兜底，不是主路径。
      bind(lanPort).then(async () => { await startV6(); resolve() }, async (error) => {
        if (!error || error.code !== 'EADDRINUSE') return reject(error);
        log(`port ${lanPort} busy (${error.code}), falling back to an OS-assigned port`);
        try { await bind(0); await startV6(); resolve() } catch (retryError) { reject(retryError) }
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
    if (v6Server) {
      try { v6Server.close(); } catch { /* ignore */ }
      try { v6Server.closeAllConnections?.(); } catch { /* ignore */ }
      v6Server = null;
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

'use strict';

/**
 * 局域网直连代理：手机在同一个 Wi-Fi 下直接访问
 * http://<电脑IP>:<lanPort>，经配对码校验后代理到本机 dsh web。
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
const WS_UPSTREAM_PENDING_MAX_BYTES = 1024 * 1024;

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
  } = opts;

  let server = null;
  let wss = null;
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
  function clearCookie(res) {
    // 与 setCookie 保持同一组属性：属性不一致时部分客户端会当成另一个 cookie，删不掉。
    res.setHeader('set-cookie', 'dsh_lan=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  }

  const PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>连接 DeepSeek Harness</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;background:#0f1115;color:#e6e8eb;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:min(380px,100%);background:#171a21;border:1px solid #262b36;border-radius:16px;padding:28px}
h1{font-size:18px;margin-bottom:6px}
.sub{font-size:13px;color:#8b93a1;margin-bottom:20px;line-height:1.6}
label{display:block;font-size:12px;color:#8b93a1;margin:14px 0 6px}
input{width:100%;padding:10px 12px;font-size:15px;background:#0f1115;color:#e6e8eb;border:1px solid #2c3340;border-radius:10px;outline:none}
input:focus{border-color:#4d6bfe}
button{width:100%;margin-top:20px;padding:11px;font-size:15px;background:#4d6bfe;color:#fff;border:none;border-radius:10px;cursor:pointer}
.err{margin-top:14px;font-size:13px;color:#f85149;min-height:18px}
</style></head><body>
<div class="card">
  <h1>连接 DeepSeek Harness</h1>
  <div class="sub">局域网直连 · 实例 <code>${instanceId}</code><br>请输入桌面端「远程连接」面板显示的 6 位配对码</div>
  <form id="f"><label for="code">配对码</label><input id="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code">
  <button type="submit">连接</button></form>
  <div class="err" id="err"></div>
</div>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = document.getElementById('code').value.trim();
  if (!/^\d{6}$/.test(code)) {
    document.getElementById('err').textContent = '请输入 6 位数字配对码';
    return;
  }
  const r = await fetch('/__lan_pair', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ code }) });
  if (r.ok) { location.href = '/'; }
  else { document.getElementById('err').textContent = '配对码错误或尝试过于频繁'; }
});
</script></body></html>`;

  /**
   * 是否是「程序化 API 请求」。
   *
   * 未认证时给浏览器导航回配对页（200 HTML）是刻意的：用户直接在手机浏览器里
   * 打开局域网地址即可输入配对码。但**绝不能**这样答复 API 请求 ——
   * `/api/mobile/v1/*` 被答成 200 + HTML 时，App 的 `app/src/api.ts` 会把它当成
   * 成功（`response.ok` 为真 → `publishRoute` 把连接通道钉在局域网、并重置局域网
   * 熔断），随后 `res.json()` 解析失败，`unwrapResult` 抛出「请求失败
   * (HTTP 200)」。结果是桌面端换过 lanSecret、或设备凭据被吊销之后，App 会永久
   * 卡在局域网通道上：既不会回退到中转，也不会提示重新配对。
   *
   * 判定规则：路径以 `/api/` 开头，或客户端明确不接受 `text/html`。
   */
  function isApiRequest(req, url) {
    if (url.pathname.startsWith('/api/')) return true;
    return !/\btext\/html\b/i.test(String(req.headers.accept || ''));
  }

  /**
   * 未认证的 API 请求：回 JSON 401，与移动 API 的鉴权失败保持同一种形状，
   * App 据此显示可读的「缺少或无效的移动 token」，而不是「请求失败 (HTTP 200)」。
   */
  function sendUnauthorized(res) {
    try {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: '缺少或无效的移动 token' } }));
    } catch { /* 客户端已断开 */ }
  }

  function sendPage(res, status) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
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
    up.on('error', (err) => {
      log('proxy error:', err.message);
      try {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`upstream error: ${err.message}`);
      } catch { /* 已关闭 */ }
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

    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      log(`ws 升级未建立：${status} ${message}`);
      dropUpstream();
      refuseSocket(socket, status, message);
    };

    // 手机在等上游的时候先走了：别白连上游。这两个监听还兼着兜底 socket 错误——
    // 这段窗口里 socket 是我们在拿着，没有人接 'error' 会冒泡成未捕获异常。
    const abandon = () => { if (settled) return; settled = true; dropUpstream(); };
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
        settled = true;
        dropUpstream();
        socket.destroy();
        return;
      }
      pending.push(chunk);
    });

    up.on('open', () => {
      upstreamReady = true;
      if (settled) return;
      wss.handleUpgrade(req, socket, head, (ws) => {
        settled = true;
        phoneWs = ws;
        ws.on('message', (data) => {
          if (up.readyState === WebSocket.OPEN) up.send(data);
        });
        ws.on('close', () => { try { up.close(); } catch { /* ignore */ } });
        ws.on('error', () => { try { up.terminate(); } catch { /* ignore */ } });
        up.on('close', () => { try { ws.close(); } catch { /* ignore */ } });
        for (const chunk of pending) {
          if (ws.readyState !== WebSocket.OPEN) break;
          ws.send(chunk);
        }
        pending.length = 0;
        pendingBytes = 0;
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
          if (url.pathname === '/__lan_logout') {
            clearCookie(res);
            res.writeHead(302, { location: '/' });
            res.end();
            return;
          }
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
            // API 请求必须回 JSON 401（见 isApiRequest 注释）；只有浏览器导航才给配对页。
            if (isApiRequest(req, url)) sendUnauthorized(res);
            else sendPage(res, 200);
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

  return { start, stop, port };
}

module.exports = { createLanProxy };

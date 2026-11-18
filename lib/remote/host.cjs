// 显式一次性邀请授权远程电脑，并把认证后的加密流接到本机固定网页入口。
// 浏览器这条跨源客户端认不了头也认不了预检头，故两条入口同时认 instance 查询参数。
'use strict';

const net = require('node:net');
const { WebSocketServer } = require('ws');
const { createPairThrottle } = require('../shared/pair-throttle.js');
const { readJsonBody, sendJson } = require('../shared/http-util.js');
const { instanceHintRefusal } = require('./instance-hint.cjs');
const c = require('./crypto.cjs');

const PAIR_PATH = '/api/mobile/v1/remote-computers/pair';
const TUNNEL_PATH = '/api/mobile/v1/remote-computers/tunnel';
const INVITE_TTL = 10 * 60 * 1000;
const HANDSHAKE_MS = 10_000;
const KEY_ID = /^[0-9a-f]{16}$/;
const CONTROL_OPS = new Set(['tunnels', 'tunnels.refresh']);

// 版本号是数字但不等于 1 说明对端插件协议代不同，报 REMOTE_VERSION 好让它提示升级，
// 不要混进普通身份认证失败。
function parseHandshake(data, binary) {
  try {
    return c.parseMessage(data, binary);
  } catch (error) {
    if (error?.code === 'REMOTE_AUTH' && !binary) {
      let value;
      try { value = JSON.parse(Buffer.from(data).toString('utf8')); } catch { value = null; }
      if (value && typeof value.v === 'number' && value.v !== 1) throw c.error('REMOTE_VERSION', 'Unsupported remote protocol version');
    }
    throw error;
  }
}


function createRemoteHost({ state, credentials, routesOf, getUpstreamPort, getWebPort, getLaunchToken, getConnectionInfo, onControl, now = Date.now, log = () => {} }) {
  const tickets = new Map();
  const sessions = new Set();
  const throttle = createPairThrottle({ now });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: c.MAX_MESSAGE });
  let closed = false;
  const instanceId = () => String(state.instanceId || '');
  const name = () => String(state.name || state.instanceName || 'DSH');
  const info = async () => getConnectionInfo ? await getConnectionInfo() : undefined;
  const routes = async () => (typeof routesOf === 'function' ? await routesOf() : []).map(({ url, channel }) => ({ url, channel }));
  const pairAad = (ticketId, direction) => JSON.stringify(['dsh-computer-pair-v1', instanceId(), ticketId, direction]);

  function valid(record) {
    return record && record.instanceId === instanceId() && record.remoteWeb === true && !record.revokedAt && (!record.expiresAt || record.expiresAt > now());
  }
  function recordOf(credential, keyId, deviceId) {
    const record = credentials.find(credential, instanceId());
    return valid(record) && record.keyId === keyId && record.deviceId === deviceId ? record : null;
  }
  function stop(session, code = 4003) {
    if (session.stopped) return;
    session.stopped = true;
    clearTimeout(session.timer);
    const failure = code === 4001 ? 'REMOTE_EXPIRED' : code === 4003 ? 'REMOTE_REVOKED' : code === 4000 ? 'REMOTE_TIMEOUT' : 'REMOTE_CONNECT';
    if (session.stream) session.stream.endAccess(failure);
    else session.deny?.(failure);
    session.upstream?.destroy();
    if (session.ws.readyState < 2) session.ws.close(code);
    const timer = setTimeout(() => session.ws.terminate(), 250);
    timer.unref?.();
  }
  function checkAuthorization() {
    for (const session of sessions) {
      if (session.expiresAt && session.expiresAt <= now()) stop(session, 4001);
      else if (session.credential) {
        const record = recordOf(session.credential, session.keyId, session.deviceId);
        if (!record || record.deviceKey !== session.deviceKey) stop(session);
      }
    }
  }
  const poll = setInterval(checkAuthorization, 1000);
  poll.unref?.();

  async function mintInvite() {
    if (closed) throw c.error('REMOTE_CONNECT', 'Remote host is closed');
    for (const [id, value] of tickets) if (value.expiresAt <= now()) tickets.delete(id);
    const payload = { type: 'dsh-computer', version: 1, instanceId: instanceId(), name: name(), ticketId: c.random(16), ticket: c.random(), expiresAt: now() + INVITE_TTL, routes: await routes() };
    tickets.set(payload.ticketId, payload);
    return { invite: `dshcomputer://v1?data=${c.json(payload).toString('base64url')}`, expiresAt: payload.expiresAt };
  }

  async function handlePair(req, res) {
    // 浏览器从官网这个源打过来是跨源的：预检和正式回包都要能让浏览器放行。
    // 配对本身有一次票据 + 端到端加密证明，CORS 不是这里的鉴权边界，回显来源即可。
    // 放在方法判断之前：预检（OPTIONS）必须能被答掉，否则真请求根本发不出来。
    const origin = req && req.headers
      ? (Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin)
      : '';
    const allowCors = () => { if (origin) res.setHeader('access-control-allow-origin', origin); };
    if (req.method === 'OPTIONS') {
      allowCors();
      res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type, x-dsh-instance');
      res.setHeader('access-control-max-age', '600');
      res.writeHead(204);
      res.end();
      return;
    }
    allowCors();
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, code: 'REMOTE_METHOD' }); return; }
    if (closed) { sendJson(res, 503, { ok: false, code: 'REMOTE_CONNECT' }); return; }
    // 请求自报的实例号（头优先，缺头看 `?instance=`）与本机对不上：这张链接指向别的电脑。
    // 趁还没花掉限流额度、也没读请求体时就拒掉，别让一张错链接吃满限流。
    const refusal = instanceHintRefusal(req, instanceId());
    if (refusal) { sendJson(res, 400, { ok: false, code: refusal }); return; }
    const rate = throttle.take();
    if (!rate.allowed) { res.setHeader('retry-after', String(rate.retryAfterSec)); sendJson(res, 429, { ok: false, code: 'REMOTE_RATE_LIMIT' }); return; }
    const timeout = setTimeout(() => req.destroy(), HANDSHAKE_MS);
    timeout.unref?.();
    let body;
    try { body = await readJsonBody(req, c.MAX_HANDSHAKE); } finally { clearTimeout(timeout); }
    const ticket = body && tickets.get(body.ticketId);
    try {
      if (!ticket || ticket.expiresAt <= now() || body.instanceId !== instanceId()) throw c.error('REMOTE_AUTH');
      if (body.v !== 1) throw c.error(typeof body.v === 'number' ? 'REMOTE_VERSION' : 'REMOTE_AUTH');
      const keys = c.pairKeys(ticket.ticket, instanceId(), ticket.ticketId);
      const request = c.openJson(keys.up, body.sealed, pairAad(ticket.ticketId, 'up'));
      c.keyBytes(request.deviceKey);
      c.keyBytes(request.nonce);
      if (!KEY_ID.test(request.keyId) || typeof request.deviceId !== 'string' || !request.deviceId || request.deviceId.length > 128) throw c.error('REMOTE_AUTH');
      // 在任何异步工作前消耗：同一邀请的并行请求只能有一份获得授权。
      tickets.delete(ticket.ticketId);
      const device = { deviceId: request.deviceId, name: String(request.name || 'Computer').slice(0, 128), platform: 'computer' };
      const issued = credentials.issue(instanceId(), device, '', undefined, { deviceKey: request.deviceKey, keyId: request.keyId, permissions: [], remoteWeb: true });
      const binding = { instanceId: instanceId(), name: name(), deviceId: issued.deviceId, credential: issued.credential, keyId: request.keyId, routes: await routes(), createdAt: now(), nonce: request.nonce, connectionInfo: await info() };
      throttle.noteSuccess();
      sendJson(res, 200, { ok: true, v: 1, sealed: c.sealJson(keys.down, binding, pairAad(ticket.ticketId, 'down')) });
    } catch (error) {
      throttle.noteFail();
      sendJson(res, 401, { ok: false, code: error?.code === 'REMOTE_VERSION' ? 'REMOTE_VERSION' : 'REMOTE_AUTH' });
    }
  }

  function accept(ws) {
    const session = { ws, timer: null, stopped: false, handshaking: true };
    sessions.add(session);
    let stage = 'hello';
    let context;
    let initial;
    const finish = () => { clearTimeout(session.timer); sessions.delete(session); session.upstream?.destroy(); };
    ws.on('close', finish);
    ws.on('error', finish);
    session.timer = setTimeout(() => stop(session, 4000), HANDSHAKE_MS);
    session.timer.unref?.();
    const receive = async (data, binary) => {
      try {
        const message = parseHandshake(data, binary);
        if (stage === 'hello') {
          stage = 'auth';
          if (message.type !== 'hello' || message.instanceId !== instanceId() || !KEY_ID.test(message.keyId)) throw c.error('REMOTE_AUTH');
          const record = typeof credentials.lookupRemoteByKeyId === 'function'
            ? credentials.lookupRemoteByKeyId(instanceId(), message.keyId)
            : credentials.findByKeyId(instanceId(), message.keyId);
          if (!record || record.instanceId !== instanceId()) throw c.error('REMOTE_AUTH');
          context = { instanceId: instanceId(), keyId: message.keyId, clientNonce: message.nonce, serverNonce: c.random() };
          initial = c.connectionKeys(record.deviceKey, context);
          Object.assign(session, { keyId: record.keyId, deviceKey: record.deviceKey, deviceId: record.deviceId });
          session.deny = (code) => { if (ws.readyState === 1) ws.send(JSON.stringify({ v: 1, type: 'denied', sealed: c.sealJson(initial.authDown, { ok: false, code }, initial.transcript) })); };
          ws.send(JSON.stringify({ v: 1, type: 'challenge', nonce: context.serverNonce, sealed: c.sealJson(initial.authDown, { instanceId: instanceId(), keyId: session.keyId, clientNonce: context.clientNonce }, initial.transcript) }));
          return;
        }
        if (stage !== 'auth' || message.type !== 'auth') throw c.error('REMOTE_AUTH');
        stage = 'opening';
        const auth = c.openJson(initial.authUp, message.sealed, initial.transcript);
        const record = recordOf(auth.credential, session.keyId, auth.deviceId);
        if (!record || record.deviceKey !== session.deviceKey) {
          const known = typeof credentials.lookup === 'function' ? credentials.lookup(auth.credential, instanceId()) : null;
          const matches = known && known.keyId === session.keyId && known.deviceId === auth.deviceId && known.deviceKey === session.deviceKey;
          if (!matches || typeof known.remoteWeb !== 'boolean') throw c.error('REMOTE_AUTH');
          if (known.expiresAt && known.expiresAt <= now()) throw c.error('REMOTE_EXPIRED');
          throw c.error('REMOTE_REVOKED');
        }
        if (!Number.isFinite(auth.leaseMs) || auth.leaseMs <= 0) throw c.error('REMOTE_EXPIRED');
        const expiresAt = Math.min(now() + Math.min(c.HOUR, auth.leaseMs), record.expiresAt || Infinity);
        if (expiresAt <= now()) throw c.error('REMOTE_EXPIRED');
        Object.assign(session, { credential: auth.credential, expiresAt });
        const keys = c.connectionKeys(session.deviceKey, { ...context, credential: auth.credential });
        let host = { connectionInfo: await info() };
        checkAuthorization();
        if (session.stopped) return;
        if (auth.control) {
          if (!CONTROL_OPS.has(auth.control.op) || typeof onControl !== 'function') throw c.error('REMOTE_CONTROL');
          clearTimeout(session.timer);
          session.timer = setTimeout(() => stop(session, 4000), 20_000);
          session.timer.unref?.();
          try { host.controlResult = await onControl(record, auth.control); }
          catch (err) { throw c.error(['REMOTE_REVOKED', 'REMOTE_EXPIRED'].includes(err.code) ? err.code : 'REMOTE_CONTROL'); }
        } else if (!auth.probe) {
          const token = await getLaunchToken();
          const upstreamPort = Number(await getUpstreamPort());
          const webPort = Number(getWebPort ? await getWebPort() : upstreamPort);
          checkAuthorization();
          if (session.stopped || ws.readyState !== 1) return;
          if (!token || !Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535 || !Number.isInteger(webPort) || webPort < 1 || webPort > 65535) throw c.error('REMOTE_UNAVAILABLE');
          host = { ...host, port: webPort, token };
          await new Promise((resolve, reject) => {
            session.upstream = net.connect({ host: '127.0.0.1', port: upstreamPort, allowHalfOpen: true }, resolve);
            session.upstream.once('error', reject);
          });
        }
        if (session.stopped || ws.readyState !== 1) { session.upstream?.destroy(); return; }
        checkAuthorization();
        if (session.stopped) return;
        clearTimeout(session.timer);
        session.handshaking = false;
        ws.off('message', receive);
        ws.send(JSON.stringify({ v: 1, type: 'ready', sealed: c.sealJson(keys.authDown, { ok: true, instanceId: instanceId(), remainingMs: Math.max(0, expiresAt - now()), host }, keys.transcript) }));
        if (auth.probe || auth.control) { ws.close(); return; }
        stage = 'stream';
        const armExpiry = () => {
          clearTimeout(session.timer);
          session.timer = setTimeout(() => stop(session, 4001), Math.max(1, session.expiresAt - now()));
          session.timer.unref?.();
        };
        const stream = c.secureStream(ws, c.codecs(keys, true), { onRenew(requested) {
          if (session.stopped) throw c.error('REMOTE_EXPIRED');
          const current = recordOf(session.credential, session.keyId, session.deviceId);
          if (!current || current.deviceKey !== session.deviceKey) { stop(session); throw c.error('REMOTE_REVOKED'); }
          if (session.expiresAt <= now() || !Number.isFinite(requested) || requested <= 0) { stop(session, 4001); throw c.error('REMOTE_EXPIRED'); }
          session.expiresAt = Math.min(now() + Math.min(requested, c.HOUR), current.expiresAt || Infinity);
          armExpiry();
          return Math.max(0, session.expiresAt - now());
        } });
        session.stream = stream;
        stream.on('error', () => session.upstream.destroy());
        session.upstream.on('error', () => stream.destroy());
        stream.pipe(session.upstream).pipe(stream);
        armExpiry();
      } catch (err) {
        if (context && initial && ws.readyState === 1) {
          ws.send(JSON.stringify({ v: 1, type: 'denied', sealed: c.sealJson(initial.authDown, { ok: false, code: err.code || 'REMOTE_AUTH' }, initial.transcript) }));
        }
        stop(session, err.code === 'REMOTE_EXPIRED' ? 4001 : ['REMOTE_REVOKED', 'REMOTE_AUTH'].includes(err.code) ? 4003 : 1011);
      }
    };
    ws.on('message', receive);
    // 中转可先完成客户端101；等A入口真正就绪再让客户端提交首次证明。
    ws.send(JSON.stringify({ v: 1, type: 'welcome' }));
  }

  function handleUpgrade(req, socket, head) {
    if (req.method !== 'GET') { socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'); return; }
    // WebSocket 升级加不了自定义头，浏览器这条只能靠 `?instance=` 说自己是哪一台。错链接
    // 在握手之前就挡回去，交给它一个能读懂的状态码，而不是开了隧道再让它认证失败。
    if (instanceHintRefusal(req, instanceId())) { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
    let pending = 0;
    for (const session of sessions) if (session.handshaking && !session.stopped) pending++;
    if (closed || pending >= 32) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, accept);
  }

  return {
    mintInvite, handlePair, handleUpgrade, checkAuthorization,
    revoke(deviceId) { for (const session of sessions) if (session.deviceId === deviceId) stop(session); },
    close() {
      closed = true;
      clearInterval(poll);
      tickets.clear();
      for (const session of sessions) { stop(session, 1011); session.ws.terminate(); }
      wss.close();
    },
  };
}

module.exports = { createRemoteHost, PAIR_PATH, TUNNEL_PATH, INVITE_TTL };

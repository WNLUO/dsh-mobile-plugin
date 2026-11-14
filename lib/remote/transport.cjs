// 远程电脑邀请客户端与经端到端身份验证的加密字节通道。
// 握手超时按「有没有进展」判：升级阶段给一个上限，升级后每收到一条消息就重置沉默窗口，
// 慢网只要还在往前推就一直等，只有彻底没声音的线路才会被判死。
'use strict';

const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');
const c = require('./crypto.cjs');
const { PAIR_PATH, TUNNEL_PATH } = require('./host.cjs');

function parseInvitation(text) {
  let value = text;
  try {
    if (typeof text === 'string') {
      if (text.length > c.MAX_HANDSHAKE * 2) throw new Error();
      const url = new URL(text.trim());
      if (url.protocol !== 'dshcomputer:' || url.hostname !== 'v1' || (url.pathname && url.pathname !== '/')) throw new Error();
      value = JSON.parse(Buffer.from(url.searchParams.get('data') || '', 'base64url').toString('utf8'));
    }
    if (!value || value.type !== 'dsh-computer' || value.version !== 1 || typeof value.instanceId !== 'string' || !value.instanceId || value.instanceId.length > 128 || typeof value.name !== 'string' || typeof value.ticketId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(value.ticketId) || !Number.isFinite(value.expiresAt) || !Array.isArray(value.routes) || value.routes.length < 1 || value.routes.length > 32) throw new Error();
    c.keyBytes(value.ticket);
    const routes = value.routes.map((route) => {
      c.endpoint(route, PAIR_PATH);
      if (typeof route.channel !== 'string' || !route.channel || route.channel.length > 32) throw new Error();
      return { url: route.url, channel: route.channel };
    });
    return { type: value.type, version: 1, instanceId: value.instanceId, name: value.name.slice(0, 128), ticketId: value.ticketId, ticket: value.ticket, expiresAt: value.expiresAt, routes };
  } catch { throw c.error('REMOTE_INVITATION', 'Invalid computer invitation'); }
}

function post(route, path, instanceId, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const bytes = c.json(body);
    const url = c.endpoint(route, path);
    const request = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': bytes.length, 'x-dsh-instance': instanceId } }, (response) => {
      const chunks = [];
      let length = 0;
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > c.MAX_HANDSHAKE * 2) { request.destroy(c.error('REMOTE_AUTH', 'Pair response too large')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) { reject(c.error(response.statusCode === 401 ? 'REMOTE_AUTH' : 'REMOTE_CONNECT', 'Computer pairing was refused')); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(c.error('REMOTE_AUTH', 'Invalid pair response')); }
      });
    });
    const timer = setTimeout(() => request.destroy(c.error('REMOTE_TIMEOUT', 'Computer pairing timed out')), timeoutMs);
    timer.unref?.();
    request.on('close', () => clearTimeout(timer));
    request.on('error', (err) => reject(err.code?.startsWith('REMOTE_') ? err : c.error('REMOTE_CONNECT', 'Computer pairing failed')));
    request.end(bytes);
  });
}

async function pairComputer(textOrObject, options = {}) {
  const invite = parseInvitation(textOrObject);
  const deviceKey = c.random();
  const keyId = crypto.randomBytes(8).toString('hex');
  const deviceId = options.deviceId || crypto.randomUUID();
  const nonce = c.random();
  const keys = c.pairKeys(invite.ticket, invite.instanceId, invite.ticketId);
  const aad = (direction) => JSON.stringify(['dsh-computer-pair-v1', invite.instanceId, invite.ticketId, direction]);
  const request = { v: 1, instanceId: invite.instanceId, ticketId: invite.ticketId, sealed: c.sealJson(keys.up, { deviceId, name: options.name || os.hostname(), deviceKey, keyId, nonce }, aad('up')) };
  let lastError;
  for (const route of options.routes || invite.routes) {
    try {
      const response = await post(route, PAIR_PATH, invite.instanceId, request, options.timeoutMs || 10_000);
      if (response.v !== 1 || !response.ok) throw c.error('REMOTE_AUTH');
      const binding = c.openJson(keys.down, response.sealed, aad('down'));
      if (binding.instanceId !== invite.instanceId || binding.deviceId !== deviceId || binding.keyId !== keyId || binding.nonce !== nonce || typeof binding.credential !== 'string' || !binding.credential || !Array.isArray(binding.routes)) throw c.error('REMOTE_AUTH', 'Unexpected computer identity');
      for (const candidate of binding.routes) c.endpoint(candidate, TUNNEL_PATH, true);
      return { instanceId: binding.instanceId, name: binding.name, deviceId, credential: binding.credential, deviceKey, keyId, routes: binding.routes, createdAt: binding.createdAt, ...(binding.connectionInfo ? { connectionInfo: binding.connectionInfo } : {}) };
    } catch (err) {
      lastError = err.code?.startsWith('REMOTE_') ? err : c.error('REMOTE_AUTH', 'Computer pairing authentication failed');
      if (lastError.code !== 'REMOTE_CONNECT' && lastError.code !== 'REMOTE_TIMEOUT') throw lastError;
    }
  }
  throw lastError || c.error('REMOTE_CONNECT', 'No computer route is available');
}

function openRemoteStream(binding, route, options = {}) {
  return new Promise((resolve, reject) => {
    let ws;
    let initial;
    let keys;
    let stage = 'welcome';
    let settled = false;
    let timer;
    const connectWindow = Math.max(1, Number(options.connectTimeoutMs) || Number(options.timeoutMs) || 10_000);
    const idleWindow = Math.max(1, Number(options.idleTimeoutMs) || connectWindow);
    // 定时器不是「总时限」：升级阶段给 connectWindow，之后每收到一条消息就重置成 idleWindow。
    const arm = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(c.error('REMOTE_TIMEOUT', 'Computer connection timed out')), Math.max(1, Math.round(ms)));
      timer.unref?.();
    };
    const abort = () => fail(c.error('REMOTE_CONNECT', 'Computer connection cancelled'));
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      ws?.terminate();
      reject(err.code?.startsWith('REMOTE_') ? err : c.error('REMOTE_AUTH', 'Computer authentication failed'));
    };
    try {
      if (options.signal?.aborted) { abort(); return; }
      options.signal?.addEventListener('abort', abort, { once: true });
      c.keyBytes(binding.deviceKey);
      if (!binding.credential || !binding.instanceId || !/^[0-9a-f]{16}$/.test(binding.keyId)) throw c.error('REMOTE_AUTH');
      if (options.expiresAt && options.expiresAt <= Date.now()) throw c.error('REMOTE_EXPIRED');
      const context = { instanceId: binding.instanceId, keyId: binding.keyId, clientNonce: c.random() };
      ws = new WebSocket(c.endpoint(route, TUNNEL_PATH, true), { perMessageDeflate: false, maxPayload: c.MAX_MESSAGE, handshakeTimeout: connectWindow, headers: { 'x-dsh-instance': binding.instanceId } });
      arm(connectWindow);
      const receive = (data, binary) => {
        // 收到任何一条协议消息都算「这条线还活着」，把沉默窗口从头计时。
        arm(idleWindow);
        try {
          const message = c.parseMessage(data, binary);
          if (stage === 'welcome' && message.type === 'welcome') {
            stage = 'challenge';
            ws.send(JSON.stringify({ v: 1, type: 'hello', instanceId: binding.instanceId, keyId: binding.keyId, nonce: context.clientNonce }));
            return;
          }
          if (message.type === 'denied' && initial) {
            const denied = c.openJson(initial.authDown, message.sealed, initial.transcript);
            throw c.error(denied.code || 'REMOTE_AUTH', 'Computer access was refused');
          }
          if (stage === 'challenge' && message.type === 'challenge') {
            context.serverNonce = message.nonce;
            initial = c.connectionKeys(binding.deviceKey, context);
            const challenge = c.openJson(initial.authDown, message.sealed, initial.transcript);
            if (challenge.instanceId !== binding.instanceId || challenge.keyId !== binding.keyId || challenge.clientNonce !== context.clientNonce) throw c.error('REMOTE_AUTH', 'Unexpected computer identity');
            keys = c.connectionKeys(binding.deviceKey, { ...context, credential: binding.credential });
            stage = 'ready';
            const leaseMs = Math.min(c.HOUR, (options.expiresAt || Date.now() + c.HOUR) - Date.now());
            if (leaseMs <= 0) throw c.error('REMOTE_EXPIRED');
            ws.send(JSON.stringify({ v: 1, type: 'auth', sealed: c.sealJson(initial.authUp, { credential: binding.credential, deviceId: binding.deviceId, leaseMs, probe: Boolean(options.probe), control: options.control }, initial.transcript) }));
            return;
          }
          if (stage !== 'ready' || message.type !== 'ready') throw c.error('REMOTE_AUTH');
          const ready = c.openJson(keys.authDown, message.sealed, keys.transcript);
          if (!ready.ok || ready.instanceId !== binding.instanceId || !Number.isFinite(ready.remainingMs) || ready.remainingMs <= 0 || ready.remainingMs > c.HOUR || !ready.host) throw c.error('REMOTE_AUTH');
          if (!options.probe && !options.control && (!Number.isInteger(ready.host.port) || ready.host.port < 1 || ready.host.port > 65535 || typeof ready.host.token !== 'string' || !ready.host.token)) throw c.error('REMOTE_AUTH', 'Invalid computer web metadata');
          if (ready.host.connectionInfo && typeof options.onConnectionInfo === 'function') {
            try { Promise.resolve(options.onConnectionInfo(ready.host.connectionInfo)).catch(() => {}); } catch { /* 地址保存失败不使已认证连接失效。 */ }
          }
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
          ws.off('message', receive);
          if (options.probe || options.control) { ws.close(); resolve({ host: ready.host }); return; }
          let expiresAt = Math.min(Date.now() + ready.remainingMs, options.expiresAt || Infinity, Date.now() + c.HOUR);
          let expiry;
          const armExpiry = () => {
            clearTimeout(expiry);
            expiry = setTimeout(() => stream.destroy(c.error('REMOTE_EXPIRED', 'Computer access expired')), Math.max(1, expiresAt - Date.now()));
            expiry.unref?.();
          };
          const stream = c.secureStream(ws, c.codecs(keys, false), { onRenewed(remainingMs, requestedExpiry) {
            if (expiresAt <= Date.now()) throw c.error('REMOTE_EXPIRED');
            expiresAt = Math.min(Date.now() + remainingMs, requestedExpiry, Date.now() + c.HOUR);
            if (expiresAt <= Date.now()) throw c.error('REMOTE_EXPIRED');
            armExpiry();
            return expiresAt;
          } });
          armExpiry();
          stream.once('close', () => clearTimeout(expiry));
          resolve({ stream, host: ready.host });
        } catch (err) { fail(err); }
      };
      ws.on('message', receive);
      // 升级完成即进入「沉默才算死」阶段；此后的握手步骤只要在推进就继续等。
      ws.on('open', () => arm(idleWindow));
      ws.on('error', () => fail(c.error('REMOTE_CONNECT', 'Computer connection failed')));
      ws.on('close', () => fail(c.error('REMOTE_CONNECT', 'Computer connection closed')));
    } catch (err) { fail(err); }
  });
}

async function probeRemote(binding, route, options = {}) {
  const started = performance.now();
  await openRemoteStream(binding, route, { ...options, probe: true });
  return Math.max(0, Math.round(performance.now() - started));
}

async function callRemoteControl(binding, route, control, options = {}) {
  const result = await openRemoteStream(binding, route, { ...options, control });
  return result.host.controlResult;
}

module.exports = { parseInvitation, pairComputer, openRemoteStream, probeRemote, callRemoteControl };

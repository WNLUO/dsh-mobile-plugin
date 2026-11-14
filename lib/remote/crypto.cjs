// 远程电脑专用的邀请、双向挑战与逐连接加密字节流。
'use strict';

const crypto = require('node:crypto');
const { Duplex } = require('node:stream');
const e2ee = require('../shared/e2ee.js');

const VERSION = 1;
const MAX_FRAME = 64 * 1024;
const MAX_MESSAGE = MAX_FRAME + 128;
const MAX_HANDSHAKE = 24 * 1024;
const HOUR = 60 * 60 * 1000;
const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const json = (value) => Buffer.from(JSON.stringify(value));
const error = (code, message = code) => Object.assign(new Error(message), { code });

function keyBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw error('REMOTE_AUTH', 'Invalid device key');
  return Buffer.from(value, 'base64url');
}

function derive(key, salt, info) {
  return Buffer.from(crypto.hkdfSync('sha256', key, Buffer.from(salt), Buffer.from(`dsh-computer-v1|${info}`), 32));
}

function pairKeys(ticket, instanceId, ticketId) {
  const salt = JSON.stringify([instanceId, ticketId]);
  return { up: derive(keyBytes(ticket), salt, 'pair-up'), down: derive(keyBytes(ticket), salt, 'pair-down') };
}

function connectionKeys(deviceKey, context) {
  const transcript = JSON.stringify([context.instanceId, context.keyId, context.clientNonce, context.serverNonce, context.credential || '']);
  keyBytes(context.clientNonce);
  keyBytes(context.serverNonce);
  const key = keyBytes(deviceKey);
  return {
    transcript,
    authUp: derive(key, transcript, 'auth-up'),
    authDown: derive(key, transcript, 'auth-down'),
    up: derive(key, transcript, 'stream-up'),
    down: derive(key, transcript, 'stream-down'),
  };
}

function sealJson(key, value, aad) {
  return e2ee.seal(key, json(value), aad).toString('base64url');
}

function openJson(key, value, aad) {
  if (typeof value !== 'string' || value.length > MAX_HANDSHAKE * 2) throw error('REMOTE_AUTH');
  return JSON.parse(e2ee.open(key, e2ee.unb64url(value), aad).toString('utf8'));
}

function parseMessage(data, binary) {
  if (binary || data.length > MAX_HANDSHAKE) throw error('REMOTE_AUTH', 'Invalid handshake');
  const value = JSON.parse(Buffer.from(data).toString('utf8'));
  if (!value || value.v !== VERSION) throw error('REMOTE_AUTH', 'Unsupported remote protocol');
  return value;
}

function frameCodec(key, transcript, direction) {
  let counter = 0n;
  const aad = (seq) => Buffer.concat([Buffer.from(`${transcript}|${direction}|`), seq]);
  return {
    seal(kind, data = Buffer.alloc(0)) {
      const seq = Buffer.alloc(8);
      seq.writeBigUInt64BE(counter++);
      const nonce = Buffer.concat([Buffer.alloc(4), seq]);
      return Buffer.concat([seq, e2ee.sealWithNonce(key, nonce, Buffer.concat([Buffer.from([kind]), Buffer.from(data)]), aad(seq))]);
    },
    open(data) {
      const bytes = Buffer.from(data);
      if (bytes.length < 37 || bytes.length > MAX_MESSAGE) throw error('REMOTE_AUTH', 'Invalid encrypted frame');
      const seq = bytes.subarray(0, 8);
      if (seq.readBigUInt64BE() !== counter) throw error('REMOTE_AUTH', 'Replayed or reordered frame');
      const nonce = Buffer.concat([Buffer.alloc(4), seq]);
      if (!bytes.subarray(8, 20).equals(nonce)) throw error('REMOTE_AUTH', 'Invalid frame nonce');
      const plain = e2ee.open(key, bytes.subarray(8), aad(seq));
      counter++;
      return { kind: plain[0], data: plain.subarray(1) };
    },
  };
}

function codecs(keys, server) {
  return {
    send: frameCodec(server ? keys.down : keys.up, keys.transcript, server ? 'down' : 'up'),
    receive: frameCodec(server ? keys.up : keys.down, keys.transcript, server ? 'up' : 'down'),
  };
}

function sendFrame(ws, codec, kind, data, callback = () => {}) {
  if (ws.readyState !== 1) { callback(error('REMOTE_CONNECT', 'Remote connection closed')); return; }
  ws.send(codec.seal(kind, data), { binary: true }, callback);
}

/** 一次 write 的回调等 ws 发完才放行；读缓冲满时暂停 WS，保留流式背压。 */
function secureStream(ws, pair, options = {}) {
  let readEnded = false;
  let writeEnded = false;
  let finished = false;
  let renewalId = 0;
  const renewals = new Map();
  const closeIfEnded = () => { if (readEnded && writeEnded) ws.close(); };
  const stream = new Duplex({
    allowHalfOpen: true,
    read() { ws.resume(); },
    write(chunk, _encoding, done) {
      let offset = 0;
      const next = (err) => {
        if (err) { done(err); return; }
        if (offset >= chunk.length) { done(); return; }
        const part = chunk.subarray(offset, offset + MAX_FRAME);
        offset += part.length;
        sendFrame(ws, pair.send, 0, part, next);
      };
      next();
    },
    final(done) {
      sendFrame(ws, pair.send, 1, undefined, (err) => {
        writeEnded = !err;
        done(err);
        closeIfEnded();
      });
    },
    destroy(err, done) {
      finished = true;
      for (const pending of renewals.values()) { clearTimeout(pending.timer); pending.reject(err || error('REMOTE_CONNECT', 'Remote connection closed')); }
      renewals.clear();
      ws.off('message', onMessage);
      if (ws.readyState !== 3) ws.terminate();
      done(err);
    },
  });
  const onMessage = (data, binary) => {
    try {
      if (!binary) throw error('REMOTE_AUTH', 'Expected encrypted bytes');
      const frame = pair.receive.open(data);
      if (frame.kind === 0 && !readEnded) {
        if (!stream.push(frame.data)) ws.pause();
      } else if (frame.kind === 1 && !readEnded && frame.data.length === 0) {
        readEnded = true;
        stream.push(null);
        closeIfEnded();
      } else if (frame.kind === 2 && typeof options.onRenew === 'function') {
        const request = JSON.parse(frame.data.toString());
        const remainingMs = options.onRenew(request.leaseMs);
        sendFrame(ws, pair.send, 3, json({ id: request.id, remainingMs }));
      } else if (frame.kind === 3 && typeof options.onRenewed === 'function') {
        const response = JSON.parse(frame.data.toString());
        const pending = renewals.get(response.id);
        if (!pending || !Number.isFinite(response.remainingMs) || response.remainingMs <= 0 || response.remainingMs > HOUR) throw error('REMOTE_AUTH');
        const expiresAt = options.onRenewed(response.remainingMs, pending.expiresAt);
        clearTimeout(pending.timer);
        renewals.delete(response.id);
        pending.resolve(expiresAt);
      } else if (frame.kind === 4) {
        const failure = JSON.parse(frame.data.toString());
        if (!['REMOTE_REVOKED', 'REMOTE_EXPIRED', 'REMOTE_TIMEOUT', 'REMOTE_CONNECT'].includes(failure.code)) throw error('REMOTE_AUTH');
        throw error(failure.code, 'Computer access ended');
      } else throw error('REMOTE_AUTH', 'Unexpected encrypted frame');
    } catch (err) { stream.destroy(err.code?.startsWith('REMOTE_') ? err : error('REMOTE_AUTH', 'Invalid encrypted bytes')); }
  };
  ws.on('message', onMessage);
  ws.on('error', () => stream.destroy(error('REMOTE_CONNECT', 'Remote connection failed')));
  ws.on('close', () => {
    if (!finished) stream.destroy(readEnded && writeEnded ? undefined : error('REMOTE_CONNECT', 'Remote connection closed'));
  });
  if (options.onRenewed) stream.renew = (expiresAt) => new Promise((resolve, reject) => {
    if (finished || stream.destroyed || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) { reject(error('REMOTE_EXPIRED')); return; }
    const leaseMs = Math.min(HOUR, expiresAt - Date.now());
    const id = ++renewalId;
    const timer = setTimeout(() => { renewals.delete(id); reject(error('REMOTE_TIMEOUT', 'Lease renewal timed out')); }, 10_000);
    timer.unref?.();
    renewals.set(id, { resolve, reject, timer, expiresAt });
    sendFrame(ws, pair.send, 2, json({ id, leaseMs }), (err) => {
      if (!err) return;
      clearTimeout(timer); renewals.delete(id); reject(err);
    });
  });
  stream.endAccess = (code) => sendFrame(ws, pair.send, 4, json({ code }));
  // 关闭可先于调用方接管，错误仍通过 close/destroyed 体现。
  stream.on('error', () => {});
  return stream;
}

function endpoint(route, path, websocket = false) {
  const url = new URL(typeof route === 'string' ? route : route?.url);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw error('REMOTE_CONNECT', 'Invalid remote route');
  }
  url.protocol = websocket ? (['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:') : (['https:', 'wss:'].includes(url.protocol) ? 'https:' : 'http:');
  url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
  return url;
}

module.exports = { VERSION, MAX_FRAME, MAX_MESSAGE, MAX_HANDSHAKE, HOUR, random, json, error, keyBytes, pairKeys, connectionKeys, sealJson, openJson, parseMessage, frameCodec, codecs, sendFrame, secureStream, endpoint };

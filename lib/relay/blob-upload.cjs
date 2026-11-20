// blob 分片逐片等落盘回执，背压保留当前片，关闭时拒绝未决上传。
'use strict';
const { performance } = require('node:perf_hooks');
const { T } = require('./protocol.js');

const CHUNK_BYTES = 48 * 1024;
const ACK_TIMEOUT_MS = 90_000;
const BUFFER_WAIT_MS = 30_000;
const LOW_WATER_BYTES = 8 * 1024 * 1024;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class BlobUpload {
  constructor(tunnel) {
    this.tunnel = tunnel;
    this.capability = null;
    this.active = null;
    this.nextId = 0;
    this.generation = 0;
  }
  configure(value) {
    this.close('blob connection changed');
    this.capability = value && Number.isSafeInteger(value.maxChunkBytes) && value.maxChunkBytes > 0
      && Number.isSafeInteger(value.maxBlobBytes) && value.maxBlobBytes > 0
      ? { maxChunkBytes: Math.min(CHUNK_BYTES, value.maxChunkBytes), maxBlobBytes: value.maxBlobBytes } : null;
  }
  close(reason = 'blob tunnel closed') {
    this.generation += 1;
    this.capability = null;
    this.active?.reject?.(new Error(reason));
    this.active = null;
  }
  onAck(id, value) {
    const active = this.active;
    if (!active || active.id !== id || !active.resolve) return;
    if (!value || value.ok !== true) {
      active.reject(new Error(value?.error || 'blob upload rejected'));
    } else if (value.nextOffset !== active.expected || value.done !== active.final) {
      active.reject(new Error('invalid blob upload acknowledgement'));
    } else active.resolve(value);
  }
  async send(frame) {
    if (this.active) throw new Error('blob upload already in progress');
    if (!this.tunnel.connected) throw new Error('blob tunnel not connected');
    // 凭据刷新与旧节点保持原id0语义；sent仍只表示旧协议入socket，不伪称落盘确认。
    if (!this.capability || frame.cipher === '') {
      if (this.tunnel.trySendJson(T.blobPut, 0, frame) !== 'sent') throw new Error('blob send backpressure or closed');
      return { ok: true, legacy: true };
    }
    if (typeof frame.cipher !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(frame.cipher)) throw new Error('invalid blob cipher');
    const bytes = Buffer.from(frame.cipher, 'base64url');
    const capability = this.capability;
    if (!bytes.length || bytes.length > capability.maxBlobBytes) throw new Error('blob exceeds relay limit');
    this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1;
    const active = { id: this.nextId, resolve: null, reject: null };
    this.active = active;
    const generation = this.generation;
    try {
      for (let offset = 0; offset < bytes.length;) {
        const end = Math.min(bytes.length, offset + capability.maxChunkBytes);
        const final = end === bytes.length;
        const chunk = { offset, total: bytes.length, final, cipher: bytes.subarray(offset, end).toString('base64url') };
        if (offset === 0) Object.assign(chunk, { scope: frame.scope, key: frame.key, creds: frame.creds });
        await this.sendChunk(active, chunk, end, final, generation);
        offset = end;
        // 每片交还事件循环，HTTP/WS泵和控制帧都有发送机会。
        await delay(0);
      }
      return { ok: true, done: true };
    } finally {
      if (this.active === active) this.active = null;
    }
  }
  async sendChunk(active, chunk, expected, final, generation) {
    const deadline = performance.now() + BUFFER_WAIT_MS;
    active.waiting = true;
    while (true) {
      if (generation !== this.generation || !this.tunnel.connected) throw new Error('blob tunnel closed');
      if (performance.now() >= deadline) throw new Error('blob send backpressure timeout');
      if (Number(this.tunnel.ws?.bufferedAmount || 0) > LOW_WATER_BYTES) { await delay(25); continue; }
      // 先挂回执再发，允许同进程测试/快速回执；未发送的片没有丢失或前移offset。
      let timer;
      const ack = new Promise((resolve, reject) => {
        active.expected = expected;
        active.final = final;
        active.resolve = resolve;
        active.reject = reject;
        timer = setTimeout(() => reject(new Error('blob acknowledgement timeout')), ACK_TIMEOUT_MS);
      });
      const result = this.tunnel.trySendJson(T.blobPut, active.id, chunk);
      if (result === 'sent') {
        active.waiting = false;
        try { return await ack; }
        finally { clearTimeout(timer); active.resolve = null; active.reject = null; }
      }
      clearTimeout(timer);
      active.resolve = null;
      active.reject = null;
      if (result !== 'backpressure') throw new Error('blob send failed');
      await delay(25);
    }
  }
}
module.exports = { BlobUpload, CHUNK_BYTES };

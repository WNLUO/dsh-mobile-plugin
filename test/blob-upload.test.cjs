// blob分片必须等最终持久化确认；背压、停止和换代不能续发旧轮或清脏账。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { BlobUpload } = require('../lib/relay/blob-upload.cjs');
const { T } = require('../lib/relay/protocol.js');
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const frameOf = bytes => ({ scope: 'messages', key: 'session', creds: ['1'.repeat(64)], cipher: Buffer.from(bytes).toString('base64url') });

function fixture(send) {
  const frames = [];
  const tunnel = { connected: true, ws: { bufferedAmount: 0 }, trySendJson(type, id, body) {
    frames.push({ type, id, body });
    return send?.(type, id, body) || 'sent';
  } };
  const upload = new BlobUpload(tunnel);
  return { tunnel, upload, frames };
}

test('旧中转或无效能力保留id0整包和空cipher刷新，背压传播为失败', async () => {
  const { upload, frames, tunnel } = fixture();
  await upload.send(frameOf('whole'));
  upload.configure({ maxChunkBytes: 0, maxBlobBytes: 100 });
  await upload.send(frameOf('whole'));
  upload.configure({ maxChunkBytes: 3, maxBlobBytes: 100 });
  await upload.send({ ...frameOf(''), cipher: '' });
  assert.deepEqual(frames.map(frame => frame.id), [0, 0, 0]);
  upload.configure(null);
  tunnel.trySendJson = () => 'backpressure';
  await assert.rejects(upload.send(frameOf('x')), /backpressure|closed/);
});

test('只切解码字节，逐片ack前不发后片，done前不resolve', async () => {
  const { upload, frames } = fixture();
  upload.configure({ maxChunkBytes: 3, maxBlobBytes: 100 });
  let finished = false;
  const promise = upload.send(frameOf('abcdefgh')).then(() => { finished = true; });
  assert.equal(frames.length, 1);
  const id = frames[0].id;
  assert.ok(id > 0);
  assert.equal(frames[0].type, T.blobPut);
  assert.equal(Buffer.from(frames[0].body.cipher, 'base64url').toString(), 'abc');
  upload.onAck(id + 1, { ok: true, nextOffset: 3, done: false });
  await nextTurn();
  assert.equal(frames.length, 1, '其他id回执不推进');
  upload.onAck(id, { ok: true, nextOffset: 3, done: false });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(frames.length, 2);
  assert.equal(frames[1].body.scope, undefined);
  assert.equal(frames[1].body.offset, 3);
  upload.onAck(id, { ok: true, nextOffset: 6, done: false });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(frames.length, 3);
  assert.equal(frames[2].body.final, true);
  assert.equal(finished, false);
  upload.onAck(id, { ok: true, nextOffset: 8, done: true });
  await promise;
  assert.equal(finished, true);
  assert.equal(Buffer.concat(frames.map(frame => Buffer.from(frame.body.cipher, 'base64url'))).toString(), 'abcdefgh');
});

test('错误ack、错误offset和stop拒绝未决，重试用新id', async () => {
  const { upload, frames } = fixture();
  const configure = () => upload.configure({ maxChunkBytes: 3, maxBlobBytes: 100 });
  configure();
  let promise = upload.send(frameOf('abc'));
  upload.onAck(frames.at(-1).id, { ok: false, nextOffset: 0, done: false, error: 'disk full' });
  await assert.rejects(promise, /disk full/);
  const oldId = frames.at(-1).id;
  promise = upload.send(frameOf('abc'));
  assert.notEqual(frames.at(-1).id, oldId);
  upload.onAck(frames.at(-1).id, { ok: true, nextOffset: 2, done: true });
  await assert.rejects(promise, /acknowledgement/);
  promise = upload.send(frameOf('abc'));
  upload.close();
  await assert.rejects(promise, /closed/);
  assert.equal(upload.capability, null);
});

test('发送背压保留同一片，逐片让出事件循环且不超能力大小', async () => {
  let backpressure = true;
  let upload;
  const { upload: actual, frames } = fixture((_type, id, body) => {
    if (backpressure) { backpressure = false; return 'backpressure'; }
    setImmediate(() => upload.onAck(id, { ok: true, nextOffset: body.offset + Buffer.from(body.cipher, 'base64url').length, done: body.final }));
    return 'sent';
  });
  upload = actual;
  upload.configure({ maxChunkBytes: 2, maxBlobBytes: 100 });
  await upload.send(frameOf('abcdef'));
  assert.deepEqual(frames[0].body, frames[1].body, '背压不跳片');
  assert.ok(frames.every(frame => Buffer.from(frame.body.cipher, 'base64url').length <= 2));
});

test('宿主桥等待真实pushBlob结果，失败不返回成功', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/sidecar-facade-worker.cjs'), 'utf8');
  const start = source.indexOf("if (body && typeof body === 'object' && body.kind === 'blob') {");
  const end = source.indexOf("if (body && typeof body === 'object' && body.kind === 'blob-delete')", start);
  const run = new Function('tunnel', 'body', 'send', 'res', `return (async()=>{${source.slice(start, end)}})()`);
  let complete;
  const tunnel = { connected: true, pushBlob: () => new Promise(resolve => { complete = resolve; }) };
  const replies = [];
  const result = run(tunnel, { kind: 'blob', ...frameOf('abc') }, (_res, status, value) => replies.push({ status, value }), {});
  await nextTurn();
  assert.equal(replies.length, 0);
  complete({ ok: true, done: true });
  await result;
  assert.equal(replies[0].status, 200);
  tunnel.pushBlob = async () => { throw new Error('disk full'); };
  await assert.rejects(run(tunnel, { kind: 'blob' }, () => assert.fail('失败不可返回成功'), {}), /disk full/);
});

test('真实pusher上传未确认不挡镜像，失败仍会再推且成功后才判重', async () => {
  const { createMirrorPusher } = require('../lib/mirror/pusher.cjs');
  const previous = process.env.DSH_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-blob-confirm-'));
  process.env.DSH_HOME = home;
  const calls = [];
  const hash = createHash('sha256').update('device').digest('hex');
  const passthrough = overrides => new Proxy(overrides, { get(target, prop) {
    return prop in target ? target[prop] : async () => ({ result: { ok: true, value: {} } });
  } });
  const item = { sessionId: 's', cwd: '/workspace', updatedAt: 42, running: true, blank: false, projections: { values: { title: 's' } } };
  const ctx = { apiProxy: {
    sessions: passthrough({ list: async () => ({ result: { ok: true, value: { items: [item] } } }), history: async () => ({ result: { ok: true, value: { events: [] } } }), projections: async () => ({ result: { ok: true, value: { values: {} } } }) }),
    workspace: passthrough({ list: async () => ({ result: { ok: true, value: { items: [{ workspaceId: 'w', path: '/workspace', title: 'w', sessionIds: [] }], archivedSessionIds: [] } } }) }),
    events: { mux: async function* () { await new Promise(() => {}); } },
  } };
  let fail;
  let count = 0;
  const sidecar = { pushSync: async () => {}, pushBlob: frame => {
    if (!frame.cipher) return Promise.resolve({ ok: true, legacy: true });
    calls.push(frame);
    if (++count === 1) return new Promise((_resolve, reject) => { fail = reject; });
    return Promise.resolve({ ok: true, done: true });
  } };
  try {
    const pusher = createMirrorPusher({ ctx, tunnelConnected: () => true, getSidecar: () => sidecar,
      credentialDigests: () => [{ hash }], getHistoryKey: () => Buffer.alloc(32, 7).toString('base64url') });
    await pusher.pushMirror();
    for (let i = 0; i < 20 && !fail; i++) await nextTurn();
    assert.ok(fail, '真实pusher已发上传');
    assert.equal(calls.length, 1, '未完成上传不能重复创建并发轮次');
    fail(new Error('disk full'));
    await nextTurn();
    await pusher.pushMirror();
    for (let i = 0; i < 20 && calls.length < 2; i++) await nextTurn();
    assert.equal(calls.length, 2, '失败未记指纹，下一轮重推');
    await nextTurn();
    await pusher.pushMirror();
    await nextTurn();
    assert.equal(calls.length, 2, '最终成功后才跳过相同内容');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('pusher独立停止后迟到成功不记指纹且旧轮不发后续blob', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/mirror/pusher.cjs'), 'utf8');
  // 执行生产者的完整blob调度段；只替换宿主快照与sidecar接口，不复制轮次逻辑。
  const start = source.indexOf('  let blobRoundRunning = false;');
  const end = source.indexOf('  // 镜像推送的唯一出口', start);
  const cleanupStart = source.indexOf('    return () => {', source.indexOf('  const start = () => {'));
  const cleanupEnd = source.indexOf('\n  };', cleanupStart);
  const lifecycle = source.slice(cleanupStart, cleanupEnd);
  const calls = [];
  const pending = [];
  const pushed = new Map();
  const deps = {
    sidecar: { pushBlob: frame => { calls.push(frame); return new Promise(resolve => pending.push(resolve)); } },
    pushed,
  };
  const boot = new Function('deps', `
    const { sidecar, pushed } = deps;
    const getHistoryKey = () => 'history-key';
    const getSidecar = () => sidecar;
    const hasFns = (...fns) => fns.every(fn => typeof fn === 'function');
    const digestListOf = value => value;
    const sessionUpdatedAt = () => 42;
    const messagesBlobFingerprint = id => id + ':same';
    const buildMessagesBlobPut = (_hk, id) => ({ scope:'messages', key:id, cipher:'YQ==' });
    const isBlobEligible = () => true;
    const collectFileBlobSources = undefined, statFileSource = undefined, fileBlobFingerprint = undefined;
    const readFileSource = undefined, buildFileBlobPut = undefined, FILE_MAX_PLAIN_BYTES = undefined;
    const MAX_BLOB_MESSAGE_FRAMES_PER_ROUND = 6, MAX_BLOB_FILE_FRAMES_PER_ROUND = 2, MAX_CREDS_ONLY_BATCH = 32;
    const pushedMessageBlobs = pushed, pushedFileBlobs = new Map();
    let blobHistoryKey = null, blobCredsKey = null;
    const blobLogOnce = new Map();
    const noteBlobGaps = () => {}, blobLog = () => {}, blobLogClear = () => {}, errorText = String;
    const deleteRemovedSessionBlobs = async () => {};
    ${source.slice(start, end)}
    return {
      schedule: scheduleHistoryBlobs,
      restart() { const generation = ++blobGeneration; blobStopped = false; return this.cleanup(generation); },
      cleanup(generation) {
        let disposed = false;
        const ac = { abort() {} }, bgTimer = null;
        ${lifecycle}
      },
      idle: () => !blobRoundRunning,
    };
  `)(deps);
  const stop = boot.cleanup(0);
  const payload = { messages: { first: { items: [] }, second: { items: [] } } };
  boot.schedule(payload, ['digest']);
  for (let i = 0; i < 10 && !pending.length; i++) await nextTurn();
  assert.deepEqual(calls.map(frame => frame.key), ['first']);
  stop();
  pending.shift()({ ok: true, done: true });
  for (let i = 0; i < 10 && !boot.idle(); i++) await nextTurn();
  assert.deepEqual(calls.map(frame => frame.key), ['first'], '停止后不续发旧payload第二条');
  assert.equal(pushed.size, 0, '停止后的迟到成功不记指纹');
  const stopAgain = boot.restart();
  boot.schedule(payload, ['digest']);
  for (let i = 0; i < 10 && calls.length < 2; i++) await nextTurn();
  assert.deepEqual(calls.map(frame => frame.key), ['first', 'first'], '重启后首条仍需重推');
  stopAgain();
  pending.shift()({ ok: true, done: true });
  for (let i = 0; i < 10 && !boot.idle(); i++) await nextTurn();
});

// blob 重推用会话定点补推驱动，绕开全量推送 30s 合流门，避免第二发被挡。
// blob确认、桥接和停止代次的行为用例与内存源码变异证明。
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

function fixture(send, Sender = BlobUpload) {
  const frames = [];
  const tunnel = { connected: true, ws: { bufferedAmount: 0 }, trySendJson(type, id, body) {
    frames.push({ type, id, body });
    return send?.(type, id, body) || 'sent';
  } };
  const upload = new Sender(tunnel);
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

function replaceMutation(source, before, after) {
  // 定位失败是测试基础设施错误，不能冒充行为断言成功捕获变异。
  if (source.split(before).length !== 2) throw new Error(`mutation anchor must match once: ${before}`);
  return source.replace(before, after);
}

function memorySender(mutate = source => source) {
  const filename = path.join(__dirname, '../lib/relay/blob-upload.cjs');
  const source = mutate(fs.readFileSync(filename, 'utf8'));
  const module = { exports: {} };
  const localRequire = id => id === './protocol.js' ? { T } : require(id);
  // 只把零延时让出映射到同类事件循环假体；ACK/背压期限仍用真实计时器并在finally清理。
  const schedule = (fn, ms) => ms === 0 ? setImmediate(fn) : setTimeout(fn, ms);
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', source)(
    localRequire, module, module.exports, schedule, clearTimeout,
  );
  return module.exports.BlobUpload;
}

async function bridgeContract(mutate = source => source) {
  const source = fs.readFileSync(path.join(__dirname, '../lib/sidecar-facade-worker.cjs'), 'utf8');
  const start = source.indexOf("if (body && typeof body === 'object' && body.kind === 'blob') {");
  const end = source.indexOf("if (body && typeof body === 'object' && body.kind === 'blob-delete')", start);
  if (start < 0 || end <= start) throw new Error('blob bridge source range missing');
  const run = new Function('tunnel', 'body', 'send', 'res', `return (async()=>{${mutate(source.slice(start, end))}})()`);
  let complete;
  const tunnel = { connected: true, pushBlob: () => new Promise(resolve => { complete = resolve; }) };
  const replies = [];
  const result = run(tunnel, { kind: 'blob', ...frameOf('abc') }, (_res, status, value) => replies.push({ status, value }), {});
  try {
    await nextTurn();
    assert.equal(replies.length, 0, '桥接必须等待持久化结果后才响应成功');
    complete({ ok: true, done: true });
    await result;
    assert.equal(replies[0].status, 200);
    tunnel.pushBlob = async () => { throw new Error('disk full'); };
    await assert.rejects(run(tunnel, { kind: 'blob' }, () => assert.fail('失败不可返回成功'), {}), /disk full/);
  } finally {
    complete?.({ ok: true, done: true });
    await result.catch(() => {});
  }
}

test('宿主桥等待真实pushBlob结果，失败不返回成功', () => bridgeContract());

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
    // 全量 `pushMirror()` 有 30s 最小间隔（防事件风暴），连跑两发第二发会被挡掉；用会话定点的
    // 立即补推来驱动「下一轮」，它不参与那个合流门，才真正会重新走一遍 blob 推送。
    await pusher.pushMirror(['s']);
    for (let i = 0; i < 20 && calls.length < 2; i++) await nextTurn();
    assert.equal(calls.length, 2, '失败未记指纹，下一轮重推');
    await nextTurn();
    await pusher.pushMirror(['s']);
    await nextTurn();
    assert.equal(calls.length, 2, '最终成功后才跳过相同内容');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function blobPusherFixture(sidecar, mutate = source => source) {
  const source = fs.readFileSync(path.join(__dirname, '../lib/mirror/pusher.cjs'), 'utf8');
  const start = source.indexOf('  let blobRoundRunning = false;');
  const end = source.indexOf('  // 镜像推送的唯一出口', start);
  const cleanupStart = source.indexOf('    return () => {', source.indexOf('  const start = () => {'));
  const cleanupEnd = source.indexOf('\n  };', cleanupStart);
  if (start < 0 || end <= start || cleanupStart < 0 || cleanupEnd <= cleanupStart) {
    throw new Error('blob pusher source range missing');
  }
  const pushed = new Map();
  // 调度、发送、确认记账和effect cleanup直接来自生产文件；只替换快照与sidecar接口。
  return new Function('deps', `
    const { sidecar, pushed } = deps;
    const getHistoryKey = () => 'history-key';
    const getSidecar = () => sidecar;
    const hasFns = (...fns) => fns.every(fn => typeof fn === 'function');
    const digestListOf = value => value;
    const sessionUpdatedAt = () => 42;
    const messagesBlobFingerprint = id => id + ':same';
    const buildMessagesBlobPut = (_hk, id) => ({ scope:'messages', key:id, creds:['1'.repeat(64)], cipher:'YWJj' });
    const isBlobEligible = () => true;
    const collectFileBlobSources = undefined, statFileSource = undefined, fileBlobFingerprint = undefined;
    const readFileSource = undefined, buildFileBlobPut = undefined, FILE_MAX_PLAIN_BYTES = undefined;
    const MAX_BLOB_MESSAGE_FRAMES_PER_ROUND = 6, MAX_BLOB_FILE_FRAMES_PER_ROUND = 2, MAX_CREDS_ONLY_BATCH = 32;
    const pushedMessageBlobs = pushed, pushedFileBlobs = new Map();
    let blobHistoryKey = null, blobCredsKey = null;
    const blobLogOnce = new Map();
    const noteBlobGaps = () => {}, blobLog = () => {}, blobLogClear = () => {}, errorText = String;
    const deleteRemovedSessionBlobs = async () => {};
    ${mutate(source.slice(start, end))}
    return {
      pushed,
      schedule: scheduleHistoryBlobs,
      restart() { const generation = ++blobGeneration; blobStopped = false; return this.cleanup(generation); },
      cleanup(generation) {
        let disposed = false;
        const ac = { abort() {} }, bgTimer = null;
        ${source.slice(cleanupStart, cleanupEnd)}
      },
      idle: () => !blobRoundRunning,
    };
  `)({ sidecar, pushed });
}

async function flushBlobRound() {
  for (let i = 0; i < 8; i++) await nextTurn();
}

async function stoppedRoundContract(mutate) {
  const calls = [];
  const pending = [];
  const boot = blobPusherFixture({ pushBlob: frame => {
    calls.push(frame);
    return new Promise(resolve => pending.push(resolve));
  } }, mutate);
  const stop = boot.cleanup(0);
  let stopNew = () => {};
  const payload = { messages: { first: { items: [] }, second: { items: [] } } };
  try {
    boot.schedule(payload, ['digest']);
    await flushBlobRound();
    assert.deepEqual(calls.map(frame => frame.key), ['first']);
    stop();
    // 旧回执跨越stop/start边界，只有代次判据才能拒绝，单一stopped布尔值不够。
    stopNew = boot.restart();
    pending.shift()({ ok: true, done: true });
    await flushBlobRound();
    assert.equal(boot.pushed.size, 0, '停止代次的迟到确认不得记指纹');
    assert.deepEqual(calls.map(frame => frame.key), ['first'], '停止后不续发旧payload第二条');
    boot.schedule(payload, ['digest']);
    await flushBlobRound();
    assert.deepEqual(calls.map(frame => frame.key), ['first', 'first'], '重启后首条仍需重推');
  } finally {
    stopNew();
    stop();
    // 变异可能已发出第二条；释放假体所有未决调用，不把悬挂Promise当变异证据。
    while (pending.length) { pending.shift()({ ok: true, done: true }); await nextTurn(); }
    await flushBlobRound();
  }
}

test('pusher独立停止重开后迟到成功不记指纹且旧轮不发后续blob', () => stoppedRoundContract());

async function senderDirtyContract(kind, mutate) {
  const Sender = memorySender(mutate);
  const { upload, frames } = fixture(undefined, Sender);
  upload.configure({ maxChunkBytes: 3, maxBlobBytes: 100 });
  const boot = blobPusherFixture({ pushBlob: frame => upload.send(frame) });
  const stop = boot.cleanup(0);
  try {
    boot.schedule({ messages: { first: { items: [] } } }, ['digest']);
    await flushBlobRound();
    assert.equal(frames.length, 1, '真实sender应已发出首片');
    const id = frames[0].id;
    assert.equal(frames[0].type, T.blobPut);
    assert.equal(frames[0].body.final, true);
    assert.equal(boot.pushed.size, 0, '等待ACK期间不得记指纹');
    const ack = { ok: true, nextOffset: kind === 'offset' ? 2 : 3, done: kind !== 'done' };
    upload.onAck(kind === 'id' ? id + 1 : id, ack);
    await flushBlobRound();
    assert.equal(boot.pushed.size, 0, '错误或未完成ACK必须保留生产者脏账');
    if (kind === 'id') {
      assert.ok(upload.active, '其他id不能结束当前上传');
      upload.onAck(id, { ok: true, nextOffset: 3, done: true });
      await flushBlobRound();
      assert.equal(boot.pushed.size, 1, '只有当前id最终done才记指纹');
    } else {
      assert.equal(upload.active, null, '错误ACK必须结束失败上传以便下一轮重推');
    }
  } finally {
    stop();
    upload.close('test cleanup');
    await flushBlobRound();
  }
}

for (const kind of ['id', 'offset', 'done']) {
  test(`真实sender到pusher：${kind} ACK边界保持脏账`, () => senderDirtyContract(kind));
}

test('变异：移除ACK id匹配会被生产者保脏断言拒绝', async () => {
  await assert.rejects(senderDirtyContract('id', source => replaceMutation(source,
    '!active || active.id !== id || !active.resolve', '!active || !active.resolve')),
  { code: 'ERR_ASSERTION', message: /错误或未完成ACK必须保留生产者脏账/ });
});

test('变异：移除ACK offset匹配会被生产者保脏断言拒绝', async () => {
  await assert.rejects(senderDirtyContract('offset', source => replaceMutation(source,
    'value.nextOffset !== active.expected || value.done !== active.final', 'value.done !== active.final')),
  { code: 'ERR_ASSERTION', message: /错误或未完成ACK必须保留生产者脏账/ });
});

test('变异：忽略最终done会被生产者保脏断言拒绝', async () => {
  await assert.rejects(senderDirtyContract('done', source => replaceMutation(source,
    'value.nextOffset !== active.expected || value.done !== active.final', 'value.nextOffset !== active.expected')),
  { code: 'ERR_ASSERTION', message: /错误或未完成ACK必须保留生产者脏账/ });
});

test('变异：桥接不等待pushBlob会被提前成功断言拒绝', async () => {
  await assert.rejects(bridgeContract(source => replaceMutation(source,
    'const result = await current.pushBlob({', 'const result = current.pushBlob({')),
  { code: 'ERR_ASSERTION', message: /桥接必须等待持久化结果后才响应成功/ });
});

test('变异：去掉轮次代次检查会被停止后迟到记账断言拒绝', async () => {
  await assert.rejects(stoppedRoundContract(source => replaceMutation(source,
    'const isCurrent = () => !blobStopped && generation === blobGeneration;', 'const isCurrent = () => !blobStopped;')),
  { code: 'ERR_ASSERTION', message: /停止代次的迟到确认不得记指纹/ });
});

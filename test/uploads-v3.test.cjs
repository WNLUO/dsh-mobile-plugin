'use strict';

/**
 * 上传协议的 v3（二进制分片体 + 偏移乱序窗口），见 docs/native-upload.md 的 v3 章。
 *
 * v3 是为了把线上字节从 v2 的约 1.78 倍压回 ≈1.0 倍：分片不再 base64 塞 JSON、整条也不再
 * 套信封 JSON，请求体就是 `AES-256-GCM(这一片的原始字节)` 的裸密文。代价是「一片在哪」
 * 必须由请求头（`X-Dsh-Upload-Id` / `X-Dsh-Upload-Offset`）说清楚，于是收片从「按 index
 * 强序」变成「按字节偏移收 + 乱序窗口」。
 *
 * 每条断言都对着一个真会出事的写法：
 *
 *  1. 老客户端（不带 `caps`）拿到的 begin 回执必须**逐字段与从前相同** —— 多一个 `wire`
 *     就等于把老 App 推进一条它不认识的路径。
 *  2. 只有 `caps.wire === 'bin'` 才进 v3；`wire: 'json'` 显式写出来也还是老路。
 *  3. 二进制片解封后落盘的字节必须与原文件逐字节相等（AEAD 的 nonce/tag 不落盘、AAD 绑
 *     上传身份与偏移）。
 *  4. 乱序两片先到后到，靠窗口拼接出正确的文件；重复偏移幂等、且不会把同一段写两遍。
 *  5. 窗口有封顶（字节数与积压片数），超了 409 让客户端退避重发，而不是吃光内存。
 *  6. 收口时字节不齐必须 400 `incomplete`，且 job 不能被删 —— 客户端补片后还能再收一次口。
 *  7. 同一 job 中途换 wire 一律 400：两种 wire 的 `received` 一个数片、一个数字节。
 *
 * 驱动方式与 `uploads.test.cjs` 一致：真 http 服务 + 真 req/res + 临时收件根；区别是加密
 * 那几条要走真的信封守卫（`createGuarded`），否则验签 / 解封 / 封响应三层一行都测不到。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const routing = require('../lib/http/routing.js');
const e2ee = require('../lib/shared/e2ee.js');
const { readRawBody } = require('../lib/shared/e2ee-request.js');
const {
  handleUploadBegin,
  handleUploadChunk,
  handleUploadFinish,
  handleUploadAbort,
  CHUNK_BYTES,
  CHUNK_MAX_BYTES,
} = require('../lib/mobile/uploads.js');

const API_PREFIX = '/api/mobile/v1';
const DEVICE_KEY = Buffer.alloc(32, 0x22);
const KEY_ID = '0011223344556677';
const keys = e2ee.deriveSessionKeys(DEVICE_KEY);

/** 按 v2 的口径封一条 JSON 请求（与 App 侧 `sealRequest` 同形）。 */
function sealJsonRequest(routePath, plainBody) {
  const ts = Date.now();
  const nonceBytes = crypto.randomBytes(12);
  const nonce = e2ee.b64url(nonceBytes);
  const plain = Buffer.from(JSON.stringify(plainBody), 'utf8');
  const sealed = e2ee.sealWithNonce(keys.up, nonceBytes, plain, e2ee.upAad('POST', routePath));
  const wire = JSON.stringify({ v: 2, c: Buffer.from(sealed).toString('base64') });
  const canonical = e2ee.canonicalString({
    method: 'POST',
    path: routePath,
    query: '',
    ts,
    nonce,
    bodyBytes: Buffer.from(wire, 'utf8'),
  });
  return {
    body: wire,
    headers: {
      'content-type': 'application/json',
      'x-dsh-proto': '2',
      'x-dsh-key-id': KEY_ID,
      'x-dsh-ts': String(ts),
      'x-dsh-nonce': nonce,
      'x-dsh-sig': e2ee.sign(keys.sig, canonical),
    },
    ts,
    nonce,
  };
}

/**
 * 封一条 v3 的二进制分片。
 *
 * AAD 直接写死 `v2|up|POST|<PATH>|<uploadId>|<offset>`（文档口径），**不从被测实现里取**：
 * 两边用同一个拼串函数的话，拼错了测试也会一起错。
 */
function sealBinChunk(routePath, uploadId, offset, piece, options = {}) {
  const ts = Date.now();
  const nonceBytes = crypto.randomBytes(12);
  const nonce = e2ee.b64url(nonceBytes);
  const aad = `v2|up|POST|${options.aadPath || routePath}|${options.aadUploadId || uploadId}|${options.aadOffset ?? offset}`;
  const wire = Buffer.from(e2ee.sealWithNonce(keys.up, nonceBytes, piece, aad));
  const canonical = e2ee.canonicalString({ method: 'POST', path: routePath, query: '', ts, nonce, bodyBytes: wire });
  return {
    body: wire,
    headers: {
      'content-type': 'application/octet-stream',
      'x-dsh-proto': '2',
      'x-dsh-key-id': KEY_ID,
      'x-dsh-ts': String(ts),
      'x-dsh-nonce': nonce,
      'x-dsh-sig': e2ee.sign(keys.sig, canonical),
      'x-dsh-wire': 'bin',
      'x-dsh-upload-id': uploadId,
      'x-dsh-upload-offset': String(offset),
    },
    ts,
    nonce,
  };
}

/** 解开响应的信封；明文响应（401/403/503 与守卫自己回的错误）原样返回。 */
function openResponse(routePath, request, raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!parsed || Number(parsed.v) !== 2 || typeof parsed.c !== 'string') return parsed;
  const sealed = Buffer.concat([Buffer.from(String(parsed.n), 'base64url'), Buffer.from(parsed.c, 'base64')]);
  const plain = e2ee.open(keys.down, sealed, e2ee.downAad('POST', routePath, request.ts, request.nonce));
  return JSON.parse(plain.toString('utf8'));
}

/** 起一个挂着真守卫的真 http 服务；收件根指向临时目录。 */
async function serve(inbox) {
  process.env.DSH_MOBILE_INBOX = inbox;
  const guarded = routing.createGuarded({}, () => true, null, {
    envelope: {
      keyFor: (keyId) => (keyId === KEY_ID ? { deviceKey: DEVICE_KEY.toString('base64url'), deviceId: 'dev-1' } : null),
      readBody: (req) => readRawBody(req),
    },
  });
  const routes = {
    [`${API_PREFIX}/upload/begin`]: guarded(handleUploadBegin),
    [`${API_PREFIX}/upload/chunk`]: guarded(handleUploadChunk),
    [`${API_PREFIX}/upload/finish`]: guarded(handleUploadFinish),
    [`${API_PREFIX}/upload/abort`]: guarded(handleUploadAbort),
  };
  const server = http.createServer((req, res) => {
    const routePath = String(req.url || '').split('?')[0];
    const handler = routes[routePath];
    if (!handler) {
      res.writeHead(404).end('{}');
      return;
    }
    handler(req, res).catch((error) => {
      res.writeHead(500).end(JSON.stringify({ ok: false, error: { code: 'internal', message: String(error && error.message) } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // 调用方给的是 `/upload/begin` 这种短名；线上路径与签名口径都要带 API 前缀。
  const send = async (routePath, built) => {
    const wirePath = API_PREFIX + routePath;
    const response = await fetch(base + wirePath, { method: 'POST', headers: built.headers, body: built.body });
    const raw = await response.text();
    return { status: response.status, body: openResponse(wirePath, built, raw), raw };
  };

  return {
    // 老客户端：明文 JSON，一个信封头都不带。
    postPlain: async (routePath, body) => {
      const response = await fetch(base + API_PREFIX + routePath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    post: async (routePath, body) => send(routePath, sealJsonRequest(API_PREFIX + routePath, body)),
    postBin: async (routePath, uploadId, offset, piece, options) =>
      send(routePath, sealBinChunk(API_PREFIX + routePath, uploadId, offset, piece, options)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function tempInbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-upload-v3-'));
}

/** 一小段可复现的伪随机字节：逐字节对账时不能用全零，否则「写错位置」也照样相等。 */
function bytesOf(size, seed) {
  const out = Buffer.alloc(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i += 1) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

/** 一次完整的 v3 上传，返回 begin / finish 的响应。 */
async function uploadBin(api, name, payload, pieceSize, caps = { wire: 'bin' }) {
  const begin = await api.post('/upload/begin', { name, size: payload.length, caps });
  if (begin.status !== 200) return { begin, finish: null };
  for (let offset = 0; offset < payload.length; offset += pieceSize) {
    const piece = payload.subarray(offset, Math.min(offset + pieceSize, payload.length));
    const chunk = await api.postBin('/upload/chunk', begin.body.uploadId, offset, piece);
    assert.equal(chunk.status, 200, `分片 ${offset} 必须被接受（实际 ${JSON.stringify(chunk.body)}）`);
  }
  return { begin, finish: await api.post('/upload/finish', { uploadId: begin.body.uploadId }) };
}

test('caps 协商：wire=bin 才进 v3，回 4MB/6MB 片长与窗口', async () => {
  const inbox = tempInbox();
  const api = await serve(inbox);
  try {
    const begin = await api.post('/upload/begin', { name: 'a.bin', size: 100, caps: { wire: 'bin', offset: true, pipeline: 4 } });
    assert.equal(begin.status, 200);
    assert.equal(begin.body.ok, true);
    assert.equal(begin.body.wire, 'bin');
    assert.equal(begin.body.chunkSize, 4 * 1024 * 1024);
    assert.equal(begin.body.maxChunkSize, 6 * 1024 * 1024);
    assert.equal(begin.body.pipeline, 4);
    // 窗口 = 片数 × 片长：文档给的那个数（25165824）就是 4 × 6MB。
    assert.equal(begin.body.windowBytes, 4 * 6 * 1024 * 1024);

    // 客户端要 2 条流水线：窗口跟着收窄，别按缺省值硬塞。
    const narrowed = await api.post('/upload/begin', { name: 'b.bin', size: 10, caps: { wire: 'bin', pipeline: 2 } });
    assert.equal(narrowed.body.pipeline, 2);
    assert.equal(narrowed.body.windowBytes, 2 * 6 * 1024 * 1024);
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_INBOX;
  }
});

test('不带 caps / caps.wire 不是 bin：begin 回执与 v2 逐字段相同', async () => {
  const inbox = tempInbox();
  const api = await serve(inbox);
  try {
    const legacy = await api.post('/upload/begin', { name: 'old.txt' });
    assert.equal(legacy.status, 200);
    assert.deepEqual(Object.keys(legacy.body).sort(), ['chunkSize', 'maxChunkSize', 'ok', 'uploadId']);
    assert.equal(legacy.body.chunkSize, CHUNK_BYTES);
    assert.equal(legacy.body.maxChunkSize, CHUNK_MAX_BYTES);

    // 显式说 `wire: 'json'` 也是老路：协商结果不是 bin 就不该碰 v3 的任何一格。
    const explicit = await api.post('/upload/begin', { name: 'old2.txt', size: 10, caps: { wire: 'json' } });
    assert.deepEqual(Object.keys(explicit.body).sort(), ['chunkSize', 'maxChunkSize', 'ok', 'uploadId']);
    assert.equal(explicit.body.chunkSize, CHUNK_BYTES);

    // 不吃 size 也就不该因为缺 size 报错：老客户端从来没有这个字段。
    const noSize = await api.post('/upload/begin', { name: 'old3.txt', caps: { wire: 'bin' } });
    assert.equal(noSize.status, 400);
    assert.equal(noSize.body.error.code, 'bad-request');
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_INBOX;
  }
});

test('二进制分片：解封后落盘与原文件逐字节相等', async () => {
  const inbox = tempInbox();
  const api = await serve(inbox);
  try {
    const payload = bytesOf(300 * 1024, 7);
    const { begin, finish } = await uploadBin(api, 'report.bin', payload, 64 * 1024);
    assert.equal(begin.body.wire, 'bin');
    assert.equal(finish.status, 200);
    assert.equal(finish.body.ok, true);
    assert.equal(finish.body.bytes, payload.length);
    assert.deepEqual(fs.readFileSync(finish.body.path), payload);
    // 线上是裸密文，落盘的必须只有明文（nonce / tag 不能跟着写进去）。
    assert.equal(fs.statSync(finish.body.path).size, payload.length);
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_INBOX;
  }
});

test('乱序窗口：后一片先到先攒着，前面补齐后一起落盘', async () => {
  const inbox = tempInbox();
  const api = await serve(inbox);
  try {
    const payload = bytesOf(9 * 1024, 11);
    const first = payload.subarray(0, 3 * 1024);
    const second = payload.subarray(3 * 1024, 6 * 1024);
    const third = payload.subarray(6 * 1024);
    const begin = await api.post('/upload/begin', { name: 'out.bin', size: payload.length, caps: { wire: 'bin' } });
    const uploadId = begin.body.uploadId;

    // 第 2、3 片先到：还没有连续字节，回 200 但 received 仍是 0。
    const late3 = await api.postBin('/upload/chunk', uploadId, 6 * 1024, third);
    assert.equal(late3.status, 200);
    assert.equal(late3.body.received, 0);
    const late2 = await api.postBin('/upload/chunk', uploadId, 3 * 1024, second);
    assert.equal(late2.body.received, 0);

    // 第 1 片到：三片连着，一次全落盘。
    const head = await api.postBin('/upload/chunk', uploadId, 0, first);
    assert.equal(head.status, 200);
    assert.equal(head.body.received, payload.length);

    const finish = await api.post('/upload/finish', { uploadId });
    assert.equal(finish.status, 200);
    assert.deepEqual(fs.readFileSync(finish.body.path), payload);
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_INBOX;
  }
});

test('重复偏移幂等：整片已收过回 200 且不重复追加；跨过已收边界 400 bad-offset', async () => {
  const inbox = tempInbox();
  const api = await serve(inbox);
  try {
    const payload = bytesOf(2048, 13);
    const begin = await api.post('/upload/begin', { name: 'dup.bin', size: payload.length, caps: { wire: 'bin' } });
    const uploadId = begin.body.uploadId;
    const head = payload.subarray(0, 1024);
    const tail = payload.subarray(1024);

    assert.equal((await api.postBin('/upload/chunk', uploadId, 0, head)).body.received, 1024);
    // 重发同一片：进度不变。
    const retry = await api.postBin('/upload/chunk', uploadId, 0, head);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.received, 1024);

    // 跨过已收边界（offset 512 + 1024 字节 > 1024）必须是 400：那说明客户端切片边界变了，
    // 硬接上去会写坏文件。
    const overlap = await api.postBin('/upload/chunk', uploadId, 512, payload.subarray(512, 1536));
    assert.equal(overlap.status, 400);
    assert.equal(overlap.body.error.code, 'bad-offset');

    assert.equal((await api.postBin('/upload/chunk', uploadId, 1024, tail)).body.received, payload.length);
    const finish = await api.post('/upload/finish', { uploadId });
    assert.deepEqual(fs.readFileSync(finish.body.path), payload);
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_INBOX;
  }
});

test('窗口封顶：积压片数超限与字节数超限都回 409 window-exceeded', async () => {
  const inbox = tempInbox();
  const api = await serve(inbox);
  try {
    // pipeline=1 → 积压片数上限 max(4, 2) = 4。
    const payload = bytesOf(64 * 1024, 17);
    const begin = await api.post('/upload/begin', {
      name: 'win.bin',
      size: 32 * 1024 * 1024,
      caps: { wire: 'bin', pipeline: 1 },
    });
    const uploadId = begin.body.uploadId;
    assert.equal(begin.body.windowBytes, 6 * 1024 * 1024);

    for (let i = 0; i < 4; i += 1) {
      const at = (i + 1) * 4096;
      const piece = payload.subarray(0, 1024);
      const ok = await api.postBin('/upload/chunk', uploadId, at, piece);
      assert.equal(ok.status, 200, `第 ${i} 片进窗口（实际 ${JSON.stringify(ok.body)}）`);
      assert.equal(ok.body.received, 0);
    }
    // 第 5 片：片数超了。
    const tooMany = await api.postBin('/upload/chunk', uploadId, 5 * 4096, payload.subarray(0, 1024));
    assert.equal(tooMany.status, 409);
    assert.equal(tooMany.body.error.code, 'window-exceeded');

    // 字节数上限：换一个 job，两片 4MB 就把 6MB 的窗口撑破。
    const big = await api.post('/upload/begin', {
      name: 'win2.bin',
      size: 32 * 1024 * 1024,
      caps: { wire: 'bin', pipeline: 1 },
    });
    const bigPiece = bytesOf(4 * 1024 * 1024, 19);
    assert.equal((await api.postBin('/upload/chunk', big.body.uploadId, 8 * 1024 * 1024, bigPiece)).status, 200);
    const overBytes = await api.postBin('/upload/chunk', big.body.uploadId, 12 * 1024 * 1024, bigPiece);
    assert.equal(overBytes.status, 409);
    assert.equal(overBytes.body.error.code, 'window-exceeded');

    // 被拒的那片没落盘：这个 job 一个字节都没收上来。
    const finish = await api.post('/upload/finish', { uploadId: big.body.uploadId });
    assert.equal(finish.status, 400);
    assert.equal(finish.body.error.code, 'incomplete');
    assert.equal(finish.body.error.received, 0);
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_INBOX;
  }
});

test('收口缺字节：400 incomplete 带 received，补片后还能再收一次口', async () => {
  const inbox = tempInbox();
  const api = await serve(inbox);
  try {
    const payload = bytesOf(3000, 23);
    const begin = await api.post('/upload/begin', { name: 'half.bin', size: payload.length, caps: { wire: 'bin' } });
    const uploadId = begin.body.uploadId;
    await api.postBin('/upload/chunk', uploadId, 0, payload.subarray(0, 1000));

    const early = await api.post('/upload/finish', { uploadId });
    assert.equal(early.status, 400);
    assert.equal(early.body.error.code, 'incomplete');
    assert.equal(early.body.error.received, 1000);

    // job 没被删：补上剩下的字节，再收一次口就该成功。
    await api.postBin('/upload/chunk', uploadId, 1000, payload.subarray(1000));
    const finish = await api.post('/upload/finish', { uploadId });
    assert.equal(finish.status, 200);
    assert.deepEqual(fs.readFileSync(finish.body.path), payload);

    // 落盘之后再收一次是回放：两条 wire 都保留这条语义（这里覆盖 bin）。
    const replay = await api.post('/upload/finish', { uploadId });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.path, finish.body.path);
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_INBOX;
  }
});

test('中途换 wire：bin job 收 JSON 分片、json job 收二进制分片都 400', async () => {
  const inbox = tempInbox();
  const api = await serve(inbox);
  try {
    const bin = await api.post('/upload/begin', { name: 'a.bin', size: 8, caps: { wire: 'bin' } });
    const jsonIntoBin = await api.post('/upload/chunk', {
      uploadId: bin.body.uploadId,
      index: 0,
      data: Buffer.from('xxxxxxxx').toString('base64'),
    });
    assert.equal(jsonIntoBin.status, 400);
    assert.equal(jsonIntoBin.body.error.code, 'wire-mismatch');

    const json = await api.post('/upload/begin', { name: 'b.txt' });
    const binIntoJson = await api.postBin('/upload/chunk', json.body.uploadId, 0, Buffer.from('xxxxxxxx'));
    assert.equal(binIntoJson.status, 400);
    assert.equal(binIntoJson.body.error.code, 'wire-mismatch');

    // 老路本身没被影响：json job 照旧按 index 收片、收口。
    const chunk = await api.post('/upload/chunk', {
      uploadId: json.body.uploadId,
      index: 0,
      data: Buffer.from('hello').toString('base64'),
    });
    assert.equal(chunk.status, 200);
    assert.equal(chunk.body.received, 1);
    const finish = await api.post('/upload/finish', { uploadId: json.body.uploadId });
    assert.equal(finish.status, 200);
    assert.equal(fs.readFileSync(finish.body.path, 'utf8'), 'hello');
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_INBOX;
  }
});

test('AAD 绑上传与偏移：把一片改挂到别的偏移上解不开', async () => {
  const inbox = tempInbox();
  const api = await serve(inbox);
  try {
    const payload = bytesOf(1024, 29);
    const begin = await api.post('/upload/begin', { name: 'aad.bin', size: payload.length, caps: { wire: 'bin' } });
    const uploadId = begin.body.uploadId;
    // 头里说 offset=0，AAD 却按 offset=1024 封：AEAD 必须不认。
    const moved = await api.postBin('/upload/chunk', uploadId, 0, payload.subarray(0, 512), { aadOffset: 1024 });
    assert.equal(moved.status, 400);
    assert.equal(moved.body.error.code, 'e2ee-decrypt-failed');

    // 换个上传 id 封的片同样不认。
    const misbound = await api.postBin('/upload/chunk', uploadId, 0, payload.subarray(0, 512), { aadUploadId: 'another-upload' });
    assert.equal(misbound.status, 400);
    assert.equal(misbound.body.error.code, 'e2ee-decrypt-failed');
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_INBOX;
  }
});

test('老客户端走明文（不带信封头）时，v2 分片与收口一字不变', async () => {
  const inbox = tempInbox();
  const api = await serve(inbox);
  try {
    const begin = await api.postPlain('/upload/begin', { name: 'plain.txt' });
    assert.deepEqual(Object.keys(begin.body).sort(), ['chunkSize', 'maxChunkSize', 'ok', 'uploadId']);
    const uploadId = begin.body.uploadId;
    const first = await api.postPlain('/upload/chunk', { uploadId, index: 0, data: Buffer.from('AAA').toString('base64') });
    assert.equal(first.status, 200);
    assert.equal(first.body.received, 1);
    // 跳号仍是 409 out-of-order：老路径的语义一个字都没动。
    const skipped = await api.postPlain('/upload/chunk', { uploadId, index: 2, data: Buffer.from('CCC').toString('base64') });
    assert.equal(skipped.status, 409);
    assert.equal(skipped.body.error.code, 'out-of-order');
    const second = await api.postPlain('/upload/chunk', { uploadId, index: 1, data: Buffer.from('BBB').toString('base64') });
    assert.equal(second.body.received, 2);
    const finish = await api.postPlain('/upload/finish', { uploadId });
    assert.equal(finish.status, 200);
    assert.equal(fs.readFileSync(finish.body.path, 'utf8'), 'AAABBB');
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_INBOX;
  }
});

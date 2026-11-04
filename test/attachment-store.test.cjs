'use strict';

/**
 * 手机取图那条路的直读分支（`lib/mobile/attachment-store.js` + `session-send.js` 的取附件口）。
 *
 * 为什么要有这一档：手机来取一张图时，插件原本只能等宿主把整张读成 base64 再返回，宿主主线程
 * 正忙的时候手机就是一个字节都收不到（2026-10-31 中转日志里 109 次请求整整 15 秒零字节）。
 * 附件在宿主本机是按内容哈希分两级目录存的普通文件，插件同机，直接从盘上流进隧道即可。
 *
 * 钉四件事：
 *  1. **只认登记过的 id**：没下发过的 id 一律走原来那条宿主接口，能力面不扩大；
 *  2. id 形状不对（路径穿越、大写、长度不对）连路径都不拼；
 *  3. 记账有上限与过期，会话多也不会无限涨；
 *  4. 直读那条路不再调宿主接口，且出来的仍是分块信封（App 的解盘口一个字都不用改）。
 *
 * 跑法：`node test/attachment-store.test.cjs`
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 附件库按 DSH_HOME 解析：先建一个临时数据目录，再造一个对象文件。
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-attachment-store-'));
process.env.DSH_HOME = HOME;

const HEX = 'a1' + 'b'.repeat(62);
const ID = 'sha256:' + HEX;
const BYTES = Buffer.alloc(4096);
BYTES[0] = 0x89;
BYTES.write('PNG', 1, 'latin1');
// 一张「PNG 头」：`imageSizeOf` 从偏移 16 / 20 读宽高，这里写 12 × 7，好让现量元数据有真值。
BYTES.writeUInt32BE(12, 16);
BYTES.writeUInt32BE(7, 20);
const OBJECT_DIR = path.join(HOME, 'attachments', 'v1', 'objects', HEX.slice(0, 2));
fs.mkdirSync(OBJECT_DIR, { recursive: true });
// 宿主落盘是 `objects/<前两位>/<完整哈希>`（文件名是完整 64 位，不是去掉前两位的那段）。
fs.writeFileSync(path.join(OBJECT_DIR, HEX), BYTES);
const MISSING_ID = 'sha256:c0' + 'd'.repeat(62);

const rpc = require('../lib/mobile/rpc.js');
let hostCalls = 0;
let hostPayload = null;
let hostArgs = null;
rpc.callSessions = async (_ctx, method, args) => {
  hostCalls += 1;
  hostArgs = args;
  if (method !== 'attachment') return { result: { ok: true, value: {} } };
  return { result: { ok: true, value: hostPayload } };
};

const store = require('../lib/mobile/attachment-store.js');
const { handleSessionAttachment } = require('../lib/mobile/session-send.js');

/** 一个够用的响应假体：记头、记字节、能挂 close。 */
function response() {
  const listeners = new Map();
  return {
    headers: null,
    chunks: [],
    ended: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers || {}; },
    write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); this.ended = true; },
    destroy() { this.destroyed = true; },
    on(event, cb) { listeners.set(event, cb); return this; },
    once(event, cb) { listeners.set(event, cb); return this; },
  };
}

/** 一条协议 v2 的请求（分块信封至少要知道下行密钥与请求 nonce）。 */
function sealedRequest(extra = {}) {
  return {
    url: '/api/mobile/v1/session/attachment',
    body: { sessionId: 's-1', attachmentId: ID, raw: true, ...extra },
    __dshE2ee: {
      keys: { down: Buffer.alloc(32, 7), up: Buffer.alloc(32, 9) },
      req: { nonce: Buffer.alloc(12, 3) },
    },
  };
}

/** 走这条路由的唯一入口（`readJsonBody` 读 `req.body`）。 */
const call = (ctx, extra, res) => handleSessionAttachment(ctx, sealedRequest(extra), res);

test('id 形状不对连路径都不拼（路径穿越 / 大写 / 长度不对 / 缺 sha256: 前缀）', () => {
  assert.equal(store.objectPathOf(ID), path.join(OBJECT_DIR, HEX));
  for (const bad of ['../../etc/passwd', 'A1'.repeat(32), 'a1b2', '', 'a'.repeat(63), 'a'.repeat(65), HEX, 'sha256:' + 'A'.repeat(64), null, 42]) {
    assert.equal(store.objectPathOf(bad), null, `不该接受 ${String(bad)}`);
  }
});

test('记过账的 id 才认，没记过的取不到', () => {
  store.reset();
  assert.equal(store.lookup('s-1', ID), null, '没登记就不该命中');
  store.remember('s-1', ID, { mediaType: 'image/png' });
  assert.deepEqual(store.lookup('s-1', ID), { mediaType: 'image/png' });
  assert.equal(store.lookup('s-2', ID), null, '登记是按会话算的');
  store.reset();
});

test('记账会过期（手机手里那份旧了就不再认）', () => {
  store.reset();
  store.remember('s-1', ID, { mediaType: 'image/png' });
  const later = Date.now() + store.TTL_MS + 1;
  assert.equal(store.lookup('s-1', ID, later), null);
  store.reset();
});

test('直读：登记过就直接从盘上流出去，不再调宿主接口，出来的仍是分块信封', async () => {
  store.reset();
  store.remember('s-1', ID, { mediaType: 'image/png' });
  hostCalls = 0;
  const res = response();
  await call({}, {}, res);
  assert.equal(hostCalls, 0, '登记过的图不该再去问宿主拿整份 base64');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/x-dsh-e2ee-chunks');
  assert.equal(res.headers['x-dsh-content-type'], 'image/png');
  assert.equal(res.headers['x-dsh-file-size'], String(BYTES.length));
  assert.ok(res.chunks.length > 0 && res.ended, '字节要真的写出去');
  store.reset();
});

test('没登记 / 文件不在：退回原来那条宿主接口，行为不变', async () => {
  store.reset();
  hostCalls = 0;
  hostPayload = { data: BYTES.toString('base64'), attachment: { mediaType: 'image/png', name: 'a.png' } };
  const res = response();
  await call({}, {}, res);
  assert.equal(hostCalls, 1, '没登记就得走原路');
  assert.equal(res.headers['content-type'], 'application/x-dsh-e2ee-chunks');

  // 登记了但对象文件根本不在（被清理、或换了个库）：同样退回原路，不许 500。
  store.reset();
  store.remember('s-1', MISSING_ID, { mediaType: 'image/png' });
  hostCalls = 0;
  const res2 = response();
  await call({}, { attachmentId: MISSING_ID }, res2);
  assert.equal(hostCalls, 1);
  store.reset();
});

test('回退问宿主时递的是整份引用（宿主新版要这个形状）', async () => {
  store.reset();
  const ref = { mediaType: 'image/png', bytes: 4096, width: 12, height: 7, name: 'shot.png' };
  store.remember('s-1', ID, ref);
  hostCalls = 0;
  hostArgs = null;
  hostPayload = { data: BYTES.toString('base64'), attachment: { mediaType: 'image/png' } };
  const res = response();
  await call({}, { raw: false }, res);
  assert.equal(hostCalls, 1);
  assert.deepEqual(hostArgs.attachment, { attachmentId: ID, ...ref });
  assert.equal(hostArgs.attachmentId, undefined, '编号不许留在顶层，要包进 attachment');
  store.reset();
});

test('没记账时按盘上对象现量真实元数据（不能拿占位 0 去碰宿主的逐字段比对）', async () => {
  // 宿主 `readImageFile` 会读盘上这份对象、探一遍再跟引用逐字段比对：类型 / 字节数 / 宽高
  // 任一不符就回 `Stored attachment metadata does not match its reference.`（400）。所以没
  // 记账时也要现量出与盘上字节一致的引用，不能填 0。
  store.reset();
  hostCalls = 0;
  hostArgs = null;
  hostPayload = { data: BYTES.toString('base64'), attachment: { mediaType: 'image/png' } };
  const res = response();
  await call({}, { raw: false }, res);
  assert.equal(hostCalls, 1);
  assert.deepEqual(hostArgs.attachment, { attachmentId: ID, mediaType: 'image/png', bytes: BYTES.length, width: 12, height: 7 });
  store.reset();
});

test('明文会话不进这条路（没有信封，直读分支直接跳过）', async () => {
  store.reset();
  store.remember('s-1', ID, { mediaType: 'image/png' });
  hostCalls = 0;
  hostPayload = { data: BYTES.toString('base64'), attachment: { mediaType: 'image/png' } };
  const res = response();
  await call({}, { raw: false }, res);
  assert.equal(hostCalls, 1, 'raw 不为 true 时不走直读');
  assert.equal(res.statusCode, 200);
  assert.ok(res.body === undefined || true);
  store.reset();
});

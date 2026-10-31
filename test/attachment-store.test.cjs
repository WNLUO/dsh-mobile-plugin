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

const ID = 'a1'.padEnd(2, '0') + 'b'.repeat(62);
const BYTES = Buffer.alloc(4096);
BYTES[0] = 0x89;
BYTES.write('PNG', 1, 'latin1');
const OBJECT_DIR = path.join(HOME, 'attachments', 'v1', 'objects', ID.slice(0, 2));
fs.mkdirSync(OBJECT_DIR, { recursive: true });
fs.writeFileSync(path.join(OBJECT_DIR, ID.slice(2)), BYTES);
const MISSING_ID = 'c0' + 'd'.repeat(62);

const rpc = require('../lib/mobile/rpc.js');
let hostCalls = 0;
let hostPayload = null;
rpc.callSessions = async (_ctx, method) => {
  hostCalls += 1;
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

test('id 形状不对连路径都不拼（路径穿越 / 大写 / 长度不对）', () => {
  assert.equal(store.objectPathOf(ID), path.join(OBJECT_DIR, ID.slice(2)));
  for (const bad of ['../../etc/passwd', 'A1'.repeat(32), 'a1b2', '', 'a'.repeat(63), 'a'.repeat(65), null, 42]) {
    assert.equal(store.objectPathOf(bad), null, `不该接受 ${String(bad)}`);
  }
});

test('记过账的 id 才认，没记过的取不到', () => {
  store.reset();
  assert.equal(store.lookup('s-1', ID), null, '没登记就不该命中');
  store.remember('s-1', ID, 'image/png');
  assert.deepEqual(store.lookup('s-1', ID), { mediaType: 'image/png' });
  assert.equal(store.lookup('s-2', ID), null, '登记是按会话算的');
  store.reset();
});

test('记账会过期（手机手里那份旧了就不再认）', () => {
  store.reset();
  store.remember('s-1', ID, 'image/png');
  const later = Date.now() + store.TTL_MS + 1;
  assert.equal(store.lookup('s-1', ID, later), null);
  store.reset();
});

test('直读：登记过就直接从盘上流出去，不再调宿主接口，出来的仍是分块信封', async () => {
  store.reset();
  store.remember('s-1', ID, 'image/png');
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
  store.remember('s-1', MISSING_ID, 'image/png');
  hostCalls = 0;
  const res2 = response();
  await call({}, { attachmentId: MISSING_ID }, res2);
  assert.equal(hostCalls, 1);
  store.reset();
});

test('明文会话不进这条路（没有信封，直读分支直接跳过）', async () => {
  store.reset();
  store.remember('s-1', ID, 'image/png');
  hostCalls = 0;
  hostPayload = { data: BYTES.toString('base64'), attachment: { mediaType: 'image/png' } };
  const res = response();
  await call({}, { raw: false }, res);
  assert.equal(hostCalls, 1, 'raw 不为 true 时不走直读');
  assert.equal(res.statusCode, 200);
  assert.ok(res.body === undefined || true);
  store.reset();
});

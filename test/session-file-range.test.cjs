'use strict';

/**
 * 按块偏移取文件（`docs/streaming-media.md` §1）的契约。
 *
 * 边下边播靠这一条：客户端按段取字节，宿主从 `offset` 处开始读。这里能错的地方都很安静 ——
 * 解不开 / 块序号接不上只会表现成「播放页一直转」，所以逐条钉住：
 *
 *  1. `offset` 必须是非负的 `CHUNK` 整数倍，否则 400 `bad-offset`；`offset > size` 越界
 *     （加密档 400、明文档 416，体是同一份 `bad-range`）。
 *  2. `offset === size` 合法：回一个空的尾块，客户端据此确认「到这里就是头」。
 *  3. **加密档**：从 `offset` 起读时第 n 块的 AAD 序号是 `offset / CHUNK + n`，不是 1。
 *     这一条断了，手机上拿到的那一段就解不开；而按 1 起数还能解出**错位**的字节，更隐蔽。
 *  4. **明文档**：206 + `content-range` + 长度，字节与整份取回的同一段逐字节相同。
 *  5. 两条路由（`/session/file`、`/file/read`）走同一份响应实现：同一个 offset 取回的字节
 *     必须逐字节相同。
 *
 * 起真 http 服务、真读临时目录，只有宿主那一侧是假对象。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { handleSessionFile, encryptedLengthOf } = require('../lib/mobile/session-file.js');
const { handleFileRead } = require('../lib/mobile/file-read.js');
const { FILE_CHUNK_BYTES } = require('../lib/shared/e2ee-chunks.js');
const e2ee = require('../lib/shared/e2ee.js');

const SESSION_FILE = '/api/mobile/v1/session/file';
const FILE_READ = '/api/mobile/v1/file/read';

/** 一条会话的上下行密钥（写块只用 `down`）。 */
const TEST_KEYS = e2ee.deriveSessionKeys(Buffer.alloc(32, 0x22));
const REQUEST_NONCE = e2ee.b64url(Buffer.alloc(12, 0x44));

/**
 * 起一个把两条取文件路由都挂上的服务；宿主 sessions.* / workspace.* 是假对象。
 *
 * @param {object} options
 * @param {string} options.cwd 会话工作区
 * @param {boolean} [options.e2ee] 挂上协议 v2 的会话密钥（模拟 guarded 解封之后的状态）
 */
async function serve(options) {
  const ctx = {
    apiProxy: {
      sessions: {
        history: async () => ({ result: { ok: true, value: { events: [] } } }),
        list: async () => ({ result: { ok: true, value: { items: [{ sessionId: 's1', cwd: options.cwd }] } } }),
      },
      workspace: {
        list: async () => ({ result: { ok: true, value: { items: [{ workspaceId: 'w1', path: options.cwd }] } } }),
      },
    },
  };
  const opened = options.e2ee
    ? { keys: TEST_KEYS, req: { ts: 1, nonce: REQUEST_NONCE } }
    : null;

  const server = http.createServer((req, res) => {
    // `req.__dshE2ee` 平时由 `createGuarded` 解封时挂上，这里直接画上同一个形状。
    if (opened) req.__dshE2ee = opened;
    const handler = req.url === SESSION_FILE ? handleSessionFile : handleFileRead;
    Promise.resolve(handler(ctx, req, res)).catch((error) => {
      if (res.headersSent || res.writableEnded) {
        try { res.destroy(); } catch { /* 连接已关闭 */ }
        return;
      }
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String((error && error.message) || error) } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const post = async (route, body) => {
    const response = await fetch(`${origin}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const type = response.headers.get('content-type') || '';
    const bytes = Buffer.from(await response.arrayBuffer());
    const headers = response.headers;
    if (type.startsWith('application/json')) {
      return { status: response.status, body: JSON.parse(bytes.toString('utf8') || '{}'), type, headers };
    }
    return { status: response.status, bytes, type, headers };
  };

  return {
    sessionFile: (body) => post(SESSION_FILE, { sessionId: 's1', ...body }),
    fileRead: (body) => post(FILE_READ, body),
    close: () => new Promise((resolve) => {
      // fetch 的 keep-alive 空闲连接会让 close 干等。
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

async function withHost(options, run) {
  const host = await serve(options);
  try {
    await run(host);
  } finally {
    await host.close();
  }
}

/** 建一个临时工作区，用例结束时删掉。 */
async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-file-range-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

/**
 * 按 §8.3(6) 切块并用宿主自己的实现解开。
 *
 * `seqStart` 缺省 1（整份）；取文件中间一段时传 `offset / CHUNK + 1` —— 这就是 App 侧
 * `media-stream` 调 `openFile` 时给的 `seqStart`，契约 §1 的「第 n 块序号是 offset/CHUNK + n」。
 * `route` 是 AAD 里绑的请求路径（两条路由各绑各的，见 `signedPath`）。
 */
function decodeChunks(raw, { seqStart = 1, route = SESSION_FILE } = {}) {
  const parts = [];
  let cursor = 0;
  let seq = seqStart - 1;
  while (cursor < raw.length) {
    const len = raw.readUInt32BE(cursor);
    cursor += 4;
    const sealed = raw.subarray(cursor, cursor + e2ee.NONCE_BYTES + len);
    cursor += e2ee.NONCE_BYTES + len;
    seq += 1;
    parts.push(e2ee.open(TEST_KEYS.down, sealed, e2ee.fileAad(route, REQUEST_NONCE, seq)));
  }
  return { plain: Buffer.concat(parts), blocks: seq - seqStart + 1 };
}

/** 一份跨多个块边界的测试文件内容：每个字节都不一样，按段比才比得出错位。 */
function contentOf(size) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buf[i] = (i * 31 + 7) & 0xff;
  return buf;
}

/** 加密档的一份响应头契约（offset 段）。 */
function assertEncryptedHeaders(res, { size, offset, contentType = 'application/octet-stream' }) {
  assert.equal(res.status, 200);
  assert.equal(res.type, 'application/x-dsh-e2ee-chunks');
  assert.equal(res.headers.get('x-dsh-proto'), '2');
  assert.equal(res.headers.get('x-dsh-file-size'), String(size));
  assert.equal(res.headers.get('x-dsh-range-start'), String(offset));
  assert.equal(res.headers.get('x-dsh-content-type'), contentType);
  assert.equal(Number(res.headers.get('content-length')), encryptedLengthOf(size - offset));
  assert.equal(res.bytes.length, Number(res.headers.get('content-length')), '实收字节数要与 content-length 相等');
}

test('明文档：带 offset 回 206 + content-range，字节与整份的同一段逐字节相同', async (t) => {
  const dir = await workspace(t);
  const size = FILE_CHUNK_BYTES * 3 + 1234;
  const content = contentOf(size);
  await fs.writeFile(path.join(dir, 'clip.mp4'), content);

  await withHost({ cwd: dir }, async (host) => {
    const full = await host.sessionFile({ path: 'clip.mp4' });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-range'), null, '不带 offset 时行为与今天完全一致（200、全量）');
    assert.deepEqual(full.bytes, content);

    const offset = FILE_CHUNK_BYTES * 2;
    const ranged = await host.sessionFile({ path: 'clip.mp4', offset });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes ${offset}-${size - 1}/${size}`);
    assert.equal(Number(ranged.headers.get('content-length')), size - offset);
    assert.equal(ranged.type, 'video/mp4');
    assert.deepEqual(ranged.bytes, content.subarray(offset), '取回的字节必须与整份的同段相同');

    // 另一条路由同一份实现：同一个 offset 的字节与上面逐字节相同。
    const viaRead = await host.fileRead({ path: path.join(dir, 'clip.mp4'), offset });
    assert.equal(viaRead.status, 206);
    assert.equal(viaRead.headers.get('content-range'), `bytes ${offset}-${size - 1}/${size}`);
    assert.deepEqual(viaRead.bytes, ranged.bytes);
  });
});

test('明文档：offset === size 回 206 + 空体 + bytes */size', async (t) => {
  const dir = await workspace(t);
  const size = FILE_CHUNK_BYTES * 2;
  const content = contentOf(size);
  await fs.writeFile(path.join(dir, 'clip.mp4'), content);

  await withHost({ cwd: dir }, async (host) => {
    const res = await host.sessionFile({ path: 'clip.mp4', offset: size });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), `bytes */${size}`);
    assert.equal(res.headers.get('content-length'), '0');
    assert.equal(res.bytes.length, 0);
  });
});

test('offset 不合法：没对齐 / 负数 / 不是整数一律 400 bad-offset，两条路由同一套', async (t) => {
  const dir = await workspace(t);
  await fs.writeFile(path.join(dir, 'clip.mp4'), contentOf(FILE_CHUNK_BYTES + 8));

  await withHost({ cwd: dir }, async (host) => {
    for (const offset of [1, FILE_CHUNK_BYTES - 1, FILE_CHUNK_BYTES + 1, -FILE_CHUNK_BYTES, 1.5]) {
      const viaSession = await host.sessionFile({ path: 'clip.mp4', offset });
      assert.equal(viaSession.status, 400, `offset=${offset} 应当 400`);
      assert.equal(viaSession.body.error.code, 'bad-offset');
      const viaRead = await host.fileRead({ path: path.join(dir, 'clip.mp4'), offset });
      assert.equal(viaRead.status, 400, `offset=${offset} 应当 400（/file/read）`);
      assert.equal(viaRead.body.error.code, 'bad-offset');
    }
  });
});

test('offset > size：明文档 416、加密档 400，体都是 bad-range', async (t) => {
  const dir = await workspace(t);
  const size = FILE_CHUNK_BYTES;
  await fs.writeFile(path.join(dir, 'clip.mp4'), contentOf(size));
  const beyond = size + FILE_CHUNK_BYTES;

  await withHost({ cwd: dir }, async (host) => {
    const plain = await host.sessionFile({ path: 'clip.mp4', offset: beyond });
    assert.equal(plain.status, 416);
    assert.equal(plain.body.error.code, 'bad-range');
  });

  await withHost({ cwd: dir, e2ee: true }, async (host) => {
    const encrypted = await host.sessionFile({ path: 'clip.mp4', offset: beyond });
    assert.equal(encrypted.status, 400);
    assert.equal(encrypted.body.error.code, 'bad-range');
  });
});

test('加密档：从 offset 起读的块序号接得上，解出的字节与整份的同段逐字节相同', async (t) => {
  const dir = await workspace(t);
  const size = FILE_CHUNK_BYTES * 3 + 1234;
  const content = contentOf(size);
  await fs.writeFile(path.join(dir, 'blob.bin'), content);

  await withHost({ cwd: dir, e2ee: true }, async (host) => {
    const full = await host.sessionFile({ path: 'blob.bin' });
    assertEncryptedHeaders(full, { size, offset: 0 });
    assert.deepEqual(decodeChunks(full.bytes).plain, content);

    for (const offset of [FILE_CHUNK_BYTES, FILE_CHUNK_BYTES * 2]) {
      const ranged = await host.sessionFile({ path: 'blob.bin', offset });
      assertEncryptedHeaders(ranged, { size, offset });
      // `offset / CHUNK + n`（n 从 1 起）—— App 侧 `seqStart = offset / CHUNK + 1` 的同一口径。
      const seqStart = offset / FILE_CHUNK_BYTES + 1;
      const decoded = decodeChunks(ranged.bytes, { seqStart });
      assert.deepEqual(decoded.plain, content.subarray(offset), '解出的字节必须与整份的同段相同');
      assert.equal(decoded.blocks, Math.floor((size - offset) / FILE_CHUNK_BYTES) + 1, '块数按剩余长度算');

      // 序号接不上的话解不出来：这一段不能当成「从 1 开始的一份小文件」。
      assert.throws(
        () => decodeChunks(ranged.bytes, { seqStart: 1 }),
        /unable to authenticate|bad decrypt|Unsupported state/i,
        '按 1 起数必须认证失败，否则序号错误会被安静地吞掉',
      );

      // 另一条路由同一份实现：同一个 offset 解出来的明文与上面逐字节相同（密文不同 ——
      // 每块的 nonce 是随机的，比密文等于比随机数）。
      const viaRead = await host.fileRead({ path: path.join(dir, 'blob.bin'), offset });
      assertEncryptedHeaders(viaRead, { size, offset });
      assert.deepEqual(decodeChunks(viaRead.bytes, { seqStart, route: FILE_READ }).plain, decoded.plain);
    }
  });
});

test('加密档：offset === size 回一个空的尾块', async (t) => {
  const dir = await workspace(t);
  const size = FILE_CHUNK_BYTES * 2;
  const content = contentOf(size);
  await fs.writeFile(path.join(dir, 'blob.bin'), content);

  await withHost({ cwd: dir, e2ee: true }, async (host) => {
    const offset = size;
    const res = await host.sessionFile({ path: 'blob.bin', offset });
    assertEncryptedHeaders(res, { size, offset });
    const decoded = decodeChunks(res.bytes, { seqStart: offset / FILE_CHUNK_BYTES + 1 });
    assert.equal(decoded.blocks, 1, '空尾块也要发出来，客户端据此确认「到头了」');
    assert.equal(decoded.plain.length, 0);
  });
});

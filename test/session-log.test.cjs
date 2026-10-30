'use strict';

/**
 * 会话日志导出代理（GET /api/mobile/v1/session-log）的透传契约（真机回归）。
 *
 * 桌面端这一步是「宿主执行命令 + 浏览器下载」两步：命令只在 transcript 里留一行标记，真正的
 * ZIP 由 dsh-session-log-export 监听 command/executed 后拉宿主 `GET /api/session.export`。
 * 手机既直连不到那个端点、也没有下载管理器，所以 App 里 `/export` 只看到一行「已请求」，
 * 之后什么都不会发生。
 *
 * 本测试驱动真实的 handleSessionLog（不是转写实现）：起一个只挂它的真 http 服务，用真
 * req/res，检查状态码、透传的 query、响应头与字节流。
 *
 * 关键点：
 *  1. 缺 sessionId / includeDescendants 取值非法 → 400，且**不触碰宿主**（笔误不该变成一次
 *     真实的导出请求）；
 *  2. includeDescendants 缺省即 true（与桌面客户端一致：导出整棵会话树）；
 *  3. 宿主的 application/zip 流原样落到客户端，content-disposition 照抄；
 *  4. 宿主 404/500/501 的纯文本原因原样透出，不能只剩一个状态码。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { handleSessionLog, sessionLogZipFilename } = require('../lib/mobile/session-log.js');

/** 起一个只挂 handleSessionLog 的真 http 服务。 */
async function serve(downloadsImpl, options = {}) {
  const calls = [];
  const ctx = {
    apiProxy: {
      downloads: {
        sessionLog: async (request, signal) => {
          calls.push({ request, signal });
          return downloadsImpl(request, signal);
        },
      },
    },
  };
  const server = http.createServer((req, res) => {
    // 守卫解封请求时挂的那一格：给了就等于「这条请求封过包」（真机上只有带
    // `X-Dsh-Proto: 2` 的才有），分支判据就是它。
    if (options.open) req.__dshE2ee = options.open;
    void handleSessionLog(ctx, req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    calls,
    base: `http://127.0.0.1:${port}/session-log`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** 造一个宿主 downloads.sessionLog 的应答（application/zip + 指定字节）。 */
function zipResponse(bytes, { status = 200, headers = {} } = {}) {
  return new Response(bytes, {
    status,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${sessionLogZipFilename('session-abc')}"`,
      ...headers,
    },
  });
}

test('sessionLogZipFilename 与桌面 sessionLogZipFilename 同口径', () => {
  assert.equal(sessionLogZipFilename('session-2af4d8db-c27a-4421'), 'dsh-session-session-2af4d8db-c27a-4421.zip');
  // 路径分隔符 / 空格 / 点号一律折叠成下划线，避免落盘时被当成目录。
  assert.equal(sessionLogZipFilename('a/b c.d'), 'dsh-session-a_b_c_d.zip');
});

test('缺 sessionId → 400 且不请求宿主', async () => {
  const s = await serve(() => zipResponse(new Uint8Array([1])));
  try {
    const res = await fetch(s.base);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'bad-request');
    assert.equal(body.error.message, '缺少 sessionId');
    assert.equal(s.calls.length, 0, '参数不合法时不应发起导出');
  } finally {
    await s.close();
  }
});

test('includeDescendants 只接受 true/false/缺省 → 其他取值 400 且不请求宿主', async () => {
  const s = await serve(() => zipResponse(new Uint8Array([1])));
  try {
    const res = await fetch(`${s.base}?sessionId=session-a&includeDescendants=maybe`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.message, 'includeDescendants 只接受 true 或 false');
    assert.equal(s.calls.length, 0);
  } finally {
    await s.close();
  }
});

test('缺省 includeDescendants 即 true，false 则不传该字段', async () => {
  const s = await serve(() => zipResponse(new Uint8Array([1, 2, 3])));
  try {
    await (await fetch(`${s.base}?sessionId=session-a`)).arrayBuffer();
    await (await fetch(`${s.base}?sessionId=session-a&includeDescendants=true`)).arrayBuffer();
    await (await fetch(`${s.base}?sessionId=session-a&includeDescendants=false`)).arrayBuffer();

    assert.equal(s.calls.length, 3);
    assert.deepEqual(s.calls[0].request, { sessionId: 'session-a', includeDescendants: true });
    assert.deepEqual(s.calls[1].request, { sessionId: 'session-a', includeDescendants: true });
    // 与宿主 sessionLogQuerySchema 同形：false 走「不带字段」，而不是带一个 false。
    assert.deepEqual(s.calls[2].request, { sessionId: 'session-a' });
    assert.ok(s.calls[0].signal instanceof AbortSignal);
  } finally {
    await s.close();
  }
});

test('宿主 ZIP 原样透传：状态码、content-type、content-disposition、字节', async () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x7f]);
  const s = await serve(() => zipResponse(bytes));
  try {
    const res = await fetch(`${s.base}?sessionId=session-abc`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="dsh-session-session-abc.zip"');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
  } finally {
    await s.close();
  }
});

test('宿主失败体的纯文本原因原样透出（404 session not found）', async () => {
  const s = await serve(() => new Response('session not found', { status: 404 }));
  try {
    const res = await fetch(`${s.base}?sessionId=session-gone`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'export-failed');
    assert.equal(body.error.message, 'session not found');
  } finally {
    await s.close();
  }
});

test('宿主抛错 → 502 export-failed，不把异常抛给 http 层', async () => {
  const s = await serve(() => { throw new Error('宿主连接中断'); });
  try {
    const res = await fetch(`${s.base}?sessionId=session-a`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'export-failed');
    assert.equal(body.error.message, '宿主连接中断');
  } finally {
    await s.close();
  }
});

test('路由已注册在插件上（apiProxy 的 exports 由真源码读取）', () => {
  const { readWiring } = require('./lib/wiring.cjs');
  const source = readWiring();
  assert.match(source, /require\('\.\.\/mobile\/session-log\.js'\)/);
  assert.match(source, /route\('\/api\/mobile\/v1\/session-log', sessionLog\.handleSessionLog\)/);
});

// ── 封过包的请求：分块信封 ────────────────────────────────────────────────────
//
// 判据是守卫挂上来的 `req.__dshE2ee`。这条分支存在的理由见 session-log.js 的文件头：
// 守卫对「v2 凭据 + 明文请求」一律回 e2ee-required，而会话树里是整段对话与附件 ——
// 请求封了，响应也必须封。块格式与 `session-file.js` 共用一套，所以这里按那份的解法定。

const e2ee = require('../lib/shared/e2ee');

/** 这一趟的会话密钥与请求 nonce（真机上分别来自凭据库与那条请求的信封头）。 */
const DOWN_KEY = Buffer.alloc(32, 7);
const REQUEST_NONCE = e2ee.b64url(Buffer.alloc(12, 3));
const opened = { keys: { down: DOWN_KEY }, req: { nonce: REQUEST_NONCE } };

/** 按块解开：`[4 字节长度][12 字节 nonce][密文+tag]`，AAD 绑路径 / 请求 nonce / 块序号。 */
function decryptChunks(payload, path) {
  const parts = [];
  let cursor = 0;
  let seq = 0;
  while (cursor + 4 <= payload.length) {
    const cipherLen = payload.readUInt32BE(cursor);
    cursor += 4;
    const blockLen = e2ee.NONCE_BYTES + cipherLen;
    assert.ok(cursor + blockLen <= payload.length, '块长度越界（被截断）');
    const block = payload.subarray(cursor, cursor + blockLen);
    cursor += blockLen;
    seq += 1;
    parts.push(e2ee.open(DOWN_KEY, block, e2ee.fileAad(path, REQUEST_NONCE, seq)));
  }
  assert.equal(cursor, payload.length, '尾部有多余字节');
  return Buffer.concat(parts);
}

test('封过包的请求回分块信封：多块能逐字节解回原 ZIP，明文不在线上', async () => {
  // 跨一块（64KB）的载荷：块边界、序号 AAD、尾块一起验。头部放 `PK\x03\x04`，这样
  // 「明文没漏出去」这条断言能对着真 magic 判。
  const zip = Buffer.alloc(70_000);
  Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x7f]).copy(zip, 0);
  for (let i = 6; i < zip.length; i += 1) zip[i] = (i * 131 + 7) & 0xff;
  const s = await serve(() => zipResponse(zip), { open: opened });
  try {
    const res = await fetch(`${s.base}?sessionId=session-a`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/x-dsh-e2ee-chunks');
    assert.equal(res.headers.get('x-dsh-content-type'), 'application/zip');
    assert.equal(res.headers.get('x-dsh-proto'), '2');
    assert.equal(res.headers.get('content-length'), null, '不知道总长就不给长度');
    const payload = Buffer.from(await res.arrayBuffer());
    assert.notDeepEqual(payload.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]), '明文 ZIP magic 不许出现在线上');
    assert.ok(payload.length > zip.length, '信封要带每块的 nonce 与 tag');
    assert.deepEqual(decryptChunks(payload, '/session-log'), zip);
  } finally {
    await s.close();
  }
});

test('空导出也给一块：解出 0 字节，App 才分得清「空的」与「一个字节没收到」', async () => {
  const s = await serve(() => zipResponse(new Uint8Array([])), { open: opened });
  try {
    const res = await fetch(`${s.base}?sessionId=session-a`);
    assert.equal(res.headers.get('content-type'), 'application/x-dsh-e2ee-chunks');
    const payload = Buffer.from(await res.arrayBuffer());
    assert.ok(payload.length >= 4, '至少要有一块');
    assert.equal(decryptChunks(payload, '/session-log').length, 0);
  } finally {
    await s.close();
  }
});

test('宿主失败体在封过包的请求上仍是明文 JSON（App 要先读懂它）', async () => {
  const s = await serve(() => new Response('session not found', { status: 404 }), { open: opened });
  try {
    const res = await fetch(`${s.base}?sessionId=session-gone`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.equal(body.error.message, 'session not found');
  } finally {
    await s.close();
  }
});

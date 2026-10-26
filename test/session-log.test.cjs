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
async function serve(downloadsImpl) {
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

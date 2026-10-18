'use strict';

/**
 * 局域网直连的上游请求必须随手机断开一起拆掉（2026-10-19 宿主内存事故）。
 *
 * 真机现象：宿主进程涨到 3.5～5G、CPU 30～40%，重启后回到 530M；一台机器 12 条手机连接
 * 攒出 216 条到宿主 web 口的上游长流。根因是 lan-proxy 的 proxyToUpstream 只挂了
 * `error`，手机断开后上游请求还活着，宿主那边的 SSE 响应永远等不到 `close`，每条会话流
 * 与 events 流的订阅永不退订、继续往没人读的连接上生成帧。中转那条路有 `httpCancel` 帧
 * 负责拆，只有局域网这条路漏了。
 *
 * 本测试驱动**真实的 lan-proxy HTTP 监听**（就是 App 打进来的那条路）与一个假宿主：
 * 假宿主的 SSE 响应刻意永不 end，于是「上游被拆掉」只有一个来源——手机断开。
 * 变异证明：删掉 proxyToUpstream 里的 `res.on('close')` 拆除，第一条用例会等满超时变红。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// 必须在 require credentials-entry（lan-proxy 的依赖）之前指向临时文件，否则会污染真实凭据库。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lan-teardown-'));
process.env.DEVICE_CREDENTIALS_FILE = path.join(tmp, 'relay-device-credentials.json');

const { createLanProxy } = require('../lib/relay/lan-proxy.js');
const core = require('../lib/relay/core.js');

const INSTANCE = 'teardowne2e';
const SECRET = 'lan-teardown-secret-0123456789';
const LAN_PORT = Number(process.env.LAN_TEARDOWN_PORT || 18734);
const LAN_PORT_CAP = Number(process.env.LAN_TEARDOWN_CAP_PORT || 18735);
const SSE_PATH = '/api/mobile/v1/session/stream';
const auth = () => ({ authorization: `Bearer ${core.signLanToken(SECRET, INSTANCE, 3600)}` });

/**
 * 假宿主：**带 `accept: text/event-stream` 的请求就是长流，且永不结束**（模拟宿主那条流）。
 * 判据必须与插件自己一致（插件也读 accept），按 URL 猜字符串会踩 `session` 这种词。
 * 每条上游请求记一个 `closed`：只有这条上游响应真的被拆了才会翻成 true。
 */
function startUpstream() {
  const entries = [];
  const server = http.createServer((req, res) => {
    const isSse = String(req.headers.accept || '').toLowerCase().includes('text/event-stream');
    const entry = { url: req.url, isSse, closed: false };
    entries.push(entry);
    res.on('close', () => { entry.closed = true; });
    res.writeHead(200, {
      'content-type': isSse ? 'text/event-stream' : 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    if (isSse) {
      res.write(': pad\n\n');
      return;                      // 刻意不 end：结束的主动权只该来自「手机走了」
    }
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        entries,
        port: server.address().port,
        /** 等第 index 条上游请求被拆；超时回 false。 */
        waitClosed(index, ms = 3000) {
          const entry = entries[index];
          if (!entry) return Promise.resolve(false);
          if (entry.closed) return Promise.resolve(true);
          return new Promise((done) => {
            const started = Date.now();
            const poll = setInterval(() => {
              if (entry.closed) { clearInterval(poll); done(true); }
              else if (Date.now() - started >= ms) { clearInterval(poll); done(false); }
            }, 20);
          });
        },
      });
    });
  });
}

/** 起一条 SSE 请求，拿到首块就交出来（连接保持开着）。 */
function openSse(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'GET', path: SSE_PATH,
      headers: { ...auth(), accept: 'text/event-stream' },
    }, (res) => {
      res.on('error', () => {});
      res.once('data', () => resolve({ req, res }));
    });
    req.on('error', reject);
    req.end();
    const timer = setTimeout(() => reject(new Error('上游 SSE 没有开始推流')), 4000);
    timer.unref();
  });
}

/** 普通请求：等响应收完再回，顺带把状态码与响应头带出来（429 那条也走它）。 */
function call(port, p, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, headers: { ...auth(), ...extraHeaders } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

function mkProxy(upstreamPort, lanPort, extra = {}) {
  return createLanProxy({
    lanPort,
    pairingCode: '246810',
    instanceId: INSTANCE,
    lanSecret: SECRET,
    upstreamPort,
    readSnapshot: () => null,
    onApprove: async () => ({ approved: false }),
    onLog: () => {},
    ...extra,
  });
}

function waitFor(predicate, ms) {
  if (predicate()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (predicate()) { clearInterval(poll); resolve(true); }
      else if (Date.now() - started >= ms) { clearInterval(poll); resolve(false); }
    }, 20);
  });
}

test('局域网直连：手机断开后上游长流必须被拆掉（真机内存事故）', async () => {
  const upstream = await startUpstream();
  const proxy = mkProxy(upstream.port, LAN_PORT);
  await proxy.start();
  const stream = await openSse(LAN_PORT);
  try {
    assert.equal(upstream.entries.length, 1, '应该有一条上游请求');
    assert.equal(upstream.entries[0].closed, false, '手机还连着，上游不该被拆');
    assert.deepEqual(proxy.stats(), { upstreamOpen: 1, sseOpen: 1 }, '自检计数要如实反映活着的那一条');

    // 手机走了：只断开手机这一侧，上游那侧不做任何动作。
    stream.res.destroy();

    const closed = await upstream.waitClosed(0);
    assert.equal(closed, true, '手机断开后上游请求必须被拆，否则宿主的订阅永远退不掉');
    assert.equal(await waitFor(() => proxy.stats().upstreamOpen === 0, 2000), true,
      `拆除后计数要落回去，实际 ${JSON.stringify(proxy.stats())}`);
    assert.deepEqual(proxy.stats(), { upstreamOpen: 0, sseOpen: 0 });
  } finally {
    try { stream.req.destroy(); } catch { /* 已断开 */ }
    proxy.stop();
    upstream.server.close();
  }
});

test('普通响应活完之后不该被当成「客户端提前走」', async () => {
  const upstream = await startUpstream();
  const proxy = mkProxy(upstream.port, LAN_PORT + 2);
  await proxy.start();
  try {
    const res = await call(LAN_PORT + 2, '/api/mobile/v1/sessions');
    assert.equal(res.status, 200, `普通读应 200，实际 ${res.status}`);
    assert.equal(JSON.parse(res.body).ok, true, '正常响应必须原样回给手机');
    assert.equal(await waitFor(() => proxy.stats().upstreamOpen === 0, 2000), true, '正常收尾之后上游计数也该归零');
  } finally {
    proxy.stop();
    upstream.server.close();
  }
});

test('上游 SSE 有失控闸：挡住超限长流、不误伤普通请求、手机走了就放得开', async () => {
  const upstream = await startUpstream();
  const proxy = mkProxy(upstream.port, LAN_PORT_CAP, { maxUpstreamSse: 2 });
  await proxy.start();
  const streams = [];
  try {
    streams.push(await openSse(LAN_PORT_CAP));
    streams.push(await openSse(LAN_PORT_CAP));
    assert.deepEqual(proxy.stats(), { upstreamOpen: 2, sseOpen: 2 }, '两条长流应各占一个上游名额');

    const refused = await call(LAN_PORT_CAP, SSE_PATH, { accept: 'text/event-stream' });
    assert.equal(refused.status, 429, '超过上限的长流应被拒，而不是放它再占一条上游');
    assert.equal(refused.headers['retry-after'], '2', '要带 retry-after，手机才知道可以重连');
    assert.match(refused.body, /上限/);

    const plain = await call(LAN_PORT_CAP, '/api/mobile/v1/sessions');
    assert.equal(plain.status, 200, '闸只该管长流，普通请求不受影响');
    assert.deepEqual(proxy.stats(), { upstreamOpen: 2, sseOpen: 2 }, '普通请求收尾后仍只剩那两条长流');

    // 手机全走了 → 名额要放得开，否则一次半开连接会把后面的正常使用永久挡在门外。
    for (const s of streams.splice(0)) { try { s.req.destroy(); } catch { /* 已断开 */ } }
    assert.equal(await waitFor(() => proxy.stats().upstreamOpen === 0, 2000), true, '拆除后名额必须还回来');
    const reopened = await openSse(LAN_PORT_CAP);
    streams.push(reopened);
    assert.deepEqual(proxy.stats(), { upstreamOpen: 1, sseOpen: 1 }, '名额还回来之后必须能重新连上');
  } finally {
    for (const s of streams) { try { s.req.destroy(); } catch { /* 已断开 */ } }
    proxy.stop();
    upstream.server.close();
  }
});

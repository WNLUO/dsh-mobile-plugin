'use strict';

/**
 * 协议 v2 信封的端到端守卫（§8.3(4)(7)(11)）。
 *
 * 直接驱动真实实现：App 侧（`app/src/api/envelope.ts` + `services/e2ee-envelope.ts`）
 * 封一条请求，喂进宿主侧的 \`createGuarded\`，再解回响应。中间不转写任何逻辑 ——
 * 「两端各看各的代码都像对的、合起来解不开」是这一层最典型的翻车方式。
 *
 * 钉住这七条：
 *  1. 一条正常请求能走完「封 → 验签 → 解 → 业务 → 封响应 → 解响应」；
 *  2. `X-Dsh-Sig` 对不上就 400 `e2ee-bad-signature`，且 handler 不被调用；
 *  3. 时钟超窗回 400 `e2ee-clock-skew` + `serverTime`（**明文**，否则 App 读不到原因）；
 *  4. 同一 nonce 的写请求第二次进来回 409 `e2ee-replay`；
 *  5. GET 复用同一 nonce 不算重放（换通道重投就是这个形状）;
 *  6. 未知 keyId 回 401 `e2ee-unknown-device`（明文）；
 *  7. `401/403/503` 的响应不加密。
 *
 * 运行：`node dsh-mobile-plugin/test/e2ee-envelope-e2e.test.cjs`
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const root = path.join(__dirname, '..');
const routing = require(path.join(root, 'lib/http/routing.js'));
const e2ee = require(path.join(root, 'lib/shared/e2ee.js'));

const DEVICE_KEY = Buffer.alloc(32, 0x22);
const KEY_ID = '0011223344556677';
const INSTANCE = 'a1b2c3d4';
const keys = e2ee.deriveSessionKeys(DEVICE_KEY);

/** 假 IncomingMessage：能按信封要求读 body。 */
function fakeReq({ method = 'POST', url = '/api/mobile/v1/status', headers = {}, body = '' } = {}) {
  const stream = new PassThrough();
  const req = {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    on: stream.on.bind(stream),
    destroy: () => stream.destroy(),
  };
  stream.resume();
  process.nextTick(() => {
    if (body) stream.write(body);
    stream.end();
  });
  return req;
}

/** 假 ServerResponse：记录状态与最终写出的字节。 */
function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    written: '',
    writeHead(status, extra) {
      res.statusCode = status;
      Object.assign(res.headers, extra || {});
      return res;
    },
    end(chunk) {
      res.written = chunk == null ? '' : String(chunk);
      return res;
    },
  };
  return res;
}

const guarded = routing.createGuarded(
  {},
  () => true,
  null,
  {
    envelope: {
      keyFor: (keyId) => (keyId === KEY_ID ? { deviceKey: DEVICE_KEY.toString('base64url'), deviceId: 'dev-1' } : null),
      // 与 `lib/shared/e2ee-request.js` 的 `readRawBody` 同形状：超限或连接出错都 reject。
      readBody: (req) =>
        new Promise((resolve, reject) => {
          const chunks = [];
          req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          req.on('end', () => resolve(Buffer.concat(chunks)));
          req.on('error', reject);
        }),
    },
  },
);

/**
 * 按 App 的口径封一条请求。
 *
 * 这里用的是宿主侧的 `lib/shared/e2ee.js`，而不是 App 那份 .ts —— 后者是 ESM+TS，CJS 测试
 * 里加载不了。两端口径一致这件事由 `app/scripts/test-e2ee-vectors.js` 逐字节证明过，
 * 所以这里用哪一份封都不影响判据：这条测试要证的是**接线**（信封放哪、什么时候验签、
 * 错误码对不对），字节口径已经有独立的守卫。
 */
function buildRequest({ method = 'POST', path = '/api/mobile/v1/status', query = '', plain = { v: 1 }, ts = Date.now(), nonce = null }) {
  const nonceBytes = nonce || Buffer.alloc(12, 0x44);
  const nonceText = e2ee.b64url(nonceBytes);
  // `plain === null` 就是「没有 body」：GET 走这条，签名摘要按**空字节**算（与 App 侧一致）。
  const bodyBytes = plain === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(plain), 'utf8');
  const sealed = e2ee.sealWithNonce(keys.up, nonceBytes, bodyBytes, e2ee.upAad(method, path));
  const wire = plain === null ? '' : JSON.stringify({ v: 2, c: Buffer.from(sealed).toString('base64') });
  const canonical = e2ee.canonicalString({
    method,
    path,
    query,
    ts,
    nonce: nonceText,
    bodyBytes: wire === '' ? Buffer.alloc(0) : Buffer.from(wire, 'utf8'),
  });
  return {
    wire,
    headers: {
      'x-dsh-proto': '2',
      'x-dsh-key-id': KEY_ID,
      'x-dsh-ts': String(ts),
      'x-dsh-nonce': nonceText,
      'x-dsh-sig': e2ee.sign(keys.sig, canonical),
    },
  };
}

test('正常一条请求：封 → 验签 → 解 → 业务 → 封响应 → 解响应', async () => {
  const built = buildRequest({ plain: { hello: '世界' }, nonce: Buffer.alloc(12, 0x01) });
  let received = null;
  const handler = guarded(async (_ctx, req, res) => {
    received = req.body;
    routing.sendJson(res, 200, { ok: true, echo: req.body.hello });
  });
  const req = fakeReq({ headers: built.headers, body: built.wire });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(received, { hello: '世界' }, '业务 handler 必须拿到明文');

  const wire = JSON.parse(res.written);
  assert.equal(wire.v, 2, '响应必须是信封');
  assert.equal(typeof wire.n, 'string');
  assert.equal(typeof wire.c, 'string');

  const nonce = req.headers['x-dsh-nonce'];
  const ts = Number(req.headers['x-dsh-ts']);
  const { unwrapper } = require(path.join(root, 'lib/shared/e2ee-request.js'));
  const plain = JSON.parse(
    e2ee.open(keys.down, unwrapper(wire), e2ee.downAad('POST', '/api/mobile/v1/status', ts, nonce)).toString('utf8'),
  );
  assert.deepEqual(plain, { ok: true, echo: '世界' }, 'App 侧必须能解回业务结果');
});

test('签名对不上：400 e2ee-bad-signature，handler 不被调用、响应明文', async () => {
  const built = buildRequest({ plain: { a: 1 }, nonce: Buffer.alloc(12, 0x02) });
  const bad = { ...built, headers: { ...built.headers, 'x-dsh-sig': e2ee.b64url(Buffer.alloc(32, 0)) } };
  let called = false;
  const handler = guarded(async () => { called = true; });
  const res = fakeRes();
  await handler(fakeReq({ headers: bad.headers, body: bad.wire }), res);
  assert.equal(called, false);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.written).error.code, 'e2ee-bad-signature');
});

test('时钟超窗：400 e2ee-clock-skew + serverTime，且响应明文', async () => {
  const built = buildRequest({ plain: { a: 1 }, nonce: Buffer.alloc(12, 0x03), ts: Date.now() - 30 * 60 * 1000 });
  const handler = guarded(async () => { throw new Error('不该被调用'); });
  const res = fakeRes();
  await handler(fakeReq({ headers: built.headers, body: built.wire }), res);
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.written);
  assert.equal(body.error.code, 'e2ee-clock-skew');
  assert.ok(typeof body.error.serverTime === 'number', '必须带宿主的时钟，否则手机无从校准');
  assert.equal(body.v, undefined, '这条响应不能是信封：App 要先读懂它');
});

test('同一 nonce 的写请求第二次：409 e2ee-replay', async () => {
  const nonce = Buffer.alloc(12, 0x66);
  const handler = guarded(async (_ctx, _req, res) => routing.sendJson(res, 200, { ok: true }));
  const built = buildRequest({ plain: { a: 1 }, nonce, ts: Date.now() });
  await handler(fakeReq({ headers: built.headers, body: built.wire }), fakeRes());
  const second = buildRequest({ plain: { a: 1 }, nonce, ts: Date.now() });
  const res = fakeRes();
  await handler(fakeReq({ headers: second.headers, body: second.wire }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.written).error.code, 'e2ee-replay');
});

test('GET 复用同一 nonce 不算重放（换通道重投就是这个形状）', async () => {
  const nonce = Buffer.alloc(12, 0x77);
  const handler = guarded(async (_ctx, _req, res) => routing.sendJson(res, 200, { ok: true }));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const built = buildRequest({ method: 'GET', plain: null, nonce, ts: Date.now() });
    const res = fakeRes();
    await handler(fakeReq({ method: 'GET', headers: built.headers, body: '' }), res);
    assert.equal(res.statusCode, 200, `第 ${attempt + 1} 次 GET 不该被判重放`);
  }
});

test('未知 keyId：401 e2ee-unknown-device，明文', async () => {
  const built = buildRequest({ plain: { a: 1 }, nonce: Buffer.alloc(12, 0x04) });
  const unknown = { ...built, headers: { ...built.headers, 'x-dsh-key-id': 'ffffffffffffffff' } };
  const handler = guarded(async () => { throw new Error('不该被调用'); });
  const res = fakeRes();
  await handler(fakeReq({ headers: unknown.headers, body: unknown.wire }), res);
  assert.equal(res.statusCode, 401);
  const body = JSON.parse(res.written);
  assert.equal(body.error.code, 'e2ee-unknown-device');
  assert.equal(body.v, undefined, '401 必须明文');
});

test('业务层的 401 响应不加密', async () => {
  const built = buildRequest({ plain: { a: 1 }, nonce: Buffer.alloc(12, 0x05) });
  const handler = guarded(async (_ctx, _req, res) => {
    routing.sendJson(res, 401, { ok: false, error: { code: 'device-revoked', message: '已解除绑定' } });
  });
  const res = fakeRes();
  await handler(fakeReq({ headers: built.headers, body: built.wire }), res);
  assert.equal(res.statusCode, 401);
  const body = JSON.parse(res.written);
  assert.equal(body.v, undefined, '被吊销必须让 App 直接读懂');
  assert.equal(body.error.code, 'device-revoked');
});

test('低速请求体的连接不会把守卫挂死（读体失败回 413 而不是永远等）', async () => {
  const built = buildRequest({ plain: { a: 1 }, nonce: Buffer.alloc(12, 0x06) });
  const stream = new PassThrough();
  stream.resume();
  const req = {
    method: 'POST',
    url: '/api/mobile/v1/status',
    headers: built.headers,
    socket: { remoteAddress: '127.0.0.1' },
    on: stream.on.bind(stream),
    destroy: () => stream.destroy(new Error('too large')),
  };
  const handler = guarded(async () => { throw new Error('不该被调用'); });
  const res = fakeRes();
  process.nextTick(() => stream.destroy(new Error('too large')));
  await handler(req, res);
  assert.equal(res.statusCode, 413, '读体失败必须是 413，不能挂住');
});

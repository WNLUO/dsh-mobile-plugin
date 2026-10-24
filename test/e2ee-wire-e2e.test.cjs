'use strict';

/**
 * 协议 v2 的**接线**（讨论记录 §8.3(4)(5)(6) / §8.4）。
 *
 * `e2ee-envelope-e2e.test.cjs` 钉的是宿主侧守卫的行为（错误码、重放、时钟），
 * `app/scripts/test-e2ee-vectors.js` 钉的是两端的字节口径。**这两者之间还有一层没人管**：
 * App 封出来的东西宿主能不能真解开、宿主封的 App 能不能真解开，以及「私密参数搬走之后
 * 签名还算不算数」。这一层出错的症状是「联调时一直解不开」，而两端各自看代码都对。
 *
 * 所以这里做两件事：
 *  1. 用 App 侧真实实现（`e2ee-envelope.ts`）封一条带私密参数的请求，喂进宿主的
 *     `createGuarded`，断言宿主的验签通过、业务 handler **拿到合并回来的查询串**；
 *  2. 反过来用宿主封一条响应 / 一帧流 / 一块文件，喂给 App 侧的 `openResponse` /
 *     `openStreamFrame` / `openFileChunk`，断言能解开且内容一致。
 *
 * 跑法：`node dsh-mobile-plugin/test/e2ee-wire-e2e.test.cjs`。宿主那侧是 CJS 直接 require，
 * App 那侧用 `app/scripts/load-ts.js` 加载（需要 stub 掉 react-native 与原生随机口）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const root = path.join(__dirname, '..', '..');
const e2ee = require(path.join(root, 'dsh-mobile-plugin', 'lib', 'shared', 'e2ee.js'));
const { wrapper } = require(path.join(root, 'dsh-mobile-plugin', 'lib', 'shared', 'e2ee-request.js'));
const routing = require(path.join(root, 'dsh-mobile-plugin', 'lib', 'http', 'routing.js'));

const { loadTsFromApp, registerStub } = require(path.join(root, 'app', 'scripts', 'load-ts.js'));
// App 侧的随机数走原生安全随机口；这里给一串固定字节，让断言可复现。
registerStub('react-native', {
  Platform: { OS: 'ios', select: (options) => options.ios },
  // 两个注册名都给：真机上 Android 是 `VoiceModule`、iOS 走 `DSHVoice`，
  // App 侧取哪一个会随两边接线变动；假体同时提供，免得测试因为改名而假红。
  NativeModules: {
    VoiceModule: { randomBytes: async (size) => Buffer.alloc(size, 0x33).toString('base64') },
    DSHVoice: { randomBytes: async (size) => Buffer.alloc(size, 0x33).toString('base64') },
  },
});
const appEnvelope = loadTsFromApp('src/services/e2ee-envelope');
const appRandom = loadTsFromApp('src/services/e2ee-random');
const appFile = loadTsFromApp('src/services/e2ee-file');
const appSse = loadTsFromApp('src/services/viewmodels/e2ee');
const appApiEnvelope = loadTsFromApp('src/api/envelope');

const DEVICE_KEY = Buffer.alloc(32, 0x22);
const KEY_ID = '0011223344556677';
const INSTANCE = 'a1b2c3d4';
const keys = e2ee.deriveSessionKeys(DEVICE_KEY);
const context = { proto: 2, deviceKey: DEVICE_KEY.toString('base64url'), keyId: KEY_ID, clockSkewMs: 0 };

/** 假 req：按信封要求能读 body，且带 App 实际发的那几个头。 */
function fakeReq({ method = 'GET', url = '/api/mobile/v1/status', headers = {}, body = '' } = {}) {
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
      // 保留原始字节：v2 的响应体可能是 gzip 后的信封，`String()` 会把它毁掉。
      res.raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk == null ? '' : String(chunk));
      res.written = res.raw.toString('utf8');
      return res;
    },
    setHeader(name, value) {
      res.headers[String(name).toLowerCase()] = value;
    },
  };
  return res;
}

/** 起一个真的 guarded 守卫，keyFor 只认这一把设备密钥。 */
function guarded() {
  return routing.createGuarded({}, () => true, null, {
    envelope: {
      keyFor: (keyId) => (keyId === KEY_ID ? { deviceKey: DEVICE_KEY.toString('base64url'), deviceId: 'dev-1' } : null),
      readBody: (req) =>
        new Promise((resolve, reject) => {
          const chunks = [];
          req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          req.on('end', () => resolve(Buffer.concat(chunks)));
          req.on('error', reject);
        }),
    },
  });
}

test.before(async () => { await appRandom.warmUpRandom(512); });

test('App 封的请求宿主能验签解开；私密参数搬走后仍对得上，并合并回 req.url', async () => {
  // 带 `path=`（工作目录）的那条真实路由：它同时有「留在 URL 上的分页参数」。
  const url = 'http://127.0.0.1:3080/api/mobile/v1/session/search?path=%2FUsers%2Fme%2Fcode%2Fx&rev=abc';
  const sealed = appEnvelope.sealRequest(context, url, { method: 'GET', headers: {} });

  // App 真正发出去的是 `sealRequest` 给的 suffix（少掉 path=），不是入参那条 URL。
  assert.ok(!sealed.suffix.includes('path='), '私密参数必须已经从线上 URL 里搬走');
  assert.match(sealed.suffix, /rev=abc/, '分页 / rev 这类要留在 URL 上（镜像靠它）');
  assert.ok(sealed.headers['X-Dsh-Params'], '搬走的参数要进加密头');

  let seenUrl = '';
  const handler = guarded()(async (_ctx, req, res) => {
    seenUrl = req.url;
    routing.sendJson(res, 200, { ok: true });
  });
  const res = fakeRes();
  const req = fakeReq({ method: 'GET', url: sealed.suffix, headers: sealed.headers, body: sealed.body });
  await handler(req, res);

  assert.equal(res.statusCode, 200, `宿主必须验签通过（否则会回 400，实际 body=${res.written}）`);
  // 业务 handler 读到的仍是原来那个查询串：`path` 由守卫合并回来，`rev` 一直在。
  assert.match(seenUrl, /rev=abc/);
  assert.match(seenUrl, /path=%2FUsers%2Fme%2Fcode%2Fx/);
});

test('宿主封的响应 App 能解开（nonce 必须拼回去）', async () => {
  const ts = Date.now();
  const reqNonce = e2ee.b64url(Buffer.alloc(12, 0x44));
  const plain = { ok: true, hello: '世界' };
  const sealed = wrapper(
    e2ee.sealWithNonce(keys.down, Buffer.alloc(12, 0x55), Buffer.from(JSON.stringify(plain)), e2ee.downAad('GET', '/api/mobile/v1/status', ts, reqNonce)),
  );
  const got = appEnvelope.openResponse(context, { method: 'GET', path: '/api/mobile/v1/status', ts, nonce: reqNonce }, sealed);
  assert.deepEqual(got, plain);
});

test('宿主封的 SSE 帧 App 能解开', () => {
  const ts = Date.now();
  const reqNonce = e2ee.b64url(Buffer.alloc(12, 0x44));
  const framePath = '/api/mobile/v1/session/stream';
  const payload = { type: 'session/event', seq: 3 };
  const sealed = wrapper(
    e2ee.sealWithNonce(keys.down, Buffer.alloc(12, 0x66), Buffer.from(JSON.stringify(payload)), e2ee.sseAad(framePath, ts, reqNonce, 1)),
  );
  const got = appEnvelope.openStreamFrame(context, { path: framePath, ts, nonce: reqNonce, seq: 1 }, sealed);
  assert.deepEqual(got, payload);
});

test('宿主写的分块文件 App 能整份解回来（含尾块）', () => {
  const reqNonce = e2ee.b64url(Buffer.alloc(12, 0x44));
  const filePath = '/api/mobile/v1/session/file';
  const blocks = [Buffer.from('a'.repeat(64 * 1024)), Buffer.from('尾巴')];
  const payload = Buffer.concat(blocks.map((bytes, index) => {
    const sealed = Buffer.from(e2ee.sealWithNonce(keys.down, Buffer.alloc(12, index + 1), bytes, e2ee.fileAad(filePath, reqNonce, index + 1)));
    const head = Buffer.alloc(4);
    head.writeUInt32BE(sealed.length - e2ee.NONCE_BYTES, 0);
    return Buffer.concat([head, sealed]);
  }));
  const out = appFile.openFileChunk(
    { proto: 2, deviceKey: DEVICE_KEY.toString('base64url'), keyId: KEY_ID, clockSkewMs: 0 },
    { path: filePath, ts: 1, nonce: reqNonce },
    new Uint8Array(payload),
  );
  assert.equal(out.length, blocks[0].length + blocks[1].length);
  assert.equal(Buffer.from(out).subarray(64 * 1024).toString('utf8'), '尾巴');
});

test('签名对不上时宿主拒收：搬参前后算签名会得到两个不同的摘要', () => {
  const url = 'http://x/api/mobile/v1/session/search?path=%2Fa&rev=1';
  const sealed = appEnvelope.sealRequest(context, url, { method: 'GET', headers: {} });
  // 按**入参**那条 URL 算（也就是旧实现的顺序）应该对不上，这正是这条守卫要钉的回归。
  const canonical = e2ee.canonicalString({
    method: 'GET',
    path: '/api/mobile/v1/session/search',
    query: '?path=%2Fa&rev=1',
    ts: sealed.ts,
    nonce: sealed.nonce,
    bodyBytes: Buffer.alloc(0),
  });
  assert.notEqual(sealed.headers['X-Dsh-Sig'], e2ee.sign(keys.sig, canonical), '签的必须是搬参之后实际发出去的那一串');
});

test('列表类响应：外层留 ok/revision/generatedAt，正文在 env，App 解完要盖回去', () => {
  const ts = Date.now();
  const reqNonce = e2ee.b64url(Buffer.alloc(12, 0x44));
  const listPath = '/api/mobile/v1/sessions';
  const payload = { ok: true, revision: 'rev-abc', generatedAt: 1761292800123, items: [{ sessionId: 's1' }] };
  // 用宿主真实实现跑一遍，避免这里手抄一份形状：
  const { sealResponse } = require(path.join(root, 'dsh-mobile-plugin', 'lib', 'shared', 'e2ee-request.js'));
  const body = sealResponse(
    { method: 'GET', url: listPath },
    { statusCode: 200 },
    keys,
    { ts, nonce: reqNonce },
    payload,
  );
  assert.equal(body.ok, true, '中转的镜像 `is_ok()` 只认外层这个 ok');
  assert.equal(body.revision, 'rev-abc', 'revision 必须留在外层（unchanged 短路靠它）');
  assert.equal(body.generatedAt, payload.generatedAt);
  assert.ok(body.env && typeof body.env === 'object', '正文在 env 里');
  // AAD 材料随响应走：这里直接把 `sealResponse` 收到的那条请求交回去。
  const got = appApiEnvelope.openEnvelopeBody(context, body, 200, '2', { method: 'GET', path: listPath, ts, nonce: reqNonce });
  assert.deepEqual(got.items, payload.items, '正文解回来了');
  assert.equal(got.ok, true, '外层 ok 要盖回去');
  assert.equal(got.revision, 'rev-abc', '外层 revision 要盖回去');
});


test('大响应（>=1KB）带 Accept-Encoding: gzip 时仍然封成信封，不许退化成明文', async () => {
  // 2026-10-24 现场：`sendJson` 先 gzip，守卫的 `res.end` 钩子拿到的就是二进制，
  // `JSON.parse` 失败 → 原样写出、没封。症状是「最大的那批响应反而不加密」，而且安静。
  const big = { ok: true, items: Array.from({ length: 200 }, (_v, i) => ({ id: `s-${i}`, title: '一条足够长的会话标题用来把响应顶过 1KB' })) };
  const handler = guarded()(async (_ctx, _req, res) => { routing.sendJson(res, 200, big); });
  // 用 App 侧的封法生成一条合法请求，借它拿到 keys / AAD 材料。
  const url = 'http://127.0.0.1:3080/api/mobile/v1/sessions';
  const sealed = appEnvelope.sealRequest(context, url, { method: 'GET', headers: { 'accept-encoding': 'gzip' } });
  const res = fakeRes();
  const req = fakeReq({ method: 'GET', url: sealed.suffix, headers: sealed.headers, body: sealed.body });
  // 真实节点里 `res.req` 一定在，`sendJson` 靠它读 accept-encoding；假体不挂就等于
  // 永远测不到「先压后封」那条路（变异证明会假装通过）。
  res.req = req;
  await handler(req, res);

  assert.equal(res.statusCode, 200, `守卫必须放行（实际 ${res.written.slice(0, 120)}）`);
  // 信封不能再压：`writeHead` 之后设不了 `content-encoding`，压了就是「头说 identity、
  // 线上是 gzip」，客户端报「请求失败 (HTTP 200)」。这里钉住「线上字节直接是 JSON」。
  assert.equal(res.headers['content-encoding'], undefined, '信封不许在 HTTP 层再压一遍');
  const envelope = JSON.parse(res.raw.toString('utf8'));
  assert.equal(envelope.v, 2, '响应必须是信封，不能是明文 JSON 或明文 gzip');
  assert.ok(envelope.c, '信封里必须有密文');
});

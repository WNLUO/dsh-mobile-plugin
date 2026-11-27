// 2026-11-27：面板中转检测与 APP 同判据——跟跳转、回包 ok 不真都不算通。
'use strict';

/**
 * 面板「自建中转检测」的守卫。
 *
 * 手机拨中转是严格判据：不跟跳转，回包要同时有 ok:true 和 dsh-mobile-relay 服务名。
 * 面板原来用 follow 跟跳、只看 service，于是会出现「面板 142ms 正常、APP 判不通」的假绿灯。
 * 这里把同一套判据钉在宿主代测这一层，变异掉就红。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const CONTROL_PLANE = path.join(__dirname, '..', 'lib', 'routes', 'control-plane.js');
const nativeRequire = createRequire(CONTROL_PLANE);

function handlerWith(fetchImpl, mutate = (source) => source) {
  const module = { exports: {} };
  vm.runInNewContext(mutate(fs.readFileSync(CONTROL_PLANE, 'utf8')), {
    module,
    exports: module.exports,
    require: nativeRequire,
    __dirname: path.dirname(CONTROL_PLANE),
    process,
    Buffer,
    URL,
    performance,
    AbortController,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
  });
  const table = new Map();
  const state = { enabled: true };
  module.exports.registerControlPlaneRoutes({
    registerRoute: (route) => table.set(route.path, route.handler),
    localOnly: (_method, handler) => handler,
    trustedLocalUi: () => true,
    sendJson: (res, status, payload) => { res.status = status; res.body = payload; },
    readJson: async (req) => req.body || {},
    state,
    sidecarToken: 'test',
    status: () => ({}),
    settings: { update: async (patch) => Object.assign(state, patch) },
    syncSidecar: async () => {},
    reconnectTunnel: async () => {},
    getSidecar: () => null,
    credentials: {
      listDevices: () => [],
      listHistory: () => [],
      listDevicesWithHistory: () => ({ devices: [], history: [] }),
    },
    activeGuard: () => null,
    resolveLanPort: async () => 18787,
    lanPortInUse: () => 18787,
    getLanPortAdjusted: () => false,
    pairingPayload: () => ({ payload: {} }),
    dropDeviceStreams: () => 0,
    getPluginRuntime: () => null,
  });
  return table.get('/api/relay/probe-relays');
}

function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    url: '',
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  };
}

async function probe(fetchImpl, mutate) {
  const handler = handlerWith(fetchImpl, mutate);
  const res = {};
  await handler({ body: { urls: ['https://relay.example'] } }, res);
  return res.body.results[0];
}

/** 真中转：两条路径都回正常的体检形状。 */
const healthy = async (url) => fakeResponse(200,
  url.endsWith('/healthz') ? 'ok' : { ok: true, service: 'dsh-mobile-relay' });

/** 反代把体检路径 302 到别处；只有 caller 声明 follow 时才「跳到真中转」。 */
const redirecting = async (url, init) => (init && init.redirect === 'follow')
  ? healthy(url)
  : fakeResponse(302, {});

test('真中转测出延迟，回包 ok 为假不算通，跟跳转也不算通', async () => {
  const good = await probe(healthy);
  assert.equal(typeof good.ms, 'number');
  assert.equal(good.service, 'dsh-mobile-relay');

  const notOk = await probe(async (url) => fakeResponse(200,
    url.endsWith('/healthz') ? 'ok' : { ok: false, service: 'dsh-mobile-relay' }));
  assert.equal(notOk.ms, null, 'service 对但 ok 不真，手机判不通，面板也不该给绿灯');

  const redirected = await probe(redirecting);
  assert.equal(redirected.ms, null, '面板不跟跳，避免把反代跳转当成可用中转');
});

test('变异：把不跟跳改回 follow，守卫会红', async () => {
  await assert.rejects(
    probe(redirecting, (source) => source.replaceAll("redirect: 'manual'", "redirect: 'follow'"))
      .then((result) => {
        assert.equal(result.ms, null, '变异后跟跳被判通，守卫必须红');
      }),
    assert.AssertionError,
  );
});

test('变异：去掉 ok 校验，守卫会红', async () => {
  await assert.rejects(
    probe(async (url) => fakeResponse(200,
      url.endsWith('/healthz') ? 'ok' : { ok: false, service: 'dsh-mobile-relay' }),
    (source) => source.replaceAll('who.ok === true && who.service ===', 'who.service ==='))
      .then((result) => {
        assert.equal(result.ms, null, '变异后 ok:false 被判通，守卫必须红');
      }),
    assert.AssertionError,
  );
});

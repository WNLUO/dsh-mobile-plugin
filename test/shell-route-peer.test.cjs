// 外壳分发必须原样透传宿主传给 handler 的全部实参（尤其第三个 peer）。
'use strict';

/**
 * 新版 web 服务器按 `handler(req, res, peer)` 调用路由。外壳为了统计在飞请求，会在
 * handler 外面套一层 `wrapInFlight` / `wrapHandler`；只要这层只转 `(req, res)`，就会把
 * `peer` 丢掉，RPC 拿不到准入身份一直挂着不响应——桌面表现为「Loading plugins…」卡死、
 * `/api/*` 全部超时。这条守卫钉住两点：HTTP 路由包装与 `wrapHandler` 都必须透传 peer。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const runtimeUrl = pathToFileURL(path.join(__dirname, '..', 'lib', 'shell', 'runtime.js')).href;

test('外壳包装路由处理函数时透传 peer', async () => {
  const { createRuntime } = await import(runtimeUrl);
  const runtime = createRuntime();

  let captured = null;
  const server = {
    register(route) { captured = route; return () => {}; },
    registerUpgrade(route) { return () => {}; },
  };
  const outer = server.register;
  runtime.installDispatch(server, outer, server.registerUpgrade);

  const peer = { id: 'peer-xyz' };
  const seen = [];
  const route = {
    kind: 'exact',
    path: '/api/__test__',
    handler: async (...args) => { seen.push(args); return 'ok'; },
  };
  runtime.registerRoute(route, outer, server);

  assert.ok(captured, 'registerRoute 应把包装后的路由交给宿主 register');
  await captured.handler({ headers: {} }, { end() {} }, peer);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][2], peer, '包装后 handler 必须收到宿主传的第三个参数 peer');
});

test('wrapHandler 透传 peer', async () => {
  const { createRuntime } = await import(runtimeUrl);
  const runtime = createRuntime();
  const peer = { id: 'peer-wrap' };
  const seen = [];
  const wrapped = runtime.wrapHandler({
    kind: 'exact',
    path: '/x',
    handler: async (...args) => { seen.push(args); },
  });
  await wrapped.handler({}, {}, peer);
  assert.equal(seen[0][2], peer, 'wrapHandler 包装后 handler 必须收到 peer');
});

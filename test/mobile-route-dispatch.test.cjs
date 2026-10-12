'use strict';

/**
 * 移动端路由的**派发**契约：宿主怎么调 handler，handler 必须写出什么。
 *
 * 为什么有了 `mobile-routes.test.cjs` 还需要这一条：那套测试读的是
 * `lib/routes/mobile-api.js` 的**源码文本**，只比对「路径清单有没有和 App 对齐」，
 * 对「handler 长什么样」一无所知。于是 2026-10 的 `/api/mobile/v1/health` 把一个本该
 * 收 `(req, res)` 的裸 handler 写成了 `(_ctx, _req, res)`：`res` 成了 `undefined`，
 * 而 `shared/http-util.js` 的 `sendJson` 把 TypeError 当成「连接已关闭」静默吞掉——
 * 既没报错也没回包，请求**永久挂住**。手机 5s 超时后退回 `/healthz` 拿到 ok，报
 * 「地址能连上，但对面不是 DSH 移动端服务」，而整套纯文本断言全绿。
 *
 * 所以这里**真装配一次路由表**、按宿主的调用约定真派发每一条路由
 * （`@deepseek-ai/dsh-host-webserver` 就是 `await route.handler(req, res)`，两个参数），
 * 钉住两件事：
 *   1. 无凭据时**任何**一条路由都得写出响应，一个字节都不回就是上面那种挂死；
 *   2. 公开豁免的那一条回 200 + 服务名，其余一律 401。
 *
 * 公开路由的清单与理由不在本文件重复维护（在 `mobile-routes.test.cjs` 的
 * `PUBLIC_ROUTES`），这里只断言「它是那个例外、且真的答得出来」。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { registerMobileRoutes } = require(path.join(root, 'lib/routes/mobile-api.js'));
const { createGuarded } = require(path.join(root, 'lib/http/routing.js'));

/** 假 ServerResponse：只记录最后一次 writeHead + end（与 http-routing.test.cjs 同一形状）。 */
function fakeRes() {
  return {
    status: 0,
    body: null,
    writeHead(status) { this.status = status; },
    end(raw) { this.body = JSON.parse(String(raw)); },
  };
}

/** 假 IncomingMessage：一个不带任何凭据的请求。 */
const fakeReq = () => ({ headers: {}, method: 'GET' });

/**
 * 真装配一次路由表，收集注册进来的普通 HTTP 路由（升级路由走另一套名字空间，不在这里）。
 *
 * `guarded` 传的是**真的** `createGuarded`，且 `authorized` 恒假——这样「其余路由必须回
 * 401」验的是真守卫，而不是测试自己伪造的替身。handler 体要到被派发时才跑，所以其余
 * 注入项给最小的假值就够。
 */
function mountRoutes() {
  const routes = [];
  registerMobileRoutes({
    registerRoute: (route) => routes.push(route),
    registerUpgradeRoute: () => {},
    preview: { handleUpgrade() {} },
    guarded: createGuarded(null, () => false, null),
    state: {},
    hostMetadata: () => ({}),
    getSidecarSnapshot: () => null,
    safeLanCandidates: () => [],
    lanPortInUse: () => 0,
  });
  return routes;
}

const ROUTES = mountRoutes();
const HEALTH = '/api/mobile/v1/health';

test('路由表装得出来（条数下限防装配失效）', () => {
  assert.ok(ROUTES.length >= 45, `只装出 ${ROUTES.length} 条移动端路由，装配可能没跑起来`);
  assert.ok(ROUTES.some((r) => r.path === HEALTH), `没装出公开豁免的 ${HEALTH}`);
});

test('无凭据派发每一条路由：谁都得写出响应，不许一个字节都不回', async () => {
  for (const route of ROUTES) {
    const res = fakeRes();
    await route.handler(fakeReq(), res);
    assert.notEqual(
      res.status,
      0,
      `${route.path} 一个字节都没回。宿主是按 handler(req, res) 两个参数调的，`
      + 'handler 多写一个前缀参数就会把 res 挤成 undefined，而 sendJson 会把那个 TypeError 吞掉',
    );
  }
});

test('公开豁免的体检路由回 200 + 服务名，其余无凭据一律 401', async () => {
  for (const route of ROUTES) {
    const res = fakeRes();
    await route.handler(fakeReq(), res);
    if (route.path === HEALTH) {
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.service, 'dsh-mobile-plugin', 'App 靠这个字段分辨宿主与中转');
      continue;
    }
    assert.equal(res.status, 401, `${route.path} 无凭据应当回 401`);
  }
});

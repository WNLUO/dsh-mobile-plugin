'use strict';

/**
 * 移动端 handler 的**活体**守卫：真的把每条路由跑一遍，宿主怎么调就怎么调。
 *
 * 有些 500 在界面上毫无痕迹：`GET /api/mobile/v1/session` 曾回
 * `{"ok":false,"error":{"code":"internal","message":"eventSeqOf is not defined"}}`，而 App 把
 * 这一发 catch 掉、拿不到就退化成绝对路径显示。根因是 sessions.js 拆成按域模块时，
 * `eventSeqOf` 搬去了 session-snapshot.js，**调用处却没把名字接进来**。
 *
 * 已有的三套测试全绿：`mobile-routes.test.cjs` 只比对路径清单与 App 对齐；
 * `mobile-route-dispatch.test.cjs` 只断言「无凭据时写出 401」，handler 体根本不会被走到；
 * `module-split.test.cjs` 只钉「某个函数住在哪个文件」，不钉「调用它的地方有没有把它引进来」。
 *
 * 所以这里补最后一块：**带一个形状完整的 ctx 真跑一遍每个 handler**，任何一处「名字没接
 * 进来 / 接线指向不存在的路径」都会当场变成 `ReferenceError` 或 5xx。
 *
 * 假宿主用 Proxy：任何属性都存在、任何方法调用都回一个空信封 `{ result: { ok: true, value: {} } }`。
 * 这样 handler 里每一行都会被执行到（包括它怎么解包、怎么兜底），但不会真的碰宿主的磁盘或
 * RPC。断言只钉一件事：**不许抛异常、不许回 5xx**。
 */

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { registerMobileRoutes } = require(path.join(root, 'lib/routes/mobile-api.js'));

/**
 * 两条 SSE 长连接不参与：它们不写响应头就会一直挂着等帧，跑完还得靠超时收尸，
 * 而且「连得上」这件事由 stream/events 各自的契约测试管。它们的共同点是
 * **没有 handler 体里的一次性解析**，不会有「名字没接进来」这类问题。
 */
const STREAMING_ROUTES = new Set([
  '/api/mobile/v1/session/stream',
  '/api/mobile/v1/events/stream',
]);

/**
 * 「手机上查插件更新」那条路由**不需要外壳**，所以在空宿主下也真的会去问 npm 注册表 ——
 * 真发出去要等 8 秒超时，撞上下面那条「1 秒内必须回包」的判据，红的是「守卫里混进了一次
 * 真实网络请求」，而不是 handler 挂住了。这一轮把 `fetch` 换成一个只认注册表地址的假答：
 * 问别的地址一律当场抛，免得以后真有 handler hang 在网络那一步还被这层假答盖住。
 * 网络与超时那一半由 `update-registry.test.cjs` 管。
 */
let savedFetch = null;
let savedHome = null;

before(() => {
  // 宿主家里有真账本（`mobile-stats.json`）：统计那条路由会把里面的会话标题 / 最后一句
  // 原样回出去，而这台机器上正好有一条的正文就是「Cannot read property …」—— 下面那条
  // 「不许回代码级错误」的判据直接把用户正文当成崩溃信息判红了。活体守卫只关心接线，
  // 给它一个空家：跟 archive-clean 那套一样，测完还原。
  savedHome = process.env.DSH_HOME;
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-liveness-'));
  savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (!String(url).includes('/dsh-mobile-plugin/latest')) {
      throw new Error(`活体守卫里不该发真实请求：${url}`);
    }
    return { ok: true, status: 200, json: async () => ({ version: '0.1.99' }) };
  };
});

after(() => {
  globalThis.fetch = savedFetch;
  if (savedHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedHome;
});

/**
 * 空宿主：任何属性都可取、任何调用都回一个合法的空信封。
 *
 * 不能省成 `{}` —— 那样 handler 在 `ctx.apiProxy.sessions.history(...)` 这一步就抛
 * TypeError，测出来的是「假宿主太薄」而不是「handler 坏了」。也不能返回 `undefined`：
 * handler 普遍写 `value && value.events`，给个 undefined 就跳过了后面所有解包逻辑，
 * 覆盖不到真正的接线点。
 */
function emptyHost() {
  const target = function emptyHostCall() {};
  return new Proxy(target, {
    get(_t, prop) {
      // await 会探测 then：真给它一个函数就会被当成 thenable，整个调用变成 pending。
      if (prop === 'then') return undefined;
      // 少数 handler 会 `for await (... of ctx.apiProxy.events.mux(...))`。
      if (prop === Symbol.asyncIterator) return async function* emptyFrames() {};
      if (prop === 'toString' || prop === Symbol.toPrimitive) return () => '';
      return emptyHost();
    },
    // 宿主方法返回的是 `{ result: { ok, value } }` 信封（见 mobile/envelope.js）。
    apply() {
      return Promise.resolve({ result: { ok: true, value: {} } });
    },
  });
}

/** 假 ServerResponse：只要 handler 走到「回包」这一步就记下来。 */
function fakeRes() {
  const res = {
    status: 0,
    raw: '',
    headersSent: false,
    writableEnded: false,
    socket: { remoteAddress: '127.0.0.1', writableLength: 0 },
  };
  res.writeHead = (status) => { res.status = status; res.headersSent = true; };
  res.setHeader = () => {};
  res.write = () => true;
  res.end = (chunk) => {
    res.raw = String(chunk == null ? '' : chunk);
    res.writableEnded = true;
  };
  res.on = () => res;
  res.once = () => res;
  res.emit = () => true;
  res.removeListener = () => res;
  return res;
}

/**
 * 假 IncomingMessage：GET + 空 body。
 *
 * `on('end')` 要立刻回来：POST 那批 handler 用 `readJsonBody` 收包，本仓库那套实现挂的是
 * `data` / `end` 事件；不触发就永远等不到 body，测出来的又是假的。同时给一份空的
 * async iterator，照顾走 `for await` 读流的实现。
 */
function fakeReq(url) {
  const req = {
    url,
    method: 'GET',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    readableEnded: true,
    setEncoding() {},
  };
  req.on = (event, listener) => {
    if (event === 'end') setImmediate(listener);
    return req;
  };
  req.once = req.on;
  req.removeListener = () => req;
  req[Symbol.asyncIterator] = async function* emptyBody() {};
  return req;
}

/** 真装配一次路由表，`guarded` 原样放行（鉴权边界归 mobile-route-dispatch.test.cjs 管）。 */
function mountRoutes() {
  const routes = [];
  registerMobileRoutes({
    registerRoute: (route) => routes.push(route),
    registerUpgradeRoute: () => {},
    guarded: (handler) => handler,
    state: {},
    hostMetadata: () => ({}),
    getSidecarSnapshot: () => ({}),
    safeLanCandidates: () => [],
    safeIpv6Candidates: () => [],
    lanPortInUse: () => 0,
    preview: { handleUpgrade() {} },
    core: {},
    pairingApproval: null,
  });
  return routes;
}

/**
 * 空宿主 + **一条历史事件**。
 *
 * 空 events 会让 `events.length ? eventSeqOf(...) : 0` 走 else 分支，于是「eventSeqOf
 * 没接进来」这种断线在空宿主下根本不炸 —— 真机那条 500 就是这么漏过去的。给一条事件，
 * 凡是碰事件序号的地方都会被走到。
 */
function hostWithOneEvent() {
  const host = emptyHost();
  return {
    ...host,
    apiProxy: new Proxy({}, {
      get(_t, prop) {
        if (prop === 'sessions') {
          return new Proxy({}, {
            get(_t2, method) {
              if (method === 'history') {
                return async () => ({
                  result: {
                    ok: true,
                    value: {
                      events: [{ event: { type: 'turn/start', seq: 5, time: 1, data: { turn: 1 } } }],
                      hasMore: false,
                    },
                  },
                });
              }
              // 其余宿主方法（list / projections / search…）一律空信封。
              return async () => ({ result: { ok: true, value: {} } });
            },
          });
        }
        return host[prop];
      },
    }),
  };
}

const ROUTES = mountRoutes();

test('路由表装得出来（条数下限防装配失效）', () => {
  assert.ok(ROUTES.length >= 45, `只装出 ${ROUTES.length} 条移动端路由，装配可能没跑起来`);
});

test('每个 handler 都跑得起来：空宿主下不许抛、不许挂住、不许报「东西不存在」', async () => {
  for (const route of ROUTES) {
    if (STREAMING_ROUTES.has(route.path)) continue;
    const res = fakeRes();
    const ctx = {
      ...hostWithOneEvent(),
      typertGateway: emptyHost(),
      goals: emptyHost(),
      webServer: emptyHost(),
      log: () => {},
    };
    let outcome;
    try {
      outcome = await Promise.race([
        Promise.resolve(route.handler(ctx, fakeReq(`${route.path}?sessionId=session-liveness`), res))
          .then(() => 'done'),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 1000)),
      ]);
    } catch (error) {
      assert.fail(`${route.path} 抛了异常：${error && error.message}。`
        + '常见原因是拆模块时把函数搬了家、调用处没把名字接进来');
    }
    assert.notEqual(outcome, 'timeout', `${route.path} 挂住不回包（handler 里多半在等一个不会来的东西）`);

    // 400 / 502 / 503 都是 handler 自己判定的「这次请求不成立」，空宿主下出现很正常，不算坏。
    // 要拦的是另一种 5xx：代码里有东西不存在，被 guarded 兜成 500 internal。它在真机上
    // 就是那次 `eventSeqOf is not defined`，而 App catch 掉之后界面上一点痕迹都没有。
    const looksLikeRuntimeError = /is not defined|is not a function|Cannot read propert|Cannot destructure/i
      .test(res.raw);
    assert.equal(
      looksLikeRuntimeError,
      false,
      `${route.path} 回了代码级错误：${res.raw.slice(0, 160)}`,
    );
  }
});

test('会话详情这条真机上 500 过的路由，现在答得出 cwd 与 lastSeq', async () => {
  // 这条单独钉一次：上面那轮用的是空宿主（history.map 返回空 events），
  // 恰好让 `events.length ? … : 0` 走到 else 分支 —— 接线断了也不会炸。必须给它
  // 一条真事件，才会走到 `eventSeqOf(...)` 那一行（ReferenceError 就在那儿）。
  const route = ROUTES.find((item) => item.path === '/api/mobile/v1/session');
  assert.ok(route, '没装出 /api/mobile/v1/session');

  const ctx = {
    apiProxy: {
      sessions: {
        history: async () => ({
          result: {
            ok: true,
            value: {
              events: [
                { event: { type: 'turn/start', seq: 3, time: 1, data: { turn: 1 } } },
                { event: { type: 'turn/end', seq: 7, time: 2, data: { turn: 1 } } },
              ],
            },
          },
        }),
        list: async () => ({
          result: { ok: true, value: { items: [{ sessionId: 'session-liveness', cwd: '/ws/alpha', title: 'alpha' }] } },
        }),
      },
    },
  };
  const res = fakeRes();
  await route.handler(ctx, fakeReq('/api/mobile/v1/session?sessionId=session-liveness'), res);

  assert.equal(res.status, 200, `会话详情回了 ${res.status}：${res.raw.slice(0, 160)}`);
  const body = JSON.parse(res.raw);
  assert.equal(body.session.cwd, '/ws/alpha', 'cwd 是 App 唯一消费的字段（工具卡路径相对化）');
  assert.equal(body.session.lastSeq, 7, 'lastSeq 取最后一条事件序号，正是接线断掉那一行');
});

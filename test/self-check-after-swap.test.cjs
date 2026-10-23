'use strict';

/**
 * 换代之后的自检：新版装起来了、但手机要打的接口没挂上时，必须自己退回去。
 *
 * 这一条是「装坏了 App 就连不上，你怎么回滚」的答案所在：**回滚不能是手机按的** ——
 * 装坏的后果正是 App 连不上，那时候手机上一颗按钮都发不出去。所以判据与动作都在宿主。
 *
 * 钉三件：
 *  1. 「自检失败」与「没法自检」必须分开：宿主 webServer 没在监听时退回去会退掉一次
 *     其实成功的更新（开发机跑测试时就是这种现场）。
 *  2. 自检判的是**那条路由答不答得出来**，不是「进程还活着」。
 *  3. 401 也算活：移动端守卫先核 token 再谈路由，没带 token 回 401 说明实现与守卫都在。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  checkGenerationAlive,
  SELF_CHECK_PATH,
  SELF_CHECK_SERVICE,
} = require('../lib/shell/self-check-after-swap.js');

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('答得出本插件身份 → 活着', async () => {
  const seen = [];
  const result = await checkGenerationAlive({
    port: 4321,
    fetchImpl: async (url) => {
      seen.push(url);
      return jsonResponse(200, { ok: true, service: SELF_CHECK_SERVICE });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(seen[0], `http://127.0.0.1:4321${SELF_CHECK_PATH}`, '打的就是手机首屏那条路径');
});

test('401 也算活着（守卫先核 token 再谈路由）', async () => {
  const result = await checkGenerationAlive({
    port: 4321,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  assert.equal(result.ok, true);
});

test('404 = 路由没挂上，算失败', async () => {
  const result = await checkGenerationAlive({
    port: 4321,
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /404/);
});

test('回的不是本插件：算失败，不把中转当自己', async () => {
  const result = await checkGenerationAlive({
    port: 4321,
    fetchImpl: async () => jsonResponse(200, { ok: true, service: 'dsh-mobile-relay' }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /dsh-mobile-relay/);
});

test('超时：算失败（连上了但不回包 = handler 卡住）', async () => {
  const result = await checkGenerationAlive({
    port: 4321,
    timeoutMs: 30,
    fetchImpl: async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /超时/);
});

test('连不上（宿主 webServer 没起来）：跳过，不算新版坏了', async () => {
  const error = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  const result = await checkGenerationAlive({ port: 4321, fetchImpl: async () => { throw error; } });
  assert.equal(result.skip, true, '退回去会退掉一次其实成功的更新');
  assert.match(result.reason, /ECONNREFUSED/);
});

test('拿不到端口：跳过（老宿主 / 测试里的假 ctx）', async () => {
  for (const port of [null, undefined, 0, -1, 'abc']) {
    const result = await checkGenerationAlive({ port, fetchImpl: async () => jsonResponse(200, { service: SELF_CHECK_SERVICE }) });
    assert.equal(result.skip, true, `port=${String(port)} 时应该跳过`);
  }
});

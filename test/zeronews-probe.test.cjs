// ZeroNews 本地 API 读取：只认 active 的 HTTPS 隧道，读不到如实说，绝不建隧道/碰账号。
'use strict';

/**
 * 面板「从 ZeroNews 读取」按钮背后的读取层守卫。
 *
 * 不连真网：fetch 全部注入假体。要保证的是各种响应形状（官方 data.items / 裸数组 / endpoints）
 * 都能挑出正确的 https 地址，TCP、非 active、坏地址一律不收；连不上 / 超时 / 业务错误码
 * 各自给出明确结论，不把错误体当隧道清单。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_BASE,
  ENDPOINTS_PATH,
  httpsUrlOf,
  extractEndpoints,
  readZeroNewsEndpoints,
} = require('../lib/zeronews/probe.cjs');

/** 造一个回固定 JSON 的 fetch 假体，顺带记下被请求的 URL。 */
function fetchJson(payload, status = 200) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  fn.calls = calls;
  return fn;
}

test('httpsUrlOf 只认 https 且能解析出主机的地址，去掉尾斜杠', () => {
  assert.equal(httpsUrlOf('https://abc.takin.cc/'), 'https://abc.takin.cc');
  assert.equal(httpsUrlOf(' https://abc.takin.cc '), 'https://abc.takin.cc');
  assert.equal(httpsUrlOf('http://abc.takin.cc'), '');
  assert.equal(httpsUrlOf('not a url'), '');
  assert.equal(httpsUrlOf(''), '');
  assert.equal(httpsUrlOf(null), '');
});

test('extractEndpoints 认官方 data.items 形状', () => {
  const payload = {
    code: 200,
    data: {
      items: [
        { type: 'HTTPS', status: 'active', domain: 'a.takin.cc' },
        { type: 'TCP', status: 'active', domain: 'b.takin.cc' },
        { type: 'HTTPS', status: 'inactive', domain: 'c.takin.cc' },
      ],
    },
  };
  assert.deepEqual(extractEndpoints(payload), ['https://a.takin.cc']);
});

test('extractEndpoints 认裸数组与 endpoints 字段，并去重', () => {
  assert.deepEqual(
    extractEndpoints([
      { type: 'HTTPS', status: 'active', domain: 'a.takin.cc' },
      { type: 'HTTPS', status: 'active', domain: 'a.takin.cc/' },
    ]),
    ['https://a.takin.cc'],
  );
  assert.deepEqual(
    extractEndpoints({ endpoints: [{ status: 'active', public_url: 'https://d.takin.cc' }] }),
    ['https://d.takin.cc'],
  );
});

test('extractEndpoints 对空/异常输入回空清单，不抛', () => {
  assert.deepEqual(extractEndpoints(null), []);
  assert.deepEqual(extractEndpoints({}), []);
  assert.deepEqual(extractEndpoints({ data: { items: 'not-array' } }), []);
  assert.deepEqual(extractEndpoints({ data: { items: [null, 3, 'x'] } }), []);
});

test('readZeroNewsEndpoints 从默认地址读，返回可用地址', async () => {
  const fetchImpl = fetchJson({ code: 200, data: { items: [{ type: 'HTTPS', status: 'active', domain: 'ok.takin.cc' }] } });
  const res = await readZeroNewsEndpoints({ fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.available, true);
  assert.deepEqual(res.urls, ['https://ok.takin.cc']);
  assert.deepEqual(fetchImpl.calls, [`${DEFAULT_BASE}${ENDPOINTS_PATH}`]);
});

test('readZeroNewsEndpoints 客户端在跑但没有隧道：ok=true、urls 空', async () => {
  const res = await readZeroNewsEndpoints({ fetchImpl: fetchJson({ code: 200, data: { items: [] } }) });
  assert.equal(res.ok, true);
  assert.equal(res.available, true);
  assert.deepEqual(res.urls, []);
});

test('readZeroNewsEndpoints 连不上（没装/没起）如实报 available=false', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const res = await readZeroNewsEndpoints({ fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.available, false);
  assert.deepEqual(res.urls, []);
  assert.match(res.error, /没有回应/);
});

test('readZeroNewsEndpoints 业务错误码不把错误体当隧道清单', async () => {
  const res = await readZeroNewsEndpoints({ fetchImpl: fetchJson({ code: 400, error: 'bad' }) });
  assert.equal(res.ok, false);
  assert.equal(res.available, true);
  assert.deepEqual(res.urls, []);
  assert.match(res.error, /返回了错误/);
});

test('readZeroNewsEndpoints fetch 抛错时给明确结论，不抛回调用方', async () => {
  const fetchImpl = async () => { throw new Error('connection refused'); };
  const res = await readZeroNewsEndpoints({ fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.available, false);
  assert.match(res.error, /connection refused/);
});

test('readZeroNewsEndpoints 支持注入 base（换端口场景）', async () => {
  const fetchImpl = fetchJson({ code: 200, data: { items: [] } });
  await readZeroNewsEndpoints({ fetchImpl, base: 'http://127.0.0.1:48080/' });
  assert.deepEqual(fetchImpl.calls, ['http://127.0.0.1:48080/api/v1/endpoints']);
});

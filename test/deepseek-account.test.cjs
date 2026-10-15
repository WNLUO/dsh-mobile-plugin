/** DeepSeek account read-only projection and mobile-boundary tests. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleDeepSeekAccount, readClientMetadata } = require('../lib/mobile/deepseek-account.js');

const QUERY = '?version=0.2.117&locale=zh-CN&timezoneOffsetSeconds=28800';

function response() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

async function run(ctx, url = `/api/mobile/v1/deepseek-account${QUERY}`) {
  const res = response();
  await handleDeepSeekAccount(ctx, { url }, res);
  return { status: res.status, headers: res.headers, body: JSON.parse(res.body) };
}

function ok(value) { return { result: { ok: true, value } }; }
function error(code) { return { result: { ok: false, error: { code, message: 'internal detail' } } }; }

test('解析客户端元数据，拒绝缺失的时区参数', () => {
  assert.deepEqual(readClientMetadata({ url: `/account${QUERY}` }), {
    version: '0.2.117', locale: 'zh-CN', timezoneOffsetSeconds: 28800,
  });
  assert.equal(readClientMetadata({ url: '/account?version=1&locale=zh-CN' }), null);
  assert.equal(readClientMetadata({ url: '/account?version=1&locale=zh-CN&timezoneOffsetSeconds=' }), null);
});

test('未登录时只返回状态与链接，不读取资料或余额', async () => {
  const calls = [];
  const result = await run({ apiProxy: { account: {
    getState: async () => { calls.push('getState'); return ok({ status: 'signed-out', attempt: { authorizeUrl: 'secret-url' }, links: { usageUrl: 'https://deepseek.com/usage' } }); },
    getProfile: async () => { calls.push('getProfile'); return ok({}); },
    getBalance: async () => { calls.push('getBalance'); return ok({}); },
  } } });

  assert.equal(result.status, 200);
  assert.deepEqual(calls, ['getState']);
  assert.deepEqual(result.body, {
    ok: true,
    status: 'signed-out',
    profile: { status: 'unavailable' },
    balance: { status: 'unavailable' },
    links: { usageUrl: 'https://deepseek.com/usage', topUpUrl: null },
  });
  assert.doesNotMatch(JSON.stringify(result.body), /attempt|authorizeUrl|secret-url/);
});

test('已登录时仅投影资料、钱包与用量链接，不回传账号内部字段', async () => {
  const calls = [];
  const client = { version: '0.2.117', locale: 'zh-CN', timezoneOffsetSeconds: 28800 };
  const result = await run({ apiProxy: { account: {
    getState: async () => ok({ status: 'credential-stored', token: 'never-forward', attempt: { authorizeUrl: 'private' }, links: {
      usageUrl: 'https://deepseek.com/usage', topUpUrl: 'https://deepseek.com/top-up',
    } }),
    getProfile: async (request) => { calls.push(['getProfile', request.payload.client]); return ok({
      status: 'ready', value: { id: 'account-id', name: '小明', contact: 'x@example.com', avatarUrl: 'https://example.com/avatar', token: 'private' },
    }); },
    getBalance: async (request) => { calls.push(['getBalance', request.payload.client]); return ok({
      status: 'ready', value: [{ currency: 'CNY', balance: '12.30', token: 'private' }],
      bonusWallets: [{ currency: 'CNY', balance: '3.00' }, { currency: 'EUR', balance: '9.00' }],
    }); },
  } } });

  assert.equal(result.status, 200);
  assert.deepEqual(calls, [['getProfile', client], ['getBalance', client]]);
  assert.deepEqual(result.body, {
    ok: true,
    status: 'credential-stored',
    profile: { status: 'ready', name: '小明', contact: 'x@example.com' },
    balance: {
      status: 'ready',
      wallets: [{ currency: 'CNY', balance: '12.30' }],
      bonusWallets: [{ currency: 'CNY', balance: '3.00' }],
    },
    links: { usageUrl: 'https://deepseek.com/usage', topUpUrl: 'https://deepseek.com/top-up' },
  });
  assert.doesNotMatch(JSON.stringify(result.body), /token|attempt|authorizeUrl|account-id|avatarUrl/);
});

test('资料读取失败不影响余额，余额读取失败不泄漏宿主错误文本', async () => {
  const profileFailure = await run({ apiProxy: { account: {
    getState: async () => ok({ status: 'credential-stored' }),
    getProfile: async () => error('profile-failed'),
    getBalance: async () => ok({ status: 'ready', value: [], bonusWallets: [] }),
  } } });
  assert.deepEqual(profileFailure.body.profile, { status: 'failed' });
  assert.deepEqual(profileFailure.body.balance, { status: 'ready', wallets: [], bonusWallets: [] });

  const balanceFailure = await run({ apiProxy: { account: {
    getState: async () => ok({ status: 'credential-stored' }),
    getProfile: async () => ok({ status: 'ready', value: { name: '小明', contact: null } }),
    getBalance: async () => error('balance-failed'),
  } } });
  assert.deepEqual(balanceFailure.body.profile, { status: 'ready', name: '小明', contact: null });
  assert.deepEqual(balanceFailure.body.balance, { status: 'failed' });
  assert.doesNotMatch(JSON.stringify(balanceFailure.body), /internal detail|balance-failed/);

  const stateFailure = await run({ apiProxy: { account: { getState: async () => error('host-unavailable') } } });
  assert.equal(stateFailure.status, 502);
  assert.deepEqual(stateFailure.body.error, {
    code: 'host-unavailable', message: '这台宿主暂时无法读取 DeepSeek 账号信息',
  });
});

test('缺少客户端元数据时不调用宿主', async () => {
  let called = false;
  const result = await run({ apiProxy: { account: { getState: async () => { called = true; return ok({ status: 'signed-out' }); } } } }, '/account?version=1&locale=zh-CN');
  assert.equal(result.status, 400);
  assert.equal(called, false);
});

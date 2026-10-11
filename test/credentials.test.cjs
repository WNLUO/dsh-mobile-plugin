'use strict';

/**
 * 宿主凭据代理（GET /credentials、POST /credentials/set、POST /credentials/unset）的透传契约。
 *
 * 桌面端设置面板能往宿主写 API Key（dsh-client-ui-settings-plugins/lib/client.js 的
 * writeKey() → credentials.set），手机端此前只能在设置页看到一句「· 1 项密钥未设置」。
 * 这个代理的职责很窄，但每一条都容易写错：
 *
 *  1. 引用名必须与宿主同一条正则（/^[A-Za-z_][A-Za-z0-9_]*$/），畸形要在本地就 400，
 *     别把垃圾发给宿主；describe 一次最多 64 个（宿主 schema 也是 64）；
 *  2. 三个宿主方法都只吃一个信封参数（没有 signal 形参），代理必须只传一个；
 *  3. 密钥值只进不出：成功响应里只有 ok，绝不能把值回显 / 回传给手机；
 *  4. 「能不能写」由宿主说了算（环境变量提供的引用 writable:false，set 回
 *     credential-rejected），代理不许自己判断，如实透传；
 *  5. 畸形宿主响应（null / 数组 / 字符串视图）按「没有这个引用」处理，不抛错。
 *
 * 本测试驱动真实的 handler（不是转写实现）：起一个真 http 服务，用真 req/res。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {
  handleCredentialsDescribe,
  handleCredentialsSet,
  handleCredentialsUnset,
  normalizeCredentialView,
  normalizeRef,
} = require('../lib/mobile/credentials.js');
const { credentialRefOf, normalizeNamespace } = require('../lib/mobile/host-settings.js');
const { readWiring } = require('./lib/wiring.cjs')

const okValue = (value) => ({ result: { ok: true, value } });
const errValue = (error) => ({ result: { ok: false, error } });

/**
 * 起一个只挂三个 handler 的真 http 服务，并记下宿主收到的每一次调用与第二个参数。
 * `impl` 可以按域名给假实现：{ describe, set, unset }。
 */
async function serve(impl = {}) {
  const calls = { describe: [], set: [], unset: [] };
  const signals = [];
  const record = (domain) => async (request, signal) => {
    calls[domain].push(request);
    signals.push(signal);
    const fn = impl[domain];
    return fn ? fn(request, signal) : okValue(domain === 'describe' ? { credentials: {} } : {});
  };
  const ctx = {
    apiProxy: { credentials: { describe: record('describe'), set: record('set'), unset: record('unset') } },
  };
  const server = http.createServer((req, res) => {
    const route = String(req.url || '').split('?')[0];
    const handler = route === '/credentials'
      ? handleCredentialsDescribe
      : route === '/credentials/set'
        ? handleCredentialsSet
        : route === '/credentials/unset'
          ? handleCredentialsUnset
          : null;
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'not-found', message: 'no route' } }));
      return;
    }
    // 复刻 lib/index.js 的 guarded()：handler 抛错就回 500 JSON。
    Promise.resolve(handler(ctx, req, res)).catch((error) => {
      if (res.headersSent || res.writableEnded) return;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: { code: 'internal', message: String((error && error.message) || error) },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    calls,
    signals,
    get: async (query) => {
      const res = await fetch(`${base}/credentials${query}`);
      return { status: res.status, body: await res.json() };
    },
    post: async (route, payload) => {
      const res = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return { status: res.status, body: await res.json() };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test('describe 原样转发，只传一个信封参数', async () => {
  const server = await serve({
    describe: () => okValue({ credentials: { DEEPSEEK_API_KEY: { configured: true, source: 'env', writable: false } } }),
  });
  try {
    const { status, body } = await server.get('?refs=DEEPSEEK_API_KEY');
    assert.equal(status, 200);
    assert.deepEqual(server.calls.describe[0], {
      rpcId: 'mobile',
      method: 'credentials.describe',
      payload: { refs: ['DEEPSEEK_API_KEY'] },
    });
    assert.equal(server.signals[0], undefined, '宿主 credentials.describe 没有 signal 形参');
    assert.deepEqual(body, {
      ok: true,
      credentials: { DEEPSEEK_API_KEY: { configured: true, source: 'env', writable: false } },
    });
  } finally {
    await server.close();
  }
});

test('describe：source 只在宿主给出时带上，布尔严格', async () => {
  const server = await serve({
    describe: () => okValue({
      credentials: {
        A_KEY: { configured: 'yes', writable: 1, source: '   ' },
        B_KEY: { configured: false, writable: true, source: 'file' },
        C_KEY: {},
      },
    }),
  });
  try {
    const { body } = await server.get('?refs=A_KEY,B_KEY,C_KEY');
    assert.deepEqual(body.credentials.A_KEY, { configured: false, writable: false });
    assert.deepEqual(body.credentials.B_KEY, { configured: false, writable: true, source: 'file' });
    assert.deepEqual(body.credentials.C_KEY, { configured: false, writable: false });
  } finally {
    await server.close();
  }
});

test('describe：refs 逗号分隔、去空白、去重、保持顺序', async () => {
  const server = await serve();
  try {
    const { body } = await server.get('?refs=%20B_KEY%20,A_KEY,B_KEY,,A_KEY');
    assert.equal(body.ok, true);
    assert.deepEqual(server.calls.describe[0].payload.refs, ['B_KEY', 'A_KEY']);
  } finally {
    await server.close();
  }
});

test('describe：没有 refs 参数就是空列表，照问宿主一次', async () => {
  const server = await serve();
  try {
    const { status, body } = await server.get('');
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true, credentials: {} });
    assert.deepEqual(server.calls.describe[0].payload.refs, []);
  } finally {
    await server.close();
  }
});

test('describe：畸形引用名本地 400，不打扰宿主', async () => {
  const server = await serve();
  try {
    for (const query of ['?refs=9bad', '?refs=has%20space', '?refs=a-b', '?refs=%E4%B8%AD%E6%96%87']) {
      const { status, body } = await server.get(query);
      assert.equal(status, 400, query);
      assert.equal(body.error.code, 'bad-request');
      assert.match(body.error.message, /refs 必须是逗号分隔的凭据引用名/);
    }
    assert.equal(server.calls.describe.length, 0);
  } finally {
    await server.close();
  }
});

test('describe：超过 64 个引用本地 400', async () => {
  const server = await serve();
  try {
    const many = Array.from({ length: 65 }, (_, i) => `KEY_${i}`).join(',');
    const { status, body } = await server.get(`?refs=${many}`);
    assert.equal(status, 400);
    assert.match(body.error.message, /一次最多 64 个/);
    assert.equal(server.calls.describe.length, 0);
    // 正好 64 个放行。
    const exact = Array.from({ length: 64 }, (_, i) => `KEY_${i}`).join(',');
    const ok = await server.get(`?refs=${exact}`);
    assert.equal(ok.status, 200);
    assert.equal(server.calls.describe[0].payload.refs.length, 64);
  } finally {
    await server.close();
  }
});

test('describe：宿主错误原样透传，响应里没有 credentials 键', async () => {
  const server = await serve({
    describe: () => errValue({ code: 'credentials-absent', message: 'this deployment does not mount a credential provider' }),
  });
  try {
    const { status, body } = await server.get('?refs=A_KEY');
    assert.equal(status, 400);
    assert.deepEqual(body, {
      ok: false,
      error: { code: 'credentials-absent', message: 'this deployment does not mount a credential provider' },
    });
    assert.equal('credentials' in body, false);
  } finally {
    await server.close();
  }
});

test('describe：畸形宿主响应按「没有这个引用」处理', async () => {
  for (const value of [null, {}, { credentials: null }, { credentials: [] }, { credentials: 'nope' }, { credentials: { A_KEY: 'nope' } }]) {
    const server = await serve({ describe: () => okValue(value) });
    try {
      const { status, body } = await server.get('?refs=A_KEY');
      assert.equal(status, 200, JSON.stringify(value));
      assert.deepEqual(body, { ok: true, credentials: {} }, JSON.stringify(value));
    } finally {
      await server.close();
    }
  }
});

test('describe：宿主视图里的任何值都不会漏给手机', async () => {
  const server = await serve({
    describe: () => okValue({
      credentials: { A_KEY: { configured: true, writable: true, value: 'sk-super-secret', data: 'sk-super-secret' } },
    }),
  });
  try {
    const { body } = await server.get('?refs=A_KEY');
    assert.deepEqual(body.credentials.A_KEY, { configured: true, writable: true });
    const raw = JSON.stringify(body);
    assert.equal(raw.includes('sk-super-secret'), false, '密钥值绝不能出现在响应里');
    assert.equal(raw.includes('value'), false);
    assert.equal(raw.includes('data'), false);
  } finally {
    await server.close();
  }
});

test('set：信封精确，成功响应只有 ok（不回显值）', async () => {
  const server = await serve();
  try {
    const { status, body } = await server.post('/credentials/set', { ref: 'A_KEY', value: 'sk-abc123' });
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });
    assert.deepEqual(server.calls.set[0], {
      rpcId: 'mobile',
      method: 'credentials.set',
      payload: { ref: 'A_KEY', value: 'sk-abc123' },
    });
    assert.equal(server.signals[0], undefined);
    assert.equal(JSON.stringify(body).includes('sk-abc123'), false);
  } finally {
    await server.close();
  }
});

test('set：ref 先 trim 再转发', async () => {
  const server = await serve();
  try {
    const { status } = await server.post('/credentials/set', { ref: '  A_KEY  ', value: 'v' });
    assert.equal(status, 200);
    assert.equal(server.calls.set[0].payload.ref, 'A_KEY');
  } finally {
    await server.close();
  }
});

test('set：畸形请求本地 400，不打扰宿主', async () => {
  const server = await serve();
  try {
    const bad = [
      {},
      { value: 'v' },
      { ref: '', value: 'v' },
      { ref: '   ', value: 'v' },
      { ref: 7, value: 'v' },
      { ref: '9bad', value: 'v' },
      { ref: 'a b', value: 'v' },
      { ref: 'A_KEY' },
      { ref: 'A_KEY', value: '' },
      { ref: 'A_KEY', value: 7 },
      { ref: 'A_KEY', value: null },
      { ref: 'A_KEY', value: 'x'.repeat(8193) },
    ];
    for (const payload of bad) {
      const { status, body } = await server.post('/credentials/set', payload);
      assert.equal(status, 400, JSON.stringify(payload).slice(0, 60));
      assert.equal(body.error.code, 'bad-request');
    }
    assert.equal(server.calls.set.length, 0);
    // 正好 8192 个字符放行。
    const exact = await server.post('/credentials/set', { ref: 'A_KEY', value: 'x'.repeat(8192) });
    assert.equal(exact.status, 200);
    assert.equal(server.calls.set[0].payload.value.length, 8192);
  } finally {
    await server.close();
  }
});

test('set：宿主的 credential-rejected 原样透传（含 details）', async () => {
  const server = await serve({
    set: () => errValue({
      code: 'credential-rejected',
      message: 'credentials-local: "DEEPSEEK_API_KEY" is supplied read-only by the launching environment',
      details: { ref: 'DEEPSEEK_API_KEY' },
    }),
  });
  try {
    const { status, body } = await server.post('/credentials/set', { ref: 'DEEPSEEK_API_KEY', value: 'nope' });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'credential-rejected');
    assert.deepEqual(body.error.details, { ref: 'DEEPSEEK_API_KEY' });
    assert.match(body.error.message, /read-only by the launching environment/);
  } finally {
    await server.close();
  }
});

test('unset：信封精确，宿主对没设过的引用回 ok 也算成功', async () => {
  const server = await serve();
  try {
    const { status, body } = await server.post('/credentials/unset', { ref: 'A_KEY' });
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });
    assert.deepEqual(server.calls.unset[0], {
      rpcId: 'mobile',
      method: 'credentials.unset',
      payload: { ref: 'A_KEY' },
    });
    assert.equal(server.signals[0], undefined);
  } finally {
    await server.close();
  }
});

test('unset：畸形 ref 本地 400，宿主错误透传', async () => {
  const server = await serve();
  try {
    for (const payload of [{}, { ref: '' }, { ref: 7 }, { ref: 'has space' }]) {
      const { status, body } = await server.post('/credentials/unset', payload);
      assert.equal(status, 400, JSON.stringify(payload));
      assert.equal(body.error.code, 'bad-request');
    }
    assert.equal(server.calls.unset.length, 0);
  } finally {
    await server.close();
  }

  const failing = await serve({ unset: () => errValue({ code: 'credential-rejected', message: 'no', details: { ref: 'A_KEY' } }) });
  try {
    const { status, body } = await failing.post('/credentials/unset', { ref: 'A_KEY' });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'credential-rejected');
  } finally {
    await failing.close();
  }
});

test('normalizeRef / normalizeCredentialView 是纯函数', () => {
  assert.equal(normalizeRef('A_KEY'), 'A_KEY');
  assert.equal(normalizeRef('  A_KEY  '), 'A_KEY');
  assert.equal(normalizeRef('_x1'), '_x1');
  assert.equal(normalizeRef('9bad'), null);
  assert.equal(normalizeRef('a-b'), null);
  assert.equal(normalizeRef('a b'), null);
  assert.equal(normalizeRef(''), null);
  assert.equal(normalizeRef('   '), null);
  assert.equal(normalizeRef(7), null);
  assert.equal(normalizeRef(null), null);
  assert.equal(normalizeRef(undefined), null);
  assert.equal(normalizeRef('A'.repeat(129)), null);
  assert.equal(normalizeRef('A'.repeat(128)), 'A'.repeat(128));

  assert.deepEqual(normalizeCredentialView({ configured: true, writable: true }), { configured: true, writable: true });
  assert.deepEqual(normalizeCredentialView({ configured: false, writable: false, source: 'env' }), { configured: false, writable: false, source: 'env' });
  for (const bad of [null, undefined, 7, 'nope', [], [1]]) {
    assert.equal(normalizeCredentialView(bad), null, String(bad));
  }
});

test('credentialRefOf：从 schema 的 role 标记推导凭据引用', () => {
  const webSearch = {
    uid: 294,
    refs: {
      277: { type: 'string', meta: { role: 'secret' } },
      280: { type: 'string', meta: { role: 'credential-ref', default: 'DEEPSEEK_API_KEY' } },
      283: { type: 'string', meta: { default: 'deepseek-v4-flash' } },
      294: { type: 'object', meta: { default: {} }, dict: { apiKey: 277, apiKeyEnv: 280, model: 283 } },
    },
  };
  assert.deepEqual(credentialRefOf(webSearch, { apiKeyEnv: 'DEEPSEEK_API_KEY' }), { ref: 'DEEPSEEK_API_KEY', refField: 'apiKeyEnv' });
  // 值里没写就用 schema 的 default。
  assert.deepEqual(credentialRefOf(webSearch, {}), { ref: 'DEEPSEEK_API_KEY', refField: 'apiKeyEnv' });
  // 值里写了就以值为准。
  assert.deepEqual(credentialRefOf(webSearch, { apiKeyEnv: 'MY_KEY' }), { ref: 'MY_KEY', refField: 'apiKeyEnv' });
  // 空白值回落到 default。
  assert.deepEqual(credentialRefOf(webSearch, { apiKeyEnv: '   ' }), { ref: 'DEEPSEEK_API_KEY', refField: 'apiKeyEnv' });

  // 只有 credential-ref、没有 secret：这个命名空间没有可写的密钥槽。
  const llm = { uid: 9, refs: { 8: { type: 'string', meta: { role: 'credential-ref', default: 'DEEPSEEK_API_KEY' } }, 9: { type: 'object', dict: { apiKeyEnv: 8 } } } };
  assert.equal(credentialRefOf(llm, { apiKeyEnv: 'DEEPSEEK_API_KEY' }), null);
  // 有 secret 但没有 credential-ref（也没有 default）：推不出来。
  const noRef = { uid: 2, refs: { 1: { type: 'string', meta: { role: 'secret' } }, 2: { type: 'object', dict: { apiKey: 1 } } } };
  assert.equal(credentialRefOf(noRef, {}), null);

  // 两个密钥槽共用一个 credential-ref：引用是命名空间级的，写哪个都不对，宁可不给入口。
  const twoSecrets = {
    uid: 5,
    refs: {
      3: { type: 'string', meta: { role: 'secret' } },
      4: { type: 'string', meta: { role: 'secret' } },
      6: { type: 'string', meta: { role: 'credential-ref', default: 'DEEPSEEK_API_KEY' } },
      5: { type: 'object', dict: { apiKey: 3, backupKey: 4, apiKeyEnv: 6 } },
    },
  };
  assert.equal(credentialRefOf(twoSecrets, { apiKeyEnv: 'DEEPSEEK_API_KEY' }), null);

  for (const bad of [null, undefined, 7, 'nope', [], {}, { uid: 1 }, { uid: 1, refs: {} }, { uid: 1, refs: { 1: { dict: 'x' } } }, { uid: 1, refs: { 1: {} } }]) {
    assert.equal(credentialRefOf(bad, {}), null, JSON.stringify(bad));
  }
});

test('normalizeNamespace：只有既有密钥槽又推导得出引用时才给 credentialRef', () => {
  const schema = {
    uid: 294,
    refs: {
      277: { type: 'string', meta: { role: 'secret' } },
      280: { type: 'string', meta: { role: 'credential-ref', default: 'DEEPSEEK_API_KEY' } },
      294: { type: 'object', dict: { apiKey: 277, apiKeyEnv: 280 } },
    },
  };
  const withSecret = normalizeNamespace({
    ns: 'web-search-deepseek',
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
    applies: 'live',
    revision: 3,
    secrets: [{ path: ['apiKey'], set: false }],
    schema,
  });
  assert.equal(withSecret.credentialRef, 'DEEPSEEK_API_KEY');
  assert.deepEqual(withSecret.secrets, [{ path: 'apiKey', set: false }]);

  // 宿主没报密钥槽：即使 schema 里有 role 标记也不给。
  const noSlots = normalizeNamespace({
    ns: 'web-search-deepseek',
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
    applies: 'live',
    revision: 3,
    secrets: [],
    schema,
  });
  assert.equal('credentialRef' in noSlots, false);

  // schema 畸形：不给，但也不抛错。
  const badSchema = normalizeNamespace({
    ns: 'x',
    value: { apiKey: 'v' },
    applies: 'live',
    revision: 1,
    secrets: [{ path: ['apiKey'], set: true }],
    schema: 'nope',
  });
  assert.equal('credentialRef' in badSchema, false);
  assert.deepEqual(badSchema.secrets, [{ path: 'apiKey', set: true }]);
});

test('源码契约：三条路由都已注册，host-settings 导出 credentialRefOf', () => {
  const root = path.join(__dirname, '..');
  const index = readWiring();
  assert.match(index, /route\('\/api\/mobile\/v1\/credentials', mobileCredentials\.handleCredentialsDescribe\)/);
  assert.match(index, /route\('\/api\/mobile\/v1\/credentials\/set', mobileCredentials\.handleCredentialsSet\)/);
  assert.match(index, /route\('\/api\/mobile\/v1\/credentials\/unset', mobileCredentials\.handleCredentialsUnset\)/);
  assert.match(index, /require\('\.\.\/mobile\/credentials\.js'\)/);

  const source = fs.readFileSync(path.join(root, 'lib/mobile/credentials.js'), 'utf8');
  assert.match(source, /method: 'credentials\.describe'/);
  assert.match(source, /method: 'credentials\.set'/);
  assert.match(source, /method: 'credentials\.unset'/);
  assert.match(source, /CREDENTIAL_REF_PATTERN = \/\^\[A-Za-z_\]/);

  const settings = fs.readFileSync(path.join(root, 'lib/mobile/host-settings.js'), 'utf8');
  assert.match(settings, /function credentialRefOf\(schema, value\)/);
  assert.match(settings, /out\.credentialRef = credential\.ref/);
});

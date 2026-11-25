// 2026-11-26：一键导入的插件侧契约——整条渠道（含 Key）与手机该试的地址。
'use strict';

/**
 * `POST /channels/export`：把电脑上的一条自建渠道交给手机，给「本机 Agent → 新增渠道」
 * 的一键导入用。四条硬约束：
 *
 *  1. **只认自建那一类**：插件 / 宿主注册的提供方没有可搬的地址，也没有一把属于它的 Key。
 *  2. **Key 取不到不算导入失败**：宿主没注册 resolve、或者那把 Key 由启动环境变量提供时，
 *     如实回 `keySet:false`，用户自己填一次就完事。
 *  3. **本机地址要给出手机够得着的变体**：`127.0.0.1` 那种交给手机就是打到自己身上；
 *     同一端口 + 这台电脑的局域网地址才有机会通。
 *  4. **只按 id 取一条**：这不是「导出全部凭据」的口子。
 *
 * 驱动真实 handler（真 http 服务、真 req/res），不转写实现。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { readRouteTable } = require('./lib/wiring.cjs');
const { handleChannelExport, reachCandidatesOf } = require('../lib/mobile/channels.js');

const PROVIDERS = {
  'my-gateway': {
    displayName: '我的网关',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:11434',
    apiKeyEnv: 'OFM_MY_GATEWAY_KEY',
    models: [{ id: 'gpt-x', name: 'GPT X' }, { id: 'gpt-y', name: 'GPT Y' }],
  },
};

function ctxWith(options = {}) {
  return {
    apiProxy: {
      settings: {
        describe: async () => ({ result: { ok: true, value: { namespaces: [{ ns: 'llm-pi-ai', value: { providers: PROVIDERS } }] } } }),
      },
      credentials: {
        resolve: async () => {
          if (options.resolveMissing) return { result: { ok: false, error: { code: 'host-unavailable', message: '没注册' } } };
          return { result: { ok: true, value: { value: 'sk-imported', source: 'stored' } } };
        },
      },
    },
  };
}

async function serve(options = {}) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handleChannelExport(ctxWith(options), req, res)).catch((error) => {
      if (res.headersSent || res.writableEnded) return;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String(error && error.message) } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    post: async (body) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/mobile/v1/channels/export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('路由表登记了这一条（App 的 apiPaths 那条才有人答）', () => {
  assert.match(readRouteTable(), /route\('\/api\/mobile\/v1\/channels\/export'/);
});

test('导出一条自建渠道：名字、协议、地址、模型与 Key 一起给全', async () => {
  const api = await serve();
  try {
    const { status, body } = await api.post({ id: 'my-gateway' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.keySet, true);
    assert.equal(body.channel.name, '我的网关');
    assert.equal(body.channel.protocol, 'openai-completions');
    assert.equal(body.channel.baseUrl, 'http://127.0.0.1:11434');
    assert.deepEqual(body.channel.models.map((row) => row.id), ['gpt-x', 'gpt-y']);
    assert.equal(body.channel.apiKey, 'sk-imported');
  } finally { await api.close(); }
});

test('Key 取不到时如实说没有，整条渠道照样给（导入不该因为这一格失败）', async () => {
  const api = await serve({ resolveMissing: true });
  try {
    const { status, body } = await api.post({ id: 'my-gateway' });
    assert.equal(status, 200);
    assert.equal(body.keySet, false);
    assert.equal(body.channel.apiKey, undefined);
    assert.equal(body.channel.baseUrl, 'http://127.0.0.1:11434');
  } finally { await api.close(); }
});

test('不存在的 id 回 404，不把它当成「空渠道」导出去', async () => {
  const api = await serve();
  try {
    const { status, body } = await api.post({ id: 'not-there' });
    assert.equal(status, 404);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'channel-not-found');
  } finally { await api.close(); }
});

test('畸形 id 直接 400，不去问宿主', async () => {
  const api = await serve();
  try {
    const { status } = await api.post({ id: '../etc/passwd' });
    assert.equal(status, 400);
  } finally { await api.close(); }
});

test('本机地址补上这台电脑的局域网地址：只换主机，端口与路径原样', () => {
  const interfaces = { en0: [{ address: '192.168.1.5', family: 'IPv4', internal: false }] };
  assert.deepEqual(reachCandidatesOf('http://127.0.0.1:11434', interfaces), ['http://127.0.0.1:11434', 'http://192.168.1.5:11434']);
  assert.deepEqual(reachCandidatesOf('http://localhost:8080/v1', interfaces), ['http://localhost:8080/v1', 'http://192.168.1.5:8080/v1']);
});

test('公网地址不补变体，坏地址只回原样（手机侧按地址错处理）', () => {
  const interfaces = { en0: [{ address: '192.168.1.5', family: 'IPv4', internal: false }] };
  assert.deepEqual(reachCandidatesOf('https://api.example.com/v1', interfaces), ['https://api.example.com/v1']);
  assert.deepEqual(reachCandidatesOf('not a url', interfaces), ['not a url']);
});

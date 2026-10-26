'use strict';

/**
 * Agent 预设代理（GET /api/mobile/v1/agent-presets）的透传契约。
 *
 * 移动端如今只剩**列表与管理分区**（见 lib/mobile/agent-presets.js）：手机 composer 上的
 * 预设芯片下线后，App 不再给会话换档，一律吃宿主默认档。职责很窄但容易写错：
 *
 *  1. 宿主的 `agentPreset.list` 在没有 roster 时回的是**空列表**（不是错误），与
 *     `session.search` 的「未开启就报错」正相反 —— 空数组是合法的「没得选」，当失败处理
 *     会在正常部署上弹错误提示；
 *  2. 预设条目要洗干净：只认非空字符串 id，name/description 只在真的有值时透出，不让
 *     undefined / null 漏进 UI；
 *  3. authorable / hasDocument 非布尔一律当 false，别让 'yes' / 1 被当成「可以自己写预设」。
 *
 * 本测试驱动真实的 handleAgentPresets（不是转写实现）：起一个只挂它的真 http 服务，用真
 * req/res。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handleAgentPresets } = require('../lib/mobile/sessions.js');
const { readWiring } = require('./lib/wiring.cjs')

/** 起一个挂 handler 的真 http 服务，并记下宿主收到的每一次调用。 */
async function serve(impls = {}) {
  const calls = [];
  const listImpl = impls.list || (() => okValue({ presets: [], authorable: false, hasDocument: false }));
  const ctx = {
    apiProxy: {
      agentPresets: {
        list: async (request) => { calls.push(request); return listImpl(request); },
      },
    },
  };
  const server = http.createServer((req, res) => {
    // 复刻 lib/index.js 的 guarded()：handler 抛错就回 500 JSON。
    Promise.resolve(handleAgentPresets(ctx, req, res)).catch((error) => {
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
  return {
    calls,
    listUrl: `http://127.0.0.1:${port}/agent-presets`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const okValue = (value) => ({ result: { ok: true, value } });
const errValue = (error) => ({ result: { ok: false, error } });

test('列表：宿主预设原样透出，且携带标准的 RPC 信封', async () => {
  const host = await serve({
    list: () => okValue({
      presets: [
        { id: 'standard', trust: 'system', isDefault: true },
        { id: 'review', trust: 'user', isDefault: false, name: '代码评审', description: '只读审阅' },
      ],
      authorable: true,
      hasDocument: true,
    }),
  });
  try {
    const res = await fetch(host.listUrl);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      presets: [
        { id: 'standard', trust: 'system', isDefault: true },
        { id: 'review', trust: 'user', isDefault: false, name: '代码评审', description: '只读审阅' },
      ],
      authorable: true,
      hasDocument: true,
    });
    assert.deepEqual(host.calls[0], { rpcId: 'mobile', method: 'agentPreset.list', payload: {} });
  } finally {
    await host.close();
  }
});

test('列表：畸形预设条目丢干净，缺省的 name/description 不臆造', async () => {
  const host = await serve({
    list: () => okValue({
      presets: [
        null,
        'standard',
        { id: '' },
        { id: 'ok', trust: 'user', isDefault: 'yes', name: '', description: 7, broken: true },
      ],
      authorable: 'yes',
      hasDocument: 1,
    }),
  });
  try {
    const body = await (await fetch(host.listUrl)).json();
    assert.deepEqual(body.presets, [
      { id: 'ok', trust: 'user', isDefault: false, broken: true },
    ]);
    assert.equal(body.authorable, false);
    assert.equal(body.hasDocument, false);
  } finally {
    await host.close();
  }
});

test('列表：宿主没有 roster 时是空列表，不是错误', async () => {
  const host = await serve({
    list: () => okValue({ presets: [], authorable: false, hasDocument: false }),
  });
  try {
    const res = await fetch(host.listUrl);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, presets: [], authorable: false, hasDocument: false });
  } finally {
    await host.close();
  }
});

test('列表：宿主报错原样透出，不当成空列表', async () => {
  const host = await serve({
    list: () => errValue({ code: 'internal', message: 'agent preset roster failed' }),
  });
  try {
    const res = await fetch(host.listUrl);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'internal');
    assert.equal(body.error.message, 'agent preset roster failed');
    assert.equal('presets' in body, false);
  } finally {
    await host.close();
  }
});

test('列表：宿主返回空响应体 → 400 internal（不是 500 崩溃）', async () => {
  const host = await serve({ list: () => undefined });
  try {
    const res = await fetch(host.listUrl);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'internal');
  } finally {
    await host.close();
  }
});

test('接线：列表路由与导出都在（少一个 App 就只会拿到 404）', () => {
  const root = path.join(__dirname, '..');
  const index = readWiring();
  const sessions = fs.readFileSync(path.join(root, 'lib', 'mobile', 'sessions.js'), 'utf8');
  assert.ok(index.includes("route('/api/mobile/v1/agent-presets', sessions.handleAgentPresets)"), '缺列表路由');
  // 断言真实导出面，而不是导出表里某两行挨不挨着——那只是文件布局，一改就红而行为没变。
  assert.equal(typeof require('../lib/mobile/sessions.js').handleAgentPresets, 'function', 'handler 未导出');
  // 会话列表要带上定档预设，App 才有「当前是哪一档」可显示。
  assert.ok(sessions.includes('...(typeof s.agentPreset === \'string\' && s.agentPreset ? { agentPreset: s.agentPreset } : {}),'), '会话列表未带 agentPreset');
});

test('死路由：换档入口下线后不再挂 select-agent-preset', () => {
  const root = path.join(__dirname, '..');
  const index = readWiring();
  const sessions = fs.readFileSync(path.join(root, 'lib', 'mobile', 'sessions.js'), 'utf8');
  assert.ok(!index.includes('select-agent-preset'), '换档路由又挂回来了，但 App 侧已经没有调用方');
  assert.ok(!sessions.includes('handleSelectAgentPreset'), '换档 handler 又活过来了');
});

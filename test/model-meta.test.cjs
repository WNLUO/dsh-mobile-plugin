'use strict';

/**
 * 模型能力配置的移动端契约（GET /model-meta、POST /model-meta/apply）。
 *
 * 这一层能改的是**宿主上的模型配置**，所以钉四件事：
 *
 *  1. **名字按折叠匹配**：`Claude-Sonnet-4.5`、`anthropic/claude-sonnet-4-5`、`claude sonnet 4 5（中转）`
 *     都落到同一条；查不到就是查不到，不猜后缀。`reasoning: []`（查到、明确不思考）与
 *     「没这个键」（没资料）必须分得开。
 *  2. **写只到 `providers.<id>`**：与渠道保存同一条边界，整段覆盖会把用户手写的其它路由抹掉。
 *  3. **只写这一条模型的能力字段**：地址 / 协议 / Key 引用 / 别的模型原样保留。
 *  4. **内置渠道一律 409**：不归本机配置的 provider 不给一条点了必然失败的路。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  handleModelMeta,
  handleModelMetaApply,
  normalizeApply,
  mergeModel,
  capabilityOf,
} = require('../lib/mobile/model-caps.js');
const modelMeta = require('../lib/mobile/model-meta.js');

/** 密集使用的那几条：公开表里一定有。 */
const KNOWN = 'claude-sonnet-4-5';

function fixture() {
  return {
    settings: {
      ns: 'llm-pi-ai',
      value: {
        providers: {
          'my-gateway': {
            displayName: '我的网关',
            api: 'openai-completions',
            baseURL: 'https://gw.example.com',
            apiKeyEnv: 'OFM_MY_GATEWAY_KEY',
            models: [
              { id: 'gpt-x', name: 'GPT X' },
              { id: KNOWN, name: 'Claude Sonnet 4.5', contextWindow: 200000, maxTokens: 64000, input: ['text', 'image'] },
            ],
            unknownField: { keep: true },
          },
        },
      },
    },
  };
}

async function serve(options = {}) {
  const calls = [];
  const state = options.state || fixture();
  const ctx = {
    apiProxy: {
      settings: {
        describe: async (request) => {
          calls.push({ method: 'settings.describe', request });
          if (options.describeError) return { result: { ok: false, error: { code: 'settings-unavailable', message: 'no' } } };
          return { result: { ok: true, value: { namespaces: [state.settings] } } };
        },
        mutate: async (request) => {
          calls.push({ method: 'settings.mutate', request });
          if (options.mutateError) return { result: { ok: false, error: { code: 'settings-rejected', message: '拒绝写入' } } };
          const op = request.payload.ops[0];
          state.settings.value.providers[op.path[1]] = op.value;
          return { result: { ok: true, value: state.settings } };
        },
      },
    },
  };
  const server = http.createServer((req, res) => {
    const handler = req.url.startsWith('/api/mobile/v1/model-meta/apply') ? handleModelMetaApply : handleModelMeta;
    handler(ctx, req, res).catch((error) => {
      res.writeHead(500);
      res.end(String(error && error.stack ? error.stack : error));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { ctx, calls, state, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function getJson(base, path) {
  const answer = await fetch(`${base}${path}`);
  return { status: answer.status, body: await answer.json() };
}

async function postJson(base, path, body) {
  const answer = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: answer.status, body: await answer.json() };
}

// ---------------------------------------------------------------------------
// 一、折叠匹配
// ---------------------------------------------------------------------------

test('折叠键：大小写、符号、厂商前缀都落到同一条', () => {
  assert.equal(modelMeta.foldKey('Claude-Sonnet-4.5'), modelMeta.foldKey('claude_sonnet_4_5'));
  assert.equal(modelMeta.foldKey('anthropic/claude-sonnet-4-5'), modelMeta.foldKey('Claude Sonnet 4.5'));
  // 完全不同的名字不许撞在一起。
  assert.notEqual(modelMeta.foldKey('gpt-4o'), modelMeta.foldKey('gpt-4o-mini'));
});

test('名字后面带一句括号备注也认（只剥结尾那段）', () => {
  assert.equal(modelMeta.withoutTrailingBrackets('claude-sonnet-4-5（中转）'), 'claude-sonnet-4-5');
  assert.equal(modelMeta.withoutTrailingBrackets('gpt-4o (free) [test]'), 'gpt-4o');
  const hit = modelMeta.lookupModelMeta('Claude-Sonnet-4-5（中转站）');
  assert.ok(hit && hit.contextWindow > 0);
  // 真变体不剥：`-preview` 不是备注。
  assert.equal(modelMeta.withoutTrailingBrackets('claude-sonnet-4-5-preview'), 'claude-sonnet-4-5-preview');
});

test('查得到的那条带公开参数，查不到回 undefined（不是空对象）', () => {
  const hit = modelMeta.lookupModelMeta('Anthropic/Claude-Sonnet-4.5');
  assert.ok(hit, '公开表里应该有 claude-sonnet-4-5');
  assert.ok(Number.isInteger(hit.contextWindow) && hit.contextWindow > 0);
  assert.ok(Number.isInteger(hit.maxTokens) && hit.maxTokens < hit.contextWindow);
  assert.equal(modelMeta.lookupModelMeta('definitely-not-a-real-model-xyz'), undefined);
});

test('「查到了、明确不思考」是空数组，与「没资料」分开', () => {
  const nonThinking = modelMeta.lookupModelMeta('gpt-4o');
  assert.ok(nonThinking && Array.isArray(nonThinking.reasoning), 'gpt-4o 在公开表里是「明确不思考」');
  assert.equal(nonThinking.reasoning.length, 0);
  assert.equal(modelMeta.lookupModelMeta('definitely-not-a-real-model-xyz'), undefined);
});

test('搜索：完全相等的排最前，其次是前缀', () => {
  const hits = modelMeta.searchModelMeta('claude-sonnet-4-5', 10);
  assert.ok(hits.length > 0);
  assert.equal(hits[0].id, 'claudesonnet45');
  const prefix = modelMeta.searchModelMeta('claude sonnet 4', 10);
  assert.ok(prefix.length >= 1 && prefix[0].id.startsWith('claudesonnet4'));
  assert.deepEqual(modelMeta.searchModelMeta('   ', 10), []);
});

test('整份表带修订号与条数（App 靠修订号判断缓存要不要重拉）', () => {
  const full = modelMeta.fullModelMeta();
  assert.equal(typeof full.revision, 'string');
  assert.ok(full.revision.length > 0);
  assert.equal(full.total, modelMeta.size);
  assert.ok(full.total > 1000, `快照条目太少：${full.total}`);
  assert.ok(full.items[modelMeta.foldKey(KNOWN)]);
});

// ---------------------------------------------------------------------------
// 二、参数校验
// ---------------------------------------------------------------------------

test('一次提交只带用户真给了的字段', () => {
  const ok = normalizeApply({ provider: 'p', model: 'm', contextWindow: 128000 });
  assert.deepEqual(ok.patch, { contextWindow: 128000 });
  assert.equal(normalizeApply({ provider: '', model: 'm', contextWindow: 1 }).error.code, 'bad-request');
  assert.equal(normalizeApply({ provider: 'p', model: 'm' }).error.code, 'bad-request');
});

test('数值必须是正整数，输出上限必须小于上下文', () => {
  assert.equal(normalizeApply({ provider: 'p', model: 'm', contextWindow: -1 }).error.code, 'bad-request');
  assert.equal(normalizeApply({ provider: 'p', model: 'm', maxTokens: 1.5 }).error.code, 'bad-request');
  assert.equal(normalizeApply({ provider: 'p', model: 'm', contextWindow: 100, maxTokens: 200 }).error.message, '输出上限必须小于上下文窗口');
});

test('推理档位只认四档，重复的收一次', () => {
  assert.deepEqual(normalizeApply({ provider: 'p', model: 'm', reasoning: ['high', 'low', 'high'] }).patch.reasoning, ['low', 'high']);
  assert.equal(normalizeApply({ provider: 'p', model: 'm', reasoning: ['xhigh'] }).error.code, 'bad-request');
  assert.deepEqual(normalizeApply({ provider: 'p', model: 'm', reasoning: [] }).patch.reasoning, []);
});

test('合并只动这一条模型的能力字段', () => {
  const model = { id: 'm', name: 'M', contextWindow: 100000, input: ['text'] };
  const merged = mergeModel(model, { maxTokens: 8000, vision: true, reasoning: ['low', 'high'] });
  assert.equal(merged.id, 'm');
  assert.equal(merged.name, 'M');
  assert.equal(merged.contextWindow, 100000);
  assert.equal(merged.maxTokens, 8000);
  assert.deepEqual(merged.input, ['text', 'image']);
  assert.deepEqual(merged.reasoningEfforts, { low: 'low', high: 'high' });
  // 清空档位 = 明确不思考（pi-ai 的口径）。
  assert.equal(mergeModel(model, { reasoning: [] }).reasoningEfforts, false);
  assert.equal(capabilityOf({ contextWindow: 1, maxTokens: 1 }).vision, undefined);
  assert.deepEqual(capabilityOf({ reasoningEfforts: false }).reasoning, []);
});

// ---------------------------------------------------------------------------
// 三、两条路由（真 http）
// ---------------------------------------------------------------------------

test('GET /model-meta 回整份快照，并带上这台电脑已写下的能力值', async () => {
  const app = await serve();
  try {
    const { status, body } = await getJson(app.base, '/api/mobile/v1/model-meta');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.revision, 'string');
    assert.ok(body.total > 1000);
    assert.ok(body.items[modelMeta.foldKey(KNOWN)]);
    const override = body.overrides[`my-gateway\u0001${KNOWN}`];
    assert.ok(override, '自建渠道里已经写下的能力要带回去');
    assert.equal(override.contextWindow, 200000);
    assert.equal(override.vision, true);
  } finally {
    await app.close();
  }
});

test('GET /model-meta?q= 只回这一搜的结果', async () => {
  const app = await serve();
  try {
    const { status, body } = await getJson(app.base, '/api/mobile/v1/model-meta?q=claude-sonnet-4-5&limit=5');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items) && body.items.length > 0 && body.items.length <= 5);
    assert.equal(body.items[0].id, 'claudesonnet45');
    assert.equal(typeof body.total, 'undefined', '搜索不带整份表');
  } finally {
    await app.close();
  }
});

test('apply：只 set 这一条 providers.<id>，其它字段原样保留', async () => {
  const app = await serve();
  try {
    const { status, body } = await postJson(app.base, '/api/mobile/v1/model-meta/apply', {
      provider: 'my-gateway',
      model: KNOWN,
      contextWindow: 150000,
      maxTokens: 32000,
      vision: false,
      reasoning: ['low', 'high'],
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    const writes = app.calls.filter((call) => call.method === 'settings.mutate');
    assert.equal(writes.length, 1);
    const payload = writes[0].request.payload;
    assert.equal(payload.ns, 'llm-pi-ai');
    assert.equal(payload.ops.length, 1);
    assert.equal(payload.ops[0].op, 'set');
    assert.deepEqual(payload.ops[0].path, ['providers', 'my-gateway']);
    const profile = payload.ops[0].value;
    assert.equal(profile.baseURL, 'https://gw.example.com');
    assert.equal(profile.apiKeyEnv, 'OFM_MY_GATEWAY_KEY');
    assert.deepEqual(profile.unknownField, { keep: true });
    const target = profile.models.find((model) => model.id === KNOWN);
    assert.equal(target.contextWindow, 150000);
    assert.equal(target.maxTokens, 32000);
    assert.deepEqual(target.input, ['text']);
    assert.deepEqual(target.reasoningEfforts, { low: 'low', high: 'high' });
    // 别的模型一个字段都不许动。
    assert.deepEqual(profile.models.find((model) => model.id === 'gpt-x'), { id: 'gpt-x', name: 'GPT X' });
  } finally {
    await app.close();
  }
});

test('apply：内置渠道回 409，且不产生任何写', async () => {
  const app = await serve();
  try {
    const { status, body } = await postJson(app.base, '/api/mobile/v1/model-meta/apply', { provider: 'buddy', model: 'x', contextWindow: 1000 });
    assert.equal(status, 409);
    assert.equal(body.error.code, 'model-meta-external');
    assert.equal(app.calls.filter((call) => call.method === 'settings.mutate').length, 0);
  } finally {
    await app.close();
  }
});

test('apply：渠道里没有这个模型回 404', async () => {
  const app = await serve();
  try {
    const { status, body } = await postJson(app.base, '/api/mobile/v1/model-meta/apply', { provider: 'my-gateway', model: 'nope', contextWindow: 1000 });
    assert.equal(status, 404);
    assert.equal(body.error.code, 'not-found');
  } finally {
    await app.close();
  }
});

test('apply：输出上限大于等于上下文时拒绝（不写盘）', async () => {
  const app = await serve();
  try {
    const { status, body } = await postJson(app.base, '/api/mobile/v1/model-meta/apply', {
      provider: 'my-gateway',
      model: KNOWN,
      contextWindow: 1000,
      maxTokens: 5000,
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'bad-request');
    assert.equal(app.calls.filter((call) => call.method === 'settings.mutate').length, 0);
  } finally {
    await app.close();
  }
});

test('apply：宿主拒绝写入时把错误原样交回去', async () => {
  const app = await serve({ mutateError: true });
  try {
    const { status, body } = await postJson(app.base, '/api/mobile/v1/model-meta/apply', { provider: 'my-gateway', model: KNOWN, contextWindow: 150000 });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'settings-rejected');
  } finally {
    await app.close();
  }
});

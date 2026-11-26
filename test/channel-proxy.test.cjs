// 2026-11-27：明确的工具拒绝回专用短码，400 但不涉及工具仍是通用失败。
// 2026-11-26：补上「自建渠道查不到退回 DSH 当前渠道」那一组的契约。
// 2026-11-26：经电脑转发模型请求的契约——只转发对话那一层，地址与 Key 用宿主自己那份。
'use strict';

/**
 * `POST /channels/chat`：手机拨不到的渠道（跑在这台电脑上的 Ollama、内网服务）由电脑代发。
 *
 * 这一条能出的错都很难看出来，所以钉五条：
 *  1. **只转对话**：请求体只带 OpenAI 兼容的几样，手机塞进来的地址 / Key / 流开关一律不认。
 *  2. **地址与 Key 用宿主那份**：上游收到的 Authorization 是电脑上那把，URL 是电脑上那条。
 *  3. **上游的每条 data 原样成帧**：手机解析的就是直连时的同一套 chunk。
 *  4. **上游失败把状态码带回去**：401 还是鉴权失败，不能被压成「电脑出错了」。
 *  5. **中途断流补一帧错误**：否则手机只会看到一个没有结束标记的空回复。
 *
 * 驱动真实 handler（真 http 服务、真 req/res），上游也是真的 http 服务。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { readRouteTable } = require('./lib/wiring.cjs');
const { handleChannelChat, chatCompletionUrlOf, upstreamBodyOf, createRecordSplitter, dshMessagesOf } = require('../lib/mobile/channel-proxy.js');

const PROVIDERS = {
  'my-gateway': {
    displayName: '我的网关',
    api: 'openai-completions',
    baseURL: '', // 每个用例换成上游地址
    apiKeyEnv: 'OFM_MY_GATEWAY_KEY',
    models: [{ id: 'gpt-x', name: 'GPT X' }],
  },
};

function ctxOf(baseURL, options = {}) {
  PROVIDERS['my-gateway'].baseURL = baseURL;
  return {
    apiProxy: {
      settings: {
        describe: async () => ({ result: { ok: true, value: { namespaces: [{ ns: 'llm-pi-ai', value: { providers: PROVIDERS } }] } } }),
      },
      credentials: {
        resolve: async () => (options.noKey
          ? { result: { ok: true, value: undefined } }
          : { result: { ok: true, value: { value: 'sk-host', source: 'stored' } } }),
      },
    },
    // 老宿主没有 llm 服务时只让「退回 DSH」那一路 503，自建渠道那一路不受影响。
    get: (name) => (name === 'llm' ? options.llm || null : null),
  };
}

/** 上游：记下请求体与头，按剧本回 SSE。 */
async function upstream(script) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* 非 JSON 也记下来 */ }
      seen.push({ url: req.url, headers: req.headers, body, raw });
      script(req, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { seen, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function serve(upstreamBase, options = {}) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handleChannelChat(ctxOf(upstreamBase, options), req, res)).catch((error) => {
      if (res.headersSent) { try { res.end(); } catch { /* 已收 */ } return; }
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { message: String(error && error.message) } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    post: async (body) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/mobile/v1/channels/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, text: await res.text(), headers: res.headers };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 从回给手机的那段 SSE 里取出每条 `data:` 的 JSON。 */
function framesOf(text) {
  return text
    .split(/\n\n/)
    .map((record) => record.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join(''))
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('路由表登记了这一条', () => {
  assert.match(readRouteTable(), /route\('\/api\/mobile\/v1\/channels\/chat'/);
});

test('上游的每条 data 原样成帧回给手机，请求只带对话本身', async () => {
  const up = await upstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
    res.end('data: [DONE]\n\n');
  });
  const api = await serve(up.base);
  try {
    const { status, text } = await api.post({
      id: 'my-gateway',
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'hi' }],
      // 手机塞的东西一律不认
      baseUrl: 'http://127.0.0.1:1/evil',
      apiKey: 'sk-phone',
      stream: false,
    });
    assert.equal(status, 200);
    assert.deepEqual(framesOf(text).map((frame) => frame.choices[0].delta.content), ['你', '好']);
    const sent = up.seen[0];
    assert.equal(sent.url, '/v1/chat/completions');
    assert.equal(sent.headers.authorization, 'Bearer sk-host');
    assert.equal(sent.body.stream, true);
    assert.equal(sent.body.model, 'gpt-x');
    assert.equal(sent.body.baseUrl, undefined);
    assert.equal(sent.body.apiKey, undefined);
  } finally { await api.close(); await up.close(); }
});

test('上游 401 把状态码带回去（鉴权失败不能被压成「电脑出错了」）', async () => {
  const up = await upstream((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"bad key"}}');
  });
  const api = await serve(up.base);
  try {
    const { status, text } = await api.post({ id: 'my-gateway', model: 'gpt-x', messages: [] });
    assert.equal(status, 401);
    assert.match(text, /bad key/);
  } finally { await api.close(); await up.close(); }
});

// 需求变更（2026-11-26）：原先「查不到就 404」，现在查不到要退回 DSH 自己的模型服务，
// 否则当前 DSH 渠道（宿主 / 插件注册的那种）永远没法经电脑代发。下面这组钉住新口径。
test('自建渠道查不到时退回 DSH 当前渠道，增量翻成手机认得的 chunk', async () => {
  const seen = [];
  const llm = {
    stream: async function* (options) {
      seen.push(options);
      yield { type: 'text-delta', text: '你' };
      yield { type: 'reasoning-delta', text: '想' };
      yield { type: 'text-delta', text: '好' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const up = await upstream((_req, res) => { res.writeHead(200); res.end(); });
  const api = await serve('', { llm });
  try {
    const { status, text } = await api.post({
      id: 'group',
      model: 'hy',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'read', description: '读文件', parameters: { type: 'object' } } }],
      maxTokens: 64,
    });
    assert.equal(status, 200);
    const frames = framesOf(text);
    assert.deepEqual(frames.map((frame) => frame.choices?.[0]?.delta).filter(Boolean), [
      { content: '你' }, { reasoning_content: '想' }, { content: '好' }, {},
    ]);
    assert.equal(seen[0].provider, 'group');
    assert.equal(seen[0].model, 'hy');
    assert.equal(seen[0].maxTokens, 64);
    assert.deepEqual(seen[0].tools, [{ name: 'read', description: '读文件', parameters: { type: 'object' } }]);
    assert.deepEqual(seen[0].messages[0].content, [{ type: 'text', text: 'hi' }]);
    assert.equal(up.seen.length, 0, '退回 DSH 时不该再打自建渠道的地址');
  } finally { await api.close(); await up.close(); }
});

test('工具结果与 assistant 工具调用翻成 DSH 的形状', () => {
  const messages = dshMessagesOf([
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"p":"a"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '正文' },
  ], 'group', 'hy');
  assert.deepEqual(messages[0].content, [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"p":"a"}' }]);
  assert.deepEqual(messages[1].content, [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '正文' }] }]);
});

test('DSH 的失败块翻成短码，手机不必再猜', async () => {
  const llm = {
    stream: async function* () {
      yield { type: 'text-delta', text: '半' };
      yield { type: 'finish', reason: { kind: 'error', failure: { status: 401, code: 'auth' } } };
    },
  };
  const api = await serve('', { llm });
  try {
    const { text } = await api.post({ id: 'group', model: 'hy', messages: [] });
    const frames = framesOf(text);
    assert.ok(frames.some((frame) => frame.choices), '已经收到的正文照旧给手机');
    assert.ok(frames.some((frame) => frame.dshError?.code === 'http-401'), '401 不能被压成通用失败');
  } finally { await api.close(); }
});

test('上游明确拒绝 tools 时回专用短码，普通 400 不误判', async () => {
  const toolReject = {
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { status: 400, message: 'unsupported parameter: tools' } } };
    },
  };
  const api = await serve('', { llm: toolReject });
  try {
    const { text } = await api.post({ id: 'group', model: 'hy', messages: [], tools: [{ name: 't', description: '', parameters: {} }] });
    assert.ok(framesOf(text).some((frame) => frame.dshError?.code === 'tools-unsupported'), '工具拒绝要回专用短码');
  } finally { await api.close(); }
});

test('400 但没提工具仍按通用失败，不让降级误伤', async () => {
  const bad = {
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { status: 400, message: 'bad request' } } };
    },
  };
  const api = await serve('', { llm: bad });
  try {
    const { text } = await api.post({ id: 'group', model: 'hy', messages: [], tools: [{ name: 't', description: '', parameters: {} }] });
    assert.ok(!framesOf(text).some((frame) => frame.dshError?.code === 'tools-unsupported'), '普通 400 不能记成不支持工具');
  } finally { await api.close(); }
});

test('电脑上没有模型服务时回 503，不假装渠道可用', async () => {
  const api = await serve('');
  try {
    const { status, text } = await api.post({ id: 'group', model: 'hy', messages: [] });
    assert.equal(status, 503);
    assert.match(text, /host-llm-unavailable/);
  } finally { await api.close(); }
});

test('没配 Key 时不发 Authorization（本地无鉴权端点照样能用）', async () => {
  const up = await upstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
  });
  const api = await serve(up.base, { noKey: true });
  try {
    await api.post({ id: 'my-gateway', model: 'gpt-x', messages: [] });
    assert.equal(up.seen[0].headers.authorization, undefined);
  } finally { await api.close(); await up.close(); }
});

test('上游中途断流补一帧 dshError（手机不会把空回复当成功）', async () => {
  const up = await upstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"半"}}]}\n\n');
    setTimeout(() => res.destroy(), 20);
  });
  const api = await serve(up.base);
  try {
    const { text } = await api.post({ id: 'my-gateway', model: 'gpt-x', messages: [] });
    const frames = framesOf(text);
    assert.ok(frames.some((frame) => frame.choices), '应当转发到已经收到的正文');
    assert.ok(frames.some((frame) => frame.dshError), '应当补一帧 dshError');
  } finally { await api.close(); await up.close(); }
});

test('地址拼法与提示：写了 /v1 就不再补，没写就补上', () => {
  assert.equal(chatCompletionUrlOf('https://api.x.com'), 'https://api.x.com/v1/chat/completions');
  assert.equal(chatCompletionUrlOf('https://api.x.com/v1/'), 'https://api.x.com/v1/chat/completions');
  assert.equal(chatCompletionUrlOf(''), '');
});

test('上游请求体只留对话需要的字段', () => {
  const body = upstreamBodyOf({ messages: [{ role: 'user', content: 'x' }], tools: [{ name: 't' }], toolChoice: 'auto', maxTokens: 32, temperature: 0.2, junk: 1 }, 'm');
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'stream', 'temperature', 'tool_choice', 'tools']);
  assert.equal(body.tool_choice, 'auto');
});

test('SSE 切记录：跨块也能切开，注释行不算帧', () => {
  const seen = [];
  const push = createRecordSplitter((record) => seen.push(record));
  push('data: {"a":1}\n');
  push('\ndata: {"b"');
  push(':2}\n\n');
  assert.deepEqual(seen, ['data: {"a":1}', 'data: {"b":2}']);
});

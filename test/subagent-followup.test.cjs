'use strict';

/**
 * 子代理续话 / 打断代理（POST /api/mobile/v1/subagents/prompt、/subagents/interrupt）
 * 的透传契约。
 *
 * 手机端的输入框平时只发 session.send，而宿主对**子会话**的 session.prompt 一律回
 * agent-busy（"use subagent delivery for this child session"）；给「可继续」子代理发
 * 消息必须换 subagent.prompt，打断必须换 subagent.interrupt。这个代理的每一条规则
 * 都对应一个真机才会暴露的坑：
 *
 *  1. 两个 id 都是必填：宿主 payload 是 `{ parentSessionId, childSessionId }`，
 *     缺了会被宿主报 invalid payload；代理应该在本地就 400，别把请求发出去；
 *  2. prompt 的签名是 `prompt(request, signal)`（**有** signal 形参），与
 *     subagent.list 一样必须显式传一个 AbortController 的 signal —— 宿主内部
 *     `isAborted(signal)` 直接 `return signal.aborted`，不传 undefined 会 500；
 *     而 interrupt 的签名是 `interrupt(request)`（**没有** signal），多传一个参数
 *     不会报错，但会让人误以为它有取消语义，所以源码契约里钉住「interrupt 不传」；
 *  3. mode 固定 'continuable'：一次性子代理宿主压根不收续话（桌面端也是先判
 *     one-shot 再本地拒绝），不给客户端挑的机会；
 *  4. 图片一律拒绝，且报 attachment-error / SUBAGENT_IMAGE_UNSUPPORTED —— 与桌面端
 *     runtime 的本地判定同一个 code/reason。runtime 只把 text 块 flatMap 出去，
 *     图片根本到不了宿主，这里跟着拒，免得静默丢块让用户以为图发出去了；
 *  5. 宿主的 `{ messageId }` 不透传：手机端自己生成乐观行的 clientMessageId，
 *     多回一个用不上的字段只会让 App 侧契约漂移。
 *
 * 本测试驱动真实的 handler（不是转写实现）：起一个只挂它们的真 http 服务，用真 req/res。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { readWiring } = require('./lib/wiring.cjs')
const {
  handleSubagentPrompt,
  handleSubagentInterrupt,
  normalizePromptContent,
} = require('../lib/mobile/subagents.js');

const PROMPT_ROUTE = '/subagents/prompt';
const INTERRUPT_ROUTE = '/subagents/interrupt';

/**
 * 起一个只挂两个 handler 的真 http 服务，并记下宿主收到的每一次调用。
 * interrupt 那侧额外记 `argCounts` —— 宿主只声明一个形参，多传 signal 要能发现。
 */
async function serve(promptImpl, interruptImpl) {
  const prompts = [];
  const promptSignals = [];
  const interrupts = [];
  const interruptArgCounts = [];
  const ctx = {
    apiProxy: {
      // 命名空间是复数 subagents（真宿主 apiProxy.subagents.prompt / .interrupt），
      // 而 RPC 方法名是单数 subagent.prompt / subagent.interrupt —— 宿主两处不对称。
      // 假 ctx 写成单数时 handler 也能全绿，只有真机才会 500，所以照抄真名。
      subagents: {
        prompt: async (request, signal) => {
          prompts.push(request);
          promptSignals.push(signal);
          return promptImpl ? promptImpl(request, signal) : okValue({ messageId: 'm-1' });
        },
        interrupt: async (...args) => {
          interrupts.push(args[0]);
          interruptArgCounts.push(args.length);
          return interruptImpl ? interruptImpl(args[0]) : okValue({ accepted: true });
        },
      },
    },
  };
  const server = http.createServer((req, res) => {
    const handler = req.url.startsWith(PROMPT_ROUTE) ? handleSubagentPrompt : handleSubagentInterrupt;
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
  const post = (route, body) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return {
    prompts,
    promptSignals,
    interrupts,
    interruptArgCounts,
    prompt: (body) => post(PROMPT_ROUTE, body),
    interrupt: (body) => post(INTERRUPT_ROUTE, body),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const okValue = (value) => ({ result: { ok: true, value } });
const errValue = (error) => ({ result: { ok: false, error } });
const PAIR = { parentSessionId: 'session-parent', childSessionId: 'child-1' };

test('续话：真实形状透传，回 accepted，宿主的 messageId 不透传', async () => {
  const host = await serve(() => okValue({ messageId: 'm-should-not-leak' }));
  try {
    const res = await host.prompt({ ...PAIR, content: [{ type: 'text', text: '继续一下' }] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, accepted: true });
    assert.equal(body.messageId, undefined, '宿主 messageId 不该漏给 App');
  } finally {
    await host.close();
  }
});

test('续话：请求信封与 method 精确，且传了取消信号', async () => {
  const host = await serve();
  try {
    const res = await host.prompt({
      ...PAIR,
      content: [{ type: 'text', text: 'hello' }],
    });
    assert.equal(res.status, 200);
    assert.equal(host.prompts.length, 1);
    assert.deepEqual(host.prompts[0], {
      rpcId: 'mobile',
      method: 'subagent.prompt',
      payload: {
        parentSessionId: 'session-parent',
        childSessionId: 'child-1',
        mode: 'continuable',
        content: [{ type: 'text', text: 'hello' }],
      },
    });
    // 宿主 subagents.prompt 的签名是 prompt(request, signal)：必须传一个真 signal。
    assert.ok(host.promptSignals[0], '必须传取消信号');
    assert.equal(typeof host.promptSignals[0].aborted, 'boolean');
  } finally {
    await host.close();
  }
});

test('续话：缺 id 直接 400，且不打扰宿主', async () => {
  const host = await serve();
  try {
    const cases = [
      {},
      { parentSessionId: 'session-parent' },
      { childSessionId: 'child-1' },
      { parentSessionId: '', childSessionId: 'child-1' },
      { parentSessionId: 'session-parent', childSessionId: '   ' },
      { parentSessionId: 7, childSessionId: 'child-1' },
      { parentSessionId: 'session-parent', childSessionId: null },
      { parentSessionId: 'session-parent', childSessionId: 'child-1', content: [] },
    ];
    for (const [index, body] of cases.entries()) {
      const res = await host.prompt(body);
      assert.equal(res.status, 400, `case#${index} ${JSON.stringify(body)}`);
      const out = await res.json();
      assert.equal(out.ok, false);
      assert.equal(out.error.code, 'bad-request');
      // 最后一条 id 齐全但 content 为空，报的是另一句；其余都是缺 id。
      assert.equal(
        out.error.message,
        index === cases.length - 1 ? 'content 不能为空' : '需要 { parentSessionId, childSessionId, content | text }',
        `case#${index}`,
      );
      assert.equal(out.accepted, undefined);
    }
    assert.equal(host.prompts.length, 0, '缺 id 不该调用宿主');
  } finally {
    await host.close();
  }
});

test('续话：两个 id 两侧空白被 trim 后再发给宿主', async () => {
  const host = await serve();
  try {
    const res = await host.prompt({
      parentSessionId: '  session-x  ',
      childSessionId: '  child-y  ',
      text: 'hi',
    });
    assert.equal(res.status, 200);
    assert.equal(host.prompts[0].payload.parentSessionId, 'session-x');
    assert.equal(host.prompts[0].payload.childSessionId, 'child-y');
  } finally {
    await host.close();
  }
});

test('续话：text 简写变成一条 text 块', async () => {
  const host = await serve();
  try {
    const res = await host.prompt({ ...PAIR, text: '走简写' });
    assert.equal(res.status, 200);
    assert.deepEqual(host.prompts[0].payload.content, [{ type: 'text', text: '走简写' }]);
  } finally {
    await host.close();
  }
});

test('续话：content 数组里多个 text 块原样透传', async () => {
  const host = await serve();
  try {
    const res = await host.prompt({
      ...PAIR,
      content: [
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' },
      ],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(host.prompts[0].payload.content, [
      { type: 'text', text: '第一段' },
      { type: 'text', text: '第二段' },
    ]);
  } finally {
    await host.close();
  }
});

test('续话：content 非数组且没有 text 简写 → 400', async () => {
  const host = await serve();
  try {
    for (const body of [
      { ...PAIR },
      { ...PAIR, content: 'nope' },
      { ...PAIR, content: null },
      { ...PAIR, text: '' },
      { ...PAIR, text: '   ' },
      { ...PAIR, text: 7 },
    ]) {
      const res = await host.prompt(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      const out = await res.json();
      assert.equal(out.error.code, 'bad-request');
      assert.equal(out.error.message, '需要 content 数组或 text');
    }
    assert.equal(host.prompts.length, 0);
  } finally {
    await host.close();
  }
});

test('续话：块数超过 32 → 400', async () => {
  const host = await serve();
  try {
    const ok32 = Array.from({ length: 32 }, (_, i) => ({ type: 'text', text: `t${i}` }));
    assert.equal((await host.prompt({ ...PAIR, content: ok32 })).status, 200, '32 块应当放行');
    const too33 = Array.from({ length: 33 }, (_, i) => ({ type: 'text', text: `t${i}` }));
    const res = await host.prompt({ ...PAIR, content: too33 });
    assert.equal(res.status, 400);
    const out = await res.json();
    assert.equal(out.error.code, 'bad-request');
    assert.equal(out.error.message, 'content 一次最多 32 块');
    assert.equal(host.prompts.length, 1, '33 块那次不该调用宿主');
  } finally {
    await host.close();
  }
});

test('续话：块缺 type → 400', async () => {
  const host = await serve();
  try {
    for (const block of [null, 'nope', 7, {}, { type: 5 }, { text: 'x' }]) {
      const res = await host.prompt({ ...PAIR, content: [block] });
      assert.equal(res.status, 400, JSON.stringify(block));
      const out = await res.json();
      assert.equal(out.error.code, 'bad-request');
      assert.equal(out.error.message, 'content 块缺少 type');
    }
    assert.equal(host.prompts.length, 0);
  } finally {
    await host.close();
  }
});

test('续话：图片块 → attachment-error / SUBAGENT_IMAGE_UNSUPPORTED', async () => {
  const host = await serve();
  try {
    const res = await host.prompt({
      ...PAIR,
      content: [
        { type: 'text', text: '看这张图' },
        { type: 'image', mediaType: 'image/png', data: 'AAAA' },
      ],
    });
    assert.equal(res.status, 400);
    const out = await res.json();
    assert.equal(out.ok, false);
    assert.equal(out.error.code, 'attachment-error');
    assert.equal(out.error.message, '子代理续话不支持图片输入。');
    assert.deepEqual(out.error.details, { reason: 'SUBAGENT_IMAGE_UNSUPPORTED' });
    assert.equal(host.prompts.length, 0, '图片续话不该调用宿主');
  } finally {
    await host.close();
  }
});

test('续话：其它块类型 → 400 不支持的 content 块类型', async () => {
  const host = await serve();
  try {
    for (const type of ['file', 'audio', 'tool', '']) {
      const res = await host.prompt({ ...PAIR, content: [{ type, text: 'x' }] });
      assert.equal(res.status, 400, `type=${JSON.stringify(type)}`);
      const out = await res.json();
      assert.equal(out.error.code, 'bad-request');
      assert.equal(out.error.message, `不支持的 content 块类型: ${type}`);
    }
    assert.equal(host.prompts.length, 0);
  } finally {
    await host.close();
  }
});

test('续话：text 块空白或超长 → 400', async () => {
  const host = await serve();
  try {
    for (const text of ['', '   ', null, 7]) {
      const res = await host.prompt({ ...PAIR, content: [{ type: 'text', text }] });
      assert.equal(res.status, 400, JSON.stringify(text));
      const out = await res.json();
      assert.equal(out.error.code, 'bad-request');
      assert.equal(out.error.message, 'text 块内容为空');
    }
    const long = 'x'.repeat(64 * 1024 + 1);
    const res = await host.prompt({ ...PAIR, content: [{ type: 'text', text: long }] });
    assert.equal(res.status, 400);
    const out = await res.json();
    assert.equal(out.error.code, 'bad-request');
    assert.equal(out.error.message, 'text 块最长 65536 个字符');
    // 正好 64Ki 字符应当放行。
    const exact = 'y'.repeat(64 * 1024);
    assert.equal((await host.prompt({ ...PAIR, content: [{ type: 'text', text: exact }] })).status, 200);
    assert.equal(host.prompts.length, 1);
  } finally {
    await host.close();
  }
});

test('续话：clientTimeZone 有值才透传，且 trim', async () => {
  const host = await serve();
  try {
    await host.prompt({ ...PAIR, text: 'a' });
    assert.ok(!('clientTimeZone' in host.prompts[0].payload), '没给就别塞字段');
    await host.prompt({ ...PAIR, text: 'b', clientTimeZone: '  Asia/Shanghai  ' });
    assert.equal(host.prompts[1].payload.clientTimeZone, 'Asia/Shanghai');
    await host.prompt({ ...PAIR, text: 'c', clientTimeZone: '   ' });
    assert.ok(!('clientTimeZone' in host.prompts[2].payload), '空白当没给');
    await host.prompt({ ...PAIR, text: 'd', clientTimeZone: 7 });
    assert.ok(!('clientTimeZone' in host.prompts[3].payload), '非字符串当没给');
  } finally {
    await host.close();
  }
});

test('续话：宿主报错如实透传，不回 accepted', async () => {
  for (const error of [
    { code: 'subagent-parent-unavailable', message: 'parent session "session-parent" is not live' },
    { code: 'subagent-not-found', message: 'subagent not found' },
    { code: 'internal', message: 'subagent prompt failed' },
  ]) {
    const host = await serve(() => errValue(error));
    try {
      const res = await host.prompt({ ...PAIR, text: 'hi' });
      assert.equal(res.status, 400);
      const out = await res.json();
      assert.equal(out.ok, false);
      assert.equal(out.error.code, error.code);
      assert.equal(out.error.message, error.message);
      assert.equal(out.accepted, undefined);
    } finally {
      await host.close();
    }
  }
});

test('续话：宿主空响应 → 400 internal 空响应', async () => {
  const host = await serve(() => undefined);
  try {
    const res = await host.prompt({ ...PAIR, text: 'hi' });
    assert.equal(res.status, 400);
    const out = await res.json();
    assert.equal(out.error.code, 'internal');
    assert.equal(out.error.message, '空响应');
  } finally {
    await host.close();
  }
});

test('续话：非法 JSON 请求体 → 400 需要 { parentSessionId, childSessionId, content | text }', async () => {
  const host = await serve();
  try {
    const res = await host.prompt('{not json');
    assert.equal(res.status, 400);
    const out = await res.json();
    assert.equal(out.error.code, 'bad-request');
    assert.equal(out.error.message, '需要 { parentSessionId, childSessionId, content | text }');
    assert.equal(host.prompts.length, 0);
  } finally {
    await host.close();
  }
});

test('打断：请求信封精确，且只传一个参数（宿主 interrupt 没有 signal 形参）', async () => {
  const host = await serve();
  try {
    const res = await host.interrupt(PAIR);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, accepted: true });
    assert.equal(host.interrupts.length, 1);
    assert.deepEqual(host.interrupts[0], {
      rpcId: 'mobile',
      method: 'subagent.interrupt',
      payload: {
        parentSessionId: 'session-parent',
        childSessionId: 'child-1',
        mode: 'continuable',
      },
    });
    assert.equal(host.interruptArgCounts[0], 1, 'interrupt 只能传 request 一个参数');
  } finally {
    await host.close();
  }
});

test('打断：缺 id 直接 400，且不打扰宿主', async () => {
  const host = await serve();
  try {
    for (const body of [{}, { parentSessionId: 'session-parent' }, { childSessionId: 'child-1' }, { parentSessionId: '  ', childSessionId: 'x' }]) {
      const res = await host.interrupt(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      const out = await res.json();
      assert.equal(out.ok, false);
      assert.equal(out.error.code, 'bad-request');
      assert.equal(out.error.message, '需要 { parentSessionId, childSessionId }');
      assert.equal(out.accepted, undefined);
    }
    assert.equal(host.interrupts.length, 0);
  } finally {
    await host.close();
  }
});

test('打断：id 两侧空白被 trim；宿主报错如实透传', async () => {
  // 第一个形参是 promptImpl，打断的实现要传在第二位。
  const host = await serve(undefined, (request) => (
    request.payload.childSessionId === 'child-bad'
      ? errValue({ code: 'subagent-unauthorized', message: 'subagent does not belong to this parent' })
      : okValue({ accepted: true })
  ));
  try {
    const ok = await host.interrupt({ parentSessionId: ' p ', childSessionId: ' c ' });
    assert.equal(ok.status, 200);
    assert.deepEqual(host.interrupts[0].payload, {
      parentSessionId: 'p',
      childSessionId: 'c',
      mode: 'continuable',
    });

    const bad = await host.interrupt({ parentSessionId: 'p', childSessionId: 'child-bad' });
    assert.equal(bad.status, 400);
    const out = await bad.json();
    assert.equal(out.ok, false);
    assert.equal(out.error.code, 'subagent-unauthorized');
    assert.equal(out.error.message, 'subagent does not belong to this parent');
    assert.equal(out.accepted, undefined);
  } finally {
    await host.close();
  }
});

test('打断：宿主空响应 → 400 internal 空响应', async () => {
  const host = await serve(undefined, () => undefined);
  try {
    const res = await host.interrupt(PAIR);
    assert.equal(res.status, 400);
    const out = await res.json();
    assert.equal(out.error.code, 'internal');
    assert.equal(out.error.message, '空响应');
  } finally {
    await host.close();
  }
});

test('normalizePromptContent 是纯函数，不改动入参', () => {
  const body = { content: [{ type: 'text', text: 'hello' }], extra: 'keep' };
  const before = JSON.stringify(body);
  const out = normalizePromptContent(body);
  assert.deepEqual(out, { blocks: [{ type: 'text', text: 'hello' }] });
  assert.equal(JSON.stringify(body), before, '入参不该被改动');

  // 只重建 text 块：块上多带的字段不该漏给宿主。
  const withExtra = normalizePromptContent({ content: [{ type: 'text', text: 'hi', cache: true }] });
  assert.deepEqual(withExtra, { blocks: [{ type: 'text', text: 'hi' }] });
});

test('子代理续话：插件挂上两条路由并导出，且 interrupt 不传 signal', () => {
  const root = path.join(__dirname, '..');
  const mod = fs.readFileSync(path.join(root, 'lib/mobile/subagents.js'), 'utf8');
  assert.ok(mod.includes("method: 'subagent.prompt'"), 'subagents.js 应调用 subagent.prompt');
  assert.ok(mod.includes("method: 'subagent.interrupt'"), 'subagents.js 应调用 subagent.interrupt');
  // 真宿主是 apiProxy.subagents（复数），方法名才是单数：写错在真机上只表现为 500。
  assert.ok(mod.includes('ctx.apiProxy.subagents.prompt('), 'prompt 必须走 apiProxy.subagents（复数）');
  assert.ok(mod.includes('ctx.apiProxy.subagents.interrupt('), 'interrupt 必须走 apiProxy.subagents（复数）');
  assert.ok(mod.includes("mode: 'continuable'"), 'mode 固定 continuable');
  assert.ok(mod.includes('SUBAGENT_IMAGE_UNSUPPORTED'), '图片续话要报 SUBAGENT_IMAGE_UNSUPPORTED');
  assert.ok(mod.includes('需要 { parentSessionId, childSessionId, content | text }'), 'prompt 缺 id 时应 400');
  assert.ok(mod.includes('需要 { parentSessionId, childSessionId }'), 'interrupt 缺 id 时应 400');

  // interrupt 的宿主签名没有 signal 形参：源码里那段调用不能出现 signal。
  const start = mod.indexOf('async function handleSubagentInterrupt');
  assert.ok(start > 0, 'subagents.js 应有 handleSubagentInterrupt');
  const interruptBody = mod.slice(start, mod.indexOf('\nmodule.exports'));
  assert.ok(!interruptBody.includes('signal'), 'interrupt 不该传 signal');
  assert.ok(!interruptBody.includes('AbortController'), 'interrupt 不该建 AbortController');

  const index = readWiring();
  assert.ok(
    index.includes("route('/api/mobile/v1/subagents/prompt', subagents.handleSubagentPrompt)"),
    'index.js 应注册 /api/mobile/v1/subagents/prompt 路由',
  );
  assert.ok(
    index.includes("route('/api/mobile/v1/subagents/interrupt', subagents.handleSubagentInterrupt)"),
    'index.js 应注册 /api/mobile/v1/subagents/interrupt 路由',
  );
});

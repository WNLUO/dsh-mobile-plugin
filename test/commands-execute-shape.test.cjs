'use strict';

/**
 * commands/execute 的 args 形状守卫。
 *
 * 宿主 typertGateway 用 assertExactArguments 严格校验 args 键名，形状写错回
 * gateway/arguments-invalid，而 App 把那个 400 渲染成错误卡也只是提示 —— 结果**所有**
 * slash 命令一律失败（切权限模式、`/plan off` 都点不动），普通发消息却完全正常，很容易
 * 被当成「权限功能单独坏了」。
 *
 * 所以假网关不是「宽松地记录一下 args」，而是**照抄宿主那条断言**：键名必须恰好等于
 * descriptor 的 wire 名，多一个少一个都抛 gateway/arguments-invalid。任何把
 * `submittedAttachments` 写回 `images` 的改动都会当场红。
 *
 * descriptor 的 wire 名（`@deepseek-ai/dsh-commands#commands/execute`）：scope 为 `agentId`，
 * 参数为 `line` + `submittedAttachments`（array(union(image, file))，纯命令调用传 [] 合法）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { handleSend } = require('../lib/mobile/sessions.js');

/** commands/execute 的宿主 descriptor（wire 名）。 */
const COMMANDS_WIRE = ['agentId', 'line', 'submittedAttachments'];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function assertExactArguments(args, endpoint) {
  assert.ok(args && typeof args === 'object' && !Array.isArray(args), `${endpoint}: args 必须是普通对象`);
  const expected = new Set(COMMANDS_WIRE);
  const extra = Object.keys(args).filter((key) => !expected.has(key));
  const missing = [...expected].filter((key) => !Object.hasOwn(args, key));
  assert.equal(
    extra.length === 0 && missing.length === 0,
    true,
    `${endpoint}: args 字段与 descriptor 不符 — unexpected ${JSON.stringify(extra)}; missing ${JSON.stringify(missing)}`,
  );
  assert.equal(typeof args.agentId, 'string', `${endpoint}: agentId 必须是字符串`);
  assert.equal(typeof args.line, 'string', `${endpoint}: line 必须是字符串`);
  assert.ok(Array.isArray(args.submittedAttachments), `${endpoint}: submittedAttachments 必须是数组`);
  for (const item of args.submittedAttachments) {
    assert.ok(item && typeof item === 'object', `${endpoint}: 附件项必须是对象`);
    if (item.type === 'image') {
      assert.ok(IMAGE_TYPES.includes(item.mediaType), `${endpoint}: image.mediaType 非法`);
      assert.equal(typeof item.data, 'string', `${endpoint}: image.data 必须是 base64 字符串`);
    } else if (item.type === 'file') {
      assert.equal(typeof item.receiptId, 'string', `${endpoint}: file.receiptId 必须是字符串`);
    } else {
      assert.fail(`${endpoint}: 未知附件类型 ${JSON.stringify(item.type)}`);
    }
  }
}

/**
 * 假网关：只实现 commands/execute，并且按宿主那条断言校验 args。
 * 记录每次调用，便于断言形状本身。
 */
function makeCtx({ unknown = false, gateway = true } = {}) {
  const calls = [];
  const fake = {
    async invoke({ namespace, method, args }) {
      calls.push({ namespace, method, args });
      if (namespace === 'commands' && method === 'execute') {
        assertExactArguments(args, 'commands/execute');
        // undefined = 命令注册表未命中（descriptor 的返回类型就是 CommandExecution|undefined）。
        return unknown ? undefined : { command: { name: 'permission' }, status: 'ok' };
      }
      throw Object.assign(new Error(`未预期的端点 ${namespace}/${method}`), { code: 'gateway/invocation-unavailable' });
    },
    async stream() { throw new Error('本测试不涉及流'); },
  };
  const ctx = {
    get: (name) => (name === 'typertGateway' && gateway ? fake : undefined),
    logger: { warn() {}, error() {} },
  };
  // 未知命令 / 网关未组合时回退普通消息，这条路径要能跑通。
  ctx.apiProxy = {
    sessions: { prompt: async () => ({ result: { ok: true, value: { accepted: true } } }) },
  };
  return { ctx, calls };
}

function request(body) {
  const req = new EventEmitter();
  req.url = '/api/mobile/v1/session/send';
  req.headers = { 'x-dsh-device': 'phone-1' };
  process.nextTick(() => {
    req.emit('data', JSON.stringify(body));
    req.emit('end');
  });
  return req;
}

function response() {
  return {
    status: 0,
    body: null,
    writeHead(status) { this.status = status; },
    end(value) { this.body = value ? JSON.parse(String(value)) : null; },
  };
}

test('slash command reaches commands/execute with the descriptor-exact args', async () => {
  const { ctx, calls } = makeCtx();
  const res = response();

  await handleSend(ctx, request({ sessionId: 's-1', text: '/permission danger-full-access' }), res);

  // 假网关里的 assertExactArguments 才是本测试真正的断言点：少一个键就抛。
  assert.equal(res.status, 200, `期望 200，实际 ${res.status}：${JSON.stringify(res.body)}`);
  assert.deepEqual(res.body, { ok: true, accepted: true, handledAs: 'command' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].namespace, 'commands');
  assert.equal(calls[0].method, 'execute');
  assert.deepEqual(calls[0].args, {
    agentId: 's-1',
    line: '/permission danger-full-access',
    submittedAttachments: [],
  });
});

test('args carry submittedAttachments and never the old images key', async () => {
  const { ctx, calls } = makeCtx();
  const res = response();

  await handleSend(ctx, request({ sessionId: 's-1', text: '/plan off' }), res);

  assert.equal(res.status, 200);
  const args = calls[0].args;
  assert.equal(Object.hasOwn(args, 'images'), false, 'args 里不能有 images（宿主报 unexpected "images"）');
  assert.deepEqual(Object.keys(args).sort(), [...COMMANDS_WIRE].sort());
  assert.deepEqual(args.submittedAttachments, [], '纯命令调用提交空附件数组');
});

test('a host arguments-invalid keeps its literal message so the phone can show it', async () => {
  // 回归姿势：如果哪天形状又写错，App 至少要把宿主原话显示出来，别被自己的文案盖掉。
  const poisoned = {
    async invoke() {
      throw Object.assign(
        new Error('typert gateway: commands/execute: args fields do not match the descriptor: missing "submittedAttachments"; unexpected "images"'),
        { code: 'gateway/arguments-invalid' },
      );
    },
    async stream() { throw new Error('本测试不涉及流'); },
  };
  const ctx = {
    get: (name) => (name === 'typertGateway' ? poisoned : undefined),
    logger: { warn() {}, error() {} },
  };
  const res = response();

  await handleSend(ctx, request({ sessionId: 's-1', text: '/permission workspace-write' }), res);

  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error.message, /args fields do not match the descriptor/);
  assert.match(res.body.error.message, /missing "submittedAttachments"/);
});

test('an unknown command still falls back to a plain prompt', async () => {
  // execute 返回 undefined = 注册表未命中（对齐桌面 miss 落入默认 sink）。
  const { ctx, calls } = makeCtx({ unknown: true });
  const res = response();

  await handleSend(ctx, request({ sessionId: 's-1', text: '/not-a-command' }), res);

  assert.equal(calls.length, 1, '仍然要问一次命令注册表');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, accepted: true }, '未知命令回退普通消息，不带 handledAs');
});

test('a missing gateway still falls back to a plain prompt', async () => {
  const { ctx, calls } = makeCtx({ gateway: false });
  const res = response();

  await handleSend(ctx, request({ sessionId: 's-1', text: '/permission workspace-write' }), res);

  assert.equal(calls.length, 0, '网关未组合时不该有 invoke');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, accepted: true });
});

test('source contract: executeCommand passes submittedAttachments, not images', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/mobile/session-send.js'), 'utf8');
  const start = source.indexOf('async function executeCommand(');
  const end = source.indexOf('\n}\n', start);
  const body = start >= 0 && end > start ? source.slice(start, end) : '';
  assert.ok(body.length > 0, 'executeCommand 可定位');
  assert.ok(body.includes('submittedAttachments: []'), 'args 必须带 submittedAttachments: []');
  assert.equal(/images:/.test(body), false, 'args 里不能出现 images');
});

'use strict';

/**
 * CLI 会话的「发图 / 回看图 / 记住默认模型 / 清单来自注册表」这四件事。
 *
 * 钉的都是**用户能立刻感觉到的断法**，不是实现长相：
 *   1. 图片按内容哈希存一份，历史与实时帧只下发引用；按 id 取字节三档与宿主逐字一致；
 *   2. 手机发上来的两种图片写法（`uploadId` / 内联 `data`）都认；
 *   3. 记住的是「哪个 CLI + 哪个配置项 + 哪个值」，换会话 / 重启之后还在；
 *   4. 注册表里没有 npx 分发的那批不进清单（二进制分发是另一件事），拉不到就回内置四家。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-images-'));
process.env.DSH_HOME = HOME;

const images = require('../lib/mobile/cli/images.js');
const modelPrefs = require('../lib/mobile/cli/model-prefs.js');
const registry = require('../lib/mobile/cli/registry.js');

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('图片按内容哈希存一份：同一张图两次只有一份，元数据带回宽高', async () => {
  const first = await images.saveImage({ bytes: PNG_1PX, mediaType: 'image/png', name: 'a.png' });
  const second = await images.saveImage({ bytes: PNG_1PX, mediaType: 'image/png', name: 'b.png' });
  assert.equal(first.attachmentId, second.attachmentId);
  assert.match(first.attachmentId, /^[0-9a-f]{64}$/);
  assert.equal(first.mediaType, 'image/png');
  assert.equal(first.width, 1);
  assert.equal(first.height, 1);
  // 盘上只有一份字节 + 一份元数据。
  const files = fs.readdirSync(images.imageRoot());
  assert.equal(files.length, 2);
});

test('引用块是 App 认的那种形状（attachment.attachmentId + 宽高）', async () => {
  const meta = await images.saveImage({ bytes: PNG_1PX, mediaType: 'image/png', name: 'shot.png' });
  const block = images.imageBlockOf(meta);
  assert.equal(block.type, 'image');
  assert.equal(block.attachment.attachmentId, meta.attachmentId);
  assert.equal(block.attachment.mediaType, 'image/png');
  assert.equal(block.width, 1);
  assert.equal(block.height, 1);
  assert.equal(block.name, 'shot.png');
});

test('不认识的 id / 已经被删掉的文件一律回 null（不抛）', async () => {
  assert.equal(images.metaOf('nope'), null);
  assert.equal(images.openImage('../../etc/passwd'), null);
  const meta = await images.saveImage({ bytes: Buffer.concat([PNG_1PX, Buffer.from([0])]), mediaType: 'image/png' });
  fs.unlinkSync(path.join(images.imageRoot(), meta.attachmentId));
  assert.equal(images.openImage(meta.attachmentId), null);
});

test('只认那四种媒体类型；空的 / 超大的不存', async () => {
  assert.equal(await images.saveImage({ bytes: Buffer.alloc(0), mediaType: 'image/png' }), null);
  const big = Buffer.alloc(images.MAX_IMAGE_BYTES + 1, 1);
  assert.equal(await images.saveImage({ bytes: big, mediaType: 'image/png' }), null);
  const odd = await images.saveImage({ bytes: PNG_1PX, mediaType: 'application/pdf' });
  // 不认识的类型按 png 落（文件头量得出宽高），不会存成一个取不出来的东西。
  assert.equal(odd.mediaType, 'image/png');
});

test('默认模型：按 agentId 记一份，重启之后还在', () => {
  assert.equal(modelPrefs.preferredModel('codex'), null);
  modelPrefs.rememberModel('codex', 'model', 'gpt-5');
  assert.deepEqual(modelPrefs.preferredModel('codex'), { configId: 'model', value: 'gpt-5' });
  // 另一家互不影响。
  assert.equal(modelPrefs.preferredModel('claude'), null);
  modelPrefs.rememberModel('claude', 'model', 'sonnet');
  assert.deepEqual(modelPrefs.preferredModel('claude'), { configId: 'model', value: 'sonnet' });
  // 清掉（选回默认）。
  modelPrefs.rememberModel('codex', 'model', '');
  assert.equal(modelPrefs.preferredModel('codex'), null);
});

test('注册表：内置那四条永远在清单里，注册表只补它没有的', () => {
  const builtin = [
    { id: 'codex', label: 'Codex', transport: 'npx', package: '@agentclientprotocol/codex-acp', bin: 'codex-acp' },
    { id: 'gemini', label: 'Gemini CLI', transport: 'native', bin: 'gemini', args: ['--acp'] },
    { id: 'opencode', label: 'OpenCode', transport: 'native', bin: 'opencode', args: ['acp'] },
  ];
  const fromRegistry = [
    // 同一条适配器换个 id（注册表里桥包带 -acp 后缀）：不能变成两条。
    { id: 'codex-acp', label: 'Codex', transport: 'npx', package: '@agentclientprotocol/codex-acp@2.5.0' },
    // 同一家、同 id：留内置那条（本机装好的 CLI 比去 npx 拉一份快）。
    { id: 'gemini', label: 'Gemini CLI', transport: 'npx', package: '@google/gemini-cli@0.66.0', args: ['--acp'] },
    // 新的一家：补进来。
    { id: 'cline', label: 'Cline', transport: 'npx', package: 'cline@3.0.74', args: ['--acp'] },
  ];
  const merged = registry.mergeWithBuiltin(builtin, fromRegistry);
  assert.deepEqual(merged.map((item) => item.id), ['codex', 'gemini', 'opencode', 'cline']);
  // opencode 在注册表里只有二进制分发（会被过滤掉）：内置那条必须还在，否则建会话回「不认识这个 CLI」。
  assert.equal(merged.find((item) => item.id === 'opencode').transport, 'native');
  assert.equal(merged.find((item) => item.id === 'gemini').transport, 'native');
});

test('注册表：只收 npx 分发的那一档，别的（binary / uvx）不进清单', () => {
  const adapters = registry.adaptersOf({
    agents: [
      { id: 'codex-acp', name: 'Codex', distribution: { npx: { package: '@agentclientprotocol/codex-acp@2.5.0' } } },
      { id: 'cline', name: 'Cline', distribution: { npx: { package: 'cline@3.0.74', args: ['--acp'] } } },
      // 只有二进制分发：这轮不做（下载可执行文件、按平台选架构是另一件事）。
      { id: 'cursor', name: 'Cursor', distribution: { binary: { 'darwin-aarch64': { archive: 'https://x' } } } },
      { id: 'fast-agent', name: 'fast-agent', distribution: { uvx: { package: 'fast-agent' } } },
      // 没有 id 的坏条目直接跳过。
      { name: 'broken', distribution: { npx: { package: 'x' } } },
    ],
  });
  assert.deepEqual(adapters.map((item) => item.id), ['codex-acp', 'cline']);
  assert.deepEqual(adapters[1].args, ['--acp']);
  assert.equal(adapters[0].transport, 'npx');
});

test('注册表：拉不到就回内置那四条，不抛也不报错', async () => {
  const builtin = [{ id: 'codex', label: 'Codex', transport: 'npx', package: 'p' }];
  // 指向一个打不通的地址：这条路的结论必须是「用内置那份」，而不是把异常抛给调用方。
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('offline'); };
  try {
    registry.resetRegistryMemory();
    fs.rmSync(registry.cacheFile(), { force: true });
    const listed = await registry.listRegistryAgents(builtin);
    assert.deepEqual(listed, builtin);
  } finally {
    global.fetch = realFetch;
  }
});

test('注册表：盘上缓存新鲜时不再联网', async () => {
  const builtin = [{ id: 'codex', label: 'Codex', transport: 'npx', package: 'p' }];
  const cached = [{ id: 'cached', label: 'Cached', transport: 'npx', package: 'cached-pkg' }];
  fs.mkdirSync(path.dirname(registry.cacheFile()), { recursive: true });
  fs.writeFileSync(registry.cacheFile(), JSON.stringify({ fetchedAt: Date.now(), agents: cached }), 'utf8');
  let called = 0;
  const realFetch = global.fetch;
  global.fetch = async () => { called += 1; throw new Error('不该联网'); };
  try {
    registry.resetRegistryMemory();
    const listed = await registry.listRegistryAgents(builtin);
    // 内置那几条永远在清单最前面，缓存里的补在后面（合并规则见 mergeWithBuiltin）。
    assert.deepEqual(listed.map((item) => item.id), ['codex', 'cached']);
    assert.equal(called, 0);
  } finally {
    global.fetch = realFetch;
    fs.rmSync(path.dirname(registry.cacheFile()), { recursive: true, force: true });
  }
});

// ── 适配层：发图 / 回看图 ────────────────────────────────────────────────────

const { createCliMobile } = require('../lib/mobile/cli/mobile.js');

function fakeRes() {
  const out = { status: 0, body: null, chunk: null };
  return {
    out,
    writeHead(status) { out.status = status; return this },
    end(chunk) { out.body = chunk === undefined ? null : JSON.parse(String(chunk)); return this },
    write() { return true },
    on() {},
  };
}

function makeBridge(session) {
  const sessions = new Map([[session.id, session]]);
  const calls = { prompts: [] };
  const bridge = createCliMobile({
    sessions,
    runPrompt: (target, message, images) => { calls.prompts.push({ message, images }); return { ok: true }; },
    answerPermission: () => true,
    cancelTurn: () => undefined,
    setTitle: () => undefined,
    watch: (target, sink) => { target.sinks.add(sink); return () => target.sinks.delete(sink); },
    forget: () => undefined,
  });
  return { bridge, calls };
}

function makeSession() {
  return {
    id: 'cli-9',
    workspaceId: 'ws-1',
    agentId: 'codex',
    label: 'Codex',
    cwd: '/tmp/proj',
    title: 'Codex',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    configOptions: [],
    commands: [],
    permissionFrames: new Map(),
    sinks: new Set(),
    blocks: { list: () => [] },
  };
}

test('发图：手机上来的是内联 base64 时，存好、块表只留元数据', async () => {
  const session = makeSession();
  const { bridge, calls } = makeBridge(session);
  const handler = bridge.route('/api/mobile/v1/session/send', () => { throw new Error('不该走宿主'); });
  const res = fakeRes();
  await handler({}, {
    method: 'POST',
    url: '/',
    body: {
      sessionId: 'cli-9',
      content: [{ type: 'image', mediaType: 'image/png', data: PNG_1PX.toString('base64') }, { type: 'text', text: '看图' }],
    },
  }, res);
  assert.equal(res.out.status, 200);
  assert.equal(calls.prompts.length, 1);
  assert.equal(calls.prompts[0].message, '看图');
  assert.equal(calls.prompts[0].images.length, 1);
  assert.match(calls.prompts[0].images[0].attachmentId, /^[0-9a-f]{64}$/);
});

test('发图：只有图没有正文也发得出去（普通对话就是这样）', async () => {
  const session = makeSession();
  const { bridge, calls } = makeBridge(session);
  const handler = bridge.route('/api/mobile/v1/session/send', () => { throw new Error('不该走宿主'); });
  const res = fakeRes();
  await handler({}, {
    method: 'POST',
    url: '/',
    body: { sessionId: 'cli-9', content: [{ type: 'image', mediaType: 'image/png', data: PNG_1PX.toString('base64') }] },
  }, res);
  assert.equal(res.out.status, 200);
  assert.equal(calls.prompts[0].message, '');
  assert.equal(calls.prompts[0].images.length, 1);
});

test('发图：上传过期时说一句人话，不是静默丢掉那张图', async () => {
  const session = makeSession();
  const { bridge, calls } = makeBridge(session);
  const handler = bridge.route('/api/mobile/v1/session/send', () => { throw new Error('不该走宿主'); });
  const res = fakeRes();
  await handler({}, {
    method: 'POST',
    url: '/',
    body: { sessionId: 'cli-9', content: [{ type: 'image', mediaType: 'image/png', uploadId: 'gone' }] },
  }, res);
  assert.equal(res.out.status, 400);
  assert.match(res.out.body.error.message, /过期/);
  assert.equal(calls.prompts.length, 0);
});

test('回看图：按 attachmentId 回 base64（老路），dims 只回两格数字', async () => {
  const meta = await images.saveImage({ bytes: PNG_1PX, mediaType: 'image/png', name: 'x.png' });
  const session = makeSession();
  const { bridge } = makeBridge(session);
  const handler = bridge.route('/api/mobile/v1/session/attachment', () => { throw new Error('不该走宿主'); });

  const base64Res = fakeRes();
  await handler({}, { method: 'POST', url: '/', body: { sessionId: 'cli-9', attachmentId: meta.attachmentId } }, base64Res);
  assert.equal(base64Res.out.status, 200);
  assert.equal(base64Res.out.body.mediaType, 'image/png');
  assert.equal(base64Res.out.body.data, PNG_1PX.toString('base64'));

  const dimsRes = fakeRes();
  await handler({}, { method: 'POST', url: '/', body: { sessionId: 'cli-9', attachmentId: meta.attachmentId, dims: true } }, dimsRes);
  assert.deepEqual({ width: dimsRes.out.body.width, height: dimsRes.out.body.height }, { width: 1, height: 1 });
  assert.equal(dimsRes.out.body.data, undefined);
});

test('回看图：raw 那条不封包不许走（否则就是明文传输）', async () => {
  const meta = await images.saveImage({ bytes: PNG_1PX, mediaType: 'image/png' });
  const { bridge } = makeBridge(makeSession());
  const handler = bridge.route('/api/mobile/v1/session/attachment', () => { throw new Error('不该走宿主'); });
  const res = fakeRes();
  await handler({}, { method: 'POST', url: '/', body: { sessionId: 'cli-9', attachmentId: meta.attachmentId, raw: true } }, res);
  assert.equal(res.out.status, 400);
  assert.equal(res.out.body.error.code, 'e2ee-required');
});

test('回看图：不认识的 id 回 404，不是一张空白图', async () => {
  const { bridge } = makeBridge(makeSession());
  const handler = bridge.route('/api/mobile/v1/session/attachment', () => { throw new Error('不该走宿主'); });
  const res = fakeRes();
  await handler({}, { method: 'POST', url: '/', body: { sessionId: 'cli-9', attachmentId: 'f'.repeat(64) } }, res);
  assert.equal(res.out.status, 404);
});


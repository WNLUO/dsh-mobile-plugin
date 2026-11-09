'use strict';

/**
 * 加密历史 blob（宿主侧）：HK 生成、信封封/解、creds 形状、proto1 跳过、无 HK 不推。
 *
 * 规格见 /tmp/dsh-blob-spec.md 第 2、6 节。这里钉住插件这一侧的契约，与 App 侧的
 * `app/scripts/test-history-blob.js` 用同一套信封口径（AES-256-GCM，AAD
 * `dsh-history-v1|<scope>|<key>`，外层 `{v,z,n,c}`）。
 *
 * 一条总原则：**加法**。开关关 / 没有 HK 时，现有镜像推送行为一个字节都不许变。
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// relay.json 的落盘路径在 require core 时定下来，所以 DSH_HOME 必须先设。
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-history-blob-'));
process.env.DSH_HOME = HOME;

const core = require('../lib/relay/core.js');
const {
  sealHistoryBlob,
  openHistoryBlob,
  envelopeCipher,
  isBlobEligible,
  buildBlobPuts,
} = require('../lib/mirror/history-blob.cjs');
const { createMirrorPusher } = require('../lib/mirror/pusher.cjs');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const newHk = () => crypto.randomBytes(32).toString('base64url');
const flush = async (turns = 30) => {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('HK 惰性生成一次、稳定、落盘可还原', () => {
  const state = core.defaultState();
  assert.equal(state.historyKey, '', '默认状态里 historyKey 是空串（不能预置随机值，否则每次重启换钥）');
  const first = core.ensureHistoryKey(state);
  assert.equal(typeof first, 'string');
  assert.match(first, /^[A-Za-z0-9_-]{43}$/, '32 字节 base64url 必须是 43 个无补位字符');
  assert.equal(core.ensureHistoryKey(state), first, '再次取值必须返回同一把（稳定）');
  assert.equal(state.historyKey, first, '取值器要把它落到 state 上');

  // 落盘：新起一份 state 从 relay.json 读回来，密钥还在（重启后仍能解旧 blob）。
  const reloaded = core.loadState();
  assert.equal(reloaded.historyKey, first, 'HK 必须持久化到 relay.json');
});

test('信封封/解往返：逐字节一致，AAD 差一个字节就解不开', () => {
  const hk = newHk();
  const plain = {
    sessionId: 'sess-1',
    seq: 7,
    updatedAt: 1700000000000,
    messages: [{ seq: 1, role: 'user', text: '你好' }, { seq: 7, role: 'assistant', text: '在的' }],
  };
  const envelopeJson = sealHistoryBlob(hk, 'messages', 'sess-1', plain);
  const envelope = JSON.parse(envelopeJson);
  assert.deepEqual(Object.keys(envelope).sort(), ['c', 'n', 'v', 'z'], '外层信封形状固定为 {v,z,n,c}');
  assert.equal(envelope.v, 1);
  assert.equal(envelope.z, 0, '未压缩，z 恒为 0');

  assert.deepEqual(openHistoryBlob(hk, 'messages', 'sess-1', envelopeJson), plain, '解回来必须与明文逐字段一致');

  // AAD 参与认证：scope 或 key 差一个字节都必须失败（不能悄悄解出半截）。
  assert.throws(() => openHistoryBlob(hk, 'messages', 'sess-2', envelopeJson), 'key 不符必须解不开');
  assert.throws(() => openHistoryBlob(hk, 'file', 'sess-1', envelopeJson), 'scope 不符必须解不开');
  assert.throws(() => openHistoryBlob(newHk(), 'messages', 'sess-1', envelopeJson), '换一把 HK 必须解不开');
});

test('cipher 是信封 JSON 的 base64url（中转只当不透明字节存）', () => {
  const hk = newHk();
  const envelopeJson = sealHistoryBlob(hk, 'messages', 'k', { sessionId: 'k', seq: 0, updatedAt: 0, messages: [] });
  const cipher = envelopeCipher(envelopeJson);
  // 中转拿到 cipher 解 base64url 就是信封字节，再按 UTF-8 读回来应等于原信封 JSON。
  assert.equal(Buffer.from(cipher, 'base64url').toString('utf8'), envelopeJson);
  // 而 blobPut 帧里的 cipher 解出来能直接喂 openHistoryBlob。
  assert.deepEqual(openHistoryBlob(hk, 'messages', 'k', Buffer.from(cipher, 'base64url').toString('utf8')), {
    sessionId: 'k', seq: 0, updatedAt: 0, messages: [],
  });
});

test('creds 形状：只取 sha256 hex 串，丢对象外壳与 expiresAt', () => {
  const hk = newHk();
  const hashA = sha256('dshc_aaa');
  const hashB = sha256('dshc_bbb');
  const payload = {
    sessions: { items: [{ sessionId: 'sess-1', updatedAt: 42 }] },
    messages: {
      'sess-1': { ok: true, items: [{ seq: 3, role: 'user', text: 'hi' }], lastSeq: 3 },
    },
  };
  const frames = buildBlobPuts(payload, hk, [{ hash: hashA }, { hash: hashB, expiresAt: 123 }]);
  assert.equal(frames.length, 1);
  const frame = frames[0];
  assert.equal(frame.scope, 'messages');
  assert.equal(frame.key, 'sess-1');
  assert.deepEqual(frame.creds, [hashA, hashB], 'creds 必须是 sha256 hex 串数组，不带对象/过期时间');
  assert.equal(typeof frame.cipher, 'string');

  const plain = openHistoryBlob(hk, 'messages', 'sess-1', Buffer.from(frame.cipher, 'base64url').toString('utf8'));
  assert.equal(plain.sessionId, 'sess-1');
  assert.equal(plain.seq, 3, 'seq 取 lastSeq（消息水位）');
  assert.equal(plain.updatedAt, 42, 'updatedAt 取会话清单那一行');
  assert.deepEqual(plain.messages, [{ seq: 3, role: 'user', text: 'hi' }]);
});

test('会话一律入 blob，只有显式标记未加密才跳过', () => {
  // blob 里装的都是 HK 密文，真正的门是「设备有没有 HK」；消息快照不带协议标记，
  // 所以这里不再有 proto 判据。唯一保留的钩子是「显式说了未加密」。
  assert.equal(isBlobEligible({ ok: true, items: [], encrypted: false }), false);
  assert.equal(isBlobEligible({ ok: true, items: [] }), true);
  assert.equal(isBlobEligible({ ok: true, items: [], proto: 1 }), true);
  assert.equal(isBlobEligible({ ok: true, items: [], encrypted: true }), true);

  const hk = newHk();
  const payload = {
    sessions: { items: [{ sessionId: 'v2', updatedAt: 1 }, { sessionId: 'old', updatedAt: 2 }] },
    messages: {
      v2: { ok: true, items: [{ seq: 1 }], lastSeq: 1 },
      old: { ok: true, items: [{ seq: 1 }], lastSeq: 1 },
    },
  };
  const frames = buildBlobPuts(payload, hk, []);
  assert.deepEqual(frames.map((f) => f.key), ['v2', 'old'], '两个会话都该入 blob');
  // 读不到正文（ok:false / 无 items）的会话也不该硬造一条空 blob。
  const noBody = buildBlobPuts({ messages: { x: { ok: false } } }, hk, []);
  assert.deepEqual(noBody, []);
});

test('没有 HK 时一条 blob 都不发', () => {
  const payload = {
    sessions: { items: [{ sessionId: 'sess-1', updatedAt: 1 }] },
    messages: { 'sess-1': { ok: true, items: [{ seq: 1 }], lastSeq: 1 } },
  };
  assert.deepEqual(buildBlobPuts(payload, '', [{ hash: sha256('x') }]), []);
  assert.deepEqual(buildBlobPuts(payload, undefined, []), []);
});

/* ── 与镜像推送的接线：HK 有就推、没有就一条不提 ────────────────────── */

const mkItem = ({ sessionId, running, updatedAt }) => ({
  sessionId, cwd: '/ws/a', updatedAt, running, blank: false, projections: { values: { title: sessionId } },
});

function fakeCtx(state) {
  const passthrough = (overrides) => new Proxy(overrides, {
    get(target, prop) {
      if (prop in target || typeof prop !== 'string') return target[prop];
      return async () => ({ result: { ok: true, value: {} } });
    },
  });
  return {
    apiProxy: {
      sessions: passthrough({
        list: async () => ({ result: { ok: true, value: { items: state.items } } }),
        history: async () => ({ result: { ok: true, value: { events: [] } } }),
        projections: async () => ({ result: { ok: true, value: { values: {} } } }),
      }),
      workspace: passthrough({
        list: async () => ({ result: { ok: true, value: { items: [{ workspaceId: 'w1', path: '/ws/a', title: 'a', sessionIds: [] }], archivedSessionIds: [] } } }),
      }),
      events: { mux: async function* () { await new Promise(() => {}); } },
    },
  };
}

/** 推一次整批镜像，返回 sidecar 收到的 sync 与 blob 两类帧。 */
async function pushOnce({ getHistoryKey }) {
  const previousHome = process.env.DSH_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-history-blob-push-'));
  process.env.DSH_HOME = home;
  try {
    const pushed = [];
    const blobs = [];
    const pusher = createMirrorPusher({
      ctx: fakeCtx({ items: [mkItem({ sessionId: 'sess-run', running: true, updatedAt: Date.now() })] }),
      tunnelConnected: () => true,
      getSidecar: () => ({
        pushSync: async (payload) => { pushed.push(payload); },
        pushBlob: async (frame) => { blobs.push(frame); },
      }),
      credentialDigests: () => [{ hash: sha256('dshc_x') }],
      getHistoryKey,
    });
    await pusher.pushMirror();
    await flush();
    return { pushed, blobs };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
}

test('镜像推送时带着 HK 会为含正文的会话发 blobPut 帧', async () => {
  const hk = newHk();
  const { pushed, blobs } = await pushOnce({ getHistoryKey: () => hk });
  assert.ok(pushed.length > 0, '镜像照常推');
  assert.ok(blobs.length > 0, '有 HK 时应发 blobPut');
  const frame = blobs.find((entry) => entry.key === 'sess-run');
  assert.ok(frame, '应包含这次推送里的会话');
  assert.equal(frame.scope, 'messages');
  assert.deepEqual(frame.creds, [sha256('dshc_x')], 'creds 复用镜像那份设备凭据摘要');
  const plain = openHistoryBlob(hk, 'messages', 'sess-run', Buffer.from(frame.cipher, 'base64url').toString('utf8'));
  assert.equal(plain.sessionId, 'sess-run');
  assert.ok(Array.isArray(plain.messages));
});

test('没有 HK 时镜像照推、但一条 blobPut 都不发（关/无钥行为不变）', async () => {
  const { pushed, blobs } = await pushOnce({ getHistoryKey: () => '' });
  assert.ok(pushed.length > 0, '没有 HK 不许影响镜像推送');
  assert.equal(blobs.length, 0, '没有 HK 时不该发任何 blobPut');
});

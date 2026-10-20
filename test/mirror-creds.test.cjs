'use strict';

/**
 * 镜像载荷里的设备凭据摘要（`creds`）。
 *
 * 中转新增离线镜像缓存后，桌面宿主没上线时也要能判断「来读这份缓存的人是不是配对过的
 * 手机」，而它手上只有手机发来的 `dshc_` 原文。插件这一侧的全部职责就是：每次推镜像时
 * 把本实例签发过、仍然有效的凭据 sha256 一起带上去 —— 凭据库落盘存的正是这个摘要，
 * 原文从未留存，所以这是纯读取，不需要新凭据、也不动配对流程。
 *
 * 钉住三件事：
 *   1. 载荷真的带 creds，且是凭据库同口径的 sha256、只收本实例的活记录；
 *   2. 吊销一台设备后清单少一条，**而且下一 tick 就要推出去**：清单本身一个字都没变，
 *      只看 revision 的判重会把它挡回去，被撤销的手机于是还能继续读离线镜像；
 *   3. 隧道未连时不白读凭据库（沿用「断线不构建快照」的既有行为）。
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// 凭据库在 require 时就把落盘路径定下来，所以环境变量必须先设。
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mirror-creds-'));
process.env.DEVICE_CREDENTIALS_FILE = path.join(STORE_DIR, 'relay-device-credentials.json');

const credentials = require('../dsh-mobile-credentials/lib/credentials.js');
const { createMirrorPusher } = require('../lib/mirror/pusher.cjs');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = async (turns = 20) => {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const mkItem = ({ sessionId, title, running, updatedAt }) => ({
  sessionId,
  cwd: '/ws/a',
  updatedAt,
  running,
  blank: false,
  projections: { values: { title } },
});

/**
 * 假 ctx：一个跑着的会话 + 一个冷会话。
 *
 * 冷会话不是凑数——后台 tick 只轮转「没在跑、5 分钟没动过」的会话，没有它就没有任何推送，
 * 「撤销后仍要推」那条断言会退化成恒真。
 */
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
      // 事件流一直挂着：本用例只驱动 500ms 的后台 tick 与启动那次全量。
      events: { mux: async function* () { await new Promise(() => {}); } },
    },
  };
}

/** 手动点火的 setInterval：不必真等 500ms，也不让定时器在用例结束后留着。 */
function harness() {
  const intervals = [];
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  global.setInterval = (fn, ms) => { const handle = { fn, ms }; intervals.push(handle); return handle; };
  global.clearInterval = () => {};
  return {
    tick() {
      const handle = intervals.find((entry) => entry.ms === 500);
      assert.ok(handle, '没有找到 500ms 的镜像 tick');
      handle.fn();
    },
    restore() {
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
    },
  };
}

/** 起一台假宿主推镜像；run 里拿得到推进去的载荷与 tick 点火器。 */
async function withPusher({ tunnelConnected = () => true, credentialDigests, run }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mirror-creds-home-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home; // 空清单守卫会落盘，别污染真实 ~/.dsh
  const h = harness();
  const pushed = [];
  const state = {
    items: [
      mkItem({ sessionId: 'session-run', title: '跑着的会话', running: true, updatedAt: Date.now() }),
      mkItem({ sessionId: 'session-cold', title: '冷会话', running: false, updatedAt: Date.now() - 10 * 60 * 1000 }),
    ],
  };
  const pusher = createMirrorPusher({
    ctx: fakeCtx(state),
    tunnelConnected,
    getSidecar: () => ({ pushSync: async (payload) => { pushed.push(payload); } }),
    credentialDigests,
  });
  try {
    return await run({ pusher, pushed, state, h });
  } finally {
    h.restore();
    await flush();
    fs.rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
}

test('镜像载荷带本实例活凭据的 sha256：同口径、按签发倒序、无过期就不出 expiresAt', async () => {
  const INSTANCE = 'inst-payload';
  const withTtl = credentials.issue(INSTANCE, { deviceId: 'phone-a' }, 'host-token-a');
  const permanent = credentials.issue(INSTANCE, { deviceId: 'phone-b' }, 'host-token-b', 0);
  const otherInstance = credentials.issue('inst-elsewhere', { deviceId: 'phone-x' }, 'host-token-x');
  await withPusher({
    credentialDigests: () => credentials.activeDigests(INSTANCE),
    run: async ({ pusher, pushed }) => {
      const stop = pusher.start();
      try {
        await flush();
      } finally {
        stop();
      }
      assert.ok(pushed.length > 0, '启动那次全量镜像没有推出去');
      const payload = pushed[pushed.length - 1];
      assert.ok(Array.isArray(payload.creds), '镜像载荷必须带 creds 数组');
      assert.equal(payload.creds.length, 2, '只收本实例的活凭据');
      // 倒序：最后签发的那条在最前。
      assert.equal(payload.creds[0].hash, sha256(permanent.credential), '摘要必须是 dshc_ 原文的 sha256');
      assert.equal('expiresAt' in payload.creds[0], false, '没设 TTL 的记录不该带 expiresAt 字段');
      assert.equal(payload.creds[1].hash, sha256(withTtl.credential));
      assert.equal(payload.creds[1].expiresAt, withTtl.expiresAt, '过期时间原样带上去，中转才好自己判活');
      const raw = JSON.stringify(payload);
      for (const { credential } of [withTtl, permanent, otherInstance]) {
        assert.equal(raw.includes(credential), false, '凭据原文绝不能进镜像载荷');
      }
    },
  });
});

test('吊销一台设备后清单少一条，并且下一 tick 就推出去', async () => {
  const INSTANCE = 'inst-revoke';
  const keep = credentials.issue(INSTANCE, { deviceId: 'phone-keep' }, 'host-token-keep');
  const drop = credentials.issue(INSTANCE, { deviceId: 'phone-drop' }, 'host-token-drop');
  await withPusher({
    credentialDigests: () => credentials.activeDigests(INSTANCE),
    run: async ({ pusher, pushed, h }) => {
      const stop = pusher.start();
      try {
        await flush();
        assert.equal(pushed[pushed.length - 1].creds.length, 2, '首份镜像应带两条摘要');
        // 先跑一轮后台 tick（轮转窗口还没走过，冷会话要补一份正文），把基准落定。
        h.tick();
        await flush();
        const settled = pushed.length;
        // 什么都没变：这一轮不许再推。否则下面那条「撤销后被推出去」就分不清是谁促成的。
        h.tick();
        await flush();
        assert.equal(pushed.length, settled, '内容与摘要都没变却还在重复推送');

        assert.equal(credentials.revokeDevice(INSTANCE, 'phone-drop'), 1, '吊销应命中那条记录');
        h.tick();
        await flush();
        assert.equal(pushed.length, settled + 1, '撤销设备后必须在一个 tick 内把新摘要推出去');
        const payload = pushed[pushed.length - 1];
        assert.equal(payload.creds.length, 1, '被吊销的那条不能再出现在镜像里');
        assert.equal(payload.creds[0].hash, sha256(keep.credential));
        assert.equal(pusher.getMirrorPush().ok, true);
        const dropHash = sha256(drop.credential);
        assert.equal(
          pushed.slice(settled).some((entry) => Array.isArray(entry.creds) && entry.creds.some((digest) => digest.hash === dropHash)),
          false,
          '撤销之后推出去的镜像里不该再有被吊销的摘要',
        );
      } finally {
        stop();
      }
    },
  });
});

test('隧道未连时不读凭据库（沿用「断线不构建快照」的既有行为）', async () => {
  const INSTANCE = 'inst-offline';
  credentials.issue(INSTANCE, { deviceId: 'phone-off' }, 'host-token-off');
  let digestReads = 0;
  await withPusher({
    tunnelConnected: () => false,
    credentialDigests: () => { digestReads += 1; return credentials.activeDigests(INSTANCE); },
    run: async ({ pusher, pushed }) => {
      await pusher.pushMirror();
      await flush();
      assert.equal(pushed.length, 0, '隧道未连时不该有推送');
      assert.equal(digestReads, 0, '隧道未连时这份清单没有去处，不该白读凭据库');
      const status = pusher.getMirrorPush();
      assert.equal(status.ok, false);
      assert.match(String(status.error), /隧道未连接/);
    },
  });
});

test('activeDigests 只给活记录：吊销与过期都现读现滤', async () => {
  const INSTANCE = 'inst-live-filter';
  const revoked = credentials.issue(INSTANCE, { deviceId: 'phone-revoked' }, 'host-token-1');
  const expired = credentials.issue(INSTANCE, { deviceId: 'phone-expired' }, 'host-token-2', 1);
  const live = credentials.issue(INSTANCE, { deviceId: 'phone-live' }, 'host-token-3');
  assert.equal(credentials.revoke(revoked.credential, INSTANCE), true);
  await delay(5);
  const digests = credentials.activeDigests(INSTANCE);
  assert.deepEqual(digests.map((entry) => entry.hash), [sha256(live.credential)]);
  assert.equal(JSON.stringify(digests).includes(sha256(expired.credential)), false);
});

test('超过 200 条时截断的是最老的，最新签发的仍在清单里', () => {
  const INSTANCE = 'inst-cap';
  const issued = [];
  for (let i = 0; i < 201; i += 1) issued.push(credentials.issue(INSTANCE, { deviceId: `phone-${i}` }, `host-token-${i}`));
  const digests = credentials.activeDigests(INSTANCE);
  assert.equal(digests.length, 200, '上限 200 条');
  assert.equal(digests[0].hash, sha256(issued[200].credential), '最新签发的一条排在最前');
  assert.equal(digests[digests.length - 1].hash, sha256(issued[1].credential), '被截掉的是最早签发的那条');
  assert.equal(digests.some((entry) => entry.hash === sha256(issued[0].credential)), false);
});

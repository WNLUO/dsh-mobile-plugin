'use strict';

// 点对点隧道（P2P）宿主会话的守卫：身份交换、拉起、状态、收尾。
//
// 这一层守的是「插件怎么跟助手说话」，不打真网络：助手是假的，回什么由用例决定。
// 真打洞那段在 Go 的 `p2p` 包里测。

const test = require('node:test');
const assert = require('node:assert');

const { createP2PSession, STATE, P2P_PORT } = require('../lib/p2p/session.cjs');
const { mountP2P } = require('../lib/p2p/wiring.cjs');

/** 一个假助手：把写进来的命令记下来，事件由用例自己喂。 */
function fakeHost() {
  const written = [];
  return {
    written,
    start() {},
    close: async () => {},
    startP2P(options) { written.push({ command: 'p2pStart', ...options }); },
    statusP2P() { written.push({ command: 'p2pStatus' }); },
    stopP2P() { written.push({ command: 'p2pStop' }); },
    newKeysP2P() { written.push({ command: 'p2pKeys' }); },
    status: () => ({ available: true, running: true, ready: true }),
  };
}

function makeSession(state = {}, host = fakeHost()) {
  const saved = { ...state };
  const session = createP2PSession({
    readState: () => saved,
    writeState: (patch) => { Object.assign(saved, patch); },
    localPort: 18787,
    host,
    log: () => {},
  });
  return { session, host, saved };
}

test('没配密钥时不给身份：回 no-identity，并顺手催一次生成', () => {
  const { session, host } = makeSession();
  const reply = session.exchange('peer');
  assert.equal(reply.ok, false);
  assert.equal(reply.error, 'no-identity');
  // 催一次是刻意的：下一次开码就能给出来，否则要等用户再点一次。
  assert.ok(host.written.some((item) => item.command === 'p2pKeys'));
});

test('配好密钥后交换：公钥照给，手机那把存下来', () => {
  const { session, saved } = makeSession({
    [STATE.privateKey]: 'priv', [STATE.publicKey]: 'pub',
  });
  const reply = session.exchange('phone-public-key');
  assert.equal(reply.ok, true);
  assert.equal(reply.publicKey, 'pub');
  assert.equal(reply.port, P2P_PORT);
  assert.equal(saved[STATE.peerKey], 'phone-public-key');
});

test('助手报上来的密钥对要落进配置（私钥进存储，公钥可以给出去）', () => {
  const { session, saved } = makeSession();
  session._event({ event: 'p2pKeys', private: 'new-priv', public: 'new-pub', port: P2P_PORT });
  assert.equal(saved[STATE.privateKey], 'new-priv');
  assert.equal(saved[STATE.publicKey], 'new-pub');
});

test('拉起隧道：按配置里的身份与手机给的候选发命令', async () => {
  const { session, host } = makeSession({
    [STATE.privateKey]: 'priv', [STATE.publicKey]: 'pub',
  });
  const pending = session.open({
    peerKey: 'peer', candidates: ['203.0.113.1:5000'], localCandidates: ['10.0.0.2:5000'],
  });
  // 助手回一句「起来了」。
  session._event({ event: 'p2pReady', url: 'http://10.99.0.1:48950' });
  const reply = await pending;

  assert.equal(reply.ok, true);
  assert.equal(reply.url, 'http://10.99.0.1:48950');
  const start = host.written.find((item) => item.command === 'p2pStart');
  assert.ok(start, '应当发过 p2pStart');
  assert.equal(start.privateKey, 'priv');
  assert.equal(start.peerKey, 'peer');
  assert.deepEqual(start.peerPublic, ['203.0.113.1:5000']);
  assert.deepEqual(start.peerLocal, ['10.0.0.2:5000']);
  // 两个端口各司其职：listen 是手机在隧道里拨的（固定值），target 是本机插件在听的那个
  // （这次没给，按 0 发 —— 助手会自己判非法，因为电脑侧没有落点就无处转发）。
  assert.equal(start.listenPort, P2P_PORT);
  assert.equal(start.targetPort, 0);
});

test('状态如实反映「通没通」：打不通时 active 必须是假', async () => {
  const { session } = makeSession({
    [STATE.privateKey]: 'priv', [STATE.publicKey]: 'pub',
  });
  session._event({ event: 'p2pStatus', running: true, url: 'http://x', path: 'failed', active: false, detail: '{"error":"nat-blocked"}' });
  const status = session.status();
  assert.equal(status.ready, true);
  assert.equal(status.path, 'failed');
  assert.equal(status.active, false, '打不通时绝不能报成可用');
});

test('打通了 active 才是真', async () => {
  const { session } = makeSession({
    [STATE.privateKey]: 'priv', [STATE.publicKey]: 'pub',
  });
  session._event({ event: 'p2pStatus', running: true, url: 'http://x', path: 'direct', active: true, detail: '' });
  const status = session.status();
  assert.equal(status.path, 'direct');
  assert.equal(status.active, true);
});

test('助手报错要落到状态里，别吞掉', () => {
  const { session } = makeSession({
    [STATE.privateKey]: 'priv', [STATE.publicKey]: 'pub',
  });
  session._event({ event: 'error', code: 'nat-blocked' });
  assert.equal(session.status().error, 'nat-blocked');
});

test('停掉之后状态回到「没在跑」', async () => {
  const { session } = makeSession({
    [STATE.privateKey]: 'priv', [STATE.publicKey]: 'pub',
  });
  session._event({ event: 'p2pStatus', running: true, url: 'http://x', path: 'direct', active: true, detail: '' });
  await session.stop();
  const status = session.status();
  assert.equal(status.ready, false);
  assert.equal(status.active, false);
  assert.equal(status.url, '');
});

test('没找到助手时状态是 available:false + helper-missing，而不是抛错', () => {
  const saved = {};
  const session = createP2PSession({
    readState: () => saved,
    writeState: (patch) => Object.assign(saved, patch),
    localPort: 18787,
    resolveBinary: () => null,
    log: () => {},
  });
  const status = session.status();
  assert.equal(status.available, false);
  assert.equal(status.error, 'helper-missing');
  // 拉起时也不该抛：调用方按「这次没有这条通道」处理。
  assert.equal(session.start(), null);
});

test('关掉开关就不起助手（setEnabled 之后 start 直接回 null）', () => {
  const saved = { [STATE.enabled]: false };
  const session = createP2PSession({
    readState: () => saved,
    writeState: (patch) => Object.assign(saved, patch),
    localPort: 18787,
    resolveBinary: () => '/nonexistent/p2p-host',
    log: () => {},
  });
  assert.equal(session.start(), null);
});

test('挂载层：没端口时不建会话，但门面照样能问（回 starting）', async () => {
  let effectFn = null;
  const door = mountP2P({
    mount: (_label, fn) => { effectFn = fn; return fn(); },
    warn: () => {},
    state: {},
    saveState: () => {},
    localPort: () => 0,
    ctx: { effect: (fn) => fn() },
    name: 'test',
  });
  assert.equal(door.status().error, 'starting');
  assert.equal(door.exchange('x').ok, false);
  assert.equal(await door.open({}), null);
  assert.equal(await door.refresh(), null);
});

test('挂载层：有端口就建会话，状态门面接得上', () => {
  const door = mountP2P({
    mount: (_label, fn) => fn(),
    warn: () => {},
    state: { [STATE.privateKey]: 'priv', [STATE.publicKey]: 'pub' },
    saveState: () => {},
    localPort: () => 18787,
    ctx: { effect: (fn) => fn() },
    name: 'test',
  });
  // 会话是异步建好的（Promise.resolve().then），让出一拍。
  return Promise.resolve().then(() => {
    const status = door.status();
    assert.equal(typeof status.available, 'boolean');
    assert.equal(status.available, false, '本机没装助手时就是不可用，这是正常结局');
  });
});

// ── 会合那一环：没有它两端都不知道往哪打洞，这条通道一次都连不上 ────────────────

const { createP2PRendezvousHandler, normalizeCandidates } = require('../lib/p2p/rendezvous.cjs');

/**
 * 一个够用的假 req / res。
 *
 * `res` 要真的接住 `writeHead` / `end`：`sendJson` 就是那么写出去的，不去接就等于
 * 「什么都没发」，断言的失败会伪装成「这个 handler 没回包」。
 */
function fakeHttp(body) {
  // 直接给 `body`：`readJsonBody` 见到它就不再走流那一路（省得在这里模拟一个 stream）。
  const req = { headers: {}, body };
  const res = { req
, statusCode: 0, body: null };
  res.writeHead = (status) => { res.statusCode = status; };
  res.end = (chunk) => { res.body = typeof chunk === 'string' ? chunk : Buffer.from(chunk || '').toString('utf8'); };
  return { req, res };
}

test('会合：电脑把自己那份候选回给手机（打洞的起点）', async () => {
  const opened = [];
  const handler = createP2PRendezvousHandler({
    p2p: {
      constants: { P2P_PORT },
      open: async (options) => {
        opened.push(options);
        return { ok: true, url: 'http://10.99.0.1:48950', candidates: ['198.51.100.7:51820'] };
      },
    },
    lanPortInUse: () => 18787,
  });
  const { req, res } = fakeHttp({
    peerKey: 'peer', candidates: ['203.0.113.1:5000'], localCandidates: ['10.0.0.2:5000'],
  });
  // sendJson 直接写到 res 上；这里拦一层看它交了什么。
  const captured = await captureJson(() => handler(null, req, res), res);
  assert.equal(captured.ok, true);
  assert.equal(captured.available, true);
  assert.deepEqual(captured.candidates, ['198.51.100.7:51820'], '电脑必须把自己的候选回去');
  assert.equal(captured.port, P2P_PORT);
  // 手机那份候选与落点端口都传下去了。
  assert.deepEqual(opened[0].candidates, ['203.0.113.1:5000']);
  assert.deepEqual(opened[0].localCandidates, ['10.0.0.2:5000']);
  assert.equal(opened[0].targetPort, 18787);
});

test('会合：手机没有候选也照接（电脑「只听不打」地起来、把候选报回去）', async () => {
  // 这一条是刻意的：手机第一发本来就可能还没候选（它自己那半边也还没起）。
  // 电脑要是这时拒掉，第一发永远换不到地址，两端谁也不会先开口 —— 死循环。
  const opened = [];
  const handler = createP2PRendezvousHandler({
    p2p: {
      constants: { P2P_PORT },
      open: async (options) => {
        opened.push(options);
        return { ok: true, url: 'http://10.99.0.1:48950', candidates: ['198.51.100.7:51820'] };
      },
    },
    lanPortInUse: () => 18787,
  });
  const { req, res } = fakeHttp({ peerKey: 'peer', candidates: [], localCandidates: [] });
  const captured = await captureJson(() => handler(null, req, res), res);
  assert.equal(captured.ok, true);
  assert.equal(captured.available, true);
  assert.deepEqual(captured.candidates, ['198.51.100.7:51820'], '电脑仍要把自己的候选报回去');
  assert.deepEqual(opened[0].candidates, [], '手机空候选原样传下去');
});

test('会合：这台电脑没这条通道时如实说不可用，不让手机一直等', async () => {
  const handler = createP2PRendezvousHandler({});
  const { req, res } = fakeHttp({ candidates: ['203.0.113.1:5000'] });
  const captured = await captureJson(() => handler(null, req, res), res);
  assert.equal(captured.available, false);
  assert.equal(captured.reason, 'p2p-unavailable');
});

test('会合：助手起不来时也不假装成功', async () => {
  const handler = createP2PRendezvousHandler({
    p2p: { open: async () => ({ ok: false, code: 'nat-blocked' }) },
  });
  const { req, res } = fakeHttp({ candidates: ['203.0.113.1:5000'] });
  const captured = await captureJson(() => handler(null, req, res), res);
  assert.equal(captured.available, false);
  assert.equal(captured.reason, 'nat-blocked');
});

test('候选清洗：坏形状一律丢掉，好形状去重且限量', () => {
  const cleaned = normalizeCandidates([
    '1.2.3.4:5', 'bad!!', '1.2.3.4:5', '[2001:db8::1]:80', 42, '', 'x'.repeat(80),
  ]);
  assert.deepEqual(cleaned, ['1.2.3.4:5', '[2001:db8::1]:80']);
  assert.deepEqual(normalizeCandidates('not-an-array'), []);
  assert.equal(normalizeCandidates(Array.from({ length: 40 }, (_, i) => `10.0.0.${i}:1`)).length, 16);
});

/** 跑一遍 handler，把它写到 res 上的那份 JSON 解出来。 */
async function captureJson(run, res) {
  await run();
  if (!res || !res.body) return {};
  try {
    return JSON.parse(res.body);
  } catch {
    return {};
  }
}

'use strict';

// 点对点隧道（P2P）宿主会话的守卫：身份交换、拉起、状态、收尾。
//
// 这一层守的是「插件怎么跟助手说话」，不打真网络：助手是假的，回什么由用例决定。
// 真打洞那段在 Go 的 `p2p` 包里测。

const test = require('node:test');
const assert = require('node:assert');

const { createP2PSession, STATE, P2P_PORT } = require('../lib/p2p/session.cjs');
const { mountP2P, chooseP2PTarget } = require('../lib/p2p/wiring.cjs');

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

test('拉起隧道：按手机报上来的公钥与候选发命令', async () => {
  const { session, host } = makeSession({
    [STATE.privateKey]: 'priv', [STATE.publicKey]: 'pub',
  });
  const pending = session.open({
    // 手机报上来的 `peerKey` 里装的是**电脑自己的公钥**（它拿它认「对面是那台电脑」），
    // 不是对端公钥 —— 早先这一格被直接当成了 WireGuard 对端，电脑于是跟自己握手。
    peerKey: 'computer-self-public-key',
    phonePublicKey: 'phone-public-key',
    candidates: ['203.0.113.1:5000'], localCandidates: ['10.0.0.2:5000'],
  });
  // 助手回一句「起来了」。
  session._event({ event: 'p2pReady', url: 'http://10.99.0.1:48950' });
  const reply = await pending;

  assert.equal(reply.ok, true);
  assert.equal(reply.url, 'http://10.99.0.1:48950');
  const start = host.written.find((item) => item.command === 'p2pStart');
  assert.ok(start, '应当发过 p2pStart');
  assert.equal(start.privateKey, 'priv');
  assert.equal(start.peerKey, 'phone-public-key', '对端必须是手机那把，不是手机报回来的电脑公钥');
  assert.deepEqual(start.peerPublic, ['203.0.113.1:5000']);
  assert.deepEqual(start.peerLocal, ['10.0.0.2:5000']);
  // 两个端口各司其职：listen 是手机在隧道里拨的（固定值），target 是本机插件在听的那个
  // （这次没给，按 0 发 —— 助手会自己判非法，因为电脑侧没有落点就无处转发）。
  assert.equal(start.listenPort, P2P_PORT);
  assert.equal(start.targetPort, 0);
});

test('另一台手机正在用时如实说「被占用」，绝不去抢（抢就会两边端口乱跳、永远打不穿）', async () => {
  // 这条通道一次只服务一个对端，所以多台手机同时在线时必须有一个人退让。
  // 早先这里是「换设备就重开」，于是 A 起来 → B 把 A 踢掉 → 下一轮 A 又把 B 踢掉：
  // 每抢一次 socket 端口都换一个，两端手里的候选永远对不上，打洞永远打不穿，而面板上
  // 它老老实实报 `punching` / `failed`，看起来像 NAT 太严。真机上一平板一手机同时开着
  // 就是这个场面 —— 抢是错的，让才是对的。
  const { session, host } = makeSession({
    [STATE.privateKey]: 'priv', [STATE.publicKey]: 'pub',
  });
  const first = session.open({ phonePublicKey: 'phone-a', candidates: ['203.0.113.1:5000'] });
  session._event({ event: 'p2pReady', url: 'http://10.99.0.1:48950' });
  await first;

  const second = await session.open({ phonePublicKey: 'phone-b', candidates: ['203.0.113.2:5000'] });

  assert.equal(second.ok, false, '第二台手机必须拿到明确的「不可用」');
  assert.equal(second.code, 'busy', '原因要说清是「别人在用」，不是笼统的起不来');
  const starts = host.written.filter((item) => item.command === 'p2pStart');
  assert.equal(starts.length, 1, '不许把第一台那条收掉重开 —— 那一收一开就把端口换掉了');
  assert.ok(!host.written.some((item) => item.command === 'p2pStop'), '不许停别人的隧道');
});

test('同一台手机、候选一模一样再来一次不重开（别每分钟踢掉已经打通的洞）', async () => {
  // 判据是「同一把手机公钥 + 同一个候选集合」（决策见 lib/p2p/session.cjs 的 open）。
  // 早先这条只判公钥，连候选变了也复用 —— 那一条是错的，理由见下面「候选变了要重开」。
  // 候选**顺序不同、内容相同**不算变：手机每轮报上来的先后本来就不稳定，按顺序比就是
  // 每轮重开一次，用户感受到的是「网一分钟断一次」。
  const { session, host } = makeSession({
    [STATE.privateKey]: 'priv', [STATE.publicKey]: 'pub',
  });
  const first = session.open({
    phonePublicKey: 'phone-a',
    candidates: ['203.0.113.1:5000', '203.0.113.2:5001'],
    localCandidates: ['10.0.0.2:5000'],
  });
  session._event({ event: 'p2pReady', url: 'http://10.99.0.1:48950' });
  await first;

  const again = await session.open({
    phonePublicKey: 'phone-a',
    candidates: ['203.0.113.2:5001', '203.0.113.1:5000'],
    localCandidates: ['10.0.0.2:5000'],
  });
  assert.equal(again.ok, true, '同一份候选要照常回现状');

  const starts = host.written.filter((item) => item.command === 'p2pStart');
  assert.equal(starts.length, 1, '同一把手机公钥 + 同一份候选不该重开');
  assert.ok(!host.written.some((item) => item.command === 'p2pStop'));
});

test('候选真的变了要重开（只听不打起来的隧道拿不到新候选，公网永远往空气里打）', async () => {
  // 电脑第一次常常是在手机还没报出候选时以「只听不打」起来的。之后手机把真实候选报上来，
  // 若判据只看公钥，电脑就一直复用一个没有任何对端地址的隧道 —— 永远不往手机打。
  // 局域网还能通，只因为手机摸得到电脑的内网地址、先从那边打过来了；一到公网就只剩「等待」。
  // 这是这条通道公网打不通的头号原因，所以候选必须进判据。
  const { session, host } = makeSession({
    [STATE.privateKey]: 'priv', [STATE.publicKey]: 'pub',
  });
  const first = session.open({ phonePublicKey: 'phone-a', candidates: [] });
  session._event({ event: 'p2pReady', url: 'http://10.99.0.1:48950' });
  await first;

  const second = session.open({ phonePublicKey: 'phone-a', candidates: ['203.0.113.9:6000'] });
  session._event({ event: 'p2pReady', url: 'http://10.99.0.1:48951', candidates: [] });
  await second;

  const starts = host.written.filter((item) => item.command === 'p2pStart');
  assert.equal(starts.length, 2, '候选从空变成有地址，必须按新候选重开一次');
  assert.deepEqual(starts[1].peerPublic, ['203.0.113.9:6000'], '重开那一发必须带上新候选');
});

test('被 busy 拒掉的那台不许改盘上的对端公钥（否则下一轮原来那台反被当成别人）', async () => {
  // 落盘顺序的坑：早先是「先把手机公钥落盘成 p2pPeerKey，再判 busy」。于是一台被拒的手机
  // 也把盘上那份改了，原来那台下次来会合时 `peerKey === runningPeer` 不成立、反被判成
  // 「另一台」，两台谁也接不上。落盘必须在两道门（复用 / busy）之后。
  const { session, saved } = makeSession({
    [STATE.privateKey]: 'priv', [STATE.publicKey]: 'pub',
  });
  const first = session.open({ phonePublicKey: 'phone-a', candidates: ['203.0.113.1:5000'] });
  session._event({ event: 'p2pReady', url: 'http://10.99.0.1:48950' });
  await first;
  assert.equal(saved[STATE.peerKey], 'phone-a');

  const second = await session.open({ phonePublicKey: 'phone-b', candidates: ['203.0.113.2:5000'] });
  assert.equal(second.code, 'busy');
  assert.equal(saved[STATE.peerKey], 'phone-a', '被拒的那台不许把盘上的对端改掉');
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
    // 钉住「本机没装助手」：不钉的话，开发机上刚好编好了助手，这条用例就会去拉一个
    // 真的子进程，结果取决于这台机器，而不是这段代码。
    resolveBinary: () => null,
  });
  // 会话是异步建好的（Promise.resolve().then），让出一拍。
  return Promise.resolve().then(() => {
    const status = door.status();
    assert.equal(typeof status.available, 'boolean');
    assert.equal(status.available, false, '本机没装助手时就是不可用，这是正常结局');
  });
});

test('挂载层：门面必须带出 P2P 端口常量（会合回包要用，缺了手机就判「这次没有」）', () => {
  const door = mountP2P({
    mount: (_label, fn) => fn(),
    warn: () => {},
    state: {},
    saveState: () => {},
    localPort: () => 0,
    ctx: { effect: (fn) => fn() },
    name: 'test',
  });
  // 这一条是用真实装配出来的门面跑的：早先守卫自己喂了一份带常量的假门面，
  // 于是「真实门面根本没有这个字段」一路绿到了真机上。
  assert.equal(door.constants && door.constants.P2P_PORT, P2P_PORT);
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

test('会合：手机的公钥要一层层交到会话，并落盘（电脑拿它配对端）', async () => {
  const phoneKey = 'uQ8Z9nq1k7Yb3r5T2mW4xV6cL0aE8hJ1sDfG3kMn5pQ=';
  const opened = [];
  const handler = createP2PRendezvousHandler({
    p2p: {
      constants: { P2P_PORT },
      open: async (options) => {
        opened.push(options);
        return { ok: true, candidates: ['198.51.100.7:51820'] };
      },
    },
    lanPortInUse: () => 18787,
  });
  const { req, res } = fakeHttp({ peerKey: 'computer-self-public-key', phonePublicKey: phoneKey, candidates: [] });
  await captureJson(() => handler(null, req, res), res);
  assert.equal(opened[0].phonePublicKey, phoneKey, '手机公钥要原样交给会话');
  // 手机发回来的 `peerKey` 是**电脑自己的**公钥，绝不能当对端传下去（那一格只配当「对面是谁」的确认）。
  assert.equal(opened[0].peerKey, undefined, '电脑公钥不许被当成对端公钥交给会话');

  // 会话那一头：拿到了就存下来，并且之后拉起隧道用的是它。
  const { session, host, saved } = makeSession({
    [STATE.privateKey]: 'priv', [STATE.publicKey]: 'pub',
  });
  const pending = session.open({ phonePublicKey: phoneKey, candidates: ['198.51.100.7:51820'] });
  session._event({ event: 'p2pReady', url: 'http://x', candidates: [] });
  await pending;
  assert.equal(saved[STATE.peerKey], phoneKey, '手机公钥必须落盘，进程重启后还得接着用');
  assert.equal(host.written.find((item) => item.command === 'p2pStart').peerKey, phoneKey);
});

test('会合：公钥形状不对一律不收（空白 / 太短 / 太长）', async () => {
  const opened = [];
  const handler = createP2PRendezvousHandler({
    p2p: {
      constants: { P2P_PORT },
      open: async (options) => {
        opened.push(options);
        return { ok: true, candidates: ['198.51.100.7:51820'] };
      },
    },
    lanPortInUse: () => 18787,
  });
  const { req, res } = fakeHttp({ peerKey: 'peer', phonePublicKey: 'not-a-key', candidates: [] });
  await captureJson(() => handler(null, req, res), res);
  assert.equal(opened[0].phonePublicKey, '');
});

test('会合与轮询同时在等时，两边都要收到回执（单等待位会被顶掉，会合永远超时）', async () => {
  // 这条钉的是一个真事故：`waiting` 只放得下一个等待者，而会话起好后状态轮询每 2 秒就要问
  // 一次现状。手机的会合请求刚把等待位放进去，下一拍轮询就把它顶掉 —— 助手回的 `p2pReady`
  // 交给了轮询，会合这一发永远等不到回执。表现是「会合必超时、P2P 永远接不上」，而电脑
  // 那头一切正常。两个等待者必须都能收到同一条事件。
  const { session } = makeSession({ [STATE.privateKey]: 'priv', [STATE.publicKey]: 'pub' });
  const pending = session.open({ candidates: [] });
  const polling = session.refresh();
  session._event({ event: 'p2pReady', url: 'http://127.0.0.1:1', candidates: ['1.2.3.4:5'] });
  const openReply = await Promise.race([pending, new Promise((r) => setTimeout(() => r('TIMEOUT'), 3000))]);
  const pollReply = await Promise.race([polling, new Promise((r) => setTimeout(() => r('TIMEOUT'), 3000))]);
  assert.notEqual(openReply, 'TIMEOUT', '会合必须收到回执（单等待位会被轮询顶掉）');
  assert.notEqual(pollReply, 'TIMEOUT', '轮询也要收到回执');
});

test('状态要能区分「还没人接」与「正在起」（否则面板永远说「正在启动」）', () => {
  const { session } = makeSession({
    [STATE.privateKey]: 'priv', [STATE.publicKey]: 'pub',
  });
  // 从没被会合叫起来过：ready 假、started 假 —— 这是「还没有手机来会合」，不是「正在启动」。
  const idle = session.status();
  assert.equal(idle.ready, false);
  assert.equal(idle.started, false);
});

test('起过一次之后 started 要变真（面板据此说「正在打洞」而不是「等人接」）', async () => {
  const { session } = makeSession({
    [STATE.privateKey]: 'priv', [STATE.publicKey]: 'pub',
  });
  const pending = session.open({ candidates: [] });
  session._event({ event: 'p2pReady', url: 'http://x', candidates: [] });
  await pending;
  assert.equal(session.status().started, true);
});

test('会话启动时就催一次密钥对（否则没开过码的机器上这条通道永远是死的）', () => {
  const { session, host } = makeSession({});
  // 没配过密钥：`start()` 应当顺手催一次 `p2pKeys`，而不是等到有人点开二维码才生成。
  session.start();
  assert.ok(host.written.some((item) => item.command === 'p2pKeys'));
});

test('会话：进程重启后能从盘上读回对端公钥（否则配不出设备、永远起不来）', async () => {
  const { session, host } = makeSession({
    [STATE.privateKey]: 'priv', [STATE.publicKey]: 'pub', [STATE.peerKey]: 'phoneKeyFromDisk',
  });
  const pending = session.open({ candidates: ['198.51.100.7:51820'] });
  session._event({ event: 'p2pReady', url: 'http://x', candidates: [] });
  await pending;
  assert.equal(host.written.find((item) => item.command === 'p2pStart').peerKey, 'phoneKeyFromDisk');
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

test('会合：落点端口取门面给的，不是硬编码的局域网端口（局域网关着时那个口没人听）', async () => {
  // 隧道会「连上了却毫无反应」的那个坑：局域网关着时局域网端口根本没在监听，隧道照旧往它
  // 转，握手成功、数据一到就断。门面（`lib/p2p/wiring.cjs`）自己知道该转谁，会合这条路
  // 必须用它的答案，而不是自己拿 `lanPortInUse`。
  const opened = [];
  const handler = createP2PRendezvousHandler({
    p2p: {
      constants: { P2P_PORT },
      targetPort: () => 19485,
      open: async (options) => {
        opened.push(options);
        return { ok: true, candidates: [] };
      },
    },
    // 局域网端口那一份是**诱饵**：谁要是回退到它，这条就红。
    lanPortInUse: () => 18787,
  });
  const { req, res } = fakeHttp({ phonePublicKey: 'phoneKey', candidates: ['203.0.113.1:5000'] });
  await captureJson(() => handler(null, req, res), res);
  assert.equal(opened[0].targetPort, 19485, '必须用门面给的落点端口，局域网关着时它才是 webServer.port');
});

test('挂载层：落点端口跟局域网开关走（局域网开着转局域端口，关着转 web 端口）', async () => {
  // 样板是直连隧道的 `chooseTailcatTarget`，判据一模一样：两条隧道最终都转给
  // 「手机上那个 API」，只是局域网关着时它住在宿主 web 端口上。
  let lanOn = true;
  const target = chooseP2PTarget({
    lanEnabled: () => lanOn,
    lanPort: () => 18787,
    webPort: () => 19485,
  });
  const door = mountP2P({
    mount: (_label, fn) => fn(),
    warn: () => {},
    state: {},
    saveState: () => {},
    localPort: () => 18787,
    targetPort: target,
    ctx: { effect: (fn) => fn() },
    name: 'test',
    // 同上：钉住「本机没装助手」，别真拉一个子进程起来。
    resolveBinary: () => null,
  });
  assert.equal(door.targetPort(), 18787, '局域网开着：与一台 LAN 手机走同一条路');
  lanOn = false;
  assert.equal(door.targetPort(), 19485, '局域网关着：那个口没人听，必须转宿主 web 端口');
});

test('挂载层：没给 targetPort 时退回 localPort（老形状，行为不变）', () => {
  const door = mountP2P({
    mount: (_label, fn) => fn(),
    warn: () => {},
    state: {},
    saveState: () => {},
    localPort: () => 18787,
    ctx: { effect: (fn) => fn() },
    name: 'test',
    resolveBinary: () => null,
  });
  assert.equal(door.targetPort(), 18787);
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

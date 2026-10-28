'use strict';

/**
 * 镜像帧过隧道前只带中转会读的字段。
 *
 * 桌面推上来的整份载荷有四块：`sessions`、`workspaces`、`messages`、`stats`/`models`。
 * 中转（`server/relay/rust/src/mirror.rs` 的 `remember`）只落前两块，另外三块解析完
 * 就丢 —— 它只解决「宿主不在线时手机还看得见清单」。而正文快照恰好是最大的一块：
 * 实测一个 200 条消息的会话快照约 58KB，且它在**每个会话事件**上都会被重推一次。
 *
 * 两条同时钉住，缺一条就会把好事做坏：
 *  1. 上隧道的那一帧里没有 messages / stats / models；
 *  2. **本地快照（局域网直连的读取隔离）仍然带着全部字段** —— 裁了它等于把
 *     `snapshotRead` 一起砍掉，手机上「打开对话立刻有内容」就没了。
 *
 * 第三条（2026-10-28 加）：中转在注册回执里说自己**不存镜像**（`mirror:false`，纯转发节点，
 * `MIRROR_CACHE=0`）时，连两份清单正文也一起裁到只剩 `ok/revision/generatedAt` 加凭据摘要。
 * 这种节点收下正文也只解析完就丢，而那是每台宿主每 5 秒几十 KB —— 美国那台实测入向
 * 1.9MB/s、一天两百多 GB 全打了水漂。回执里没有这个字段（老中转）一律按「存」处理，
 * 行为与加这个能力之前一字不差。
 *
 * 跑法：`node dsh-mobile-plugin/test/mirror-frame-slim.test.cjs`。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { WebSocketServer } = require('ws');

const path = require('node:path');
const { SidecarFacade } = require('../lib/sidecar-facade.cjs');
const { T, jsonFrame, createFrameDecoder } = require('../lib/relay/protocol.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs, message) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(message);
};

/** 一份有正文、统计与模型的镜像载荷：形状照宿主真实推的那个。 */
const mirrorPayload = (filler = 'x') => ({
  kind: 'sync',
  at: Date.now(),
  activeSessionId: 'session-a',
  sessions: { ok: true, revision: 'rev-s', generatedAt: Date.now(), items: [{ sessionId: 'session-a' }] },
  workspaces: { ok: true, revision: 'rev-w', generatedAt: Date.now(), items: [{ id: 'w1' }] },
  messages: { 'session-a': { ok: true, lastSeq: 42, items: [{ id: 'm1', role: 'assistant', text: filler.repeat(4000) }] } },
  stats: { 'session-a': { ok: true, projections: { tokens: { total: 1234 } } } },
  models: { 'session-a': { ok: true, revision: 'rev-m', groups: [{ id: 'g1', name: '默认' }] } },
});

/** 起一个假中转：完成注册并解出收到的每一帧 sync。`ackPayload` 就是中转回的那条 registered。 */
async function startRig(ackPayload = {}) {
  const parent = http.createServer((_req, res) => { res.writeHead(404); res.end('{}'); });
  await new Promise((resolve) => parent.listen(0, '127.0.0.1', resolve));

  const frames = [];
  const relay = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ server: relay });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const push = createFrameDecoder((frame) => {
        if (frame.type !== T.sync) return;
        try { frames.push(JSON.parse(frame.payload.toString('utf8'))); } catch { /* 交给断言去红 */ }
      });
      push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });
    setTimeout(() => { try { ws.send(jsonFrame(T.registered, 0, ackPayload)); } catch { /* ignore */ } }, 30);
  });
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));

  const facade = new SidecarFacade({ parentPort: parent.address().port, token: randomBytes(32).toString('hex') });
  await facade.start();
  await facade.configure({
    enabled: true,
    relayUrl: `http://127.0.0.1:${relay.address().port}`,
    instanceId: 'i1',
    pairingCode: '123456',
    name: 'Test',
    upstreamPort: 12345,
    lanPort: 18787,
    lanEnabled: false,
    lanSecret: randomBytes(32).toString('hex'),
  });
  await waitFor(async () => (await facade.request('/status')).tunnel.state === 'connected', 5000, '隧道应注册成功');
  return {
    facade,
    frames,
    stop: async () => {
      await facade.stop();
      await new Promise((resolve) => relay.close(resolve));
      await new Promise((resolve) => parent.close(resolve));
    },
  };
}

test('上隧道的镜像帧裁掉 messages/stats/models，清单与工作区照旧', async () => {
  const rig = await startRig();
  try {
    const sent = mirrorPayload();
    await rig.facade.pushSync(sent);
    await waitFor(() => rig.frames.length > 0, 3000, '中转侧应收到这一帧 sync');
    const got = rig.frames[0];

    assert.equal(got.messages, undefined, '正文不该上隧道：中转只落清单与工作区');
    assert.equal(got.stats, undefined, '统计同样没人读');
    assert.equal(got.models, undefined, '模型目录同样没人读');
    // 该留的一个都不许少：中转按这三样判「这份镜像还能不能用」。
    assert.deepEqual(got.sessions, sent.sessions);
    assert.deepEqual(got.workspaces, sent.workspaces);
    assert.equal(got.kind, 'sync', '帧类型字段必须留着，中转按它判形状');
    assert.ok(Number.isFinite(got.at), 'at 要留着，它是快照新鲜度的判据');

    // 收益的量级：这一帧应当不到原载荷的两成。
    const before = Buffer.byteLength(JSON.stringify(sent));
    const after = Buffer.byteLength(JSON.stringify(got));
    assert.ok(after < before * 0.2, `裁剪后应不到原来的两成：${after} vs ${before}`);
  } finally {
    await rig.stop();
  }
});

test('本地快照仍留全份：局域网直连的读取隔离不能被一起砍掉', async () => {
  const rig = await startRig();
  try {
    const sent = mirrorPayload('y');
    await rig.facade.pushSync(sent);
    await waitFor(() => rig.frames.length > 0, 3000, '隧道侧应收到这一帧');

    // 局域网直连的手机走 snapshotRead，读的就是 worker 本地这份 localSnapshot，
    // 而它只从 `/tunnel/send` 的原始 body 赋值 —— 裁剪只能发生在「上隧道那一帧」上。
    // 这里按调用点次序钉住：赋值必须排在 `frameForTunnel(body)` 那次调用之前。
    // （用调用点的字面量而不是函数定义：定义在文件上半部分，按字符串位置比会永远通过。）
    const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'lib', 'sidecar-facade-worker.cjs'), 'utf8');
    const assignAt = source.indexOf('localSnapshot = body');
    const frameCallAt = source.indexOf('tunnel.sendJson(frameType, 0, frameForTunnel(body, relayMirror === false))');
    assert.ok(assignAt > 0, '没找到本地快照赋值');
    assert.ok(frameCallAt > 0, '没找到上隧道的调用点');
    assert.ok(assignAt < frameCallAt, '本地快照必须在裁剪之前落地，否则读取隔离会一起丢正文');
  } finally {
    await rig.stop();
  }
});

test('非 sync 的帧（推送令牌）一个字段都不裁', async () => {
  const rig = await startRig();
  try {
    // push 帧走 pushRegister / pushSend，形状与镜像无关；这里确认它没被顺手裁掉。
    const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'lib', 'sidecar-facade-worker.cjs'), 'utf8');
    const fn = source.slice(source.indexOf('function frameForTunnel'), source.indexOf('function frameForTunnel') + 400);
    assert.match(fn, /kind !== 'sync'/, '只对 sync 帧生效，其余原样返回');
  } finally {
    await rig.stop();
  }
});

test('对端在回执里说不存镜像（mirror:false）：清单与工作区正文也不上隧道', async () => {
  const rig = await startRig({ ok: true, mirror: false });
  try {
    // 现场形状：每台宿主每 5 秒一份，清单几十条、工作区里还带着整串归档 id。
    const sent = mirrorPayload('z');
    sent.sessions.items = Array.from({ length: 60 }, (_, i) => ({ sessionId: `s${i}`, title: '标题'.repeat(10), cwd: '/ws/a' }));
    sent.workspaces.items = Array.from({ length: 200 }, (_, i) => ({ workspaceId: `w${i}`, path: `/ws/${i}` }));
    sent.creds = [{ hash: 'abc123', expiresAt: 0 }];

    await rig.facade.pushSync(sent);
    await waitFor(() => rig.frames.length > 0, 3000, '中转侧应收到这一帧 sync');
    const got = rig.frames[0];

    assert.deepEqual(got.sessions, { ok: true, revision: 'rev-s' }, '对端不存镜像，清单正文一个字节都不该上隧道');
    assert.deepEqual(got.workspaces, { ok: true, revision: 'rev-w' }, '工作区正文（含归档 id 列表）是最大的一块，同样不该推');
    assert.deepEqual(got.creds, [{ hash: 'abc123', expiresAt: 0 }], '凭据摘要是 /push-token 的鉴权真源，丢了它上报全 403');
    assert.equal(got.kind, 'sync', '帧类型字段必须留着，中转按它判形状');
    assert.ok(Number.isFinite(got.at), 'at 要留着，它是快照新鲜度的判据');

    const before = Buffer.byteLength(JSON.stringify(sent));
    const after = Buffer.byteLength(JSON.stringify(got));
    assert.ok(after < 1024, `摘要帧应当只有几百字节：${after}`);
    assert.ok(after < before / 20, `应当不到原来的二十分之一：${after} vs ${before}`);

    // 这个口径要能在 /status 里看见，否则运维没法判断「这台到底在推什么」。
    assert.equal((await rig.facade.request('/status')).tunnel.mirror, false);
  } finally {
    await rig.stop();
  }
});

test('老中转的回执里没有 mirror 字段：清单照旧整份推上去', async () => {
  const rig = await startRig({ ok: true });
  try {
    const sent = mirrorPayload('q');
    await rig.facade.pushSync(sent);
    await waitFor(() => rig.frames.length > 0, 3000, '中转侧应收到这一帧 sync');
    assert.deepEqual(rig.frames[0].sessions, sent.sessions, '没这个字段就是老中转，行为必须与加能力之前一字不差');
    assert.equal((await rig.facade.request('/status')).tunnel.mirror, true, '缺省按「存」处理');
  } finally {
    await rig.stop();
  }
});

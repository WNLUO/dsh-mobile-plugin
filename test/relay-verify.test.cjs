'use strict';

/**
 * 试连中转的**真实现**（`lib/relay/verify.js`）：拿临时实例 id 真连一次、注册上了才算地址
 * 能用，连完立刻断开。
 *
 * 宿主侧那几条 handler 测试把试连换成了假体（它们要钉的是「不落盘」「400 带原因」），这个
 * 文件补的是假体盖不住的那一半：帧真的发出去了吗、注册被拒时错误是不是原样浮上来、临时 id
 * 是不是真的与正式 id 不同。用一个只认 register / registered 两帧的假中转，全程环回。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { WebSocketServer } = require('ws');

const { verifyRelayRegistration, probeInstanceId, PROBE_MARK } = require('../lib/relay/verify.js');
const { T, encodeFrame, createFrameDecoder, parseJson } = require('../lib/relay/protocol.js');

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 假中转：收 register → 回 registered（或按 `reject` 直接关连接）。
 * 返回 `seen`：每条隧道收到的注册帧与它有没有被断开。
 */
async function startFakeRelay({ reject = null } = {}) {
  const seen = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  server.on('connection', (ws) => {
    const entry = { registrations: [], closed: false, closeReason: '' };
    seen.push(entry);
    const push = createFrameDecoder((frame) => {
      if (frame.type !== T.register) return;
      const msg = parseJson(frame.payload);
      entry.registrations.push(msg);
      if (reject) {
        ws.close(1008, reject);
        return;
      }
      ws.send(encodeFrame(T.registered, 0, Buffer.alloc(0)));
    });
    ws.on('message', (data) => push(Buffer.isBuffer(data) ? data : Buffer.from(data)));
    ws.on('close', (code, reason) => { entry.closed = true; entry.closeReason = String(reason || '') });
  });
  const { port } = server.address();
  return {
    seen,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('probeInstanceId：带标记段、每次都不一样、必然不等于正式 id', () => {
  const one = probeInstanceId('inst1');
  const two = probeInstanceId('inst1');
  assert.ok(one.startsWith('inst1'), '临时 id 以正式 id 打头，中转侧看得出是谁在试');
  assert.ok(one.includes(PROBE_MARK), '要带标记段');
  assert.notEqual(one, 'inst1', '临时 id 与正式 id 必须不同：撞上就把正在服务的那条顶掉');
  assert.notEqual(one, two, '两次试连不能共用一个 id（上一条迁移记录还没过期时会互相取代）');
});

test('试连成功：真的注册了一次，然后立刻断开（不在中转上留实例）', async () => {
  const relay = await startFakeRelay();
  try {
    const result = await verifyRelayRegistration({
      relayUrl: relay.url,
      instanceId: probeInstanceId('inst1'),
      upstreamPort: 19387,
      name: 'Mac',
      registerSecret: 'sec',
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(relay.seen.length, 1);
    const entry = relay.seen[0];
    assert.equal(entry.registrations.length, 1, '注册帧要真的发出去');
    assert.ok(entry.registrations[0].instanceId.includes(PROBE_MARK));
    assert.equal(entry.registrations[0].secret, 'sec', '试连也要过中转的准入校验，否则验证等于没做');
    // 「连完马上断」是这条的全部意义：留一个实例在中转上，下次真连接会被它顶一下。
    await wait(150);
    assert.equal(entry.closed, true, '试连结束后必须断开');
  } finally {
    await relay.close();
  }
});

test('试连被拒：错误原样抛出（手机上那句提示就是它），连接照样断掉', async () => {
  const relay = await startFakeRelay({ reject: 'bad registration secret' });
  try {
    await assert.rejects(
      () => verifyRelayRegistration({
        relayUrl: relay.url,
        instanceId: probeInstanceId('inst1'),
        upstreamPort: 19387,
        name: 'Mac',
      }),
      /bad registration secret/,
    );
    await wait(150);
    assert.equal(relay.seen[0].closed, true, '失败也要断：不然那头留一条半死的连接');
  } finally {
    await relay.close();
  }
});

test('地址形状不对：连都不连，当场抛（与保存配置同一个判据）', async () => {
  await assert.rejects(
    () => verifyRelayRegistration({
      relayUrl: 'relay.example.com',
      instanceId: probeInstanceId('inst1'),
      upstreamPort: 19387,
    }),
    /无效的中转地址/,
  );
});

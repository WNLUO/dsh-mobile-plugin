'use strict';

/**
 * 换中转地址的「搬迁登记」——顺序就是这个功能的全部。
 *
 * 现场：手机和电脑面板上把中转地址一改，这台电脑在旧中转上就没有了；还握着旧地址的设备只会
 * 在旧中转上找它，于是「换了个服务器，只有配过的那台还能用，别的设备永远学不到新地址」。
 * 修法不是改挺多地方，而是把顺序钉死：**旧隧道上先发 MIGRATE → 等帧真的出去 → 才建新隧道**；
 * 新隧道注册不上就发 `to:""` 撤销，并把错误原样往回抛。
 *
 * 这里不碰网络：隧道是假体，断言的是「第几帧、发在谁身上、什么时候才许停旧的」。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  switchRelay,
  announce,
  revoke,
  migrateTarget,
  MIGRATE_FLUSH_MS,
  OLD_TUNNEL_LINGER_MS,
} = require('../lib/relay/migrate.js');
const { T, TYPE_NAME } = require('../lib/relay/protocol.js');

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 假隧道：记下每一帧、记下自己被停没有。 */
function fakeTunnel({ connected = true } = {}) {
  const frames = [];
  const tunnel = {
    connected,
    stopped: false,
    frames,
    sendJson(type, id, body) {
      if (!tunnel.connected) return false;
      frames.push({ type, id, body, at: Date.now() });
      return true;
    },
    stop() {
      tunnel.stopped = true;
      tunnel.connected = false;
    },
  };
  return tunnel;
}

test('帧编号与名字：0x1C / migrate（与 relay-core 逐字节对齐的那一格）', () => {
  assert.equal(T.migrate, 0x1c, 'MIGRATE 必须是 0x1C');
  assert.equal(TYPE_NAME[0x1c], 'migrate', '反查表里的名字就叫 migrate');
  // 与相邻的编号不能撞：撞了等于两件事共用一帧，中转那边只能二选一。
  assert.equal(Object.values(T).filter((code) => code === 0x1c).length, 1);
});

test('migrateTarget：去空白与尾斜杠，与设备手里那份是同一个字符串', () => {
  assert.equal(migrateTarget('  https://relay2.example.com/  '), 'https://relay2.example.com');
  assert.equal(migrateTarget('https://relay2.example.com//'), 'https://relay2.example.com');
  assert.equal(migrateTarget(undefined), '');
});

test('换地址：MIGRATE 先离开本机，新隧道才被建起来', async () => {
  const old = fakeTunnel();
  const order = [];
  let openedAt = 0;
  const announced = await switchRelay({
    oldTunnel: old,
    // 尾斜杠会被规范化：设备手里、配置里、帧里必须是同一份。
    relayUrl: 'https://relay2.example.com/',
    open: async () => { order.push('open'); openedAt = Date.now(); return {}; },
    drop: (tunnel) => { order.push('drop'); tunnel.stop(); },
  });

  assert.equal(announced, true, '旧隧道连着呢，这一帧应该真发出去了');
  assert.deepEqual(order, ['open'], '旧隧道此刻还不许收：它还要打电话把响应送回去，失败时也只有它能发撤销');
  assert.equal(old.frames.length, 1, '只该有那一帧 MIGRATE');
  const frame = old.frames[0];
  assert.equal(frame.type, 0x1c);
  assert.equal(frame.id, 0, '控制帧一律 id=0');
  assert.equal(frame.body.to, 'https://relay2.example.com');
  assert.equal(typeof frame.body.at, 'number', 'at 是毫秒时间戳（中转用它算迁移记录的年龄）');
  // 帧与重建之间必须真有一段等待：紧接着拆旧隧道会把还没出队的 MIGRATE 一起带走。
  assert.ok(
    openedAt - frame.at >= MIGRATE_FLUSH_MS - 5,
    `帧发出到重建只隔了 ${openedAt - frame.at}ms，短于留出的 ${MIGRATE_FLUSH_MS}ms`,
  );

  // 注册成功后旧隧道才收，而且要留够让那一发 HTTP 响应沿着老路回完。
  assert.equal(old.stopped, false, '注册刚成功就收旧隧道，那一发「已受理」会丢在迁移里');
  await wait(OLD_TUNNEL_LINGER_MS + 100);
  assert.equal(old.stopped, true, '留够时间之后旧隧道要收掉，否则中转上一直挂着一条僵尸连接');
  assert.deepEqual(order, ['open', 'drop']);
});

test('新隧道注册不上：先撤销登记，再把错误原样抛回调用方', async () => {
  const old = fakeTunnel();
  const dropped = [];
  await assert.rejects(
    () => switchRelay({
      oldTunnel: old,
      relayUrl: 'https://relay2.example.com',
      open: async () => { throw new Error('隧道关闭: 1008 bad registration secret'); },
      drop: (tunnel) => { dropped.push(tunnel); tunnel.stop(); },
    }),
    /bad registration secret/,
    '失败原因不许被换成一句笼统的「配置下发失败」：手机上那句提示就是它',
  );

  // 第一帧登记、第二帧撤销 —— 顺序反过来等于先撤销再登记，旧中转会把设备送进一个死地址。
  assert.deepEqual(
    old.frames.map((frame) => frame.body.to),
    ['https://relay2.example.com', ''],
    '失败必须紧跟一条 to:"" 的撤销',
  );
  assert.equal(old.frames[1].type, 0x1c);
  // 撤销之后**不能立刻关**：那一句「为什么没成」要沿旧隧道回到发起这次切换的请求上。
  assert.equal(dropped.length, 0, '撤销刚发出去就关掉旧隧道，错误提示会跟着一起丢');
  assert.equal(old.stopped, false);
  await wait(OLD_TUNNEL_LINGER_MS + 100);
  assert.equal(dropped.length, 1, '留够时间之后旧隧道也要收掉：配置已经换成新地址，它不该继续冒充');
  assert.equal(old.stopped, true);
});

test('旧隧道本来就没连上：不发帧、不撤销，照样把新地址建起来', async () => {
  const old = fakeTunnel({ connected: false });
  let opened = 0;
  const announced = await switchRelay({
    oldTunnel: old,
    relayUrl: 'https://relay2.example.com',
    open: async () => { opened += 1; return {}; },
    drop: () => {},
  });
  assert.equal(announced, false);
  assert.equal(old.frames.length, 0, '没连着就没有「在旧隧道上登记」这件事');
  assert.equal(opened, 1, '重建还是要做的');
});

test('没有旧隧道（第一次配地址）：不发帧、不收谁，也不抛', async () => {
  let opened = 0;
  let dropped = 0;
  const announced = await switchRelay({
    oldTunnel: null,
    relayUrl: 'https://relay2.example.com',
    open: async () => { opened += 1; return {}; },
    drop: () => { dropped += 1; },
  });
  assert.equal(announced, false);
  assert.equal(opened, 1);
  assert.equal(dropped, 0, '没有旧隧道就没有要收的那一条');
});

test('announce / revoke 只认「还连着」的隧道', () => {
  const connected = fakeTunnel();
  assert.equal(announce(connected, 'https://relay2.example.com'), true);
  assert.equal(revoke(connected), true);
  const offline = fakeTunnel({ connected: false });
  assert.equal(announce(offline, 'https://relay2.example.com'), false);
  assert.equal(revoke(offline), false);
});

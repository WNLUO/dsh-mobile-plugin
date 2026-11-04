'use strict';

/**
 * 「让 AI 操作手机」宿主侧的两条守卫：**会话绑哪台** 与 **动作通道**。
 *
 * 绑定的每条规则坏起来都不报错：多绑一台就是「B 手机上一句话，任务跑到 A 上去了」；少记
 * 一次 `last` 就是「老会话永远问不出该操作哪台」。动作通道坏起来更安静：在途 op 不结算，
 * 界面上只是「点了一下，半分钟没反应」。
 *
 * 所以这里用真 WebSocket（http 服务器自己接升级）+ 临时 DSH_HOME，驱动真实现：
 *   - `phone/binding.js`：第一次发消息即绑定、之后跨设备继续聊不改绑、显式改绑、无绑定不猜；
 *   - `phone/service.js`：op → 手机 → result 的一整圈、超时、断线、未知动作、同一台重连顶掉旧的；
 *   - `phone/tools.js`：模型那组工具的**参数表里没有 deviceId**（目标只能来自绑定）。
 *
 * 运行：node --test test/phone-control.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { WebSocket } = require('ws');

// 绑定账落在 $DSH_HOME 下，而 paths 在调用时解析 —— 先把 HOME 指到临时目录再 require。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-phone-control-'));
process.env.DSH_HOME = home;
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const binding = require('../lib/mobile/phone/binding.js');
const { createPhoneService, ACTIONS } = require('../lib/mobile/phone/service.js');
const { installPhoneTools } = require('../lib/mobile/phone/tools.js');

function freshBinding() {
  fs.rmSync(binding.stateFile(), { force: true });
  binding.resetForTest();
}

/** 起一条真的可以升级的 http 服务器，把升级交给 `service.handleUpgrade`。 */
async function listen(service, { authorized = (req) => req.headers['x-dsh-device-credential'] === 'ok' } = {}) {
  const server = http.createServer((_req, res) => res.end('no'));
  server.on('upgrade', (req, socket, head) => {
    service.authorized = authorized; // 测试替身：只判那一个头
    service.handleUpgrade(req, socket, head);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, url: `ws://127.0.0.1:${port}/api/mobile/v1/phone/control` };
}

/** 连一台「手机」，把收到的 op 交给 `onOp` 处理。 */
function connectPhone(url, deviceId, onOp) {
  const socket = new WebSocket(url, { headers: { 'x-dsh-device': deviceId, 'x-dsh-device-credential': 'ok' } });
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.t === 'ping') return socket.send(JSON.stringify({ t: 'pong' }));
    if (frame.t !== 'op') return;
    const reply = onOp(frame);
    // 返回 null 表示这一条刻意不回：超时 / 断线那几条要考的就是「手机不回话」。
    if (reply === null) return;
    const value = reply || {};
    socket.send(JSON.stringify({ t: 'result', id: frame.id, ok: value.ok !== false, data: value.data, error: value.error }));
  });
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** 关测试用的服务器：`close()` 只等已有连接自己结束，挂着的手机连接会让它永远不回调。 */
function closeAll(server) {
  try { server.closeAllConnections?.(); } catch { /* 没有这个方法的老 Node 就直接 close */ }
  try { server.close(); } catch { /* 已经关了 */ }
}

/** 等这台手机在服务里登记上（`welcome` 之后才一定在）。 */
async function waitOnline(service, deviceId) {
  for (let i = 0; i < 100; i += 1) {
    if (service.isOnline(deviceId)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`${deviceId} 一直没连上`);
}

// ── 一、绑定账 ───────────────────────────────────────────────────────────────

test('第一条消息就绑定，之后同一台继续发不重绑', () => {
  freshBinding();
  assert.equal(binding.boundDeviceOf('s1'), null);
  const first = binding.noteSender('s1', 'phone-a');
  assert.equal(first.bound, 'phone-a');
  assert.equal(first.changed, true);
  const second = binding.noteSender('s1', 'phone-a');
  assert.equal(second.changed, false);
  assert.equal(binding.boundDeviceOf('s1'), 'phone-a');
});

test('换一台手机继续聊，绑定的还是原来那台（last 跟着走）', () => {
  freshBinding();
  binding.noteSender('s2', 'phone-a');
  binding.noteSender('s2', 'phone-b');
  assert.equal(binding.boundDeviceOf('s2'), 'phone-a', '绑定不该被后一台改掉');
  assert.equal(binding.lastSenderOf('s2'), 'phone-b');
  const resolved = binding.resolveTarget('s2');
  assert.deepEqual(resolved, { deviceId: 'phone-a', from: 'bound', changed: false });
});

test('没带设备头（桌面端 / 测试 / 老客户端）不进账', () => {
  freshBinding();
  binding.noteSender('s3', '');
  assert.equal(binding.boundDeviceOf('s3'), null);
  binding.noteRequestSender({ headers: {} }, 's3');
  assert.equal(binding.boundDeviceOf('s3'), null);
  // 已经绑好的会话也不会被这种调用清掉
  binding.noteSender('s3', 'phone-a');
  binding.noteRequestSender({ headers: {} }, 's3');
  assert.equal(binding.boundDeviceOf('s3'), 'phone-a');
});

test('请求头里的设备号会被认出来，数组形状也认', () => {
  freshBinding();
  binding.noteRequestSender({ headers: { 'x-dsh-device': 'phone-z' } }, 's4');
  assert.equal(binding.boundDeviceOf('s4'), 'phone-z');
  binding.noteRequestSender({ headers: { 'x-dsh-device': ['phone-y'] } }, 's5');
  assert.equal(binding.boundDeviceOf('s5'), 'phone-y');
});

test('显式改绑只动 bound，不动 last', () => {
  freshBinding();
  binding.noteSender('s6', 'phone-a');
  binding.noteSender('s6', 'phone-b');
  const resolved = binding.resolveTarget('s6', 'phone-b');
  assert.deepEqual(resolved, { deviceId: 'phone-b', from: 'explicit', changed: true });
  assert.equal(binding.boundDeviceOf('s6'), 'phone-b');
  assert.equal(binding.lastSenderOf('s6'), 'phone-b');
});

test('三条路都空就是空，不去猜一台在线的', () => {
  freshBinding();
  assert.deepEqual(binding.resolveTarget('nobody'), { deviceId: '', from: '', changed: false });
});

test('只有 last 的老会话按 last 算（这一条要回写绑定）', () => {
  freshBinding();
  // 模拟「这个功能上线之前就有这条会话」：盘上只有 last，没有 bound。
  fs.mkdirSync(path.dirname(binding.stateFile()), { recursive: true });
  fs.writeFileSync(binding.stateFile(), JSON.stringify({
    version: 1,
    sessions: { old: { bound: '', boundAt: 0, last: 'phone-a', lastAt: 1 } },
  }));
  binding.resetForTest();
  const resolved = binding.resolveTarget('old');
  assert.deepEqual(resolved, { deviceId: 'phone-a', from: 'sender', changed: true });
});

test('解除某台手机时只清指向它的绑定，last 留着', () => {
  freshBinding();
  binding.noteSender('s7', 'phone-a');
  binding.noteSender('s8', 'phone-b');
  const cleared = binding.clearBindingForDevice('phone-a');
  assert.equal(cleared, 1);
  assert.equal(binding.boundDeviceOf('s7'), null, '绑定该被清掉');
  assert.equal(binding.lastSenderOf('s7'), 'phone-a', '「谁发过消息」是事实，不该被解绑改掉');
  assert.equal(binding.boundDeviceOf('s8'), 'phone-b', '别的手机一条都不许碰');
});

test('绑定账重启后还在（落盘）', () => {
  freshBinding();
  binding.noteSender('s9', 'phone-a');
  binding.resetForTest(); // 丢掉内存那份，模拟进程重启
  assert.equal(binding.boundDeviceOf('s9'), 'phone-a');
});

// ── 二、动作通道 ─────────────────────────────────────────────────────────────

test('op 发到那台手机，回包按 id 对上', async () => {
  const service = createPhoneService({ authorized: () => true });
  const { server, url } = await listen(service);
  const seen = [];
  const phone = await connectPhone(url, 'd1', (frame) => {
    seen.push(frame);
    return { data: { ok: true, echo: frame.action } };
  });
  await waitOnline(service, 'd1');

  const result = await service.call('d1', 's1', 'screen.read', { includeText: false });
  assert.equal(result.ok, true);
  assert.equal(result.data.echo, 'screen.read');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sessionId, 's1', 'sessionId 要原样带过去（宿主按它算绑定）');

  phone.close();
  await new Promise((r) => setTimeout(r, 20));
  closeAll(server);
  service.close();
});

test('手机不在线：立刻以 offline 失败，不干等到超时', async () => {
  const service = createPhoneService({ authorized: () => true });
  await assert.rejects(
    () => service.call('nobody', 's1', 'screen.read', {}),
    (error) => error.code === 'offline',
  );
  service.close();
});

test('动作表是封闭的：表外的名字一律拒', async () => {
  const service = createPhoneService({ authorized: () => true });
  const { server, url } = await listen(service);
  const phone = await connectPhone(url, 'd1', () => ({ data: {} }));
  await waitOnline(service, 'd1');

  for (const name of ['shell', 'exec', 'run', 'screen.read; rm -rf /']) {
    await assert.rejects(
      () => service.call('d1', 's1', name, {}),
      (error) => error.code === 'unknown-action',
    );
  }
  // 动作表里没有一个是能透传命令的
  for (const name of ACTIONS.keys()) {
    assert.doesNotMatch(name, /shell|exec|run|command/i, `${name} 看起来像命令透传口子`);
  }

  phone.close();
  await new Promise((r) => setTimeout(r, 20));
  closeAll(server);
  service.close();
});

test('手机不回应时按自己的预算超时，并给手机发一条 cancel', async () => {
  const service = createPhoneService({ authorized: () => true });
  const { server, url } = await listen(service);
  const cancels = [];
  const phone = new WebSocket(url, { headers: { 'x-dsh-device': 'd1', 'x-dsh-device-credential': 'ok' } });
  phone.on('message', (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.t === 'cancel') cancels.push(frame.id);
    // op 故意不回：这一条要考的就是预算
  });
  await new Promise((resolve) => phone.once('open', resolve));
  await waitOnline(service, 'd1');

  await assert.rejects(
    () => service.call('d1', 's1', 'tap', { ref: 'e1' }, { timeoutMs: 120 }),
    (error) => error.code === 'timeout',
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(cancels.length, 1, '超时之后要撤销那一步，否则下一个 op 会错位');

  phone.close();
  await new Promise((r) => setTimeout(r, 20));
  closeAll(server);
  service.close();
});

test('手机断开时，在途的那一步立刻以 offline 结算', async () => {
  const service = createPhoneService({ authorized: () => true });
  const { server, url } = await listen(service);
  const phone = await connectPhone(url, 'd1', () => null); // 永不回包

  await waitOnline(service, 'd1');
  const pending = service.call('d1', 's1', 'tap', { ref: 'e1' }, { timeoutMs: 5_000 });
  await new Promise((r) => setTimeout(r, 20));
  phone.close();

  await assert.rejects(() => pending, (error) => error.code === 'offline');
  assert.equal(service.isOnline('d1'), false);

  closeAll(server);
  service.close();
});

test('同一台手机重连：新的顶掉旧的，旧那条的在途 op 一起结算', async () => {
  const service = createPhoneService({ authorized: () => true });
  const { server, url } = await listen(service);
  const first = await connectPhone(url, 'd1', () => null);
  await waitOnline(service, 'd1');
  // 先挂上 catch 再等：这条 promise 会在下面的重连之前就被结算，晚挂 handler 会让 Node
  // 把它当未处理的拒绝报出来（判决还是对的，但输出里多一条误导性的警告）。
  const stale = service.call('d1', 's1', 'tap', { ref: 'e1' }, { timeoutMs: 5_000 })
    .then(() => null, (error) => error);
  await new Promise((r) => setTimeout(r, 20));

  const second = await connectPhone(url, 'd1', (frame) => ({ data: { who: 'second', action: frame.action } }));
  const staleError = await stale;
  assert.equal(staleError && staleError.code, 'replace', '旧那条连接上的在途 op 要一起结算');
  const result = await service.call('d1', 's1', 'screen.read', {});
  assert.equal(result.data.who, 'second', '新连接才该收到后面的 op');

  first.close();
  second.close();
  await new Promise((r) => setTimeout(r, 20));
  closeAll(server);
  service.close();
});

test('没带设备标识的升级一律拒（没法路由到某台）', async () => {
  const service = createPhoneService({ authorized: () => true });
  const { server, url } = await listen(service);
  const phone = new WebSocket(url, { headers: { 'x-dsh-device-credential': 'ok' } });
  const outcome = await new Promise((resolve) => {
    phone.once('error', (error) => resolve({ failed: true, message: error.message }));
    phone.once('open', () => resolve({ failed: false }));
  });
  assert.equal(outcome.failed, true, '缺 x-dsh-device 时不该握手成功');
  assert.match(outcome.message, /400/);
  closeAll(server);
  service.close();
});

test('凭据不对一律拒', async () => {
  const service = createPhoneService({ authorized: () => false });
  const { server, url } = await listen(service, { authorized: () => false });
  const phone = new WebSocket(url, { headers: { 'x-dsh-device': 'd1', 'x-dsh-device-credential': 'bad' } });
  const outcome = await new Promise((resolve) => {
    phone.once('error', (error) => resolve({ failed: true, message: error.message }));
    phone.once('open', () => resolve({ failed: false }));
  });
  assert.equal(outcome.failed, true);
  assert.match(outcome.message, /401/);
  closeAll(server);
  service.close();
});

// ── 三、工具的参数表 ─────────────────────────────────────────────────────────

/**
 * 宿主那一侧 `tools` 是子代理作用域提供的服务：插件只能在 `ctx.inject(['tools'], …)` 的
 * 回调里拿到它，直接读 `ctx.tools` 是 undefined。假体照这个形状给，别图省事写成
 * `{ tools: { register } }` —— 那会让「注册路径写错了」这件事在测试里照样绿。
 */
function fakeCtx(register) {
  const calls = [];
  return {
    calls,
    inject(names, callback) {
      calls.push(names);
      callback({ tools: { register } });
    },
  };
}

test('工具走 ctx.inject([tools]) 注册，不是直接读 ctx.tools', () => {
  const registered = [];
  const ctx = fakeCtx((tool) => registered.push(tool));
  installPhoneTools(ctx, { getService: () => null, listDevices: () => [], describeDevice: (id) => id });
  assert.deepEqual(ctx.calls, [['tools']], '没走 tools 注入，宿主里这条注册会静默丢掉');
  assert.ok(registered.length >= 8, `工具没注册全（${registered.length} 条）`);
});

test('模型那组工具里没有任何一条能自己指定手机', () => {
  const registered = [];
  const ctx = fakeCtx((tool) => registered.push(tool));
  installPhoneTools(ctx, {
    getService: () => null,
    listDevices: () => [],
    describeDevice: (id) => id,
  });

  assert.ok(registered.length >= 8, `工具没注册全（${registered.length} 条）`);
  for (const tool of registered) {
    const keys = Object.keys(tool.parameters || {});
    assert.ok(!keys.includes('deviceId') || tool.name === 'phone_target', `${tool.name} 不该让模型自己挑设备`);
    const shape = JSON.stringify(tool.parameters || {});
    assert.doesNotMatch(shape, /shell|exec|command|cmd|bash/i, `${tool.name} 的参数里有像命令的口子`);
  }
  // 动作名与宿主服务那张表对得上（名字里 phone_ 前缀去掉之后是 action 的驼峰写法）
  const names = registered.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'phone_apps', 'phone_key', 'phone_open_app', 'phone_screen',
    'phone_scroll', 'phone_tap', 'phone_target', 'phone_type',
  ]);
});

test('没有目标手机时工具报一句能照做的话，而不是默默挑一台', async () => {
  freshBinding();
  const registered = new Map();
  const ctx = fakeCtx((tool) => registered.set(tool.name, tool));
  installPhoneTools(ctx, {
    getService: () => ({ isOnline: () => true }),
    listDevices: () => [],
    describeDevice: (id) => id,
  });
  const tool = registered.get('phone_screen');
  // 会话 id 在 `exec.agent.id`：写成 `agent.session.id` 的话这里恒为空串，绑定永远读不到。
  await assert.rejects(
    () => tool.execute({}, { agent: { id: 'no-binding' }, signal: undefined }),
    /还没有指定要操作哪台手机/,
  );
});

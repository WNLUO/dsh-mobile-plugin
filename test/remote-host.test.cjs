// 真实HTTP/WS验证单次授权、记录变更和逐设备断流。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { fixture, waitClose } = require('./remote-host-fixture.cjs');
const { pairComputer, openRemoteStream, probeRemote, callRemoteControl } = require('../lib/remote/transport.cjs');
const { INVITE_TTL } = require('../lib/remote/host.cjs');

const deadline = { timeout: 8000 };

test('邀请10分钟、单次有效；仅显式邀请签发remoteWeb且移动权限为空', deadline, async () => {
  const f = await fixture();
  try {
    const invite = await f.invite();
    assert.equal(invite.expiresAt - f.now(), INVITE_TTL);
    const binding = await pairComputer(invite, { name: '电脑B', deviceId: 'b' });
    assert.equal(binding.name, '远端电脑 A');
    assert.equal(binding.connectionInfo.p2p.publicKey, 'public');
    assert.equal(f.records[0].remoteWeb, true);
    assert.deepEqual(f.records[0].permissions, []);
    await assert.rejects(pairComputer(invite), { code: 'REMOTE_AUTH' });
    assert.equal(f.records.length, 1);
    const stale = await f.invite();
    f.advance(INVITE_TTL + 1);
    await assert.rejects(pairComputer(stale), { code: 'REMOTE_AUTH' });
    assert.equal(f.records.length, 1);
    const plain = await new Promise((resolve, reject) => {
      const req = http.request(`${f.route.url}/api/mobile/v1/remote-computers/pair`, { method: 'POST' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end(JSON.stringify({ code: '123456' }));
    });
    assert.equal(plain, 401);
    const getStatus = await new Promise((resolve, reject) => {
      http.get(`${f.route.url}/api/mobile/v1/remote-computers/pair`, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
    });
    assert.equal(getStatus, 405);
  } finally { await f.close(); }
});

test('吊销只断目标设备；降权、过期及记录消失主动断连接', deadline, async () => {
  const f = await fixture();
  try {
    const a = await pairComputer(await f.invite(), { deviceId: 'b1' });
    const b = await pairComputer(await f.invite(), { deviceId: 'b2' });
    const first = await openRemoteStream(a, f.route);
    const second = await openRemoteStream(b, f.route);
    const closeFirst = waitClose(first.stream);
    const firstFailure = once(first.stream, 'error');
    f.host.revoke(a.deviceId);
    await closeFirst;
    assert.equal((await firstFailure)[0].code, 'REMOTE_REVOKED', '终止原因必须通过已认证密文到达');
    assert.equal(second.stream.destroyed, false);
    const closeSecond = waitClose(second.stream);
    f.records.find((record) => record.deviceId === b.deviceId).remoteWeb = false;
    f.host.checkAuthorization();
    await closeSecond;
    await assert.rejects(probeRemote(b, f.route), { code: 'REMOTE_REVOKED' });
    const third = await openRemoteStream(a, f.route);
    const closeThird = waitClose(third.stream);
    f.records.find((record) => record.deviceId === a.deviceId).expiresAt = f.now() - 1;
    f.host.checkAuthorization();
    await closeThird;
    const d = await pairComputer(await f.invite(), { deviceId: 'b3' });
    const fourth = await openRemoteStream(d, f.route);
    const closeFourth = waitClose(fourth.stream);
    f.records.splice(f.records.findIndex((record) => record.deviceId === d.deviceId), 1);
    f.host.checkAuthorization();
    await closeFourth;
  } finally { await f.close(); }
});

test('控制消息只允许固定操作且不拨网页端口，仍要求remoteWeb授权', deadline, async () => {
  const f = await fixture();
  try {
    const binding = await pairComputer(await f.invite());
    const result = await callRemoteControl(binding, f.route, { op: 'tunnels', tailcatPublicKey: 'public' });
    assert.deepEqual(result, { routes: [f.route] });
    assert.equal(f.controls.length, 1);
    assert.equal(f.upstreamConnections, 0);
    await assert.rejects(callRemoteControl(binding, f.route, { op: 'shell' }), { code: 'REMOTE_CONTROL' });
    assert.equal(f.controls.length, 1);
    f.records[0].remoteWeb = false;
    await assert.rejects(callRemoteControl(binding, f.route, { op: 'tunnels' }), { code: 'REMOTE_REVOKED' });
  } finally { await f.close(); }
});

test('吊销后新连接必须通过已认证拒绝，普通手机凭据不能打开网页', deadline, async () => {
  const f = await fixture();
  try {
    const binding = await pairComputer(await f.invite());
    f.records[0].revokedAt = f.now();
    await assert.rejects(openRemoteStream(binding, f.route), { code: 'REMOTE_REVOKED' });
    f.records[0].revokedAt = 0;
    f.records[0].expiresAt = f.now() - 1;
    await assert.rejects(openRemoteStream(binding, f.route), { code: 'REMOTE_EXPIRED' });
    delete f.records[0].expiresAt;
    delete f.records[0].remoteWeb;
    await assert.rejects(openRemoteStream(binding, f.route), { code: 'REMOTE_CONNECT' });
    assert.equal(f.upstreamConnections, 0);
  } finally { await f.close(); }
});

test('一百次认证探测不受配对限流影响，未认证并发有界', deadline, async () => {
  const f = await fixture();
  const idle = [];
  try {
    const binding = await pairComputer(await f.invite());
    for (let i = 0; i < 100; i++) await probeRemote(binding, f.route);
    for (let i = 0; i < 32; i++) {
      const ws = new WebSocket(`${f.route.url.replace('http:', 'ws:')}/api/mobile/v1/remote-computers/tunnel`);
      await once(ws, 'open');
      idle.push(ws);
    }
    await assert.rejects(probeRemote(binding, f.route), { code: 'REMOTE_CONNECT' });
  } finally {
    for (const ws of idle) ws.terminate();
    await f.close();
  }
});

test('等待固定上游入口时吊销，不得继续拨号或交付metadata', deadline, async () => {
  let release;
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const f = await fixture({ getUpstreamPort: () => { entered(); return new Promise((resolve) => { release = resolve; }); } });
  try {
    const binding = await pairComputer(await f.invite());
    const pending = assert.rejects(openRemoteStream(binding, f.route), { code: 'REMOTE_REVOKED' });
    await waiting;
    f.records[0].revokedAt = f.now();
    f.host.checkAuthorization();
    release(12345);
    await pending;
    assert.equal(f.upstreamConnections, 0);
  } finally { await f.close(); }
});

test('网页令牌缺失时明确拒绝，不返回空凭据或拨上游', deadline, async () => {
  const f = await fixture({ getLaunchToken: () => '' });
  try {
    const binding = await pairComputer(await f.invite());
    await assert.rejects(openRemoteStream(binding, f.route), { code: 'REMOTE_UNAVAILABLE' });
    assert.equal(f.upstreamConnections, 0);
  } finally { await f.close(); }
});

test('配对请求版本号是数字但不等于1时回版本不兼容', deadline, async () => {
  const f = await fixture();
  try {
    const invite = await f.invite();
    const result = await new Promise((resolve, reject) => {
      const req = http.request(`${f.route.url}/api/mobile/v1/remote-computers/pair`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        let raw = ''; res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => { let body = {}; try { body = JSON.parse(raw); } catch { /* 空响应按无 code 处理 */ } resolve({ status: res.statusCode, body }); });
      });
      req.on('error', reject);
      req.end(JSON.stringify({ ticketId: invite.ticketId, instanceId: 'instance-a', v: 2 }));
    });
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'REMOTE_VERSION');
  } finally { await f.close(); }
});

test('信令消息版本号是数字但不等于1时按版本不兼容关闭连接', deadline, async () => {
  const f = await fixture();
  try {
    const ws = new WebSocket(`${f.route.url.replace('http:', 'ws:')}/api/mobile/v1/remote-computers/tunnel`);
    await once(ws, 'open');
    const closed = once(ws, 'close');
    ws.send(JSON.stringify({ v: 2, type: 'hello', instanceId: 'instance-a', keyId: '0123456789abcdef' }));
    const [code] = await closed;
    assert.equal(code, 1011, '版本不兼容走协议错误码而不是普通鉴权的 4003');
  } finally { await f.close(); }
});

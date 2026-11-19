// 验证移动读接口取消、逐页停止、通道识别与按设备关闭原始升级连接。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { requestSignal } = require('../lib/shared/fresh-request');
const { viaChannel, withViaHeader } = require('../lib/shared/via-header');
const registry = require('../lib/mobile/stream-registry.js');
const { handleSessionDelivery } = require('../lib/mobile/session-delivery');
const { handleSessionStep } = require('../lib/mobile/session-step');
const { handleSessionChanges, readTurnEvents } = require('../lib/mobile/session-changes');
const { handleStopSummary } = require('../lib/mobile/session-stop-summary');
const { handleSessionHead } = require('../lib/mobile/session-head');
const { handleMessages } = require('../lib/mobile/session-snapshot');
const { handleSessionFile } = require('../lib/mobile/session-file');

function response() {
  const res = new EventEmitter();
  res.writes = [];
  res.writeHead = () => {};
  res.setHeader = () => {};
  res.end = (value) => { res.writes.push(value); res.writableEnded = true; };
  return res;
}
const ok = (value) => ({ result: { ok: true, value } });

test('同一响应复用signal；close/error均取消，不影响其他响应', () => {
  const first = response();
  const second = response();
  assert.equal(requestSignal(first), requestSignal(first));
  const next = requestSignal(second);
  first.emit('close');
  assert.equal(requestSignal(first).aborted, true);
  assert.equal(next.aborted, false);
  second.emit('error', new Error('gone'));
  assert.equal(next.aborted, true);
});

const reads = [
  ['delivery', handleSessionDelivery, '/session/delivery?sessionId=cancel-delivery&clientMessageId=c'],
  ['step', handleSessionStep, '/session/step?sessionId=cancel-step&kind=tool&callId=c&seq=4'],
  ['changes', handleSessionChanges, '/session/changes?sessionId=cancel-changes&turn=1'],
  ['stop-summary', handleStopSummary, '/session/stop-summary?sessionId=cancel-summary'],
  ['head', handleSessionHead, '/session/head?sessionId=cancel-head'],
  ['messages', handleMessages, '/session/messages?sessionId=cancel-messages'],
];
for (const [name, handler, url] of reads) {
  test(`${name}把客户端close传给真实history RPC且不再派生/写响应`, async () => {
    const res = response();
    let started;
    let release;
    let seen;
    const ready = new Promise((resolve) => { started = resolve; });
    const ctx = { apiProxy: { sessions: { history: (_request, signal) => {
      seen = signal;
      started();
      return new Promise((resolve) => { release = () => resolve(ok({ events: [], hasMore: true })); });
    } } } };
    const pending = handler(ctx, { url, headers: {} }, res);
    await ready;
    assert.ok(seen instanceof AbortSignal);
    res.emit('close');
    assert.equal(seen.aborted, true);
    release();
    await pending;
    assert.equal(res.writes.length, 0);
  });
}

test('轮次分页即使上游忽略取消，也不再拉下一页', async () => {
  const controller = new AbortController();
  let calls = 0;
  const ctx = { apiProxy: { sessions: { history: async (_request, signal) => {
    assert.equal(signal, controller.signal);
    calls += 1;
    controller.abort();
    return ok({ events: [{ type: 'assistant/message', seq: 4, data: { turn: 2 } }], hasMore: true });
  } } } };
  await assert.rejects(readTurnEvents(ctx, 's', 1, {}, controller.signal), { code: 'aborted' });
  assert.equal(calls, 1);
});

test('会话外声明文件的history鉴权扫描随断开取消', async () => {
  const res = response();
  let started;
  let release;
  let seen;
  const ready = new Promise((resolve) => { started = resolve; });
  const ctx = { apiProxy: { sessions: {
    list: async () => ok({ items: [] }),
    history: (_request, signal) => { seen = signal; started(); return new Promise((resolve) => { release = () => resolve(ok({ events: [] })); }); },
  } } };
  const pending = handleSessionFile(ctx, { body: { sessionId: 's', path: '/outside-output.txt' }, headers: {} }, res);
  await ready;
  res.emit('close');
  assert.equal(seen.aborted, true);
  release();
  await pending;
  assert.equal(res.writes.length, 0);
});

test('各可信入口通道可识别，未知标记不能冒充已知通道', () => {
  for (const channel of ['relay', 'lan', 'tunnel', 'p2p', 'direct', 'ipv6', 'tcp', 'mux']) {
    const headers = withViaHeader({ 'X-Dsh-Via': ['', 'lan'] }, channel, 'localhost:1');
    assert.equal(viaChannel({ headers }), channel);
    assert.equal(Object.keys(headers).filter((name) => name.toLowerCase() === 'x-dsh-via').length, 1);
  }
  assert.equal(viaChannel({ headers: { 'x-dsh-via': 'unknown' } }), '');
});

test('设备吊销销毁原始升级socket并保持其他设备连接', () => {
  registry.reset();
  const first = new EventEmitter();
  const second = new EventEmitter();
  first.end = () => {};
  first.destroy = () => { first.destroyed = true; first.emit('close'); };
  second.end = () => {};
  second.destroy = () => { second.destroyed = true; second.emit('close'); };
  first.once('close', registry.track('first', first));
  second.once('close', registry.track('second', second));
  assert.equal(registry.drop('first'), 1);
  assert.equal(first.destroyed, true);
  assert.equal(second.destroyed, undefined);
  assert.equal(registry.size(), 1);
  second.destroy();
  assert.equal(registry.size(), 0);
});

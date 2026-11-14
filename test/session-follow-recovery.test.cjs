'use strict';

// 正文订阅结束或失败必须结束会话流，清理其他订阅并允许客户端续传。
const test = require('node:test');
const assert = require('node:assert/strict');
const { muxFrames } = require('../lib/mobile/host-bridge/event-synthesis.js');
const fs = require('node:fs');
const Module = require('node:module');

function fixture(outcome, seq = 7, createMux = muxFrames) {
  const controller = new AbortController();
  const closed = [];
  const opened = [];
  const gateway = {
    async stream(request) {
      const kind = `${request.namespace}/${request.method}`;
      opened.push(kind);
      if (kind === 'session/follow' && outcome === 'opening-error') throw new Error('follow opening failed');
      return (async function* () {
        try {
          if (kind === 'session/follow') {
            yield { type: 'event', event: { type: 'assistant/message', seq, data: {} } };
            if (outcome === 'error') throw new Error('follow disconnected');
            return;
          }
          await new Promise(resolve => {
            if (request.signal.aborted) resolve();
            else request.signal.addEventListener('abort', resolve, { once: true });
          });
        } finally { closed.push(kind); }
      })();
    },
  };
  const ctx = { get: name => name === 'typertGateway' ? gateway : null, logger: { warn() {} } };
  const iterator = createMux(ctx, { payload: { sessionId: 'recovery' } }, controller.signal)[Symbol.asyncIterator]();
  return { iterator, controller, closed, opened, ctx };
}

async function settle(promise) {
  let outcome;
  promise.then(value => { outcome = { value }; }, error => { outcome = { error }; });
  for (let i = 0; i < 80; i += 1) await Promise.resolve();
  return outcome;
}

for (const kind of ['eof', 'error', 'opening-error']) {
  test(`正文 ${kind} 后不留下只有心跳的会话流`, async () => {
    const run = fixture(kind);
    try {
      if (kind !== 'opening-error') assert.equal((await run.iterator.next()).value.payload.event.seq, 7);
      const result = await settle(run.iterator.next());
      assert.ok(result, '正文来源已失效，外层迭代器不能继续等待其他订阅');
      if (kind === 'eof') assert.equal(result.value.done, true);
      else assert.match(result.error.message, /follow/);
      await settle(Promise.resolve());
      assert.ok(run.closed.includes('session/control'), '正文退出必须取消状态订阅');
      assert.ok(run.closed.includes('job/list'), '正文退出必须取消任务订阅');
    } finally { run.controller.abort(); }
  });
}

test('正文重连后仍能交付下一段消息', async () => {
  const first = fixture('eof');
  try {
    await first.iterator.next();
    const ended = await settle(first.iterator.next());
    assert.equal(ended?.value.done, true);
    const next = fixture('eof', 8);
    try { assert.equal((await next.iterator.next()).value.payload.event.seq, 8); }
    finally { next.controller.abort(); await next.iterator.return(); }
  } finally { first.controller.abort(); }
});

test('正文订阅退出后会话响应停止心跳并要求按水位续传', async () => {
  const { handleStream } = require('../lib/mobile/stream.js');
  const run = fixture('eof');
  const listeners = new Map();
  const response = {
    chunks: [], writableEnded: false,
    writeHead(_status, headers) { this.headers = headers; },
    write(chunk) { this.chunks.push(String(chunk)); return true; },
    end() { this.writableEnded = true; },
    on(event, callback) { listeners.set(event, callback); },
  };
  const ctx = { apiProxy: { events: { mux: (request, signal) => muxFrames(run.ctx, request, signal) }, sessions: { history: async () => ({ result: { ok: true, value: { events: [] } } }) } } };
  const done = handleStream(ctx, { url: '/api/mobile/v1/session/stream?sessionId=recovery', headers: {} }, response);
  try {
    const outcome = await settle(done);
    assert.ok(outcome, '正文退出必须让会话响应落地');
    if (outcome.error) throw outcome.error;
    const frames = response.chunks.flatMap(chunk => chunk.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))));
    assert.equal(response.writableEnded, true);
    assert.equal(response.headers['x-dsh-heartbeat-ms'], '15000');
    assert.equal(frames.at(-1).type, 'session/resync-required');
    assert.equal(frames.at(-1).final, true);
    assert.equal(frames.at(-1).oldestSeq, 8);
  } finally { listeners.get('close')?.(); run.controller.abort(); await done; }
});

test('变异证明：吞掉正文退出会再次留下空转会话流', async () => {
  const file = require.resolve('../lib/mobile/host-bridge/event-synthesis.js');
  const raw = fs.readFileSync(file, 'utf8');
  const changed = raw.replace("if (opening[winner.index][0] === 'follow') return;", '');
  assert.notEqual(changed, raw);
  const instance = new Module(file, module);
  instance.filename = file;
  instance.paths = Module._nodeModulePaths(require('node:path').dirname(file));
  instance._compile(changed, file);
  const run = fixture('eof', 7, instance.exports.muxFrames);
  try {
    await run.iterator.next();
    const pending = run.iterator.next();
    assert.equal(await settle(pending), undefined, '删除正文退出处理后，故障用例必须识别到挂起');
    run.controller.abort();
    await pending;
  } finally { run.controller.abort(); }
});

'use strict';

/** Regression coverage for regular/subagent message history and HTTP error semantics. */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { handleMessages } = require('../lib/mobile/session-snapshot.js');
const { thinEntryMessages } = require('../lib/mobile/history-derive.js');

const ROUTE = '/api/mobile/v1/session/messages';
const okValue = (value) => ({ result: { ok: true, value } });
const errValue = (error) => ({ result: { ok: false, error } });

async function serve({ sessionsHistory, subagentsHistory } = {}) {
  const calls = [];
  const ctx = {
    apiProxy: {
      sessions: {
        history: async (request, signal) => {
          calls.push({ namespace: 'sessions', request, signal });
          return sessionsHistory ? sessionsHistory(request, signal) : okValue({ events: [], hasMore: false });
        },
      },
      subagents: {
        history: async (request, signal) => {
          calls.push({ namespace: 'subagents', request, signal });
          return subagentsHistory ? subagentsHistory(request, signal) : okValue({ events: [], hasMore: false });
        },
      },
    },
  };
  const server = http.createServer((req, res) => {
    Promise.resolve(handleMessages(ctx, req, res)).catch((error) => {
      if (res.headersSent || res.writableEnded) return;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String(error) } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    calls,
    url: (query = '') => `http://127.0.0.1:${port}${ROUTE}${query}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('普通会话继续走 sessions.history', async () => {
  const host = await serve();
  try {
    const response = await fetch(host.url('?sessionId=root-1&limit=25'));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.equal(host.calls.length, 1);
    assert.equal(host.calls[0].namespace, 'sessions');
    assert.deepEqual(host.calls[0].request, {
      rpcId: 'mobile',
      method: 'session.history',
      payload: { sessionId: 'root-1', maxMessages: 25 },
    });
  } finally {
    await host.close();
  }
});

test('子代理走同一条 session.history，只是 payload 带上父会话与模式', async () => {
  // 宿主 0.2.1 起已经没有 `subagents.history` 这个远程方法（只剩 prompt / interrupt /
  // list），继续调它就是 host-unavailable → 手机端一条「请求失败 (HTTP 503)」。子会话的
  // 历史与普通会话走同一条 session.page，差别只在 durable 地址（宿主 validateAddress 认）。
  const host = await serve();
  try {
    const response = await fetch(host.url(
      '?sessionId=child-1&parentSessionId=parent-1&mode=continuable&beforeSeq=17&limit=25',
    ));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.equal(host.calls.length, 1, '不再调 subagents.history');
    assert.equal(host.calls[0].namespace, 'sessions');
    assert.deepEqual(host.calls[0].request, {
      rpcId: 'mobile',
      method: 'session.history',
      payload: {
        sessionId: 'child-1',
        parentSessionId: 'parent-1',
        mode: 'continuable',
        // 25 = 这一页要的 25 条；多要的 120 条只用来看「这一轮的工具结果带什么图」，
        // 不回给手机（倒着翻页时工具结果常落在比消息更早的位置）。
        maxMessages: 145,
        beforeSeq: 17,
      },
    });
  } finally {
    await host.close();
  }
});

test('工具落定补丁取自整个窗口，但增量只回状态不回正文', async () => {
  const events = [
    {
      event: {
        type: 'tool/result',
        seq: 5,
        data: {
          message: {
            source: { callId: 'call-old' },
            content: [{ type: 'text', text: 'older result' }],
          },
        },
      },
    },
    {
      event: {
        type: 'tool/result',
        seq: 6,
        data: {
          error: { code: 'interrupted' },
          message: {
            isError: true,
            source: { callId: 'call-stopped' },
            content: [{ type: 'text', text: 'interrupted result' }],
          },
        },
      },
    },
  ];
  const host = await serve({ sessionsHistory: async () => okValue({ events, hasMore: false }) });
  try {
    // afterSeq=10 让这两条事件都落在增量窗口之外，但工具卡仍需被补成最终态。
    const response = await fetch(host.url('?sessionId=root-1&afterSeq=10'));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.items, [], '窗口内没有消息行');
    // 增量拉取（带 afterSeq）只回状态：调用方手上已经有一份会话，整窗的工具输出再灌一遍
    // 就是「每 15 秒把最近两百条里的工具输出重发一次」。正文由入口整份拉取与展开时补。
    assert.deepEqual(body.toolResults, [
      { callId: 'call-old', state: 'ok' },
      { callId: 'call-stopped', state: 'stopped' },
    ]);
  } finally {
    await host.close();
  }
});

test('不完整或未知模式的子代理地址在本地拒绝', async () => {
  const host = await serve();
  try {
    const response = await fetch(host.url('?sessionId=child-1&parentSessionId=parent-1&mode=unknown'));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'bad-request');
    assert.equal(host.calls.length, 0);
  } finally {
    await host.close();
  }
});

for (const [code, expectedStatus] of [
  ['bad-request', 400],
  ['session-not-found', 404],
  ['subagent-not-found', 404],
  ['subagent-unauthorized', 403],
  ['host-unavailable', 503],
  ['host-call-failed', 502],
  ['gateway/arguments-invalid', 502],
]) {
  test(`history error ${code} maps to HTTP ${expectedStatus}`, async () => {
    const host = await serve({ sessionsHistory: async () => errValue({ code, message: 'upstream error' }) });
    try {
      const response = await fetch(host.url('?sessionId=root-1'));
      assert.equal(response.status, expectedStatus);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.equal(body.error.code, code);
      assert.equal(body.error.message, 'upstream error');
    } finally {
      await host.close();
    }
  });
}

test('抛出的宿主调用失败作为 502，而非客户端 400', async () => {
  const host = await serve({ sessionsHistory: async () => { throw new Error('gateway offline'); } });
  try {
    const response = await fetch(host.url('?sessionId=root-1'));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: { code: 'host-call-failed', message: 'gateway offline' },
    });
  } finally {
    await host.close();
  }
});

// ── 入口那一发按「内容」取（?thin=1）──────────────────────────────────────

test('入口那一发带 thin=1：窗口按轮取整，不是按条数硬切', async () => {
  // `maxMessages` 量的是消息条数，宿主一步一条 assistant 消息，长回合里最后 40 条可能
  // 一条用户消息都没有 —— 入口必须让宿主停在 turn/start 上。`minTurns` 只取 1：
  // 进对话要的是「尾部这一屏」，多要几轮会把窗口撑到一百多条（见 entry-window 文件头）。
  const host = await serve();
  try {
    const response = await fetch(host.url('?sessionId=root-1&limit=25&thin=1'));
    assert.equal(response.status, 200);
    assert.deepEqual(host.calls[0].request.payload, {
      sessionId: 'root-1',
      maxMessages: 2000,
      turnWindow: { minMessages: 25, minTurns: 1 },
    });
  } finally {
    await host.close();
  }
});

test('带游标的请求不按内容裁：thin=1 也只当普通分页', async () => {
  // 往上翻历史与增量补拉要的是完整过程，按轮取整会把整轮过程又拉回来、还会丢掉更早的那些。
  const host = await serve();
  try {
    await fetch(host.url('?sessionId=root-1&limit=25&thin=1&beforeSeq=17'));
    assert.deepEqual(host.calls[0].request.payload, {
      sessionId: 'root-1',
      // 25 条 + 120 条只用来看工具结果的那一段；「按内容裁」那一档没有被这一发打开。
      maxMessages: 145,
      beforeSeq: 17,
    });
  } finally {
    await host.close();
  }
});

test('thinEntryMessages：只留用户消息与助手文字，过程块数挂在开轮那条用户消息上', () => {
  const items = [
    { id: 'u1', role: 'user', text: '跑个命令', seq: 10, time: 1000 },
    {
      id: 'a1',
      role: 'assistant',
      text: '',
      seq: 11,
      blocks: [{ type: 'tool-call', name: 'bash', callId: 'c1' }, { type: 'reasoning', text: '想想' }],
    },
    { id: 'a2', role: 'assistant', text: '好了', seq: 12, blocks: [] },
  ];
  const kept = thinEntryMessages(items, { hasMore: false });
  assert.deepEqual(kept.map((item) => item.id), ['u1', 'a2'], '过程块不下发');
  assert.deepEqual(kept[0].turnProcess, { startSeq: 10, endSeq: 12, count: 2 });
});

test('thinEntryMessages：最老那半轮没有用户消息就整组丢掉', () => {
  // 窗口从一轮中间开始：那一组没有起点，交给「加载更早」，别拿半轮冒充这一轮的开头。
  const items = [
    { id: 'a0', role: 'assistant', text: '半轮的尾巴', seq: 1, blocks: [] },
    { id: 'u1', role: 'user', text: '新问题', seq: 2 },
    { id: 'a1', role: 'assistant', text: '答', seq: 3, blocks: [] },
  ];
  const kept = thinEntryMessages(items, { hasMore: true });
  assert.deepEqual(kept.map((item) => item.id), ['u1', 'a1']);
});

test('thinEntryMessages：出轮尾卡的工具块留下，而且照样计入过程数', () => {
  // 只数被摘掉的块会让 App 扣不掉保留下来的那几块，加载入口提前消失。
  const items = [
    { id: 'u1', role: 'user', text: '定个提醒', seq: 5 },
    {
      id: 'a1',
      role: 'assistant',
      text: '',
      seq: 6,
      blocks: [{ type: 'tool-call', name: 'schedule_create', callId: 'c9' }],
    },
  ];
  const kept = thinEntryMessages(items, { hasMore: false });
  assert.deepEqual(kept.map((item) => item.id), ['u1', 'a1']);
  assert.deepEqual(kept[1].blocks.map((block) => block.name), ['schedule_create']);
  assert.equal(kept[0].turnProcess.count, 1, '保留下来的过程块也要计数');
});

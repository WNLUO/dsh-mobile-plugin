'use strict';

/** Regression coverage for regular/subagent message history and HTTP error semantics. */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { handleMessages, buildMessagesSnapshot } = require('../lib/mobile/session-snapshot.js');
const { thinEntryMessages } = require('../lib/mobile/history-derive.js');
const artifacts = require('../lib/mobile/session-artifacts.js');
const { withPresentedFileStats, PRESENTED_STAT_BUDGET_MS } = require('../lib/mobile/presented-file-stats.js');

const ROUTE = '/api/mobile/v1/session/messages';
const okValue = (value) => ({ result: { ok: true, value } });
const errValue = (error) => ({ result: { ok: false, error } });

async function serve({ sessionsHistory, subagentsHistory, cwd, sessionId = 'root-1' } = {}) {
  const calls = [];
  const ctx = {
    apiProxy: {
      sessions: {
        history: async (request, signal) => {
          calls.push({ namespace: 'sessions', request, signal });
          return sessionsHistory ? sessionsHistory(request, signal) : okValue({ events: [], hasMore: false });
        },
        // 会话工作区：交付声明的放行面要靠它判「在不在工作区里」。
        list: async () => okValue({ items: [{ sessionId, cwd: cwd ?? null }] }),
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
    sessionId,
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

test('镜像正文快照必须能构建：这一路不带分页参数，宿主多给只留尾部一窗', async () => {
  // 镜像正文是手机上「不现读宿主就能看到历史」的唯一来源。它整条抛错时上层只会记一句
  // 「这条会话正文缺席」，手机上照样能点开会话（回源现读），所以功能测试不会红 ——
  // 但每推一次就白烧一次宿主历史读取，镜像里的正文永远是空的。
  const events = [1, 2, 3].map((seq) => ({
    type: 'user/message',
    seq,
    time: seq,
    data: { id: `m-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `第 ${seq} 条` }] },
  }));
  const ctx = { apiProxy: { sessions: { history: async () => okValue({ events, hasMore: false }) } } };
  const snap = await buildMessagesSnapshot(ctx, 'root-1', 2);
  assert.equal(snap.ok, true, '镜像正文快照不许整条失败');
  assert.equal(snap.items.length, 2, '宿主多给了就只留尾部那一窗');
  assert.equal(snap.lastSeq, 3, '水位取留下那一窗的最后一条');
});

test('镜像正文快照读不到历史时如实回 ok:false，不抛', async () => {
  const ctx = {
    apiProxy: { sessions: { history: async () => errValue({ code: 'session-not-found', message: 'gone' }) } },
  };
  const snap = await buildMessagesSnapshot(ctx, 'root-1', 2);
  assert.equal(snap.ok, false);
  assert.equal(snap.error.code, 'session-not-found');
});

// ── 交付声明的 size / mtime（presented-file-stats.js）──────────────────────
//
// 轮尾卡第二行要写「1.2 MB · 今天 14:32」：电脑侧在投影交付声明时顺手量一下，手机不额外请求。
// 这一组的边界比功能重要 —— 能 stat 的路径必须与本来就能下载的完全重合，而 `/session/messages`
// 是开屏与轮询的主路径，量一下不许把整页拖住。

/** 一条交付声明事件（形状与宿主 dsh-tool-present 追加的那条一致）。 */
function presented(turn, paths) {
  return {
    event: {
      type: 'deliverables/presented',
      seq: 100 + turn,
      time: 1_700_000_000_000,
      data: { turn, callId: `call-${turn}`, files: paths.map((item) => (typeof item === 'string' ? { path: item } : item)) },
    },
  };
}

/** 一条收尾答复：交付声明挂在它这一轮上。 */
function answer(seq, turn, text = '好了。') {
  return {
    event: {
      type: 'assistant/message',
      seq,
      time: 1_700_000_000_000 + seq,
      data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
    },
  };
}

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-presented-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

/** 取这一页里某条消息的 presentedFiles。 */
async function pageOf(host) {
  const response = await fetch(host.url(`?sessionId=${host.sessionId}&limit=50`));
  assert.equal(response.status, 200);
  return response.json();
}

test('投影出来的 presentedFiles 带 size / mtime，值与盘上的一致', async (t) => {
  // 每条用例一个会话 id：派生缓存按会话分桶，同一份 seq/type 指纹在不同用例里会串。
  const sid = 'presented-shape';
  const dir = await workspace(t);
  const body = '甲文件的内容\n';
  await fs.writeFile(path.join(dir, 'a.md'), body, 'utf8');
  const stat = await fs.stat(path.join(dir, 'a.md'));

  const host = await serve({ sessionId: sid,
    cwd: dir,
    sessionsHistory: async () => okValue({ events: [presented(1, ['a.md']), answer(101, 1)], hasMore: false }),
  });
  try {
    const body1 = await pageOf(host);
    const presentedFiles = body1.items.flatMap((item) => item.presentedFiles || []);
    assert.equal(presentedFiles.length, 1);
    assert.equal(presentedFiles[0].path, 'a.md');
    assert.equal(presentedFiles[0].size, Buffer.byteLength(body));
    assert.equal(presentedFiles[0].mtime, Math.round(stat.mtimeMs));
  } finally {
    await host.close();
  }
});

test('放行面没有放宽：声明里没有的路径量不到，与 /session/file 同一份判定', async (t) => {
  const dir = await workspace(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-presented-out-'));
  t.after(async () => { await fs.rm(outside, { recursive: true, force: true }); });
  const secret = path.join(outside, 'secret.txt');
  await fs.writeFile(secret, 'nope', 'utf8');

  // 手上这份投影声称交付过一条工作区外的绝对路径，而**历史里没有那条声明**
  // （旧缓存、或者声明已经滚出窗口）。作用域两条口子都不认，就不许量。
  const ctx = {
    apiProxy: {
      sessions: {
        list: async () => okValue({ items: [{ sessionId: 's1', cwd: dir }] }),
        history: async () => okValue({ events: [], hasMore: false }),
      },
    },
  };
  const messages = [{ id: 'a1', role: 'assistant', text: '好了。', presentedFiles: [{ path: secret }] }];
  const enriched = await withPresentedFileStats(ctx, 's1', messages);
  assert.deepEqual(enriched[0].presentedFiles, [{ path: secret }], '认不了就是认不了：不许带出任何元信息');
});

test('stat 抛错 / 文件不存在：那一行只留 path，整页照常 200', async (t) => {
  // 每条用例一个会话 id：派生缓存按会话分桶，同一份 seq/type 指纹在不同用例里会串。
  const sid = 'presented-missing';
  const dir = await workspace(t);
  await fs.writeFile(path.join(dir, 'ok.md'), 'x', 'utf8');
  const host = await serve({ sessionId: sid,
    cwd: dir,
    sessionsHistory: async () => okValue({
      events: [presented(1, ['ok.md', 'gone.md']), answer(101, 1)],
      hasMore: false,
    }),
  });
  try {
    const page = await pageOf(host);
    const files = page.items.flatMap((item) => item.presentedFiles || []);
    assert.equal(files.length, 2);
    assert.equal(files[0].size, 1, '量得到的那条照旧带');
    assert.equal(files[1].path, 'gone.md');
    assert.equal('size' in files[1], false);
    assert.equal('mtime' in files[1], false);
  } finally {
    await host.close();
  }

  // stat 整个抛错（网络盘掉线那种）：也只是一条都不补，页照旧是 200。
  const host2 = await serve({ sessionId: `${sid}-throw`,
    cwd: dir,
    sessionsHistory: async () => okValue({ events: [presented(1, ['ok.md']), answer(101, 1)], hasMore: false }),
  });
  artifacts.__setStatForTests(async () => { throw new Error('disk gone'); });
  try {
    const page = await pageOf(host2);
    assert.deepEqual(page.items.flatMap((item) => item.presentedFiles || []), [{ path: 'ok.md' }]);
  } finally {
    artifacts.__setStatForTests(null);
    await host2.close();
  }
});

test('整批 stat 超过总预算就放弃补齐，页面照常 200 返回', async (t) => {
  // 每条用例一个会话 id：派生缓存按会话分桶，同一份 seq/type 指纹在不同用例里会串。
  const sid = 'presented-timeout';
  const dir = await workspace(t);
  await fs.writeFile(path.join(dir, 'slow.md'), 'x', 'utf8');
  const host = await serve({ sessionId: sid,
    cwd: dir,
    sessionsHistory: async () => okValue({ events: [presented(1, ['slow.md']), answer(101, 1)], hasMore: false }),
  });
  // 永远不回来的 stat：网络盘卡死那种。这一页不许等它。
  artifacts.__setStatForTests(() => new Promise(() => {}));
  try {
    const startedAt = Date.now();
    const page = await pageOf(host);
    const elapsed = Date.now() - startedAt;
    assert.deepEqual(page.items.flatMap((item) => item.presentedFiles || []), [{ path: 'slow.md' }]);
    assert.ok(elapsed < PRESENTED_STAT_BUDGET_MS + 1500, `整页不该被 stat 拖住，实际 ${elapsed}ms`);
  } finally {
    artifacts.__setStatForTests(null);
    await host.close();
  }
});

test('stat 并发不超过 8', async (t) => {
  // 每条用例一个会话 id：派生缓存按会话分桶，同一份 seq/type 指纹在不同用例里会串。
  const sid = 'presented-concurrency';
  const dir = await workspace(t);
  const paths = [];
  for (let index = 0; index < 40; index += 1) {
    await fs.writeFile(path.join(dir, `f${index}.md`), 'x', 'utf8');
    paths.push(`f${index}.md`);
  }
  const real = fs.stat;
  let live = 0;
  let peak = 0;
  artifacts.__setStatForTests(async (target) => {
    live += 1;
    if (live > peak) peak = live;
    try {
      return await new Promise((resolve, reject) => setImmediate(() => real(target).then(resolve, reject)));
    } finally {
      live -= 1;
    }
  });
  const host = await serve({ sessionId: sid,
    cwd: dir,
    sessionsHistory: async () => okValue({ events: [presented(1, paths), answer(101, 1)], hasMore: false }),
  });
  try {
    const page = await pageOf(host);
    assert.equal(page.items.flatMap((item) => item.presentedFiles || []).length, 40);
    assert.ok(peak <= artifacts.ARTIFACT_STAT_CONCURRENCY, `并发峰值 ${peak} 超过了 ${artifacts.ARTIFACT_STAT_CONCURRENCY}`);
    assert.equal(peak, artifacts.ARTIFACT_STAT_CONCURRENCY, `该并发的地方没并发起来（峰值只有 ${peak}）`);
  } finally {
    artifacts.__setStatForTests(null);
    await host.close();
  }
});

test('同一份投影第二次调用不再 stat（派生缓存 + 补格缓存都命中）', async (t) => {
  // 每条用例一个会话 id：派生缓存按会话分桶，同一份 seq/type 指纹在不同用例里会串。
  const sid = 'presented-cached';
  const dir = await workspace(t);
  await fs.writeFile(path.join(dir, 'a.md'), 'x', 'utf8');
  const events = [presented(1, ['a.md']), answer(101, 1)];
  const host = await serve({ sessionId: sid, cwd: dir, sessionsHistory: async () => okValue({ events, hasMore: false }) });
  let statCalls = 0;
  const real = fs.stat;
  artifacts.__setStatForTests(async (target) => { statCalls += 1; return real(target); });
  try {
    const first = await pageOf(host);
    const afterFirst = statCalls;
    assert.equal(afterFirst, 1, '第一次该量一次');
    const second = await pageOf(host);
    assert.equal(statCalls, afterFirst, '同指纹的第二次不许再 stat');
    assert.deepEqual(
      second.items.flatMap((item) => item.presentedFiles || []),
      first.items.flatMap((item) => item.presentedFiles || []),
      '两次拿到的补齐结果必须一致',
    );
  } finally {
    artifacts.__setStatForTests(null);
    await host.close();
  }
});

test('补格是纯函数形态：原数组不被就地改，没声明时原样返回', async () => {
  const ctx = { apiProxy: { sessions: { list: async () => okValue({ items: [{ sessionId: 's1', cwd: null }] }) } } };
  const messages = [{ id: 'a1', role: 'assistant', text: '没有交付声明' }];
  const out = await withPresentedFileStats(ctx, 's1', messages);
  assert.equal(out, messages, '一条声明都没有时不许造新数组');
});

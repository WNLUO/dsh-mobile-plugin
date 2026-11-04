'use strict';

/**
 * 后台提醒的轻量视图（`/api/mobile/v1/monitor`）。
 *
 * 场景：安卓那条前台服务在 App 之外定时问「这一轮跑完了没有」。它此前问的是完整会话
 * 清单，而那份为画侧栏还要给最近的会话补「最后一条消息」预览 —— 预览是读 history，
 * 后台每 8 秒白读 20 次日志。这条视图只回状态位，且带 `?rev=`：稳态几十字节。
 *
 * 钉住的四件事：
 *   1. 回的形状里**没有**侧栏预览与排序用的字段（有就说明又走回了完整清单那条路）；
 *      只有「可能提醒」的那几条带一句可选的 `lastMessage`；
 *   2. 状态位变 → revision 变；没变 → `unchanged` 且不带 items；
 *   3. 稳态下**一次 history 都不读**；只有「刚跑完、结局还没定」的那条读一次；
 *   4. 归档的会话不进监控视图（否则会被为一条侧栏里根本没有的会话叫醒）。
 */

const { Readable } = require('node:stream');
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleMonitor } = require('../lib/mobile/monitor.js');
const { resetArchivedSessionIdsForTest } = require('../lib/mobile/session-flags.js');
const { recordLastTurn, recordSessionRead } = require('../lib/mobile/session-last-turn.js');
const { completionStateOf } = require('../lib/mobile/session-cache.js');
const { listSignal } = require('../lib/shared/list-signal.js');
const { sessionSignal } = require('../lib/shared/session-signal.js');
const questions = require('../lib/mobile/questions.js');

function makeReq(url) {
  const req = Readable.from([Buffer.from('{}')]);
  req.url = url;
  req.headers = {};
  return req;
}

function makeRes() {
  const res = { status: null, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = JSON.parse(payload); };
  return res;
}

/** 假宿主：清单与归档集合都是活对象，改它们等于宿主那边变了。 */
function makeCtx(items) {
  const state = {
    items,
    archivedSessionIds: [],
    historyCalls: 0,
    // 预览正文可改：用于钉「正文变了 revision 也要变」。
    historyRole: 'assistant',
    historyText: '这一轮跑完了，结果在这里。',
    historyFails: false,
  };
  const ctx = {
    state,
    apiProxy: {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items: state.items } } }),
        history: async () => {
          state.historyCalls += 1;
          if (state.historyFails) {
            return { result: { ok: false, error: { code: 'history-failed', message: '读不到历史' } } };
          }
          return {
            result: {
              ok: true,
              value: {
                events: [
                  { type: 'turn/start', seq: 1, time: 5_000, data: { turn: 1 } },
                  {
                    type: 'assistant/message',
                    seq: 2,
                    time: 5_100,
                    data: {
                      turn: 1,
                      interrupted: false,
                      message: {
                        id: 'm1',
                        role: state.historyRole,
                        content: [{ type: 'text', text: state.historyText }],
                      },
                    },
                  },
                  { type: 'turn/end', seq: 3, time: 5_200, data: { turn: 1, reason: { kind: 'completed' } } },
                ],
              },
            },
          };
        },
      },
      workspace: {
        list: async () => ({ result: { ok: true, value: { items: [], archivedSessionIds: state.archivedSessionIds } } }),
      },
    },
  };
  return ctx;
}

function session(id, over = {}) {
  return {
    sessionId: id,
    running: false,
    blank: false,
    updatedAt: 1_000,
    projections: { values: { title: id } },
    ...over,
  };
}

async function get(ctx, url) {
  const res = makeRes();
  await handleMonitor(ctx, makeReq(url), res);
  assert.equal(res.status, 200, `${url} 应返回 200，实际 ${res.status}：${JSON.stringify(res.body)}`);
  return res.body;
}

const URL_ = '/api/mobile/v1/monitor';

test('只回状态位：没有预览、没有 updatedAt、没有 cwd', async () => {
  const ctx = makeCtx([session('s1')]);
  const body = await get(ctx, URL_);
  assert.equal(body.ok, true);
  assert.equal(body.items.length, 1);
  const item = body.items[0];
  // `pendingCard` 恒在：原生靠这一格判「这台宿主认不认识待处理卡片」（见 monitor.js）。
  assert.deepEqual(Object.keys(item).sort(), ['completed', 'pendingCard', 'running', 'sessionId', 'title']);
  assert.equal(item.pendingCard, null, '没有挂起时显式 null，不是「不知道」');
  assert.equal(item.running, false);
  assert.equal(item.completed, false);
  // 完整清单那条路会为它读一次 history 补预览；监控视图常态下一次都不读。
  assert.equal(ctx.state.historyCalls, 0);
});

test('状态位没变 → unchanged 且不带 items', async () => {
  const ctx = makeCtx([session('s1'), session('s2', { running: true })]);
  const first = await get(ctx, URL_);
  assert.equal(typeof first.revision, 'string');
  assert.ok(first.revision.length > 0);
  const second = await get(ctx, `${URL_}?rev=${encodeURIComponent(first.revision)}`);
  assert.equal(second.unchanged, true);
  assert.equal(second.items, undefined);
  assert.equal(second.revision, first.revision);
});

test('状态位变了 → revision 变、照常回 items', async () => {
  const ctx = makeCtx([session('s1')]);
  const first = await get(ctx, URL_);
  ctx.state.items = [session('s1', { running: true })];
  const second = await get(ctx, `${URL_}?rev=${encodeURIComponent(first.revision)}`);
  assert.notEqual(second.unchanged, true);
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].running, true);
  assert.notEqual(second.revision, first.revision);
});

test('刚跑完的那一条读一次 history 折出完成态，之后不再读', async () => {
  const ctx = makeCtx([session('s1', { running: true, updatedAt: 2_000 })]);
  const running = await get(ctx, URL_);
  assert.equal(running.items[0].running, true);
  assert.equal(ctx.state.historyCalls, 0, '有人正在跑的时候不该去读历史');

  // 宿主说它不在跑了，而完成态还没定 → 这一轮去读一次。
  ctx.state.items = [session('s1', { running: false, updatedAt: 3_000 })];
  const done = await get(ctx, `${URL_}?rev=${encodeURIComponent(running.revision)}`);
  assert.equal(ctx.state.historyCalls, 1);
  assert.equal(done.items[0].completed, true);
  assert.notEqual(done.revision, running.revision);

  // 结局已定 → 回到零读取，且指纹不再变。
  const settled = await get(ctx, `${URL_}?rev=${encodeURIComponent(done.revision)}`);
  assert.equal(ctx.state.historyCalls, 1);
  assert.equal(settled.unchanged, true);
});

test('完成看上一轮事实：预览缓存命中（events 为空）也能报完成', async () => {
  // 真机根因（2026-10-25）：`state.completed` 只在「这次真读回 history」时才折得出来，
  // 而宿主的镜像推送每 500ms 就把同一份预览按新指纹写进缓存 —— 监控这一侧永远命中缓存、
  // 永远折不出来，后台一条完成提醒都不响。现在完成/失败改由上一轮事实（turn/end 当场
  // 记下）来算，这条路不经过预览缓存。
  const ctx = makeCtx([session('s1', { running: true, updatedAt: 2_000 })]);
  const running = await get(ctx, URL_);
  assert.equal(running.items[0].completed, false);

  ctx.state.items = [session('s1', { running: false, updatedAt: 3_000 })];
  recordLastTurn(ctx, 's1', { turn: 1, endedAt: 5_000, status: 'completed' });
  const done = await get(ctx, `${URL_}?rev=${encodeURIComponent(running.revision)}`);
  assert.equal(done.items[0].completed, true);
});

test('把上一轮事实透给原生（按轮次判完成用）', async () => {
  const ctx = makeCtx([session('s1', { running: false, updatedAt: 2_000 })]);
  recordLastTurn(ctx, 's1', { turn: 3, endedAt: 5_000, status: 'completed' });
  const body = await get(ctx, URL_);
  assert.equal(body.items[0].lastTurn.turn, 3);
  assert.equal(body.items[0].lastTurn.status, 'completed');
});

test('把「这一轮读没读过」透给原生：桌面点开之后手机上的提醒要能自己消失', async () => {
  // 用户口径：在电脑上把那条对话点开看过了，手机上那条推送也该跟着消失。
  // 桌面点开只推进**与设备无关**的已读水位（`recordSessionRead`），不动这台设备的
  // `clearedAt` —— 所以后台提醒要撤掉「别人已经看过的这一轮」时，只能看这一格。
  const ctx = makeCtx([session('s1', { updatedAt: 2_000 })]);
  recordLastTurn(ctx, 's1', { turn: 3, endedAt: 5_000, status: 'completed' });
  const before = await get(ctx, URL_);
  assert.equal(before.items[0].lastTurn.readAt, undefined, '没人读过时这一格不出现');
  recordSessionRead(ctx, 's1', 6_000);
  // 水位进指纹：不进去的话手机那边条件刷新永远拿到 unchanged，这个变化永远送不到。
  const after = await get(ctx, `${URL_}?rev=${encodeURIComponent(before.revision)}`);
  assert.notEqual(after.unchanged, true);
  assert.equal(after.items[0].lastTurn.readAt, 6_000);
});

test('可能提醒的那几条带 lastMessage，且形状只有 role/text', async () => {
  const ctx = makeCtx([
    session('done', { updatedAt: 2_000 }),
    session('failed', { updatedAt: 2_100 }),
    session('waiting', { updatedAt: 2_200, pendingInteraction: 'question' }),
  ]);
  recordLastTurn(ctx, 'done', { turn: 1, endedAt: 5_000, status: 'completed' });
  recordLastTurn(ctx, 'failed', { turn: 1, endedAt: 5_000, status: 'failed', code: 'turn-failed', message: '崩了' });
  const body = await get(ctx, URL_);
  const byId = new Map(body.items.map((item) => [item.sessionId, item]));
  assert.equal(byId.get('done').completed, true);
  assert.equal(byId.get('failed').lastTurnError.code, 'turn-failed');
  assert.equal(byId.get('waiting').pendingInteraction, 'question');
  for (const id of ['done', 'failed', 'waiting']) {
    assert.deepEqual(byId.get(id).lastMessage, {
      role: 'assistant',
      text: '这一轮跑完了，结果在这里。',
    });
    assert.equal(byId.get(id).lastMessage.at, undefined, '与 /sessions 的 lastMessage 不同：不带 at');
  }
});

test('普通在跑的条目不带 lastMessage，也不读 history', async () => {
  const ctx = makeCtx([session('s1', { running: true, updatedAt: 2_000 })]);
  const body = await get(ctx, URL_);
  assert.equal(body.items[0].running, true);
  assert.equal('lastMessage' in body.items[0], false);
  assert.equal(ctx.state.historyCalls, 0);
});

test('lastMessage 进 revision：状态位没变但正文变了，rev 也要变', async () => {
  const ctx = makeCtx([session('s1', { updatedAt: 2_000 })]);
  recordLastTurn(ctx, 's1', { turn: 1, endedAt: 5_000, status: 'completed' });
  const first = await get(ctx, URL_);
  assert.equal(first.items[0].lastMessage.text, '这一轮跑完了，结果在这里。');

  ctx.state.historyText = '换了一句新结果。';
  ctx.state.items = [session('s1', { updatedAt: 3_000 })];
  const second = await get(ctx, `${URL_}?rev=${encodeURIComponent(first.revision)}`);
  assert.notEqual(second.unchanged, true);
  assert.equal(second.items[0].lastMessage.text, '换了一句新结果。');
  assert.notEqual(second.revision, first.revision, '正文变了却没进指纹，手机不会被唤醒');
});

test('拿不到预览时整个 lastMessage 字段不出现', async () => {
  const ctx = makeCtx([session('s1', { updatedAt: 2_000 })]);
  recordLastTurn(ctx, 's1', { turn: 1, endedAt: 5_000, status: 'completed' });
  ctx.state.historyFails = true;
  const body = await get(ctx, URL_);
  assert.equal(body.items[0].completed, true);
  assert.equal('lastMessage' in body.items[0], false);
  assert.equal(ctx.state.historyCalls, 1);
});

test('最后一句是用户说的就不带 lastMessage', async () => {
  const ctx = makeCtx([session('s1', { updatedAt: 2_000 })]);
  recordLastTurn(ctx, 's1', { turn: 1, endedAt: 5_000, status: 'completed' });
  ctx.state.historyRole = 'user';
  const body = await get(ctx, URL_);
  assert.equal(body.items[0].completed, true);
  assert.equal('lastMessage' in body.items[0], false);
});

test('读过之后结束的那一轮不再算提醒（已读水位仍然生效）', async () => {
  const ctx = makeCtx([session('s1', { running: false, updatedAt: 2_000 })]);
  await get(ctx, URL_);
  // 这台设备在 6000 读过，而这一轮 5000 就结束了 —— 不该再亮。
  completionStateOf(ctx, 'legacy').get('s1').clearedAt = 6_000;
  recordLastTurn(ctx, 's1', { turn: 1, endedAt: 5_000, status: 'completed' });
  const body = await get(ctx, URL_);
  assert.equal(body.items[0].completed, false);
});

test('子代理会话不进监控视图（后台不该为内部执行单元弹提醒）', async () => {
  const ctx = makeCtx([
    session('s1'),
    session('sub', { origin: 'subagent', running: true, updatedAt: 2_000 }),
  ]);
  const body = await get(ctx, URL_);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].sessionId, 's1');
});

test('归档会话不进监控视图', async () => {
  const ctx = makeCtx([session('s1'), session('s2', { running: true })]);
  ctx.state.archivedSessionIds = ['s2'];
  const body = await get(ctx, URL_);
  assert.deepEqual(body.items.map((i) => i.sessionId), ['s1']);
});

/**
 * 读不到归档集合时**不能**当成「什么都没归档」。
 *
 * 这条视图的判据是「会话还在不在清单里」。按空集合画，已归档的会话会重新进清单 —— 原生
 * 刚因为它消失而清了基线，于是它成了「第一次见到」，只要那一轮结束在十分钟内就再响一遍。
 * 所以沿用上一次真正读到的归档集合。别改成回 5xx：那条 RPC 在 0.2.0 宿主要现开
 * `workspace.follow` 取首帧，失败率不低，每失败一拍就让后台提醒整条哑掉更糟。
 */
test('读不到归档集合时沿用上一次读到的那份（别让已归档会话重新进清单）', async () => {
  resetArchivedSessionIdsForTest();
  const ctx = makeCtx([session('s1'), session('s2')]);
  ctx.state.archivedSessionIds = ['s2'];
  const first = await get(ctx, URL_);
  assert.deepEqual(first.items.map((i) => i.sessionId), ['s1']);

  // 宿主那条 RPC 抖一下：集合读不到了。
  ctx.apiProxy.workspace.list = async () => { throw new Error('workspace.list exploded'); };
  const second = await get(ctx, URL_);
  assert.deepEqual(second.items.map((i) => i.sessionId), ['s1'],
    '读不到归档集合时把已归档的会话放回清单 = 后台再为它响一声');

  // 读回来之后跟着新的账走：取消归档的那条要重新出现。
  ctx.apiProxy.workspace.list = async () => ({ result: { ok: true, value: { items: [], archivedSessionIds: [] } } });
  const third = await get(ctx, URL_);
  assert.deepEqual(third.items.map((i) => i.sessionId).sort(), ['s1', 's2']);
  resetArchivedSessionIdsForTest();
});

test('一本归档账都没有（进程刚起来就问不到）时退回空集合，不凭空造提醒', async () => {
  resetArchivedSessionIdsForTest();
  const ctx = makeCtx([session('s1')]);
  ctx.apiProxy.workspace.list = async () => { throw new Error('workspace.list exploded'); };
  const body = await get(ctx, URL_);
  // 空集合只是「不知道」；首拍原生还没有基线，见到什么也只建基线、不提醒。
  assert.deepEqual(body.items.map((i) => i.sessionId), ['s1']);
  resetArchivedSessionIdsForTest();
});

test('归档集合以 Set 形态给过来也要认（否则那类宿主上归档过滤恒失效）', async () => {
  resetArchivedSessionIdsForTest();
  const ctx = makeCtx([session('s1'), session('s2')]);
  ctx.apiProxy.workspace.list = async () => ({
    result: { ok: true, value: { items: [], archivedSessionIds: new Set(['s2']), pinnedSessionIds: [] } },
  });
  const body = await get(ctx, URL_);
  assert.deepEqual(body.items.map((i) => i.sessionId), ['s1']);
  resetArchivedSessionIdsForTest();
});

test('清单顺序换过不算变化（指纹按 id 排过）', async () => {
  const ctx = makeCtx([session('b'), session('a')]);
  const first = await get(ctx, URL_);
  ctx.state.items = [session('a'), session('b')];
  const second = await get(ctx, `${URL_}?rev=${encodeURIComponent(first.revision)}`);
  assert.equal(second.unchanged, true, '宿主按 updatedAt 重排会让指纹每轮都变 —— 排序是必须的');
});

test('宿主列表形状不对 → 5xx（别拿空清单清掉原生基线）', async () => {
  const ctx = makeCtx([]);
  ctx.apiProxy.sessions.list = async () => ({ result: { ok: true, value: {} } });
  const res = makeRes();
  await handleMonitor(ctx, makeReq(URL_), res);
  assert.equal(res.status, 500);
  assert.equal(res.body.ok, false);
});

/*
 * 挂起等待（`?wait=`）：安卓后台服务靠它实时拿到「这一轮跑完了」。
 *
 * 钉住三件事：状态位没变时这一发**不回**（否则就成了换地方的轮询）；有变化时**立刻**回，
 * 不用等满；没有 rev 时一律立刻回（那是「给我完整状态」，不是「等变化」）。
 */

test('带 wait 且状态位没变 → 挂到有变化才回，且立刻回', async () => {
  const ctx = makeCtx([session('s1')]);
  const first = await get(ctx, URL_);
  const url = `${URL_}?rev=${encodeURIComponent(first.revision)}&wait=10`;

  let resolved = false;
  const pending = get(ctx, url).then((body) => { resolved = true; return body; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resolved, false, '状态位没变，这一发不能被立刻回掉');

  ctx.state.items = [session('s1', { running: true })];
  listSignal.bump(`test-${Date.now()}`);
  const body = await pending;
  assert.equal(body.unchanged, undefined);
  assert.equal(body.items[0].running, true);
});

test('会话水位涨了也能唤醒（正文变化不一定改清单）', async () => {
  const ctx = makeCtx([session('s1')]);
  const first = await get(ctx, URL_);
  const url = `${URL_}?rev=${encodeURIComponent(first.revision)}&wait=10`;

  let resolved = false;
  const pending = get(ctx, url).then((body) => { resolved = true; return body; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resolved, false);

  ctx.state.historyCalls = 0;
  sessionSignal.bump('s1', 7);
  const body = await pending;
  assert.equal(body.unchanged, true, '醒来先如实回一次，手机自己再挂');
});

test('挂满就回，不留一个转不停的请求', async () => {
  const ctx = makeCtx([session('s1')]);
  const first = await get(ctx, URL_);
  const started = Date.now();
  const body = await get(ctx, `${URL_}?rev=${encodeURIComponent(first.revision)}&wait=0.05`);
  assert.equal(body.unchanged, true);
  assert.ok(Date.now() - started >= 40, '没到时间就回了说明根本没挂');
});

test('没有 rev 时不挂：那是「给我完整状态」', async () => {
  const ctx = makeCtx([session('s1')]);
  const started = Date.now();
  const body = await get(ctx, `${URL_}?wait=5`);
  assert.equal(body.items.length, 1);
  assert.ok(Date.now() - started < 1_000);
});

test('变化已经发生过的这一发不挂（rev 对不上就直接回新状态）', async () => {
  const ctx = makeCtx([session('s1')]);
  const first = await get(ctx, URL_);
  ctx.state.items = [session('s1', { running: true })];
  const started = Date.now();
  const body = await get(ctx, `${URL_}?rev=${encodeURIComponent(first.revision)}&wait=5`);
  assert.equal(body.unchanged, undefined);
  assert.equal(body.items[0].running, true);
  assert.ok(Date.now() - started < 1_000);
});

/**
 * 回前台那张卡：`pendingCard` 必须跟着待处理的那条一起回。
 *
 * 真机现场：从后台滑回前台，侧栏已经显示「需要人工介入」，对话页里那张卡却没出来，
 * 得切一次会话才出现 —— 因为卡片在手机上只有一条来路：实时流重新接上时插件的补发。
 * 那次重连一旦落空（退避中、宿主把流收了、网络还没被采纳），卡就缺到下次重进对话。
 * 现在后台轮询顺手把卡本身带回去，回前台问原生取，纯本地、不必等网络。
 */
function installPendingQuestion(sessionId) {
  questions.resetForTest();
  const listeners = [];
  const ctx = {
    apiProxy: { respond: async () => ({ accepted: false }) },
    on(name, listener) { listeners.push({ name, listener }); return () => {}; },
  };
  questions.installQuestionBridge(ctx);
  const hook = listeners.find((entry) => entry.name === 'user-questions/request');
  // 阻塞式提问：钩子会一直等答案，这里刻意不 await 它。
  void hook.listener({
    questions: [{ id: 'q1', question: '用哪个端口？', options: [{ label: '8787' }] }],
    agent: { session: { id: sessionId } },
  }, () => new Promise(() => {}));
  return () => questions.resetForTest();
}

test('待处理的那条把卡片本身也带上（回前台不必等流重连）', async () => {
  const ctx = makeCtx([session('waiting', { updatedAt: 2_200 }), session('idle', { updatedAt: 2_100 })]);
  const cleanup = installPendingQuestion('waiting');
  try {
    const body = await get(ctx, URL_);
    const byId = new Map(body.items.map((item) => [item.sessionId, item]));
    assert.equal(byId.get('waiting').pendingInteraction, 'question');
    const card = byId.get('waiting').pendingCard;
    assert.equal(card.type, 'question/requested');
    assert.match(card.rpcId, /^m-/, '没有帧级 rpcId 的卡点了必然是 409');
    assert.equal(card.questions[0].id, 'q1');
    assert.equal(byId.get('idle').pendingCard, null, '没挂起的条目写 null：那是「看过了、没有」');

    // 卡进不进指纹：同一份内容必须仍算「没变」，否则原生每拍都被唤醒重推。
    const again = await get(ctx, `${URL_}?rev=${encodeURIComponent(body.revision)}`);
    assert.equal(again.unchanged, true);
  } finally {
    cleanup();
  }
});

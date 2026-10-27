'use strict';

/**
 * session/queue 帧形状守卫。
 *
 * 这条 bug 的杀伤力全在「不报错」上：宿主投影 `inbox` 是**按键分组的对象**
 * `{ 'next-turn': Message[], 'next-step': Message[] }`（桌面 bundle 里
 * `@deepseek-ai/dsh-agent-loop/inbox` 的 `key: 'inbox'` + `wire.view: (state) => state`，
 * 桌面 QueueDock 读的正是 `inbox['next-turn']`），而移动端帧的约定是平铺数组
 * `[{ id, placement, message }]`（`app/src/types/chatStream.ts` 的 QueueItem）。
 * 兼容桥原样转发那个对象时，App 的 `Array.isArray(items)` 判定失败、整帧被静默丢弃 ——
 * 排队条一次都不显示，也不会有任何错误日志。
 *
 * 所以这里的假网关是照着宿主 `session/control` 的两种帧（baseline / 单键 projection）
 * 喂进 `muxFrames`，钉住合成的队列帧形状。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { muxFrames } = require('../lib/mobile/host-bridge/event-synthesis.js');

/** 宿主 inbox 里的一行（Message：id + source + content）。 */
function inboxMessage(id, text) {
  return { id, source: { kind: 'user', rpcId: `rpc-${id}` }, content: [{ type: 'text', text }] };
}

/** 假网关：session/control 返回给定帧，其余流（job/list、session/follow）空跑。 */
function makeCtx(controlFrames, seen = [], warns = []) {
  const gateway = {
    async invoke() {
      throw new Error('本测试不涉及 invoke');
    },
    async stream(request) {
      seen.push(`${request.namespace}/${request.method}`);
      if (request.namespace === 'session' && request.method === 'control') return Readable.from(controlFrames);
      return Readable.from([]);
    },
  };
  return {
    ctx: {
      get: (name) => (name === 'typertGateway' ? gateway : undefined),
      logger: { warn: (message) => warns.push(String(message)), error() {} },
    },
    seen,
    warns,
  };
}

async function collect(iterable) {
  const frames = [];
  for await (const frame of iterable) frames.push(frame);
  return frames;
}

function queueFrames(frames) {
  return frames.filter((frame) => frame.payload.type === 'session/queue');
}

function baselineFor(sessionId, values) {
  return { type: 'baseline', value: { projections: { [sessionId]: { asOfSeq: 7, values } } } };
}

test('键控 inbox 摊平成 queued / steering 行', async () => {
  const seen = [];
  const { ctx } = makeCtx([
    baselineFor('s-1', {
      inbox: { 'next-turn': [inboxMessage('msg-q1', '排队的消息')], 'next-step': [inboxMessage('msg-s1', '插话的消息')] },
      model: { lastUsed: 'x' },
    }),
  ], seen);

  const frames = await collect(muxFrames(ctx, { payload: { sessionId: 's-1' } }));
  const queue = queueFrames(frames);

  assert.equal(queue.length, 1, '基线里带 inbox 就该出一条队列帧');
  assert.deepEqual(queue[0].payload, {
    type: 'session/queue',
    sessionId: 's-1',
    items: [
      { id: 'msg-q1', placement: 'queued', message: { id: 'msg-q1', content: [{ type: 'text', text: '排队的消息' }] } },
      // next-step 是「宿主已经收下、等本步末尾插进去」的插话：它不进排队条，但手机要靠它
      // 把气泡从「发送中」翻面（App 侧 QueueDock / 正文列表都只认 queued）。
      { id: 'msg-s1', placement: 'steering', message: { id: 'msg-s1', content: [{ type: 'text', text: '插话的消息' }] } },
    ],
  });

  // 投影整帧仍按宿主形状原样转发（别的字段由 App 侧另一条路读），只有队列帧摊平。
  const projection = frames.find((frame) => frame.payload.type === 'session/projection');
  assert.deepEqual(projection.payload.values.inbox, {
    'next-turn': [inboxMessage('msg-q1', '排队的消息')],
    'next-step': [inboxMessage('msg-s1', '插话的消息')],
  });

  // 订阅面没变：带 sessionId 仍是 control + job/list + follow 三条流。
  assert.deepEqual([...seen].sort(), ['job/list', 'session/control', 'session/follow']);
});

test('单键更新帧（inbox 变化）同样摊平，空队列发空数组', async () => {
  const { ctx } = makeCtx([
    { type: 'projection', sessionId: 's-1', key: 'inbox', value: { 'next-turn': [inboxMessage('m2', '第二条')], 'next-step': [] }, seq: 9 },
    { type: 'projection', sessionId: 's-1', key: 'inbox', value: { 'next-turn': [], 'next-step': [] }, seq: 10 },
  ]);

  const queue = queueFrames(await collect(muxFrames(ctx, { payload: { sessionId: 's-1' } })));

  assert.equal(queue.length, 2);
  assert.deepEqual(queue[0].payload.items, [
    { id: 'm2', placement: 'queued', message: { id: 'm2', content: [{ type: 'text', text: '第二条' }] } },
  ]);
  assert.deepEqual(queue[1].payload.items, [], '队列被认领后必须推空数组，否则排队条留在原地');
});

test('畸形 inbox 一律退化成空 items，不报错也不伪造行', async () => {
  const malformed = [
    { 'next-turn': [{ content: [{ type: 'text', text: '没有 id' }] }], 'next-step': [] },
    { 'next-turn': [null, 3, 'x'], 'next-step': [] },
    { 'next-turn': 'nope', 'next-step': [] },
    // 插话那一组同样只认数组 + 带 id 的对象：形状坏了就整组不出行，不猜。
    { 'next-turn': [], 'next-step': 'nope' },
    { 'next-turn': [], 'next-step': [null, { content: [{ type: 'text', text: '没有 id' }] }] },
    {},
    [],
    null,
  ];

  for (const inbox of malformed) {
    const { ctx } = makeCtx([baselineFor('s-1', { inbox })]);
    const frames = await collect(muxFrames(ctx, { payload: { sessionId: 's-1' } }));
    const queue = queueFrames(frames);
    assert.equal(queue.length, 1, `inbox=${JSON.stringify(inbox)} 仍应有队列帧`);
    assert.deepEqual(queue[0].payload.items, [], `inbox=${JSON.stringify(inbox)} 应退化成空数组`);
  }
});

// 宿主会把**系统注入**也当 user 行塞进同一份 inbox（后台任务结束、时间/环境上下文、
// 子代理消息、模型切换提示……），来源在 `source.kind`，不是 `user`。队列帧的条目形状没有
// source 这一格，摊平出去以后 App 会把它们画成「我发出去的气泡」（next-step 那条在 App 侧
// 就是用户气泡）。这些注入在正文里本来就被来源过滤丢掉，这里必须同样丢掉。
// 缺 source 的老宿主按用户消息算，与 history-derive 的口径一致。
test('系统注入不进队列帧（它们不是用户说的话）', async () => {
  const injected = (id, kind, text) => ({ id, source: { kind, form: 'notice' }, content: [{ type: 'text', text }] });
  const { ctx } = makeCtx([
    baselineFor('s-1', {
      inbox: {
        'next-turn': [inboxMessage('u1', '用户排队的'), injected('i1', 'tool-jobs', 'background job finished')],
        'next-step': [
          inboxMessage('u2', '用户插话的'),
          injected('i2', 'devmap-hint', '<system-reminder>'),
          injected('i3', 'time-context', 'Time sampled while preparing turn 1'),
          injected('i4', 'subagent-settled', 'Background subagent finished'),
          injected('i5', 'model-selection', '[model changed: a → b]'),
          // 老宿主可能连 source 都没有：按用户消息处理，别顺手把真消息也丢了。
          { id: 'legacy', content: [{ type: 'text', text: '没有 source 的旧行' }] },
        ],
      },
    }),
  ]);
  const frames = await collect(muxFrames(ctx, { payload: { sessionId: 's-1' } }));
  assert.deepEqual(queueFrames(frames)[0].payload.items, [
    { id: 'u1', placement: 'queued', message: { id: 'u1', content: [{ type: 'text', text: '用户排队的' }] } },
    { id: 'u2', placement: 'steering', message: { id: 'u2', content: [{ type: 'text', text: '用户插话的' }] } },
    { id: 'legacy', placement: 'steering', message: { id: 'legacy', content: [{ type: 'text', text: '没有 source 的旧行' }] } },
  ]);
});

test('投影里没有 inbox 就不发队列帧', async () => {
  const { ctx } = makeCtx([baselineFor('s-1', { model: { lastUsed: 'x' } })]);
  const frames = await collect(muxFrames(ctx, { payload: { sessionId: 's-1' } }));
  assert.deepEqual(queueFrames(frames), []);
});

// 丢行本身是对的（App 的 session.updateQueue 按 id 定位，凭空造 id 会让「已落定」和
// 「待发」两条记录对不上），但**静默**丢不行：手机上少一条待发消息，宿主侧一行日志
// 都没有，只能靠人对着桌面端数气泡。这里钉住「丢几条就说几条」。
test('丢掉的待发行必须留下带计数的日志', async () => {
  const { ctx, warns } = makeCtx([
    baselineFor('s-1', {
      inbox: {
        'next-turn': [inboxMessage('m1', '有 id'), { content: [{ type: 'text', text: '没有 id' }] }, null],
        // 插话那一组也计入同一个计数：两处共用一个摊平实现，别只在一处数。
        'next-step': [{ content: [{ type: 'text', text: '插话没有 id' }] }],
      },
    }),
  ]);
  const frames = await collect(muxFrames(ctx, { payload: { sessionId: 's-1' } }));
  assert.deepEqual(queueFrames(frames)[0].payload.items.map((item) => item.id), ['m1']);
  assert.equal(warns.length, 1, '丢行必须告警一次');
  assert.match(warns[0], /session\/queue 丢了 2 条没有 id 的待发行/);
});

test('没有丢行时不许告警', async () => {
  const { ctx, warns } = makeCtx([
    baselineFor('s-1', { inbox: { 'next-turn': [inboxMessage('m1', '有 id')], 'next-step': [] } }),
  ]);
  await collect(muxFrames(ctx, { payload: { sessionId: 's-1' } }));
  assert.deepEqual(warns, []);
});

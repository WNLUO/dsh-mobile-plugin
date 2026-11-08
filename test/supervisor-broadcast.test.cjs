'use strict';

/**
 * 总管播报（`lib/mobile/supervisor-broadcast.js`）：什么时候开口、念哪一句、其余留屏幕。
 *
 * 这条功能的坏法都不报错：一有动静就蹦一句（几条会话同时在跑时，用户听到的是一串各自
 * 为政的短句）、把两件事说成两句（本该一句话讲完）、空档里硬编一句、说满了还接着说。
 * 所以这里钉判据本身，也钉钩子真调一次能不能只出一句。
 *
 * 不钉措辞——那句话要跟着用户口味改。钉的是「说不说、说几句、先说哪件」。
 *
 * 运行：node --test test/supervisor-broadcast.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  installSupervisorBroadcast,
  installDeviceBroadcast,
  createDeviceBroadcastSink,
  planBroadcast,
  eventOf,
  spokenOf,
  BROADCAST_WINDOW_MS,
  BROADCAST_MAX_CHARS,
} = require('../lib/mobile/supervisor-broadcast.js');

/** 造一条待播事件。 */
const ev = (kind, title, at, sessionId = title) => ({ kind, title, at, sessionId });

/** 睡一小会儿：钩子那条用的是真定时器（压到几毫秒）。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('空档不开口：没有待播的事件时一句话都不说', () => {
  const plan = planBroadcast({ events: [], now: 1000 });
  assert.equal(plan.speak, false);
  assert.equal(plan.text, '');
  assert.equal(plan.reason, 'quiet');
});

test('攒批：刚冒出来的事件先压一会儿，不立刻开口', () => {
  const plan = planBroadcast({ events: [ev('done', '修侧栏', 1000, 's1')], now: 1000 });
  assert.equal(plan.speak, false);
  assert.equal(plan.reason, 'settling');
  // 憋着的那件在队列里等下一拍，不是丢了。
  assert.equal(plan.held.length, 1);
  assert.equal(plan.screen.length, 0);
});

test('攒批窗口过了才开口，窗口内密集到达的几件合成一句', () => {
  const now = 10_000;
  const events = [
    ev('done', '修侧栏', now - BROADCAST_WINDOW_MS - 10, 's1'),
    ev('done', '补接口', now - BROADCAST_WINDOW_MS - 5, 's2'),
    ev('error', '跑迁移', now - BROADCAST_WINDOW_MS - 1, 's3'),
  ];
  const plan = planBroadcast({ events, now });
  assert.equal(plan.speak, true);
  assert.equal(plan.spoken.length, 3);
  // 三件事只出一句（两句封顶，这里第一句就把要紧的都说完了）。
  assert.equal(plan.text.split('。').filter(Boolean).length, 1);
  assert.match(plan.text, /跑迁移/);
  assert.match(plan.text, /修侧栏/);
});

test('两件事合成一句，最要紧的在前：报错 / 在等人答 > 跑完了', () => {
  const now = 20_000;
  const old = now - BROADCAST_WINDOW_MS - 10;
  const both = planBroadcast({ events: [ev('done', '修侧栏', old, 's1'), ev('error', '跑迁移', old, 's2')], now });
  assert.equal(both.speak, true);
  assert.ok(both.text.indexOf('跑迁移') < both.text.indexOf('修侧栏'), `报错应该在前：${both.text}`);

  const waiting = planBroadcast({ events: [ev('done', '修侧栏', old, 's1'), ev('waiting', '补接口', old, 's2')], now });
  assert.equal(waiting.speak, true);
  assert.ok(waiting.text.indexOf('补接口') < waiting.text.indexOf('修侧栏'), `等人答应该在前：${waiting.text}`);
  // 报错比等人答更急：那条已经停了，这条只是被卡住。
  const urgent = planBroadcast({ events: [ev('waiting', '补接口', old, 's1'), ev('error', '跑迁移', old, 's2')], now });
  assert.ok(urgent.text.indexOf('跑迁移') < urgent.text.indexOf('补接口'), `报错该排在等人答前面：${urgent.text}`);
});

test('单条也能正常出：一件事照样念一句', () => {
  const now = 30_000;
  const plan = planBroadcast({ events: [ev('error', '跑迁移', now - BROADCAST_WINDOW_MS - 1, 's1')], now });
  assert.equal(plan.speak, true);
  assert.equal(plan.spoken.length, 1);
  assert.match(plan.text, /跑迁移报错了/);
});

test('上限：这一段说满了就闭嘴，剩下的事留在屏幕', () => {
  const now = 40_000;
  const events = [ev('error', '跑迁移', now - BROADCAST_WINDOW_MS - 1, 's1')];
  const plan = planBroadcast({ events, now, said: 2, maxPerWindow: 2 });
  assert.equal(plan.speak, false);
  assert.equal(plan.reason, 'capped');
  assert.equal(plan.screen.length, 1);
  assert.equal(plan.held.length, 0);
});

test('冷却：刚说完又来一件，先憋着，不追加第二句', () => {
  const now = 50_000;
  const events = [ev('done', '修侧栏', now - BROADCAST_WINDOW_MS - 1, 's1')];
  const plan = planBroadcast({ events, now, sinceLastMs: 500, cooldownMs: 3000 });
  assert.equal(plan.speak, false);
  assert.equal(plan.reason, 'cooldown');
  assert.equal(plan.held.length, 1);
});

test('憋太久就先说手头这一批：事件不断时不会无限期推迟', () => {
  const now = 60_000;
  // 最新那件还很新（窗口内），但最老那件已经超过最长憋的时限。
  const events = [
    ev('done', '修侧栏', now - 9000, 's1'),
    ev('done', '补接口', now - 100, 's2'),
  ];
  const plan = planBroadcast({ events, now, windowMs: 1200, maxWaitMs: 6000 });
  assert.equal(plan.speak, true);
  assert.match(plan.text, /修侧栏/);
});

test('两句封顶：点名最多几件，剩下只报个数，细节留给屏幕', () => {
  const now = 70_000;
  const old = now - BROADCAST_WINDOW_MS - 1;
  const plan = planBroadcast({
    events: [
      ev('error', '跑迁移', old, 's1'),
      ev('done', '修侧栏', old, 's2'),
      ev('done', '补接口', old, 's3'),
      ev('done', '写文档', old, 's4'),
    ],
    now,
    maxItems: 3,
  });
  assert.equal(plan.speak, true);
  const sentences = plan.text.split('。').filter(Boolean);
  assert.ok(sentences.length <= 2, `最多两句，实际 ${sentences.length}：${plan.text}`);
  assert.match(plan.text, /跑迁移/);
  assert.match(plan.text, /还有一件/);
  // 没点名的（第四件）留给屏幕，不进嘴。
  assert.equal(plan.screen.length, 1);
  assert.equal(plan.screen[0].title, '写文档');
});

test('念出来的话不代码、不表格、不链接：只剩能听懂的部分', () => {
  const text = spokenOf(
    [
      '## 结果',
      '```js',
      'const a = 1;',
      '```',
      '| 键 | 值 |',
      '| a | 1 |',
      '看这里 [文档](https://example.com/doc) 和 https://example.com/x 。',
      '`inline` 与 **粗体** 都念内容。',
    ].join('\n'),
  );
  assert.doesNotMatch(text, /const|https?:|\||```/);
  assert.match(text, /文档/);
  assert.match(text, /粗体/);
  assert.ok(text.length <= BROADCAST_MAX_CHARS);
});

test('钩子：两条会话同一拍有动静，只出一句，先说要紧的', async () => {
  const said = [];
  const listeners = [];
  const ctx = {
    on: (name, handler) => {
      listeners.push({ name, handler });
      return () => listeners.splice(0);
    },
  };
  const off = installSupervisorBroadcast(ctx, {
    sink: (text) => said.push(text),
    windowMs: 5,
    maxWaitMs: 200,
    cooldownMs: 0,
    maxPerWindow: 3,
  });
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].name, 'session/event');

  const handler = listeners[0].handler;
  handler({ id: 's1', header: { id: 's1', title: '修侧栏' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  handler({ id: 's2', header: { id: 's2', title: '跑迁移' } }, { type: 'turn/end', data: { reason: { kind: 'error' } } });

  await sleep(60);
  assert.equal(said.length, 1, `两条会话的动静应合成一句，实际 ${said.length} 句：${JSON.stringify(said)}`);
  assert.match(said[0], /跑迁移/);
  assert.match(said[0], /修侧栏/);

  // 同一条会话连报两件（先报错再跑完）：只留最新那件，不把同一件事说两遍。
  handler({ id: 's3', header: { id: 's3', title: '补接口' } }, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  handler({ id: 's3', header: { id: 's3', title: '补接口' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await sleep(60);
  assert.equal(said.length, 2);
  assert.match(said[1], /补接口/);
  assert.doesNotMatch(said[1], /报错/);

  off();
  handler({ id: 's4', header: { id: 's4', title: '又一件' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await sleep(40);
  assert.equal(said.length, 2, '卸掉之后不该还在说');
});

test('折算：子代理与中间帧不播，报错/完成/等人答认得出来', () => {
  assert.equal(eventOf({ header: { id: 's', title: 'x', origin: 'subagent' } }, { type: 'turn/end' }), null);
  assert.equal(eventOf({ header: { id: 's' } }, { type: 'assistant/message' }), null);
  assert.equal(eventOf({ header: { id: 's', title: '跑迁移' } }, { type: 'turn/end', data: { reason: { kind: 'error' } } }).kind, 'error');
  assert.equal(eventOf({ header: { id: 's', title: '跑迁移' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }).kind, 'done');
  assert.equal(eventOf({ header: { id: 's', title: '跑迁移' } }, { type: 'approval/asked' }).kind, 'waiting');
  assert.equal(eventOf({ header: { id: 's', title: '跑迁移' } }, { type: 'question/requested' }).kind, 'waiting');
});

// 出口：判据只说「这一句」，说给谁听由 sink 定。真出口是把这一句放进广播总线，设备级流
// （`mobile/events.js`）订阅它推给手机 —— 帧形状定死 `{type:'supervisor/broadcast',
// text, at}`，App 那边只认这一种。坏法同样是无声的：帧形状歪了手机直接当未知帧丢掉，
// 一句话都不会念，宿主侧却一切正常。
test('出口：sink 收到的就是合并后那一句，帧形状对', async () => {
  const frames = [];
  const listeners = [];
  const ctx = {
    on: (name, handler) => {
      listeners.push({ name, handler });
      return () => listeners.splice(0);
    },
  };
  const off = installDeviceBroadcast(ctx, {
    windowMs: 5,
    maxWaitMs: 200,
    cooldownMs: 0,
    maxPerWindow: 3,
    emit: (frame) => frames.push(frame),
    // 时钟必须真的往前走：事件岁数小于攒批窗口时，策略本来就该压着不说。
    now: () => Date.now(),
  });

  const handler = listeners[0].handler;
  handler({ id: 's1', header: { id: 's1', title: '修侧栏' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  handler({ id: 's2', header: { id: 's2', title: '跑迁移' } }, { type: 'turn/end', data: { reason: { kind: 'error' } } });

  await sleep(60);
  assert.equal(frames.length, 1, `两条会话的动静应只推一帧，实际 ${frames.length} 帧`);
  const frame = frames[0];
  // 形状定死：多一个字段、少一个字段 App 都可能认不出来。
  assert.deepEqual(Object.keys(frame).sort(), ['at', 'text', 'type']);
  assert.equal(frame.type, 'supervisor/broadcast');
  assert.equal(typeof frame.at, 'number');
  assert.ok(frame.at > 0);
  // 推出去的就是合成后那一句（两件事在同一句里），不是两条各自为政的短句。
  assert.match(frame.text, /跑迁移/);
  assert.match(frame.text, /修侧栏/);
  assert.equal(frame.text.split('。').filter(Boolean).length, 1);

  off();
});

test('出口：空句子不推帧（策略层说不说，这里不再编一句出来）', () => {
  const frames = [];
  const sink = createDeviceBroadcastSink({ emit: (frame) => frames.push(frame), now: () => 1 });
  assert.equal(sink('   '), false);
  assert.equal(sink(null), false);
  assert.equal(frames.length, 0);
  assert.equal(sink('跑完了。'), true);
  assert.equal(frames[0].text, '跑完了。');
});

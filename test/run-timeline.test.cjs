'use strict';

// 运行时间线：一轮的步骤怎么折成 App 侧那份视图（`GET /session/run-timeline` 的料）。
//
// 钉五件事：kind 如实映射（宿主只有 think / tool，别发明 say）、历史事件里步骤的顺序与摘要、
// 结局怎么从 turn/end 的 reason 推、每一步带着能点开详情的身份字段（callId / seq / index /
// resultSeq，历史工具步另补 durationMs），以及**截图与标签两格不产出**（那套能力已整块下线，
// 页面按「没有就不画」处理）。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRunTimeline,
  stepOfEntry,
  stepsFromEvents,
  turnMetaOf,
  latestTurnOf,
  runTimelineFromLiveSteps,
  runTimelineFromEvents,
} = require('../lib/mobile/run-timeline.js');

/** 一条 assistant 消息事件（带轮号与时间）。 */
function assistant(turn, seq, content, time = 1000 + seq) {
  return { type: 'assistant/message', seq, time, data: { turn, message: { role: 'assistant', content } } };
}

function toolResult(turn, seq, callId, text, extra) {
  return {
    type: 'tool/result',
    seq,
    time: 1000 + seq,
    data: {
      turn,
      message: { source: { callId }, content: [{ type: 'text', text }], ...(extra && extra.isError ? { isError: true } : {}) },
      ...(extra || {}),
    },
  };
}

test('kind 只映射宿主真有的两档，认不出的一律按工具步兜底', () => {
  assert.equal(stepOfEntry({ key: 'think:0', step: { kind: 'think', summary: '想一下' } }).kind, 'think');
  assert.equal(stepOfEntry({ key: 'tool:a', step: { kind: 'tool', name: 'read', summary: 'x' } }).kind, 'tool');
  assert.equal(stepOfEntry({ key: 'weird', step: { kind: 'say', summary: '兜底' } }).kind, 'tool');
});

test('一步的字段：有就带、没有就不写', () => {
  const withTime = stepOfEntry({
    key: 'tool:call-1',
    step: { kind: 'tool', name: 'bash', summary: 'npm test', state: 'ok', at: 1700000000000, durationMs: 1200 },
  });
  assert.deepEqual(withTime, {
    id: 'tool:call-1',
    kind: 'tool',
    title: 'npm test',
    tool: 'bash',
    state: 'ok',
    durationMs: 1200,
    at: 1700000000000,
  });
  const bare = stepOfEntry({ key: 'tool:call-2', step: { kind: 'tool', name: 'read', summary: '' } });
  assert.equal(bare.title, 'read', '没有摘要就退回工具名，别给一行空白');
  assert.equal('at' in bare, false);
  assert.equal('durationMs' in bare, false);
  assert.equal('state' in bare, false);
  assert.equal('tags' in bare, false, 'tags 没有生产者，不该凭空出现');
  assert.equal('screenshotUrl' in bare, false, 'screenshotUrl 没有生产者，不该凭空出现');
});

test('历史事件折步骤：空推理不算一步，工具步状态由结果反推', () => {
  const events = [
    assistant(3, 10, [
      { type: 'reasoning', text: '先看看目录结构' },
      { type: 'reasoning', text: '' },
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"/tmp/a.ts"}' },
    ]),
    toolResult(3, 11, 'c1', 'file body'),
    assistant(3, 12, [
      { type: 'tool-call', id: 'c2', name: 'bash', arguments: '{"command":"npm test"}' },
    ]),
  ];
  const entries = stepsFromEvents(events, 3);
  assert.deepEqual(entries.map((entry) => entry.step.kind), ['think', 'tool', 'tool']);
  assert.equal(entries[0].step.summary, '先看看目录结构');
  assert.equal(entries[0].step.state, 'ok');
  assert.equal(entries[1].step.summary, '/tmp/a.ts');
  assert.equal(entries[1].step.state, 'ok');
  assert.equal(entries[2].step.state, 'running', '结果还没来就是还在跑');
  // 位置是稳定身份：同一份事件折两遍 key 必须一样。
  assert.deepEqual(entries.map((entry) => entry.key), stepsFromEvents(events, 3).map((entry) => entry.key));
});

test('直播副本那条只透传已有的身份字段，不凭空造', () => {
  const step = stepOfEntry({
    key: 'tool:call-9',
    step: { kind: 'tool', callId: 'call-9', name: 'bash', summary: 'npm test', seq: 42, resultSeq: 43 },
  });
  assert.equal(step.callId, 'call-9');
  assert.equal(step.seq, 42);
  assert.equal(step.resultSeq, 43);
  assert.equal('durationMs' in step, false, '直播副本没有钟，不补耗时');
  assert.equal('index' in step, false, '这一步本来没有 index，就不带');

  // 副本里没带的就是没有：不拿 key 去反解 callId、不拿 0 填 seq。
  const bare = stepOfEntry({ key: 'think:0', step: { kind: 'think', summary: '想一下' } });
  for (const field of ['callId', 'seq', 'index', 'resultSeq', 'durationMs']) {
    assert.equal(field in bare, false, `直播副本没带的 ${field} 不该凭空出现`);
  }

  // 不是安全整数的那些也不当身份字段透出去。
  const messy = stepOfEntry({
    key: 'tool:call-3',
    step: { kind: 'tool', callId: '', name: 'read', seq: '7', index: 1.5, resultSeq: null },
  });
  for (const field of ['callId', 'seq', 'index', 'resultSeq']) {
    assert.equal(field in messy, false, `不合法的 ${field} 不该透出去`);
  }
});

test('历史步补 durationMs：工具步 = 结果 time − 调用 time；思考步不补', () => {
  const events = [
    assistant(3, 10, [
      { type: 'reasoning', text: '先看看目录结构' },
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"/tmp/a.ts"}' },
    ], 1000),
    toolResult(3, 11, 'c1', 'file body'),
  ];
  const entries = stepsFromEvents(events, 3);
  // 历史侧再过一遍 stepOfEntry 才是 App 拿到的那一行。
  const steps = entries.map(stepOfEntry);

  const think = steps[0];
  assert.equal(think.kind, 'think');
  assert.equal(think.seq, 10, '思考步的 seq 就是那条 assistant 事件的 seq');
  assert.equal(think.index, 0, 'index 是块下标，App 靠它定位同一事件里的哪一块');
  assert.equal('durationMs' in think, false, '思考步没有可靠的结束时刻，别编');
  assert.equal('callId' in think, false);

  const tool = steps[1];
  assert.equal(tool.kind, 'tool');
  assert.equal(tool.callId, 'c1');
  assert.equal(tool.seq, 10, '调用事件的 seq');
  assert.equal(tool.resultSeq, 11, '结果事件的 seq，`/session/step` 拿它取详情');
  assert.equal(tool.durationMs, 1011 - 1000, '结果事件 time − 调用事件 time');
});

test('历史工具步端点没时刻时就不写 durationMs', () => {
  const noResultTime = [
    assistant(3, 10, [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"npm test"}' }], 1000),
    { ...toolResult(3, 11, 'c1', 'ok'), time: undefined },
  ];
  const settled = stepOfEntry(stepsFromEvents(noResultTime, 3)[0]);
  assert.equal('durationMs' in settled, false, '结果事件没有 time，耗时就不知道');
  assert.equal(settled.resultSeq, 11, '结果事件的 seq 仍然在');

  // 还在跑（结果没来）同样没有结束时刻。
  const running = stepOfEntry(stepsFromEvents(
    [assistant(3, 10, [{ type: 'tool-call', id: 'c2', name: 'bash', arguments: '{}' }], 1000)], 3,
  )[0]);
  assert.equal(running.state, 'running');
  assert.equal('durationMs' in running, false);
  assert.equal('resultSeq' in running, false, '没有结果事件就没有 resultSeq');
});

test('历史事件只折点名的那一轮', () => {
  const events = [
    assistant(1, 10, [{ type: 'reasoning', text: '上一轮' }]),
    assistant(2, 20, [{ type: 'reasoning', text: '这一轮' }]),
  ];
  assert.deepEqual(stepsFromEvents(events, 2).map((entry) => entry.step.summary), ['这一轮']);
  assert.equal(latestTurnOf(events), 2);
});

test('结局从 turn/end 的 reason 推：error / aborted / max-tokens / 其余', () => {
  const started = { type: 'turn/start', seq: 1, time: 5000, data: { turn: 4 } };
  const user = {
    type: 'user/message',
    seq: 2,
    time: 5001,
    data: { turn: 4, role: 'user', content: [{ type: 'text', text: '帮我看一下这个仓库' }] },
  };
  const cases = [
    [{ kind: 'error' }, 'failed'],
    [{ kind: 'aborted' }, 'stopped'],
    [{ kind: 'max-tokens' }, 'partial'],
    [{ kind: 'end' }, 'done'],
  ];
  for (const [reason, want] of cases) {
    const meta = turnMetaOf([started, user, { type: 'turn/end', seq: 9, time: 9000, data: { turn: 4, reason } }], 4);
    assert.equal(meta.outcome, want, `${reason.kind} → ${want}`);
    assert.equal(meta.startedAt, 5000);
    assert.equal(meta.endedAt, 9000);
    assert.equal(meta.title, '帮我看一下这个仓库');
  }
  // 没有 turn/end 就是还在跑。
  assert.equal(turnMetaOf([started, user], 4).outcome, 'running');
});

test('折出来的视图：id 按轮、结局跟着走、时长由起止现算', () => {
  const run = buildRunTimeline({
    sessionId: 's-1',
    turn: 7,
    title: '跑一遍测试',
    startedAt: 1000,
    endedAt: 4000,
    outcome: 'done',
    entries: [
      { key: 'think:0', step: { kind: 'think', summary: '想想', state: 'ok', at: 1200 } },
      { key: 'tool:c1', step: { kind: 'tool', name: 'bash', summary: 'npm test', state: 'ok', at: 2000 } },
    ],
  });
  assert.equal(run.id, 's-1:7');
  assert.equal(run.status, 'done');
  assert.equal(run.startedAt, 1000);
  assert.equal(run.endedAt, 4000);
  assert.equal(run.steps.length, 2);
  assert.equal(run.steps[1].tool, 'bash');
});

test('认不出的结局落 done，不把没见过的词原样透出去', () => {
  assert.equal(buildRunTimeline({ sessionId: 's', turn: 1, entries: [], outcome: 'zzz' }).status, 'done');
  assert.equal(buildRunTimeline({ sessionId: 's', turn: 1, entries: [] }).status, 'done');
});

test('直播副本：全收口当跑完、还有 running 的就是在跑；起止时刻不编', () => {
  const running = runTimelineFromLiveSteps({
    sessionId: 's-1',
    turn: 2,
    entries: [{ key: 'tool:c1', step: { kind: 'tool', name: 'bash', summary: 'npm test', state: 'running' } }],
  });
  assert.equal(running.status, 'running');
  assert.equal('startedAt' in running, false);
  assert.equal('endedAt' in running, false);

  const settled = runTimelineFromLiveSteps({
    sessionId: 's-1',
    turn: 2,
    entries: [{ key: 'think:0', step: { kind: 'think', summary: '想好了', state: 'ok' } }],
  });
  assert.equal(settled.status, 'done');
});

test('历史里那一轮已经不在窗口里时返回 null（由路由回 404）', () => {
  assert.equal(runTimelineFromEvents([], { sessionId: 's' }), null);
  const other = [assistant(9, 10, [{ type: 'reasoning', text: '别的轮' }])];
  assert.equal(runTimelineFromEvents(other, { sessionId: 's', turn: 3 }), null);
});

test('历史折出来的视图带起止、标题与结局', () => {
  const events = [
    { type: 'turn/start', seq: 1, time: 5000, data: { turn: 4 } },
    { type: 'user/message', seq: 2, time: 5001, data: { turn: 4, role: 'user', content: [{ type: 'text', text: '跑测试' }] } },
    assistant(4, 10, [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"npm test"}' }]),
    toolResult(4, 11, 'c1', 'ok'),
    { type: 'turn/end', seq: 12, time: 9000, data: { turn: 4, reason: { kind: 'end' } } },
  ];
  const run = runTimelineFromEvents(events, { sessionId: 's-1' });
  assert.ok(run);
  assert.equal(run.id, 's-1:4');
  assert.equal(run.title, '跑测试');
  assert.equal(run.status, 'done');
  assert.equal(run.startedAt, 5000);
  assert.equal(run.endedAt, 9000);
  assert.equal(run.steps.length, 1);
  assert.equal(run.steps[0].state, 'ok');
});

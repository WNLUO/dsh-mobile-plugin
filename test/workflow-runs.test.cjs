'use strict';

// 工作流运行记录：四条 `tool-workflow/*` 事件 → 运行 → 阶段 → 成员的三层树。
//
// 这里钉的四条，都是「按桌面实现读出来的、凭直觉会写错」的地方：
//   一、形状是树不是清单（阶段分组、成员按 seq 认）；
//   二、状态只认落定证据（没有 run-end 不能凭「工具调用结束」判死）；
//   三、没给 phase 与给了空串是两档（`missing` / `value:0:`）；
//   四、窗口截断时（只拿到成员事件、没有 run-start）不凭空造卡。

const test = require('node:test');
const assert = require('node:assert/strict');

const { deriveWorkflowRuns, workflowMembers, phaseKeyOf } = require('../lib/mobile/workflow-runs.js');

const RUN = 'run-1';

/** 一条会话事件；`seq` 自增，位置断言要真的动。 */
let seq = 0;
function ev(type, data) {
  seq += 1;
  return { event: { type, seq, time: 1_700_000_000_000 + seq, data: { runId: RUN, ...data } } };
}

const runStart = (name = 'survey') => ev('tool-workflow/run-start', { name });
const agentStart = (memberSeq, label, extra) => ev('tool-workflow/agent-start', { seq: memberSeq, label, childId: `child-${memberSeq}`, ...(extra || {}) });
const agentEnd = (memberSeq, outcome) => ev('tool-workflow/agent-end', { seq: memberSeq, outcome });
const runEnd = (stopReason) => ev('tool-workflow/run-end', { stopReason });

test('run-start 出一条 workflow 行，id 按 runId 锚（重进会话也认得出同一条运行）', () => {
  const out = deriveWorkflowRuns([runStart('chat-scene-survey')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'workflow');
  assert.equal(out[0].id, `workflow-${RUN}`);
  assert.equal(out[0].workflow.name, 'chat-scene-survey');
});

test('阶段按 phase 分组；同一阶段的两个成员落进同一组', () => {
  const out = deriveWorkflowRuns([
    runStart(),
    agentStart(0, '正文行形状', { phase: 'survey' }),
    agentStart(1, '可复用底座', { phase: 'survey' }),
    agentStart(2, '浮层与接管', { phase: 'build' }),
  ]);
  const run = out[0].workflow;
  assert.equal(run.phases.length, 2);
  assert.deepEqual(run.phases[0].members.map((m) => m.label), ['正文行形状', '可复用底座']);
  assert.deepEqual(run.phases[1].members.map((m) => m.label), ['浮层与接管']);
});

test('没给 phase 与给了空串是两档，不许并成一组', () => {
  assert.notEqual(phaseKeyOf(undefined), phaseKeyOf(''));
  const out = deriveWorkflowRuns([
    runStart(),
    agentStart(0, '无阶段'),
    agentStart(1, '空阶段', { phase: '' }),
  ]);
  const run = out[0].workflow;
  assert.equal(run.phases.length, 2);
  // 「没给」那一档 phase 是 null（渲染层据此取「未分阶段」文案），空串原样留着。
  assert.equal(run.phases.find((p) => p.key === 'missing').phase, null);
  assert.equal(run.phases.find((p) => p.key === 'value:0:').phase, '');
});

test('成员状态：没 outcome 是在跑，agent-end 按 outcome 落定', () => {
  const out = deriveWorkflowRuns([
    runStart(),
    agentStart(0, 'a'),
    agentStart(1, 'b'),
    agentEnd(0, 'completed'),
    agentEnd(1, 'failed'),
  ]);
  const members = workflowMembers(out[0].workflow);
  assert.deepEqual(members.map((m) => m.status), ['completed', 'failed']);
  // 整条运行还没 run-end：状态不能自己变成「已完成」。
  assert.equal(out[0].workflow.status, 'running');
});

test('成员按 seq 认，不按标签：同名成员并存、end 只落定那一个', () => {
  const out = deriveWorkflowRuns([
    runStart(),
    agentStart(0, '同一个 agent'),
    agentStart(1, '同一个 agent'),
    agentEnd(1, 'completed'),
  ]);
  const members = workflowMembers(out[0].workflow);
  assert.equal(members.length, 2);
  assert.deepEqual(members.map((m) => m.status), ['running', 'completed']);
});

test('run-end 的三种 stopReason 各落一档（error 是 failed 不是 error）', () => {
  for (const [stop, want] of [['completed', 'completed'], ['error', 'failed'], ['cancelled', 'cancelled']]) {
    const out = deriveWorkflowRuns([runStart(), runEnd(stop)]);
    assert.equal(out[0].workflow.status, want, `${stop} 应落 ${want}`);
  }
});

test('中断证据：没有 run-end 的运行与被撇下的成员一起落 interrupted', () => {
  const out = deriveWorkflowRuns([runStart(), agentStart(0, 'a'), agentStart(1, 'b'), agentEnd(0, 'completed')], { interrupted: true });
  const run = out[0].workflow;
  assert.equal(run.status, 'interrupted');
  // 已经落定的那个成员不动。
  assert.deepEqual(workflowMembers(run).map((m) => m.status), ['completed', 'interrupted']);
});

test('没有中断证据时不把在跑的运行判死', () => {
  const out = deriveWorkflowRuns([runStart(), agentStart(0, 'a')]);
  assert.equal(out[0].workflow.status, 'running');
  assert.equal(workflowMembers(out[0].workflow)[0].status, 'running');
});

test('窗口截断：只拿到成员事件、没有 run-start 时不凭空造卡', () => {
  const out = deriveWorkflowRuns([agentStart(0, 'a'), agentEnd(0, 'completed'), runEnd('completed')]);
  assert.deepEqual(out, []);
});

test('同一条运行只出一行，所有事件并进去（多张卡是重复）', () => {
  const out = deriveWorkflowRuns([runStart(), agentStart(0, 'a'), agentStart(1, 'b'), runEnd('completed')]);
  assert.equal(out.length, 1);
  assert.equal(workflowMembers(out[0].workflow).length, 2);
});

test('两条并行的工作流各出一行，顺序按 run-start 的先后', () => {
  const a = { event: { type: 'tool-workflow/run-start', seq: 1, time: 1, data: { runId: 'A', name: '甲' } } };
  const b = { event: { type: 'tool-workflow/run-start', seq: 2, time: 2, data: { runId: 'B', name: '乙' } } };
  const out = deriveWorkflowRuns([a, b]);
  assert.deepEqual(out.map((row) => row.workflow.name), ['甲', '乙']);
});

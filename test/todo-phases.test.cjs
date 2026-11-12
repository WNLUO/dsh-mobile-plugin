'use strict';

/**
 * 「阶段」的守卫：todo_write 的参数怎么压、当前阶段怎么挑、两条下发路径是否同一口径。
 *
 * 这一组的每一条错了都会在手机上变成静默的错样子 —— 没有报错、没有崩溃，只是那一行不出现
 * 或者写着别人的阶段。三块：
 *  - `slimTodoArguments`：单条截断与整份限量都只在这一处，解析不了就回 undefined（骨架照旧）；
 *  - `todoPhaseOf`：先认 in_progress、没有才退到 pending，序号是整表序号不是未完成的序号；
 *  - 直播侧（`wire-cut` 的 `cutAssistantBlock`）与历史侧（`history-derive` 的 `parseBlocks`）
 *    必须给出同一份 `arguments` 与 `phase`。
 *
 * 运行：node --test test/todo-phases.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TODO_MAX_ITEMS,
  TODO_CONTENT_MAX,
  slimTodoArguments,
  todoPhaseOf,
} = require('../lib/mobile/todo-phases.js');
const { STEP_SUMMARY_MAX } = require('../lib/mobile/step-index.js');
const { cutAssistantBlock } = require('../lib/mobile/wire-cut.js');
const { deriveMessages, thinEntryMessages } = require('../lib/mobile/history-derive.js');

const todo = (content, status) => ({ content, status });

/** `todo_write` 的原生参数形状（宿主就是这么给的：整份清单塞在 `todos` 里）。 */
const argsOf = (todos) => JSON.stringify({ todos });

// ——— slimTodoArguments：形状 ———

test('瘦身：正常解析压成 [{c,s}]，顺序照原文', () => {
  const raw = argsOf([todo('梳理需求', 'completed'), todo('写实现', 'in_progress'), todo('补测试', 'pending')]);
  assert.equal(
    slimTodoArguments(raw),
    JSON.stringify([
      { c: '梳理需求', s: 'completed' },
      { c: '写实现', s: 'in_progress' },
      { c: '补测试', s: 'pending' },
    ]),
  );
});

test('瘦身：畸形 JSON 回 undefined（骨架照旧，不抛错）', () => {
  assert.equal(slimTodoArguments('{"todos":['), undefined);
  assert.equal(slimTodoArguments('不是 json'), undefined);
  assert.equal(slimTodoArguments(''), undefined);
});

test('瘦身：空数组是「没有待办」的有效答案，不是拿不到', () => {
  assert.equal(slimTodoArguments(argsOf([])), '[]');
  assert.equal(slimTodoArguments([]), '[]');
});

test('瘦身：非数组输入一律回 undefined', () => {
  assert.equal(slimTodoArguments(null), undefined);
  assert.equal(slimTodoArguments(undefined), undefined);
  assert.equal(slimTodoArguments(42), undefined);
  assert.equal(slimTodoArguments(true), undefined);
  assert.equal(slimTodoArguments({}), undefined, '没有 todos 字段的对象认不出');
  assert.equal(slimTodoArguments({ todos: 'nope' }), undefined);
  assert.equal(slimTodoArguments([null, 42, 'text']), '[]', '数组里认不出的条目被丢掉');
});

test('瘦身：单条 content 截到与过程摘要同一档，超出用省略号收尾', () => {
  assert.equal(TODO_CONTENT_MAX, STEP_SUMMARY_MAX, '两处画的是同一行，字数上限必须同档');
  const long = '很长的待办'.repeat(40);
  const slim = JSON.parse(slimTodoArguments(argsOf([todo(long, 'in_progress')])));
  assert.equal(slim.length, 1);
  assert.equal(slim[0].c.length, TODO_CONTENT_MAX);
  assert.ok(slim[0].c.endsWith('…'), '截断要有省略号，不然看不出被剪过');
  assert.ok(long.startsWith(slim[0].c.slice(0, -1)));
});

test('瘦身：一份清单最多留 20 条，多出来的丢掉', () => {
  const many = Array.from({ length: 40 }, (_, i) => todo(`第 ${i + 1} 条`, 'pending'));
  const slim = JSON.parse(slimTodoArguments(argsOf(many)));
  assert.equal(slim.length, TODO_MAX_ITEMS);
  assert.equal(slim[TODO_MAX_ITEMS - 1].c, `第 ${TODO_MAX_ITEMS} 条`, '留的是前 20 条，顺序不变');
});

// ——— todoPhaseOf：当前阶段 ———

test('阶段：取第一个 in_progress，序号是整表序号（从 1 起）', () => {
  const todos = [todo('甲', 'completed'), todo('乙', 'in_progress'), todo('丙', 'in_progress'), todo('丁', 'pending')];
  assert.deepEqual(todoPhaseOf(todos), { index: 2, total: 4, label: '乙' });
});

test('阶段：in_progress 换人之后跟着换', () => {
  const before = [todo('甲', 'completed'), todo('乙', 'in_progress'), todo('丙', 'pending')];
  const after = [todo('甲', 'completed'), todo('乙', 'completed'), todo('丙', 'in_progress')];
  assert.equal(todoPhaseOf(before).index, 2);
  assert.equal(todoPhaseOf(after).index, 3);
  assert.equal(todoPhaseOf(after).label, '丙');
});

test('阶段：只有 pending 没有 in_progress 时退到第一个 pending', () => {
  const todos = [todo('甲', 'completed'), todo('甲二', 'completed'), todo('乙', 'pending'), todo('丙', 'pending')];
  assert.deepEqual(todoPhaseOf(todos), { index: 3, total: 4, label: '乙' });
});

test('阶段：全部做完 / 空清单没有「当前」，回 null', () => {
  assert.equal(todoPhaseOf([todo('甲', 'completed'), todo('乙', 'completed')]), null);
  assert.equal(todoPhaseOf([]), null);
});

test('阶段：畸形输入回 null，不抛错', () => {
  assert.equal(todoPhaseOf('{"todos":['), null);
  assert.equal(todoPhaseOf(null), null);
  assert.equal(todoPhaseOf({ todos: [] }), null);
  assert.equal(todoPhaseOf([null, 'nope']), null);
});

test('阶段：label 与瘦身同一档截断', () => {
  const long = '这一步很长'.repeat(40);
  const phase = todoPhaseOf([todo(long, 'in_progress')]);
  assert.equal(phase.label.length, TODO_CONTENT_MAX);
  assert.ok(phase.label.endsWith('…'));
});

test('阶段：认出瘦身之后的 [{c,s}] 形状（手机侧复算用）', () => {
  const slim = JSON.parse(slimTodoArguments(argsOf([todo('甲', 'completed'), todo('乙', 'in_progress')])));
  assert.deepEqual(todoPhaseOf(slim), { index: 2, total: 2, label: '乙' });
});

// ——— 两条下发路径：同一口径 ———

test('直播侧：todo_write 的块仍是 {type,id,name,arguments}，参数换成瘦身投影并挂 phase', () => {
  const raw = argsOf([todo('甲', 'completed'), todo('乙', 'in_progress')]);
  const kept = cutAssistantBlock({ type: 'tool-call', id: 'c1', name: 'todo_write', arguments: raw });
  assert.equal(kept.type, 'tool-call');
  assert.equal(kept.id, 'c1');
  assert.equal(kept.name, 'todo_write', 'App 按名字找它，名字一格都不能少');
  assert.equal(kept.arguments, slimTodoArguments(raw));
  assert.deepEqual(kept.phase, { index: 2, total: 2, label: '乙' });
  assert.deepEqual(Object.keys(kept).sort(), ['arguments', 'id', 'name', 'phase', 'type']);
});

test('直播侧：参数解析不了时还是老骨架（不挂 arguments、不挂 phase）', () => {
  const kept = cutAssistantBlock({ type: 'tool-call', id: 'c2', name: 'todo_write', arguments: '{"todos":[' });
  assert.deepEqual(kept, { type: 'tool-call', id: 'c2', name: 'todo_write' });
});

test('直播侧：别的工具的 arguments 仍然一个字节都不下发', () => {
  const kept = cutAssistantBlock({ type: 'tool-call', id: 'c3', name: 'write', arguments: '{"path":"/tmp/a.md"}' });
  assert.deepEqual(kept, { type: 'tool-call', id: 'c3', name: 'write' });
});

test('历史侧：parseBlocks 与直播侧同一份 arguments 与 phase', () => {
  const raw = argsOf([todo('甲', 'completed'), todo('乙', 'in_progress')]);
  const event = {
    type: 'assistant/message',
    seq: 1,
    time: 1700000000000,
    data: {
      turn: 1,
      step: 0,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '先做乙' },
          { type: 'tool-call', id: 'c1', name: 'todo_write', arguments: raw },
        ],
      },
    },
  };
  const cards = [];
  for (const item of deriveMessages([event])) {
    for (const block of item.blocks || []) if (block.type === 'tool-call') cards.push(block);
  }
  assert.equal(cards.length, 1);
  const live = cutAssistantBlock(event.data.message.content[1]);
  assert.equal(cards[0].argsRaw, live.arguments);
  assert.equal(cards[0].argsRaw, slimTodoArguments(raw));
  assert.deepEqual(cards[0].phase, live.phase);
});

test('入口窗口：thin=1 也要留下 todo_write 那一块（不然刚进会话阶段行整片消失）', () => {
  const raw = argsOf([todo('甲', 'completed'), todo('乙', 'in_progress')]);
  const messages = [
    {
      id: 'u1',
      role: 'user',
      text: '做乙',
      blocks: [{ type: 'text', text: '做乙' }],
      seq: 0,
      time: 1,
    },
    {
      id: 'a1',
      role: 'assistant',
      text: '先做乙',
      blocks: [
        { type: 'tool-call', callId: 'c1', name: 'todo_write', argsRaw: slimTodoArguments(raw), phase: todoPhaseOf(raw) },
        { type: 'tool-call', callId: 'c2', name: 'read', argsRaw: undefined },
      ],
      seq: 1,
      time: 2,
    },
  ];
  const [opener, assistant] = thinEntryMessages(messages, { hasMore: false });
  // 开轮那条会被换成带 turnProcess 的新对象（原样引用不再相等），按身份字段认。
  assert.equal(opener.id, 'u1');
  assert.equal(opener.role, 'user');
  const keptNames = assistant.blocks.filter((block) => block.type === 'tool-call').map((block) => block.name);
  assert.deepEqual(keptNames, ['todo_write'], '阶段块留着，普通工具块照旧剥掉');
  assert.equal(opener.turnProcess.count, 2, '计数照记：留下的那一块也是这一轮的过程项');
});

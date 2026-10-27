'use strict';
// 会话日志 → 移动端消息投影的「过程明细」边界：write/edit 的已应用 diff 不上线路。
//
// App 的对话页不显示过程（改了哪几行、跑了哪些命令），所以 `tool/result` 上的
// `data.meta`（fs 工具挂的 FsDiffMeta，桌面 diff 卡的数据源）整个不进载荷，结果正文也只给
// 定时任务卡要解析的 `schedule_create` 留着。这里直接驱动导出的 deriveMessages（不经过
// HTTP），用真机日志里的事件形状（data = { turn, step, message, meta }）钉住这条边界，
// 并覆盖畸形与超大的 meta 都不会把载荷撑起来。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { deriveMessages } = require('../lib/mobile/sessions.js');
const { toolResultPatchesFor } = require('../lib/mobile/history-derive.js');

/** 一条 user/message，用于让投影有正常的对话起点。 */
function userEvent(text) {
  return { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text }] } } };
}

/** 一条携带 tool-call 的 assistant/message（arguments 为 JSON 字符串，与 harness 同口径）。 */
function assistantCallEvent(callId, name, args) {
  return {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args || {}) }],
      },
    },
  };
}

/** 一条 tool/result；meta 省略时不下发 meta 字段（正常 read/bash 就是这样）。 */
function toolResultEvent(callId, text, options) {
  const opts = options || {};
  const data = {
    turn: 1,
    step: 1,
    message: {
      source: { kind: 'tool', callId },
      content: [
        {
          isError: opts.isError === true,
          content: [{ type: 'text', text }],
        },
      ],
    },
  };
  if (opts.errorCode) data.error = { code: opts.errorCode };
  if ('meta' in opts) data.meta = opts.meta;
  return { type: 'tool/result', seq: opts.seq, data };
}

/** 跑一次投影，返回扁平的工具块列表。 */
function toolCards(events) {
  const out = [];
  for (const item of deriveMessages(events)) {
    for (const block of item.blocks || []) {
      if (block.type === 'tool-call') out.push(block);
    }
  }
  return out;
}

/** 生成一份含 n 行的文本。 */
function lines(n) {
  const rows = [];
  for (let i = 1; i <= n; i += 1) rows.push(`line-${i}`);
  return rows.join('\n');
}

test('投影：edit 的 data.meta 里的 diff 不上线路，工具块只剩状态与名字', () => {
  const events = [
    userEvent('改一下文件'),
    assistantCallEvent('call_1', 'edit', { path: '/tmp/a.md', old_string: 'one', new_string: 'two' }),
    toolResultEvent('call_1', 'The file /tmp/a.md has been updated successfully.', {
      meta: { diffs: [{ path: '/tmp/a.md', oldText: 'one\n', newText: 'two\n' }] },
    }),
  ];
  const [card] = toolCards(events);
  assert.equal(card.name, 'edit');
  assert.equal(card.state, 'ok', '状态要留着：App 按 callId 把图片补到骨架上');
  assert.equal(card.diffs, undefined);
  assert.equal(card.output, undefined);
  assert.equal(card.argsRaw, undefined);
});

test('投影：meta 再大也一样不发（几百行 newText 撑不起来）', () => {
  const events = [
    userEvent('建个文件'),
    assistantCallEvent('call_2', 'write', { path: '/tmp/new.md' }),
    toolResultEvent('call_2', 'created', {
      meta: { diffs: [{ path: '/tmp/new.md', oldText: null, newText: lines(500) }] },
    }),
  ];
  const [card] = toolCards(events);
  assert.equal(card.diffs, undefined);
  assert.equal(card.output, undefined);
});

test('投影：出错的编辑照样只有状态，没有正文与 diff', () => {
  const events = [
    userEvent('改一下文件'),
    assistantCallEvent('call_3', 'edit', { path: '/tmp/a.md' }),
    toolResultEvent('call_3', 'Error: edit requires reading the file first', { isError: true, meta: { diffs: [] } }),
  ];
  const [card] = toolCards(events);
  assert.equal(card.state, 'error');
  assert.equal(card.diffs, undefined);
  assert.equal(card.output, undefined);
});

test('投影：畸形 meta 一律丢掉，绝不抛错', () => {
  const bad = [
    { diffs: 'nope' },
    { diffs: {} },
    { diffs: [] },
    { diffs: [null, 'x', 7] },
    { diffs: [{ path: '', newText: 'x' }] },
    { diffs: [{ path: '/tmp/a.md', newText: 42 }] },
    { nope: 1 },
    null,
  ];
  for (const meta of bad) {
    const events = [
      userEvent('改一下文件'),
      assistantCallEvent('call_bad', 'edit', { path: '/tmp/a.md' }),
      toolResultEvent('call_bad', 'updated', { meta }),
    ];
    const [card] = toolCards(events);
    assert.equal(card.diffs, undefined, `meta=${JSON.stringify(meta)} 不该产生 diffs`);
  }
});

test('落定补丁：增量窗口里只有 callId 与状态，不带正文与 diff', () => {
  const events = [
    toolResultEvent('call-old', 'older result', { seq: 5, meta: { diffs: [{ path: '/tmp/a.md', oldText: null, newText: 'x' }] } }),
    toolResultEvent('call-stopped', 'interrupted result', { seq: 6, errorCode: 'interrupted', isError: true }),
  ];
  assert.deepEqual(toolResultPatchesFor(events, [], { bodies: true }), [
    { callId: 'call-old', state: 'ok' },
    { callId: 'call-stopped', state: 'stopped' },
  ]);
});

test('接线：history-derive 里没有读 meta / diffs 的分支', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mobile', 'history-derive.js'), 'utf8');
  assert.doesNotMatch(source, /meta\.diffs/);
  assert.doesNotMatch(source, /normalizeResultDiffs/);
  assert.doesNotMatch(source, /diffs/);
  assert.doesNotMatch(source, /DIFF_/);
  // 减法本身在共用模块里，投影与直播间调的是同一份。
  assert.match(source, /const kept = cutToolResultEvent\(e, toolNames\.nameOf\(src\.callId\)\);/);
});

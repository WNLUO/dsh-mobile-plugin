'use strict';
// 会话日志 → 移动端消息投影里的 write/edit diff 卡数据。
//
// 真机现象：桌面在 write/edit 后画一张 diff 卡（改了哪几行），App 里同一张工具卡
// 只会把 JSON 参数原样铺开。根因是移动端投影只读 tool/result 的 message.content，
// 把 fs 工具挂在 result.meta 上的 FsDiffMeta（已应用的分块 diff，桌面
// dsh-client-ui-tool 的 diffCardModel 就是从它渲染的）整个丢掉了。
//
// 这里直接驱动导出的 deriveMessages（不经过 HTTP），用真机日志里的真实事件形状
// （data = { turn, step, message, meta }）验证投影是否把 meta.diffs 送到工具卡上，
// 以及畸形/超长数据是否被安全收窄。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { deriveMessages } = require('../lib/mobile/sessions.js');

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
  return { type: 'tool/result', data };
}

/** 跑一次投影，返回扁平的工具卡列表。 */
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

test('投影：meta.diffs 抵达工具卡，路径与前后文本原样保留', () => {
  const events = [
    userEvent('改一下文件'),
    assistantCallEvent('call_1', 'edit', { path: '/tmp/a.md', old_string: 'one', new_string: 'two' }),
    toolResultEvent('call_1', 'The file /tmp/a.md has been updated successfully.', {
      meta: { diffs: [{ path: '/tmp/a.md', oldText: 'one\n', newText: 'two\n' }] },
    }),
  ];
  const [card] = toolCards(events);
  assert.equal(card.name, 'edit');
  assert.equal(card.state, 'ok');
  assert.ok(Array.isArray(card.diffs), '工具卡应带 diffs');
  assert.equal(card.diffs.length, 1);
  assert.deepEqual(card.diffs[0], { path: '/tmp/a.md', oldText: 'one\n', newText: 'two\n' });
});

test('投影：oldText 为 null（新建/覆盖）时保留 null，而不是丢掉这张卡', () => {
  const events = [
    userEvent('建个文件'),
    assistantCallEvent('call_2', 'write', { path: '/tmp/new.md' }),
    toolResultEvent('call_2', 'created', {
      meta: { diffs: [{ path: '/tmp/new.md', oldText: null, newText: lines(12) }] },
    }),
  ];
  const [card] = toolCards(events);
  assert.equal(card.diffs.length, 1);
  assert.equal(card.diffs[0].oldText, null);
  assert.equal(card.diffs[0].newText, lines(12));
});

test('投影：出错的编辑没有 diff 卡，但保留错误态与错误文本', () => {
  const events = [
    userEvent('改一下文件'),
    assistantCallEvent('call_3', 'edit', { path: '/tmp/a.md' }),
    toolResultEvent('call_3', 'Error: edit requires reading the file first', { isError: true, meta: { diffs: [] } }),
  ];
  const [card] = toolCards(events);
  assert.equal(card.state, 'error');
  assert.equal(card.diffs, undefined);
  assert.match(card.output, /requires reading/);
});

test('投影：普通工具（无 meta）不凭空长出 diffs', () => {
  const events = [
    userEvent('看下文件'),
    assistantCallEvent('call_4', 'read', { path: '/tmp/a.md' }),
    toolResultEvent('call_4', 'file body'),
  ];
  const [card] = toolCards(events);
  assert.equal(card.name, 'read');
  assert.equal(card.diffs, undefined);
  assert.equal(card.output, 'file body');
});

test('投影：畸形 meta 一律丢弃，绝不抛错', () => {
  const bad = [
    { diffs: 'nope' },
    { diffs: {} },
    { diffs: [] },
    { diffs: [null, 'x', 7] },
    { diffs: [{ path: '', newText: 'a' }] },
    { diffs: [{ path: '/tmp/a.md' }] },
    { diffs: [{ path: '/tmp/a.md', newText: 3 }] },
    { diffs: [{ path: '/tmp/a.md', newText: 'a', oldText: 7 }] },
    'not-an-object',
    null,
  ];
  bad.forEach((meta, i) => {
    const events = [
      userEvent('改文件'),
      assistantCallEvent(`call_bad_${i}`, 'edit', { path: '/tmp/a.md' }),
      toolResultEvent(`call_bad_${i}`, 'ok', { meta }),
    ];
    const [card] = toolCards(events);
    assert.equal(card.diffs, undefined, `meta=${JSON.stringify(meta)} 不该产生 diffs`);
  });
});

test('投影：单文件超长文本按 400 行截断并打 truncated', () => {
  const events = [
    userEvent('写一篇长文'),
    assistantCallEvent('call_5', 'write', { path: '/tmp/long.md' }),
    toolResultEvent('call_5', 'created', {
      meta: { diffs: [{ path: '/tmp/long.md', oldText: null, newText: lines(500) }] },
    }),
  ];
  const [card] = toolCards(events);
  assert.equal(card.diffs.length, 1);
  assert.equal(card.diffs[0].truncated, true);
  assert.equal(card.diffs[0].newText.split('\n').length, 400);
});

test('投影：一次调用的文件数封顶 20，避免畸形 meta 撑爆载荷', () => {
  const many = [];
  for (let i = 0; i < 25; i += 1) many.push({ path: `/tmp/f${i}.md`, oldText: null, newText: `body ${i}` });
  const events = [
    userEvent('批量写'),
    assistantCallEvent('call_6', 'write', { path: '/tmp/f0.md' }),
    toolResultEvent('call_6', 'created', { meta: { diffs: many } }),
  ];
  const [card] = toolCards(events);
  assert.equal(card.diffs.length, 20);
  assert.equal(card.diffs[0].path, '/tmp/f0.md');
  assert.equal(card.diffs[19].path, '/tmp/f19.md');
});

test('投影：同一次会话里每个调用各带各的 diff，互不串味', () => {
  const events = [
    userEvent('两处修改'),
    assistantCallEvent('call_a', 'edit', { path: '/tmp/a.md' }),
    toolResultEvent('call_a', 'updated a', { meta: { diffs: [{ path: '/tmp/a.md', oldText: 'a1', newText: 'a2' }] } }),
    assistantCallEvent('call_b', 'bash', { command: 'ls' }),
    toolResultEvent('call_b', 'a.md'),
    assistantCallEvent('call_c', 'edit', { path: '/tmp/c.md' }),
    toolResultEvent('call_c', 'updated c', { meta: { diffs: [{ path: '/tmp/c.md', oldText: 'c1', newText: 'c2' }] } }),
  ];
  const cards = toolCards(events);
  assert.equal(cards.length, 3);
  assert.equal(cards[0].diffs[0].path, '/tmp/a.md');
  assert.equal(cards[1].diffs, undefined);
  assert.equal(cards[2].diffs[0].path, '/tmp/c.md');
});

test('接线：投影确实读 tool/result 的 data.meta 并把它挂到工具卡上', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mobile', 'history-derive.js'), 'utf8');
  assert.match(source, /function normalizeResultDiffs\(meta\)/);
  assert.match(source, /const diffs = normalizeResultDiffs\(e\.data\.meta\);/);
  assert.match(source, /\.\.\.\(diffs \? \{ diffs \} : \{\}\)/);
  assert.match(source, /diffs = result\.diffs;/);
  assert.match(source, /\.\.\.diffs && diffs\.length \? \{ diffs \} : \{\},/);
  assert.match(source, /const DIFF_TEXT_MAX_LINES = 400;/);
  assert.match(source, /const DIFF_MAX_FILES = 20;/);
});

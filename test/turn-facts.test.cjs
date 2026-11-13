'use strict';

/** 同轮模型、成功写入、反复编辑净改动与窗口缺失的真实折叠契约。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const facts = require('../lib/mobile/turn-facts.js');
const { cutEvent, createToolNameIndex } = require('../lib/mobile/wire-cut.js');
const event = (type, seq, data = {}) => ({ type, seq, time: seq * 100, data: { turn: 1, ...data } });
const start = event('turn/start', 1);
const header = (seq, model, step = 1) => event('request/header', seq, { step, header: { config: { provider: 'p', model } } });
const answer = (seq, step = 1) => event('assistant/message', seq, { step, message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } });
const call = (seq, id, path = 'a.ts') => event('tool/call', seq, { callId: id, name: 'edit', arguments: { file_path: path, old_string: 'old', new_string: 'new' } });
const result = (seq, id, oldText, newText, extra = {}) => event('tool/result', seq, { message: { source: { callId: id }, content: [], ...extra }, meta: { diffs: [{ path: 'a.ts', oldText, newText }] } });
const fold = (events) => facts.turnFactsSnapshot(facts.foldTurnFacts(events).get(1));

test('失败请求头不覆盖已产出回答的实际模型，轨迹保留尝试', () => {
  const view = fold([start, header(2, 'one'), answer(3), header(4, 'two', 2)]);
  assert.deepEqual(view.actualModel, { provider: 'p', model: 'one' });
  assert.deepEqual(view.modelTrail.map((m) => m.model), ['one', 'two']);
});

test('重复编辑按首个old与最后new算净差，不累加中间变更', () => {
  const events = [start, call(2, 'c1'), result(3, 'c1', 'a\nb\n', 'a\nx\nb\n'), call(4, 'c2'), result(5, 'c2', 'a\nx\nb\n', 'a\nz\nb\n')];
  const view = fold(events);
  assert.deepEqual(view.producedFiles, ['a.ts']);
  assert.deepEqual(view.fileChanges, [{ path: 'a.ts', added: 1, removed: 0 }]);
  const details = facts.turnChangesSnapshot(facts.foldTurnFacts(events).get(1));
  assert.equal(details.files[0].oldText, 'a\nb\n');
  assert.equal(details.files[0].newText, 'a\nz\nb\n');
});

test('失败写入与净未改文件不算产出', () => {
  const view = fold([start, call(2, 'bad'), result(3, 'bad', 'a', 'b', { isError: true }), call(4, 'same'), result(5, 'same', 'a', 'a')]);
  assert.deepEqual(view.producedFiles, []);
  const restored = fold([start, call(2, 'a'), result(3, 'a', 'old', 'new'), call(4, 'b'), result(5, 'b', 'new', 'old')]);
  assert.deepEqual(restored.producedFiles, []);
});

test('中间版本不连续或轮首不在窗口时不能编造整轮行数', () => {
  const partial = fold([call(2, 'a'), result(3, 'a', 'a', 'b')]);
  assert.equal(partial.changesTruncated, true);
  assert.deepEqual(partial.fileChanges, [{ path: 'a.ts' }]);
  const discontinuous = fold([start, call(2, 'a'), result(3, 'a', 'a', 'b'), call(4, 'b'), result(5, 'b', 'other', 'c')]);
  assert.deepEqual(discontinuous.fileChanges, [{ path: 'a.ts' }]);
});

test('相同seq回放不重复吸收，旧窗口补到仍按事件序号计算', () => {
  const state = facts.createTurnFacts();
  const rows = [start, call(2, 'a'), result(3, 'a', 'a', 'b')];
  for (const item of rows.slice().reverse()) facts.absorbTurnFact(state, item);
  for (const item of rows) facts.absorbTurnFact(state, item);
  assert.deepEqual(facts.turnFactsSnapshot(state), fold(rows));
});

test('常规线路继续裁掉请求配置和diff正文', () => {
  const names = createToolNameIndex();
  assert.equal(cutEvent(header(2, 'one'), names), null);
  const cut = cutEvent(result(3, 'a', 'secret-old', 'secret-new'), names);
  assert.equal(cut.data.meta, undefined);
  assert.equal(JSON.stringify(cut).includes('secret-old'), false);
});

test('行差异处理空文件、尾换行和替换', () => {
  assert.deepEqual(facts.lineChanges('', 'a\n'), { added: 1, removed: 0 });
  assert.deepEqual(facts.lineChanges('a\n', ''), { added: 0, removed: 1 });
  assert.deepEqual(facts.lineChanges('a\nb\n', 'a\nc\n'), { added: 1, removed: 1 });
  assert.deepEqual(facts.lineChanges('a', 'a\n'), { added: 1, removed: 1 });
});

'use strict';
/** 真实历史起止投影：漏实时帧、薄入口和增量补拉仍能还原轮次结局。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { turnLifecyclesOf } = require('../lib/mobile/turn-lifecycle.js');
const { deriveMessages, thinEntryMessages } = require('../lib/mobile/history-derive.js');
const event = (type, seq, data) => ({ type, seq, time: seq * 1000, data });
const begin = event('turn/start', 1, { turn: 3 });
const user = event('user/message', 2, { id: 'u', role: 'user', content: [{ type: 'text', text: '你好' }] });
const end = (state) => event('turn/end', 8, { turn: 3, reason: { kind: state, error: { message: '失败' } } });
test('只有开跑与用户消息时，历史明确标记运行', () => {
  const messages = deriveMessages([begin, user]);
  assert.equal(messages[0].turnLifecycle.state, 'running');
  assert.equal(messages[0].turnLifecycle.startSeq, 1);
  assert.equal(messages[0].turnLifecycle.startedAt, 1000);
});
for (const state of ['completed', 'aborted', 'error', 'max-tokens']) {
  test(`${state} 没有助手正文也有起止依据，薄入口不丢`, () => {
    const messages = thinEntryMessages(deriveMessages([begin, user, end(state)]));
    assert.equal(messages[0].turnLifecycle.state, state);
    assert.equal(messages[0].turnLifecycle.endedAt, 8000);
    assert.equal(messages[0].turnLifecycle.seq, 8);
  });
}
test('结束之后迟到旧开跑不能把同一轮重新点亮', () => {
  assert.equal(turnLifecyclesOf([begin, end('completed'), begin]).get(3).state, 'completed');
});
test('回看窗口可提供开跑时间', () => {
  const lifecycle = turnLifecyclesOf([end('completed')], [begin]).get(3);
  assert.equal(lifecycle.startedAt, 1000);
  assert.equal(lifecycle.endedAt, 8000);
});
test('新一轮的边界与上一轮分开', () => {
  const turns = turnLifecyclesOf([begin, end('completed'), event('turn/start', 10, { turn: 4 })]);
  assert.equal(turns.get(3).state, 'completed');
  assert.equal(turns.get(4).state, 'running');
});

'use strict';

/**
 * 派生结果缓存的守卫（第 7 条）：内容没变就交回上一份，变了必须重算。
 *
 * 这里钉三件事，每一件错了都会变成「手机上看到旧数据」或「白算一遍」：
 *  - 判据是内容指纹：同一份输入拿到的就是同一份对象（复用），改一个字节就换一份新的；
 *  - 按会话分桶、桶有上限：两条会话的输入内容一样也不许串，桶数超出按最久没用淘汰；
 *  - 隐藏输入（进程里记下的工具结果）进了指纹：那一页自己没变、更晚的一页记下了结果，
 *    上一页的图也要跟着重算（`tool-result-cache.js` 的版本号）。
 *
 * 第三块是这一组里唯一不像「纯函数缓存」的地方：`deriveMessages` 读的 `toolResultsFor`
 * 是进程状态，不把它算进指纹就会把一张该补上的图永远锁在缓存里。
 *
 * 运行：node --test test/derived-cache.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDerivedCache } = require('../lib/shared/derived-cache.js');
const { deriveMessages } = require('../lib/mobile/history-derive.js');
const { rememberToolResults, clearToolResults } = require('../lib/mobile/tool-result-cache.js');
const ledger = require('../lib/mobile/stats-ledger.cjs');

function userEvent(text, seq = 0) {
  return {
    type: 'user/message',
    seq,
    time: 1700000000000 + Number(seq || 0),
    data: { id: `u-${seq}`, turn: 1, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  };
}

function assistantCallEvent(callId, seq) {
  return {
    type: 'assistant/message',
    seq,
    time: 1700000000000 + Number(seq || 0),
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'image', arguments: '{}' }] },
    },
  };
}

test('缓存：同一份内容交回同一份结果，内容变了就重算', () => {
  const cache = createDerivedCache();
  const value = [{ role: 'user' }];
  assert.equal(cache.get('s1', 'fp-a'), undefined, '没算过就是未命中');
  cache.set('s1', 'fp-a', value);
  assert.equal(cache.get('s1', 'fp-a'), value, '同一份指纹必须复用上一份（这是这一整条的意义）');
  assert.equal(cache.get('s1', 'fp-b'), undefined, '指纹变了就是新内容，必须重算');
  assert.equal(cache.get('s2', 'fp-a'), undefined, '换一条会话不许拿到别人的结果');
});

test('缓存：指纹为空不进缓存（分不清内容有没有变，就老实重算）', () => {
  const cache = createDerivedCache();
  cache.set('s1', '', [{ role: 'user' }]);
  assert.equal(cache.get('s1', ''), undefined);
  assert.equal(cache.get('', 'fp-a'), undefined, '没有桶名不进缓存');
});

test('缓存：每个桶有版本上限，桶数也有上限，超出按最久没用淘汰', () => {
  const cache = createDerivedCache({ maxBuckets: 2, maxEntriesPerBucket: 2 });
  cache.set('s1', 'a', 1);
  cache.set('s1', 'b', 2);
  cache.set('s1', 'c', 3);
  assert.equal(cache.get('s1', 'a'), undefined, '最早的版本被挤出桶（每桶只留两条）');
  assert.equal(cache.get('s1', 'c'), 3);
  assert.equal(cache.get('s1', 'b'), 2, '还在窗口里的版本必须命得中');

  cache.set('s2', 'a', 4);
  cache.set('s3', 'a', 5);
  assert.equal(cache.get('s1', 'b'), undefined, '桶数超上限时挤掉最久没用的那个桶');
  assert.equal(cache.get('s3', 'a'), 5);
});

test('deriveMessages：同一段事件折出来的就是同一份（数组按引用复用）', () => {
  clearToolResults();
  const events = [userEvent('你好', 0), assistantCallEvent('call-1', 1)];
  const first = deriveMessages(events, 'sess-cache-a');
  const again = deriveMessages(events, 'sess-cache-a');
  assert.equal(again, first, '一份没变的事件窗口只该折一次');

  const changed = [userEvent('你好', 0), userEvent('又说一句', 2)];
  const next = deriveMessages(changed, 'sess-cache-a');
  assert.notEqual(next, first, '事件变了必须重算（不能拿上一份糊弄）');
  assert.equal(next.length, 2);

  clearToolResults('sess-cache-a');
});

test('deriveMessages：两条会话同一段事件也不许共用一份（分桶）', () => {
  clearToolResults();
  const events = [userEvent('你好', 0)];
  const a = deriveMessages(events, 'sess-cache-b1');
  const b = deriveMessages(events, 'sess-cache-b2');
  assert.notEqual(a, b, '按会话分桶：换会话不能串');
  clearToolResults('sess-cache-b1');
  clearToolResults('sess-cache-b2');
});

test('deriveMessages：进程里补记的工具结果会把图带上（隐藏输入进了指纹）', () => {
  clearToolResults('sess-cache-c');
  // 这一页只有调用、没有结果 —— 正是「边界切在调用与结果之间」的形状。
  const page = [userEvent('画张图', 0), assistantCallEvent('call-1', 1)];
  const alone = deriveMessages(page, 'sess-cache-c');
  assert.equal(alone[alone.length - 1].images, undefined, '结果还不在这一页时，图确实带不上');

  // 更晚的一页把结果记进了进程：同一段事件现在应当折出带图的那一份。
  rememberToolResults('sess-cache-c', new Map([[
    'call-1',
    { isError: false, images: [{ mediaType: 'image/png', attachmentId: 'att-cache' }] },
  ]]));
  const merged = deriveMessages(page, 'sess-cache-c');
  assert.notEqual(merged, alone, '进程里的结果变了就是输入变了，必须重算');
  assert.deepEqual(merged[merged.length - 1].images, [{ mediaType: 'image/png', attachmentId: 'att-cache' }]);

  clearToolResults('sess-cache-c');
});

test('summarize：同一本账同一个范围只折一次，账本一动（抬版本）就重算', () => {
  const now = Date.UTC(2026, 10, 10, 6, 0);
  const book = { version: 1, updatedAt: 0, days: {}, sessions: {}, models: {}, composition: null };
  ledger.applyDelta(book, { sessionId: 's1', at: now, delta: { ...ledger.emptyUsage(), uncachedInputTokens: 100 }, title: 'A' });

  const first = ledger.summarize(book, '7d', now);
  const again = ledger.summarize(book, '7d', now);
  assert.equal(again, first, '账本与范围都没变时交回同一份（统计页 1.5 秒轮询一次）');

  // 换范围要重算：逐日序列不一样。
  const month = ledger.summarize(book, '30d', now);
  assert.notEqual(month, first);
  assert.equal(month.days.length, 30);

  // 账本再动一笔：版本抬了，之前那份不许再交出来。
  ledger.applyDelta(book, { sessionId: 's2', at: now, delta: { ...ledger.emptyUsage(), uncachedInputTokens: 7 } });
  const fresh = ledger.summarize(book, '7d', now);
  assert.equal(fresh.kpi.uncachedInputTokens, 107, '账本变了必须重算，不能把旧数字交回去');
});

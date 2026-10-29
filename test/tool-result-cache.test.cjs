'use strict';
// 工具结果记录表：倒着分页时「调用在这一页、结果在下一页」那一段要靠它补齐。
//
// 钉三件事：记下来的能查回来、重复记不覆盖先到的那份（结果不会变）、两个上限都当真
// （每会话的条数、同时记几条会话）。
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  rememberToolResults,
  toolResultsFor,
  clearToolResults,
  MAX_CALLS_PER_SESSION,
  MAX_SESSIONS,
} = require('../lib/mobile/tool-result-cache.js');

test('记下来的结果能按会话查回来', () => {
  clearToolResults();
  rememberToolResults('s1', new Map([['call-1', { images: [{ attachmentId: 'a' }] }]]));
  assert.equal(toolResultsFor('s1').get('call-1').images[0].attachmentId, 'a');
  assert.equal(toolResultsFor('s2'), null, '别的会话不该看见');
  clearToolResults();
});

test('重复记同一次调用不覆盖先到的那一份', () => {
  clearToolResults();
  rememberToolResults('s1', new Map([['call-1', { state: 'first' }]]));
  rememberToolResults('s1', new Map([['call-1', { state: 'second' }]]));
  assert.equal(toolResultsFor('s1').get('call-1').state, 'first');
  clearToolResults();
});

test('每会话条数有上限，最旧的先走', () => {
  clearToolResults();
  const many = new Map();
  for (let i = 0; i < MAX_CALLS_PER_SESSION + 10; i += 1) many.set(`call-${i}`, { i });
  rememberToolResults('s1', many);
  const bucket = toolResultsFor('s1');
  assert.equal(bucket.size, MAX_CALLS_PER_SESSION);
  assert.equal(bucket.has('call-0'), false, '最早那几条该被淘汰');
  assert.equal(bucket.has(`call-${MAX_CALLS_PER_SESSION + 9}`), true);
  clearToolResults();
});

test('同时只记最近的几条会话', () => {
  clearToolResults();
  for (let i = 0; i < MAX_SESSIONS + 2; i += 1) rememberToolResults(`s-${i}`, new Map([['c', { i }]]));
  assert.equal(toolResultsFor('s-0'), null, '最旧的那条会话该被挤掉');
  assert.ok(toolResultsFor(`s-${MAX_SESSIONS + 1}`), '最新那条还在');
  clearToolResults();
});

test('没有会话 id 时什么都不记（测试与合成事件走这条路）', () => {
  clearToolResults();
  rememberToolResults(undefined, new Map([['c', { i: 1 }]]));
  rememberToolResults('', new Map([['c', { i: 1 }]]));
  assert.equal(toolResultsFor(undefined), null);
  assert.equal(toolResultsFor(''), null);
});

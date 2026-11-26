// 任务提醒的工作区归属只认精确证据：显式 workspaceId、唯一的会话归属、或唯一的工作区路径。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { workspaceIdOfRows } = require('../lib/mobile/workspace-id.js');
const { workspaceIdOf } = require('../lib/mobile/workspace-id.js');

const rows = [
  { workspaceId: 'w1', path: '/proj/one', sessionIds: ['s1', 's2'] },
  { workspaceId: 'w2', path: '/proj/two', sessionIds: ['s3'] },
];

test('summary 自带 workspaceId 优先（去除首尾空白）', () => {
  assert.equal(workspaceIdOfRows(rows, { sessionId: 's1', workspaceId: '  w9  ' }), 'w9');
});

test('会话归属唯一时按 sessionIds 精确命中', () => {
  assert.equal(workspaceIdOfRows(rows, { sessionId: 's3' }), 'w2');
});

test('会话归属到多个工作区时判不清，回空串', () => {
  const dup = [
    { workspaceId: 'wa', path: '/a', sessionIds: ['s1'] },
    { workspaceId: 'wb', path: '/b', sessionIds: ['s1'] },
  ];
  assert.equal(workspaceIdOfRows(dup, { sessionId: 's1' }), '');
});

test('没有会话归属时按规范化路径唯一命中', () => {
  assert.equal(workspaceIdOfRows(rows, { sessionId: 'unknown', cwd: '/proj/two/' }), 'w2');
});

test('路径不唯一或完全对不上：回空串，绝不前缀 / 模糊匹配', () => {
  const dup = [
    { workspaceId: 'wa', path: '/proj/same', sessionIds: [] },
    { workspaceId: 'wb', path: '/proj/same', sessionIds: [] },
  ];
  assert.equal(workspaceIdOfRows(dup, { sessionId: 'x', cwd: '/proj/same' }), '');
  assert.equal(workspaceIdOfRows(rows, { sessionId: 'x', cwd: '/proj/one/nested' }), '');
});

test('workspaceIdOf 经 registry 解析（不依赖 workspace.follow 流）', async () => {
  const ctx = {
    get(name) {
      if (name !== 'workspaceRegistry') return undefined;
      return { list: () => rows.map((r) => ({ id: r.workspaceId, path: r.path, sessionIds: [...r.sessionIds] })) };
    },
  };
  assert.equal(await workspaceIdOf(ctx, { sessionId: 's3' }), 'w2');
  assert.equal(await workspaceIdOf(ctx, { sessionId: 'none' }), '');
});

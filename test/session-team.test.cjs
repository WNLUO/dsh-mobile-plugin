'use strict';

/**
 * 会话级「启用智能体团队协作」的写路由契约。
 *
 * 这个开关与模型附加选项不是一回事：它写的是**这条会话自己的日志**（宿主
 * `agentTeams.setEnabled` 往根会话追加一条 `team/mode`），所以这里钉的是：
 *
 *  1. 入参只认 `{ sessionId, enabled }`，`enabled` 必须是布尔（真假由界面决定，
 *     但「传 undefined」不能当成关 —— 那等于把一条没拨过的开关悄悄关掉）；
 *  2. 透传给宿主的参数名与顺序（`agentId` + `enabled`），错的后果是静默 400；
 *  3. 宿主没装团队插件（没有 `agentTeams` 服务）时如实回错误，不假装成功。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { handleSessionTeam, callAgentTeams } = require('../lib/mobile/session-team.js');

function contextOf(overrides = {}) {
  const calls = [];
  const ctx = {
    apiProxy: {
      agentTeams: {
        setEnabled: async (request) => {
          calls.push(request);
          return overrides.setEnabled
            ? overrides.setEnabled(request)
            : { result: { ok: true, value: undefined } };
        },
      },
    },
  };
  return { ctx, calls };
}

test('callAgentTeams 按宿主 descriptor 的键名与顺序透传', async () => {
  const { ctx, calls } = contextOf();
  await callAgentTeams(ctx, { sessionId: 's1', enabled: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'agentTeams.setEnabled');
  assert.deepEqual(calls[0].payload, { sessionId: 's1', enabled: true });
});

test('POST /session/team-mode：缺字段 / 非布尔 enabled 本地 400，不碰宿主', async () => {
  const { ctx, calls } = contextOf();
  const server = http.createServer(async (req, res) => { await handleSessionTeam(ctx, req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/api/mobile/v1/session/team-mode`;
  const post = (body) => fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    for (const body of [{}, { sessionId: 's1' }, { sessionId: 's1', enabled: 'true' }, { enabled: true }]) {
      const res = await post(body);
      assert.equal(res.status, 400, `这份入参本该 400：${JSON.stringify(body)}`);
      assert.equal((await res.json()).error.code, 'bad-request');
    }
    assert.equal(calls.length, 0, '入参不合法时一次宿主都不该调');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /session/team-mode：成功回 enabled，开与关都发得出去', async () => {
  const { ctx, calls } = contextOf();
  const server = http.createServer(async (req, res) => { await handleSessionTeam(ctx, req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/api/mobile/v1/session/team-mode`;
  const post = (body) => fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    for (const enabled of [true, false]) {
      const res = await post({ sessionId: 's1', enabled });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, enabled });
    }
    assert.deepEqual(calls.map((call) => call.payload.enabled), [true, false]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('宿主没装团队插件时如实回错误，不当成成功', async () => {
  const { ctx } = contextOf({
    setEnabled: async () => ({ result: { ok: false, error: { code: 'host-unavailable', message: 'no agentTeams' } } }),
  });
  const server = http.createServer(async (req, res) => { await handleSessionTeam(ctx, req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/mobile/v1/session/team-mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', enabled: true }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'host-unavailable');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

'use strict';

/**
 * `dsh_feedback` 工具：AI 查清问题后把反馈提交到分发平台。
 *
 * 钉四件事：
 *  1. 两条途径在工具说明与 `channels` 动作里都看得到（分发平台 + GitHub）；
 *  2. 身份从凭据记录里取——设备号 / 平台 / 机型 / 系统版本 / App 版本 / 包名 / 构建号 / 渠道；
 *  3. 提交走固定基址的 `/api/sdk/feedback`，字段名与 App 的反馈页逐字对齐；
 *  4. 正文为空 / 超长 / 没连设备，在本地就拒，**一个请求都不发**。
 *
 * 全程用注入的假 fetch，不联网。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_PACKAGE_ID,
  FEEDBACK_PATH,
  GITHUB_REPO,
  PLATFORM_ORIGIN,
  buildFeedbackForm,
  feedbackChannels,
  installFeedback,
  pickDevice,
  registerFeedbackTool,
  submitFeedback,
} = require('../lib/mobile/feedback.js');

/** 一台设备的活动记录（形状与凭据库 `listDevices` 一致）。 */
function deviceRow(overrides = {}) {
  return {
    deviceId: 'phone-1',
    name: '主力机',
    model: 'Xiaomi 9',
    platform: 'android',
    osVersion: '34',
    appVersion: '0.5.50',
    packageId: 'com.dsh.mobile',
    buildNumber: '465',
    channel: 'direct',
    lastSeenAt: 2000,
    boundAt: 1000,
    ...overrides,
  };
}

/** 记录每次请求的假 fetch：回一个带 `data.thread_key` 的包。 */
function fakeFetch(body, status = 200) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body });
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    };
  };
  impl.calls = calls;
  return impl;
}

function withFetch(fake, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = original; });
}

function depsFor(devices = [deviceRow()]) {
  return {
    credentials: { listDevices: () => devices },
    instanceId: () => 'inst-1',
  };
}

test('channels：两条途径都在，GitHub 那条标明要登录', () => {
  const channels = feedbackChannels();
  assert.equal(channels.length, 2);
  const distribution = channels.find((channel) => channel.kind === 'distribution');
  assert.ok(distribution, '缺少分发平台那条');
  assert.equal(distribution.endpoint, `${PLATFORM_ORIGIN}${FEEDBACK_PATH}`);
  assert.equal(distribution.requiresLogin, false);
  const github = channels.find((channel) => channel.kind === 'github');
  assert.ok(github, '缺少 GitHub 那条');
  assert.equal(github.repo, GITHUB_REPO);
  assert.equal(github.requiresLogin, true);
});

test('pickDevice：给了设备号按它找；没给取最近连着的那台；找不到照实报', () => {
  const devices = [
    deviceRow({ deviceId: 'phone-recent', lastSeenAt: 3000 }),
    deviceRow({ deviceId: 'phone-old', lastSeenAt: 1000 }),
  ];
  assert.equal(pickDevice(devices, 'phone-old').deviceId, 'phone-old');
  assert.equal(pickDevice(devices).deviceId, 'phone-recent');
  assert.throws(() => pickDevice(devices, 'phone-missing'), /找不到设备/);
  assert.throws(() => pickDevice([]), /没有已连接的手机/);
});

test('表单字段与 App 的反馈页对齐；包名读不到时回退默认产品号', () => {
  const form = buildFeedbackForm(deviceRow(), '插件连不上', 'tk-9');
  assert.equal(form.get('package_id'), 'com.dsh.mobile');
  assert.equal(form.get('platform'), 'android');
  assert.equal(form.get('version_name'), '0.5.50');
  assert.equal(form.get('build_number'), '465');
  assert.equal(form.get('model'), 'Xiaomi 9');
  assert.equal(form.get('system_version'), '34');
  assert.equal(form.get('channel'), 'direct');
  assert.equal(form.get('content'), '插件连不上');
  assert.equal(form.get('thread_key'), 'tk-9');
  assert.equal(form.get('device_id'), 'phone-1');

  const fallback = buildFeedbackForm(deviceRow({ packageId: '' }), 'x');
  assert.equal(fallback.get('package_id'), DEFAULT_PACKAGE_ID);
});

test('submitFeedback：提交到固定基址，带回线程 key', async () => {
  const fake = fakeFetch({ data: { thread_key: 'tk-abc' } });
  await withFetch(fake, async () => {
    const result = await submitFeedback(depsFor(), '发现一个真问题', undefined, undefined);
    assert.equal(result.threadKey, 'tk-abc');
    assert.match(result.message, /tk-abc/);
  });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url, `${PLATFORM_ORIGIN}${FEEDBACK_PATH}`);
  assert.equal(fake.calls[0].method, 'POST');
});

test('submitFeedback：平台报错时把它的文案带出来；429 单独说太频繁', async () => {
  await withFetch(fakeFetch({ error: '内容不能为空' }, 400), async () => {
    await assert.rejects(() => submitFeedback(depsFor(), 'x'), /内容不能为空/);
  });
  await withFetch(fakeFetch({}, 429), async () => {
    await assert.rejects(() => submitFeedback(depsFor(), 'x'), /太频繁/);
  });
});

test('工具：动作清单、说明里有两条途径、缺 content 与超长都拒（不发请求）', async () => {
  let registered = null;
  const ctx = { tools: { register: (tool) => { registered = tool; } } };
  registerFeedbackTool(ctx, depsFor());
  assert.equal(registered.name, 'dsh_feedback');
  assert.deepEqual([...registered.parameters.properties.action.enum].sort(), ['channels', 'submit']);
  assert.match(registered.description, /distribution platform/);
  assert.match(registered.description, new RegExp(GITHUB_REPO));

  const channels = await registered.execute({ action: 'channels' });
  assert.equal(channels.action, 'channels');
  assert.equal(channels.channels.length, 2);
  assert.match(registered.output.render({}, channels)[0].text, /两条反馈途径/);

  const fake = fakeFetch({ data: { thread_key: 'tk-1' } });
  await withFetch(fake, async () => {
    const submitted = await registered.execute({ action: 'submit', content: '查出来的问题' });
    assert.equal(submitted.submitted, true);
    assert.equal(submitted.threadKey, 'tk-1');
  });
  assert.equal(fake.calls.length, 1);

  await assert.rejects(() => registered.execute({ action: 'submit' }), /需要 content/);
  await assert.rejects(() => registered.execute({ action: 'submit', content: 'x'.repeat(4001) }), /超长/);
  await assert.rejects(() => registered.execute({ action: 'noop' }), /must be one of|invalid arguments/);
});

test('installFeedback：没有 tools 注入时静默跳过；别的注册失败照抛', () => {
  const missing = { get tools() { throw new Error('cannot get property "tools" without inject'); } };
  assert.doesNotThrow(() => installFeedback(missing, depsFor()));

  const broken = { tools: { register() { throw new Error('tool registry exploded'); } } };
  assert.throws(() => installFeedback(broken, depsFor()), /tool registry exploded/);
});

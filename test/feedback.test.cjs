// 用途：验证插件反馈提交、线程读取与续回复共用服务，保留身份、附件和重试契约。
'use strict';

/**
 * `dsh_feedback` 工具与公开提交表单的守卫。
 *
 * 钉五件事：
 *  1. 两条途径在工具说明与 `channels` 动作里都看得到，且不再要求先查明根因；
 *  2. 没连手机也能提交：不默认取最近一台，用本机安装身份，手机那几格留空；
 *  3. 新 multipart 字段与 text/plain 诊断附件都在，context 是 JSON 摘要；
 *  4. 同一条反馈重试复用 submission_id，回执照实给出线程 key，不冒充写进 App 列表；
 *  5. 正文为空 / 超长在本地就拒，平台报错照实带出来。
 *
 * 全程用注入的假 fetch，不联网。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const {
  ATTACHMENT_NAME,
  COMPONENT_ID,
  COMPONENT_VERSION,
  DEFAULT_PACKAGE_ID,
  FEEDBACK_PATH,
  GITHUB_REPO,
  PLATFORM_ORIGIN,
  PRODUCT_SLUG,
  SOURCE,
  buildFeedbackForm,
  feedbackChannels,
  installFeedback,
  pickDevice,
  registerFeedbackTool,
  submissionIdFor,
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

function depsFor(devices = [deviceRow()], instanceId = 'inst-1') {
  return {
    credentials: { listDevices: () => devices },
    instanceId: () => instanceId,
  };
}

test('channels：两条途径都在，说明里写明不用查明根因、也不用配手机', () => {
  const channels = feedbackChannels();
  assert.equal(channels.length, 2);
  const distribution = channels.find((channel) => channel.kind === 'distribution');
  assert.ok(distribution, '缺少分发平台那条');
  assert.equal(distribution.endpoint, `${PLATFORM_ORIGIN}${FEEDBACK_PATH}`);
  assert.equal(distribution.requiresLogin, false);
  assert.match(distribution.description, /read 动作查看官方回复/);
  assert.match(distribution.description, /submit 带 threadKey 继续补充/);
  assert.match(distribution.description, /不会写进 App 的反馈列表/);
  assert.match(distribution.description, /没配手机也能提交/);
  assert.match(distribution.description, /线程 key/);
  assert.doesNotMatch(distribution.description, /收到官方回复/);
  const github = channels.find((channel) => channel.kind === 'github');
  assert.ok(github, '缺少 GitHub 那条');
  assert.equal(github.repo, GITHUB_REPO);
  assert.equal(github.requiresLogin, true);
});

test('pickDevice：只认明确指定的设备；没给或不在这台都不报错、不默认取最近一台', () => {
  const devices = [
    deviceRow({ deviceId: 'phone-recent', lastSeenAt: 3000 }),
    deviceRow({ deviceId: 'phone-old', lastSeenAt: 1000 }),
  ];
  assert.equal(pickDevice(devices, 'phone-old').deviceId, 'phone-old');
  assert.equal(pickDevice(devices, 'phone-missing'), null);
  assert.equal(pickDevice(devices), null);
  assert.equal(pickDevice([]), null);
  assert.equal(pickDevice(null, 'phone-1'), null);
});

test('表单：设备身份逐格对齐，新字段与 text/plain 诊断附件齐全，context 是 JSON 摘要', async () => {
  const form = buildFeedbackForm(deviceRow(), '插件连不上', 'tk-9', {
    localDeviceId: 'inst-1',
    submissionId: 'sub-1',
    diagnosis: 'dsh-mobile-plugin feedback\nself_check=ok',
  });
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

  assert.equal(form.get('product_slug'), PRODUCT_SLUG);
  assert.equal(form.get('source'), SOURCE);
  assert.equal(form.get('component_id'), COMPONENT_ID);
  assert.equal(form.get('component_version'), COMPONENT_VERSION);
  assert.equal(form.get('submission_id'), 'sub-1');
  const context = JSON.parse(form.get('context'));
  assert.equal(context.source, 'plugin');
  assert.equal(context.device_source, 'paired');
  assert.deepEqual(context.files, { name: ATTACHMENT_NAME, type: 'text/plain' });
  assert.equal(context.attachment, undefined);
  const attachment = form.get('files');
  assert.equal(attachment.type, 'text/plain');
  assert.equal(attachment.name, ATTACHMENT_NAME);
  assert.match(await attachment.text(), /self_check=ok/);

  const fallback = buildFeedbackForm(deviceRow({ packageId: '' }), 'x');
  assert.equal(fallback.get('package_id'), DEFAULT_PACKAGE_ID);
});

test('没有设备：用本机安装 id，受影响手机那几格留空，不伪造平台或机型', () => {
  const form = buildFeedbackForm(null, '面板打不开', undefined, {
    localDeviceId: 'local-random-id',
    submissionId: 'sub-2',
    diagnosis: 'diag',
  });
  assert.equal(form.get('device_id'), 'local-random-id');
  for (const key of ['package_id', 'platform', 'version_name', 'build_number', 'model', 'system_version', 'channel']) {
    assert.equal(form.get(key), '', `${key} 应当留空`);
  }
  assert.equal(form.get('source'), 'plugin');
  assert.equal(form.get('product_slug'), 'dsh-mobile');
  const context = JSON.parse(form.get('context'));
  assert.equal(context.device_source, 'install');
  assert.doesNotMatch(form.get('context'), /android|ios|extension/i);
});

test('submitFeedback：没连手机也提交成功，回执给出可复制的线程 key', async () => {
  const fake = fakeFetch({ data: { thread_key: 'tk-abc' } });
  await withFetch(fake, async () => {
    const result = await submitFeedback(depsFor([]), '没手机也交', undefined, undefined);
    assert.equal(result.threadKey, 'tk-abc');
    assert.ok(result.submissionId);
    assert.match(result.message, /tk-abc/);
    assert.match(result.message, /复制编号/);
    assert.match(result.message, /不会写进 App 的反馈列表/);
    assert.doesNotMatch(result.message, /收到官方回复/);
    const form = fake.calls[0].body;
    assert.equal(form.get('device_id'), 'inst-1');
    assert.equal(form.get('platform'), '');
    assert.equal(JSON.parse(form.get('context')).device_source, 'install');
  });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url, `${PLATFORM_ORIGIN}${FEEDBACK_PATH}`);
  assert.equal(fake.calls[0].method, 'POST');
});

test('submitFeedback：明确指定设备时带它的真实身份，没给时仍用安装身份', async () => {
  const fake = fakeFetch({ data: { thread_key: 'tk-2' } });
  await withFetch(fake, async () => {
    const deps = depsFor([deviceRow({ deviceId: 'phone-9', platform: 'android' }), deviceRow({ deviceId: 'phone-1' })]);
    await submitFeedback(deps, '指定那台', undefined, 'phone-9');
    let form = fake.calls[0].body;
    assert.equal(form.get('device_id'), 'phone-9');
    assert.equal(form.get('platform'), 'android');
    assert.equal(JSON.parse(form.get('context')).device_source, 'paired');

    await submitFeedback(deps, '不指定', undefined, undefined);
    form = fake.calls[1].body;
    assert.equal(form.get('device_id'), 'inst-1');
    assert.equal(form.get('platform'), '');
  });
});

test('submission_id：同一条反馈重试复用，换了内容才换号', () => {
  const a = submissionIdFor('同一个现象', 'tk-1');
  assert.equal(submissionIdFor('同一个现象', 'tk-1'), a);
  assert.notEqual(submissionIdFor('另一个现象', 'tk-1'), a);
  assert.notEqual(submissionIdFor('同一个现象', 'tk-2'), a);
});

test('submission_id：在途重复提交复用同一个号，不必每次新生成', async () => {
  const fake = fakeFetch({ data: { thread_key: 'tk-3' } });
  await withFetch(fake, async () => {
    const deps = depsFor([]);
    // 两次调用都还没等到 fetch 返回，第二次必须拿到第一次已经缓存的号。
    const firstCall = submitFeedback(deps, '在途同一条');
    const secondCall = submitFeedback(deps, '在途同一条');
    const [first, second] = await Promise.all([firstCall, secondCall]);
    assert.equal(first.submissionId, second.submissionId);
    assert.equal(fake.calls[0].body.get('submission_id'), first.submissionId);
    assert.equal(fake.calls[1].body.get('submission_id'), second.submissionId);
  });
});

test('submission_id：提交成功后清除、下一次同内容是新号；失败保留、重试沿用旧号', async () => {
  const first = fakeFetch({ data: { thread_key: 'tk-clear-1' } });
  let firstId = '';
  await withFetch(first, async () => {
    firstId = (await submitFeedback(depsFor([]), '成功后清除-甲')).submissionId;
  });
  assert.equal(first.calls[0].body.get('submission_id'), firstId);

  const second = fakeFetch({ data: { thread_key: 'tk-clear-2' } });
  await withFetch(second, async () => {
    const again = await submitFeedback(depsFor([]), '成功后清除-甲');
    assert.notEqual(again.submissionId, firstId, '成功后清掉缓存，同内容下一次是新反馈');
    assert.notEqual(second.calls[0].body.get('submission_id'), firstId);
  });

  const failing = fakeFetch({ error: '平台暂时不可用' }, 500);
  await withFetch(failing, async () => {
    await assert.rejects(() => submitFeedback(depsFor([]), '失败后保留-乙'), /平台暂时不可用/);
  });
  const failedId = failing.calls[0].body.get('submission_id');
  assert.ok(failedId, '失败的请求也要带上 submission_id');

  const retry = fakeFetch({ data: { thread_key: 'tk-retry' } });
  await withFetch(retry, async () => {
    const done = await submitFeedback(depsFor([]), '失败后保留-乙');
    assert.equal(done.submissionId, failedId, '失败保留，重试沿用同一个号');
    assert.equal(retry.calls[0].body.get('submission_id'), failedId);
  });
});

test('submitFeedback：直连表单带 files 附件，字段名、文件名与类型都对', async () => {
  const fake = fakeFetch({ data: { thread_key: 'tk-files' } });
  await withFetch(fake, async () => {
    await submitFeedback(depsFor([]), '直连表单附件');
    const form = fake.calls[0].body;
    const file = form.get('files');
    assert.ok(file, '缺少 files 附件');
    assert.equal(file.name, ATTACHMENT_NAME);
    assert.equal(file.type, 'text/plain');
    assert.equal(form.get('attachment'), null, '服务端不认 attachment 字段');
    const context = JSON.parse(form.get('context'));
    assert.deepEqual(context.files, { name: ATTACHMENT_NAME, type: 'text/plain' });
    assert.equal(context.attachment, undefined);
  });
});

test('submitFeedback：平台报错时把文案带出来；429 单独说太频繁', async () => {
  await withFetch(fakeFetch({ error: '内容不能为空' }, 400), async () => {
    await assert.rejects(() => submitFeedback(depsFor([]), 'x'), /内容不能为空/);
  });
  await withFetch(fakeFetch({}, 429), async () => {
    await assert.rejects(() => submitFeedback(depsFor([]), 'x'), /太频繁/);
  });
});

test('工具：说明不再要求查明根因、改为现象/已查/不确定；缺 content 与超长都拒', async () => {
  let registered = null;
  const ctx = { tools: { register: (tool) => { registered = tool; } } };
  registerFeedbackTool(ctx, depsFor([]));
  assert.equal(registered.name, 'dsh_feedback');
  assert.deepEqual([...registered.parameters.properties.action.enum].sort(), ['channels', 'read', 'submit']);
  assert.match(registered.description, /distribution platform/);
  assert.match(registered.description, new RegExp(GITHUB_REPO));
  assert.match(registered.description, /Use `read` with the thread key/);
  assert.match(registered.description, /`submit` with the same threadKey/);
  assert.match(registered.description, /not written into the in-app feedback list/);
  assert.match(registered.description, /what you observed, what you already checked, and what is still uncertain/);
  assert.match(registered.description, /No paired phone is required/);
  assert.doesNotMatch(registered.description, /Only submit after you have actually found the cause/);
  assert.match(registered.parameters.properties.content.description, /A confirmed root cause is not required/);

  const channels = await registered.execute({ action: 'channels' });
  assert.equal(channels.action, 'channels');
  assert.equal(channels.channels.length, 2);
  assert.match(registered.output.render({}, channels)[0].text, /两条反馈途径/);

  const fake = fakeFetch({ data: { thread_key: 'tk-1' } });
  await withFetch(fake, async () => {
    // 即使凭据库里一台设备都没有，submit 也照常发出去。
    const submitted = await registered.execute({ action: 'submit', content: '只看到现象，原因未明' });
    assert.equal(submitted.submitted, true);
    assert.equal(submitted.threadKey, 'tk-1');
    assert.match(submitted.message, /tk-1/);
  });
  assert.equal(fake.calls.length, 1);

  const thread = { thread_key: 'tk-read', status: 'closed', messages: [{ id: 7, author: 'staff', content: '请补充系统版本', created_at: '2026-11-21', attachments: [] }] };
  const read = fakeFetch({ data: thread });
  await withFetch(read, async () => {
    const viewed = await registered.execute({ action: 'read', threadKey: 'tk-read' });
    assert.equal(viewed.threadKey, 'tk-read');
    assert.equal(viewed.thread.status, 'closed');
    assert.equal(viewed.thread.messages[0].content, '请补充系统版本');
    assert.match(registered.output.render({}, viewed)[0].text, /官方.*请补充系统版本/);
  });
  assert.equal(read.calls[0].url, `${PLATFORM_ORIGIN}${FEEDBACK_PATH}?thread_key=tk-read`);
  const reply = fakeFetch({ data: { thread_key: 'tk-read' } });
  await withFetch(reply, async () => {
    await registered.execute({ action: 'submit', content: 'Windows 11', threadKey: 'tk-read' });
  });
  assert.equal(reply.calls[0].body.get('thread_key'), 'tk-read');
  await assert.rejects(() => registered.execute({ action: 'read' }), /需要 threadKey/);
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

test('就地反馈源码：IssueMark 附件走 files、context 不留 attachment 键，提交号成功后清除', () => {
  const source = fs.readFileSync(path.join(ROOT, 'React', 'src', 'components', 'IssueMark.tsx'), 'utf8');
  assert.match(source, /form\.append\('files',\s*new Blob\(\[draft\.detail\]/);
  assert.doesNotMatch(source, /form\.append\('attachment'/);
  assert.doesNotMatch(source, /attachment:\s*\{\s*name:\s*ATTACHMENT_NAME/);
  assert.match(source, /if \(!submissionIds\.has\(text\)\) submissionIds\.set\(text, randomId\(\)\)/);
  assert.match(source, /if \(!threadKey\) throw new Error\(t\('panel\.feedback\.noKey'\)\)[\s\S]{0,300}?submissionIds\.delete\(draft\.summary\)/);
});

test('client.js 源码：成功后清 submission_id、失败保留，附件只拼安全字段', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');
  assert.match(source, /if \(!feedbackSubmissionIds\.has\(text\)\) feedbackSubmissionIds\.set\(text, feedbackRandomId\(\)\);/);
  assert.match(source, /if \(!threadKey\) throw new Error\('反馈接口没有返回线程编号'\);[\s\S]{0,400}?feedbackSubmissionIds\.delete\(summary\);/);

  const start = source.indexOf('function feedbackDiagnosisText(');
  const end = source.indexOf('async function submitIssueFeedback(', start);
  assert.ok(start >= 0 && end > start, '找不到就地反馈的诊断文本拼装');
  const safeText = source.slice(start, end);
  for (const field of ['source', 'component_id', 'component_version', 'stage', 'code', 'scope']) {
    assert.match(safeText, new RegExp(field), `安全字段 ${field} 丢了`);
  }
  assert.doesNotMatch(safeText, /host_last_error|panel_url|user_agent|navigator|lastError|snapshot\.url/);
  assert.doesNotMatch(source, /diagnosis:\s*copyTextOf\(\)/);
  assert.doesNotMatch(source, /facts:\s*facts\(\)\.map/);
  // 「复制诊断信息」那条老出口照旧给全文，不受附件脱敏影响。
  assert.match(source, /const ok = await copyDiagnosisText\(document, copyTextOf\(\)\);/);
});

test('Onboarding 源码：常驻直连/中转失败有反馈入口，三处反馈各记各的状态', () => {
  const source = fs.readFileSync(path.join(ROOT, 'React', 'src', 'Onboarding.tsx'), 'utf8');
  assert.match(source, /const statusFailure = status !== null/);
  assert.match(source, /<AlertDescription>\{statusFailure\.message\}<\/AlertDescription>\s*\{feedbackAction\('status',/);
  assert.equal((source.match(/feedbackAction\('/g) || []).length, 3, '三处错误都要有反馈入口');
  assert.match(source, /useState<Record<string, boolean>>\(\{\}\)/);
  assert.doesNotMatch(source, /setFeedbackKey\(|setFeedbackError\(/);
});

// 用途：插件反馈的统一提交口——AI 工具与就地入口共用字段、身份与诊断附件，无手机也能提交。
'use strict';

/**
 * 给模型的「反馈」能力：用户遇到问题时，AI 描述现象、已检查什么、还有哪些不确定，
 * 直接把反馈提交到分发平台；不需要先查明根因，也不需要用户回 App 手填。
 *
 * ## 两条途径
 *
 *  - **分发平台**：公开反馈接口（`/api/sdk/feedback`）。明确指定设备号时带上那台手机的
 *    身份；没指定时用这台电脑上的插件安装身份；没配手机时依然能交，受影响手机那几格留空。
 *    诊断文本作为 text/plain 附件一起发。官方回复在维护者反馈队列里跟进（`npm run feedback`），
 *    这条先留在本机，不会写进 App 的反馈列表，线程 key 当场回显给用户复制。
 *  - **GitHub**：插件代码本身的 bug 可以直接提 PR。这条路依赖用户自己登录 GitHub，
 *    插件无法代提，所以只把仓库与前提写进说明，由 AI 自己判断走不走。
 *
 * ## 身份从哪来
 *
 * 手机身份来自凭据库里每条请求写回的活动记录（机型 / 平台 / 系统版本 / App 版本 / 包名 /
 * 构建号 / 渠道）。未指定设备时用 `instanceId()`——它是落盘在 relay.json 里的 128 位随机
 * 安装 id，不是硬件指纹。这里不读密钥、不读会话内容、不伪造安卓 / iOS / extension 身份。
 */

const { randomUUID } = require('node:crypto');
const { version: COMPONENT_VERSION } = require('../../package.json');

const PLATFORM_ORIGIN = 'https://app.wnluo.com';
const FEEDBACK_PATH = '/api/sdk/feedback';
const GITHUB_REPO = 'https://github.com/WNLUO/dsh-mobile-plugin';

/** 新 multipart 字段：提交端恒为插件，产品号固定。 */
const PRODUCT_SLUG = 'dsh-mobile';
const SOURCE = 'plugin';
const COMPONENT_ID = 'dsh-mobile-plugin';
const ATTACHMENT_NAME = 'diagnosis.txt';

/** 与平台侧对齐的正文上限（App 的反馈页也是这个数）。 */
const CONTENT_MAX = 4000;
/** 带一份小文本附件，30 秒足够。 */
const SUBMIT_TIMEOUT_MS = 30_000;
/** 明确指定设备、但包名读不到时的兜底；没有设备时这一格留空。 */
const DEFAULT_PACKAGE_ID = 'com.dsh.mobile';

/** 同一份内容重试复用同一个 submission_id；键就是内容与线程，不另造哈希。 */
const submissionIds = new Map();

function submissionKeyOf(content, threadKey) {
  return `${content}\n${threadKey || ''}`;
}

/** 同一条反馈重试时沿用第一次的 submission_id。 */
function submissionIdFor(content, threadKey) {
  const key = submissionKeyOf(content, threadKey);
  if (!submissionIds.has(key)) submissionIds.set(key, randomUUID());
  return submissionIds.get(key);
}

/** 提交成功后清掉：同内容下次提交是新反馈，不能被平台当成重试返回旧线程。 */
function forgetSubmissionId(content, threadKey) {
  submissionIds.delete(submissionKeyOf(content, threadKey));
}

function feedbackChannels() {
  return [
    {
      kind: 'distribution',
      name: 'APP 分发系统反馈',
      description: '提交到分发平台的公开反馈接口（与 App 里的反馈页同一个）。没配手机也能提交：指定设备号才带那台手机的身份，否则用这台电脑的插件安装身份；诊断文本作 text/plain 附件。官方回复在维护者反馈队列里跟进（npm run feedback 查看），这条先留在本机，不会写进 App 的反馈列表，提交后当场给出可复制的线程 key。',
      endpoint: `${PLATFORM_ORIGIN}${FEEDBACK_PATH}`,
      requiresLogin: false,
    },
    {
      kind: 'github',
      name: 'GitHub PR',
      description: '如果确定是插件代码本身的 bug，可以在公开仓库提交 PR 或 issue；这条路需要用户已登录 GitHub，插件不代提交。',
      repo: GITHUB_REPO,
      requiresLogin: true,
    },
  ];
}

/**
 * 只认「明确指定的那台」：给了 deviceId 就按它找，找不到就当没有设备身份可用；
 * 没给时**不默认选最近一台**，交给调用方用提交端安装身份。没有设备不报错。
 */
function pickDevice(devices, deviceId) {
  const list = Array.isArray(devices) ? devices : [];
  const wanted = typeof deviceId === 'string' ? deviceId.trim() : '';
  if (!wanted) return null;
  return list.find((device) => device && device.deviceId === wanted) || null;
}

/** 本地安装身份：relay.json 里落盘的随机实例号，不是硬件指纹。 */
function localDeviceId(deps) {
  const value = typeof deps && typeof deps.instanceId === 'function' ? deps.instanceId() : '';
  return typeof value === 'string' && value.trim() ? value.trim() : randomUUID();
}

/** 附件里只有插件自己能拿到的诊断字样，不含凭据、密钥或会话内容。 */
function diagnosisTextOf({ deviceSource, deviceId, submissionId }) {
  return [
    'dsh-mobile-plugin feedback',
    `source=${SOURCE}`,
    `component_id=${COMPONENT_ID}`,
    `component_version=${COMPONENT_VERSION}`,
    `device_source=${deviceSource}`,
    `device_id=${deviceId}`,
    `submission_id=${submissionId}`,
  ].join('\n');
}

/**
 * 拼提交给分发平台的表单。字段名与 App 的反馈页逐字对齐（`app/src/services/feedback.ts`
 * 的 `feedbackForm`），另加插件侧的新字段：`source` / `product_slug` / `component_*` /
 * `submission_id` / `context`，以及一份 text/plain 诊断附件。
 *
 * 没有设备时受影响手机的几格留空，device_id 用本机安装身份，绝不编一个平台或机型出来。
 */
function buildFeedbackForm(device, content, threadKey, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const localId = String(opts.localDeviceId || '');
  const deviceSource = device ? 'paired' : (localId ? 'install' : 'local');
  const deviceId = device ? (device.deviceId || localId) : localId;
  const componentVersion = String(opts.componentVersion || COMPONENT_VERSION);
  const submissionId = String(opts.submissionId || randomUUID());
  const form = new FormData();

  form.append('package_id', device ? (device.packageId || DEFAULT_PACKAGE_ID) : '');
  form.append('platform', device ? (device.platform || '') : '');
  form.append('version_name', device ? (device.appVersion || '') : '');
  form.append('build_number', device ? (device.buildNumber || '') : '');
  form.append('model', device ? (device.model || '') : '');
  form.append('system_version', device ? (device.osVersion || '') : '');
  form.append('channel', device ? (device.channel || '') : '');
  form.append('device_id', deviceId);
  form.append('content', content);
  const key = typeof threadKey === 'string' ? threadKey.trim() : '';
  if (key) form.append('thread_key', key);

  form.append('product_slug', PRODUCT_SLUG);
  form.append('source', SOURCE);
  form.append('component_id', COMPONENT_ID);
  form.append('component_version', componentVersion);
  form.append('submission_id', submissionId);
  const context = {
    product_slug: PRODUCT_SLUG,
    source: SOURCE,
    component_id: COMPONENT_ID,
    component_version: componentVersion,
    device_source: deviceSource,
    files: opts.diagnosis ? { name: ATTACHMENT_NAME, type: 'text/plain' } : null,
    ...(opts.context && typeof opts.context === 'object' ? opts.context : {}),
  };
  form.append('context', JSON.stringify(context));
  if (opts.diagnosis) {
    form.append('files', new Blob([String(opts.diagnosis)], { type: 'text/plain' }), ATTACHMENT_NAME);
  }
  return form;
}

/** 发 multipart 到分发平台。返回平台给的线程对象（含 `thread_key`）。 */
async function postMultipart(form) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
  try {
    const response = await fetch(`${PLATFORM_ORIGIN}${FEEDBACK_PATH}`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (response.status >= 200 && response.status < 300) {
      const data = body && typeof body === 'object' ? body.data : null;
      if (data && typeof data === 'object') return data;
      throw new Error('反馈接口没有返回线程信息');
    }
    const text = body && typeof body === 'object' && typeof body.error === 'string'
      ? body.error.trim()
      : '';
    if (text) throw new Error(text);
    if (response.status === 429) throw new Error('反馈提交太频繁，稍后再试');
    throw new Error(`反馈提交失败（HTTP ${response.status}）`);
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('反馈提交超时，网络可能不通');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 提交一次：选身份 → 拼表单与诊断附件 → 发给平台 → 把线程 key 与结论还给调用方。
 *
 * `options` 可带 `submissionId`（重试时复用）、`diagnosis`（诊断文本）、`context`（诊断摘要）、
 * `componentVersion`（就地入口从宿主读到的版本）。
 */
async function submitFeedback(deps, content, threadKey, deviceId, options = {}) {
  const id = typeof deps && typeof deps.instanceId === 'function' ? deps.instanceId() : '';
  const devices = deps && deps.credentials && typeof deps.credentials.listDevices === 'function'
    ? deps.credentials.listDevices(id)
    : [];
  const device = pickDevice(devices, deviceId);
  const localId = localDeviceId(deps);
  const opts = options && typeof options === 'object' ? options : {};
  const submissionId = String(opts.submissionId || submissionIdFor(content, threadKey));
  const deviceSource = device ? 'paired' : (localId ? 'install' : 'local');
  const diagnosis = String(opts.diagnosis || diagnosisTextOf({ deviceSource, deviceId: device ? device.deviceId : localId, submissionId }));
  const form = buildFeedbackForm(device, content, threadKey, {
    localDeviceId: localId,
    submissionId,
    diagnosis,
    componentVersion: opts.componentVersion,
    context: opts.context,
  });
  const thread = await postMultipart(form);
  const key = typeof thread.thread_key === 'string' ? thread.thread_key : '';
  // 平台已收下这条：清掉缓存，避免同内容下一次提交被当成重试拿到旧线程。
  // postMultipart 抛错时到不了这里，失败重试仍沿用原来的 submission_id。
  forgetSubmissionId(content, threadKey);
  return {
    threadKey: key,
    submissionId,
    message: key
      ? `已提交到分发平台，反馈编号 ${key}。请复制编号留档；这条先留在本机，不会写进 App 的反馈列表。`
      : '已提交到分发平台。',
  };
}

/** 工具注册。`deps` 给这次装配的凭据库与实例号取值器。 */
function registerFeedbackTool(ctx, deps) {
  const { defineTool } = require('@deepseek-ai/dsh-tools');
  if (!deps || !deps.credentials || typeof deps.instanceId !== 'function') {
    throw new Error('反馈工具缺少凭据库或实例号取值器');
  }
  const channels = feedbackChannels();
  ctx.tools.register(defineTool({
    name: 'dsh_feedback',
    description: 'Report a real problem with this mobile plugin or the AI-HUB app. '
      + 'Feedback routes: (1) the APP distribution platform — `submit` sends the content to it. You do NOT need to find the root cause: describe what you observed, what you already checked, and what is still uncertain. No paired phone is required either; without an explicitly chosen device the plugin submits under its local installation identity, with a text/plain diagnostics attachment and a thread key you can show to the user. Official replies are followed up in the maintainer feedback queue (run `npm run feedback`); the feedback stays local first and is not written into the in-app feedback list. '
      + '(2) GitHub — code-level bugs can go to https://github.com/WNLUO/dsh-mobile-plugin as a pull request or issue, but that needs the user to be logged into GitHub and is not submitted by this tool. '
      + 'Use `channels` to list both routes.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['channels', 'submit'],
        description: 'channels: list the feedback routes. submit: send the content to the distribution platform.',
      },
      content: {
        type: 'string',
        description: 'Feedback text for submit: the observed symptom, what you checked, and what remains uncertain. A confirmed root cause is not required. Required for submit (max 4000 chars).',
      },
      threadKey: {
        type: 'string',
        description: 'Optional for submit: append to an existing feedback thread instead of opening a new one.',
      },
      deviceId: {
        type: 'string',
        description: 'Optional for submit: a paired device whose identity should be attached. Omit to submit under this plugin installation; a phone is not required.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          channels: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
                endpoint: { type: 'string' },
                repo: { type: 'string' },
                requiresLogin: { type: 'boolean' },
              },
            },
          },
          submitted: { type: 'boolean' },
          threadKey: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSummary(value) }],
    },
    execute: async (args) => {
      switch (args.action) {
        case 'channels':
          return { action: 'channels', channels };
        case 'submit': {
          const content = typeof args.content === 'string' ? args.content.trim() : '';
          if (!content) throw new Error('submit 需要 content');
          if (content.length > CONTENT_MAX) throw new Error(`content 超长（上限 ${CONTENT_MAX} 字）`);
          const submitted = await submitFeedback(deps, content, args.threadKey, args.deviceId);
          return { action: 'submit', submitted: true, threadKey: submitted.threadKey, message: submitted.message };
        }
        default:
          throw new Error(`未知的 action：${args.action}`);
      }
    },
  }));
}

function renderSummary(value) {
  switch (value.action) {
    case 'channels': {
      const names = (value.channels || []).map((channel) => channel.name).join('、');
      return `两条反馈途径：${names || '（空）'}`;
    }
    case 'submit':
      return value.message || '已提交反馈。';
    default:
      return '完成。';
  }
}

/** 装配层入口：挂 `dsh_feedback` 工具；没有 tools 注入时只少这个工具。 */
function installFeedback(ctx, deps) {
  try {
    registerFeedbackTool(ctx, deps);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (!message.includes('without inject')) throw error;
  }
}

module.exports = {
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
  diagnosisTextOf,
  feedbackChannels,
  installFeedback,
  localDeviceId,
  pickDevice,
  registerFeedbackTool,
  submissionIdFor,
  submitFeedback,
};

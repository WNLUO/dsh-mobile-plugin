'use strict';
// AI 查清问题后直接把反馈提交到分发平台；官方回复在维护者反馈队列跟进，AI 代提的不进 App 反馈列表（2026-11-20）。

/**
 * 给模型的「反馈」能力：用户在用插件 / App 时遇到问题，AI 先排查；真查出原因后，由 AI
 * 直接把反馈提交到分发平台，不用用户自己回 App 里手填。
 *
 * ## 两条途径
 *
 *  - **分发平台**：公开反馈接口，与 App 里的反馈页同一个（`/api/sdk/feedback`）。插件把
 *    当前连接的设备身份一并带上。官方回复在维护者反馈队列里跟进（`npm run feedback` 查看），
 *    这条由 AI 代提的反馈不会出现在 App 的反馈列表里。这条本模块能真的替用户提交。
 *  - **GitHub**：插件代码本身的 bug 可以直接提 PR。这条路依赖用户自己登录 GitHub，
 *    插件无法代提，所以只把仓库与前提写进说明，由 AI 自己判断走不走。
 *
 * ## 身份从哪来
 *
 * 手机的机型 / 平台 / 系统版本 / App 版本 / 包名 / 构建号 / 渠道跟着每条请求的身份头上报，
 * 宿主在鉴权通过时写回凭据记录（`lib/shared/device-headers.js` → 凭据库）。这里读最新一条
 * 活动记录里的那几格，不另开接口、也不在 App 里输任何东西。
 *
 * ## 为什么没有附件
 *
 * 反馈页能带上截图，但 AI 提交的是「查出来的问题与复现」，正文就够；附件要读手机本地文件、
 * 走 20MB 上传，是另一条路，这一版不做。
 */

const PLATFORM_ORIGIN = 'https://app.wnluo.com';
const FEEDBACK_PATH = '/api/sdk/feedback';
const GITHUB_REPO = 'https://github.com/WNLUO/dsh-mobile-plugin';

/** 与平台侧对齐的正文上限（App 的反馈页也是这个数）。 */
const CONTENT_MAX = 4000;
/** 只有文字、没有附件上传，30 秒足够。 */
const SUBMIT_TIMEOUT_MS = 30_000;
/**
 * 读不到安装包包名时的兜底：与 App 的 `buildPackageName() || PACKAGE_ID` 同一条。
 * 插件就是给这个 App 用的，所以这个常量是这台电脑上那份安装包的默认产品号。
 */
const DEFAULT_PACKAGE_ID = 'com.dsh.mobile';

/** 两条反馈途径：写进工具说明，也能被 `channels` 动作单独取出来。 */
function feedbackChannels() {
  return [
    {
      kind: 'distribution',
      name: 'APP 分发系统反馈',
      description: '提交到分发平台的公开反馈接口（与 App 里的反馈页同一个）。插件会自动带上当前连接的设备身份；官方回复在维护者反馈队列里跟进（npm run feedback 查看），这条由 AI 代提的反馈不会出现在 App 的反馈列表里。',
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
 * 选一台设备的身份来提交：给了 `deviceId` 就按它找，没给就用最近连着的那台。
 *
 * 活动清单本身已按「最近连着」排好序（凭据库的 `activeOut`），所以没指定时取第一台。
 * 指定了却找不到，照实报错 —— 不能悄悄换一台，那会把反馈挂到错误的设备上。
 */
function pickDevice(devices, deviceId) {
  const list = Array.isArray(devices) ? devices : [];
  const wanted = typeof deviceId === 'string' ? deviceId.trim() : '';
  if (wanted) {
    const found = list.find((device) => device && device.deviceId === wanted);
    if (!found) throw new Error(`找不到设备 ${wanted}（可用 \`channels\` 之后按已配对的设备号指定）`);
    return found;
  }
  if (list.length === 0) throw new Error('当前没有已连接的手机，拿不到设备身份，无法提交反馈');
  return list[0];
}

/**
 * 拼提交给分发平台的表单。字段名与 App 的反馈页逐字对齐（`app/src/services/feedback.ts`
 * 的 `feedbackForm`），这样平台那边看到的是同一种形状。
 *
 * **不填 `context`**：那是 `{runtime_version, language}`，两样只有 App 自己知道；宿主拿不到，
 * 硬编一个只会让平台看到假的运行时。版本相关信息已经由 `version_name` / `build_number` 带着。
 */
function buildFeedbackForm(device, content, threadKey) {
  const form = new FormData();
  form.append('package_id', device.packageId || DEFAULT_PACKAGE_ID);
  form.append('platform', device.platform || '');
  form.append('version_name', device.appVersion || '');
  form.append('build_number', device.buildNumber || '');
  form.append('model', device.model || '');
  form.append('system_version', device.osVersion || '');
  form.append('channel', device.channel || '');
  form.append('content', content);
  const key = typeof threadKey === 'string' ? threadKey.trim() : '';
  if (key) form.append('thread_key', key);
  form.append('device_id', device.deviceId || '');
  return form;
}

/**
 * 发 multipart 到分发平台。返回平台给的线程对象（含 `thread_key`）。
 *
 * 网络与状态码的收口与 App 的 `postMultipart` 同口径：2xx 取 `data`，其余尽量读平台回的
 * `error` 文案，429 单独说「太频繁」，超时说「超时」。
 */
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
 * 真正提交一次：读设备身份 → 拼表单 → 发给平台 → 把线程 key 与一句结论还给 AI。
 *
 * `deps` 是装配层给的 `{ credentials, instanceId }`：`instanceId` 是取值器（不是值），
 * 与本插件其它「必须传取值器」的地方同一理由 —— 重载后实例号可能变。
 */
async function submitFeedback(deps, content, threadKey, deviceId) {
  const devices = deps.credentials.listDevices(deps.instanceId());
  const device = pickDevice(devices, deviceId);
  const form = buildFeedbackForm(device, content, threadKey);
  const thread = await postMultipart(form);
  const key = typeof thread.thread_key === 'string' ? thread.thread_key : '';
  return {
    threadKey: key,
    message: key
      ? `已提交到分发平台，反馈线程 ${key}。官方回复在维护者反馈队列里跟进（npm run feedback 查看），这条由 AI 代提的反馈不会出现在 App 的反馈列表里。`
      : '已提交到分发平台。',
  };
}

/** 工具注册。`deps` 只给这次装配的凭据库与实例号取值器。 */
function registerFeedbackTool(ctx, deps) {
  const { defineTool } = require('@deepseek-ai/dsh-tools');
  if (!deps || !deps.credentials || typeof deps.instanceId !== 'function') {
    throw new Error('反馈工具缺少凭据库或实例号取值器');
  }
  const channels = feedbackChannels();
  ctx.tools.register(defineTool({
    name: 'dsh_feedback',
    description: 'Report a real problem with this mobile plugin or the AI-HUB app. '
      + 'Feedback routes: (1) the APP distribution platform — `submit` sends the content to it, and the plugin fills in the connected device identity automatically; official replies are followed up in the maintainer feedback queue (run `npm run feedback`), and this AI-submitted feedback will not appear in the in-app feedback list. '
      + '(2) GitHub — code-level bugs can go to https://github.com/WNLUO/dsh-mobile-plugin as a pull request or issue, but that needs the user to be logged into GitHub and is not submitted by this tool. '
      + 'Use `channels` to list both routes. Only submit after you have actually found the cause: describe the problem, what you checked, and the reproduction or suggested fix.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['channels', 'submit'],
        description: 'channels: list the feedback routes. submit: send the content to the distribution platform.',
      },
      content: {
        type: 'string',
        description: 'Feedback text for submit: the problem, what you found, and the reproduction or suggested fix. Required for submit (max 4000 chars).',
      },
      threadKey: {
        type: 'string',
        description: 'Optional for submit: append to an existing feedback thread instead of opening a new one.',
      },
      deviceId: {
        type: 'string',
        description: 'Optional for submit: which paired device identity to report. Omit to use the most recently connected device.',
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

/** 结果压成一句话，给模型看的那份正文。 */
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

/**
 * 装配层入口：挂 `dsh_feedback` 工具。
 *
 * 与另外几个工具同一个口径：没有 tools 注入的 profile 只少这个工具，插件其余部分照常装；
 * 缺注入时 cordis 抛的是 "without inject"。别的错误照抛，不能把真的注册失败也吞掉。
 */
function installFeedback(ctx, deps) {
  try {
    registerFeedbackTool(ctx, deps);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (!message.includes('without inject')) throw error;
  }
}

module.exports = {
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
};

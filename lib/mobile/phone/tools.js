'use strict';

/**
 * 给模型的那组手机动作。
 *
 * ## 能力面的边界
 *
 * 这里面**没有**「执行命令」。模型能说的是「看这块屏」「点第 7 个元素」「输入这段字」
 * 「往上滑一屏」「返回」「打开这个 App」，参数全是结构化字段、全部经过校验；没有任何一格
 * 能拼出一段 shell。手机侧认的动作表与这里一一对应（见 `phone/service.js` 的 `ACTIONS`），
 * 多一个动作就是两边同时扩一次能力面。
 *
 * ## 为什么每个工具都要先问一次「操作哪台手机」
 *
 * 一台电脑可以连好几台手机，而一条会话可能在任意一台手机上被打开。目标由 `phone/binding`
 * 决定（会话第一次收到谁的消息就绑谁），模型的参数里**没有** deviceId —— 它不该、也没法
 * 自己挑一台机器。要换，就走 `phone_target`：那是显式的、用户看得见的一次改绑。
 *
 * ## 报错口径
 *
 * 目标不存在、那台手机断开、动作超时，都抛成工具失败 —— 消息写得像人话，模型据此改主意
 * 或者问用户，而不是重试同一发。**绝不**在目标不可用时偷偷换一台在线的顶上。
 */

const binding = require('./binding.js');

/** 元素的短标签：模型看到的是「第几个」，不是像素坐标。 */
const MAX_TEXT = 120;

function textOf(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * 这些工具都要拿到「这条会话绑在哪台手机上」，拿不到就抛一句能照做的话。
 *
 * @returns {{deviceId: string, service: object}}
 */
function targetOf(ctx, deps, sessionId) {
  const { deviceId, from } = binding.resolveTarget(sessionId);
  if (!deviceId) {
    throw new Error('这条对话还没有指定要操作哪台手机：让用户在这台手机上发一句话，或者用 phone_target 选定一台。');
  }
  const service = deps.getService();
  if (!service) throw new Error('手机操作服务没在运行（插件刚启动或已停用），先让用户重新连一次。');
  if (!service.isOnline(deviceId)) {
    const label = deps.describeDevice ? deps.describeDevice(deviceId) : deviceId;
    throw new Error(`要操作的那台手机（${label}）现在没连上。让用户在手机上打开 App 让连接恢复，或者用 phone_target 换一台。`);
  }
  return { deviceId, from, service };
}

/** 把服务层的失败翻译成一句能给模型看的话。 */
async function run(service, deviceId, sessionId, action, args, signal) {
  try {
    const { data } = await service.call(deviceId, sessionId, action, args, { signal });
    return data === undefined ? null : data;
  } catch (error) {
    const code = error && error.code ? error.code : 'failed';
    const message = error && error.message ? error.message : '手机那边没能完成这一步';
    if (code === 'offline') throw new Error('那台手机在这期间断开了连接，这一步没有做。');
    if (code === 'timeout') throw new Error(`那台手机 ${message}。可以再试一次，或者先 phone_screen 看看它现在停在哪。`);
    if (code === 'unsupported') throw new Error(`那台手机上装的 App 版本还不支持 ${action}，需要把手机上的 App 升级到最新。`);
    if (code === 'aborted') throw new Error('这一步被取消了。');
    throw new Error(message);
  }
}

/** 一句话总结「现在屏上是什么」，给工具结果用。 */
function summarizeScreen(data) {
  if (!data || typeof data !== 'object') return '没有读到屏幕内容。';
  const parts = [];
  if (data.packageName) parts.push(`当前 App：${data.packageName}`);
  if (data.activity) parts.push(`页面：${data.activity}`);
  const count = Array.isArray(data.elements) ? data.elements.length : 0;
  parts.push(`可见元素 ${count} 个`);
  return parts.join('；');
}

/**
 * 注册这组工具。缺 `tools` 注入的 profile（比如纯手机端宿主）静默跳过 —— 与
 * `installExtensions` 同一口径，别把整块装配掀掉。
 */
function installPhoneTools(ctx, deps) {
  let defineTool;
  try {
    ({ defineTool } = require('@deepseek-ai/dsh-tools'));
  } catch {
    return;
  }

  const register = (tool) => ctx.tools.register(defineTool(tool));

  /** 所有工具都要的那一步：从执行上下文里认出这条会话。 */
  const sessionOf = (exec) => {
    const id = exec && exec.agent && exec.agent.session && exec.agent.session.id;
    return typeof id === 'string' ? id : '';
  };

  /**
   * 拼出一句「这一轮来自谁、绑着谁」的提醒。
   *
   * 只在两者不一致时才说 —— 每一轮都说一遍等于噪音，模型很快就会学会忽略它。
   */
  const mentionMismatch = (sessionId, bound) => {
    const sender = binding.lastSenderOf(sessionId);
    if (!sender || !bound || sender === bound) return '';
    const boundLabel = deps.describeDevice ? deps.describeDevice(bound) : bound;
    const senderLabel = deps.describeDevice ? deps.describeDevice(sender) : sender;
    return `（提醒：这条对话绑的是 ${boundLabel}，而这句话是 ${senderLabel} 发来的。没让你换的话就继续操作 ${boundLabel}，别擅自改绑。）`;
  };

  register({
    name: 'phone_screen',
    description: 'Read the phone screen the agent is working on: which app is in front, and the visible elements with a short ref each. This is the structured accessibility tree, not a picture; call it before tapping so refs are fresh.',
    parameters: {
      includeText: {
        type: 'boolean',
        description: 'Include the readable text of each element. Default true; turn off for very long lists.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deviceId: { type: 'string' },
          packageName: { type: 'string' },
          activity: { type: 'string' },
          // 元素是**任意形状的界面节点**（不同 App 给的字段不一样），所以 items 必须显式允许
          // 附加字段 —— dsh-tools 的 schema 编译器不接受留空的 additionalProperties。
          elements: { type: 'array', items: { type: 'object', additionalProperties: true } },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: summarizeScreen(value) }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const data = await run(service, deviceId, sessionId, 'screen.read', {
        includeText: args.includeText !== false,
      }, exec.signal);
      const note = mentionMismatch(sessionId, deviceId);
      return {
        deviceId,
        packageName: textOf(data && data.packageName, MAX_TEXT),
        activity: textOf(data && data.activity, MAX_TEXT),
        elements: Array.isArray(data && data.elements) ? data.elements.slice(0, 200) : [],
        note,
      };
    },
  });

  register({
    name: 'phone_tap',
    description: 'Tap an element on the phone screen by its ref (from phone_screen), or by viewport-relative percentage coordinates when no ref fits. One call taps once.',
    parameters: {
      ref: { type: 'string', description: 'Element ref from the latest phone_screen, e.g. "e12".' },
      x: { type: 'number', description: 'Horizontal position in percent of the screen width (0-100). Use only without ref.' },
      y: { type: 'number', description: 'Vertical position in percent of the screen height (0-100). Use only without ref.' },
      target: { type: 'string', description: 'What you are tapping, in a few words. Required for coordinate taps so the step stays readable.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          packageName: { type: 'string' },
          // 元素是**任意形状的界面节点**（不同 App 给的字段不一样），所以 items 必须显式允许
          // 附加字段 —— dsh-tools 的 schema 编译器不接受留空的 additionalProperties。
          elements: { type: 'array', items: { type: 'object', additionalProperties: true } },
          note: { type: 'string' },
        },
      },
      render: () => [{ type: 'text', text: '已点击，界面见结果。' }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const hasRef = typeof args.ref === 'string' && args.ref.trim();
      const hasPoint = Number.isFinite(args.x) && Number.isFinite(args.y);
      if (!hasRef && !hasPoint) throw new Error('要么给 ref（phone_screen 里的元素编号），要么给 x / y 百分比。');
      if (hasRef && hasPoint) throw new Error('ref 和坐标只能给一样：有 ref 就按元素点。');
      if (!hasRef && !textOf(args.target, MAX_TEXT)) throw new Error('按坐标点的时候要说明点的是什么（target）。');
      const data = await run(service, deviceId, sessionId, 'tap', {
        ref: hasRef ? args.ref.trim() : '',
        x: hasPoint ? args.x : null,
        y: hasPoint ? args.y : null,
        target: textOf(args.target, MAX_TEXT),
      }, exec.signal);
      return {
        ok: true,
        packageName: textOf(data && data.packageName, MAX_TEXT),
        elements: Array.isArray(data && data.elements) ? data.elements.slice(0, 120) : [],
        note: mentionMismatch(sessionId, deviceId),
      };
    },
  });

  register({
    name: 'phone_type',
    description: 'Type text into an input on the phone screen. Give the input element ref from phone_screen; without it the text goes to whatever field already has focus.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to enter. Replaces the field content when ref is given.' },
      ref: { type: 'string', description: 'Input element ref from phone_screen. Omit to type into the focused field.' },
      submit: { type: 'boolean', description: 'Press Enter afterwards. Default false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          packageName: { type: 'string' },
          // 元素是**任意形状的界面节点**（不同 App 给的字段不一样），所以 items 必须显式允许
          // 附加字段 —— dsh-tools 的 schema 编译器不接受留空的 additionalProperties。
          elements: { type: 'array', items: { type: 'object', additionalProperties: true } },
          note: { type: 'string' },
        },
      },
      render: () => [{ type: 'text', text: '已输入。' }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const value = typeof args.text === 'string' ? args.text : '';
      if (!value) throw new Error('要输入的文字是空的。');
      const data = await run(service, deviceId, sessionId, 'type', {
        text: value,
        ref: typeof args.ref === 'string' ? args.ref.trim() : '',
        submit: args.submit === true,
      }, exec.signal);
      return {
        ok: true,
        packageName: textOf(data && data.packageName, MAX_TEXT),
        elements: Array.isArray(data && data.elements) ? data.elements.slice(0, 120) : [],
        note: mentionMismatch(sessionId, deviceId),
      };
    },
  });

  register({
    name: 'phone_scroll',
    description: 'Scroll the phone screen: up (content moves up, i.e. see what is below), down, left or right. Distance is a fraction of the screen.',
    parameters: {
      direction: { type: 'string', required: true, enum: ['up', 'down', 'left', 'right'], description: 'Direction the content moves.' },
      amount: { type: 'number', description: 'How far, as a fraction of the screen (0.1-1). Default 0.7.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          packageName: { type: 'string' },
          // 元素是**任意形状的界面节点**（不同 App 给的字段不一样），所以 items 必须显式允许
          // 附加字段 —— dsh-tools 的 schema 编译器不接受留空的 additionalProperties。
          elements: { type: 'array', items: { type: 'object', additionalProperties: true } },
          note: { type: 'string' },
        },
      },
      render: () => [{ type: 'text', text: '已滚动。' }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const direction = ['up', 'down', 'left', 'right'].includes(args.direction) ? args.direction : '';
      if (!direction) throw new Error('direction 只能是 up / down / left / right。');
      const amount = Number.isFinite(args.amount) ? Math.min(1, Math.max(0.1, args.amount)) : 0.7;
      const data = await run(service, deviceId, sessionId, 'swipe', { direction, amount }, exec.signal);
      return {
        ok: true,
        packageName: textOf(data && data.packageName, MAX_TEXT),
        elements: Array.isArray(data && data.elements) ? data.elements.slice(0, 120) : [],
        note: mentionMismatch(sessionId, deviceId),
      };
    },
  });

  register({
    name: 'phone_key',
    description: 'Press one system key on the phone: back, home, enter, or recents. Nothing else (no power, no volume) — those are the user\'s own buttons.',
    parameters: {
      key: { type: 'string', required: true, enum: ['back', 'home', 'enter', 'recents'], description: 'Which key to press.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          packageName: { type: 'string' },
          // 元素是**任意形状的界面节点**（不同 App 给的字段不一样），所以 items 必须显式允许
          // 附加字段 —— dsh-tools 的 schema 编译器不接受留空的 additionalProperties。
          elements: { type: 'array', items: { type: 'object', additionalProperties: true } },
          note: { type: 'string' },
        },
      },
      render: () => [{ type: 'text', text: '已按键。' }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const key = ['back', 'home', 'enter', 'recents'].includes(args.key) ? args.key : '';
      if (!key) throw new Error('key 只能是 back / home / enter / recents。');
      const data = await run(service, deviceId, sessionId, 'key', { key }, exec.signal);
      return {
        ok: true,
        packageName: textOf(data && data.packageName, MAX_TEXT),
        elements: Array.isArray(data && data.elements) ? data.elements.slice(0, 120) : [],
        note: mentionMismatch(sessionId, deviceId),
      };
    },
  });

  register({
    name: 'phone_apps',
    description: 'List the apps installed on the phone that can be opened (label + package), optionally filtered by a keyword. Use it to find the package before phone_open_app.',
    parameters: {
      query: { type: 'string', description: 'Case-insensitive keyword matched against label or package.' },
      limit: { type: 'integer', description: 'How many to return, 1-100. Default 40.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          apps: { type: 'array', items: { type: 'object', additionalProperties: true } },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `找到 ${Array.isArray(value.apps) ? value.apps.length : 0} 个 App。` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const limit = Number.isInteger(args.limit) ? Math.min(100, Math.max(1, args.limit)) : 40;
      const data = await run(service, deviceId, sessionId, 'app.list', {
        query: textOf(args.query, 60),
        limit,
      }, exec.signal);
      return {
        apps: Array.isArray(data && data.apps) ? data.apps.slice(0, limit) : [],
        note: mentionMismatch(sessionId, deviceId),
      };
    },
  });

  register({
    name: 'phone_open_app',
    description: 'Open an app on the phone screen the agent works on. Opening happens on a background display, so the user keeps their own screen.',
    parameters: {
      packageName: { type: 'string', required: true, description: 'Android package name, e.g. "com.tencent.mm". Find it with phone_apps.' },
      fresh: { type: 'boolean', description: 'Restart the app instead of reusing its existing state. Default false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          packageName: { type: 'string' },
          // 元素是**任意形状的界面节点**（不同 App 给的字段不一样），所以 items 必须显式允许
          // 附加字段 —— dsh-tools 的 schema 编译器不接受留空的 additionalProperties。
          elements: { type: 'array', items: { type: 'object', additionalProperties: true } },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已打开 ${value.packageName || 'App'}。` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const pkg = textOf(args.packageName, 200);
      if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(pkg)) throw new Error('packageName 看起来不像安卓包名。');
      const data = await run(service, deviceId, sessionId, 'app.open', {
        packageName: pkg,
        fresh: args.fresh === true,
      }, exec.signal);
      return {
        ok: true,
        packageName: textOf(data && data.packageName, MAX_TEXT) || pkg,
        elements: Array.isArray(data && data.elements) ? data.elements.slice(0, 120) : [],
        note: mentionMismatch(sessionId, deviceId),
      };
    },
  });

  register({
    name: 'phone_target',
    description: 'Show or change which phone this conversation operates. Without arguments it reports the binding and the phones currently connected. With a deviceId it rebinds — only do that when the user asked to switch phones.',
    parameters: {
      deviceId: { type: 'string', description: 'Rebind this conversation to that phone. Omit to just look.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deviceId: { type: 'string' },
          from: { type: 'string' },
          changed: { type: 'boolean' },
          devices: { type: 'array', items: { type: 'object', additionalProperties: true } },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.deviceId ? `这条对话操作的是 ${value.deviceId}。` : '这条对话还没有指定手机。' }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const wanted = textOf(args.deviceId, 200);
      if (wanted) {
        const service = deps.getService();
        if (!service || !service.isOnline(wanted)) {
          throw new Error('那台手机现在没连上，先让用户在手机上打开 App 让连接恢复，再改绑。');
        }
      }
      const resolved = binding.resolveTarget(sessionId, wanted);
      return {
        deviceId: resolved.deviceId,
        from: resolved.from,
        changed: resolved.changed,
        devices: deps.listDevices ? deps.listDevices() : [],
        note: mentionMismatch(sessionId, resolved.deviceId),
      };
    },
  });
}

module.exports = { installPhoneTools, summarizeScreen };

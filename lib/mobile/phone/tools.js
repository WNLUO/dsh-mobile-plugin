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
    if (code === 'adb-unavailable') throw new Error('那台手机的无线调试没连上（可能被系统关了），让用户在手机上重新打开无线调试。');
    if (code === 'warming') throw new Error('手机正在准备后台屏，大约还要几秒，稍等再试。');
    if (code === 'aborted') throw new Error('这一步被取消了。');
    throw new Error(message);
  }
}

/** 一句话总结「现在屏上是什么」，给工具结果用。 */
function summarizeScreen(data) {
  if (!data || typeof data !== 'object') return '没有读到屏幕内容。';
  // 「读屏没开」必须说在前面：否则「0 个元素」会被读成「界面是空的」或「App 没起来」，
  // 模型就会反复重读、换 App 打开，越试越乱（2026-11-04 用户现场）。
  if (data.a11yDisabled) {
    return '读屏没有打开：只看到 0 个元素，不是界面空的，是我们看不见。让用户在「设置 › 权限 › 操作手机」里点「去打开」（现在点一下就开，不用去系统设置翻），然后重新读。';
  }
  const parts = [];
  if (data.packageName) parts.push(`当前 App：${data.packageName}`);
  if (data.activity) parts.push(`页面：${data.activity}`);
  const count = Array.isArray(data.elements) ? data.elements.length : 0;
  parts.push(`可见元素 ${count} 个`);
  if (data.treeUnreadable) parts.push('没读到应用窗口（可能是自绘界面），坐标只能看截图');
  return parts.join('；');
}

/**
 * 注册这组工具。缺 `tools` 注入的 profile（比如纯手机端宿主）静默跳过 —— 与
 * `installExtensions` 同一口径，别把整块装配掀掉。
 *
 * **必须走 `ctx.inject(['tools'], …)`，不能直接 `ctx.tools.register`**：宿主里 `tools` 是
 * 子代理作用域提供的服务，插件这一层直接读 `ctx.tools` 拿到的是 undefined（或者一个没有
 * `register` 的影子对象），`register` 一调就抛，被下面那句容错吞掉 —— 现象是八个工具**一条
 * 都没交到模型手上**，而模型只知道能用 `bash` 去敲 adb，于是它去截了电脑上连着的另一台设备。
 * 同树的 `dsh-free-search` 也是这么写的（`ctx.inject(['tools'], (sctx) => …)`）。
 */
function installPhoneTools(ctx, deps) {
  let defineTool;
  try {
    ({ defineTool } = require('@deepseek-ai/dsh-tools'));
  } catch {
    return;
  }

  const build = (scoped) => {
  const register = (tool) => scoped.tools.register(defineTool(tool));

  /**
   * 宿主的附件库：截图要交给它存，编号才是宿主认得的那种（见 `phone_screenshot` 的说明）。
   *
   * 取用放在执行时、不在注册时：`attachments` 是宿主后装的，注册这一趟它可能还不在。先问
   * 注入作用域、再问外层 —— 与 `schedule.js` 同一个口径（那边也是执行时 `ctx.get`）。
   */
  const attachmentsOf = () => {
    for (const source of [scoped, ctx]) {
      if (!source || typeof source.get !== 'function') continue;
      let store = null;
      try { store = source.get('attachments'); } catch { store = null; }
      if (store && typeof store.saveImage === 'function') return store;
    }
    return null;
  };

  /**
   * 所有工具都要的那一步：从执行上下文里认出这条会话。
   *
   * `exec.agent.id` 就是会话 id（本仓 `dsh-codex-subscription` 也这么取）。**别写成
   * `exec.agent.session.id`**：那一格不存在，取出来恒为空串，于是每个工具都以为「这条对话
   * 还没绑手机」，绑定账也永远写着另一个键 —— 症状是「明明绑过，它还是说没有目标」。
   */
  const sessionOf = (exec) => {
    const id = exec && exec.agent && exec.agent.id;
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
          // 无障碍没开时这一格为真：说清楚「是我们看不见」而不是「界面是空的」。
          a11yDisabled: { type: 'boolean' },
          treeUnreadable: { type: 'boolean' },
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
      // 这两个开关**只在这两件事真的成立时才有键**：宿主不允许工具结果里出现值为 undefined
      // 的字段（整条结果会被判成不是合法 JSON，模型看到的是「读屏坏了」），所以按「有值才塞」
      // 的写法构造，而不是摆一个 undefined 占位。
      const value = {
        deviceId,
        packageName: textOf(data && data.packageName, MAX_TEXT),
        activity: textOf(data && data.activity, MAX_TEXT),
        elements: Array.isArray(data && data.elements) ? data.elements.slice(0, 200) : [],
        note,
      };
      if (data && data.a11yDisabled === true) value.a11yDisabled = true;
      if (data && data.treeUnreadable === true) value.treeUnreadable = true;
      return value;
    },
  });

  /**
   * 截一张后台屏的画面。
   *
   * **为什么要有它**：读屏拿到的是界面树（文字、控件、坐标），但视频、画布、游戏、部分网页
   * 根本没有可读的节点 —— 那时候模型只能瞎猜。实测（2026-11-04）：让它去抖音里看内容，
   * 它连标题都读不到，因为整屏都是自绘的画面。截图这条能力一直在手机侧（读屏读不到时兜底
   * 用的就是它），只是没交到模型手上。
   *
   * 图必须存进**宿主**的附件库：工具结果里的图片引用会随会话历史再发给模型，而宿主只认自己
   * 发的那种带 `sha256:` 前缀的编号。2026-11-04 真机：图存进了插件自己那份库里、编号是裸的
   * 哈希，下一轮请求整条挂掉（「附件引用无效」）。插件那份库是给手机端发图用的，两边不是一回事。
   */
  register({
    name: 'phone_screenshot',
    description: 'Take a picture of the background screen the agent is working on. Use it when the accessibility tree cannot describe what is on screen: videos, canvas, games, image galleries. Returns the picture as an image.',
    parameters: {
      target: { type: 'string', description: 'What you are looking at, in a few words.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deviceId: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          note: { type: 'string' },
          image: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => {
        const blocks = [{ type: 'text', text: `后台屏截图（${value.width}×${value.height}）` }];
        if (value.image) blocks.push(value.image);
        return blocks;
      },
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const data = await run(service, deviceId, sessionId, 'screen.screenshot', {}, exec.signal);
      const blob = data && typeof data.blob === 'string' ? data.blob : '';
      if (!blob) throw new Error('没截到画面：手机那边没有回图片。');
      const store = attachmentsOf();
      if (!store) throw new Error('宿主没有附件库，这张图存不进去。');
      let ref;
      try {
        ref = await store.saveImage({
          data: Buffer.from(blob, 'base64'),
          mediaType: data && data.format === 'jpeg' ? 'image/jpeg' : 'image/png',
          name: textOf(args.target, MAX_TEXT) || 'phone-screen',
        });
      } catch (error) {
        throw new Error(`截到的画面存不下来：${String((error && error.message) || error).slice(0, 200)}`);
      }
      // 有值才塞键：宿主不接受值为 undefined 的字段（见 A3-79 的坑）。
      const value = {
        deviceId,
        width: Number(ref.width) || 0,
        height: Number(ref.height) || 0,
        note: mentionMismatch(sessionId, deviceId),
        // 引用块按宿主自己那种形状写（`attachmentId` 带 `sha256:` 前缀、另有字节数与宽高），
        // 这一块会被原样留在历史里，下一轮请求按它取图。
        image: {
          type: 'image',
          attachment: {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name ? { name: ref.name } : {}),
          },
        },
      };
      return value;
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
  };

  // 老宿主 / 无工具注入的 profile（纯手机端宿主）：`ctx.inject` 不存在时什么也不做，
  // 别把整块装配掀掉。注册本身抛错照旧往上抛 —— 那是真的坏了，不该被当成「没有这个 profile」。
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['tools'], (scoped) => {
    if (!scoped || !scoped.tools || typeof scoped.tools.register !== 'function') return;
    build(scoped);
  });
}

module.exports = { installPhoneTools, summarizeScreen };

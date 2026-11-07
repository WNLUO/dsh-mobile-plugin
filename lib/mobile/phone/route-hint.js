'use strict';

/**
 * `phone_route_hint`：只读地翻出「这个 App 以前成功过的路线」。
 *
 * 用法是打开一个 App 之后问一句「以前有没有做成过、怎么做的」。**只给参考，不自动执行**：
 * 这里既不连手机、也不发任何动作，模型看过之后还得自己按当前屏幕重新判断。之所以只给摘要不给
 * 原始步骤，是因为界面会变，照抄旧路线比没有更危险 —— 摘要让模型看懂大意，具体每一步仍要现读屏。
 *
 * 注册形状照 `phone/tools.js` 里的那套：走 `ctx.inject(['tools'], …)` 再 `defineTool`，
 * 不能直接读 `ctx.tools`（宿主里那是个影子对象，`register` 一调就抛，被容错吞掉后一条工具都交不到
 * 模型手上）。缺 tools 注入的 profile 静默跳过，别把整块装配掀翻。
 */

const routesMemory = require('./routes-memory.js');

/** 一次最多回几条路线。 */
const MAX_ROUTES = 5;
/** 摘要里单段文字最长多少字。 */
const MAX_TEXT = 60;

/** 动作名换成一句人话动词。 */
const ACTION_VERBS = {
  tap: '点击',
  type: '输入',
  key: '按键',
  swipe: '滑动',
  gesture: '手势',
  'screen.wait': '等待',
  'screen.read': '读屏',
  'screen.screenshot': '截图',
  'app.open': '打开',
  'app.close': '关闭',
};

function clip(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return '';
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
}

/**
 * 把一步压成一句摘要。只取最有辨识度的一个参数，不要把小箭头变成一段代码。
 */
function summarizeStep(step) {
  if (!step || typeof step !== 'object') return '';
  const action = typeof step.action === 'string' ? step.action.trim() : '';
  if (!action) return '';
  const args = step.args && typeof step.args === 'object' ? step.args : {};
  const verb = ACTION_VERBS[action] || action;

  let object = '';
  if (action === 'type') {
    const text = clip(args.text);
    if (text) object = `「${text}」`;
  } else if (action === 'tap') {
    const target = clip(args.target);
    if (target) object = `「${target}」`;
    else if (typeof args.ref === 'string' && args.ref.trim()) object = args.ref.trim();
  } else if (action === 'key') {
    object = typeof args.key === 'string' ? args.key : '';
  } else if (action === 'app.open') {
    object = clip(args.packageName);
  } else if (action === 'swipe') {
    object = typeof args.direction === 'string' ? args.direction : '';
  } else {
    object = clip(args.target) || clip(args.text) || clip(args.packageName) || (typeof args.ref === 'string' ? args.ref.trim() : '');
  }
  return object ? `${verb}${object}` : verb;
}

/**
 * 把一条路线压成可读的摘要对象：步骤数、时间、整条路线的一句话。
 */
function summarizeRoute(route) {
  const steps = route && Array.isArray(route.steps) ? route.steps : [];
  const parts = steps.map(summarizeStep).filter(Boolean);
  return {
    at: route && Number.isFinite(route.at) ? route.at : 0,
    stepCount: steps.length,
    summary: parts.join(' → '),
  };
}

/** 取这个 App 最近成功的几条，压成摘要。没有记录回空数组。 */
function hintFor(packageName) {
  const routes = routesMemory.list(packageName);
  // 最近的先给：新近成功的路线更贴近现在这个版本的界面。
  return routes
    .slice()
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ROUTES)
    .map(summarizeRoute);
}

/**
 * 注册 `phone_route_hint`。与 `installPhoneTools` 同一口径：拿不到 tools 注入就静静不装。
 */
function installRouteHint(ctx) {
  if (!ctx || typeof ctx.inject !== 'function') return;
  let defineTool;
  try {
    ({ defineTool } = require('@deepseek-ai/dsh-tools'));
  } catch {
    return;
  }

  ctx.inject(['tools'], (scoped) => {
    if (!scoped || !scoped.tools || typeof scoped.tools.register !== 'function') return;
    scoped.tools.register(defineTool({
      name: 'phone_route_hint',
      description: 'Look up routes this app has succeeded with before, as short step summaries. This is reference only — nothing is executed. After opening an app, use it to recall a past successful path, then re-read the screen and decide each step yourself; the UI may have changed.',
      parameters: {
        packageName: {
          type: 'string',
          required: true,
          description: 'Android package name of the app, e.g. "com.tencent.mm".',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            packageName: { type: 'string' },
            count: { type: 'number' },
            // 一条路线是「步骤数 + 摘要」，形状固定，但为了紧凑允许附加字段。
            routes: { type: 'array', items: { type: 'object', additionalProperties: true } },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const count = Array.isArray(value.routes) ? value.routes.length : 0;
          const lines = [`这个 App 以前成功过 ${count} 条路线（仅供参考，不会自动执行）：`];
          for (const route of value.routes || []) lines.push(`- ${route.summary}`);
          if (!count) lines.push('- 还没有记录。');
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      execute: async (args) => {
        const pkg = typeof args.packageName === 'string' ? args.packageName.trim() : '';
        if (!pkg) throw new Error('要给一个包名（例如 com.tencent.mm）才能查历史路线。');
        const routes = hintFor(pkg);
        const value = {
          ok: true,
          packageName: pkg,
          count: routes.length,
          routes,
        };
        if (routes.length === 0) value.note = '这个 App 还没有成功过的路线记录。';
        return value;
      },
    }));
  });
}

module.exports = {
  installRouteHint,
  summarizeStep,
  summarizeRoute,
  hintFor,
  MAX_ROUTES,
};

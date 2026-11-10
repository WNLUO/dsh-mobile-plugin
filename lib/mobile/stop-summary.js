'use strict';

/**
 * 用户按停止后补在对话里的那份「本轮交代」：从**一次运行的步骤流**折成 App 侧
 * `StopSummaryView` 那个形状（做了什么 / 看到了什么 / 没做完的部分 / 对外发出几次）。
 *
 * 为什么是纯函数、不调模型：停止那一刻要立刻给用户一句看得懂的话，不该再等一次模型往返。
 * 输入复用直播清单与历史清单同一份形状（`live-steps.js` 的 `liveStepsOf` 与
 * `history-derive.js` 的 `turnProcess.steps` 都是 `{ key, step }`，`step` 带
 * `kind` / `name` / `summary` / `state`），所以两条数据源都能直接喂进来。
 *
 * 信息量口径：只陈述**能从那一步本身读到的东西**。状态只认步骤自己的 `state`
 * （`ok` / `error` / `stopped`，缺省即「还在跑」），读不到就不写那一句 —— 宁可少写一行，
 * 也不要把「已发出」写在一次其实失败了的动作上。「对外发出几次」同理：只认步骤上显式的
 * `outward` / `irreversible` 标记，不按工具名或文案猜。
 */

/** 交代里每一段的条数上限：行再多也看不完，白占篇幅。 */
const MAX_DONE = 12;
const MAX_SEEN = 8;
const MAX_UNFINISHED = 12;

/** 单条摘要的字数上限。 */
const CLIP = 80;

/** 读类工具：这一步是「看到了什么」，不是「做了什么改动」。 */
const READ_TOOLS = new Set([
  'read', 'read_image', 'web_fetch', 'web_search', 'grep', 'glob',
]);

/** 思考步不是「做的事」，但可以是「最后想到哪 / 写了一半的字」。 */
function isThink(step) {
  return step && step.kind === 'think';
}

/** 把一个清单条目摊成裸 step：`{ key, step }` 去掉壳，裸 step 原样返回。 */
function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return {};
  return entry.step && typeof entry.step === 'object'
    ? { key: entry.key, ...entry.step }
    : entry;
}

/** 摊平步骤数组：认 `{ steps: [...] }` 与裸数组两种形状。 */
function toStepList(run) {
  const list = Array.isArray(run)
    ? run
    : (run && typeof run === 'object' && Array.isArray(run.steps) ? run.steps : null);
  return list ? list.map(normalizeEntry) : [];
}

function clip(text, max = CLIP) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/** 这一步行给人看的标签：优先现成摘要，没有就从参数里挑一个最像「这一步是干嘛的」字段。 */
function labelOf(step) {
  if (!step || typeof step !== 'object') return '';
  if (typeof step.summary === 'string' && step.summary.trim() !== '') return clip(step.summary);
  const args = step.args && typeof step.args === 'object' ? step.args : {};
  const candidates = ['target', 'text', 'description', 'query', 'command', 'file_path', 'path', 'ref', 'url'];
  for (const key of candidates) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return clip(value);
  }
  return clip(step.name || step.kind || '');
}

/** 一步的状态归成三种：成功 / 没用成 / 还在跑（读不到就是还在跑）。 */
function stateOf(step) {
  const state = step && typeof step.state === 'string' ? step.state : '';
  if (state === 'ok') return 'ok';
  if (state === 'error') return 'error';
  if (state === 'stopped') return 'stopped';
  return 'running';
}

/** 这一步有没有显式标成「对外发出」（发送 / 提交 / 下单这类收不回来的动作）。 */
function outwardOf(step) {
  if (!step || typeof step !== 'object') return false;
  return step.outward === true || step.irreversible === true
    || (typeof step.outward === 'string' && step.outward !== '');
}

/**
 * 从一次运行生成交代。
 *
 * @param {object|Array} run 步骤流（`{ steps: [{key, step}] }` 或裸数组）。
 * @returns {{did: string[], saw: string[], outboundCount?: number, unfinished?: string[], closing?: string}}
 */
function summarize(run) {
  const steps = toStepList(run);
  const did = [];
  const seen = [];
  const unfinished = [];
  let outboundCount = 0;
  let closing = '';

  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const label = labelOf(step);
    const state = stateOf(step);

    if (isThink(step)) {
      // 思考步不进「做了什么」；只记最后一段有内容的思考。
      if (label) closing = label;
      continue;
    }
    if (!step.name && !label) continue;

    if (state !== 'ok') {
      unfinished.push(label || String(step.name || '一步动作'));
      continue;
    }

    if (READ_TOOLS.has(step.name)) {
      if (label) seen.push(label);
    } else if (label) {
      did.push(label);
    }
    if (outwardOf(step)) outboundCount += 1;
  }

  const view = {
    did: did.slice(-MAX_DONE),
    saw: seen.slice(-MAX_SEEN),
  };
  if (outboundCount > 0) view.outboundCount = outboundCount;
  if (unfinished.length > 0) view.unfinished = unfinished.slice(0, MAX_UNFINISHED);
  if (closing) view.closing = closing;
  return view;
}

module.exports = {
  summarize,
  // 给守卫与接线方直接用的纯函数：
  toStepList,
  labelOf,
  stateOf,
  outwardOf,
  MAX_DONE,
  MAX_SEEN,
  MAX_UNFINISHED,
};

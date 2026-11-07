'use strict';

/**
 * 停止后的一份交代，以及「继续」从哪一步接着做。
 *
 * 用户点停止后，这一轮不该只剩「已停止」三个字。这里从**一次运行的步骤流**折出几句话：
 * 做了什么、看到了什么、对外发了几次、哪些没做完，再给一个可续跑的锚点（哪一步还没成功）。
 * 输入复用直播清单 / 历史清单那一份的形状（`live-steps.js` 的 `liveStepsOf` 与
 * `history-derive.js` 的 `turnProcess.steps` 都是 `{ key, step }`，`step` 里带
 * `kind` / `name` / `summary` / `state`）。
 *
 * 纯函数、确定性、不调模型：停止时要马上给用户一句看得懂的话，不该再等一次模型往返。
 * 需要模型润色时由接线方另请一次，并把这里的结果当上下文；模型失败/超时就用这里的 `line`。
 *
 * 信息量口径：只陈述**能从那一步本身读到的东西**，不猜模型的意图；读不到的一律不编
 * （宁可少写一句，也不要把「已发送」写在一段其实失败了的动作上）。
 */

const irreversible = require('./irreversible.js');

/** 交代里每一段的条数上限：一行省略，再多也看不完，白占篇幅。 */
const MAX_DONE = 12;
const MAX_SEEN = 8;
const MAX_UNFINISHED = 12;

/** 单条摘要的字数上限。 */
const CLIP = 80;

/** 读类工具：这一步是「看到了什么」，不是「做了什么改动」。 */
const READ_TOOLS = new Set([
  'phone_screen', 'phone_screenshot', 'phone_apps',
  'read', 'read_image', 'web_fetch', 'web_search', 'grep', 'glob',
]);

/** 思考步不是「做的事」，但可以是「最后想到哪」。 */
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

/** 把传进来的「一次运行」摊平成步骤数组：认 `run` 对象、`{ steps:[{key,step}] }` 与裸数组三种形状。 */
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
  const candidates = ['target', 'text', 'description', 'query', 'command', 'file_path', 'path', 'ref', 'packageName', 'url'];
  for (const key of candidates) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return clip(value);
  }
  return clip(step.name || step.kind || '');
}

/** 一步的状态归成交代里的三种：成功 / 没用成 / 还在跑。 */
function stateOf(step) {
  const state = step && typeof step.state === 'string' ? step.state : '';
  if (state === 'ok') return 'ok';
  if (state === 'error') return 'error';
  if (state === 'stopped') return 'stopped';
  return 'running';
}

/**
 * 这一步算不算「对外发出」（发送 / 提交 / 下单 / 付款 / 删除这类收不回来的动作）。
 * 复用 irreversible 的词表，避免和「点之前要不要停下来问」那套规则各写一份。
 * 有些工具调用会在步骤上显式带 `outward` / `irreversible` 标记，优先用它。
 */
function outwardKindOf(step) {
  if (!step || typeof step !== 'object') return '';
  if (typeof step.outward === 'string' && step.outward) return step.outward;
  if (step.outward === true) return 'outward';
  if (step.irreversible === true) return 'outward';
  const args = step.args && typeof step.args === 'object' ? step.args : {};
  const label = [
    step.summary,
    args.target, args.text, args.label, args.value, args.description,
  ].filter((v) => typeof v === 'string' && v.trim() !== '').join(' ');
  if (!label) return '';
  const hit = irreversible.matchLabel(label);
  return hit && hit.kind && hit.kind !== 'none' ? hit.kind : '';
}

/** 一行交代的固定收尾：明确说「没做完的部分没有接着做」，别让用户以为还在跑。 */
const TAIL = '没做完的部分没有接着做。';

/**
 * 从一次运行生成交代。
 *
 * @param {object|Array} run 一次运行的步骤流（见文件头），可选带 `reason` / `note`。
 * @returns {{
 *   done: string[], seen: string[], unfinished: Array<{key?:string,index:number,summary:string,state:string}>,
 *   outward: { count:number, byKind:Object<string,number>, items:string[] },
 *   thought: string,
 *   nextAnchor: ({key?:string,index:number,summary:string,state:string}|null),
 *   line: string,
 * }}
 */
function summarize(run) {
  const steps = toStepList(run);
  const done = [];
  const seen = [];
  const unfinished = [];
  const outward = { count: 0, byKind: {}, items: [] };
  let thought = '';

  steps.forEach((step, index) => {
    if (!step || typeof step !== 'object') return;
    const label = labelOf(step);
    const state = stateOf(step);

    if (isThink(step)) {
      // 思考步不进「做了什么」；只记最后一段有内容的思考，作为「停下时想到哪 / 写了一半的字」。
      if (label) thought = label;
      return;
    }
    if (!step.name && !label) return;

    if (state === 'running' || state === 'error' || state === 'stopped') {
      unfinished.push({
        ...(typeof step.key === 'string' ? { key: step.key } : {}),
        index,
        summary: label || String(step.name || '一步动作'),
        state,
      });
      return;
    }

    // 成功的一步：区分「看到了什么」与「做了什么」。
    if (READ_TOOLS.has(step.name)) {
      if (label) seen.push(label);
    } else if (label) {
      done.push(label);
    }

    const kind = outwardKindOf(step);
    if (kind) {
      outward.count += 1;
      outward.byKind[kind] = (outward.byKind[kind] || 0) + 1;
      if (label) outward.items.push(label);
    }
  });

  // 整轮一个收尾答复都没有（被停止）：也算一件没做完的事。
  const reason = run && typeof run === 'object' && !Array.isArray(run) && run.reason != null ? String(run.reason) : '';
  if (unfinished.length === 0 && (reason === 'aborted' || reason === 'stopped')) {
    unfinished.push({ index: steps.length, summary: '这一轮被停下，没有收尾答复', state: 'stopped' });
  }

  // 续跑锚点：第一件没做完的事；都做完了就指向「上一步之后」。
  const nextAnchor = unfinished.length > 0
    ? { ...unfinished[0] }
    : (steps.length > 0 ? { index: steps.length, summary: '上一步之后', state: 'running' } : null);

  const capped = {
    done: done.slice(-MAX_DONE),
    seen: seen.slice(-MAX_SEEN),
    unfinished: unfinished.slice(0, MAX_UNFINISHED),
    outward: { ...outward, items: outward.items.slice(-MAX_DONE) },
    thought,
    nextAnchor,
  };

  return { ...capped, line: renderLine(capped) };
}

/** 把结构化结果拼成一段人话（确定性，不调模型）。可以是助手气泡的兜底文本。 */
function renderLine(summary) {
  const parts = [];
  if (summary.done.length > 0) parts.push(`做了：${summary.done.join('；')}`);
  if (summary.seen.length > 0) parts.push(`看到了：${summary.seen.join('；')}`);
  if (summary.outward.count > 0) {
    const kinds = Object.keys(summary.outward.byKind).map((k) => `${k} ${summary.outward.byKind[k]}`).join('、');
    parts.push(`对外发出 ${summary.outward.count} 次（${kinds}）`);
  }
  if (summary.unfinished.length > 0) {
    parts.push(`没做完：${summary.unfinished.map((u) => u.summary).join('；')}`);
  }
  const head = parts.length > 0 ? `先停在这里。${parts.join('。')}。` : '先停在这里，这一轮还没读到可交代的东西。';
  return `${head}${TAIL}`;
}

/**
 * 这一轮能不能「继续」接着做，以及从哪一步接。
 *
 * @param {object|Array} run
 * @returns {{ ok:boolean, anchor:({key?:string,index:number,summary:string,state:string}|null), reason:string }}
 */
function canContinue(run) {
  const steps = toStepList(run);
  if (steps.length === 0) return { ok: false, anchor: null, reason: '这一轮没有任何步骤可接着做' };
  const summary = summarize(run);
  return {
    ok: true,
    anchor: summary.nextAnchor,
    reason: summary.nextAnchor && summary.nextAnchor.state !== 'running'
      ? `从「${summary.nextAnchor.summary}」这一步接着做`
      : '从最后一步之后接着做',
  };
}

module.exports = {
  summarize,
  canContinue,
  renderLine,
  // 给接线方与守卫直接用的纯函数：
  toStepList,
  labelOf,
  stateOf,
  outwardKindOf,
  TAIL,
  MAX_DONE,
  MAX_SEEN,
  MAX_UNFINISHED,
};

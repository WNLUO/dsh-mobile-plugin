'use strict';

/**
 * 压缩时的**结构化步骤摘要**：目标 / 已确认事实（按种类去重）/ 进展行 / 更早结局计数 / 最后打算。
 *
 * 全从原话、工具结果与模型说过的话里**确定性**地取，**不调模型**。理由和 Mika 一样直白：
 * 压缩每次都要重算摘要，调一次模型既多一次往返，同样的历史还可能得出不同的摘要——请求前缀
 * 就不稳，缓存命中率跟着掉。摘要稳 = 前缀稳 = 省钱。
 *
 * 各段都有上限（事实每类 `MAX_FACT_VALUES` 个、进展 `MAX_PROGRESS` 行、更早结局 `MAX_EARLIER_KINDS`
 * 种、单项截到 `CLIP` 字），步数再多摘要也不会无限变长。
 *
 * 输入沿用直播 / 历史清单的形状（`{ key, step }` 或裸 step 数组，step 里带
 * `kind` / `name` / `summary` / `state`，可选 `args` / 结构化事实字段）。`render()` 产出的
 * 是给模型读的确定性文本，可直接当压缩时折叠段的头。
 */

const MAX_FACT_VALUES = 4;
const MAX_PROGRESS = 15;
const MAX_EARLIER_KINDS = 5;
const CLIP = 100;
const OTHER = '其他';

/** 结果里能当事实记下的短字段 → 事实种类（对齐 Mika StepSummary 的 FACT_KEYS）。 */
const FACT_KEYS = [
  ['currentApp', '去过的应用'],
  ['app', '去过的应用'],
  ['packageName', '去过的应用'],
  ['url', '打开的页面'],
  ['path', '读写的文件'],
  ['file_path', '读写的文件'],
];

function clip(text, max = CLIP) {
  const one = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return {};
  return entry.step && typeof entry.step === 'object'
    ? { key: entry.key, ...entry.step }
    : entry;
}

function toStepList(run) {
  const list = Array.isArray(run)
    ? run
    : (run && typeof run === 'object' && Array.isArray(run.steps) ? run.steps : null);
  return list ? list.map(normalizeEntry) : [];
}

function labelOf(step) {
  if (!step || typeof step !== 'object') return '';
  if (typeof step.summary === 'string' && step.summary.trim() !== '') return clip(step.summary);
  const args = step.args && typeof step.args === 'object' ? step.args : {};
  for (const key of ['target', 'text', 'description', 'query', 'command', 'file_path', 'path', 'ref', 'packageName', 'url']) {
    if (typeof args[key] === 'string' && args[key].trim() !== '') return clip(args[key]);
  }
  return clip(step.name || step.kind || '');
}

/** 状态 → 进展行末尾的结局词。 */
function outcomeOf(step) {
  const state = step && typeof step.state === 'string' ? step.state : '';
  if (state === 'ok') return '成功';
  if (state === 'error') return '失败';
  if (state === 'stopped') return '中断';
  if (state === 'running') return '未完成';
  return '完成';
}

/** 工具名 → 从它这一步能确认的事实（路径 / 网址 / 应用）。 */
function factsFromStep(step, out) {
  if (!step || typeof step !== 'object') return;
  // 优先用步骤/结果里已经结构化好的字段。
  for (const [key, kind] of FACT_KEYS) {
    const value = step[key] != null ? step[key]
      : (step.result && typeof step.result === 'object' ? step.result[key] : undefined);
    if (typeof value === 'string' && value.trim() !== '') {
      pushFact(out, kind, value.trim());
    }
  }
  // 退一步：从工具摘要里认（读写/编辑给的是路径，web_fetch 给的是网址）。
  const args = step.args && typeof step.args === 'object' ? step.args : {};
  if (step.name === 'web_fetch' && typeof args.url === 'string') pushFact(out, '打开的页面', args.url.trim());
  if (['read', 'read_image', 'write', 'edit', 'str_replace_editor'].includes(step.name)) {
    const path = args.file_path || args.path;
    if (typeof path === 'string' && path.trim() !== '') pushFact(out, '读写的文件', path.trim());
  }
  if (step.name === 'phone_open_app' && typeof args.packageName === 'string') pushFact(out, '去过的应用', args.packageName.trim());
}

function pushFact(out, kind, value) {
  const clipped = clip(value);
  if (!clipped) return;
  const list = out[kind] || [];
  const next = list.filter((v) => v !== clipped).concat(clipped).slice(-MAX_FACT_VALUES);
  out[kind] = next;
}

/**
 * 生成结构化步骤摘要。
 *
 * @param {object|Array} steps 步骤流（见文件头）
 * @param {{goal?:string, intent?:string}} [opts] 目标；`intent` 不传就从最后一段有内容的思考取
 * @returns {{
 *   goal:string, facts:Object<string,string[]>, progress:string[],
 *   earlier:Object<string,number>, intent:string,
 *   render:(header?:string)=>string
 * }}
 */
function summarizeSteps(steps, opts) {
  const list = toStepList(steps);
  const goal = opts && typeof opts.goal === 'string' ? clip(opts.goal, 200) : '';

  const facts = {};
  const progress = [];
  let lastThought = '';

  for (const step of list) {
    if (!step || typeof step !== 'object') continue;
    if (step.kind === 'think') {
      const label = labelOf(step);
      if (label) lastThought = label;
      continue;
    }
    const label = labelOf(step);
    if (!label && !step.name) continue;
    factsFromStep(step, facts);
    progress.push(`${label || step.name} → ${outcomeOf(step)}`);
  }

  // 进展行超上限：最早的几行并进「更早结局计数」。
  const earlier = {};
  let p = progress;
  while (p.length > MAX_PROGRESS) {
    const out = p[0].substring(p[0].lastIndexOf('→ ') + 2).trim() || OTHER;
    const key = (out in earlier || Object.keys(earlier).length < MAX_EARLIER_KINDS) ? out : OTHER;
    earlier[key] = (earlier[key] || 0) + 1;
    p = p.slice(1);
  }

  const intent = opts && typeof opts.intent === 'string' && opts.intent.trim() !== ''
    ? clip(opts.intent)
    : lastThought;

  const summary = {
    goal,
    facts,
    progress: p,
    earlier,
    intent,
  };
  summary.render = (header) => render(summary, header);
  return summary;
}

/** 把摘要渲染成给模型读的确定性文本（无时间戳，保证前缀稳定）。 */
function render(summary, header) {
  const lines = [];
  lines.push(typeof header === 'string' && header.trim() !== '' ? header.trim() : '【本轮进度摘要】');
  lines.push('只有最新的用户消息是当前任务，工具仍然可用；更早的用户消息只作参考。');
  lines.push(`目标：${summary.goal || '（未记录）'}`);
  lines.push('已确认：');
  const kinds = Object.keys(summary.facts);
  if (kinds.length === 0) {
    lines.push('- （暂无）');
  } else {
    for (const kind of kinds) lines.push(`- ${kind}：${summary.facts[kind].join('、')}`);
  }
  lines.push('进展：');
  const earlierKeys = Object.keys(summary.earlier);
  if (earlierKeys.length > 0) {
    const total = earlierKeys.reduce((sum, k) => sum + summary.earlier[k], 0);
    lines.push(`- 更早 ${total} 步：${earlierKeys.map((k) => `${k} ${summary.earlier[k]}`).join('，')}`);
  }
  if (summary.progress.length === 0) {
    lines.push('- （暂无）');
  } else {
    for (const line of summary.progress) lines.push(`- ${line}`);
  }
  lines.push(summary.intent
    ? `下一步：从下面保留的最近几步接着做（折叠前的最后打算：${summary.intent}）`
    : '下一步：从下面保留的最近几步接着做');
  return lines.join('\n');
}

module.exports = {
  summarizeSteps,
  render,
  // 纯函数与小常量：
  labelOf,
  outcomeOf,
  factsFromStep,
  MAX_FACT_VALUES,
  MAX_PROGRESS,
  MAX_EARLIER_KINDS,
  CLIP,
};

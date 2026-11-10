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

/**
 * 只读命令白名单：`bash` 这一步到底动没动手，只看命令本身。
 *
 * 为什么需要它：手机上一轮活里绝大多数步骤是 `bash`，而 `bash` 既可能是
 * `grep -n "ota" docs/` 也可能是 `npm run build`。全算「做了什么」，交代里就是十几行
 * 「做了什么」，其实一件东西都没改 —— 用户按停止时最想知道的「改了没有」反而读不出来。
 *
 * 口径刻意收得很紧：**只认白名单里的命令词，任何一段不认得就退回「做了什么」**。
 * 判错的方向不对称 —— 把读算成做，是把没发生的事写成发生了；把做算成读，是把真做了的事
 * 藏起来。所以宁可按旧口径写「做了什么」。
 */
const READ_ONLY_COMMANDS = new Set([
  'cd', 'grep', 'rg', 'cat', 'ls', 'head', 'tail', 'wc', 'find', 'fd', 'jq',
  'diff', 'stat', 'file', 'tree', 'pwd', 'sed', 'awk', 'echo', 'which', 'type',
  'basename', 'dirname', 'realpath', 'sort', 'uniq', 'cut', 'tr', 'xargs',
]);

/** 这些词一出现就是真动手了（写文件 / 装依赖 / 改版本库），整条命令按「做了什么」算。 */
const WRITE_WORDS = new Set([
  'rm', 'mv', 'cp', 'tee', 'mkdir', 'touch', 'chmod', 'chown', 'ln', 'dd',
  'truncate', 'npm', 'pnpm', 'yarn', 'npx', 'cargo', 'docker', 'make', 'kill',
  'curl', 'wget', 'git-add', 'install', 'patch',
]);

/** 把一段命令切成若干「子命令」：只切 `&&` 与 `;`，**不切 `|`**（正则里的 `\|` 是转义，不是管道）。 */
function commandSegments(command) {
  return String(command || '')
    .split(/&&|;/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 一段命令的词：去掉 `VAR=value` 前缀与环境变量，取前两个词判断。 */
function wordsOf(segment) {
  return segment
    .replace(/[0-9]?>\s*\/dev\/null/g, ' ')
    .replace(/2>&1/g, ' ')
    .replace(/^\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '')
    .split(/\s+/)
    .filter(Boolean);
}

/** 这一段是不是纯读取（白名单命令 + 不含任何写词；`git` 只放行只读子命令）。 */
function segmentIsRead(segment) {
  // 先把「丢掉输出」这类无害重定向抹掉，再查还有没有 `>` —— 剩下的每一个都是真在写文件。
  const cleaned = String(segment)
    .replace(/[0-9]?>\s*\/dev\/null/g, ' ')
    .replace(/[0-9]?>&[0-9]/g, ' ');
  if (/>/.test(cleaned)) return false;
  const words = wordsOf(segment);
  if (words.length === 0) return false;
  const head = words[0].replace(/^[-("']+/, '').replace(/["').]+$/, '');
  if (head === 'git') {
    const sub = (words[1] || '').replace(/["']/g, '');
    if (!/^(log|status|diff|show|blame|rev-parse|ls-files|grep|shortlog|describe|branch|remote|tag)$/.test(sub)) {
      return false;
    }
  } else if (!READ_ONLY_COMMANDS.has(head)) {
    return false;
  }
  if (head === 'sed' && /(^|\s)-i/.test(segment)) return false;
  for (const word of words) {
    if (WRITE_WORDS.has(word.replace(/["']/g, ''))) return false;
  }
  return true;
}

/** 整条命令里有没有看得出来是写的痕迹。 */
function commandLooksReadOnly(command) {
  const segments = commandSegments(command);
  if (segments.length === 0) return false;
  return segments.every(segmentIsRead);
}

/**
 * 摘要里那截**每次都一样**的目录前缀剥掉：`cd "/Volumes/…" && grep …` → `grep …`。
 *
 * 为什么：Agent 每一条命令都从 `cd <项目根>` 起手，而摘要只给 80 个字 —— 前缀吃掉之后
 * 十几行显示出来几乎一模一样，真正的动作全落在省略号后面。剥掉之后同一个前缀不再重复十几遍。
 */
function stripCdPrefix(command) {
  const segments = commandSegments(command);
  const kept = segments.filter((part) => !/^cd\s/.test(part));
  const value = (kept.length > 0 ? kept : segments).join(' && ').trim();
  return value || String(command || '').trim();
}


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
  if (typeof step.summary === 'string' && step.summary.trim() !== '') {
    return clip(cleanLabel(step.summary, step.name));
  }
  const args = step.args && typeof step.args === 'object' ? step.args : {};
  const candidates = ['target', 'text', 'description', 'query', 'command', 'file_path', 'path', 'ref', 'url'];
  for (const key of candidates) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return clip(cleanLabel(value, step.name));
  }
  return clip(step.name || step.kind || '');
}

/**
 * 摘要显示前先收拾一遍：`bash` 类摘要把 `cd <项目根> &&` 那截前缀剥掉。
 *
 * 只剥 `bash` / `pwsh` / `terminal_send`（它们的摘要就是命令行），别的工具的原样留着 ——
 * `read` 的摘要是路径、`grep` 的是模式，本来就不带 `cd`。
 */
function cleanLabel(text, name) {
  const value = String(text == null ? '' : text);
  if (name === 'bash' || name === 'pwsh' || name === 'terminal_send') {
    return stripCdPrefixClip(value);
  }
  return value;
}

/**
 * 剥前缀之后再截断：先剥再截，才能让剩下的字更多。
 *
 * 摘要本身在插件上游已经被 `clampSummary` 截到 72 字了，这里拿到的可能已经是
 * `cd "…" && grep -n "ota" docs/dev-map…`（末尾带省略号）。剥掉前缀之后留个尾巴上的
 * 省略号就够了，不必再补。
 */
function stripCdPrefixClip(value) {
  if (!/(^|\s)cd\s/.test(value)) return value;
  const stripped = stripCdPrefix(value);
  return stripped || value;
}

/** 一步是不是「纯读取」：读类工具，或命令看起只读的 bash。 */
function looksReadOnly(step) {
  if (READ_TOOLS.has(step.name)) return true;
  if (step.name === 'bash' || step.name === 'pwsh' || step.name === 'terminal_send') {
    const command = typeof step.summary === 'string' ? step.summary : '';
    return commandLooksReadOnly(stripCdPrefix(command));
  }
  return false;
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

    if (looksReadOnly(step)) {
      if (label) seen.push(label);
    } else if (label) {
      did.push(label);
    }
    if (outwardOf(step)) outboundCount += 1;
  }

  const view = {
    did: dedupe(did).slice(-MAX_DONE),
    saw: dedupe(seen).slice(-MAX_SEEN),
  };
  if (outboundCount > 0) view.outboundCount = outboundCount;
  if (unfinished.length > 0) view.unfinished = dedupe(unfinished).slice(0, MAX_UNFINISHED);
  if (closing) view.closing = closing;
  return view;
}

/**
 * 同一个标签只留一条：`grep` 同一个模式搜两次、`read` 同一个文件读两遍，
 * 在交代里并列两行不增加任何信息，只把篇幅撑长。
 */
function dedupe(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const key = String(item || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

module.exports = {
  summarize,
  // 给守卫与接线方直接用的纯函数：
  toStepList,
  labelOf,
  stateOf,
  outwardOf,
  looksReadOnly,
  commandLooksReadOnly,
  stripCdPrefix,
  MAX_DONE,
  MAX_SEEN,
  MAX_UNFINISHED,
};

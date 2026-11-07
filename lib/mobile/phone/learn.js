'use strict';

/**
 * 从实际跑过的任务里沉淀 App / 网站知识草稿。
 *
 * 一次任务收尾后，把用过的动作序列（打开哪个 App / 网站、依次点了什么、在哪个框输入了什么）
 * 归纳成一份「知识草稿」，**写进待审目录**，不直接改正式的 `knowledge/apps/*` 或
 * `knowledge/sites/*`。人工看过、收下之后才并入正式知识——所以草稿与正式知识是两份东西。
 *
 * 知识只讲事实（入口在哪、界面怎么组织、走到哪一步会发生什么），不写行为规则；行为规则归
 * 审批层。草稿里也会把这一次的具体值（输入过的文字、长数字串）换成 `<参数>`，避免把订单号、
 * 手机号、人名固化进知识。
 *
 * 脱敏优先用仓库里已有的 `redact.js`（存在就用），不存在时走这里一个保守的兜底并在代码里
 * 留了清楚的 TODO。见 `desensitize()`。
 *
 * 待审目录：默认插件根下的 `.knowledge-drafts/`，可用 `DSH_PHONE_KNOWLEDGE_DRAFT_DIR` 覆盖。
 * 它**不在** `knowledge/` 里，也不在发布声明的打包路径里，所以草稿不会被当成正式知识发出去。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 待审目录：插件根下的 `.knowledge-drafts/`。 */
function draftsDir() {
  const override = process.env.DSH_PHONE_KNOWLEDGE_DRAFT_DIR;
  if (typeof override === 'string' && override.trim()) return override.trim();
  // learn.js 在 lib/mobile/phone/ 下，往上三层是插件根。
  return path.join(__dirname, '..', '..', '..', '.knowledge-drafts');
}

/* ── 脱敏 ──────────────────────────────────────────────────────────────── */

/**
 * 找现成的脱敏模块。同目录的 `phone/redact.js` 就是统一的那一份（运行记录、证据账本、
 * 网络数据共用同一个实现）；路径对不上时再往下试旧位置，最后才退保守兜底。
 */
function loadRedactor() {
  const candidates = ['./redact.js', '../redact.js', '../../redact.js'];
  for (const candidate of candidates) {
    try {
      const mod = require(candidate);
      if (typeof mod === 'function') return { fn: mod, source: candidate };
      if (mod && typeof mod.redact === 'function') return { fn: (t) => mod.redact(t), source: candidate };
    } catch {
      // 没装 / 路径不对，试下一个。
    }
  }
  return null;
}

const REDACTOR = loadRedactor();

/** 兜底脱敏：把这次输入过的原文与较长的数字串换成 `<参数>`。 */
function fallbackRedact(text, sensitive) {
  let out = String(text || '');
  for (const value of sensitive) {
    if (typeof value !== 'string') continue;
    const needle = value.trim();
    // 太短的词（如「好」「1」）换掉会把正文弄烂，跳过。
    if (needle.length < 2) continue;
    out = out.split(needle).join('<参数>');
  }
  // 6 位以上的连续数字（订单号、手机号、卡号一类）打码；版本号、年份一般不到 6 位。
  out = out.replace(/\d{6,}/g, '<参数>');
  return out;
}

/**
 * 对一段文本做脱敏。
 *
 * TODO(脱敏)：仓库里还没有 `lib/mobile/redact.js`。它应有的规则（对齐 Mika 的 SkillRedactor）是：
 * 把「引号内的内容、2 位以上数字、金额、这次输入的文字」换成 `<参数>`（先 NFKC、中文数字与
 * 分隔数字归一，长的先换、纯数字只换整段），保留 App 名字里自带的数字。补上后本模块自动改用。
 * 现在先走 `fallbackRedact`，只换本次输入原文与 6 位以上数字串。
 *
 * @param {string} text 待脱敏文本
 * @param {string[]} sensitive 这次任务里输入过的原文
 */
function desensitize(text, sensitive = []) {
  // 先换掉本次任务里确实输入过的原文（人名、地址这类 redactor 的模式不一定认识），
  // 再交给统一脱敏模块跑一遍凭据/卡号/验证码那套；没有 redactor 时退回纯数字兜底。
  let out = String(text || '');
  for (const value of sensitive) {
    if (typeof value !== 'string') continue;
    const needle = value.trim();
    if (needle.length < 2) continue;
    out = out.split(needle).join('<参数>');
  }
  if (REDACTOR) return REDACTOR.fn(out);
  return out.replace(/\d{6,}/g, '<参数>');
}

/* ── 动作序列 → 事实 ────────────────────────────────────────────────────── */

/** 从一段地址里抽主机名（小写）；认不出就按 `/`、`:` 切第一段。 */
function hostOf(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return '';
  try {
    return new URL(text.includes('://') ? text : `https://${text}`).hostname.toLowerCase();
  } catch {
    return text.toLowerCase().split('/')[0].split(':')[0];
  }
}

/** 一步动作里最能说明「动了哪儿」的标签。 */
function stepLabel(step) {
  const args = (step && step.args) || {};
  const raw = args.target || args.text || args.label || step.target || step.label || args.ref || step.ref || '';
  return String(raw || '').trim();
}

/** 一步的动作名；兼容 `{action}` 与 `{name}` 两种写法。 */
function stepAction(step) {
  return String((step && (step.action || step.name)) || '').trim().toLowerCase();
}

/**
 * 把动作序列归成「经过的界面 / 做过的操作 / 需注意的现象」三组事实。
 * 只做归纳，不评价对错，也不写行为规则。
 */
function summarizeSteps(steps) {
  const opened = [];
  const taps = [];
  const typed = [];
  const scrolled = new Set();
  const keys = new Set();
  const waits = [];
  const sensitive = [];

  for (const step of Array.isArray(steps) ? steps : []) {
    const action = stepAction(step);
    const args = (step && step.args) || {};
    switch (action) {
      case 'app.open':
        opened.push(stepLabel(step) || String(args.packageName || args.package || '').trim());
        break;
      case 'app.link':
        opened.push(stepLabel(step) || String(args.uri || args.url || '').trim());
        break;
      case 'tap':
        taps.push(stepLabel(step));
        break;
      case 'type': {
        const where = stepLabel(step);
        const text = String(args.text || step.text || '').trim();
        if (text) {
          typed.push({ where, text });
          sensitive.push(text);
        }
        break;
      }
      case 'swipe':
        scrolled.add(args.direction === 'up' ? '注意：向上滑是看下面的内容' : `向${args.direction || '下'}滑动`);
        break;
      case 'key':
        if (args.key) keys.add(String(args.key));
        break;
      case 'wait':
      case 'screen.wait':
        if (args.appears) waits.push(String(args.appears));
        break;
      default:
        break;
    }
  }

  return { opened, taps, typed, scrolled, keys, waits, sensitive };
}

/* ── 由任务提炼草稿 ────────────────────────────────────────────────────── */

/** 把一段名字压成可做文件名的 slug。 */
function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'unknown';
}

/** 现在的时间，ISO 到分钟。 */
function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

/**
 * 从一次任务的轨迹提炼一份知识草稿（不落盘）。
 *
 * @param {object} trace 任务轨迹
 * @param {string} [trace.kind] 'app' | 'site'，不给时按有没有 url / 包名推断
 * @param {string} [trace.packageName] App 包名
 * @param {string} [trace.appName] App 中文名
 * @param {string} [trace.url] 网站地址
 * @param {string} [trace.host] 网站主机名（与 url 二选一）
 * @param {string} [trace.siteName] 网站名
 * @param {string} [trace.outcome] done / partial / not_possible / unknown
 * @param {string} [trace.sessionId] 来源会话
 * @param {Array}  [trace.steps] 动作序列，每步 `{ action, args }`
 * @param {string[]} [trace.inputs] 额外需要脱敏的原文
 * @returns {{kind, name, slug, display, status, markdown, outcome}}
 */
function draftFromTask(trace) {
  const t = trace && typeof trace === 'object' ? trace : {};
  const url = String(t.url || t.host || '').trim();
  const host = hostOf(url);
  const pkg = String(t.packageName || t.package || '').trim();
  const kind = t.kind === 'app' || t.kind === 'site'
    ? t.kind
    : (host && !pkg ? 'site' : 'app');

  const summary = summarizeSteps(t.steps);
  const extraSensitive = Array.isArray(t.inputs) ? t.inputs.map(String) : [];
  const sensitive = [...summary.sensitive, ...extraSensitive];

  const name = kind === 'site' ? (host || 'site') : (pkg || slugify(t.appName));
  const display = kind === 'site'
    ? String(t.siteName || host || name)
    : String(t.appName || name);

  const lines = [];
  const fm = [];
  fm.push('---');
  fm.push(`name: ${name}`);
  fm.push(`display: ${display}`);
  fm.push(`kind: ${kind}`);
  fm.push('status: draft');
  fm.push('review: pending');
  fm.push(`learned_from: ${String(t.sessionId || 'task').slice(0, 80)}`);
  fm.push(`outcome: ${String(t.outcome || 'unknown').slice(0, 40)}`);
  fm.push(`created: ${nowIso()}`);
  fm.push('---');
  lines.push(fm.join('\n'));
  lines.push('');
  lines.push('# 知识草稿（待审）');
  lines.push('');
  lines.push('> 这是从一次实际任务归纳出的草稿，收下并人工核对后才并入正式知识。只记录事实（入口、界面、走到哪一步会发生什么），不含行为规则。');
  lines.push('');
  lines.push('## 是什么');
  if (kind === 'site') {
    lines.push(`${display}（${host || name}）。以下按一次实际任务的操作顺序记录。`);
  } else {
    lines.push(`${display}（${pkg || name}）。以下按一次实际任务的操作顺序记录。`);
  }
  lines.push('');
  lines.push('## 界面');
  const iface = [];
  if (summary.opened.length > 0) iface.push(`- 入口：${summary.opened.filter(Boolean).join('、') || display}`);
  for (const tap of summary.taps) {
    if (tap) iface.push(`- 点「${tap}」`);
  }
  if (iface.length === 0) iface.push('- 这次任务没有记录到具体的界面入口。');
  lines.push(...iface);
  lines.push('');
  lines.push('## 功能');
  const func = [];
  for (const item of summary.typed) {
    func.push(`- 在「${item.where || '输入框'}」里输入：${item.text}`);
  }
  for (const note of summary.scrolled) func.push(`- ${note}`);
  if (func.length === 0) func.push('- 这次任务没有记录到具体操作。');
  lines.push(...func);
  lines.push('');
  lines.push('## 已知现象');
  const signs = [];
  if (summary.waits.length > 0) signs.push(`- 某些页面需要等待加载：${summary.waits.join('、')}`);
  if (summary.keys.has('back')) signs.push('- 过程中用返回键退出过当前页');
  if (signs.length === 0) signs.push('- 这次任务没有遇到需要特别记下的现象。');
  lines.push(...signs);

  const body = desensitize(lines.join('\n'), sensitive);

  return {
    kind,
    name,
    slug: slugify(name),
    display,
    status: 'draft',
    outcome: String(t.outcome || 'unknown'),
    markdown: body,
  };
}

/**
 * 把草稿写进待审目录。文件名带时间戳，避免同一条知识的多份草稿互相覆盖。
 *
 * @returns {{path, file, dir, kind, name, status}}
 */
function writeDraft(draft, options = {}) {
  if (!draft || typeof draft.markdown !== 'string') throw new Error('没有可写的草稿。');
  const slug = String(draft.slug || '');
  if (!/^[a-z0-9.-]+$/.test(slug)) throw new Error('草稿 slug 不合法，可能会逃出待审目录。');
  const kind = draft.kind === 'site' ? 'site' : 'app';
  const dir = options.dir || draftsDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const file = `${kind}-${slug}-${stamp}.md`;
  const target = path.resolve(dir, file);
  const root = path.resolve(dir);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('草稿文件名逃出了待审目录。');
  }
  fs.writeFileSync(target, draft.markdown, 'utf8');
  return { path: target, file, dir, kind: draft.kind, name: draft.name, status: 'draft' };
}

/** 便利入口：从轨迹直接提炼并落盘，返回写入位置与草稿概要。 */
function learnFromTask(trace, options = {}) {
  const draft = draftFromTask(trace);
  return writeDraft(draft, options);
}

module.exports = {
  draftsDir,
  draftFromTask,
  writeDraft,
  learnFromTask,
  desensitize,
  // 供测试
  _internal: {
    summarizeSteps,
    slugify,
    hostOf,
    fallbackRedact,
    redactorSource: REDACTOR ? REDACTOR.source : null,
  },
};

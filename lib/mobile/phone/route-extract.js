'use strict';

/**
 * 把一次真跑成功的 `phone_steps` 轨迹，抽成一份**结构化路线**（也就是「教一次就学会」里
 * 「学」的那一半）。纯函数：不连手机、不发动作、不碰磁盘，进得去出得来。
 *
 * ## 为什么另起一份，不复用 `routes-memory`
 *
 * `routes-memory` 存的是「这个 App 上次是怎么做的」的**摘要**，而且文件头写明了刻意不给可执行
 * 步骤 —— 界面会变，照抄旧路线比没有更危险。那一条对「人读的参考」仍然成立，所以那份不动。
 * 这里要做的是另一件事：让**机器**能照着重放，所以必须留下每个目标的可重认身份（文字、role、
 * 资源 id、视口相对位置），而不是把步骤压成一句人话。
 *
 * 两者互不替代：`route-hint` 继续负责「大概怎么做过」，这份负责「精确怎么再走一遍」。
 *
 * ## 存什么、不存什么（这条是隐私面，不是风格）
 *
 * - **不存 ref**：`e7` 只对当时那一屏有效，换一屏就失效；存下来等于存了一把随时对不上号的钥匙。
 * - **不存绝对像素**：只存视口百分比中心，换台尺寸不同的手机仍然指同一个控件。
 * - **不存业务值**：用户输入的正文、被点的人名/单号一律换成 `<参数>` 占位符，值本身不落盘。
 * - **界面锚保留字面量**：「发送」「搜索」「+」这类按钮文字是定位骨架，换成占位符这条路线就废了。
 *
 * 换句话说：**会变的那部分不存，不变的那部分才存**。
 */

const redactor = require('./redact.js');
const irreversible = require('./irreversible.js');

/** 路线格式版本。字段含义变才抬，加可选字段不抬。 */
const ROUTE_VERSION = 1;

/** 一条路线最多几步。与 `phone_steps` 单批上限一致：再多就不是「一次教」了。 */
const MAX_STEPS = 20;

/**
 * 能重放的动作，是 `service.js` 的 ACTIONS 的一个子集。
 *
 * 刻意只有能「再走一遍」的那些：`batch` 不进来（那是容器）、`screen.screenshot` / `extract` /
 * `collect` 这类只读动作也不进来 —— 重放靠的是现读屏，把当时的观察固化成步骤没有意义。
 */
const REPLAYABLE_ACTIONS = new Set([
  'tap', 'type', 'swipe', 'key', 'app.open', 'app.close', 'wait', 'gesture',
]);

/** 动作名 → 给人看的一句话动词。 */
const VERBS = {
  tap: '点击',
  type: '输入',
  swipe: '滑动',
  key: '按键',
  'app.open': '打开',
  'app.close': '关闭',
  wait: '等待',
  gesture: '手势',
};

/**
 * 要脱敏的字面量：**只有用户亲手输入的正文**（`args.text`）。
 *
 * 刻意不含 `args.target`：那是「这一步在点什么」，绝大多数是界面上的按钮文字（发送、搜索、
 * 微信），换掉就等于把定位锚毁了。人名这类可能被点到的内容确实有隐私担忧，但它本来就活在
 * 界面上、也已经被 `routes-memory` 原样记着；把整张元素表都当 PII 处理会让路线一条都学不成，
 * 那不是隐私保护，那是功能报废。真正该挡的凭据类由统一脱敏器的模式负责。
 */
function sensitiveArgOf(step) {
  if (!step || typeof step !== 'object') return [];
  const args = step.args && typeof step.args === 'object' ? step.args : {};
  return typeof args.text === 'string' && args.text.trim() ? [args.text] : [];
}

/** 元素上的文字：与 `tools.js` 的 `elementText` 同一套字段优先级。 */
function elementText(el) {
  if (!el || typeof el !== 'object') return '';
  for (const key of ['text', 'name', 'label', 'description', 'contentDescription', 'hint']) {
    const value = el[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

/** 元素的视口中心（百分比）。读不出来返回 null —— 没有位置就不硬编一个。 */
function centerOf(el) {
  const bounds = el && Array.isArray(el.bounds) ? el.bounds : null;
  if (!bounds || bounds.length < 4) return null;
  const nums = bounds.slice(0, 4).map((n) => Number(n));
  if (!nums.every((n) => Number.isFinite(n))) return null;
  return { x: (nums[0] + nums[2]) / 2, y: (nums[1] + nums[3]) / 2 };
}

/** 按 ref 在这一屏里找元素；找不到返回 null（说明这一屏已经换过了）。 */
function elementByRef(elements, ref) {
  const wanted = typeof ref === 'string' ? ref.trim() : '';
  if (!wanted) return null;
  const list = Array.isArray(elements) ? elements : [];
  return list.find((el) => el && String(el.ref) === wanted) || null;
}

/** 把文字压成一行、去掉多余空白。 */
function tidy(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

/**
 * 从当屏元素表里给这一步取一个「重放时认得回来」的定位骨架。
 *
 * 优先取元素自己的文字；元素没有文字（只有 ref 的图标按钮）时退到这一屏的 app + 相对位置。
 * 三条特征按「越稳越靠前」排：资源 id（改文案不改控件）→ role → 文字 → 相对位置。
 */
function locatorOf(step, elements) {
  const args = (step && step.args) || {};
  const ref = typeof args.ref === 'string' ? args.ref.trim() : '';
  const el = ref ? elementByRef(elements, ref) : null;
  const loc = {};
  if (el) {
    const text = tidy(elementText(el));
    if (text) loc.text = text.slice(0, 120);
    if (typeof el.role === 'string' && el.role.trim()) loc.role = el.role.trim().slice(0, 60);
    const rid = el.resourceId || el.id;
    if (typeof rid === 'string' && rid.trim()) loc.resourceId = rid.trim().slice(0, 160);
    const center = centerOf(el);
    if (center) loc.relPos = { x: round1(center.x), y: round1(center.y) };
  }
  // 按坐标点的那一下：没有元素可认，只能留下当时那个位置。它仍然比什么都不留有用 ——
  // 重放时按位置找可点元素，找不到就如实停，不瞎点。
  if (!el && Number.isFinite(args.x) && Number.isFinite(args.y)) {
    loc.relPos = { x: round1(args.x), y: round1(args.y) };
  }
  // 兜底锚：模型调 tap 时给的 `target`（「这一步在点什么」）。手机侧批量默认只回最后那一屏，
  // 拿不到每步的元素表，所以这条文字往往是唯一能认回来的东西 —— 有它就用，没有才判不可重放。
  if (!loc.text) {
    const target = tidy(args.target);
    // 被脱敏成 `<参数>` 的目标文字认不回任何控件 —— 那种等于没有锚，不能拿它当定位依据。
    if (target && target !== '<参数>') loc.text = target.slice(0, 120);
  }
  return Object.keys(loc).length > 0 ? loc : null;
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

/** 一条路线去重用的键：同一 App + 同一意图 + 同样的动作形状，算同一条。 */
function routeKey(route) {
  const pkg = route && route.app ? String(route.app.package || '') : '';
  const shape = route && route.intent && route.intent.shape ? route.intent.shape : {};
  const first = shape.firstAction || '';
  const count = Number(shape.stepCount) || 0;
  const words = Array.isArray(route && route.intent && route.intent.tokens)
    ? route.intent.tokens.slice().sort().join(',')
    : '';
  return `${pkg}|${first}|${count}|${words}`;
}

/** 意图分词：中文按二字滑窗，英文/数字按整词。停用词去掉，重复的去重。 */
const STOP_WORDS = new Set([
  '帮我', '给我', '一下', '这个', '那个', '然后', '就是', '可以', '能不', '不能',
  'the', 'and', 'for', 'with', 'please', 'you', 'can', 'would', 'this', 'that',
]);

function tokenize(text) {
  const source = tidy(text).toLowerCase();
  if (!source) return [];
  const out = new Set();
  for (const word of source.match(/[a-z0-9][a-z0-9_]+/g) || []) out.add(word);
  const cjk = source.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i + 2 <= cjk.length; i += 1) out.add(cjk.slice(i, i + 2));
  return [...out].filter((t) => t.length >= 2 && !STOP_WORDS.has(t)).slice(0, 40);
}

/**
 * 抽一条路线。
 *
 * @param {object} input
 * @param {string} input.packageName 这条轨迹发生在哪个 App（首屏或批量结果的包名）
 * @param {Array} input.steps 真跑过的步骤，每步 `{action, args, until?}`
 * @param {Array<Array>} [input.screens] 与 steps 对齐的「这一步动手之前那一屏」的元素表；
 *   缺一格就用上一格，缺全部则这一步没有定位骨架（会被判不可重放）
 * @param {string} [input.intentText] 触发这次操作用户说的话
 * @param {string} [input.title] 首屏/页面标题
 * @param {Array<{action,ok}>} [input.results] 每步的执行结果，用来判「是不是真的都做成了」
 * @returns {{ok:true, route:object} | {ok:false, problem:string}}
 */
function extractRoute(input = {}) {
  const packageName = tidy(input.packageName);
  if (!packageName) return { ok: false, problem: 'no_package' };

  const steps = Array.isArray(input.steps) ? input.steps : [];
  if (steps.length === 0) return { ok: false, problem: 'no_steps' };
  if (steps.length > MAX_STEPS) return { ok: false, problem: 'too_many_steps' };

  // 每一步必须真的成功。有一条失败或没执行，这条轨迹就不是「做成的那一次」。
  const results = Array.isArray(input.results) ? input.results : [];
  if (results.length > 0) {
    for (const row of results) {
      if (!row || row.ok !== true) return { ok: false, problem: 'not_all_steps_ok' };
    }
  }

  // 动作必须在可重放子集里。批容器、只读动作、系统写动作一律拒绝：它们不是「再走一遍」的一部分。
  for (const step of steps) {
    const action = step && typeof step.action === 'string' ? step.action.trim() : '';
    if (!REPLAYABLE_ACTIONS.has(action)) return { ok: false, problem: `unreplayable_action:${action || '(空)'}` };
  }

  // 收集本次要脱敏的字面量。注意只用于「用户内容」字段，界面锚不脱敏。
  const literals = [];
  for (const step of steps) literals.push(...sensitiveArgOf(step));

  const screens = Array.isArray(input.screens) ? input.screens : [];
  const outSteps = [];
  const params = [];
  let lastScreen = null;

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const action = step.action.trim();
    const args = step.args && typeof step.args === 'object' ? step.args : {};
    const screen = Array.isArray(screens[i]) ? screens[i] : lastScreen;
    if (Array.isArray(screens[i])) lastScreen = screens[i];

    const out = { i, action };
    const outArgs = {};

    if (action === 'tap') {
      const target = tidy(args.target);
      // 目标文字作为「这一步在点哪儿」的人读说明；真正的定位靠 locator。
      if (target) outArgs.target = redactText(target, literals, params, 'target');
    } else if (action === 'type') {
      const text = typeof args.text === 'string' ? args.text : '';
      outArgs.text = redactText(text, literals, params, 'text');
      if (args.submit === true) outArgs.submit = true;
    } else if (action === 'swipe') {
      if (typeof args.direction === 'string') outArgs.direction = args.direction;
      if (Number.isFinite(args.amount)) outArgs.amount = args.amount;
    } else if (action === 'key') {
      if (typeof args.key === 'string') outArgs.key = args.key;
    } else if (action === 'app.open' || action === 'app.close') {
      outArgs.packageName = tidy(args.packageName) || packageName;
    } else if (action === 'wait') {
      if (Number.isFinite(args.ms)) outArgs.ms = args.ms;
    } else if (action === 'gesture') {
      if (Array.isArray(args.strokes)) outArgs.strokes = args.strokes;
    }
    out.args = outArgs;

    const locator = locatorOf(step, screen);
    // 定位锚上如果正好是用户自己的内容（被点的是人名、单号……），把那一截换成占位符而不是删掉：
    // 删掉这一步就再也认不回来，而「给<收件人>发消息」这种正是最该学的那一类。换成占位符之后
    // 它仍是一个可用锚，只是重放时要由调用方把值补进来。
    if (locator && typeof locator.text === 'string' && locator.text) {
      locator.text = redactText(locator.text, literals, params, 'anchor');
    }
    if (locator && Object.keys(locator).length > 0) out.locator = locator;
    if (step.until && typeof step.until === 'object') {
      const until = {};
      for (const key of ['appears', 'gone', 'app']) {
        if (typeof step.until[key] === 'string' && step.until[key].trim()) {
          until[key] = redactText(tidy(step.until[key]), literals, params, key);
        }
      }
      if (step.until.stable === true) until.stable = true;
      if (Number.isFinite(step.until.timeoutMs)) until.timeoutMs = step.until.timeoutMs;
      if (Object.keys(until).length > 0) out.until = until;
    }

    // 这一步要不要在重放时**当场**再问一次：付款/下单那类永远要；存档里绝不记「已确认」。
    const judged = judgeStep(step);
    if (judged && judged.kind === 'payment') out.mustConfirmLive = true;

    // 「认不回目标」只对**必须指名道姓那个控件**的动作有意义。`tap` 永远要；`type` 只有在
    // 指定了 ref（往某个具体的框里写）时才要 —— 不指定 ref 的 `type` 是「往当前焦点框里打」，
    // 它本来就跟着前一步的焦点走，没有锚是对的。`app.open` / `key` / `swipe` / `gesture` /
    // `wait` 这类动的是「动作本身」，不需要元素锚。
    const needsLocator = out.action === 'tap' || (out.action === 'type' && typeof args.ref === 'string' && args.ref.trim());
    if (needsLocator && (!out.locator || (!out.locator.text && !out.locator.role && !out.locator.resourceId))) {
      out.positionOnly = true;
    }

    outSteps.push(out);
  }

  const intentText = tidy(input.intentText);
  const title = tidy(input.title);
  const actions = outSteps.map((s) => s.action);
  const route = {
    version: ROUTE_VERSION,
    app: { package: packageName },
    intent: {
      raw: redactText(intentText, literals, params, 'intent'),
      tokens: tokenize(intentText),
      shape: {
        firstAction: actions[0] || '',
        stepCount: actions.length,
        actionBigrams: bigrams(actions),
      },
    },
    outcome: 'done',
    learnedAt: new Date().toISOString(),
    steps: outSteps,
  };
  if (title) route.intent.title = title.slice(0, 200);
  if (params.length > 0) route.params = dedupeParams(params);

  // 有一条只能靠位置认的步，就整条判「仅供人看」：与其存一条注定在第二台手机上点错的消息，
  // 不如不存。这与 `route-hint` 的取向一致，只是门槛落在「能不能重认目标」上。
  if (outSteps.some((s) => s.positionOnly)) return { ok: false, problem: 'position_only' };

  const problem = validateRoute(route);
  if (problem) return { ok: false, problem };
  return { ok: true, route };
}

/** 动作二元组：用来在「说法不同、做法一样」时兜底认亲。 */
function bigrams(actions) {
  const out = [];
  for (let i = 0; i + 1 < actions.length; i += 1) out.push([actions[i], actions[i + 1]]);
  return out.slice(0, 12);
}

/** 判这一步重放时要不要现问。判定沿用不可逆模块，抽的时候只作参考标记。 */
function judgeStep(step) {
  try {
    const args = (step && step.args) || {};
    const screenText = typeof args.target === 'string' ? args.target : '';
    return irreversible.judge({ action: step.action, args, screenText });
  } catch {
    return null;
  }
}

/**
 * 把一个用户内容字段脱敏：命中就换 `<参数>`，并登记一个占位符。
 *
 * 只替换**本次真正出现过**的字面量与凭据类模式，不做「见数字就换」那种粗暴处理 ——
 * 界面锚（按钮上的文字）必须原样留下，否则重放认不到目标。
 */
function redactText(text, literals, params, slot) {
  const source = String(text == null ? '' : text);
  if (!source.trim()) return source;
  let out = source;
  let changed = false;
  // 先按本次输入过的原文精确替换（长的先换，避免短的把长的切碎）。
  const sorted = [...new Set(literals.map((s) => tidy(s)).filter((s) => s.length >= 2))]
    .sort((a, b) => b.length - a.length);
  for (const lit of sorted) {
    if (!out.includes(lit)) continue;
    out = out.split(lit).join('<参数>');
    changed = true;
  }
  // 再交给统一脱敏模块挡凭据类（卡号、验证码、长数字串）。
  try {
    const masked = redactor.redact(out);
    if (masked && masked !== out) { out = masked; changed = true; }
  } catch { /* 脱敏器读坏了不阻断抽取，下面的兜底照样挡长数字 */ }
  if (changed && out.includes('<参数>')) {
    params.push({ name: slot, placeholder: '<参数>', kind: 'text', required: true });
  }
  return out;
}

function dedupeParams(params) {
  const seen = new Set();
  const out = [];
  for (const p of params) {
    const key = `${p.name}|${p.placeholder}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * 结构化校验：形状不对就整条不要。
 *
 * 这里刻意**不校验业务值**（金额、单号）—— 那些已经在抽取时换掉了，再校验一遍是白费。
 */
function validateRoute(route) {
  if (!route || typeof route !== 'object') return 'bad_route';
  if (route.version !== ROUTE_VERSION) return 'bad_version';
  if (!route.app || typeof route.app.package !== 'string' || route.app.package.length < 3) return 'bad_app';
  if (!route.intent || typeof route.intent.raw !== 'string') return 'bad_intent';
  if (!route.intent.shape || !Number.isInteger(route.intent.shape.stepCount)) return 'bad_shape';
  if (!Array.isArray(route.steps) || route.steps.length === 0) return 'bad_steps';
  if (route.steps.length > MAX_STEPS) return 'too_many_steps';
  for (const step of route.steps) {
    if (!step || !Number.isInteger(step.i) || !REPLAYABLE_ACTIONS.has(step.action)) return 'bad_step';
    if (!step.args || typeof step.args !== 'object') return 'bad_step_args';
  }
  return null;
}

/**
 * 按「App + 意图」从候选路线里挑一条最像的。纯读，不执行。
 *
 * 打分口径：App 必须沾边（不沾边直接出局，避免把别的 App 的步骤套上来），意图词重叠为主，
 * 动作形状只做 tie-break。同分取最近学的那条 —— 新近成功的路线更贴近当前版本的界面。
 */
function rankForIntent({ packageName, intentText, candidates } = {}) {
  const pkg = tidy(packageName).toLowerCase();
  const tokens = tokenize(intentText);
  const list = Array.isArray(candidates) ? candidates : [];
  const scored = [];
  for (const entry of list) {
    const route = entry && entry.route ? entry.route : entry;
    if (!route || !route.app) continue;
    const candidatePkg = tidy(route.app.package).toLowerCase();
    let appMatch = 0;
    if (pkg && candidatePkg === pkg) appMatch = 1;
    else if (pkg && candidatePkg && (candidatePkg.includes(pkg) || pkg.includes(candidatePkg))) appMatch = 0.6;
    if (appMatch === 0) continue;

    const hay = new Set([
      ...(Array.isArray(route.intent.tokens) ? route.intent.tokens : []),
      ...tokenize(route.intent.raw || ''),
    ]);
    const shared = tokens.filter((t) => hay.has(t)).length;
    const intentSim = tokens.length > 0 ? shared / tokens.length : 0;

    const shape = route.intent.shape || {};
    const shapeSim = shape.firstAction && shape.firstAction === (route.steps[0] && route.steps[0].action) ? 0.6 : 0;
    const score = 0.5 * appMatch + 0.35 * intentSim + 0.15 * shapeSim;

    scored.push({ route, score, appMatch, intentSim });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(b.route.learnedAt || '').localeCompare(String(a.route.learnedAt || ''));
  });
  return scored;
}

/** 一条路线压成给人看的一段：用来在工具结果里说明「学的是什么」。 */
function describeRoute(route) {
  if (!route || !Array.isArray(route.steps)) return '';
  const parts = route.steps.map((step) => {
    const verb = VERBS[step.action] || step.action;
    const args = step.args || {};
    const anchor = step.locator && step.locator.text
      ? `「${step.locator.text}」`
      : (args.packageName ? args.packageName : '');
    const value = typeof args.text === 'string' && args.text !== '<参数>' && step.action === 'type'
      ? ` ${args.text}`
      : '';
    return anchor ? `${verb}${anchor}${value}` : `${verb}${value}`;
  });
  return parts.join(' → ');
}

module.exports = {
  ROUTE_VERSION,
  MAX_STEPS,
  REPLAYABLE_ACTIONS,
  tokenize,
  routeKey,
  extractRoute,
  validateRoute,
  rankForIntent,
  describeRoute,
};

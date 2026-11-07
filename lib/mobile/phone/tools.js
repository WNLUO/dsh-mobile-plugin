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

/**
 * 本轮并行加的三个邻居：不可逆判定、节奏、App 知识库。
 *
 * 它们各自是别人的一次提交，可能还没合并进来。这里一律按「拿得到就用、拿不到就当没有」，
 * 因为少一层提示 / 少一段停留都不该让工具的整条注册失败 —— 那会把八个旧工具也一起拖没。
 */
let irreversible = null;
try { irreversible = require('./irreversible.js'); } catch { irreversible = null; }
let pacing = null;
try { pacing = require('./pacing.js'); } catch { pacing = null; }
let phoneKnowledge = null;
try { phoneKnowledge = require('../phone-knowledge.js'); } catch { phoneKnowledge = null; }
// 付款确认：走宿主审批通道的那条路。它拿不到审批服务 / 会话时一律回 unavailable，
// 所以这里直接 require 也没关系 —— 确认要不到只会让「付款那一步不执行」，不会挂住工具。
const confirm = require('./confirm.js');

/** 元素的短标签：模型看到的是「第几个」，不是像素坐标。 */
const MAX_TEXT = 120;

/* ── 守卫账 ─────────────────────────────────────────────────────────────── */

/**
 * 每个插件上下文一份：一轮里 phone_* 的调用次数、同一个 ref 的连点、同一屏的连读、同一批的失败。
 * 按 ctx 隔离，热替换之后旧账不会串到新实例上。
 */
const guardStates = new WeakMap();

function guardStateFor(ctx) {
  let state = guardStates.get(ctx);
  if (!state) {
    state = {
      budget: new Map(), taps: new Map(), screens: new Map(), batches: new Map(),
      autoShot: new Map(), revisions: new Map(),
      // 上一次读屏的元素表：stale-ref 重试要按「旧文字 + 旧位置」把同一个元素认回来，
      // 没有这一份就只能靠序号猜。只留最近一屏，一条会话一份。
      lastElements: new Map(),
    };
    guardStates.set(ctx, state);
  }
  return state;
}

/** 一轮里允许调用 phone_* 的次数：到了软上限就催收尾，越过硬上限直接拒。 */
const CALL_SOFT_LIMIT = 60;
const CALL_HARD_LIMIT = 90;
/**
 * 一轮里工具结果累计的字节数：超过软线提醒收尾，越过硬线直接拒。
 *
 * 次数拦得住「调用很密」，拦不住「读得很肥」：一次 `phone_steps` 回来两百个元素、
 * 再带一整段知识正文，几轮下来上下文就被界面文字占满了。体积按序列化后的 JSON 估，
 * 不追求精确 —— 目的是拦住「反复读整屏」这种浪费，而不是量到字节。
 */
const BYTES_SOFT_LIMIT = 400 * 1024;
const BYTES_HARD_LIMIT = 800 * 1024;
/** 拿不到轮次号时，靠「多久没动过」兜底清账，免得同一会话把上限永远吃满。 */
const IDLE_RESET_MS = 10 * 60 * 1000;

/**
 * 这一发属于会话的哪一轮。
 *
 * 复用直播过程那套轮次口径：`turn/start` 会把当前 turn 号写进 liveSteps 桶，工具执行时读得到。
 * 读不到就退到一个固定键，再由「空闲超时」负责清账（宁可多给几次，也别把还在干活的一轮提前掐死）。
 */
function turnKeyOf(ctx, sessionId) {
  try {
    const { liveStepsTurnOf } = require('../live-steps.js');
    const turn = liveStepsTurnOf(ctx, sessionId);
    if (typeof turn === 'number') return `t${turn}`;
  } catch { /* 没有直播模块就走兜底 */ }
  return 'u';
}

/**
 * 这一轮的那本账：次数与体积记在同一条目里。
 *
 * 两笔账共用一条记录、共用同一次重置（轮次变了就一起清零），因为「这一轮」是同一个概念 ——
 * 分成两个 Map 就得写两遍重置条件，早晚有一边忘了清，于是体积账在新的一轮里还挂着旧数，
 * 第一次读屏就被判超限。
 */
function budgetEntry(ctx, sessionId) {
  const state = guardStateFor(ctx);
  const now = Date.now();
  const key = turnKeyOf(ctx, sessionId);
  let entry = state.budget.get(sessionId);
  if (!entry || entry.turnKey !== key || (key === 'u' && now - entry.at > IDLE_RESET_MS)) {
    entry = { turnKey: key, count: 0, bytes: 0, at: now };
    state.budget.set(sessionId, entry);
  }
  entry.at = now;
  return entry;
}

/** 记一次调用并判断是否该拦。返回值里的 count 供软提醒用，bytes 是上一发为止的累计体积。 */
function checkBudget(ctx, sessionId) {
  const entry = budgetEntry(ctx, sessionId);
  const bytes = entry.bytes;
  entry.count += 1;
  return { blocked: entry.count > CALL_HARD_LIMIT, count: entry.count, bytes };
}

/**
 * 记一发结果的体积，并判断越过了哪条线。
 *
 * 在结果**定稿之后**才记账：工具把自己的 note 补完、把知识附进去之后那份才是真交给模型的
 * 那一段。硬线在下一发调用开头生效（`checkBudget` 带回来的是记账前的数），因为「这一发已经
 * 做完了」再拦它没有意义，能省的是后面那一发。
 */
function noteBytes(ctx, sessionId, value) {
  const entry = budgetEntry(ctx, sessionId);
  const size = byteSizeOf(value);
  entry.bytes += size;
  if (entry.bytes > BYTES_HARD_LIMIT) return { over: 'hard', bytes: entry.bytes };
  if (entry.bytes > BYTES_SOFT_LIMIT) return { over: 'soft', bytes: entry.bytes };
  return { over: '', bytes: entry.bytes };
}

/** 序列化后有多少字节。算不出来就按 0 记 —— 体积账坏了不该把工具弄挂。 */
function byteSizeOf(value) {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? Buffer.byteLength(json, 'utf8') : 0;
  } catch {
    return 0;
  }
}

function sleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function betweenDelay() {
  if (!pacing || typeof pacing.get !== 'function' || typeof pacing.paceFor !== 'function') return 0;
  try {
    const range = pacing.paceFor(pacing.get()).betweenActionsMs;
    if (!Array.isArray(range)) return 0;
    const lo = Number(range[0]) || 0;
    const hi = Number(range[1]) || lo;
    return lo + Math.round(Math.random() * Math.max(0, hi - lo));
  } catch {
    return 0;
  }
}

/**
 * 这一批交给手机侧的节奏参数 `{mode, place}`（见协议 §1.2/§3.3）。
 *
 * mode 来自插件设置的三档（pacing.js 的 get()，默认 standard）；place 来自 App 知识里那个 App 的
 * `pace`（careful 的 App 手机侧停更久、按字数读）。手机侧按它把「步间停留 / type 分片」放到批循环里跑，
 * 电脑侧插不进 sleep（批是一次下发、手机侧 for 循环）。拿不到就给空，手机侧按 standard / normal 兜底。
 */
function pacingModeOf() {
  if (pacing && typeof pacing.get === 'function') {
    try {
      const m = pacing.get();
      if (typeof m === 'string' && m) return m;
    } catch {
      /* 读不到就走默认 */
    }
  }
  return 'standard';
}

function batchPlaceOf(steps) {
  if (!phoneKnowledge || typeof phoneKnowledge.matchApp !== 'function') return '';
  let pkg = '';
  for (const s of steps) {
    if (s && s.action === 'app.open' && s.args && typeof s.args.packageName === 'string' && s.args.packageName) {
      pkg = s.args.packageName;
      break;
    }
  }
  if (!pkg) return '';
  try {
    const doc = phoneKnowledge.matchApp(pkg);
    return doc && typeof doc.pace === 'string' ? doc.pace : '';
  } catch {
    return '';
  }
}

/** 这台手机报没报某项能力；拿不到能力接口时按「支持」放过，别凭空白挡一条路径。 */
function supports(service, deviceId, cap) {
  if (!service || typeof service.hasCapability !== 'function') return true;
  try { return service.hasCapability(deviceId, cap) === true; } catch { return true; }
}

function unsupportedNote(feature) {
  return `这台手机还不支持${feature}，需要把手机上的 App 升级到最新。`;
}

/**
 * `phone_open_link` 的两张封闭白名单。uri 只放行常见入口，settings 只放行这些设置页。
 * 白名单而不是「拼字符串」：拼的话就回到了任意外部输入直达系统的口子。
 */
const URI_SCHEMES = new Set([
  'http', 'https', 'tel', 'mailto', 'sms', 'smsto', 'geo', 'market',
  'package', 'weixin', 'alipays', 'taobao', 'bilibili', 'zhihu', 'sinaweibo', 'snssdk1128',
]);

const SETTINGS_ACTIONS = new Set([
  'android.settings.SETTINGS',
  'android.settings.WIFI_SETTINGS',
  'android.settings.BLUETOOTH_SETTINGS',
  'android.settings.DATA_ROAMING_SETTINGS',
  'android.settings.NFC_SETTINGS',
  'android.settings.AIRPLANE_MODE_SETTINGS',
  'android.settings.DISPLAY_SETTINGS',
  'android.settings.SOUND_SETTINGS',
  'android.settings.BATTERY_SAVER_SETTINGS',
  'android.settings.LOCATION_SOURCE_SETTINGS',
  'android.settings.PRIVACY_SETTINGS',
  'android.settings.SECURITY_SETTINGS',
  'android.settings.ACCESSIBILITY_SETTINGS',
  'android.settings.APPLICATION_SETTINGS',
  'android.settings.MANAGE_APPLICATIONS_SETTINGS',
  'android.settings.APPLICATION_DETAILS_SETTINGS',
  'android.settings.NOTIFICATION_SETTINGS',
  'android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS',
  'android.settings.USAGE_ACCESS_SETTINGS',
]);

/** phone_steps 里每一步允许的动作：单动作，不能再嵌套 batch。 */
const STEP_ACTIONS = new Set(['tap', 'type', 'swipe', 'key', 'app.open', 'app.close', 'screen.read', 'wait', 'gesture']);

/** 等待条件的默认与上限，和协议 1.2 一致。 */
const WAIT_DEFAULT_MS = 8000;
const WAIT_MAX_MS = 20000;

function clampTimeoutMs(value) {
  if (!Number.isFinite(value)) return WAIT_DEFAULT_MS;
  return Math.max(0, Math.min(WAIT_MAX_MS, Math.round(value)));
}

/** 判一下这一步是不是不可逆；判定模块没就绪就返回 null（安静跳过）。 */
function judgeIrreversible(action, args, screenText) {
  if (!irreversible || typeof irreversible.judge !== 'function') return null;
  try { return irreversible.judge({ action, args, screenText }); } catch { return null; }
}

/** 把一段提示补进结果已有的 note 里；没有 note 或没有提示就原样不动。 */
function appendNote(value, notes) {
  if (!value || typeof value !== 'object') return value;
  const extra = (Array.isArray(notes) ? notes : [notes]).filter((n) => typeof n === 'string' && n);
  if (extra.length === 0) return value;
  const existing = typeof value.note === 'string' ? value.note : '';
  value.note = existing ? `${existing} ${extra.join(' ')}` : extra.join(' ');
  return value;
}

function elementText(el) {
  if (!el || typeof el !== 'object') return '';
  for (const key of ['text', 'name', 'label', 'description', 'contentDescription', 'hint']) {
    const value = el[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

/** 一屏的指纹：包名 + 前若干个元素的「ref:文字」。用来判断「这块屏一直没变」。 */
function screenSignature(value) {
  if (!value || typeof value !== 'object') return '';
  const pkg = typeof value.packageName === 'string' ? value.packageName : '';
  const elements = Array.isArray(value.elements) ? value.elements : [];
  const parts = elements.slice(0, 80).map((el) => {
    const ref = el && el.ref ? String(el.ref) : '';
    return `${ref}:${elementText(el).slice(0, 40)}`;
  });
  return `${pkg}|${parts.join('|')}`;
}

/** 元素在哪：手机给的是 `[left, top, right, bottom]` 百分比。读不出来就返回 null。 */
function centerOf(el) {
  const bounds = el && Array.isArray(el.bounds) ? el.bounds : null;
  if (!bounds || bounds.length < 4) return null;
  const nums = bounds.slice(0, 4).map((n) => Number(n));
  if (!nums.every((n) => Number.isFinite(n))) return null;
  return { x: (nums[0] + nums[2]) / 2, y: (nums[1] + nums[3]) / 2 };
}

/**
 * 在一屏元素里找回「刚才那个元素」：先按原文文字找，文字一样的有多个时按离原位置最近的算。
 *
 * 为什么按文字 + 相对位置，而不是只按位置：列表滚过一屏之后，同一个位置上是别的条目；
 * 而只按文字又会撞上「发送」这种一屏里出现两次的按钮。两个条件一起用，才既能认出
 * 「同一个控件挪了位置」，也能认出「同一个控件还在原地」。
 */
function relocateIn(elements, wanted) {
  const list = Array.isArray(elements) ? elements : [];
  const text = wanted && typeof wanted.text === 'string' ? wanted.text.trim() : '';
  if (!text) return null;
  const same = list.filter((el) => elementText(el).trim() === text);
  if (same.length === 0) return null;
  if (same.length === 1) return same[0];
  const anchor = wanted.center;
  if (!anchor) return same[0];
  let best = null;
  let bestDist = Infinity;
  for (const el of same) {
    const center = centerOf(el);
    if (!center) continue;
    const dist = (center.x - anchor.x) ** 2 + (center.y - anchor.y) ** 2;
    if (dist < bestDist) { bestDist = dist; best = el; }
  }
  return best || same[0];
}

/**
 * 认一下「这一屏里叫 ref 的那个元素」。读屏结果的元素表就是手机刚吐出来的那一屏，
 * 按 ref 找即可；找不到说明它已经不在这一屏上了。
 */
function elementByRef(elements, ref) {
  const wanted = typeof ref === 'string' ? ref.trim() : '';
  if (!wanted) return null;
  const list = Array.isArray(elements) ? elements : [];
  return list.find((el) => el && String(el.ref) === wanted) || null;
}

/**
 * 死循环守卫：同一 ref 连点、同一屏连读、同一批连败，都在结果里加一句该换思路的话。
 * 只提醒、不拦截 —— 拦截会把「界面本来就慢」误判成模型在瞎试。
 */
function deadLoopNotes(ctx, sessionId, name, args, value) {
  const state = guardStateFor(ctx);
  const notes = [];

  if (name === 'phone_tap') {
    const ref = args && typeof args.ref === 'string' ? args.ref.trim() : '';
    if (ref) {
      let entry = state.taps.get(sessionId);
      if (!entry || entry.ref !== ref) entry = { ref, count: 0 };
      entry.count += 1;
      state.taps.set(sessionId, entry);
      if (entry.count >= 4) {
        notes.push(`同一个元素（${ref}）已经连点 ${entry.count} 次，几乎肯定点错了。别再点它：重新读屏，换一个元素或换一条路径。`);
      } else if (entry.count === 3) {
        notes.push(`同一个元素（${ref}）已经点了 3 次，屏没变就别再点，先读屏看看实际停在哪。`);
      }
    }
  }

  if (name === 'phone_screen') {
    const sig = screenSignature(value);
    if (sig) {
      let entry = state.screens.get(sessionId);
      if (!entry || entry.sig !== sig) entry = { sig, count: 0 };
      entry.count += 1;
      state.screens.set(sessionId, entry);
      if (entry.count >= 5) {
        notes.push(`这块屏已经连续读了 ${entry.count} 次，内容一直没变。别再用 phone_screen 反复读，换个做法。`);
      } else if (entry.count === 4) {
        notes.push('这块屏连续读了 4 次没变化，再读一次也不会变，考虑换个做法。');
      }
    }
  }

  if (name === 'phone_steps') {
    const failed = Boolean(value && (value.ok === false || value.stopReason === 'step-failed'));
    const entry = state.batches.get(sessionId) || { count: 0 };
    entry.count = failed ? entry.count + 1 : 0;
    state.batches.set(sessionId, entry);
    if (entry.count >= 3) {
      notes.push(`这一批已经失败 ${entry.count} 次，原样重试大概率还是失败。换一种做法：拆成单步，先读屏确认。`);
    } else if (entry.count === 2) {
      notes.push('这一批已经失败 2 次，原样重试大概率还是失败，换个思路。');
    }
  }

  return notes;
}

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
    // 抛出去的时候把手机侧的 code 带在 error 上：`stale-ref` 要在这里被上层认出来做一次
    // 自动重试，而「人话」那段文案里不带机器码。别的地方照旧只看 message。
    const withCode = (text) => {
      const wrapped = new Error(text);
      wrapped.code = code;
      return wrapped;
    };
    if (code === 'offline') throw withCode('那台手机在这期间断开了连接，这一步没有做。');
    if (code === 'timeout') throw withCode(`那台手机 ${message}。可以再试一次，或者先 phone_screen 看看它现在停在哪。`);
    if (code === 'unsupported') throw withCode(`那台手机上装的 App 版本还不支持 ${action}，需要把手机上的 App 升级到最新。`);
    if (code === 'not-supported') throw withCode('这台手机上没有一个 App 能接这个动作，退回操作界面去做吧。');
    if (code === 'adb-unavailable') throw withCode('那台手机的无线调试没连上（可能被系统关了），让用户在手机上重新打开无线调试。');
    if (code === 'warming') throw withCode('手机正在准备后台屏，大约还要几秒，稍等再试。');
    if (code === 'aborted') throw withCode('这一步被取消了。');
    if (code === 'stale-ref') throw withCode(`${message}（界面在点之前变了）。`);
    throw withCode(message);
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
  // 元素表要写进这段文本里：模型看到的是 render 出来的文字，不是工具结果里的 json 字段。
  // 只给「可见元素 61 个」而不给这 61 个是什么，等于告诉模型「屏上有东西但我不告诉你」——
  // 它就只能去截图猜、或者拿 ref 瞎试。
  const lines = elementLines(data.elements);
  if (lines.length > 0) parts.push('', ...lines);
  return parts.join('\n');
}

/** 把元素表写成一行一个的短文本；每个都带 ref，模型据此点。 */
function elementLines(elements) {
  const list = Array.isArray(elements) ? elements : [];
  const out = [];
  for (const el of list) {
    if (!el || typeof el !== 'object') continue;
    const ref = el.ref === undefined || el.ref === null ? '' : String(el.ref);
    if (!ref) continue;
    const bits = [];
    if (el.role) bits.push(String(el.role));
    const label = el.text || el.name || el.description || '';
    if (label) bits.push(`"${String(label).replace(/\s+/g, ' ').slice(0, 80)}"`);
    if (el.clickable) bits.push('可点');
    if (el.editable) bits.push('可输入');
    if (el.scrollable) bits.push('可滚动');
    if (el.checked === true) bits.push('已勾选');
    if (el.secret) bits.push('密码框');
    if (el.enabled === false) bits.push('不可用');
    const b = Array.isArray(el.bounds) ? el.bounds : null;
    if (b && b.length === 4) bits.push(`[${b.join(',')}]`);
    out.push(`${ref}: ${bits.join(' ')}`);
  }
  return out;
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
  /**
   * 统一注册口：每条工具都套上「步数预算」与「死循环」两道软守卫。
   *
   * 包在注册这一层而不是每条 execute 里各写一遍 —— 守卫要对**所有** phone_* 生效，
   * 漏一条就等于漏一条腿。预算越界直接拒（返回前就抛），软提醒补进结果已有的 note。
   */
  const register = (tool) => {
    const inner = tool.execute;
    scoped.tools.register(defineTool({
      ...tool,
      execute: async (args, exec) => {
        const sessionId = sessionOf(exec);
        const gate = checkBudget(ctx, sessionId);
        if (gate.blocked) {
          throw new Error(`这一轮操作手机已经到上限（约 ${CALL_HARD_LIMIT} 次），不能继续试了。把现在的进度告诉用户，需要的话用 end_not_done 收尾。`);
        }
        // 体积硬线：上一发之后累计已经越过 800KB 就直接拒。这一发还没跑，拦下来才有意义；
        // 预算按「这一轮」算，轮次变了由 `budgetEntry` 一起清掉（次数与体积同一次重置）。
        if (gate.bytes > BYTES_HARD_LIMIT) {
          throw new Error(`这一轮手机界面读回来的内容已经超过 ${Math.round(BYTES_HARD_LIMIT / 1024)}KB，上下文塞不下了，不能继续读。把现在的进度告诉用户，需要的话用 end_not_done 收尾。`);
        }
        const value = await inner(args, exec);
        // 顺手记住这次结果里的元素表：stale-ref 重试靠它把「上一次那个元素」认回来。
        // 只在真的读到元素时更新 —— 无障碍没开时是一张空表，拿它覆盖会把上一屏一起忘掉。
        if (value && Array.isArray(value.elements) && value.elements.length > 0) {
          guardStateFor(ctx).lastElements.set(sessionId, value.elements);
        }
        const notes = [];
        if (gate.count > CALL_SOFT_LIMIT) {
          notes.push(`这一轮操作手机的次数已经超过 ${CALL_SOFT_LIMIT} 次（现在 ${gate.count} 次），请尽快收尾或结束这一步，别再零碎地反复试。`);
        }
        notes.push(...deadLoopNotes(ctx, sessionId, tool.name, args, value));
        const withNotes = appendNote(value, notes);
        // 体积账在结果定稿之后才记：附进去的那些提示本身也是交给模型的字节。
        const size = noteBytes(ctx, sessionId, withNotes);
        if (size.over === 'soft') {
          appendNote(withNotes, `这一轮读到的手机界面已经累计约 ${Math.round(size.bytes / 1024)}KB，读得太多了。该收尾了：把结论说给用户，别再整屏整屏地读。`);
        }
        return withNotes;
      },
    }));
  };

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
   * 截一张后台屏并存进宿主附件库，返回可直接塞进结果的那个图片块。
   *
   * 截图有两条用途：模型主动要看（`phone_screenshot`），以及读屏读不出应用窗口时自动补一张
   * （`phone_screen`）。存图这件事只写一遍 —— 引用编号必须是宿主那种 `sha256:` 形状，写错地方
   * 下一轮整条请求会挂（2026-11-04 真机）。
   */
  const captureImage = async (service, deviceId, sessionId, target, signal) => {
    const data = await run(service, deviceId, sessionId, 'screen.screenshot', {}, signal);
    const blob = data && typeof data.blob === 'string' ? data.blob : '';
    if (!blob) throw new Error('没截到画面：手机那边没有回图片。');
    const store = attachmentsOf();
    if (!store) throw new Error('宿主没有附件库，这张图存不进去。');
    let ref;
    try {
      ref = await store.saveImage({
        data: Buffer.from(blob, 'base64'),
        mediaType: data && data.format === 'jpeg' ? 'image/jpeg' : 'image/png',
        name: textOf(target, MAX_TEXT) || 'phone-screen',
      });
    } catch (error) {
      throw new Error(`截到的画面存不下来：${String((error && error.message) || error).slice(0, 200)}`);
    }
    return {
      width: Number(ref.width) || 0,
      height: Number(ref.height) || 0,
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
  };

  /** 在一屏元素里对一下等待条件，成立就返回。 */
  const matchCondition = (elements, pkg, until) => {
    const hay = (Array.isArray(elements) ? elements : []).map(elementText).join('\n').toLowerCase();
    const pkgLower = String(pkg || '').toLowerCase();
    if (until.appears && hay.includes(String(until.appears).toLowerCase())) return { met: true, stopped: null };
    if (until.gone && !hay.includes(String(until.gone).toLowerCase())) return { met: true, stopped: null };
    if (until.app && pkgLower.includes(String(until.app).toLowerCase())) return { met: true, stopped: null };
    return null;
  };

  /**
   * 原生的 screen.wait 用不了时的兜底：自己按 500ms 读一屏比对。
   * 慢，但比「假装等到了」或直接报不支持强 —— 能力差异不该让用户的任务断掉。
   */
  const pollCondition = async (service, deviceId, sessionId, until, timeoutMs, signal) => {
    const start = Date.now();
    const deadline = start + timeoutMs;
    let lastSig = '';
    let unchanged = 0;
    for (;;) {
      const data = await run(service, deviceId, sessionId, 'screen.read', { includeText: true }, signal);
      const elements = Array.isArray(data && data.elements) ? data.elements : [];
      const hit = matchCondition(elements, data && data.packageName, until);
      if (hit) return { met: true, stopped: null, waitedMs: Date.now() - start };
      if (until.stable === true) {
        const sig = screenSignature({ packageName: data && data.packageName, elements });
        if (sig === lastSig) {
          unchanged += 1;
          if (unchanged >= 1) return { met: true, stopped: null, waitedMs: Date.now() - start };
        } else {
          unchanged = 0;
          lastSig = sig;
        }
      }
      if (Date.now() >= deadline) return { met: false, stopped: 'timeout', waitedMs: Date.now() - start };
      await sleep(Math.max(50, Math.min(500, deadline - Date.now())));
    }
  };

  /** 等一个条件：原生 screen.wait 可用就走它，否则退回轮询。 */
  const waitCondition = async (service, deviceId, sessionId, until, signal, canNative) => {
    const timeoutMs = clampTimeoutMs(until && until.timeoutMs);
    const cond = { timeoutMs };
    if (until && typeof until.appears === 'string' && until.appears.trim()) cond.appears = textOf(until.appears, 200);
    if (until && typeof until.gone === 'string' && until.gone.trim()) cond.gone = textOf(until.gone, 200);
    if (until && typeof until.app === 'string' && until.app.trim()) cond.app = textOf(until.app, 200);
    if (until && until.stable === true) cond.stable = true;
    const hasCondition = cond.appears !== undefined || cond.gone !== undefined || cond.app !== undefined || cond.stable === true;
    if (!hasCondition) return { met: true, stopped: null, waitedMs: 0 };
    if (canNative) {
      try {
        const data = await run(service, deviceId, sessionId, 'screen.wait', cond, signal);
        return {
          met: Boolean(data && data.met === true),
          stopped: data && data.stopped != null ? data.stopped : null,
          waitedMs: Number(data && data.waitedMs) || 0,
        };
      } catch { /* 原生等失败就退回轮询 */ }
    }
    return pollCondition(service, deviceId, sessionId, cond, timeoutMs, signal);
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
   * 有没有手机正在**看这条会话**。
   *
   * 判据是「这台设备开着会话流」：`stream-registry` 按 deviceId 只记「有没有流开着」，
   * 会话级的观众表在审批桥里且是模块私有的。所以这里退一步用「这台会话绑的手机上有没有
   * 流开着」—— 手机开着会话页就一定有一条流，关掉就一条都不剩。
   *
   * 判错的代价不对称：判成「有」只是多发一张没人答的卡（有硬期限兜底，最坏三分钟后回
   * unavailable），判成「没有」会把一次本该发生的确认降级成 unavailable 而根本不问。
   * 所以宁可宽一点。
   */
  const someoneWatching = (sessionId) => {
    let deviceId = '';
    try {
      const { boundDeviceOf } = require('./binding.js');
      deviceId = boundDeviceOf(sessionId) || '';
    } catch {
      return true;
    }
    // 不知道绑哪台（新会话还没绑定）：当作「可能有人看」，让审批桥自己去推。
    if (!deviceId) return true;
    try {
      const registry = require('../stream-registry.js');
      if (typeof registry.has === 'function') return registry.has(deviceId);
      // 登记表没给按设备查的口子时只能看总数：有流开着就试一次。
      if (typeof registry.size === 'function') return registry.size() > 0;
    } catch { /* 没有登记表就不凭空白挡 */ }
    return true;
  };

  /**
   * 付款 / 下单那一步的关卡：先问宿主审批通道，拿到 `allowed-once` 才放行。
   *
   * 返回 null 表示可以执行；返回一句话表示不执行，那句话直接进工具结果交给模型。
   * 只有 `payment` 走这里（`confirm.needsConfirmation` 的判据），发送 / 提交 / 删除照旧只按
   * 节奏拉间隔 —— 那几种是任务本身要做的动作，每一步都拦会让人没法用。
   */
  const requirePaymentConfirmation = async (sessionId, exec, what) => {
    const callId = exec && typeof exec.callId === 'string' ? exec.callId : '';
    const outcome = await confirm.requestConfirmation(ctx, {
      sessionId,
      summary: what,
      agent: exec && exec.agent,
      // 卡片上那个「工具 X 请求越权执行」的 X。写真实的工具名，用户在手机上看得出来
      // 这一下是哪条工具要动手。
      toolName: 'phone_tap',
      // 有值才塞：宿主与守卫都不认值为 undefined 的字段。
      ...(callId ? { callId } : {}),
      signal: exec && exec.signal,
      watching: someoneWatching(sessionId),
    });
    if (outcome === 'allowed-once') return null;
    return confirm.blockedMessage(outcome, what);
  };

  /**
   * 这一屏里还认不认得那个 ref；认不得就按「上一次那个 ref 的文字 + 相对位置」在**新读的一屏**
   * 里把同一个元素找回来。
   *
   * 手机侧自己也做了一次同样的重定位（`PhoneExecutor.relocate`），但那条路只覆盖「手机那一侧
   * 拿到的旧屏还在」。插件这一层再兜一次，是因为模型拿到的 ref 来自我们上一次读屏的结果 ——
   * 那一屏可能比手机自己记的还旧。多花一次读屏换模型少一次来回，值得。
   *
   * 只做一次：再认不出就是界面真的换了，那时报错比循环更有用（与协议 7.4「只重试一次」一致）。
   *
   * @returns {Promise<{ref: string, note: string}|null>} 找到就返回新 ref 与一句说明
   */
  const relocateStaleRef = async (service, deviceId, sessionId, ref, signal) => {
    const wanted = String(ref || '').trim();
    if (!wanted) return null;
    const previous = guardStateFor(ctx).lastElements.get(sessionId);
    const staleEl = elementByRef(previous, wanted);
    let data;
    try {
      data = await run(service, deviceId, sessionId, 'screen.read', { includeText: true }, signal);
    } catch {
      return null;
    }
    const elements = Array.isArray(data && data.elements) ? data.elements : [];
    if (data && Array.isArray(data.elements)) guardStateFor(ctx).lastElements.set(sessionId, elements);
    // 先按「旧文字 + 旧位置」认：这是协议里定的口径，比按序号猜准得多。
    const hit = staleEl
      ? relocateIn(elements, { text: elementText(staleEl), center: centerOf(staleEl) })
      : null;
    if (hit && hit.ref) {
      return {
        ref: String(hit.ref),
        note: `元素编号 ${wanted} 已经不在界面上了，按「${elementText(staleEl).slice(0, 24)}」重新定位到 ${hit.ref}，重试过一次。`,
      };
    }
    return null;
  };

  /**
   * 带一次 stale-ref 重试的执行。
   *
   * `tap` 与 `type` 的 ref 都是「上一次读屏的编号」，界面一动就过期。手机侧会回 `stale-ref`，
   * 这里收到之后**自动重新读一屏、找回同一个元素、用新编号再试一次**，并且把重试这件事
   * 如实写进结果 —— 模型要知道「看到的编号不一定还作数」，但不必为一次正常的界面变化
   * 再跑一整轮读屏 + 决策。
   */
  const runWithStaleRetry = async (service, deviceId, sessionId, action, args, signal) => {
    try {
      return { data: await run(service, deviceId, sessionId, action, args, signal), note: '' };
    } catch (error) {
      if (!error || error.code !== 'stale-ref') throw error;
      const ref = typeof args.ref === 'string' ? args.ref.trim() : '';
      const found = await relocateStaleRef(service, deviceId, sessionId, ref, signal);
      if (!found) throw error;
      const retryArgs = { ...args, ref: found.ref };
      return { data: await run(service, deviceId, sessionId, action, retryArgs, signal), note: found.note };
    }
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
      compact: {
        type: 'boolean',
        description: 'Only return elements that changed since the previous read, plus a count of unchanged ones. Default false; use it in a loop to keep results small. Ignored on phones that cannot report changes.',
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
          // 读屏读不出应用窗口时，第一次读会自动补一张截图，和文字一起回来。
          image: { type: 'object', additionalProperties: true },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const blocks = [{ type: 'text', text: summarizeScreen(value) }];
        if (value.image) blocks.push(value.image);
        return blocks;
      },
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const wantCompact = args.compact === true;
      const canCompact = supports(service, deviceId, 'screen.compact');
      const readArgs = { includeText: args.includeText !== false };
      // 参数只有在手机确实报了这项能力时才透传；否则如实说一句，而不是假装成功。
      const gsRev = guardStateFor(ctx).revisions;
      if (wantCompact && canCompact) {
        readArgs.compact = true;
        // 带上上次的读屏编号，手机才知道「从哪一版开始算变化」；对不上它会自动回全量。
        if (gsRev.has(sessionId)) readArgs.since = gsRev.get(sessionId);
      }
      const data = await run(service, deviceId, sessionId, 'screen.read', readArgs, exec.signal);
      if (data && Number.isFinite(data.revision)) gsRev.set(sessionId, data.revision);

      const notes = [mentionMismatch(sessionId, deviceId)];
      if (wantCompact && !canCompact) notes.push(unsupportedNote('紧凑读屏（compact）'));

      // App 用法知识：同一个对话、同一个 App 只附一次。知识库没就绪就当作没有。
      if (phoneKnowledge && typeof phoneKnowledge.noteFor === 'function') {
        try {
          const knowledge = phoneKnowledge.noteFor(sessionId, data && data.packageName);
          if (knowledge) notes.push(knowledge);
        } catch { /* 知识是锦上添花，读坏了不影响读屏 */ }
      }

      // 这两个开关**只在这两件事真的成立时才有键**：宿主不允许工具结果里出现值为 undefined
      // 的字段（整条结果会被判成不是合法 JSON，模型看到的是「读屏坏了」），所以按「有值才塞」
      // 的写法构造，而不是摆一个 undefined 占位。
      const value = {
        deviceId,
        packageName: textOf(data && data.packageName, MAX_TEXT),
        activity: textOf(data && data.activity, MAX_TEXT),
        elements: Array.isArray(data && data.elements) ? data.elements.slice(0, 200) : [],
      };
      if (data && data.a11yDisabled === true) value.a11yDisabled = true;
      if (data && data.treeUnreadable === true) value.treeUnreadable = true;

      // 读屏读不出应用窗口（自绘界面）时，第一次自动补一张截图：同一个结果里文字和图像一起给，
      // 省掉模型先读一次、再决定要不要截的来回。屏恢复可读后清掉标记，下次再遇到还能自动补。
      const gs = guardStateFor(ctx);
      if (data && data.treeUnreadable === true) {
        if (supports(service, deviceId, 'screen.screenshot') && !gs.autoShot.has(sessionId)) {
          gs.autoShot.set(sessionId, true);
          try {
            const shot = await captureImage(service, deviceId, sessionId, 'phone-screen', exec.signal);
            value.image = shot.image;
            notes.push('读屏读不出应用窗口，已自动附一张截图。');
          } catch { /* 截图失败不影响已经拿到的文字 */ }
        }
      } else if (gs.autoShot.has(sessionId)) {
        gs.autoShot.delete(sessionId);
      }

      const note = notes.filter((n) => typeof n === 'string' && n).join(' ');
      if (note) value.note = note;
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
      const shot = await captureImage(service, deviceId, sessionId, args.target, exec.signal);
      // 有值才塞键：宿主不接受值为 undefined 的字段（见 A3-79 的坑）。
      return {
        deviceId,
        width: shot.width,
        height: shot.height,
        note: mentionMismatch(sessionId, deviceId),
        image: shot.image,
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
          // 「没执行」的原因码：付款那一步没拿到用户确认时就只有它。
          blocked: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ok === false ? `这一步没有执行：${value.note || '见说明'}。` : `已点击。\n${summarizeScreen(value)}` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const hasRef = typeof args.ref === 'string' && args.ref.trim();
      const hasPoint = Number.isFinite(args.x) && Number.isFinite(args.y);
      if (!hasRef && !hasPoint) throw new Error('要么给 ref（phone_screen 里的元素编号），要么给 x / y 百分比。');
      if (hasRef && hasPoint) throw new Error('ref 和坐标只能给一样：有 ref 就按元素点。');
      if (!hasRef && !textOf(args.target, MAX_TEXT)) throw new Error('按坐标点的时候要说明点的是什么（target）。');
      const target = textOf(args.target, MAX_TEXT);
      const ref = hasRef ? args.ref.trim() : '';
      const tapArgs = {
        ref,
        x: hasPoint ? args.x : null,
        y: hasPoint ? args.y : null,
        target,
      };
      const notes = [mentionMismatch(sessionId, deviceId)];

      // 付款 / 下单：先拿到人点的「同意」才按下去。判定用模型给的 ref + target，
      // 而 target 是这一下点的是什么 —— 模型按 phone_screen 里的文字填，词表在
      // irreversible.js，这里只认 kind === 'payment' 那一类。
      const judged = judgeIrreversible('tap', { ref, x: args.x, y: args.y, target }, '');
      if (judged && confirm.needsConfirmation(judged)) {
        const blocked = await requirePaymentConfirmation(sessionId, exec, `在手机上点「${target || ref}」`);
        if (blocked) {
          // 不执行、也不抛：抛会把「问过用户、用户没同意」做成一次工具失败，模型会当成
          // 手机坏了去重试。如实回一句「没做，为什么」才是它该看到的东西。
          return { ok: false, blocked: 'payment-confirmation', note: blocked };
        }
        notes.push('这一步是付款 / 下单，用户已经确认过一次，就这一下有效。');
      }

      const { data, note: retried } = await runWithStaleRetry(service, deviceId, sessionId, 'tap', tapArgs, exec.signal);
      if (retried) notes.push(retried);
      // 单步本来就是做不可逆动作的正确姿势（批里会被熔断）。这里给一句确认，让模型知道
      // 这一下为什么该单独做、做之前最好再核一眼。
      if (judged && judged.irreversible && !confirm.needsConfirmation(judged)) {
        notes.push(`这一步看起来不可逆（${judged.reason}），已经作为单独一步执行；接着看结果再决定下一步。`);
      }
      const value = {
        ok: true,
        packageName: textOf(data && data.packageName, MAX_TEXT),
        elements: Array.isArray(data && data.elements) ? data.elements.slice(0, 120) : [],
      };
      const note = notes.filter(Boolean).join(' ');
      if (note) value.note = note;
      return value;
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
      render: (_args, value) => [{ type: 'text', text: `已输入。\n${summarizeScreen(value)}` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const value = typeof args.text === 'string' ? args.text : '';
      if (!value) throw new Error('要输入的文字是空的。');
      const { data, note: retried } = await runWithStaleRetry(service, deviceId, sessionId, 'type', {
        text: value,
        ref: typeof args.ref === 'string' ? args.ref.trim() : '',
        submit: args.submit === true,
      }, exec.signal);
      const notes = [mentionMismatch(sessionId, deviceId)];
      if (retried) notes.push(retried);
      const result = {
        ok: true,
        packageName: textOf(data && data.packageName, MAX_TEXT),
        elements: Array.isArray(data && data.elements) ? data.elements.slice(0, 120) : [],
      };
      const note = notes.filter(Boolean).join(' ');
      if (note) result.note = note;
      return result;
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
      render: (_args, value) => [{ type: 'text', text: `已滚动。\n${summarizeScreen(value)}` }],
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
    description: 'Press one system key on the phone: back, home, enter, recents, tab (next field), paste, selectall, or delete. Nothing else — the power and volume buttons are the user\'s own and are never pressed.',
    parameters: {
      key: { type: 'string', required: true, enum: ['back', 'home', 'enter', 'recents', 'tab', 'paste', 'selectall', 'delete'], description: 'Which key to press.' },
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
      render: (_args, value) => [{ type: 'text', text: `已按键。\n${summarizeScreen(value)}` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const KEYS = ['back', 'home', 'enter', 'recents', 'tab', 'paste', 'selectall', 'delete'];
      const key = KEYS.includes(args.key) ? args.key : '';
      if (!key) throw new Error(`key 只能是 ${KEYS.join(' / ')}。`);
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
    name: 'phone_steps',
    description: 'Run several phone actions in one call, executed in order on the phone. Use it to save round-trips when you already know the next few steps (open an app, tap a search box, type, tap search). Give 1-20 steps; each step has action + args and an optional until to wait for the next screen. Do NOT put a payment step (pay, order, buy, checkout) in a batch — the batch will stop right before it and you must do that one step on its own with phone_tap, because it needs the user to confirm. Sending, submitting and deleting are fine to batch. If a step fails the batch stops and tells you where.',
    parameters: {
      steps: {
        type: 'array',
        description: '1-20 steps run in order on the phone.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            action: { type: 'string', description: 'One single action: tap, type, swipe, key, app.open, app.close, screen.read, wait, or gesture. Never batch.' },
            args: { type: 'object', additionalProperties: true, description: 'Arguments for that action, same fields as the matching single tool.' },
            until: {
              type: 'object',
              additionalProperties: true,
              properties: {
                appears: { type: 'string', description: 'Wait until an element containing this text appears (case-insensitive).' },
                gone: { type: 'string', description: 'Wait until this text is no longer on screen.' },
                app: { type: 'string', description: 'Wait until this package is in front.' },
                stable: { type: 'boolean', description: 'Wait until the screen stops changing.' },
                timeoutMs: { type: 'number', description: 'Max wait for this step, default 8000, max 20000.' },
              },
            },
          },
        },
      },
      quiet: { type: 'boolean', description: 'Only return the final screen (default true). Set false to also get the screen after each step.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
          stoppedAt: { type: 'number' },
          stopReason: { type: 'string' },
          packageName: { type: 'string' },
          elements: { type: 'array', items: { type: 'object', additionalProperties: true } },
          revision: { type: 'number' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const ran = Array.isArray(value.steps) ? value.steps.length : 0;
        const bad = value.stopReason ? `，在第 ${Number.isInteger(value.stoppedAt) ? value.stoppedAt + 1 : '?'} 步停下（${value.stopReason}）` : '';
        return [{ type: 'text', text: `做了 ${ran} 步${bad}。` }];
      },
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const raw = Array.isArray(args.steps) ? args.steps : [];
      if (raw.length < 1 || raw.length > 20) throw new Error('steps 要给 1 到 20 步。');

      const steps = raw.map((step, i) => {
        if (!step || typeof step !== 'object') throw new Error(`第 ${i + 1} 步不是对象。`);
        const action = typeof step.action === 'string' ? step.action.trim() : '';
        if (!STEP_ACTIONS.has(action)) {
          throw new Error(`第 ${i + 1} 步的动作 ${action || '（空）'} 不能放进批量：只能是 ${[...STEP_ACTIONS].join(' / ')}。`);
        }
        const stepArgs = step.args && typeof step.args === 'object' ? step.args : {};
        const out = { action, args: stepArgs };
        if (step.until && typeof step.until === 'object') out.until = step.until;
        return out;
      });

      // 批里只熔断**付款 / 下单**这一类：批内没有确认的位置，而这一步要用户亲自点一次同意。
      // 发送 / 提交 / 删除不再熔断 —— 它们是任务本身要做的事，每一步都停下来问会让「发条消息」
      // 变成一串确认框；那几种的代价由节奏控制拉间隔（协议 7.3）。
      // 找到第一处就把停点之前的部分交给手机，停点与之后都留下。
      let blockedAt = -1;
      let blockedReason = '';
      for (let i = 0; i < steps.length; i += 1) {
        const s = steps[i];
        const text = typeof s.args.target === 'string' ? s.args.target : (typeof s.args.text === 'string' ? s.args.text : '');
        const judged = judgeIrreversible(s.action, s.args, text);
        if (judged && confirm.needsConfirmation(judged)) { blockedAt = i; blockedReason = judged.reason || ''; break; }
      }
      const runnable = blockedAt >= 0 ? steps.slice(0, blockedAt) : steps;

      const notes = [mentionMismatch(sessionId, deviceId)];
      if (blockedAt === 0) {
        // 第一步就要确认：这一批没有能跑的部分。不抛错 —— 抛错会被读成「批量坏了」，
        // 而事实是「这一步得单独做」，如实把这一批的结果写成「停在第一步」更贴切。
        const only = {
          ok: true,
          steps: [],
          stoppedAt: 0,
          stopReason: 'blocked-irreversible',
          note: `第 1 步是付款 / 下单（${blockedReason}），批里不执行它。请把这一步单独做（phone_tap），它会走一次用户确认；其余步骤再另起一批。`,
        };
        return only;
      }
      if (blockedAt > 0) {
        notes.push(`第 ${blockedAt + 1} 步是付款 / 下单（${blockedReason}），没有放进这一批：它要在这一批之后单独做，单独走一次确认。`);
      }

      const canBatch = supports(service, deviceId, 'batch');
      const stepResults = [];
      let stoppedAt = null;
      let stopReason = '';
      let finalData = null;

      if (canBatch) {
        // 只把**停点之前**那几步交给手机。也可以把付款那步连同标记一起发过去、让手机自己停
        // （它认 `irreversible`），但那条路要求手机版本跟得上；发不过去的旧版本会直接把这步
        // 执行掉 —— 一次没人确认的付款不能押在「对方版本够新」上。切片在插件这边做，任何
        // 版本的手机都只会收到它该做的那几步。
        const batchArgs = {
          steps: runnable.map((s) => ({ action: s.action, args: s.args, ...(s.until ? { until: s.until } : {}) })),
          quiet: args.quiet !== false,
          // 节奏跟着批一起下去：mode 来自设置三档，place 来自 App 知识；手机侧在批循环里消费（协议 §1.2 / §3.3）。
          pacing: { mode: pacingModeOf(), place: batchPlaceOf(runnable) },
        };
        const data = await run(service, deviceId, sessionId, 'batch', batchArgs, exec.signal);
        finalData = data;
        const list = Array.isArray(data && data.steps) ? data.steps : [];
        for (const st of list) {
          const row = { index: st && st.index, action: st && st.action, ok: Boolean(st && st.ok === true) };
          if (st && Number.isFinite(st.waitedMs)) row.waitedMs = st.waitedMs;
          if (st && st.wait && typeof st.wait === 'object') row.wait = { met: st.wait.met === true, stopped: st.wait.stopped == null ? null : st.wait.stopped };
          if (st && typeof st.effect === 'string') row.effect = st.effect;
          if (st && st.error && typeof st.error === 'object') {
            row.error = {
              code: typeof st.error.code === 'string' ? st.error.code : 'failed',
              message: typeof st.error.message === 'string' ? st.error.message : '',
            };
          }
          stepResults.push(row);
        }
        if (data && data.stoppedAt != null) stoppedAt = data.stoppedAt;
        if (data && typeof data.stopReason === 'string' && data.stopReason) stopReason = data.stopReason;
        // 手机那边跑完了前面那几步、没别的原因停下：停点就是付款那一步（编号按原始 steps 算，
        // 因为切片是前缀，两边编号一致）。
        if (blockedAt >= 0 && stopReason === '') {
          stoppedAt = blockedAt;
          stopReason = 'blocked-irreversible';
        }
      } else {
        // 手机没报 batch 能力：退回逐步执行。慢一点，但任务能完成；并如实说一句。
        notes.push(`${unsupportedNote('一次多步（批量）')} 已改为逐步执行，会慢一些。`);
        const canNativeWait = supports(service, deviceId, 'screen.wait');
        for (let i = 0; i < runnable.length; i += 1) {
          if (i > 0) await sleep(betweenDelay());
          const s = runnable[i];
          try {
            await run(service, deviceId, sessionId, s.action, s.args, exec.signal);
          } catch (error) {
            const message = String((error && error.message) || error);
            const code = /不支持/.test(message) ? 'unsupported' : (/断开/.test(message) ? 'offline' : 'step-failed');
            stepResults.push({ index: i, action: s.action, ok: false, error: { code, message } });
            stoppedAt = i;
            stopReason = 'step-failed';
            break;
          }
          const row = { index: i, action: s.action, ok: true };
          if (s.until) {
            const w = await waitCondition(service, deviceId, sessionId, s.until, exec.signal, canNativeWait);
            row.waitedMs = w.waitedMs;
            row.wait = { met: w.met, stopped: w.stopped == null ? null : w.stopped };
          }
          stepResults.push(row);
        }
        try {
          finalData = await run(service, deviceId, sessionId, 'screen.read', { includeText: true }, exec.signal);
        } catch { /* 拿不到最终屏就给空，别把整批判成失败 */ }
        // 逐步执行这条路上停点由插件自己定：跑完了能跑的那几步、停在付款那一步之前。
        if (blockedAt >= 0 && stopReason === '') {
          stoppedAt = runnable.length;
          stopReason = 'blocked-irreversible';
        }
      }

      const value = { ok: stopReason !== 'step-failed', steps: stepResults };
      if (stoppedAt !== null) value.stoppedAt = stoppedAt;
      if (stopReason) value.stopReason = stopReason;
      if (finalData && typeof finalData.packageName === 'string') value.packageName = textOf(finalData.packageName, MAX_TEXT);
      if (finalData && Array.isArray(finalData.elements)) value.elements = finalData.elements.slice(0, 200);
      if (finalData && Number.isFinite(finalData.revision)) value.revision = finalData.revision;
      // 批量结果同样附一次 App 用法知识：`noteFor` 的去重账与 phone_screen 是同一份，
      // 同一对话同一 App 不管先从哪条路看到，都只附一遍（协议 7.5）。
      if (phoneKnowledge && typeof phoneKnowledge.noteFor === 'function') {
        try {
          const knowledge = phoneKnowledge.noteFor(sessionId, finalData && finalData.packageName);
          if (knowledge) notes.push(knowledge);
        } catch { /* 知识是锦上添花，读坏了不影响这一批的结果 */ }
      }
      const note = notes.filter((n) => typeof n === 'string' && n).join(' ');
      if (note) value.note = note;
      return value;
    },
  });

  register({
    name: 'phone_wait',
    description: 'Wait until the screen reaches a condition, using the phone\'s accessibility events instead of polling. Use it after an action that loads something (a search, a page open) instead of taking repeated screenshots. Give at least one of appears / gone / app / stable. Returns met=true or met=false on timeout.',
    parameters: {
      appears: { type: 'string', description: 'Wait until an element containing this text appears (case-insensitive).' },
      gone: { type: 'string', description: 'Wait until this text is no longer on screen.' },
      app: { type: 'string', description: 'Wait until this package is in front.' },
      stable: { type: 'boolean', description: 'Wait until the screen stops changing.' },
      timeoutMs: { type: 'number', description: 'Max wait in ms, default 8000, max 20000.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          met: { type: 'boolean' },
          stopped: { type: 'string' },
          waitedMs: { type: 'number' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.met ? `条件成立（等了 ${value.waitedMs || 0}ms）。` : '等超时了，条件没成立。' }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const until = {};
      if (typeof args.appears === 'string' && args.appears.trim()) until.appears = args.appears;
      if (typeof args.gone === 'string' && args.gone.trim()) until.gone = args.gone;
      if (typeof args.app === 'string' && args.app.trim()) until.app = args.app;
      if (args.stable === true) until.stable = true;
      until.timeoutMs = clampTimeoutMs(args.timeoutMs);
      if (until.appears === undefined && until.gone === undefined && until.app === undefined && until.stable !== true) {
        throw new Error('要等什么？给 appears / gone / app / stable 其中至少一个。');
      }
      const canNative = supports(service, deviceId, 'screen.wait');
      const w = await waitCondition(service, deviceId, sessionId, until, exec.signal, canNative);
      const value = { met: w.met };
      if (w.stopped != null) value.stopped = w.stopped;
      if (Number.isFinite(w.waitedMs)) value.waitedMs = w.waitedMs;
      const notes = [mentionMismatch(sessionId, deviceId)];
      if (!canNative) notes.push(`${unsupportedNote('等条件（screen.wait）')} 这次是轮询读屏等到的，会慢一些。`);
      const note = notes.filter(Boolean).join(' ');
      if (note) value.note = note;
      return value;
    },
  });

  register({
    name: 'phone_gesture',
    description: 'Send a finger gesture the simple tools cannot express: a long press, a drag along a path, or a two-finger pinch. Coordinates are viewport percentages (x 0-100 left-to-right, y 0-100 top-to-bottom). Give 1-2 strokes; each stroke is a list of points; a long press is one point with holdMs 500-800; two strokes at once is a pinch.',
    parameters: {
      strokes: {
        type: 'array',
        description: '1-2 finger strokes, done at the same time.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            points: {
              type: 'array',
              description: '2-32 points the finger moves through, each { x, y } in 0-100 percent.',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  x: { type: 'number', description: 'Horizontal position, 0-100 percent of screen width.' },
                  y: { type: 'number', description: 'Vertical position, 0-100 percent of screen height.' },
                },
              },
            },
            holdMs: { type: 'number', description: 'How long to hold at the first point before moving, in ms. Use 500-800 for a long press.' },
            startMs: { type: 'number', description: 'Delay before this stroke starts, in ms (to stagger strokes).' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          packageName: { type: 'string' },
          elements: { type: 'array', items: { type: 'object', additionalProperties: true } },
          note: { type: 'string' },
        },
      },
      render: () => [{ type: 'text', text: '已做手势。' }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const raw = Array.isArray(args.strokes) ? args.strokes : [];
      if (raw.length < 1 || raw.length > 2) throw new Error('strokes 要给 1 到 2 段。');
      const strokes = raw.map((stroke, i) => {
        if (!stroke || typeof stroke !== 'object') throw new Error(`第 ${i + 1} 段手势格式不对，要是 { points: [...] }。`);
        const pts = Array.isArray(stroke.points) ? stroke.points : [];
        if (pts.length < 2 || pts.length > 32) throw new Error(`第 ${i + 1} 段手势要有 2 到 32 个点。`);
        const points = pts.map((p, j) => {
          const x = Number(p && p.x);
          const y = Number(p && p.y);
          if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) {
            throw new Error(`第 ${i + 1} 段第 ${j + 1} 个点要是 0 到 100 的百分比坐标。`);
          }
          return { x, y };
        });
        const out = { points };
        if (Number.isFinite(stroke.holdMs)) out.holdMs = Math.max(0, Math.min(5000, Math.round(stroke.holdMs)));
        if (Number.isFinite(stroke.startMs)) out.startMs = Math.max(0, Math.min(3000, Math.round(stroke.startMs)));
        return out;
      });
      const data = await run(service, deviceId, sessionId, 'gesture', { strokes }, exec.signal);
      const notes = [mentionMismatch(sessionId, deviceId)];
      if (!supports(service, deviceId, 'gesture.multi')) notes.push(`${unsupportedNote('多指手势')} 单段手势仍会尝试，失败就以提示为准。`);
      const value = {
        ok: true,
        packageName: textOf(data && data.packageName, MAX_TEXT),
        elements: Array.isArray(data && data.elements) ? data.elements.slice(0, 120) : [],
      };
      const note = notes.filter(Boolean).join(' ');
      if (note) value.note = note;
      return value;
    },
  });

  register({
    name: 'phone_open_link',
    description: 'Open a link or a system page by kind. kind=uri opens a web or app link (only http/https and common app schemes); kind=settings opens one standard Android settings page from a fixed list; kind=package opens an app\'s details page in system settings. Use it for system settings and app-info pages instead of hunting through menus. It cannot open arbitrary intents.',
    parameters: {
      kind: { type: 'string', required: true, enum: ['uri', 'settings', 'package'], description: 'What to open.' },
      uri: { type: 'string', description: 'For kind=uri: the link, e.g. https://example.com or a common app scheme.' },
      action: { type: 'string', description: 'For kind=settings: the Android settings action name, e.g. android.settings.WIFI_SETTINGS.' },
      packageName: { type: 'string', description: 'For kind=package (and app-details settings): the Android package name.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          packageName: { type: 'string' },
          elements: { type: 'array', items: { type: 'object', additionalProperties: true } },
          note: { type: 'string' },
        },
      },
      render: () => [{ type: 'text', text: '已打开链接/页面。' }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const kind = ['uri', 'settings', 'package'].includes(args.kind) ? args.kind : '';
      if (!kind) throw new Error('kind 只能是 uri / settings / package。');
      const linkArgs = { kind };
      if (kind === 'uri') {
        const uri = textOf(args.uri, 2000);
        if (!uri) throw new Error('kind=uri 时要给 uri。');
        const scheme = uri.includes(':') ? uri.split(':')[0].toLowerCase() : '';
        if (!URI_SCHEMES.has(scheme)) {
          throw new Error(`不打开这个 scheme（${scheme || '无'}）。只放行 http / https / tel / mailto / sms / geo / market 这类常见入口。`);
        }
        linkArgs.uri = uri;
      } else if (kind === 'settings') {
        const action = textOf(args.action, 200);
        if (!SETTINGS_ACTIONS.has(action)) throw new Error(`这个设置入口不在白名单里：${action || '（空）'}。`);
        linkArgs.action = action;
        if (action === 'android.settings.APPLICATION_DETAILS_SETTINGS') {
          const pkg = textOf(args.packageName, 200);
          if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(pkg)) throw new Error('打开某个 App 的详情页时要带合法的 packageName。');
          linkArgs.packageName = pkg;
        }
      } else {
        const pkg = textOf(args.packageName, 200);
        if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(pkg)) throw new Error('packageName 看起来不像安卓包名。');
        linkArgs.packageName = pkg;
      }
      const data = await run(service, deviceId, sessionId, 'app.link', linkArgs, exec.signal);
      const notes = [mentionMismatch(sessionId, deviceId)];
      if (!supports(service, deviceId, 'app.link')) notes.push(unsupportedNote('按类别打开链接（app.link）'));
      const value = {
        ok: true,
        packageName: textOf(data && data.packageName, MAX_TEXT),
        elements: Array.isArray(data && data.elements) ? data.elements.slice(0, 120) : [],
      };
      const note = notes.filter(Boolean).join(' ');
      if (note) value.note = note;
      return value;
    },
  });

  register({
    name: 'phone_scroll_to',
    description: 'Scroll the screen until an element containing the given text is visible, then return its ref so you can tap it. It reads and swipes at most 8 times. Use it for a long list or search results when the target is not on the current screen; do not use it to read a whole page (use phone_screen). If it returns found=false, the text was not reached — say so rather than guessing.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text on the element to scroll to (case-insensitive substring).' },
      direction: { type: 'string', enum: ['up', 'down'], description: 'Where the target is: down means scroll down to see lower content (default down).' },
      maxScrolls: { type: 'integer', description: 'How many swipes to try at most, 1-8 (default 8).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean' },
          ref: { type: 'string' },
          text: { type: 'string' },
          packageName: { type: 'string' },
          scrolls: { type: 'number' },
          elements: { type: 'array', items: { type: 'object', additionalProperties: true } },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.found ? `找到了（${value.text || value.ref}）。` : '滚到头也没找到。' }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const query = textOf(args.text, 200);
      if (!query) throw new Error('要滚到哪个元素？给 text（元素上的文字）。');
      const direction = args.direction === 'up' ? 'up' : 'down';
      const maxScrolls = Number.isInteger(args.maxScrolls) ? Math.min(8, Math.max(1, args.maxScrolls)) : 8;
      const needle = query.toLowerCase();
      let found = null;
      let scrolls = 0;
      let packageName = '';
      let lastSig = '';
      let unchanged = 0;
      let elements = [];
      for (let i = 0; ; i += 1) {
        const data = await run(service, deviceId, sessionId, 'screen.read', { includeText: true }, exec.signal);
        packageName = textOf(data && data.packageName, MAX_TEXT) || packageName;
        elements = Array.isArray(data && data.elements) ? data.elements : [];
        found = elements.find((el) => elementText(el).toLowerCase().includes(needle)) || null;
        if (found) break;
        const sig = screenSignature({ packageName: data && data.packageName, elements });
        unchanged = sig === lastSig ? unchanged + 1 : 0;
        lastSig = sig;
        if (unchanged >= 2 || scrolls >= maxScrolls) break;
        await run(service, deviceId, sessionId, 'swipe', { direction, amount: 0.7 }, exec.signal);
        scrolls += 1;
      }
      const notes = [mentionMismatch(sessionId, deviceId)];
      if (!found) notes.push(`滚了 ${scrolls} 次也没找到「${query}」，如实说没找到，别猜它在哪。`);
      const value = { found: Boolean(found), scrolls, packageName, elements: elements.slice(0, 120) };
      if (found && found.ref) value.ref = String(found.ref);
      if (found) value.text = elementText(found).slice(0, MAX_TEXT);
      const note = notes.filter(Boolean).join(' ');
      if (note) value.note = note;
      return value;
    },
  });

  // ── 结构化：提取 / 查询 / 查找 / 采集 / 滚轮 ──────────────────────────────

  register({
    name: 'phone_extract',
    description: 'Extract structured data from the current screen in one read on the phone. mode=text pulls visible text; mode=list groups a scrollable list/recycler into rows with bounds and parents; mode=form returns only editable fields (secret fields show a boolean, never the value). It reads the accessibility tree on the phone, so list rows beyond the first 160 elements come back with bounds but no tappable ref (best-effort).',
    parameters: {
      mode: { type: 'string', enum: ['text', 'list', 'form'], description: 'What to extract: text, list rows, or form fields.' },
      maxItems: { type: 'integer', description: 'Maximum records, 1-200 (default 100).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string' },
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
          count: { type: 'number' },
          truncated: { type: 'boolean' },
          packageName: { type: 'string' },
          revision: { type: 'number' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `提取了 ${value.count || 0} 条（${value.mode || ''}）${value.truncated ? '，已截断' : ''}。` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const mode = ['text', 'list', 'form'].includes(args.mode) ? args.mode : 'text';
      const maxItems = Number.isInteger(args.maxItems) ? Math.min(200, Math.max(1, args.maxItems)) : 100;
      const data = await run(service, deviceId, sessionId, 'extract', { mode, maxItems }, exec.signal);
      const notes = [mentionMismatch(sessionId, deviceId)];
      if (!supports(service, deviceId, 'extract')) notes.push(unsupportedNote('结构化提取（extract）'));
      const value = {
        ok: true,
        mode,
        items: Array.isArray(data && data.items) ? data.items : [],
        count: Number.isFinite(data && data.count) ? data.count : (Array.isArray(data && data.items) ? data.items.length : 0),
        truncated: Boolean(data && data.truncated),
      };
      if (data && typeof data.packageName === 'string' && data.packageName) value.packageName = textOf(data.packageName, MAX_TEXT);
      if (data && Number.isFinite(data.revision)) value.revision = data.revision;
      const note = notes.filter(Boolean).join(' ');
      if (note) value.note = note;
      return value;
    },
  });

  register({
    name: 'phone_query',
    description: 'Find controls on the current screen by text, resource id, or role without scrolling, returning ref, bounds, parents and whether each is clickable/editable. Use it when the same text appears many places or a control has no visible label. limit up to 100 (default 30).',
    parameters: {
      text: { type: 'string', description: 'Case-insensitive text or accessibility description to find.' },
      resourceId: { type: 'string', description: 'Full or partial Android resource id to find.' },
      role: { type: 'string', description: 'Full or partial role/class to find.' },
      limit: { type: 'integer', description: 'Maximum results, 1-100 (default 30).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          total: { type: 'number' },
          truncated: { type: 'boolean' },
          matches: { type: 'array', items: { type: 'object', additionalProperties: true } },
          packageName: { type: 'string' },
          revision: { type: 'number' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `找到 ${value.total || 0} 个匹配（返回 ${Array.isArray(value.matches) ? value.matches.length : 0} 条）。` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const queryArgs = {};
      if (typeof args.text === 'string' && args.text.trim()) queryArgs.text = textOf(args.text, 200);
      if (typeof args.resourceId === 'string' && args.resourceId.trim()) queryArgs.resourceId = textOf(args.resourceId, 200);
      if (typeof args.role === 'string' && args.role.trim()) queryArgs.role = textOf(args.role, 100);
      if (!queryArgs.text && !queryArgs.resourceId && !queryArgs.role) {
        throw new Error('要查什么？给 text / resourceId / role 其中至少一个。');
      }
      queryArgs.limit = Number.isInteger(args.limit) ? Math.min(100, Math.max(1, args.limit)) : 30;
      const data = await run(service, deviceId, sessionId, 'query', queryArgs, exec.signal);
      const notes = [mentionMismatch(sessionId, deviceId)];
      if (!supports(service, deviceId, 'query')) notes.push(unsupportedNote('按字段查询（query）'));
      const value = {
        ok: true,
        total: Number.isFinite(data && data.total) ? data.total : 0,
        truncated: Boolean(data && data.truncated),
        matches: Array.isArray(data && data.matches) ? data.matches : [],
      };
      if (data && typeof data.packageName === 'string' && data.packageName) value.packageName = textOf(data.packageName, MAX_TEXT);
      if (data && Number.isFinite(data.revision)) value.revision = data.revision;
      const note = notes.filter(Boolean).join(' ');
      if (note) value.note = note;
      return value;
    },
  });

  register({
    name: 'phone_find',
    description: 'Scroll on the phone until an element matching text/resourceId/role is visible, then return its ref. It reads, matches, swipes and waits for the screen to settle in a loop on the phone. Stopped reason is one of found / screen_needs_review / app_switched / content_unchanged / scroll_limit / read_failed. maxScrolls 1-200 (default 30).',
    parameters: {
      text: { type: 'string', description: 'Text or accessibility description to find.' },
      resourceId: { type: 'string', description: 'Full or partial Android resource id.' },
      role: { type: 'string', description: 'Full or partial role/class.' },
      direction: { type: 'string', enum: ['up', 'down'], description: 'Where the target is: down means scroll down to see lower content (default down).' },
      maxScrolls: { type: 'integer', description: 'Maximum scrolls, 1-200 (default 30).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          found: { type: 'boolean' },
          stoppedBecause: { type: 'string' },
          scrolls: { type: 'number' },
          match: { type: 'object', additionalProperties: true },
          packageName: { type: 'string' },
          revision: { type: 'number' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.found ? '找到了。' : `没找到（${value.stoppedBecause || '未知'}，滚了 ${value.scrolls || 0} 次）。` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const findArgs = { direction: args.direction === 'up' ? 'up' : 'down' };
      if (typeof args.text === 'string' && args.text.trim()) findArgs.text = textOf(args.text, 200);
      if (typeof args.resourceId === 'string' && args.resourceId.trim()) findArgs.resourceId = textOf(args.resourceId, 200);
      if (typeof args.role === 'string' && args.role.trim()) findArgs.role = textOf(args.role, 100);
      if (!findArgs.text && !findArgs.resourceId && !findArgs.role) throw new Error('要找什么？给 text / resourceId / role 其中至少一个。');
      findArgs.maxScrolls = Number.isInteger(args.maxScrolls) ? Math.min(200, Math.max(1, args.maxScrolls)) : 30;
      const data = await run(service, deviceId, sessionId, 'find', findArgs, exec.signal);
      const notes = [mentionMismatch(sessionId, deviceId)];
      if (!supports(service, deviceId, 'find')) notes.push(unsupportedNote('滚动查找（find）'));
      const value = {
        ok: Boolean(data && data.found),
        found: Boolean(data && data.found),
        stoppedBecause: textOf(data && data.stoppedBecause, 40) || 'scroll_limit',
        scrolls: Number.isFinite(data && data.scrolls) ? data.scrolls : 0,
      };
      if (data && data.match && typeof data.match === 'object') value.match = data.match;
      if (data && typeof data.packageName === 'string' && data.packageName) value.packageName = textOf(data.packageName, MAX_TEXT);
      if (data && Number.isFinite(data.revision)) value.revision = data.revision;
      if (!value.found) notes.push(`滚了 ${value.scrolls} 次也没找到（${value.stoppedBecause}），如实说没找到，别猜它在哪。`);
      const note = notes.filter(Boolean).join(' ');
      if (note) value.note = note;
      return value;
    },
  });

  register({
    name: 'phone_collect',
    description: 'Scroll 1-30 screens and merge the text across them with de-duplication on the phone, returning one merged list. Use it to read a long list or chat without one round-trip per screen. Has both a maxItems and a 50KB byte cap.',
    parameters: {
      direction: { type: 'string', enum: ['up', 'down'], description: 'Direction of newer content: up or down (default down).' },
      pages: { type: 'integer', description: 'Maximum screens to inspect, 1-30 (default 10).' },
      maxItems: { type: 'integer', description: 'Maximum lines to return, 1-1000 (default 300).' },
      fromY: { type: 'integer', description: 'Top of the content area, normalized 0-999 (default 50).' },
      toY: { type: 'integer', description: 'Bottom of the content area, normalized 0-999 (default 950).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          pagesInspected: { type: 'number' },
          scrolls: { type: 'number' },
          stoppedBecause: { type: 'string' },
          count: { type: 'number' },
          items: { type: 'array', items: { type: 'string' } },
          text: { type: 'string' },
          truncated: { type: 'boolean' },
          currentApp: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `采集了 ${value.pagesInspected || 0} 屏，合并 ${value.count || 0} 行（${value.stoppedBecause || ''}）${value.truncated ? '，已截断' : ''}。` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const collectArgs = {
        direction: args.direction === 'up' ? 'up' : 'down',
        pages: Number.isInteger(args.pages) ? Math.min(30, Math.max(1, args.pages)) : 10,
        maxItems: Number.isInteger(args.maxItems) ? Math.min(1000, Math.max(1, args.maxItems)) : 300,
        fromY: Number.isInteger(args.fromY) ? Math.min(999, Math.max(0, args.fromY)) : 50,
        toY: Number.isInteger(args.toY) ? Math.min(999, Math.max(0, args.toY)) : 950,
      };
      const data = await run(service, deviceId, sessionId, 'collect', collectArgs, exec.signal);
      const notes = [mentionMismatch(sessionId, deviceId)];
      if (!supports(service, deviceId, 'collect')) notes.push(unsupportedNote('多屏采集（collect）'));
      const items = Array.isArray(data && data.items) ? data.items.map((x) => String(x)) : [];
      const value = {
        ok: Boolean(data && data.ok !== false),
        pagesInspected: Number.isFinite(data && data.pagesInspected) ? data.pagesInspected : 0,
        scrolls: Number.isFinite(data && data.scrolls) ? data.scrolls : 0,
        stoppedBecause: textOf(data && data.stoppedBecause, 40) || 'page_limit',
        count: Number.isFinite(data && data.count) ? data.count : items.length,
        items,
        text: textOf(data && data.text, 50_000) || items.join('\n'),
        truncated: Boolean(data && data.truncated),
      };
      if (data && typeof data.currentApp === 'string' && data.currentApp) value.currentApp = textOf(data.currentApp, MAX_TEXT);
      const note = notes.filter(Boolean).join(' ');
      if (note) value.note = note;
      return value;
    },
  });

  register({
    name: 'phone_wheel',
    description: 'Turn a wheel picker (time / date / region) straight to a value in one call. The phone reads the column, scrolls or drags, and reads back to verify. Give ref (from phone_screen) and value. Error codes: not_a_wheel, wheel_at_end, wheel_unreadable, wheel_not_moving.',
    parameters: {
      ref: { type: 'string', required: true, description: 'Element ref of the wheel column (from phone_screen).' },
      value: { type: 'string', required: true, description: 'The value to reach, e.g. "14", "30", "November".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          reached: { type: 'boolean' },
          target: { type: 'string' },
          value: { type: 'string' },
          from: { type: 'string' },
          attempts: { type: 'number' },
          method: { type: 'string' },
          error: { type: 'object', additionalProperties: true },
          effect: { type: 'string' },
          packageName: { type: 'string' },
          elements: { type: 'array', items: { type: 'object', additionalProperties: true } },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.reached ? `已转到 ${value.value || value.target}。` : `没转到位：${value.error ? value.error.code : '未知'}。` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const ref = textOf(args.ref, 40);
      const target = textOf(args.value, 100);
      if (!ref) throw new Error('给滚轮那一列的 ref（phone_screen 里的编号）。');
      if (!target) throw new Error('要转到哪个值？给 value。');
      const data = await run(service, deviceId, sessionId, 'wheel.set', { ref, value: target }, exec.signal);
      const notes = [mentionMismatch(sessionId, deviceId)];
      if (!supports(service, deviceId, 'wheel.set')) notes.push(unsupportedNote('滚轮选择器（wheel.set）'));
      const value = {
        ok: Boolean(data && data.reached),
        reached: Boolean(data && data.reached),
        target,
        attempts: Number.isFinite(data && data.attempts) ? data.attempts : 0,
        method: textOf(data && data.method, 20) || 'none',
      };
      if (data && typeof data.value === 'string') value.value = data.value;
      if (data && typeof data.from === 'string') value.from = data.from;
      if (data && data.error && typeof data.error === 'object') value.error = data.error;
      if (data && typeof data.effect === 'string') value.effect = data.effect;
      if (data && typeof data.packageName === 'string' && data.packageName) value.packageName = textOf(data.packageName, MAX_TEXT);
      if (data && Array.isArray(data.elements)) value.elements = data.elements.slice(0, 120);
      const note = notes.filter(Boolean).join(' ');
      if (note) value.note = note;
      return value;
    },
  });

  // ── 分享文字 / 系统动作 / App 去留 ────────────────────────────────────────

  register({
    name: 'phone_share_text',
    description: 'Share a piece of text to an app via ACTION_SEND (text/plain), landing on that app\'s share page. Parameters are only the package and the text.',
    parameters: {
      packageName: { type: 'string', required: true, description: 'Android package name of the app to share into.' },
      text: { type: 'string', required: true, description: 'The text to share.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          packageName: { type: 'string' },
          handledBy: { type: 'string' },
          effect: { type: 'string' },
          elements: { type: 'array', items: { type: 'object', additionalProperties: true } },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已把文字分享到 ${value.packageName || '那个 App'}。` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const pkg = textOf(args.packageName, 200);
      if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(pkg)) throw new Error('packageName 看起来不像安卓包名。');
      const body = textOf(args.text, 20_000);
      if (!body) throw new Error('要分享的文字是空的。');
      const data = await run(service, deviceId, sessionId, 'share.text', { packageName: pkg, text: body }, exec.signal);
      const notes = [mentionMismatch(sessionId, deviceId)];
      if (!supports(service, deviceId, 'share.text')) notes.push(unsupportedNote('分享文字（share.text）'));
      const value = {
        ok: true,
        packageName: pkg,
        handledBy: textOf(data && data.share && data.share.handledBy, 200) || pkg,
      };
      if (data && typeof data.effect === 'string') value.effect = data.effect;
      if (data && Array.isArray(data.elements)) value.elements = data.elements.slice(0, 120);
      const note = notes.filter(Boolean).join(' ');
      if (note) value.note = note;
      return value;
    },
  });

  const weekdayNames = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const systemNotes = (sessionId, deviceId, cap) => {
    const notes = [mentionMismatch(sessionId, deviceId)];
    if (!supports(service, deviceId, cap)) notes.push(unsupportedNote('这类系统动作'));
    return notes;
  };

  register({
    name: 'phone_set_alarm',
    description: 'Set an alarm through the standard Android clock interface without touching its UI. If no clock app handles it, returns not-supported and you should fall back to operating the UI.',
    parameters: {
      hour: { type: 'integer', required: true, description: 'Hour of day, 0-23.' },
      minute: { type: 'integer', required: true, description: 'Minute, 0-59.' },
      label: { type: 'string', description: 'Optional label shown with the alarm.' },
      days: { type: 'array', items: { type: 'string' }, description: 'Optional repeat days: MON..SUN. Omit for a one-time alarm.' },
      vibrate: { type: 'boolean', description: 'Optional: vibrate when it rings.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          requested: { type: 'object', additionalProperties: true },
          handledBy: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已把闹钟交给 ${value.handledBy || '时钟 App'}。` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      if (!Number.isInteger(args.hour) || args.hour < 0 || args.hour > 23) throw new Error('hour 要是 0-23 的整数。');
      if (!Number.isInteger(args.minute) || args.minute < 0 || args.minute > 59) throw new Error('minute 要是 0-59 的整数。');
      const payload = { hour: args.hour, minute: args.minute };
      if (typeof args.label === 'string' && args.label.trim()) payload.label = textOf(args.label, 100);
      if (Array.isArray(args.days) && args.days.length > 0) {
        const days = args.days.map((d) => {
          const idx = weekdayNames.indexOf(String(d).trim().toUpperCase().slice(0, 3));
          if (idx < 0) throw new Error(`days 里只能是 ${weekdayNames.join(' / ')}。`);
          return idx + 1;
        });
        payload.days = [...new Set(days)].sort((a, b) => a - b);
      }
      if (args.vibrate === true) payload.vibrate = true;
      const data = await run(service, deviceId, sessionId, 'system.alarm', payload, exec.signal);
      const value = { ok: true, requested: { time: `${String(args.hour).padStart(2, '0')}:${String(args.minute).padStart(2, '0')}` } };
      if (payload.label) value.requested.label = payload.label;
      const handledBy = textOf(data && data.system && data.system.handledBy, 200);
      if (handledBy) value.handledBy = handledBy;
      const note = systemNotes(sessionId, deviceId, 'system.alarm').filter(Boolean).join(' ');
      if (note) value.note = note;
      return value;
    },
  });

  register({
    name: 'phone_set_timer',
    description: 'Start a timer through the standard Android clock interface without touching its UI. If no clock app handles it, returns not-supported and you should fall back to operating the UI.',
    parameters: {
      seconds: { type: 'integer', required: true, description: 'Length of the timer in seconds, 1-86400.' },
      label: { type: 'string', description: 'Optional label shown with the timer.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          requested: { type: 'object', additionalProperties: true },
          handledBy: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已把计时器交给 ${value.handledBy || '时钟 App'}。` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      if (!Number.isInteger(args.seconds) || args.seconds < 1 || args.seconds > 86400) throw new Error('seconds 要是 1-86400 的整数。');
      const payload = { seconds: args.seconds };
      if (typeof args.label === 'string' && args.label.trim()) payload.label = textOf(args.label, 100);
      const data = await run(service, deviceId, sessionId, 'system.timer', payload, exec.signal);
      const value = { ok: true, requested: { seconds: args.seconds } };
      if (payload.label) value.requested.label = payload.label;
      const handledBy = textOf(data && data.system && data.system.handledBy, 200);
      if (handledBy) value.handledBy = handledBy;
      const note = systemNotes(sessionId, deviceId, 'system.timer').filter(Boolean).join(' ');
      if (note) value.note = note;
      return value;
    },
  });

  register({
    name: 'phone_show_alarms',
    description: 'Open the clock app\'s alarm list on the phone so alarms can be inspected or edited there. If no clock app handles it, returns not-supported.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          handledBy: { type: 'string' },
          effect: { type: 'string' },
          elements: { type: 'array', items: { type: 'object', additionalProperties: true } },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已打开闹钟列表（${value.handledBy || '时钟 App'}）。` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const data = await run(service, deviceId, sessionId, 'system.show_alarms', {}, exec.signal);
      const value = { ok: true };
      const handledBy = textOf(data && data.system && data.system.handledBy, 200);
      if (handledBy) value.handledBy = handledBy;
      if (data && typeof data.effect === 'string') value.effect = data.effect;
      if (data && Array.isArray(data.elements)) value.elements = data.elements.slice(0, 120);
      const note = systemNotes(sessionId, deviceId, 'system.show_alarms').filter(Boolean).join(' ');
      if (note) value.note = note;
      return value;
    },
  });

  register({
    name: 'phone_add_calendar_event',
    description: 'Open a pre-filled new-event page in the calendar app (nothing is saved until you tap save there). Standard Android Intent, no calendar permission needed. If no calendar app handles it, returns not-supported.',
    parameters: {
      title: { type: 'string', required: true, description: 'Event title.' },
      start: { type: 'string', required: true, description: 'Start as local date-time yyyy-MM-ddTHH:mm, or a date yyyy-MM-dd with allDay=true.' },
      end: { type: 'string', description: 'Optional end, same format as start. Defaults to one hour after start (one day for all-day).' },
      allDay: { type: 'boolean', description: 'All-day event (default false).' },
      location: { type: 'string', description: 'Optional location.' },
      description: { type: 'string', description: 'Optional notes.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          requested: { type: 'object', additionalProperties: true },
          handledBy: { type: 'string' },
          effect: { type: 'string' },
          elements: { type: 'array', items: { type: 'object', additionalProperties: true } },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已打开新日程页（${value.handledBy || '日历 App'}），还没保存。` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const title = textOf(args.title, 200);
      if (!title) throw new Error('日程要有 title。');
      const allDay = args.allDay === true;
      const parseLocal = (raw) => {
        let s = String(raw || '').trim();
        if (!s) return null;
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += allDay ? 'T00:00' : 'T09:00';
        const ms = Date.parse(s);
        return Number.isFinite(ms) ? ms : null;
      };
      const beginMs = parseLocal(args.start);
      if (beginMs === null) throw new Error('start 要是 yyyy-MM-ddTHH:mm 或 yyyy-MM-dd。');
      let endMs = parseLocal(args.end);
      if (endMs === null || endMs <= beginMs) endMs = beginMs + (allDay ? 24 * 3_600_000 : 3_600_000);
      const payload = { title, beginMs, endMs, allDay };
      if (typeof args.location === 'string' && args.location.trim()) payload.location = textOf(args.location, 200);
      if (typeof args.description === 'string' && args.description.trim()) payload.description = textOf(args.description, 2000);
      const data = await run(service, deviceId, sessionId, 'system.calendar_insert', payload, exec.signal);
      const value = { ok: true, requested: { title, start: new Date(beginMs).toISOString().slice(0, 16).replace('T', ' ') } };
      if (allDay) value.requested.allDay = true;
      const handledBy = textOf(data && data.system && data.system.handledBy, 200);
      if (handledBy) value.handledBy = handledBy;
      if (data && typeof data.effect === 'string') value.effect = data.effect;
      if (data && Array.isArray(data.elements)) value.elements = data.elements.slice(0, 120);
      const note = systemNotes(sessionId, deviceId, 'system.calendar_insert').filter(Boolean).join(' ');
      if (note) value.note = note;
      return value;
    },
  });

  register({
    name: 'phone_app_after_task',
    description: 'Decide whether an app should be left running or closed when the task ends, with a reason. It only records the mark; nothing is touched now. Default (when unmarked) is to keep a quiet app in the background and close one that is playing sound.',
    parameters: {
      packageName: { type: 'string', required: true, description: 'Exact package name of the app.' },
      action: { type: 'string', required: true, enum: ['keep', 'close'], description: 'keep: leave it running after the task (even if playing sound). close: close it when the task ends.' },
      reason: { type: 'string', required: true, description: 'Why, in a few words.' },
      user: { type: 'integer', description: 'Only for another copy of the app (clone / work profile): that copy\'s user value. Leave out for the main app.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          packageName: { type: 'string' },
          action: { type: 'string' },
          replaces: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.packageName || '这个 App'} 任务后${value.action === 'close' ? '关掉' : '留着'}。` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec);
      const { deviceId, service } = targetOf(ctx, deps, sessionId);
      const pkg = textOf(args.packageName, 200);
      if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(pkg)) throw new Error('packageName 看起来不像安卓包名。');
      if (args.action !== 'keep' && args.action !== 'close') throw new Error('action 只能是 keep / close。');
      const reason = textOf(args.reason, 200);
      if (!reason) throw new Error('给一句原因（reason）。');
      const payload = { packageName: pkg, action: args.action, reason };
      if (Number.isInteger(args.user)) payload.user = args.user;
      const data = await run(service, deviceId, sessionId, 'app.after_task', payload, exec.signal);
      const value = { ok: true, packageName: pkg, action: args.action };
      if (data && typeof data.replaces === 'string') value.replaces = data.replaces;
      const note = [mentionMismatch(sessionId, deviceId), '只记下了，任务结束时才按它处置，不会当场关掉。'].filter(Boolean).join(' ');
      if (note) value.note = note;
      return value;
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

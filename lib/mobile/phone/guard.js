'use strict';

/**
 * 操作停滞守卫：手机每一步结束之后记一笔，判断模型是不是「原地打转」，并在合适的级别提醒
 * 或直接叫停。纯逻辑、无 IO、无时钟、可单测 —— 所有计数都在这一份实例里，外部每步喂一条事实。
 *
 * 分级照 Mika 的 GuardRules / OperationGuards：同一动作+同一目标重复 3/6/12；动作没有效果
 * 3/6/9/12；页面没变却重读 5/8/12；连续失败 2/4/8（不可恢复 1/3）；在两三个状态之间兜圈
 * 2/4/...（安全网按步数上限），回到同一状态、连续没到过新状态也各有阶梯。每一级先「提醒」，
 * 最后一级才是「叫停」—— 叫停是安全网，门槛远在提醒之后。提醒里附三条出路：换一条明显不同
 * 的路 / 问用户 / 把已经拿到的交出来并说明还缺什么。
 *
 * 界面指纹用元素表文本（去掉会变的 ref）的 64 位 FNV-1a，照 Mika 的 Fingerprints.kt：纯文本
 * 模型没有截图，也能判断「画面没变」。
 *
 * 用法：
 *   const guard = createGuard({ budget: 60 });
 *   const v = guard.noteStep({ tool:'phone_tap', args:{ref:'e3'}, kind:'action',
 *                              effect:'no_effect', elements });
 *   if (v) { value.note = (value.note ? value.note + ' ' : '') + v.advice; } // warn 才带 advice
 *   if (guard.shouldStop()) { /* 把这一轮收掉 *\/ }
 *
 * noteStep 接受的 step 字段（除 tool 外都可缺，缺了只是少一维判定）：
 *   tool       工具名，参与「同一动作同一目标」的签名
 *   args       参数，参与签名（忽略 reason，坐标按 50 取整，滑动只记方向）
 *   kind       'action'（默认）| 'read' | 'diagnostic'
 *   effect     'changed' | 'small_change' | 'place_changed' | 'no_effect'（动作实际效果）
 *   fingerprint 已经算好的界面指纹（字符串/数字）；也可直接给 elements
 *   elements   这一屏的元素表，本模块自己算指纹
 *   fresh      读动作这次是否读到了之前没读到的新内容（read/diagnostic 用）
 *   ok         false 记一次失败，true 清零失败计数，缺省表示这份结果不表态
 *   recoverable false 记为不可恢复失败
 *   treeBlind  这次动作是在读不出控件树的情况下点的（无效果时更早提醒）
 *   diagnostic true 时按「诊断类工具」的更高门槛计重复
 */

const SEVERITY = { NONE: 'none', WARN: 'warn', STOP: 'stop' };

/** 不知道任务步数上限时按这么多步算（与 Mika 一致）。 */
const DEFAULT_BUDGET = 60;
/** 「同一动作同一目标」看最近多少个动作。 */
const LOOP_WINDOW = 16;
/** 兜圈最多看几个状态一圈。 */
const MAX_CYCLE = 3;
/** 兜圈 trail 最多记多少（够看出最长的安全网）。 */
const TRAIL_KEEP = 64;
/** 元素里这些字段每次都变，算指纹前先去掉。 */
const VOLATILE_ELEMENT_KEYS = ['ref'];

/**
 * 阈值表（导出给交付报告与单测真值）。每条的最后一级是「叫停」，其余是「提醒」。
 * 带 divisor/floor 的是「按步数上限的安全网」：lateStop(budget, divisor, floor)。
 */
const THRESHOLDS = {
  repeat: [3, 6, 12],
  repeatDiagnostic: [6, 9, 15],
  noEffect: [3, 6, 9, 12],
  reread: [5, 8, 12],
  failure: [2, 4, 8],
  unrecoverable: [1, 3],
  failureWaysOut: 4,
  sameState: { base: [3, 6], divisor: 4, floor: 10 },
  cycle: { base: [2, 4], divisor: 5, floor: 6 },
  noNewState: { base: [8, 16], divisor: 2, floor: 24 },
};

/** 提醒里给的三条出路。 */
const WAYS_OUT =
  '给你三条路：换一条明显不同的做法（换工具、换入口、换说法）；还是不行就直接问用户；' +
  '或者把已经拿到的结果交出来，并说清还缺哪一步。';

/** 各条提醒开头「卡在哪」那句。 */
const LEADS = {
  repeating_action: (n) => `同一个动作（同一目标）已经重复 ${n} 次，屏幕上没有给你新东西。`,
  no_progress: (n) => `连续 ${n} 个动作都没有效果，屏幕没有变化。`,
  read_loop: (n) => `页面没有变，你已经重读了 ${n} 次，读不出新内容。`,
  too_many_failures: (n) => `工具已经连续失败 ${n} 次，原样重试大概率还是失败。`,
  same_state: (n) => `这是第 ${n} 次回到同一个界面状态。`,
  state_cycle: (n, p) => `在 ${p} 个状态之间兜圈子，已经转了 ${n} 圈。`,
  no_new_state: (n) => `连续 ${n} 个动作都没有走到新状态。`,
};

function lateStop(budget, divisor, floor) {
  const b = Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_BUDGET;
  return Math.max(floor, Math.floor(b / divisor));
}

function sameStateLadder(budget) {
  return THRESHOLDS.sameState.base.concat(lateStop(budget, THRESHOLDS.sameState.divisor, THRESHOLDS.sameState.floor));
}
function cycleLadder(budget) {
  return THRESHOLDS.cycle.base.concat(lateStop(budget, THRESHOLDS.cycle.divisor, THRESHOLDS.cycle.floor));
}
function noNewStateLadder(budget) {
  return THRESHOLDS.noNewState.base.concat(lateStop(budget, THRESHOLDS.noNewState.divisor, THRESHOLDS.noNewState.floor));
}

/**
 * count 在升序阶梯 ladder 上到了哪一级。没到第一级、或这一级（warnedAt 是已提醒到的门槛）已提醒过
 * 返回 null；到最高一级且 canStop 时叫停，否则提醒。照 Mika GuardRules.climb。
 */
function climb(count, ladder, warnedAt, canStop) {
  let threshold = null;
  for (const t of ladder) if (count >= t) threshold = t;
  if (threshold === null) return null;
  if (threshold <= warnedAt) return null;
  const last = ladder[ladder.length - 1];
  return { threshold, severity: threshold === last && canStop ? SEVERITY.STOP : SEVERITY.WARN };
}

/** 64 位 FNV-1a（照 Mika Fingerprints.kt 的初值与素数）。返回 16 位十六进制串。 */
function fnv1a64(str) {
  let h = 0xcbf29ce484222325n;
  const bytes = Buffer.from(String(str), 'utf8');
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = BigInt.asUintN(64, h * 0x100000001b3n);
  }
  return h.toString(16).padStart(16, '0');
}

/** 稳定序列化：对象键排序，数组保序。让同样的元素表每次得到同样的指纹。 */
function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/** 去掉元素表里每次都变的字段（ref），留下真正的界面内容。 */
function stripVolatile(el) {
  if (!el || typeof el !== 'object' || Array.isArray(el)) return el;
  const copy = {};
  for (const k of Object.keys(el)) {
    if (VOLATILE_ELEMENT_KEYS.indexOf(k) === -1) copy[k] = el[k];
  }
  return copy;
}

/**
 * 画面指纹：元素表文本（去掉 ref）的 64 位 FNV。elements 不是数组返回 null。
 * @param {Array} elements
 * @returns {string|null}
 */
function elementsFingerprint(elements) {
  if (!Array.isArray(elements)) return null;
  return fnv1a64(stableStringify(elements.map(stripVolatile)));
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 动作签名：tool + 参数（忽略 reason；坐标按 50 取整；滑动只记方向）。参数顺序不影响结果。
 * @param {string} tool
 * @param {object} args
 * @returns {string}
 */
function actionSignature(tool, args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? Object.assign({}, args) : {};
  delete a.reason;
  const x = num(a.x);
  const y = num(a.y);
  if (x !== null && y !== null) {
    a.x = Math.floor(x / 50);
    a.y = Math.floor(y / 50);
  }
  const swipeKeys = ['startX', 'startY', 'endX', 'endY'];
  const s = swipeKeys.map((k) => num(a[k]));
  if (s.every((v) => v !== null)) {
    const dx = s[2] - s[0];
    const dy = s[3] - s[1];
    const vertical = Math.abs(dy) >= Math.abs(dx);
    const major = vertical ? dy : dx;
    a.swipeDirection = (vertical ? 'V' : 'H') + (major < 0 ? '-' : '+');
    for (const k of swipeKeys) delete a[k];
  }
  return String(tool == null ? '' : tool) + '|' + stableStringify(a);
}

/** 在 trail（相邻不同的状态序列）末尾找「在 2–3 个状态间兜圈」。照 Mika GuardRules.cycle。 */
function detectCycle(trail) {
  let best = null;
  for (let p = 2; p <= MAX_CYCLE; p++) {
    if (trail.length < p + 1) continue;
    const tail = trail.slice(-p);
    if (new Set(tail).size !== p) continue;
    let len = p;
    let i = trail.length - 1;
    while (i - p >= 0 && trail[i] === trail[i - p]) {
      len++;
      i--;
    }
    if (len > p && (best === null || len > best.length)) {
      best = { period: p, length: len, rounds: Math.floor(len / p) };
    }
  }
  return best;
}

function fingerprintOf(step) {
  if (step.fingerprint !== undefined && step.fingerprint !== null) return String(step.fingerprint);
  if (Array.isArray(step.elements)) return elementsFingerprint(step.elements);
  return null;
}

/**
 * 建一份守卫。options.budget 是这一轮允许的步数上限（影响兜圈/回同状态/无新状态的安全网）。
 * @param {{budget?: number}} [options]
 */
function createGuard(options) {
  const opts = options || {};
  const budget = Number.isFinite(opts.budget) ? opts.budget : null;

  let state;

  function reset() {
    state = {
      lastFingerprint: null,
      seenStates: new Set(),
      visits: new Map(),
      visitsWarnedAt: new Map(),
      trail: [],
      cycleWarnedAt: 0,
      sinceNewState: 0,
      sinceNewWarnedAt: 0,
      unchanged: 0,
      unchangedWarnedAt: 0,
      treeBlindActions: 0,
      window: [],
      repeatWarned: new Map(),
      rereads: 0,
      rereadWarnedAt: 0,
      consecutiveFailures: 0,
      unrecoverableFailures: 0,
      failureWarnedAt: 0,
      unrecoverableWarnedAt: 0,
      stopped: null,
      level: SEVERITY.NONE,
      lastAdvice: null,
      lastVerdict: null,
      emitted: [],
    };
  }
  reset();

  function buildAdvice(code, count, period) {
    const lead = LEADS[code] ? LEADS[code](count, period) : `卡住了（${code}，${count} 次）。`;
    return `${lead}${WAYS_OUT}`;
  }

  function report(code, severity, count, period) {
    const advice = severity === SEVERITY.WARN ? buildAdvice(code, count, period) : null;
    const verdict = { code, severity, count, advice };
    state.lastVerdict = verdict;
    state.emitted.push(verdict);
    if (severity === SEVERITY.STOP) {
      state.stopped = verdict;
      state.level = SEVERITY.STOP;
    } else if (state.level !== SEVERITY.STOP) {
      state.level = SEVERITY.WARN;
    }
    if (advice) state.lastAdvice = advice;
    return verdict;
  }

  function resetNoEffect() {
    state.unchanged = 0;
    state.unchangedWarnedAt = 0;
    state.treeBlindActions = 0;
  }

  function progress() {
    resetNoEffect();
    state.sinceNewState = 0;
    state.sinceNewWarnedAt = 0;
    if (state.stopped && (state.stopped.code === 'no_progress' || state.stopped.code === 'read_loop')) {
      state.stopped = null;
      state.level = SEVERITY.NONE;
    }
  }

  function noProgress() {
    if (state.treeBlindActions >= 2) {
      const severity = state.unchanged >= 3 ? SEVERITY.STOP : SEVERITY.WARN;
      return report('no_progress', severity, state.unchanged);
    }
    const rung = climb(state.unchanged, THRESHOLDS.noEffect, state.unchangedWarnedAt, true);
    if (!rung) return null;
    state.unchangedWarnedAt = rung.threshold;
    return report('no_progress', rung.severity, state.unchanged);
  }

  function sameState(fp, n) {
    const rung = climb(n, sameStateLadder(budget), state.visitsWarnedAt.get(fp) || 0, true);
    if (!rung) return null;
    state.visitsWarnedAt.set(fp, rung.threshold);
    return report('same_state', rung.severity, n);
  }

  function cycleCheck(cyc) {
    if (!cyc) {
      state.cycleWarnedAt = 0;
      return null;
    }
    const rung = climb(cyc.rounds, cycleLadder(budget), state.cycleWarnedAt, true);
    if (!rung) return null;
    state.cycleWarnedAt = rung.threshold;
    return report('state_cycle', rung.severity, cyc.rounds, cyc.period);
  }

  function noNewState() {
    const rung = climb(state.sinceNewState, noNewStateLadder(budget), state.sinceNewWarnedAt, false);
    if (!rung) return null;
    state.sinceNewWarnedAt = rung.threshold;
    return report('no_new_state', rung.severity, state.sinceNewState);
  }

  function noteRepeat(step) {
    const diag = step.diagnostic === true;
    const sig = diag ? String(step.tool == null ? '' : step.tool) : actionSignature(step.tool, step.args);
    state.window.push(sig);
    if (state.window.length > LOOP_WINDOW) state.window.shift();
    let count = 0;
    for (const s of state.window) if (s === sig) count++;
    const ladder = diag ? THRESHOLDS.repeatDiagnostic : THRESHOLDS.repeat;
    const rung = climb(count, ladder, state.repeatWarned.get(sig) || 0, true);
    if (!rung) return null;
    state.repeatWarned.set(sig, rung.threshold);
    return report('repeating_action', rung.severity, count);
  }

  function noteFailure(step) {
    const recoverable = step.recoverable !== false;
    state.consecutiveFailures += 1;
    if (!recoverable) state.unrecoverableFailures += 1;
    const r1 = climb(state.consecutiveFailures, THRESHOLDS.failure, state.failureWarnedAt, true);
    if (r1) {
      state.failureWarnedAt = r1.threshold;
      report('too_many_failures', r1.severity, state.consecutiveFailures);
    }
    const r2 = climb(state.unrecoverableFailures, THRESHOLDS.unrecoverable, state.unrecoverableWarnedAt, true);
    if (r2) {
      state.unrecoverableWarnedAt = r2.threshold;
      report('too_many_failures', r2.severity, state.consecutiveFailures);
    }
  }

  function resetFailures() {
    state.consecutiveFailures = 0;
    state.unrecoverableFailures = 0;
    state.failureWarnedAt = 0;
    state.unrecoverableWarnedAt = 0;
  }

  /**
   * 收到一屏。[didAct] 表示这屏是不是一个动作之后拿到的；[effectNoted] 表示这个动作的「有没有效果」
   * 已经按 effect 字段记过，别再用「指纹没变」重复记一次。
   */
  function handleFrame(fp, didAct, effectNoted) {
    if (fp === state.lastFingerprint) {
      if (didAct && !effectNoted) {
        state.unchanged += 1;
        noProgress();
      }
      return;
    }
    state.lastFingerprint = fp;
    state.rereads = 0;
    state.rereadWarnedAt = 0;
    if (state.trail.length === 0 || state.trail[state.trail.length - 1] !== fp) state.trail.push(fp);
    if (state.trail.length > TRAIL_KEEP) state.trail.shift();
    const seenBefore = state.seenStates.has(fp);
    let cyc = null;
    if (!seenBefore) {
      state.seenStates.add(fp);
      state.visits.set(fp, 1);
      progress();
    } else {
      const n = (state.visits.get(fp) || 1) + 1;
      state.visits.set(fp, n);
      cyc = detectCycle(state.trail);
      if (!cyc) sameState(fp, n);
    }
    if (cyc === null) cyc = detectCycle(state.trail);
    cycleCheck(cyc);
    if (didAct) noNewState();
  }

  /**
   * 喂一步。返回这一步给出的最重要一条结论（stop 优先，否则最后一条 warn），没有则 null。
   * 返回对象形如 { code, severity, count, advice }；advice 只有 warn 才有（三出路那段）。
   * @param {object} step
   */
  function noteStep(step) {
    if (state.stopped) return state.stopped;
    const s = step && typeof step === 'object' ? step : {};
    state.emitted = [];

    if (s.ok === false) noteFailure(s);
    else if (s.ok === true) resetFailures();

    const fp = fingerprintOf(s);
    const kind = s.kind || (s.tool === 'phone_screen' ? 'read' : 'action');

    if (kind === 'read' || kind === 'diagnostic') {
      if (s.fresh === true) progress();
      if (fp !== null) {
        if (fp === state.lastFingerprint && s.fresh !== true) {
          state.rereads += 1;
          const rung = climb(state.rereads, THRESHOLDS.reread, state.rereadWarnedAt, true);
          if (rung) {
            state.rereadWarnedAt = rung.threshold;
            report('read_loop', rung.severity, state.rereads);
          }
        }
        handleFrame(fp, false, true);
      }
    } else {
      state.sinceNewState += 1;
      noteRepeat(s);
      const effect = typeof s.effect === 'string' ? s.effect : null;
      if (effect === 'no_effect') {
        state.unchanged += 1;
        if (s.treeBlind === true) state.treeBlindActions += 1;
        noProgress();
      } else if (effect !== null) {
        resetNoEffect();
      }
      if (fp !== null) handleFrame(fp, true, effect !== null);
    }

    const made = state.emitted;
    if (state.stopped && state.stopped.severity === SEVERITY.STOP) return state.stopped;
    if (made.length === 0) return null;
    const stop = made.find((v) => v.severity === SEVERITY.STOP);
    return stop || made[made.length - 1];
  }

  return {
    noteStep,
    level: () => state.level,
    shouldStop: () => state.level === SEVERITY.STOP || state.stopped !== null,
    advice: () => state.lastAdvice,
    reset,
  };
}

module.exports = {
  createGuard,
  actionSignature,
  elementsFingerprint,
  fnv1a64,
  stableStringify,
  detectCycle,
  climb,
  lateStop,
  SEVERITY,
  THRESHOLDS,
  DEFAULT_BUDGET,
  LOOP_WINDOW,
  MAX_CYCLE,
};

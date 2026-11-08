'use strict';

/**
 * 总管播报：什么时候开口、开口念哪一句、其余的留在屏幕上。
 *
 * 现场是「几条会话同时在跑，一有动静就蹦一句」—— 用户听到的是一串各自为政的短句，还得自己
 * 拼回「现在到底怎么样了」。所以这里只管一件事：**攒一小会儿，把这一批合成一句话说**。
 *
 * ## 判据的顺序就是开口的顺序
 *
 *  1. **空档不开口**：这一批里没有值得说的，就一个字都不说。
 *  2. **有上限**：一段窗口里说满了就不再开口（剩下的留在屏幕，不追着念）。
 *  3. **冷却**：刚说完没一会儿，后面再来的先憋着 —— 人不是逐条念的播报机。
 *  4. **攒批**：刚冒出来的事件先压一个短窗口，等后续到齐了再一起说；压太久（`maxWaitMs`）
 *     就先说已有的，别让一句话遥遥无期。
 *  5. **合并成句**：先说最要紧的（报错 / 在等人答 > 跑完了），两句封顶，其余留在屏幕。
 *
 * ## 两道口径
 *
 * - **只说摘要、细节留屏幕**（与 App 通话页 `speakableText` 同一套口径，A1-286）：代码块、
 *   表格、链接、裸网址一律不念，每句截到一口气能说完的长度。
 * - **纯模块**：这个文件不 require 任何东西、不碰宿主 IO —— 判据能在裸 Node 里直接跑，
 *   挂到宿主上的那一半在底下的 `installSupervisorBroadcast`。两份运行在不同进程里
 *   （插件 Node / App RN），洗稿那一步各有一份实现，口径对齐即可。
 * - **出口只有一条**：`createDeviceBroadcastSink()` 把这一句放进模块级的那条总线，
 *   `mobile/events.js` 订阅它、按设备帧推给手机（帧形状 `{type:'supervisor/broadcast',
 *   text, at}`）。播报不自己开通道，也不认识谁在听 —— 与 list-signal 一个路数。
 */

/** 攒批窗口：这段时间内到的事件合并成一句说。 */
const BROADCAST_WINDOW_MS = 1200;
/**
 * 最长憋这么久：事件一直不断时，窗口永远「还没攒够」，一句话就会无限期推迟。
 * 到了这个岁数就先说手头已有的那一批。
 */
const BROADCAST_MAX_WAIT_MS = 6000;
/** 两句话之间至少隔这么久 —— 刚说完又来一件，先合并进下一句。 */
const BROADCAST_COOLDOWN_MS = 3000;
/** 一段窗口里最多说几句。再多就是播报台了。 */
const BROADCAST_MAX_PER_WINDOW = 2;
/** 上面那个「一段窗口」有多长：过了就重新计数（一小时里说两句是合理的）。 */
const BROADCAST_CAP_WINDOW_MS = 60 * 1000;
/** 一句话里最多点几件事的名字，再多就只报个数。 */
const BROADCAST_MAX_ITEMS = 3;
/** 念出来最多留这么多字：一口气能说完的长度。 */
const BROADCAST_MAX_CHARS = 90;

/** 三档待播事件，数字越小越要紧。报错排在等人答前面：那条已经停了，等人答只是被卡住。 */
const RANK = Object.freeze({ error: 0, waiting: 1, done: 2 });

/** 每档落在句子里怎么说。 */
const VERB = Object.freeze({ error: '报错了', waiting: '在等你回答', done: '跑完了' });

function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegative(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** 一条待播事件的时间戳；没给就按 0（跟 `now` 之间的差就是它的岁数）。 */
function atOf(event) {
  return Number.isFinite(event && event.at) ? event.at : 0;
}

/** 认不出来的事件（例如宿主的中间帧）不进播报，也不占位置。 */
function isEvent(event) {
  return Boolean(event) && typeof event === 'object' && VERB[event.kind] !== undefined;
}

/** 排序键：先按要紧程度，同一档里新的在前（刚发生的事更可能是用户想先知道的那件）。 */
function rankOf(event) {
  return RANK[event.kind] === undefined ? RANK.done : RANK[event.kind];
}

function titleOf(event) {
  return typeof event.title === 'string' && event.title.trim() ? event.title.trim() : '';
}

/** 一件事在句子里那半句。有标题就点名，没有就只说「有一条」。 */
function clauseOf(event) {
  const verb = VERB[event.kind];
  const title = titleOf(event);
  return title ? `${title}${verb}` : `有一条${verb}`;
}

/**
 * 洗稿：把排版文本变成能念出口的话（A1-286 那套口径）。
 *
 * 围栏代码块整块扔掉、表格行不念、链接只留文字、裸网址删掉、记号去掉，压平空白，
 * 超长时优先截在句读上。
 */
function spokenOf(text, maxChars = BROADCAST_MAX_CHARS) {
  let out = String(text == null ? '' : text);
  out = out.replace(/^[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*?^[ \t]*(?:```|~~~)[ \t]*$/gm, ' ');
  out = out.replace(/^[ \t]*(?:```|~~~)[\s\S]*$/m, ' ');
  out = out.replace(/^[ \t]*\|.*\|[ \t]*$/gm, ' ');
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/https?:\/\/\S+/g, ' ');
  out = out.replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, '');
  out = out.replace(/`([^`]*)`/g, '$1');
  out = out.replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, '$2');
  out = out.replace(/\s*\n+\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
  const limit = positive(maxChars, BROADCAST_MAX_CHARS);
  if (out.length <= limit) return out;
  const head = out.slice(0, limit);
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('；'));
  return cut > 0 ? head.slice(0, cut + 1) : head;
}

function planResult(patch) {
  return {
    speak: false,
    text: '',
    spoken: [],
    screen: [],
    held: [],
    reason: 'quiet',
    ...patch,
  };
}

/**
 * 此刻该不该开口。
 *
 * 纯函数：给一批待播事件和当前时间，回一句话该怎么说、其余怎么处理。同一个输入永远同一个
 * 输出，不读时钟、不留状态 —— 状态（说过几句、上次什么时候说的）由调用方带进来。
 *
 * @param {object} input
 * @param {Array<{kind: 'error'|'waiting'|'done', title?: string, sessionId?: string, at?: number}>} input.events
 * @param {number} input.now 现在（与事件的 `at` 同一把尺子，一般是毫秒时间戳）
 * @param {number} [input.said] 这一段窗口里已经说过几句
 * @param {number} [input.sinceLastMs] 距上次开口过了多久（没说过给 Infinity）
 * @param {number} [input.windowMs] 攒批窗口
 * @param {number} [input.maxWaitMs] 最长憋多久
 * @param {number} [input.cooldownMs] 两句之间至少隔多久
 * @param {number} [input.maxPerWindow] 一段窗口里最多说几句
 * @param {number} [input.maxItems] 一句里最多点几件事
 * @param {number} [input.maxChars] 念出来最多几个字
 * @returns {{speak: boolean, text: string, spoken: Array<object>, screen: Array<object>,
 *   held: Array<object>, reason: 'quiet'|'capped'|'cooldown'|'settling'|'speak'}}
 *   `spoken` 是这句话覆盖到的那几件事，`screen` 是没进这一句、留在屏幕上给眼睛看的，
 *   `held` 是还没到该说的时机、等下一拍的。
 */
function planBroadcast(input) {
  const source = input && typeof input === 'object' ? input : {};
  const events = Array.isArray(source.events) ? source.events.filter(isEvent) : [];
  const now = Number.isFinite(source.now) ? source.now : 0;
  const windowMs = positive(source.windowMs, BROADCAST_WINDOW_MS);
  const maxWaitMs = positive(source.maxWaitMs, BROADCAST_MAX_WAIT_MS);
  const cooldownMs = nonNegative(source.cooldownMs, BROADCAST_COOLDOWN_MS);
  const maxPerWindow = positive(source.maxPerWindow, BROADCAST_MAX_PER_WINDOW);
  const maxItems = positive(source.maxItems, BROADCAST_MAX_ITEMS);
  const maxChars = positive(source.maxChars, BROADCAST_MAX_CHARS);
  const sinceLastMs = Number.isFinite(source.sinceLastMs) ? source.sinceLastMs : Number.POSITIVE_INFINITY;
  const said = Number.isFinite(source.said) ? source.said : 0;

  // 空档：没有要说的，一个字都别说。
  if (events.length === 0) return planResult({ reason: 'quiet' });

  // 上限：这一段说满了就闭嘴，剩下的事留在屏幕上，不追着念。
  if (said >= maxPerWindow) return planResult({ reason: 'capped', screen: events.slice() });

  // 冷却：刚说完，后来的先憋着。
  if (sinceLastMs < cooldownMs) return planResult({ reason: 'cooldown', held: events.slice() });

  // 攒批：还有比窗口更新的事件就先等一等，除非已经憋了太久。
  let newestAge = Number.POSITIVE_INFINITY;
  let oldestAge = 0;
  for (const event of events) {
    const age = now - atOf(event);
    if (age < newestAge) newestAge = age;
    if (age > oldestAge) oldestAge = age;
  }
  if (newestAge < windowMs && oldestAge < maxWaitMs) {
    return planResult({ reason: 'settling', held: events.slice() });
  }

  // 合并：最要紧的在前，同一件事只出现一次。
  const sorted = events.slice().sort((a, b) => rankOf(a) - rankOf(b) || atOf(b) - atOf(a));
  const named = sorted.slice(0, maxItems);
  const rest = sorted.slice(maxItems);

  const lines = [];
  if (named.length > 0) lines.push(`${named.map(clauseOf).join('，')}。`);
  // 第二句只报个数：名字再排一遍，一句就说不完了。其余细节留在屏幕上。
  if (rest.length === 1) lines.push('还有一件。');
  else if (rest.length > 1) lines.push(`还有${rest.length}件。`);

  const text = spokenOf(lines.join(''), maxChars);
  if (!text) return planResult({ reason: 'quiet', screen: events.slice() });

  const covered = named;
  const spokenSet = new Set(covered);
  return {
    speak: true,
    text,
    spoken: covered,
    screen: events.filter((event) => !spokenSet.has(event)),
    held: [],
    reason: 'speak',
  };
}

/**
 * 「总管要开口了」的信号总线。
 *
 * 播报判据在宿主里跑，出声的地方在手机上，中间只差一个出口。出口就在这里：`emit` 把
 * 洗好的一句话广播出去，`mobile/events.js` 在设备级流上把它推成一帧。与 list-signal
 * 同款模块级单例 —— 生产端（本模块的 sink）与消费端（设备流）不需要互相认识。
 *
 * 订阅者抛错一律吞掉：播报的调用方是定时器，一条写坏的连接不该把下一句也拖住。
 */
function createBroadcastSignal() {
  const listeners = new Set();
  return {
    /**
     * 广播一句话。
     *
     * @param {string} text 已经洗好、能直接念的那一句
     * @param {number} [at] 宿主时刻；缺省现取
     * @returns {boolean} 是否真的广播了（空句子不算）
     */
    emit(text, at) {
      const body = typeof text === 'string' ? text.trim() : '';
      if (!body) return false;
      const frame = {
        type: 'supervisor/broadcast',
        text: body,
        at: Number.isFinite(at) ? at : Date.now(),
      };
      for (const listener of [...listeners]) {
        try { listener(frame); } catch { /* 订阅者自己的异常不该影响下一句 */ }
      }
      return true;
    },

    /** 订阅一次播报；返回退订函数（可重复调用）。 */
    onBroadcast(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        listeners.delete(listener);
      };
    },
  };
}

const broadcastSignal = createBroadcastSignal();

/**
 * 播报的真出口：把 `installSupervisorBroadcast` 合成的那一句交给设备级流。
 *
 * 只认 `plan.speak` 为真的那一句：策略层已经定了说不说、说哪句，这里再洗一遍就等于
 * 把口径分成两份。返回的形状正好是 `installSupervisorBroadcast` 要的 sink。
 *
 * @param {object} [options]
 * @param {(frame: object) => void} [options.emit] 换一条投递路径（测试用）
 * @param {() => number} [options.now] 时钟（测试用）
 */
function createDeviceBroadcastSink(options) {
  const opts = options && typeof options === 'object' ? options : {};
  // 默认投递进那条总线；守卫换一条只记不发的路径，就能只看「递出去的是什么形状」。
  const emit = typeof opts.emit === 'function' ? opts.emit : (frame) => broadcastSignal.emit(frame.text, frame.at);
  const clock = typeof opts.now === 'function' ? opts.now : Date.now;
  return (text) => {
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body) return false;
    return emit({ type: 'supervisor/broadcast', text: body, at: clock() }) !== false;
  };
}

/** 宿主一条会话事件折算成待播事件；不值得播的（中间帧、子代理）回 null。 */
function eventOf(session, event) {
  if (!event || typeof event.type !== 'string') return null;
  const header = session && session.header;
  if (header && header.origin === 'subagent') return null;
  const sessionId = (session && session.id) || (header && header.id) || '';
  const title = (header && typeof header.title === 'string' && header.title.trim()) || '';
  const base = { sessionId, title, at: 0 };
  if (event.type === 'turn/end') {
    const reason = event.data && event.data.reason;
    const kind = reason && typeof reason.kind === 'string' ? reason.kind : undefined;
    return { ...base, kind: kind === 'error' ? 'error' : 'done' };
  }
  if (event.type === 'approval/asked' || event.type === 'approval/requested') {
    return { ...base, kind: 'waiting' };
  }
  if (event.type === 'question/requested') return { ...base, kind: 'waiting' };
  return null;
}

/**
 * 把播报挂到宿主的事件上。
 *
 * 攒批与上限的状态都在这一份闭包里：收到事件先进队列，隔一个窗口统一算一次该不该开口；
 * 要开口就交给 `sink`（往哪儿念由装配层定，这里不碰宿主 IO）。
 *
 * 同一条会话只留最新那件待播的事：一轮里先报错再跑完，念「它跑完了」就够了，
 * 两条都念等于把同一件事说两遍。
 *
 * 返回清理函数（`ctx.effect` 要的形状）。任何一步失败都吞掉 —— 播报是锦上添花。
 *
 * @param {object} ctx 宿主上下文，只需要 `on`
 * @param {object} [options]
 * @param {(text: string, plan: object) => void} [options.sink] 这一句往哪儿说
 * @param {number} [options.windowMs] / [options.cooldownMs] / [options.maxPerWindow] /
 *   [options.maxItems] / [options.maxChars] 同 `planBroadcast`，测试用它压小
 * @param {() => number} [options.now] 时钟，测试可注入
 */
function installSupervisorBroadcast(ctx, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const clock = typeof opts.now === 'function' ? opts.now : Date.now;
  const sink = typeof opts.sink === 'function' ? opts.sink : null;
  const windowMs = positive(opts.windowMs, BROADCAST_WINDOW_MS);
  const maxWaitMs = positive(opts.maxWaitMs, BROADCAST_MAX_WAIT_MS);
  const cooldownMs = nonNegative(opts.cooldownMs, BROADCAST_COOLDOWN_MS);
  const maxPerWindow = positive(opts.maxPerWindow, BROADCAST_MAX_PER_WINDOW);
  const capWindowMs = positive(opts.capWindowMs, BROADCAST_CAP_WINDOW_MS);
  const maxItems = positive(opts.maxItems, BROADCAST_MAX_ITEMS);
  const maxChars = positive(opts.maxChars, BROADCAST_MAX_CHARS);

  /** 待播队列：同一会话只留最新那件。 */
  let queue = [];
  let timer = null;
  let disposed = false;
  let said = 0;
  let saidSince = 0;
  let lastAt = 0;

  function schedule() {
    if (disposed || timer || queue.length === 0) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, windowMs);
    // 一个后台播报的定时器不该把进程按住（宿主里照常跑，测试里也不拖尾巴）。
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function flush() {
    if (disposed || queue.length === 0) return;
    const now = clock();
    if (saidSince && now - saidSince >= capWindowMs) {
      said = 0;
      saidSince = 0;
    }
    let plan;
    try {
      plan = planBroadcast({
        events: queue,
        now,
        said,
        sinceLastMs: lastAt ? now - lastAt : Number.POSITIVE_INFINITY,
        windowMs,
        maxWaitMs,
        cooldownMs,
        maxPerWindow,
        maxItems,
        maxChars,
      });
    } catch {
      queue = [];
      return;
    }
    queue = plan.held.slice();
    if (plan.speak) {
      said += 1;
      if (!saidSince) saidSince = now;
      lastAt = now;
      try {
        if (sink) sink(plan.text, plan);
      } catch {
        // 念不出去不影响下一句。
      }
    }
    schedule();
  }

  const handler = (session, event) => {
    try {
      const item = eventOf(session, event);
      if (!item) return;
      item.at = clock();
      queue = queue.filter((pending) => pending.sessionId !== item.sessionId);
      queue.push(item);
      schedule();
    } catch {
      // 折算失败就当没看见。
    }
  };

  let off = null;
  if (ctx && typeof ctx.on === 'function') {
    try {
      off = ctx.on('session/event', handler, { global: true });
    } catch {
      // 宿主不认这个事件时只少一份播报，别把插件装载拖下去。
    }
  }

  return () => {
    disposed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    queue = [];
    if (typeof off === 'function') {
      try {
        off();
      } catch {
        // 清理失败不抛。
      }
    }
  };
}

/**
 * 装配层要的那一下：播报挂到宿主事件上，出口接设备事件流。
 *
 * 装配层只留一行 `mount`，真出口（`createDeviceBroadcastSink`）与判据都留在这里 ——
 * 与 A3-81 的分工一致：`impl.js` 是多人共用的装配文件，越薄越好。
 *
 * @returns {() => void} 清理函数（`ctx.effect` 要的形状）
 */
function installDeviceBroadcast(ctx, options) {
  return installSupervisorBroadcast(ctx, {
    ...(options && typeof options === 'object' ? options : {}),
    sink: createDeviceBroadcastSink(options),
  });
}

module.exports = {
  installSupervisorBroadcast,
  installDeviceBroadcast,
  planBroadcast,
  createDeviceBroadcastSink,
  broadcastSignal,
  eventOf,
  clauseOf,
  spokenOf,
  rankOf,
  BROADCAST_WINDOW_MS,
  BROADCAST_MAX_WAIT_MS,
  BROADCAST_COOLDOWN_MS,
  BROADCAST_MAX_PER_WINDOW,
  BROADCAST_CAP_WINDOW_MS,
  BROADCAST_MAX_ITEMS,
  BROADCAST_MAX_CHARS,
};

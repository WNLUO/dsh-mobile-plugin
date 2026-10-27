'use strict';

/**
 * 宿主进程级错误边界（crash guard）。
 *
 * DSH 宿主是长驻进程（嵌入桌面版或由 systemd 以 `Restart=on-failure` 托管），任何逃出
 * 事件循环的异常都会带走整个 DSH。路由层已有 `.catch`，进程层的缺口是两处：
 *
 * 1. 游离的 Promise 拒绝——Node 15+ 默认 throw 并杀进程，插件里大量 fire-and-forget；
 * 2. 第三方回调（事件流、WS、timer）里抛错，没有 try 包着就是 uncaughtException。
 *
 * 策略：全部记入内存账本并保持存活；只有 uncaughtException 计入熔断，且必须落在时间窗
 * 内连发到 `fatalCount` 才主动退出，交给 `Restart=on-failure` 拉起。`createGuard()` 是
 * 纯状态机，`installProcessGuard()` 才是进程接线，拆分是为了能被守卫测试覆盖。
 */

const FATAL_FAULT_COUNT = 5;
const CONSECUTIVE_FAULT_WINDOW_MS = 60 * 1000;
const FAULT_LEDGER_LIMIT = 50;
const FATAL_EXIT_CODE = 1;

/** 把任意 throw 出来的值压成一行可读文本。 */
function describeError(err) {
  if (err === null || err === undefined) return String(err);
  if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
  if (typeof err === 'object') {
    try { return JSON.stringify(err); } catch { return Object.prototype.toString.call(err); }
  }
  return String(err);
}

/**
 * 建立一个错误边界状态机（不碰 process）。
 *
 * @param {object}   [options]
 * @param {number}   [options.fatalCount]     窗口内多少个 uncaughtException 判定致命，缺省 5
 * @param {number}   [options.windowMs]       「连续」的时间窗，缺省 60s
 * @param {number}   [options.ledgerLimit]    账本上限，缺省 50
 * @param {() => number} [options.now]        注入时钟，便于测试
 * @param {(line: string) => void} [options.log] 注入日志，便于测试
 * @param {(code: number) => void} [options.exit] 注入退出，便于测试
 * @returns {{handleUncaughtException: Function, handleUnhandledRejection: Function,
 *            recordFault: Function, faults: Function, stats: Function, clear: Function,
 *            isFatal: Function}}
 */
function createGuard(options = {}) {
  const fatalCount = options.fatalCount ?? FATAL_FAULT_COUNT;
  const windowMs = options.windowMs ?? CONSECUTIVE_FAULT_WINDOW_MS;
  const ledgerLimit = options.ledgerLimit ?? FAULT_LEDGER_LIMIT;
  const now = options.now ?? (() => Date.now());
  const exit = options.exit ?? ((code) => process.exit(code));
  const log = options.log ?? ((line) => { process.stderr.write(`${line}\n`); });

  /** @type {{at: number, kind: string, message: string, fatal: boolean}[]} */
  let ledger = [];
  let consecutive = 0;
  let lastFatalKindAt = 0;
  let fatalEver = false;

  function record(kind, message, fatal) {
    // 满了就丢最旧的：账本是用来回答「刚才发生了什么」，不是完整审计日志。
    if (ledger.length >= ledgerLimit) ledger.shift();
    ledger.push({ at: now(), kind, message, fatal: Boolean(fatal) });
  }

  return {
    /**
     * `process.on('uncaughtException')` 的处理函数。
     * 记一笔，计入连续计数，够数才退出。
     */
    handleUncaughtException(err) {
      const at = now();
      // 「连续」= 距离上一个致命类异常没超过窗口。超窗则重新从 1 数，
      // 这样零星故障不会累加到熔断，只有崩溃循环才会。
      consecutive = (lastFatalKindAt !== 0 && at - lastFatalKindAt <= windowMs) ? consecutive + 1 : 1;
      lastFatalKindAt = at;
      const fatal = consecutive >= fatalCount;
      if (fatal) fatalEver = true;
      record('uncaughtException', describeError(err), fatal);
      log(`[dsh-mobile-plugin] 未捕获异常（连续 ${consecutive}/${fatalCount}${fatal ? '，判定崩溃循环，将退出' : ''}）: ${describeError(err)}`);
      if (fatal) exit(FATAL_EXIT_CODE);
      return fatal;
    },

    /**
     * `process.on('unhandledRejection')` 的处理函数。
     *
     * 刻意**不计入熔断**：游离 reject 在长驻服务里非常常见（一次后台推送失败就
     * 一个），把它们累加成退出条件会制造新的崩溃源。挂上处理器本身就已经把
     * Node 的默认「throw 并杀进程」改成了「记录并继续」。
     */
    handleUnhandledRejection(reason) {
      record('unhandledRejection', describeError(reason), false);
      log(`[dsh-mobile-plugin] 未处理的 Promise 拒绝（已忽略）: ${describeError(reason)}`);
      return false;
    },

    /** 手动记一条非致命故障（例如某个 handler 自己 catch 后上报的）。 */
    recordFault(kind, message) {
      record(kind, String(message), false);
      return false;
    },

    /** 账本快照（按时间正序）。 */
    faults() { return ledger.slice(); },

    /** 供 `status()` 暴露的汇总。 */
    stats() {
      return {
        total: ledger.length,
        consecutive,
        lastAt: ledger.length ? ledger[ledger.length - 1].at : 0,
        fatalCount,
        windowMs,
        fatal: fatalEver,
      };
    },

    /** 清空账本与计数（测试用 / 运维排障后复位）。 */
    clear() { ledger = []; consecutive = 0; lastFatalKindAt = 0; fatalEver = false; },

    /** 当前是否已经熔断过。 */
    isFatal() { return fatalEver; },
  };
}

/** @type {ReturnType<typeof createGuard>|null} 已安装的边界，供 safeAsync 复用。 */
let installed = null;

/**
 * 把状态机接到真实 process 上。**必须在任何业务代码之前调用**，
 * 否则启动阶段的游离 reject 仍然会按 Node 默认行为杀进程。
 *
 * @param {object} [options] 同 createGuard，另可传 `target`（默认 process）便于测试
 * @returns {{guard: ReturnType<typeof createGuard>, uninstall: () => void}}
 */
function installProcessGuard(options = {}) {
  const { target = process, ...rest } = options;
  const guard = rest.guard ?? createGuard(rest);
  const onUncaught = (err) => { guard.handleUncaughtException(err); };
  const onRejection = (reason) => { guard.handleUnhandledRejection(reason); };
  target.on('uncaughtException', onUncaught);
  target.on('unhandledRejection', onRejection);
  installed = guard;
  return {
    guard,
    uninstall() {
      target.off('uncaughtException', onUncaught);
      target.off('unhandledRejection', onRejection);
      if (installed === guard) installed = null;
    },
  };
}

/** 取当前已安装的边界（没装返回 null）。 */
function activeGuard() { return installed; }

/**
 * 把一个可能抛/可能 reject 的调用包成「永不把异常带出去」的函数。
 *
 * 插件里大量 fire-and-forget 的调用点可以套这一层，不必各自 try/catch，也就不会
 * 因为漏了一处 catch 把 DSH 带走。
 *
 * @param {Function} fn                 原始函数
 * @param {string}   [label]            出错时用于定位的来源名
 * @param {ReturnType<typeof createGuard>|null} [guard] 指定边界，缺省用已安装的那个
 * @returns {(...args: any[]) => Promise<void>} 永不 reject
 */
function safeAsync(fn, label = 'anonymous', guard = null) {
  return function guarded(...args) {
    const report = (err) => {
      const g = guard ?? installed;
      const message = `${label}: ${describeError(err)}`;
      if (g) g.recordFault('safeAsync', message);
      else process.stderr.write(`[dsh-mobile-plugin] 未保护的异步调用 ${message}\n`);
    };
    try {
      return Promise.resolve(fn(...args)).then(
        () => undefined,
        (err) => { report(err); },
      );
    } catch (err) {
      // 同步抛也要吞：调用点写的是 fire-and-forget，不该因为参数错就把进程带走。
      report(err);
      return Promise.resolve();
    }
  };
}

module.exports = {
  createGuard,
  installProcessGuard,
  activeGuard,
  safeAsync,
  describeError,
  FATAL_FAULT_COUNT,
  CONSECUTIVE_FAULT_WINDOW_MS,
  FAULT_LEDGER_LIMIT,
  FATAL_EXIT_CODE,
};

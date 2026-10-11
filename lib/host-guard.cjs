'use strict';

/**
 * 宿主进程级错误边界（crash guard）。
 *
 * ## 为什么要这个模块
 *
 * DSH 宿主是**长驻进程**：装在桌面版 DSH 里（macOS/Windows），也被 systemd 以
 * `Restart=on-failure` 托管（服务器无头实例）。任何一次真正逃逸到事件循环的异常都会
 * 带走整个 DSH——用户那边表现为「DSH 崩了/插件把 DSH 搞挂了」，而且桌面端连个
 * 插件隔离层都没有，插件的 bug 直接就是宿主的 bug。
 *
 * 路由层其实已经被兜住了（`dsh-host-webserver` 给每个 handler 挂了 `.catch`），
 * 但**进程层那层兜底在本插件里是完全没有的**：`grep -rn "unhandledRejection\|uncaughtException"`
 * 在整个 dsh-mobile-plugin/ 与 dsh-mobile-server/ 里零命中。缺口正在于：
 *
 *  1. **游离的 Promise 拒绝**。Node 15+ 起 `unhandledRejection` 默认行为是 *throw*，
 *     也就是**杀进程**。插件里凡是 `void someAsync()`（fire-and-forget）的地方，
 *     一个没 catch 的 reject 就等于一次 DSH 崩溃。这类点极多：自动归档轮询、
 *     镜像推送、隧道重连、遥测上报……任意一个后台任务炸一次就够了。
 *  2. **第三方回调里抛错**。宿主事件流、WS 回调、timer 回调抛出的异常没有 try 包裹，
 *     直接升级为 `uncaughtException`。
 *
 * ## 策略：记录 + 保持存活，连续 5 次才退出
 *
 * 单个异常通常不致命（最常见的是"某个后台任务这一次没成"）。一刀切退出等于把
 * 偶发故障变成必然崩溃；一味吞掉又会掩盖真正的崩溃循环。所以取中间值：
 *
 *  - **记录**：每一条都进内存账本，带时间/类型/消息/是否致命，供 `status()` 暴露
 *    （「及时阻止」的前提是能看见）；
 *  - **保持存活**：`unhandledRejection` 与单次 `uncaughtException` 都只记录并继续跑，
 *    不退出。这把「插件的偶发 bug」和「DSH 崩溃」解耦了；
 *  - **熔断**：只有 `uncaughtException` 计入致命计数，且**必须落在时间窗内**。
 *    超过 `windowMs` 没再犯就重新计数——这样捕获的是「崩溃循环」（秒级连炸），
 *    而不是「跑三个月偶发 5 次」的正常长驻。真正熔断时再主动退出，交给
 *    `Restart=on-failure` / 桌面端重启拉起，拿到一个干净的新进程。
 *
 * ## 为什么把状态机和进程接线拆开
 *
 * `createGuard()` 是纯状态机（时间/日志/退出都注入），测试可以完全确定性地驱动它，
 * 不必真的往 `process` 上挂处理器、也不会在跑测试时把测试进程搞死；
 * `installProcessGuard()` 才是那层薄薄的进程接线。这个拆分是本模块能被守卫测试
 * 覆盖的前提。
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
 *            record: Function, faults: Function, stats: Function, clear: Function,
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
 * 这是本模块想复用的那一块：插件里大量 fire-and-forget 的调用点（自动归档轮询、
 * 镜像推送、遥测、隧道重连……）都可以直接套一层，再也不必各自 try/catch，
 * 也再也不会有一处忘了 catch 就把 DSH 带走。
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

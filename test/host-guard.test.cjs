'use strict';

/**
 * 宿主进程级错误边界的守卫测试。
 *
 * 这个模块是「插件不许把 DSH 弄崩」这条要求的唯一执行点，所以守卫要钉死的是
 * **策略本身**，而不只是「函数被调用了」：
 *
 *  1. 单个未捕获异常**不能**退出——一刀切退出会把偶发故障变成必然崩溃；
 *  2. 连续 5 个（缺省）未捕获异常**必须**退出——否则真崩溃循环会一直挂着坏状态跑；
 *  3. 「连续」有**时间窗**：隔开的零星故障不许累加到熔断，否则跑久了必然误熔断；
 *  4. `unhandledRejection` **不参与**熔断——游离 reject 在长驻服务里太常见，
 *     把它算进退出条件等于制造新的崩溃源；
 *  5. 每一条都要进账本，且账本有上限——「及时阻止」的前提是先能看见。
 *
 * 本测试驱动真实的 `createGuard` 状态机（不是转写实现）；时钟/日志/退出全部注入，
 * 所以不会真的挂到 process 上，也不会在跑测试时把测试进程杀掉。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const {
  createGuard,
  installProcessGuard,
  safeAsync,
  describeError,
  FATAL_FAULT_COUNT,
  CONSECUTIVE_FAULT_WINDOW_MS,
  FAULT_LEDGER_LIMIT,
  FATAL_EXIT_CODE,
} = require('../lib/host-guard.cjs');

/** 建一个全注入的边界：可控时钟、收集日志、记录退出调用。 */
function harness(options = {}) {
  const calls = { log: [], exit: [] };
  let clock = options.startAt ?? 1_700_000_000_000;
  const guard = createGuard({
    now: () => clock,
    log: (line) => calls.log.push(line),
    exit: (code) => calls.exit.push(code),
    ...options,
  });
  return {
    guard,
    calls,
    advance(ms) { clock += ms; },
    setClock(v) { clock = v; },
  };
}

test('单个未捕获异常不退出：插件的偶发 bug 不该带走 DSH', () => {
  const { guard, calls } = harness();
  const fatal = guard.handleUncaughtException(new Error('一次后台推送失败'));
  assert.equal(fatal, false);
  assert.equal(calls.exit.length, 0, '第 1 次未捕获异常绝不能触发退出');
  assert.equal(guard.stats().consecutive, 1);
});

test('连续 5 次未捕获异常触发熔断退出，且只退一次', () => {
  const { guard, calls } = harness();
  let last = false;
  for (let i = 0; i < FATAL_FAULT_COUNT; i += 1) last = guard.handleUncaughtException(new Error(`boom ${i}`));
  assert.equal(last, true, '第 5 次应判定为崩溃循环');
  assert.deepEqual(calls.exit, [FATAL_EXIT_CODE], '只应退出一次，且用 FATAL_EXIT_CODE');
  assert.equal(guard.stats().fatal, true);
});

test('4 次不退出、5 次才退出：熔断阈值必须是 5 而不是 4', () => {
  const { guard, calls } = harness();
  for (let i = 0; i < FATAL_FAULT_COUNT - 1; i += 1) guard.handleUncaughtException(new Error(`boom ${i}`));
  assert.equal(calls.exit.length, 0, '阈值前不能退');
  guard.handleUncaughtException(new Error('最后一次'));
  assert.equal(calls.exit.length, 1);
});

test('超出时间窗的零星故障不累加：长驻进程不能因为跑得久就误熔断', () => {
  const { guard, calls, advance } = harness();
  // 每两次之间都隔一个窗口以上，模拟「三个月里偶发 5 次」
  for (let i = 0; i < FATAL_FAULT_COUNT * 3; i += 1) {
    guard.handleUncaughtException(new Error(`偶发 ${i}`));
    advance(CONSECUTIVE_FAULT_WINDOW_MS + 1);
  }
  assert.equal(calls.exit.length, 0, '跨越时间窗的故障必须重新计数');
  assert.equal(guard.isFatal(), false);
});

test('窗口内的快速连炸仍会熔断（时间窗不能被用来逃逸熔断）', () => {
  const { guard, calls, advance } = harness();
  for (let i = 0; i < FATAL_FAULT_COUNT - 1; i += 1) {
    guard.handleUncaughtException(new Error(`快炸 ${i}`));
    advance(100); // 100ms << 60s
  }
  guard.handleUncaughtException(new Error('快炸 4'));
  assert.equal(calls.exit.length, 1, '窗口内的连炸必须照样熔断');
});

test('unhandledRejection 永不影响熔断计数', () => {
  const { guard, calls } = harness();
  for (let i = 0; i < FATAL_FAULT_COUNT * 4; i += 1) guard.handleUnhandledRejection(new Error(`游离 reject ${i}`));
  assert.equal(calls.exit.length, 0, '游离 reject 不是致命类，不能累加成退出');
  assert.equal(guard.stats().consecutive, 0, '也不该占用 uncaughtException 的连续计数');
  const kinds = guard.faults().map((f) => f.kind);
  assert.equal(kinds.length, FATAL_FAULT_COUNT * 4, '但必须都进账本');
  assert.ok(kinds.every((k) => k === 'unhandledRejection'));
});

test('unhandledRejection 之后紧跟 uncaughtException，连续计数从 1 起算', () => {
  const { guard, calls } = harness();
  for (let i = 0; i < FATAL_FAULT_COUNT; i += 1) guard.handleUnhandledRejection(new Error(`r${i}`));
  for (let i = 0; i < FATAL_FAULT_COUNT - 1; i += 1) guard.handleUncaughtException(new Error(`u${i}`));
  assert.equal(calls.exit.length, 0, 'rejection 不许把计数预热到阈值');
  guard.handleUncaughtException(new Error('u4'));
  assert.equal(calls.exit.length, 1);
});

test('账本有上限：满了丢最旧的', () => {
  const { guard } = harness({ ledgerLimit: 4 });
  for (let i = 0; i < 10; i += 1) guard.handleUnhandledRejection(new Error(`e${i}`));
  const faults = guard.faults();
  assert.equal(faults.length, 4, '账本必须封顶，否则长驻进程会把它撑爆');
  assert.match(faults[0].message, /e6/, '丢的应该是最旧的');
  assert.match(faults[3].message, /e9/, '留的应该是最新的');
});

test('熔断的那一条在账本里被标成 fatal，便于排障时一眼认出', () => {
  const { guard } = harness();
  for (let i = 0; i < FATAL_FAULT_COUNT; i += 1) guard.handleUncaughtException(new Error(`b${i}`));
  const last = guard.faults().at(-1);
  assert.equal(last.fatal, true);
  assert.equal(last.kind, 'uncaughtException');
  assert.ok(last.at > 0, '账本条目必须带时间');
});

test('非 Error 的抛出物（reject 一个字符串/对象）也能记下来', () => {
  const { guard } = harness();
  guard.handleUnhandledRejection('就是一个字符串');
  guard.handleUnhandledRejection({ code: 'E_CUSTOM', detail: 42 });
  const [a, b] = guard.faults();
  assert.equal(a.message, '就是一个字符串');
  assert.match(b.message, /E_CUSTOM/, '对象要能压成可读文本');
  assert.equal(describeError(null), 'null');
});

test('clear() 复位账本与计数', () => {
  const { guard, calls } = harness();
  for (let i = 0; i < FATAL_FAULT_COUNT; i += 1) guard.handleUncaughtException(new Error(`c${i}`));
  assert.equal(guard.isFatal(), true);
  guard.clear();
  assert.equal(guard.faults().length, 0);
  assert.equal(guard.isFatal(), false);
  assert.equal(guard.stats().consecutive, 0);
  // 复位后仍能重新熔断
  for (let i = 0; i < FATAL_FAULT_COUNT; i += 1) guard.handleUncaughtException(new Error(`d${i}`));
  assert.equal(calls.exit.length, 2);
});

test('installProcessGuard 真的在 process 上挂/摘两个处理器', () => {
  const target = new EventEmitter();
  const { uninstall } = installProcessGuard({ target, now: () => 0, log: () => {}, exit: () => {} });
  assert.equal(target.listenerCount('uncaughtException'), 1);
  assert.equal(target.listenerCount('unhandledRejection'), 1);
  uninstall();
  assert.equal(target.listenerCount('uncaughtException'), 0, 'uninstall 必须摘干净');
  assert.equal(target.listenerCount('unhandledRejection'), 0);
});

test('safeAsync：被包的函数 reject 时不外泄，并记进账本', async () => {
  const { guard } = harness();
  const guarded = safeAsync(async () => { throw new Error('异步炸了'); }, 'mirror-push', guard);
  await guarded();
  const faults = guard.faults();
  assert.equal(faults.length, 1);
  assert.equal(faults[0].kind, 'safeAsync');
  assert.match(faults[0].message, /mirror-push/, '必须能看出是哪个调用点');
  assert.match(faults[0].message, /异步炸了/);
});

test('safeAsync：同步抛出同样被吞（fire-and-forget 调用点不该反噬）', async () => {
  const { guard } = harness();
  const guarded = safeAsync(() => { throw new Error('同步炸了'); }, 'session-cleanup', guard);
  await guarded();
  assert.equal(guard.faults().length, 1);
  assert.match(guard.faults()[0].message, /session-cleanup/);
});

test('safeAsync：正常路径保持 undefined 结果，参数原样透传', async () => {
  const { guard } = harness();
  const seen = [];
  const guarded = safeAsync(async (a, b) => { seen.push([a, b]); return '返回值被丢弃'; }, 'ok', guard);
  assert.equal(await guarded(1, 2), undefined);
  assert.deepEqual(seen, [[1, 2]]);
  assert.equal(guard.faults().length, 0, '正常调用不许污染账本');
});

test('safeAsync 走已安装的全局边界：各调用点共用同一条上报路径', async () => {
  const target = new EventEmitter();
  const { guard } = installProcessGuard({ target, now: () => 0, log: () => {}, exit: () => {} });
  try {
    await safeAsync(async () => { throw new Error('全局路径'); }, 'relay-tunnel')();
    assert.equal(guard.faults().length, 1);
    assert.match(guard.faults()[0].message, /relay-tunnel/);
  } finally {
    // 摘掉，避免污染后面测试的全局状态
    target.removeAllListeners();
  }
});

test('safeAsync 返回的 Promise 本身永不 reject', async () => {
  const { guard } = harness();
  const guarded = safeAsync(async () => { throw new Error('x'); }, 'lbl', guard);
  const p = guarded();
  assert.ok(p instanceof Promise);
  // 若外泄，这里会直接 reject 让测试失败
  assert.equal(await p, undefined);
});

test('守卫是接线到真实宿主上的，不是写了个没人用的模块', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const host = fs.readFileSync(path.join(__dirname, '..', 'host.js'), 'utf8');
  const installed = host.indexOf('installProcessGuard()');
  assert.ok(installed >= 0, 'host.js 必须真的安装进程级边界，否则模块等于没接上');
  const boot = host.indexOf('await boot(');
  assert.ok(boot >= 0, 'host.js 应当仍然引导宿主');
  assert.ok(installed < boot, '边界必须装在 boot 之前：启动阶段的游离 reject 同样会杀进程');
});

test('成功路径必须撤掉 installFailLoud：它会在运行期把 DSH 直接 exit 掉', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const host = fs.readFileSync(path.join(__dirname, '..', 'host.js'), 'utf8');
  // `installFailLoud` 给 process 挂的 unhandledRejection 处理器会对**任何** reject
  // 直接 exit(1)，而宿主是长驻进程。它原本只在 catch 里被撤（boot 失败时），
  // 成功路径从来不撤 —— 于是运行期第一次游离 reject 就会带走整个 DSH，
  // 进程级边界记完账也只能眼睁睁看着 PID 被换掉。
  const asserted = host.indexOf('await assertEntriesActivated(');
  assert.ok(asserted >= 0, 'host.js 应当仍然校验入口已激活');
  const ready = host.indexOf('mobile host ready');
  const disarm = host.indexOf('releaseFailLoud()', asserted);
  assert.ok(disarm >= 0, '成功路径必须调用 releaseFailLoud() 撤掉装载期兜底');
  assert.ok(disarm < ready, '撤除必须发生在宣告 ready 之前，否则启动窗口仍是裸奔的');
  // catch 分支里那一处是 boot 失败时的既有逻辑，不算。
  assert.notEqual(disarm, host.indexOf('await releaseFailLoud()'), '成功路径要的是裸调用，不是 await 版本');
});

test('故障账本经 /api/relay/faults 暴露（否则「及时阻止」无从谈起）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  // 控制面路由已抽到 lib/routes/control-plane.js（见该文件头的说明）。
  const index = fs.readFileSync(path.join(__dirname, '..', 'lib', 'routes', 'control-plane.js'), 'utf8');
  const at = index.indexOf("'/api/relay/faults'");
  assert.ok(at >= 0, '必须有一个本机只读的故障查询端点');
  // 只看**这一条路由自己的注册表达式**：窗口放宽到相邻路由，就会被邻居的
  // localOnly 蒙混过关（曾经就这么放过一次变异）。
  const end = index.indexOf('registerRoute', at + 1);
  const route = index.slice(at, end < 0 ? at + 600 : end);
  assert.match(route, /localOnly\('GET'/, '故障端点必须仅限本机访问：账本里带堆栈');
  // 光「调用了 activeGuard()」不够：照样可以拿到 guard 却回一个硬编码空数组，
  // 端点看起来正常、实际上永远报「没有故障」——那正是排障时最坏的情况。
  assert.match(route, /activeGuard\(\)/, '端点必须真的去取那条边界');
  assert.match(route, /faults:\s*guard\.faults\(\)/, '响应体必须真的把账本带出去');
});

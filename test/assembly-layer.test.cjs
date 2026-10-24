'use strict';

/**
 * 守卫：装配层的边界。
 *
 * 起因：装配层一度是 845 行的单函数——两套路由基建、sidecar 生命周期、
 * 镜像推送调度器、状态视图全挤在里面。每一块抽出去都留了一条边界断言，因为这类拆分
 * 最常见的失败方式不是「抽错了」，而是半年后有人嫌绕，又把实现搬回 apply()。
 *
 * 这里钉的是「哪些实现不许回到装配层」，不是「装配层恰好多长」——行数上限
 * 只作为兜底，真正的判据是具体函数与定时器。
 *
 * 装配层是 `lib/impl.js`（住在外壳装载的**代**里）；插件入口是稳定外壳 `lib/index.js`。
 *
 * 从前入口是 `lib/index.js` + `lib/shell/*` 那套「稳定外壳 + 可热替换的代」，2026-10
 * 整套拆掉了：插件改成从 npm 分发、更新交给 DSH 的插件市场，不再有代际目录与热替换
 * （那条路只换宿主侧实现代、换不掉设置菜单那一半，正是「更新报成功、界面一动不动」的来源）。
 * 于是入口与实现合成一个文件，「入口别长成实现」这条边界也就不存在了 —— 剩下的是
 * 「实现别重新糊回 apply()」，就是下面这些断言。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');
const INDEX = path.join(LIB, 'impl.js');
const LIFECYCLE = path.join(LIB, 'sidecar-lifecycle.cjs');
const PUSHER = path.join(LIB, 'mirror', 'pusher.cjs');

const read = (file) => fs.readFileSync(file, 'utf8');
const lineCount = (file) => read(file).split('\n').length;

/** 已经搬走的实现：名字 → 现在的住处（只用于报错信息说清该去哪）。 */
const EXTRACTED = [
  ['pushMirrorPayload', PUSHER],
  ['buildSessionData', PUSHER],
  ['pushSessionNow', PUSHER],
  ['processBgQueue', PUSHER],
  ['recordMirrorPush', PUSHER],
  ['pushSessionImmediately', PUSHER],
  ['purgePluginLibCache', LIFECYCLE],
  ['restartSidecar', LIFECYCLE],
  ['applySidecarConfig', LIFECYCLE],
  ['markSidecarDown', LIFECYCLE],
];

test('装配层回到一个可读的行数区间（兜底判据）', () => {
  const lines = lineCount(INDEX);
  // 400 → 408：新增 `advertisedLanPort`（一行取值器）+ 本文件文件头注释块（6 行，
  // 仓库规范要求动过的文件补文件头，见 AGENTS.md §0 第 7 条）。
  // 408 → 409（2026-10，自更新搬回）：装配层要把**外壳**的换代服务透给控制面路由表
  // （那四条 update 路由住在代里、机制住在外壳里），净增一行取值器 + 两行注释。
  // 409 → 413（2026-10-11，「手机优先用这条地址」）：新增一项配置字段在装配层只可能落三处
  // —— schema 一项、configOf 一行取值、二维码候选那一行的排序（`orderCandidates`），
  // 再加两行指着 lan-network.cjs 的短注释。那三处一行都搬不走（schema 与 state 都住在这里），
  // 所以只按这个必要增量放宽；`preferredLanAddress` 不进 sidecar 的 `buildConfig`，
  // 装配层没有多出任何实现。
  // 对外报地址的端口得由持有 state 的装配层转交给三处消费点，而 lifecycle 不持有
  // state，那段搬不走。真正该拦的是「实现搬回来」，那几条具体函数/定时器断言仍是严格
  // 判据；行数只是兜底，所以只按这次的必要增量放宽，不多给余量。
  // 413 → 417（2026-10-17，配对归宿主）：移动端配对的判断落在 `lib/mobile/pairing.js`，
  // 装配层只把本文件已有的 `core` 与 `pairingApproval` 透传给路由表（两行取值 + 两行注释）。
  // 没有任何实现搬回来。
  // 417 → 424（2026-10-17，typertGateway 注入）：`inject` 那一支要加 `typertGateway`，
  // 外加六行解释「不注入不是报错而是静默降级」。全是声明与注释，没有实现搬回来。
  // 417 → 424（2026-10-17，typertGateway 注入）：`inject` 那一支要加 `typertGateway`，
  // 外加六行解释「不注入不是报错而是静默降级」。全是声明与注释，没有实现搬回来。
  // 424 → 431（2026-10-19，内存自检台账）：台账本体住在 `lib/mobile/self-check.cjs`，
  // 装配层只把**本文件已有**的四个取值器转交给控制面（sidecar 快照、镜像记账两枚、
  // 局域网 stats），外加三行注释说清「侧车内存与流数只有 worker 的 /status 快照这一条
  // 通道」。那四个取值器全都是本文件已有的东西（`sidecarLifecycle.getSnapshot`、
  // `mirror.getMirrorPush`、`mirror.getPushFailures`），一行实现都没有搬回来；
  // `getLanProxyStats` 是取值器，不是逻辑。
  // 431 → 436（2026-10-19，审批桥）：装配层只多出「装载一行 + 判据一个 const」——
  // `installApprovalBridge` 与兼容桥**同生共死**（判据 `hasHostApiProxy` 由原来那行
  // `if (!runtimeProvidesApiProxy())` 提出来，省得同一判据写两遍而分叉），外加两行
  // 说明为什么两条桥的判据必须同源。审批桥本体住在 `lib/mobile/approvals.js`。
  // 436 → 438（2026-10-19，提问桥）：同样只有「装载一行 + 判据复用」，本体住在
  // `lib/mobile/questions.js`（`user-questions/request` 钩子，覆盖 ask_user_question 与
  // 计划评审）；判据仍是同一个 `hasHostApiProxy`，没有新逻辑进装配层。
  // 438 → 443（2026-10，IPv6 直连候选）：装配层只多两处**声明**——取值器转交给移动端路由表
  // （一行）+ 二维码 payload 里多一个字段（一行，附两行注释说清它为什么不掺进那份排序）。
  // 枚举与分类（全球单播判定、方括号产出、临时地址为什么不挑）全部住在
  // `lib/relay/lan-network.cjs`，一行实现都没有搬回来。
  // 443 → 448（2026-10-24，iOS 推送出口）：两处**声明**——创建推送出口一行 + 把
  // notifyTurnEnded 转交给镜像推送器一行（附一行注释）。帧的拼装、去重、发送全部住在
  // `lib/mobile/push-notify.js`；令牌上报的 handler 住在 `lib/mobile/push-notify-route.js`。
  // 448 → 454（2026-10-24，协议 v2 配对）：装配层只多出**一行**取值器——把
  // `rotatePairing` 交给配对 handler（「配对成功就换码换票据」只有它知道何时成立）。
  // 状态变更本体住在 `lib/relay/core.js` 的 `rotatePairing`，换码换票据的取舍写在那边；
  // 这里只是「改完让旁路重读配置」那一句。其余几行是这一项的注释。
  // 454 → 476（2026-10-24，协议 v2 信封接线）：装配层只多出**两个钩子**——按 keyId 查
  // 密钥的取值器、读原始请求体的一行，以及鉴权通过后记「最近连接 + 走哪条路」的那几行。
  // 验签/解封/封响应的本体全在 `lib/shared/e2ee-request.js` 与 `lib/http/routing.js`；
  // 凭据库的读写在 `dsh-mobile-credentials`。这里一行实现都没有。
  // 476 → 494（2026-10-24，插件管理上手机）：装配层只多出**一处声明**——把「这台设备的中转
  // 与连接配置」那一组依赖（十项全是本文件已有的实例/取值器）转交给移动端路由表，外加三行
  // 说明它们与控制面写的是同一份 relay.json、`getSidecar` 为什么必须是取值器。读配置 / 改配置
  // / 配对码 / 吊销 / 重连 / 端口自检 / 测速 / 诊断的本体住在 `lib/mobile/relay-control.js`。
  // 494 → 499（2026-10-24，同上一条的收尾）：config store 多了一个 `notify()` 与
  // `update(patch, { notify: false })` —— 手机改中转地址时必须「先回包、再让订阅者重配隧道」，
  // 否则响应会死在隧道搬迁里。这仍是 store 自己的接口，不是把实现搬回装配层。
  // 499 → 502（2026-10-24，吊销断流）：装配层只多出**一处声明**——把 `dropDeviceStreams`
  // 转交给控制面（吊销那台设备时收掉它已经开着的流）。登记表与断开本体住在
  // `lib/mobile/stream-registry.js`，两条流（会话流、设备级事件流）自己在开流时登记。
  // 503 → 512（2026-10-24，扩展卡）：装配层只多出**一处装载**——`installExtensions` 的一个
  // effect（与上面 session cleanup 同款 try/catch，缺 tools 注入时静默）外加一行 require。
  // 卡状态账本、宿主动作登记表与三条路由的 handler 全在 `lib/mobile/extensions.js`。
  // 512 → 517（2026-10-24，配对票据下发给旁路）：只多出 buildConfig 里的**一个字段**
  // （`pairingTicket`），其余是四行注释说清漏了它的现场 —— 旁路解不开加密配对，而主进程
  // 那条 `/pair` 一切正常。派生密钥与解封的本体住在 `lib/shared/e2ee-pair.js`。
  assert.ok(lines <= 517, `lib/impl.js 回到 ${lines} 行了；超过 517 说明实现又被搬回装配层`);
});

test('sidecar 生命周期与镜像推送的实现没有回到装配层', () => {
  const src = read(INDEX);
  for (const [name, home] of EXTRACTED) {
    assert.ok(
      !new RegExp(`(^|[^.\\w])${name}\\s*(=\\s*(async\\s*)?\\(|\\()`).test(src),
      `${name} 出现在 lib/impl.js 里，它住在 ${path.relative(LIB, home)}`,
    );
  }
});

test('装配层不再自己开定时器（健康轮询与后台补推各自归属明确）', () => {
  const src = read(INDEX);
  assert.ok(!/setInterval\(/.test(src), 'impl.js 又开始开定时器了：健康轮询归 lifecycle，后台补推归 pusher');
});

test('装配层只通过取值器拿到 sidecar 实例，不缓存引用', () => {
  // sidecar 会被自重启整体替换；装配层一旦把它存进 const，路由就会一直打在一个
  // 已经 stop 掉的 facade 上（/api/relay/revoke-all 曾是这样）。
  const src = read(INDEX);
  assert.doesNotMatch(src, /const\s+\w+\s*=\s*sidecar\b(?!Lifecycle)/, 'impl.js 缓存了 facade 实例');
  assert.match(src, /getSidecar:\s*sidecarLifecycle\.getSidecar/, '控制面必须拿取值器而不是实例');
});

test('两个 effect 各自只负责挂载，逻辑在被挂载的模块里', () => {
  const src = read(INDEX);
  assert.match(src, /ctx\.effect\(\(\) => sidecarLifecycle\.start\(\)/, 'sidecar effect 应只挂 lifecycle.start()');
  assert.match(src, /ctx\.effect\(\(\) => mirror\.start\(\)/, '镜像 effect 应只挂 mirror.start()');
  // 隧道接通时补推全量，是两个模块之间唯一的协作点，写成订阅而不是互相调用。
  assert.match(src, /sidecarLifecycle\.onTunnelUp\(\(\) => \{ void mirror\.pushMirror\(\); \}\)/);
});

test('镜像记账仍然是状态视图唯一的来源', () => {
  const src = read(INDEX);
  assert.match(src, /getMirrorPush:\s*mirror\.getMirrorPush/);
  assert.doesNotMatch(src, /mirrorPushAt|mirrorPushOk|mirrorPushError/, '记账状态搬进 pusher 后，impl.js 不该再留一份');
});

test('入口是稳定外壳：实现住在代里，换代不重启 DSH', () => {
  // 2026-10 曾经把外壳删掉（入口直接指实现），代价是**每次更新都要完整重启 DSH**；
  // 同月又按要求搬回来，理由是重启桌面端 DSH 会掐掉用户正在跑的对话。这条守卫钉的是
  // 外壳的两条命根子：① 入口必须指向它；② 它自己必须**只有装载逻辑**、不许长业务代码
  // （长进去就意味着改它要重启，热更新立刻失效）。
  const pkg = JSON.parse(read(path.join(__dirname, '..', 'package.json')));
  assert.equal(pkg.main, 'lib/index.js', '入口必须指向稳定外壳，实现住在外壳加载的代里');
  assert.equal(pkg.exports['.'], './lib/index.js', 'exports 的裸包名那条也要指外壳');
  for (const file of ['index.js', 'shell/runtime.js', 'shell/manager.js', 'shell/updater.js']) {
    assert.ok(fs.existsSync(path.join(LIB, file)), `lib/${file} 是自更新链路的一部分，不能缺`);
  }
  const shell = read(path.join(LIB, 'index.js'));
  assert.match(shell, /export const name = 'dsh-mobile-plugin'/, '外壳必须自报包名');
  assert.match(shell, /export const inject/, '外壳必须声明 inject，否则拿不到 webServer');
  assert.match(shell, /export function apply/, '外壳必须导出 apply');
  assert.match(shell, /createRuntime\(/, '外壳必须用 shell/runtime.js 装载代');
  assert.ok(shell.split('\n').length <= 200, `lib/index.js ${shell.split('\n').length} 行了：外壳只该有装载逻辑，业务代码住进代里`);
  // 装载失败必须**还会再试**：一次失败等于整张控制面路由表都不在，而设置页照样画得出来，
  // 现场只剩一句「读取宿主状态失败: HTTP 404」。行为测试造不出「所有代都失败」——随包
  // 那一代永远装得起来——所以这里钉接线与「有限次重试」的形状。
  assert.match(shell, /\.start\(ctx, \{ log \}\)/, '外壳要把日志交给 runtime.start，重试才有痕迹');
  const runtimeSource = read(path.join(LIB, 'shell', 'runtime.js'));
  assert.match(runtimeSource, /const START_RETRY_LIMIT = \d+/, '装载失败要按次数重试，不是一次就放弃');
  assert.match(runtimeSource, /for \(let attempt = 1; attempt <= START_RETRY_LIMIT; attempt \+= 1\)/, '重试循环必须是有上限的');
  assert.match(runtimeSource, /await sleep\(START_RETRY_MS\)/, '两轮之间要等间隔，别原地空转');
  assert.match(runtimeSource, /lastError = lastFailure/, '放弃前要把最后一次的真实失败原因留在状态里');
  // 业务面（移动 API 路由、隧道、镜像……）一律不许出现在外壳里。
  for (const forbidden of ['/api/mobile/v1', '/api/relay/', 'createRelay', 'mirror']) {
    assert.ok(!shell.includes(forbidden), `外壳里出现了 ${forbidden}：那是代的事，塞进外壳等于每次改它都要重启`);
  }
  // 实现那一侧不许反过来知道外壳的存在（它拿到的是普通 ctx）。
  assert.doesNotMatch(read(INDEX), /\.live|importGeneration|installedShellHash|wrapHandler/, 'impl.js 里还有热替换的残留');
});

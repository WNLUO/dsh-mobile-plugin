'use strict';

/**
 * 守卫：装配层的边界。
 *
 * 装配层一度是 845 行的单函数——两套路由基建、sidecar 生命周期、镜像推送调度器、状态视图
 * 全挤在里面。这类拆分最常见的失败方式不是「抽错了」，而是后来有人嫌绕，又把实现搬回
 * `apply()`。
 *
 * 这里钉的是「哪些实现不许回到装配层」，不是「装配层恰好多长」——行数上限只作为兜底，
 * 真正的判据是具体函数与定时器。装配层是 `lib/impl.js`。
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
  // 行数只是兜底：真正的判据是下面那几条「具体函数 / 定时器不许回到装配层」。这个上限只随
  // 装配层里多出来的**声明**（取值器转交、schema 一项、config 字段、二维码候选）与必要注释
  // 往上抬，实现一行都没有搬回来。2026-10-30 +13：inject 只留 webServer、每块装配各自兜住
  // （`mount` / `mountRoute` 的声明与说明），没有一行实现搬回来。2026-11-01 +7：手填的 IPv6
  // 直连地址 —— schema 一项、configOf 一行、二维码与移动端候选各一行（多出来的那行是注释），
  // 候选的合并逻辑在 `relay/lan-network.cjs` 的 `withManualIpv6Candidate`，没有搬回装配层。
  // 2026-11-04 +4：终端 / CLI 与「操作手机」各两行（一个 require、一个把服务交给路由表），
  // 实现分别在 `mobile/services.js` 与 `mobile/phone/`，没有一行搬回装配层。
  // 2026-11-05 +2：悬浮宠物的两个工具（一个 require、一个 mount），实现在
  // `mobile/pet-tools.js`，包目录与三条路由在 `mobile/pets.js`，没有一行搬回装配层。
  // 2026-11-06 +3：直连隧道的两个依赖转交（status 视图一格、移动端路由一格与注释），实现在
  // `lib/tailcat/`。
  // 2026-11-06 +8：直连隧道的挂载（一个 require、一次 `mountTailcat`、依赖表一行与注释）；
  // 入口、助手会话与启停都在 `lib/tailcat/`（`wiring.cjs` 只做挂载），没有一行搬回装配层。
  // 2026-11-07 +6：点对点隧道的挂载（一个 require、一次 `mountP2P`、两个依赖表转交与注释）；
  // 会话、命令与启停都在 `lib/p2p/`（`wiring.cjs` 只做挂载），没有一行搬回装配层。
  // 2026-11-07 +2：会合那一步要把 `p2p` 门面交给移动端路由表（一行转交、一行注释）——
  // 手机要把它自己的打洞候选报上来换电脑的地址，没有这一发两端连不上。实现在
  // `lib/p2p/rendezvous.cjs`，装配层只是把它挂上去。
  // 2026-11-08 +11：中转地址从单值扩成列表（schema 一项与注释、`configOf` 三行、`update`
  // 里一次收敛调用与注释、`buildConfig` 一格）。收敛规则本身在 `relay/core.js` 的
  // `applyRelayAddressPatch` / `normalizeRelayAddresses`，没有一行搬回装配层。
  // 2026-11-08 +3：择路成功后把主用地址写回配置（一个 require、一行挂订阅、一行注释）。
  // 判断与写盘规则在 `relay/route-adopt.cjs`（宿主是 relay.json 唯一写方），装配层只是挂上去。
  // 2026-11-09 +4：通话总管的两块（总管工具、两本账）各一 require 一 mount，实现都在
  // `mobile/supervisor-tools.js` 与 `mobile/supervisor-memory/`，没有一行搬回装配层。
  // 2026-11-10 +9：推送出口接线（`createPushNotifier` 一 require 一实例化、晚绑定壳两行、
  // 传给镜像调度器一格、交给路由表一格、两个 `setPushNotifier` 各一行）；组帧、去重与
  // 投递都在 `mobile/push-notify.js`，装配层只是把它接上。
  assert.ok(lines <= 612, `lib/impl.js 回到 ${lines} 行了；超过 612 说明实现又被搬回装配层`);
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

/**
 * 装配的**故障边界**：别人的插件撞了同一个路由 / 占了同一个服务名，代价只许是那一块，
 * 不许是整张移动 API。
 *
 * 这一条只能钉形状：装配层里一个没兜住的 throw 会让 fiber 回滚，已经注册好的几百条路由
 * 一起消失（手机上表现为「插件装了但什么都 404」），而造出那个现场的（另一个插件用了
 * 同一个路径）不在这个仓库里。
 */
test('装配逐块兜住：路由撞车只丢那一条，一块挂不上不影响其余', () => {
  const src = read(INDEX);
  // 每条路由自己的 try：`webServer.register` 对重复路径是抛错。
  assert.match(
    src,
    /const mountRoute = \(route, upgrade\) => mount\(`路由 \$\{route\.path\}`[\s\S]*?try \{ return upgrade \? ctx\.webServer\.registerUpgrade\(route\) : ctx\.webServer\.register\(route\) \} catch \(error\) \{/,
    '注册失败必须在 mountRoute 里就地吞掉并记日志，抛出去会带走整个 fiber',
  );
  assert.match(src, /function registerRoute\(route\) \{\n    mountRoute\(route\)/, 'registerRoute 必须走 mountRoute');
  assert.match(src, /registerUpgradeRoute: \(route\) => mountRoute\(route, true\)/, '升级路由（预览）同样要逐条兜住');
  // 大块的装配各自 mount：任何一块炸掉只留一行日志。
  for (const block of ['控制面路由', '移动端路由', 'sidecar', '镜像推送', '审批桥', '提问桥', '统计采集', '服务同步']) {
    assert.ok(src.includes(`mount('${block}'`), `「${block}」这块装配没有各自的兜住`);
  }
  assert.match(src, /const warn = \(message, \.\.\.rest\) => \{\n    try \{ ctx\.logger\?\.warn\?\./, '告警出口自己不许反噬装配');
  // `apiProxy` 是公共名字：别人先占了就用人家的，不跟它抢。
  assert.match(src, /mount\('apiProxy 兼容桥', \(\) => ctx\.reflect\.provide\('apiProxy'/, 'provide 撞车必须降级，不许把整块装配带走');
});

test('外壳包装宿主的路由注册时可叠加、撤离不摘别人的那层', () => {
  const shell = read(path.join(LIB, 'index.js'));
  assert.match(shell, /const wrapper = function register\(route\)/, '包装要留一个可比较的引用');
  assert.match(shell, /if \(server\.register === wrapper\) server\.register = outer/, '只在「现在挂的是我们这层」时才还原，否则会摘掉别的插件叠在上面的包装');
});

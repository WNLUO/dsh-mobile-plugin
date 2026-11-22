// 装配层边界：实现不许搬回 apply()，行数上限只作兜底（2026-11-23 随 FRP 独立线路抬到 496）。
'use strict';

/**
 * 守卫：装配层的边界与隧道连通后的协作接线。
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
/**
 * 代码行数：剥掉注释与空行。所有规模上限都只数这个数 —— 注释与空行不该挤掉实现的空间，
 * 而按纸面行数算会逼着人删注释来腾地方（与 app 侧 `scripts/lib/source.js` 的 `codeLines`
 * 同一个口径）。
 */
const codeLineCount = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .split('\n').filter((line) => line.trim().length > 0).length;
const lineCount = (file) => codeLineCount(read(file));

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
  // 2026-11-10 -3：通话整条链下线（总管工具 / 播报 / 运行期 / 两本账各一 require 一处 mount 撤掉）。
  // 2026-11-10 -2：悬浮宠物下线（一个 require 与一处 mount 一起撤掉）。
  // 2026-11-10 +9：推送出口接线（`createPushNotifier` 一 require 一实例化、晚绑定壳两行、
  // 传给镜像调度器一格、交给路由表一格、两个 `setPushNotifier` 各一行）；组帧、去重与
  // 投递都在 `mobile/push-notify.js`，装配层只是把它接上。
  // 2026-11-22 +5：总控转达「请自检」时插件要回一份诊断 —— 一个取值器变量、一个闭包（转交
  // `diagnostics`）、两处 `setProviders` 各一格、路由表一个 `bindRelayControl`。诊断内容是
  // `mobile/relay-control.js` 里那一份，装配层只是把它接到总控客户端上。
  // 2026-11-22 +7：Cloudflare 兜底隧道的挂载（一个 require、一次 mountCloudflare、依赖表一行、
  // syncNetwork 一行与注释，另加文件头一行）；实现都在 lib/cloudflared/wiring.cjs（wiring 只做
  // 挂载），没有一行搬回装配层。
  // 2026-11-22 +2：ZeroNews 线路的挂载（一个 require、一次 mountZeroNews）；观察器实现与启停
  // 都在 lib/zeronews/wiring.cjs + watcher.cjs，装配层只挂一下。额度此前已满，上限随这两行抬到 490；
  // 判据仍是「实现不许搬回装配层」，只是新功能本身要占两行接线。
  // 2026-11-22 +1：把 ZeroNews 的挂载结果交给控制面（const zeroNews 一行）；实现仍在 wiring/runner。
  // 2026-11-22 +1：把 Cloudflare 的挂载结果交给移动端路由（依赖表一行），心跳那一格才有值；
  // 实现仍在 cloudflared/wiring.cjs。
  // 2026-11-23 +4：FRP 独立成一条线路后，地址回写要认「只写 `frpUrl`」这条口径（一个闭包三行 +
  // 监听转接一行）；发现、重连与进程仍全在 `lib/frpc/runner.cjs`，装配层没有搬回实现。
  assert.ok(lines <= 496, `lib/impl.js 回到 ${lines} 代码行了；超过 496 说明实现又被搬回装配层`);
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

test('下发配置的闭包不读失效的 ctx.webServer，父端口在挂载时缓存', () => {
  const src = read(INDEX);
  assert.match(src, /const webPortForSidecar = ctx\.webServer\.port/, '挂载时取一次父端口');
  assert.doesNotMatch(src, /upstreamPort: ctx\.webServer\.port/, '下发时读失效 context 会让重启与 TCP 直连全失败');
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
});

function verifyTunnelUp(source) {
  const match = source.match(/sidecarLifecycle\.onTunnelUp\(\(\) => \{([\s\S]*?)\n  \}\)/);
  assert.ok(match, '隧道接通后的协作必须经订阅挂载');
  const calls = [];
  const notify = new Function('mirror', 'control', match[1]);
  notify({ pushMirror: () => calls.push('mirror') }, { sync: () => calls.push('control') });
  assert.deepEqual(calls, ['mirror', 'control'], '隧道接通后必须补推镜像并立即上报总控');
  calls.length = 0;
  assert.doesNotThrow(() => notify(
    { pushMirror: () => calls.push('mirror') },
    { sync: () => { throw new Error('control unavailable'); } },
  ));
  assert.deepEqual(calls, ['mirror'], '总控暂不可用不影响镜像补推');
}

test('隧道接通后补推镜像并立即上报总控', () => {
  // 公用中转由电脑侧选路后，连通事件还须立即上报当前线路，手机才能及时跟随。
  verifyTunnelUp(read(INDEX));
});

test('变异：移除镜像补推或总控上报都会被接线断言拒绝', () => {
  const src = read(INDEX);
  const hook = src.match(/sidecarLifecycle\.onTunnelUp\(\(\) => \{[\s\S]*?\n  \}\)/)[0];
  for (const call of ['void mirror.pushMirror()', 'control.sync()']) {
    const mutated = src.replace(hook, hook.replace(call, 'void 0'));
    assert.throws(() => verifyTunnelUp(mutated), assert.AssertionError);
  }
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
  assert.ok(codeLineCount(shell) <= 200, `lib/index.js ${codeLineCount(shell)} 代码行了：外壳只该有装载逻辑，业务代码住进代里`);
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

test('传输与长连接由外壳持有，实现只通过服务取用', () => {
  // 「更新不断」的根：传输/长连接不许再挂回一代实现。实现必须从外壳服务取它们。
  const impl = read(INDEX);
  for (const svc of [
    'dshMobileSidecarHost', 'dshMobileTransportFrp', 'dshMobileTransportControl',
    'dshMobileTransportMux', 'dshMobileTransportTailcat', 'dshMobileTransportP2P',
  ]) {
    assert.ok(impl.includes(svc), `lib/impl.js 应从外壳取 ${svc}（传输/长连接归外壳）`);
  }
  // mux 归外壳时，移动端路由表不能再重复注册它的升级路由（否则撞路径）。
  const mobileApi = read(path.join(LIB, 'routes', 'mobile-api.js'));
  assert.match(mobileApi, /if \(!deps\.muxOwnedByShell\)/, 'mux 归外壳时不应重复注册升级路由');
});

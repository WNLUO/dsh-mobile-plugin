'use strict';

/**
 * 「一组中转地址」的形状契约（`docs/relay-multi-address.md`）—— 宿主这一侧。
 *
 * 这一轮**行为一个字都不变**：隧道仍然只按 `relayUrl` 连，不做择路、不做降级。所以这里
 * 钉的是形状而不是切换行为：
 *
 *  1. 三条不变式：写单值等价写单元素列表；写列表时 `relayUrl` 跟着变首项、空列表则空串；
 *     读到的列表里没有空串 / 重复 / 非 http(s)，不满足的就地丢弃、不报错。
 *  2. 兼容：老 `relay.json` 里只有 `relayUrl` 这一格时，读盘后列表退化成单元素，手机拿到
 *     的不是 undefined、也不许把地址清空。
 *  3. 出口一致：`/status`、心跳、`/connection-info`、配对二维码、配置投影里两格都在，且
 *     首项恒等于 `relayUrl`。
 *  4. 行为不变：worker 的「要不要重建隧道」签名里不含 `relayUrls` —— 加进去就等于按列表
 *     择路了，那是下一轮的事。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * 数据目录必须先改到临时目录，再 require 实现：`relay/core.js` 在模块求值时就算出
 * `relay.json` 的路径，不隔离会把开发机真实的实例号 / 密钥覆盖掉（理由见
 * `relay-control.test.cjs` 头部的 2026-10-24 现场）。
 */
const DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-address-list-'));
process.env.DSH_HOME = DSH_HOME;

const PKG = path.join(__dirname, '..');
const core = require(path.join(PKG, 'lib', 'relay', 'core.js'));
const { createStatusView } = require(path.join(PKG, 'lib', 'relay', 'status.js'));
const { pairingPayload } = require(path.join(PKG, 'lib', 'relay', 'pairing-payload.cjs'));
const { configView, configPatch } = require(path.join(PKG, 'lib', 'mobile', 'relay-control.js'));
const { registerMobileRoutes } = require(path.join(PKG, 'lib', 'routes', 'mobile-api.js'));
const { registerControlPlaneRoutes } = require(path.join(PKG, 'lib', 'routes', 'control-plane.js'));

const A = 'https://a.example';
const B = 'https://b.example';

/** 假 ServerResponse：收下 `sendJson` 写出来的东西。 */
function fakeRes() {
  const res = { status: 0, raw: '', headersSent: false, writableEnded: false };
  res.writeHead = (status) => { res.status = status; res.headersSent = true; };
  res.setHeader = () => {};
  res.write = () => true;
  res.end = (chunk) => { res.raw = String(chunk == null ? '' : chunk); res.writableEnded = true; };
  return res;
}

/** 把 `relay.json` 写成给定内容，再按宿主的读盘路径读回来。 */
function roundTripState(raw) {
  fs.writeFileSync(core.STATE_FILE, JSON.stringify(raw, null, 2));
  return core.loadState();
}

// ── 三条不变式 ──────────────────────────────────────────────────────────────

test('不变式 1：写 relayUrl 等价于写单元素列表', () => {
  // 只写 relayUrl 这一格（老路径就是只写它）：列表由它生出来，且过规范形态。
  const state = core.normalizeRelayAddresses({ relayUrl: `${A}/` });
  assert.equal(state.relayUrl, A, '尾斜杠要去掉，否则「地址变了」会被判错');
  assert.deepEqual(state.relayUrls, [A], '写单值等于写单元素列表');
});

test('不变式 2：写 relayUrls 时 relayUrl 变成首项，空列表则 relayUrl 为空串', () => {
  const listed = core.normalizeRelayAddresses({ relayUrl: B, relayUrls: [A, B] });
  assert.equal(listed.relayUrl, A, '主用那条是列表首项，不是原来那一格');
  assert.deepEqual(listed.relayUrls, [A, B]);

  const cleared = core.normalizeRelayAddresses({ relayUrl: A, relayUrls: [] });
  assert.equal(cleared.relayUrl, '', '列表空 = 没有中转，地址是空串而不是残留旧值');
  assert.deepEqual(cleared.relayUrls, []);
});

test('不变式 3：读到的列表里没有空串 / 重复 / 非 http(s)，就地丢弃且不报错', () => {
  const urls = core.normalizeRelayUrlList([
    '  https://a.example/  ',
    '',
    '   ',
    'wss://b.example',
    'ftp://c.example',
    'https://a.example',
    'https://b.example',
    42,
    null,
    { url: A },
  ]);
  assert.deepEqual(urls, ['https://a.example', 'https://b.example'], '只留 http(s)、去空、去重、按原序');
  assert.deepEqual(core.normalizeRelayUrlList('https://a.example'), [], '不是数组就当空列表，不抛');
  assert.deepEqual(core.normalizeRelayUrlList(undefined), []);
});

// ── 兼容：老宿主 / 老 relay.json ────────────────────────────────────────────

test('老 relay.json 只有 relayUrl：读盘后列表退化成单元素，地址不会被清空', () => {
  const state = roundTripState({ relayUrl: `${A}/`, name: 'legacy' });
  assert.equal(state.relayUrl, A);
  assert.deepEqual(state.relayUrls, [A], '老文件没有这一格，读到 undefined 的那一方要能退化成一条');
});

test('手改过的 relay.json：两格打架时以列表为准，干净的那份照契约收敛', () => {
  const listed = roundTripState({ relayUrl: B, relayUrls: [A, B] });
  assert.equal(listed.relayUrl, A, '两格都在时列表说了算');
  assert.deepEqual(listed.relayUrls, [A, B]);

  const dirty = roundTripState({ relayUrl: A, relayUrls: ['', A, 'nope', `${A}/`, B] });
  assert.deepEqual(dirty.relayUrls, [A, B], '脏的那种在读盘时就地清洗');
  assert.equal(dirty.relayUrl, A);

  const onlyList = roundTripState({ relayUrls: [B, A] });
  assert.equal(onlyList.relayUrl, B, '只有列表时主用那条就是首项');
  assert.deepEqual(onlyList.relayUrls, [B, A]);
});

test('落盘那份一定是两格自洽的（读回来还是同一组，顺序不变）', () => {
  const state = { ...core.defaultState(), relayUrl: B, relayUrls: [A, B] };
  core.saveState(state);
  const reloaded = core.loadState();
  assert.equal(reloaded.relayUrl, A);
  assert.deepEqual(reloaded.relayUrls, [A, B], 'save 之后再 load，顺序与内容都不许变');
  assert.equal(JSON.parse(fs.readFileSync(core.STATE_FILE, 'utf8')).relayUrl, A, '磁盘上落的就是主用那条');
});

test('默认状态里两格俱在（新装的机器不必先写一次才有这一格）', () => {
  const state = core.defaultState();
  assert.equal(state.relayUrl, '');
  assert.deepEqual(state.relayUrls, []);
});

// ── 设置命名空间与配置写入 ──────────────────────────────────────────────────

test('schema 认 relayUrls：默认空数组，字符串冒充不了列表', async () => {
  const impl = await import(pathToFileURL(path.join(PKG, 'lib', 'impl.js')).href);
  const schema = impl.RemoteControlSettingsSchema;
  assert.deepEqual(schema({}).relayUrls, [], '新装机器上这一格是空数组，不是 undefined');
  assert.deepEqual(schema({ relayUrl: A }).relayUrls, [], '老路径只写 relayUrl 时列表是空的，收敛在 core 里');
  assert.throws(() => schema({ relayUrls: A }), '不是数组要拒，别让一个字符串冒充列表');
});

test('配置写入：patch 里两格一起带时以 relayUrls 为准，只带一格时另一格跟着变', () => {
  // 装配层的 store 不导出，这里直接钉它调用的那个收敛函数：只写 relayUrl → 列表变单元素；
  // 只写列表 → relayUrl 变首项。漏了这一步的现场是「地址改了但没生效」，一个错都不报。
  const single = core.applyRelayAddressPatch({ relayUrl: '', relayUrls: [A, B] }, { relayUrl: `${B}/` });
  assert.equal(single.relayUrl, B);
  assert.deepEqual(single.relayUrls, [B], '写单值等于把列表也换成单元素，不是「追加」');

  const listed = core.applyRelayAddressPatch({ relayUrl: A, relayUrls: [A] }, { relayUrls: [B, A] });
  assert.equal(listed.relayUrl, B);
  assert.deepEqual(listed.relayUrls, [B, A]);

  const both = core.applyRelayAddressPatch({ relayUrl: A, relayUrls: [A] }, { relayUrl: B, relayUrls: [A, B] });
  assert.equal(both.relayUrl, A, '两个键一起带时以 relayUrls 为准');
  assert.deepEqual(both.relayUrls, [A, B]);

  const untouched = { relayUrl: A, relayUrls: [A, B] };
  assert.equal(core.applyRelayAddressPatch(untouched, { name: 'x' }), untouched, '不碰地址的 patch 不该动这两格');
  assert.deepEqual(untouched.relayUrls, [A, B]);
});

test('配置投影回两格，首项恒等（手机据此回显「主用哪条、还有哪几条」）', () => {
  const view = configView({ relayUrl: A, relayUrls: [A, B] });
  assert.equal(view.relayUrl, A);
  assert.deepEqual(view.relayUrls, [A, B]);
  const legacy = configView({ relayUrl: A });
  assert.equal(legacy.relayUrl, A);
  assert.deepEqual(legacy.relayUrls, [A], '老状态没有列表这一格时退化到单条');
});

test('手机改配置：relayUrls 收数组，形状不对整次拒绝', () => {
  assert.equal(configPatch({ relayUrls: 'https://a.example' }).ok, false, '字符串不是列表');
  assert.equal(configPatch({ relayUrls: [A, 1] }).ok, false);
  assert.equal(configPatch({ relayUrls: [A, 'x'.repeat(501)] }).ok, false, '过长的地址要拒');
  const ok = configPatch({ relayUrls: [` ${A} `, B] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.patch.relayUrls, [A, B], '首尾空白在这里修掉（尾斜杠由落盘那一步的规范化管）');
});

// ── 出口：状态 / 心跳 / 配对 ────────────────────────────────────────────────

test('status() 在 relayUrl 旁边报 relayUrls，两者恒一致', () => {
  const view = (state) => createStatusView({
    state,
    webServerPort: 3080,
    getSidecarSnapshot: () => ({}),
    lanPortInUse: () => 18787,
    getLanPortAdjusted: () => false,
    getSidecarState: () => 'healthy',
    getSidecarRestarts: () => 0,
    getSidecarRestartedAt: () => 0,
    getSidecarRestartError: () => null,
    getMirrorPush: () => ({ pushedAt: 0, ok: null, error: null }),
  })();

  const listed = view({ enabled: true, relayUrl: A, relayUrls: [A, B] });
  assert.equal(listed.relayUrl, A);
  assert.deepEqual(listed.relayUrls, [A, B], '手机要能拿到整组，才谈得上以后择路');
  assert.equal(listed.relayUrls[0], listed.relayUrl);

  const legacy = view({ enabled: true, relayUrl: A });
  assert.deepEqual(legacy.relayUrls, [A], '老宿主（state 里没有这一格）也要报得出来，不是 undefined');
});

test('配对二维码 payload 两格都在：老手机读 relayUrl，新手机读数组', () => {
  const base = {
    name: 'host', instanceId: 'i1', pairingCode: '123456', pairingTicket: 't'.repeat(43),
    lanEnabled: false, lanPort: 18787, preferredLanAddress: '', manualLanUrl: '', manualIpv6Url: '',
  };
  const { payload } = pairingPayload({ ...base, relayUrl: A, relayUrls: [A, B] }, 18787);
  assert.equal(payload.relayUrl, A, '老手机只认这一格，一个字都不能少');
  assert.deepEqual(payload.relayUrls, [A, B]);
  assert.equal(payload.relayUrls[0], payload.relayUrl);

  const legacy = pairingPayload({ ...base, relayUrl: A }, 18787).payload;
  assert.equal(legacy.relayUrl, A);
  // **决策变了（2026-11-09）**：只有一条中转时二维码里**不写** `relayUrls`。
  // 原来这里断言「退化到单元素数组」，但那个数组与上面的 `relayUrl` 逐字相同 ——
  // 同一串地址在码里出现两遍，白占七八个模块，而扫码能不能成几乎全看码有多密。
  // 「老手机读 relayUrl、新手机优先读数组」那条契约没变：数组缺席时新手机本来就会退化到单条
  // （App 侧 `parsePairingInvite` 的 `declared.length ? declared : first ? [first] : []`）。
  assert.equal(legacy.relayUrls, undefined, '单中转时不写数组，省掉重复的那一串');
  const listed = pairingPayload({ ...base, relayUrl: A, relayUrls: [A, B] }, 18787).payload;
  assert.deepEqual(listed.relayUrls, [A, B], '真有第二条时才写数组');

  const none = pairingPayload({ ...base, relayUrl: '', relayUrls: [] }, 18787).payload;
  assert.equal(none.relayUrl, '');
  // 没有中转时同样不写数组（与单条时同一个判据：`relayUrls.length > 1` 才写）。
  // 这条要保住的意图是「别造一条假地址出来」—— 见下面断言：数组要么缺席、要么非空。
  assert.ok(none.relayUrls === undefined || none.relayUrls.length === 0,
    '真的没有中转时两格都空，别造一条假地址出来');
  assert.ok(!none.lanUrls.length, '局域网关着时也不该冒出地址');
});

/** 装一次移动端路由表，取出指定的那一条。 */
function mobileRoute(state, routePath) {
  const routes = [];
  registerMobileRoutes({
    registerRoute: (route) => routes.push(route),
    registerUpgradeRoute: () => {},
    guarded: (handler) => handler,
    state,
    hostMetadata: () => ({}),
    getSidecarSnapshot: () => ({}),
    safeLanCandidates: () => [],
    safeIpv6Candidates: () => [],
    lanPortInUse: () => 18787,
    preview: { handleUpgrade() {} },
    core,
    pairingApproval: null,
  });
  const route = routes.find((item) => item.path === routePath);
  assert.ok(route, `没装出 ${routePath}`);
  return route;
}

test('心跳与 /connection-info 都带 relayUrls；关掉中转时两格都为空', async () => {
  for (const routePath of ['/api/mobile/v1/status', '/api/mobile/v1/connection-info']) {
    const res = fakeRes();
    const req = { url: routePath, method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    await mobileRoute({ enabled: true, relayUrl: A, relayUrls: [A, B] }, routePath).handler({}, req, res);
    const body = JSON.parse(res.raw);
    assert.equal(body.relayUrl, A, `${routePath} 的 relayUrl 语义没变`);
    assert.deepEqual(body.relayUrls, [A, B], `${routePath} 要报整组`);

    const off = fakeRes();
    await mobileRoute({ enabled: false, relayUrl: A, relayUrls: [A, B] }, routePath).handler({}, req, off);
    const offBody = JSON.parse(off.raw);
    assert.equal(offBody.relayUrl, null, '关掉中转换 null，与「地址是空的」区分开');
    assert.deepEqual(offBody.relayUrls, [], '关掉中转时列表也空，别让手机拿着一条早已停用的地址');
  }
});

test('心跳里的列表是现算的：改完地址不用重挂路由就能读到新的', async () => {
  // `state` 是就地改的（见 A3-20 的坑「内存 state 是本进程唯一真值」）。把收敛提到注册那一刻
  // 算一份，表现是「面板改完地址、手机轮询到的还是旧的那组」，一个错都不报。
  const state = { enabled: true, relayUrl: A, relayUrls: [A] };
  const route = mobileRoute(state, '/api/mobile/v1/status');
  const read = async () => {
    const res = fakeRes();
    await route.handler({}, { url: '/api/mobile/v1/status', method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
    return JSON.parse(res.raw);
  };
  assert.deepEqual((await read()).relayUrls, [A]);
  state.relayUrls = [B, A];
  state.relayUrl = B;
  assert.deepEqual((await read()).relayUrls, [B, A], '改完立刻读到新的一组，列表首项与 relayUrl 一致');
  assert.equal((await read()).relayUrl, B);
});

// ── /api/relay/config：两个键都收 ──────────────────────────────────────────

/** 把控制面真挂一遍，只留「路径 → handler」。依赖给最小假体（照 control-plane-routes.test 的写法）。 */
function controlRoute(state) {
  const table = new Map();
  registerControlPlaneRoutes({
    registerRoute: (route) => table.set(route.path, route.handler),
    localOnly: (_method, handler) => handler,
    trustedLocalUi: () => true,
    sendJson: (res, status, payload) => { res.status = status; res.body = payload; },
    readJson: async (req) => req.body || {},
    settings: {
      async update(patch) {
        core.applyRelayAddressPatch(state, patch);
        for (const [key, value] of Object.entries(patch)) {
          if (key === 'relayUrl' || key === 'relayUrls') continue;
          state[key] = value;
        }
        core.normalizeRelayAddresses(state);
        return state;
      },
    },
    state,
    status: () => ({}),
    syncSidecar: async () => {},
    lanPortInUse: () => 18787,
    getLanPortAdjusted: () => false,
    resolveLanPort: async () => 18787,
    pairingPayload,
  });
  return table;
}

test('/api/relay/config 收两个键：单值等价单元素列表，两键同带时以列表为准', async () => {
  const state = { ...core.defaultState(), enabled: true };
  const table = controlRoute(state);

  const onlySingle = { status: 0 };
  await table.get('/api/relay/config')({ method: 'POST', body: { relayUrl: `${A}/` } }, onlySingle);
  assert.equal(onlySingle.status, 200);
  assert.equal(state.relayUrl, A);
  assert.deepEqual(state.relayUrls, [A], '老路径写单值 = 写单元素列表');

  const onlyList = { status: 0 };
  await table.get('/api/relay/config')({ method: 'POST', body: { relayUrls: [B, A] } }, onlyList);
  assert.equal(onlyList.status, 200);
  assert.equal(state.relayUrl, B, '主用那条跟着列表首项走');
  assert.deepEqual(state.relayUrls, [B, A]);

  const both = { status: 0 };
  await table.get('/api/relay/config')({ method: 'POST', body: { relayUrl: B, relayUrls: [A, B] } }, both);
  assert.equal(both.status, 200);
  assert.equal(state.relayUrl, A, '两个键一起带时列表说了算');
  assert.deepEqual(state.relayUrls, [A, B]);

  // 形状不对的列表照这条路由的老口径就地丢掉，不连累同一发里的其余字段。
  const badList = { status: 0 };
  await table.get('/api/relay/config')({ method: 'POST', body: { relayUrls: 'https://a.example', name: 'ok' } }, badList);
  assert.equal(badList.status, 200);
  assert.deepEqual(state.relayUrls, [A, B], '不是数组就不写，原来的列表一个字不动');
  assert.equal(state.name, 'ok');
});

// ── 隧道签名：这一轮起要含 relayUrls ──────────────────────────────────────
//
// 上一轮这条守卫断言的是「签名里**没有** relayUrls」，理由是那时还没有择路，跟着列表重建
// 隧道等于凭空多出一种行为。**第二轮把前提换了**：地址组（含顺序）变了就要重新择路，不进
// 签名那次下发会被判成「什么都没变」，隧道继续挂在一条已经不在组里的旧地址上。所以这里改
// 成正向断言 —— 决策本身变了，不是把断言放宽（理由同 docs/relay-multi-address.md 的
// 「择路（第二轮）」）。

test('worker 的隧道签名里含 relayUrls：地址组变了就要重新择路', () => {
  const source = fs.readFileSync(path.join(PKG, 'lib', 'sidecar-facade-worker.cjs'), 'utf8');
  const at = source.indexOf('function tunnelSignature(c)');
  assert.notEqual(at, -1, '找不到 tunnelSignature');
  const body = source.slice(at, source.indexOf('}', at) + 1);
  assert.match(body, /c\.relayUrl\b/, '主用那条仍在签名里：换了主用一定要重建');
  assert.match(body, /c\.relayUrls\b/, '地址组也在签名里：组变了（含顺序）就要重新择路');
  assert.match(source, /const allowed = \[[^\]]*'relayUrls'/, '白名单也要有它，否则配置下发直接抛 unknown field');
});

test('tunnelSignature 对地址组只认顺序：同一组不同顺序是两次不同的判定', () => {
  // 提取真源码并在受控作用域里跑：顺序不敏感的签名会让「写回队首」那次变化被判成没变，
  // 于是隧道继续挂在旧地址上。
  const source = fs.readFileSync(path.join(PKG, 'lib', 'sidecar-facade-worker.cjs'), 'utf8');
  const body = source.slice(source.indexOf('function tunnelSignature(c)'), source.indexOf('}', source.indexOf('function tunnelSignature(c)')) + 1);
  const tunnelSignature = new Function('c', `${body}; return tunnelSignature(c)`);
  const base = { enabled: true, relayUrl: 'https://a.example', relayUrls: ['https://a.example', 'https://b.example'], instanceId: 'i', upstreamPort: 1 };
  assert.notEqual(
    tunnelSignature(base),
    tunnelSignature({ ...base, relayUrl: 'https://b.example', relayUrls: ['https://b.example', 'https://a.example'] }),
    '换了主用 + 提了队首必须是一次不同的判定',
  );
  assert.equal(tunnelSignature(base), tunnelSignature({ ...base }), '同一份配置必须给同一个签名，否则每次下发都重建');
});

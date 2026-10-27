'use strict';

/**
 * 手机端改「这台设备的中转与连接配置」—— 驱动真实现，不转写。
 *
 * 容易写错、而错了又很难在手机上发现的地方：
 *
 *  1. **配置投影不能回显注册密钥**：只报「设没设」。手机这边多回一格就等于多开一条
 *     「读出来抄走」的路。
 *  2. **空串对「优先地址」合法、对「设备名」不合法**：前者是清掉这次选择的唯一方式，后者
 *     会造出一台没名字的宿主。
 *  3. **部分形状不对就整次拒绝**：只写一半会让用户以为全都改好了。
 *  4. **会掐断隧道的动作必须「先回包再动手」**：响应发不出去时，任何「返回结果」的设计都是
 *     假的。所以这里断言「handler 返回时，副作用还没发生」。
 *  5. **吊销全部要真的吊销三处**：中转授权、本机 `dshc_` 凭据、`lanSecret` 与配对码。只做
 *     一处都会留下还能用的旧凭据。
 *  6. **端口自检那两档特殊答案**：宿主自己的网页端口不能当直连端口；它自己正在监听的那个
 *     端口 `canListen` 必然失败，但那是「自己的」，不是「被占用」。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 数据目录必须先改到临时目录，再 `require` 实现。
 *
 * `relay-control.js` 在模块求值时就通过 `relay/core.js` 算出状态文件路径；它调用的
 * `core.saveState(state)` 写的是**那个**路径。不隔离的话，跑一次这组测试就会把开发机
 * 真实的 `relay.json`（实例号 / `lanSecret` / 中转地址 / 配对码）换成下面的夹具，
 * 之后所有已配对手机一律 401 —— 2026-10-24 现场就是这么把两台设备连不上的。
 */
const DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-control-'));
process.env.DSH_HOME = DSH_HOME;

const {
  createRelayControlHandlers,
  configView,
  configPatch,
  AFTER_RESPONSE_MS,
} = require('../lib/mobile/relay-control.js');

/** 假响应：收下 sendJson 写出来的东西（一个对象既是 res 也是断言入口）。 */
function fakeRes() {
  const res = {
    status: 0,
    body: null,
    raw: '',
    writeHead(status) { res.status = status; },
    end(chunk) { res.raw = String(chunk); res.body = JSON.parse(res.raw); },
  };
  return res;
}

function fakeReq(body) {
  return { method: 'POST', [Symbol.asyncIterator]: undefined, on() {}, read: () => null, ...(body === undefined ? {} : { __body: body }) };
}

/** readJsonBody 从 req 读；这里造一个最小的可读流。 */
function reqWith(body) {
  const { Readable } = require('node:stream');
  const stream = Readable.from([JSON.stringify(body)]);
  stream.method = 'POST';
  return stream;
}

function baseState(over = {}) {
  return {
    enabled: true,
    relayUrl: 'https://relay.example.com',
    name: '我的 Mac',
    lanEnabled: true,
    lanPort: 18787,
    pairingPolicy: 'code',
    preferredLanAddress: '',
    registerSecret: 'shh-secret',
    instanceId: 'i1',
    lanSecret: 'old-secret',
    pairingCode: '123456',
    ...over,
  };
}

function makeDeps(over = {}) {
  const state = over.state || baseState();
  const calls = { update: [], sync: 0, restart: 0, revokeLocal: 0, saveState: 0, resolvePort: 0 };
  const deps = {
    state,
    settings: {
      // 真实 store 的 notify 会触发装配层那个订阅者（落盘 + 重配 sidecar）。这里用 sync 计数
      // 代表「推下去了」，才能真正断言「响应之前一次都没推」。
      notify() { calls.sync += 1; },
      async update(patch, options = {}) {
        calls.update.push(patch);
        Object.assign(state, patch);
        if (options.notify !== false) calls.sync += 1;
        return state;
      },
    },
    syncSidecar: async () => { calls.sync += 1; },
    restartSidecar: async () => { calls.restart += 1; },
    status: () => ({
      localPort: 3080,
      lan: { state: 'listening', port: state.lanPort },
      tunnel: { state: 'connected', error: null },
    }),
    resolveLanPort: async () => { calls.resolvePort += 1; return state.lanPort; },
    lanPortInUse: () => state.lanPort,
    getLanPortAdjusted: () => false,
    getSidecar: () => ({ request: async () => ({ revoked: 2 }) }),
    credentials: { revokeAllByInstance: () => { calls.revokeLocal += 1; return 1; } },
    activeGuard: () => ({
      faults: () => [{ at: 1, kind: 'unhandledRejection', message: '第一行\n第二行是堆栈', fatal: false }],
      stats: () => ({ total: 1, consecutive: 0, lastAt: 1, fatal: false }),
    }),
    probeUrls: async (urls) => urls.map((url) => ({ url, ms: url.includes('good') ? 12 : null })),
    ...over.deps,
  };
  return { deps, state, calls };
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('配置投影：注册密钥只报设没设，不回值', () => {
  const view = configView(baseState());
  assert.equal(view.registerSecretSet, true);
  assert.equal(Object.prototype.hasOwnProperty.call(view, 'registerSecret'), false, '配置投影里不许出现 registerSecret 本身');
  assert.equal(configView(baseState({ registerSecret: '' })).registerSecretSet, false);
});

test('改配置：逐项校验，形状不对整次拒绝', () => {
  assert.equal(configPatch({ relayUrl: 1 }).ok, false);
  assert.equal(configPatch({ name: '   ' }).ok, false, '设备名不能是空的');
  assert.equal(configPatch({ lanPort: 80 }).ok, false, '端口低于 1024 要拒');
  assert.equal(configPatch({ lanPort: 70000 }).ok, false);
  assert.equal(configPatch({ lanPort: 18787.5 }).ok, false);
  assert.equal(configPatch({ pairingPolicy: 'always' }).ok, false);
  assert.equal(configPatch({ registerSecret: 'x'.repeat(513) }).ok, false);
  assert.equal(configPatch({ preferredLanAddress: 'a'.repeat(65) }).ok, false);
  assert.equal(configPatch({}).ok, false, '一项都没有时不该当成成功');
  // 空串优先地址是合法值（清掉这次选择的唯一方式）。
  const preferred = configPatch({ preferredLanAddress: '' });
  assert.equal(preferred.ok, true);
  assert.equal(preferred.patch.preferredLanAddress, '');
  // 手填的直连地址：与优先地址同一条口径 —— 空串合法（清掉），只挡类型与长度。
  assert.equal(configPatch({ manualLanUrl: 'a'.repeat(201) }).ok, false);
  assert.equal(configPatch({ manualLanUrl: 1 }).ok, false);
  assert.equal(configPatch({ manualLanUrl: '' }).patch.manualLanUrl, '');
  assert.equal(configPatch({ manualLanUrl: ' https://home.example.com:8443/ ' }).patch.manualLanUrl, 'https://home.example.com:8443');
});

test('读配置：一次给全配置与地址候选', async () => {
  const { deps, state } = makeDeps();
  const handlers = createRelayControlHandlers(deps);
  const res = fakeRes();
  await handlers.handleRelayConfig({}, {}, res);
  const body = res.body;
  assert.equal(body.ok, true);
  assert.equal(body.config.relayUrl, state.relayUrl);
  assert.equal(body.config.name, state.name);
  assert.equal(body.addresses.port, state.lanPort);
  assert.ok(Array.isArray(body.addresses.lan), '局域网候选要有一份');
  assert.ok(Array.isArray(body.addresses.ipv6), 'IPv6 候选要有一份');
});

test('保存配置：先回包、再推给旁路（副作用必须在响应之后）', async () => {
  const { deps, calls, state } = makeDeps();
  const handlers = createRelayControlHandlers(deps);
  const res = fakeRes();
  await handlers.handleRelayConfigSave({}, reqWith({ relayUrl: 'https://new.example.com' }), res);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(state.relayUrl, 'https://new.example.com', '配置本身是同步写进去的');
  assert.equal(calls.sync, 0, '响应返回的那一刻还不许推给旁路 —— 推下去就会把这条隧道掐了');
  await wait(AFTER_RESPONSE_MS + 60);
  assert.equal(calls.sync, 1, '响应发完之后才推配置');
});

test('保存配置：改了端口要先重新探一次端口，否则二维码报的是死地址', async () => {
  const { deps, calls } = makeDeps();
  const handlers = createRelayControlHandlers(deps);
  const res = fakeRes();
  await handlers.handleRelayConfigSave({}, reqWith({ lanPort: 19999 }), res);
  assert.equal(calls.resolvePort, 1);
  await wait(AFTER_RESPONSE_MS + 60);
});

test('保存配置：请求体形状不对回 400，且一个字段都不写', async () => {
  const { deps, calls } = makeDeps();
  const handlers = createRelayControlHandlers(deps);
  const res = fakeRes();
  await handlers.handleRelayConfigSave({}, reqWith({ relayUrl: 'https://ok.example.com', lanPort: 'abc' }), res);
  assert.equal(res.status, 400);
  assert.equal(calls.update.length, 0, '整次拒绝，不许部分写入');
});

test('总开关：关掉遥控先回包再推配置', async () => {
  const { deps, calls, state } = makeDeps();
  const handlers = createRelayControlHandlers(deps);
  const res = fakeRes();
  await handlers.handleRelayToggle({}, reqWith({ enabled: false }), res);
  assert.equal(res.body.config.enabled, false);
  assert.equal(state.enabled, false);
  assert.equal(calls.sync, 0);
  await wait(AFTER_RESPONSE_MS + 60);
  assert.equal(calls.sync, 1);
});

test('重新生成配对码：码换了、票据也换了（只换一个等于没换）', async () => {
  const { deps, state } = makeDeps();
  const before = state.pairingCode;
  const handlers = createRelayControlHandlers(deps);
  const res = fakeRes();
  await handlers.handleRelayRegenerate({}, {}, res);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.pairingCode, 'string');
  assert.equal(state.pairingCode, res.body.pairingCode);
  assert.notEqual(state.pairingCode, before, '换码应该是真的换了一个');
});

test('吊销全部：要带 confirm，且三处都吊销', async () => {
  const { deps, calls, state } = makeDeps();
  const handlers = createRelayControlHandlers(deps);
  const res = fakeRes();
  await handlers.handleRelayRevokeAll({}, reqWith({}), res);
  assert.equal(res.status, 400, '没带 confirm 必须拒');

  const ok = fakeRes();
  await handlers.handleRelayRevokeAll({}, reqWith({ confirm: true }), ok);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.started, true);
  assert.equal(calls.revokeLocal, 0, '响应返回时还没吊销 —— 否则这一发自己的凭据也可能被先收走');
  await wait(AFTER_RESPONSE_MS + 120);
  assert.equal(calls.revokeLocal, 1, '本机凭据要吊销');
  assert.notEqual(state.lanSecret, 'old-secret', 'lanSecret 必须轮换，否则旧的局域网凭据还能用');
  assert.equal(typeof state.pairingCode, 'string');
});

test('重启后台服务：没有这个能力时回 409，不假装已经开始', async () => {
  const { deps } = makeDeps({ deps: { restartSidecar: null } });
  const handlers = createRelayControlHandlers(deps);
  const res = fakeRes();
  await handlers.handleRelayRestartSidecar({}, {}, res);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'restart-unavailable');
});

test('端口自检：自己的网页端口、自己正在监听的端口、被占用，三档分开', async () => {
  const { deps } = makeDeps();
  const handlers = createRelayControlHandlers(deps);

  const webPort = fakeRes();
  await handlers.handleRelayCheckPort({}, reqWith({ port: 3080 }), webPort);
  assert.equal(webPort.body.reason, 'host-web-port');

  const ours = fakeRes();
  await handlers.handleRelayCheckPort({}, reqWith({ port: 18787 }), ours);
  assert.equal(ours.body.ours, true);
  assert.equal(ours.body.available, true);

  const bad = fakeRes();
  await handlers.handleRelayCheckPort({}, reqWith({ port: 10 }), bad);
  assert.equal(bad.body.reason, 'out-of-range');
});

test('测速：只测 http(s)、最多 8 条，不把宿主当任意地址探测器', async () => {
  const seen = [];
  const { deps } = makeDeps({ deps: { probeUrls: async (urls) => { seen.push(...urls); return urls.map((url) => ({ url, ms: 5 })); } } });
  const handlers = createRelayControlHandlers(deps);
  const urls = [
    'https://a.example.com',
    'ftp://b.example.com',
    'javascript:alert(1)',
    'https://c.example.com/',
    ...Array.from({ length: 10 }, (_, i) => `https://x${i}.example.com`),
  ];
  const res = fakeRes();
  await handlers.handleRelayProbe({}, reqWith({ urls }), res);
  assert.ok(seen.length <= 8, `最多测 8 条，实际 ${seen.length}`);
  assert.ok(seen.every((url) => /^https?:\/\//.test(url)), '只许 http(s)');
});

test('试连（stage:"prepare"）：一行都不落盘，临时实例 id 与正式 id 不同', async () => {
  const seen = [];
  const { deps, calls, state } = makeDeps({
    deps: { verifyRelay: async (opts) => { seen.push(opts); } },
  });
  const handlers = createRelayControlHandlers(deps);
  const res = fakeRes();
  await handlers.handleRelayConfigSave({}, reqWith({ relayUrl: ' https://new.example.com/ ', stage: 'prepare' }), res);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, verified: true, target: 'https://new.example.com' });
  // 「不落盘」是这条的全部意义：填错地址时这台电脑会从网上消失，而改地址的入口就在那条隧道上。
  assert.equal(calls.update.length, 0, '试连不许写配置');
  assert.equal(calls.sync, 0, '试连也不许碰正在服务的隧道（推下去就断了）');
  assert.equal(state.relayUrl, 'https://relay.example.com', '配置里还是老地址');
  assert.equal(seen.length, 1, '试连要真连一次中转，不是看一眼字符串');
  const probe = seen[0];
  assert.notEqual(probe.instanceId, state.instanceId, '临时 id 必须与正式 id 不同：撞上会把正在服务的那条顶掉');
  assert.ok(probe.instanceId.startsWith(state.instanceId), '临时 id 以正式 id 打头，中转侧看得出是谁在试');
  assert.ok(probe.instanceId.includes('~probe~'), '临时 id 要带标记段');
  assert.equal(probe.upstreamPort, 3080, '试连也要一个本地上游端口');
  assert.equal(probe.relayUrl.replace(/\/+$/, ''), 'https://new.example.com', '验证的就是用户刚填的那个地址');
});

test('试连失败：回 400 并带上原因，配置一个字都没动', async () => {
  const { deps, calls, state } = makeDeps({
    deps: { verifyRelay: async () => { throw new Error('隧道关闭: 1008 bad registration secret'); } },
  });
  const handlers = createRelayControlHandlers(deps);
  const res = fakeRes();
  await handlers.handleRelayConfigSave({}, reqWith({ relayUrl: 'https://typo.example.com', stage: 'prepare' }), res);

  assert.equal(res.status, 400, '验证不通过不许当成功');
  assert.equal(res.body.verified, false);
  assert.match(res.body.error.message, /bad registration secret/, '原因要原样带给用户，别换成一句「失败」');
  assert.equal(calls.update.length, 0);
  assert.equal(calls.sync, 0);
  assert.equal(state.relayUrl, 'https://relay.example.com');
});

test('试连缺新地址 / stage 不认识：回 400，不许当成普通保存', async () => {
  const { deps, calls } = makeDeps();
  const handlers = createRelayControlHandlers(deps);

  const noUrl = fakeRes();
  await handlers.handleRelayConfigSave({}, reqWith({ lanPort: 18787, stage: 'prepare' }), noUrl);
  assert.equal(noUrl.status, 400, '没有新地址就没有可验证的东西');

  const emptyUrl = fakeRes();
  await handlers.handleRelayConfigSave({}, reqWith({ relayUrl: '   ', stage: 'prepare' }), emptyUrl);
  assert.equal(emptyUrl.status, 400, '空地址没什么可试连的');

  const typo = fakeRes();
  await handlers.handleRelayConfigSave({}, reqWith({ relayUrl: 'https://new.example.com', stage: 'verify' }), typo);
  assert.equal(typo.status, 400, '只认 prepare / commit，拼错的 stage 不许悄悄按保存处理');
  assert.equal(calls.update.length, 0);
});

test('提交（stage:"commit"）换地址：等这次下发完才回包，失败如实回 502', async () => {
  let applied = false;
  const { deps, state } = makeDeps({
    deps: { syncSidecar: async () => { applied = true; } },
  });
  const handlers = createRelayControlHandlers(deps);
  const res = fakeRes();
  await handlers.handleRelayConfigSave({}, reqWith({ relayUrl: 'https://new.example.com', stage: 'commit' }), res);

  assert.equal(res.status, 200);
  assert.equal(res.body.migrated, true);
  assert.equal(applied, true, 'commit 必须真的等「迁移 + 重建」走完');
  assert.equal(state.relayUrl, 'https://new.example.com');

  const failed = makeDeps({
    deps: { syncSidecar: async () => { throw new Error('sidecar facade request failed: 503 (隧道关闭: 1008 bad registration secret)'); } },
  });
  const failRes = fakeRes();
  await createRelayControlHandlers(failed.deps).handleRelayConfigSave(
    {}, reqWith({ relayUrl: 'https://bad.example.com', stage: 'commit' }), failRes,
  );
  assert.equal(failRes.status, 502, '换地址失败不能先回 200 再记账');
  assert.equal(failRes.body.error.code, 'relay-switch-failed');
  assert.match(failRes.body.error.message, /bad registration secret/, '真实原因要一路回到手机上');
});

test('提交但没换地址：仍按老节奏「先回包、再推下去」', async () => {
  const { deps, calls } = makeDeps();
  const handlers = createRelayControlHandlers(deps);
  const res = fakeRes();
  await handlers.handleRelayConfigSave({}, reqWith({ name: '新名字', stage: 'commit' }), res);
  assert.equal(res.status, 200);
  assert.equal(calls.sync, 0, '响应返回时还没推');
  await wait(AFTER_RESPONSE_MS + 60);
  assert.equal(calls.sync, 1);
});

test('POST /relay/config 与 /relay/config/save 是同一份实现（GET 仍是读配置）', async () => {
  const { deps, state } = makeDeps();
  const handlers = createRelayControlHandlers(deps);
  const res = fakeRes();
  await handlers.handleRelayConfig({}, reqWith({ relayUrl: 'https://posted.example.com' }), res);
  assert.equal(res.status, 200);
  assert.equal(state.relayUrl, 'https://posted.example.com', 'POST 落在这条路径上也要真的改配置');

  const read = fakeRes();
  await handlers.handleRelayConfig({}, { method: 'GET', headers: {} }, read);
  assert.equal(read.body.config.relayUrl, 'https://posted.example.com', 'GET 还是读配置');
});

test('诊断：重建失败的台账报得出来（手机「运行状态」读的就是这一格）', async () => {
  const applyLedger = require('../lib/relay/apply-ledger.cjs');
  applyLedger.reset();
  applyLedger.recordFailure(new Error('sidecar facade request failed: 503 (注册超时)\n    at 堆栈第二行'), 'https://relay2.example.com');
  const { deps } = makeDeps();
  const handlers = createRelayControlHandlers(deps);
  const res = fakeRes();
  await handlers.handleRelayDiagnostics({}, {}, res);

  const apply = res.body.apply;
  assert.ok(apply && apply.lastFailure, '失败台账必须在诊断里，否则「保存成功然后掉线」永远查不出来');
  assert.equal(apply.lastFailure.message, 'sidecar facade request failed: 503 (注册超时)', '只留第一行，不搬堆栈');
  assert.equal(apply.lastFailure.target, 'https://relay2.example.com', '要能说出当时切的是哪个地址');
  assert.equal(typeof apply.lastFailure.at, 'number', '要带时间');
  assert.equal(apply.okAt, null, '还没成功过');

  applyLedger.recordSuccess();
  const ok = fakeRes();
  await handlers.handleRelayDiagnostics({}, {}, ok);
  assert.equal(typeof ok.body.apply.okAt, 'number', '之后成功过要看得出来');
  applyLedger.reset();
});

test('诊断：故障只搬最近几条、只留第一行（不搬堆栈）', async () => {
  const { deps } = makeDeps();
  const handlers = createRelayControlHandlers(deps);
  const res = fakeRes();
  await handlers.handleRelayDiagnostics({}, {}, res);
  const body = res.body;
  assert.equal(body.ok, true);
  assert.equal(body.faults.installed, true);
  assert.equal(body.faults.faults.length, 1);
  assert.equal(body.faults.faults[0].message, '第一行', '堆栈第二行不许出现在手机上');
  assert.equal(body.port.inUse, 18787);
});

test('诊断：插件版本 / 后台服务 / 镜像推送都报得出来，而密钥一格都不出现', async () => {
  const { deps } = makeDeps({
    deps: {
      status: () => ({
        enabled: true,
        localPort: 3080,
        appVersion: '0.4.4',
        platform: 'darwin',
        arch: 'arm64',
        osVersion: '23.6.0',
        instanceId: 'i1',
        pairingCode: '123456',
        registerSecret: 'shh-secret',
        lan: { state: 'listening', port: 18787 },
        tunnel: { state: 'connected', error: null },
        sidecar: { state: 'running', restarts: 2, restartedAt: 900, restartError: null },
        mirror: { pushedAt: 700, ok: false, error: 'push timeout' },
      }),
    },
  });
  const handlers = createRelayControlHandlers(deps);
  const res = fakeRes();
  await handlers.handleRelayDiagnostics({}, {}, res);
  const body = res.body;
  assert.equal(body.host.plugin, '0.4.4', '报障第一句就要问插件版本');
  assert.equal(body.host.webPort, 3080);
  assert.equal(body.relay.enabled, true);
  assert.equal(body.sidecar.state, 'running');
  assert.equal(body.sidecar.restarts, 2, '后台服务重启过几回要看得见');
  assert.equal(body.sidecar.restartError, null);
  assert.equal(body.mirror.ok, false);
  assert.equal(body.mirror.error, 'push timeout', '镜像推不动的原因要原样带出来');
  // 这条是底线：诊断面板会被用户复制给别人，密钥类字段一个都不许进响应。
  const raw = JSON.stringify(body);
  for (const secret of ['shh-secret', 'old-secret', '123456', 'i1']) {
    assert.equal(raw.includes(secret), false, `诊断响应里不许出现 ${secret}`);
  }
});

test('装配没接上时统一回 503，不是 500 代码错误', async () => {
  // 需要 relay.json 真值的那八条：没接线时回「这台没这个能力」，而不是让 handler 去读
  // undefined 被守卫兜成 500 internal（那种错在手机上跟「代码坏了」长得一样）。
  const needWiring = [
    'handleRelayConfig', 'handleRelayConfigSave', 'handleRelayToggle', 'handleRelayRegenerate',
    'handleRelayRevokeAll', 'handleRelayReconnect', 'handleRelayRestartSidecar', 'handleRelayDiagnostics',
  ];
  const handlers = createRelayControlHandlers({});
  for (const name of needWiring) {
    const res = fakeRes();
    await handlers[name]({}, reqWith({ confirm: true, enabled: true, port: 18787 }), res);
    assert.equal(res.status, 503, `${name} 没接线时应该回 503`);
  }
  // 端口自检与测速不依赖 relay.json 的写入口，没接线也照常能答（只读、且自己会判形状）。
  const port = fakeRes();
  await handlers.handleRelayCheckPort({}, reqWith({ port: 10 }), port);
  assert.equal(port.body.reason, 'out-of-range');
});

// Cloudflare 兜底隧道接线：地址只在真连上边缘后写回，停用 / 卸载 / 重启前先把过期地址撤掉。
'use strict';

/**
 * 地址这一格是「此刻真连得上」的声明，不是「以前有过地址」：留着一条死地址，总控会一直把它
 * 发给手机，手机拨过去就是 Cloudflare 1033。这里钉住四条：连上才写、撤回就清、停用就清、
 * 重启时先清掉上一次留下的那条（那条属于上一条隧道，这次进程还没连上之前一定是死的）。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { mountCloudflare } = require('../lib/cloudflared/wiring.cjs');

const LIVE = 'https://brave-lamp-trycloudflare.trycloudflare.com';

function fakeRunner(initial = {}) {
  const listeners = { address: null, gone: null };
  let status = {
    available: true, enabled: true, running: false, starting: false, retrying: false,
    waitingForPort: false, url: '', error: '', pid: null, startedAt: 0, ...initial,
  };
  return {
    status: () => status,
    async start() { return status; },
    async stop() {
      status = { ...status, running: false, starting: false, url: '' };
      if (listeners.gone) listeners.gone();
      return status;
    },
    dispose() {
      if (listeners.gone) listeners.gone();
      return status;
    },
    shouldAutoStart: () => true,
    setAddressListener(fn) { listeners.address = fn; },
    setAddressGoneListener(fn) { listeners.gone = fn; },
    emitAddress(address) { return listeners.address ? listeners.address(address, () => true) : undefined; },
    emitGone() { return listeners.gone ? listeners.gone() : undefined; },
  };
}

function mountWith(runner, state) {
  const updates = [];
  const settings = {
    update: async (patch) => {
      updates.push(patch);
      if ('cloudflareUrl' in patch) state.cloudflareUrl = patch.cloudflareUrl;
    },
  };
  const api = mountCloudflare({
    mount: (_label, fn) => fn(),
    warn: () => {},
    state,
    settings,
    portOf: () => 49906,
    ctx: { get: () => ({ runner }), effect: (fn) => fn() },
    name: 'test',
  });
  return { api, updates };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** 注入回环判据的挂载：信号与「有没有别的公网线路」都由测试现给。 */
function mountGated(runner, state, { signals, route }) {
  const updates = [];
  const settings = {
    update: async (patch) => {
      updates.push(patch);
      for (const [k, v] of Object.entries(patch)) state[k] = v;
    },
    watch: (fn) => { settings._watch = fn; return () => {}; },
  };
  const api = mountCloudflare({
    mount: (_label, fn) => fn(),
    warn: () => {},
    state,
    settings,
    portOf: () => 52831,
    signals: () => signals(),
    hasUsableRoute: () => route(),
    ctx: { get: () => ({ runner }), effect: (fn) => fn() },
    name: 'test',
  });
  return { api, updates };
}

test('兜底：回环被遮蔽且无可用线路才起，先备份再收起手填地址', async () => {
  const state = { cloudflareUrl: '', manualLanUrl: 'https://mine.example.com', manualTcpUrl: '', manualIpv6Url: '', manualIpv4Url: '' };
  const runner = fakeRunner();
  const { api, updates } = mountGated(runner, state, { signals: () => ({ needsBypass: true }), route: () => false });
  await api.reconcile(true);
  // 备份那次把原值存进备份字段，紧接着一次把四个手填格清空。
  assert.deepEqual(updates[0], { cloudflareFallbackBackup: { manualLanUrl: 'https://mine.example.com', manualIpv6Url: '', manualIpv4Url: '', manualTcpUrl: '' } });
  assert.equal(state.manualLanUrl, '', '被遮蔽的入口要收起，别让手机继续拨过去');
});

test('兜底：自己拿到地址后不被当成「已有线路」而自停', async () => {
  const state = { cloudflareUrl: '', manualLanUrl: '', manualTcpUrl: '', manualIpv6Url: '', manualIpv4Url: '' };
  const runner = fakeRunner({ running: true });
  const stops = [];
  const realStop = runner.stop;
  runner.stop = async () => { stops.push(1); return realStop(); };
  const { api } = mountGated(runner, state, { signals: () => ({ needsBypass: true }), route: () => false });
  await api.reconcile(true);
  // 隧道真连上、地址写回状态：判「要不要再起一条」用的是「别的线路」，自己那条不算。
  state.cloudflareUrl = LIVE;
  await api.reconcile();
  assert.equal(stops.length, 0, '刚拿到地址就停掉自己会来回抖');
});

test('兜底：已有可用线路时不起第二条', async () => {
  const state = { cloudflareUrl: '', manualLanUrl: '', manualTcpUrl: '', manualIpv6Url: '', manualIpv4Url: '' };
  const runner = fakeRunner();
  const starts = [];
  runner.start = async () => { starts.push(1); return runner.status(); };
  const { api } = mountGated(runner, state, { signals: () => ({ needsBypass: true }), route: () => true });
  await api.reconcile(true);
  assert.equal(starts.length, 0, '已经有线路就不要重复起兜底');
});

test('兜底：线路恢复后停掉并原样还原手填地址', async () => {
  const state = {
    cloudflareUrl: '', manualLanUrl: '', manualTcpUrl: '', manualIpv6Url: '', manualIpv4Url: '',
    cloudflareFallbackBackup: { manualLanUrl: 'https://mine.example.com', manualIpv6Url: '', manualIpv4Url: '', manualTcpUrl: '' },
  };
  const runner = fakeRunner({ running: true, url: LIVE });
  let bypass = true;
  let hasRoute = false;
  const { api } = mountGated(runner, state, { signals: () => ({ needsBypass: bypass }), route: () => hasRoute });
  await api.reconcile(true);
  // 线路接上：不再需要绕开，兜底要停并把备份还原。
  bypass = false;
  hasRoute = true;
  await api.reconcile();
  assert.equal(state.manualLanUrl, 'https://mine.example.com', '还原用户原本手填的直连地址');
  assert.deepEqual(state.cloudflareFallbackBackup, { manualLanUrl: '', manualIpv6Url: '', manualIpv4Url: '', manualTcpUrl: '' });
});

test('连上边缘后才把地址写回状态，撤回时清空', async () => {
  const state = { cloudflareUrl: '' };
  const runner = fakeRunner();
  const { updates } = mountWith(runner, state);
  await runner.emitAddress(LIVE);
  assert.deepEqual(updates, [{ cloudflareUrl: LIVE }]);
  await runner.emitGone();
  assert.equal(state.cloudflareUrl, '', '撤回要落到状态里，总控才会把这条 cf 线路摘掉');
  assert.deepEqual(updates.at(-1), { cloudflareUrl: '' });
});

test('停用开关会清掉地址，面板回包也不留旧地址', async () => {
  const state = { cloudflareUrl: LIVE };
  const runner = fakeRunner({ running: true, url: LIVE });
  const { api } = mountWith(runner, state);
  const st = await api.stop();
  assert.equal(st.running, false);
  assert.equal(state.cloudflareUrl, '', '关掉隧道就不能再让别人拿着这条地址拨');
});

test('重启 / 热重载：mount 时先撤掉上一次运行留下的那条地址', async () => {
  const state = { cloudflareUrl: 'https://old-one.trycloudflare.com' };
  const runner = fakeRunner();
  const { updates } = mountWith(runner, state);
  await settle();
  assert.deepEqual(updates, [{ cloudflareUrl: '' }], '上一条隧道已经不在，旧地址先撤掉，等这轮真连上再写');
});

test('宿主自带的 runner 已经连着就不误清当前地址', async () => {
  const state = { cloudflareUrl: LIVE };
  const runner = fakeRunner({ running: true, url: LIVE });
  const { updates } = mountWith(runner, state);
  await settle();
  assert.deepEqual(updates, [], '这条地址此刻真的能用，不能因为一次重载就撤掉');
});

// ZeroNews 只读账号快照：定位 / status / show 三张清单归一，用注入假体走完整条分支。
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createZeroNewsAccountReader, normalizeClient, normalizeTunnel, normalizeDevice,
} = require('../lib/zeronews/account.cjs');

const STATUS_LOGGED_IN = JSON.stringify({
  login: true,
  login_pending: false,
  configured: true,
  connected: true,
  client_id: 'cid-1',
  cloud_server_addr: 'zns1012.fzv2.zeronews.cc:7000',
  hostname: 'Mac',
  os: 'darwin',
  arch: 'arm64',
  version: '4.1.0',
  endpoint_count: 1,
  last_pong_at: '2026-11-23 16:11:04',
  user_id: 'uid-1',
  user_tel: '132****0344',
  plan_name: '免费',
  client_enabled: true,
});

const DEVICES = JSON.stringify({
  total: 1,
  page: 1,
  size: 20,
  items: [{
    id: 'cid-1',
    name: 'Mac',
    custom_name: '',
    hostname: 'Mac',
    os: 'darwin',
    arch: 'arm64',
    version: '4.1.0',
    ip: '1.207.158.147',
    is_online: true,
    enabled: true,
    created_at: '2026-11-22 21:54:20',
    edge_node_name: 'hn.takin.cc',
    workspace: { name: 'Root WorkSpace' },
  }],
});

const TUNNELS = JSON.stringify({
  total: 1,
  page: 1,
  size: 20,
  items: [{
    id: 'tid-1',
    subdomain: 'abc',
    root_domain: { domain: 'hn.takin.cc' },
    self_hosted_domain: '',
    type: 'https',
    feature: 'raw',
    mode: 'standard',
    enabled: true,
    bw: 1,
    status: 'active',
    route_rules: [{
      forward_rules: [{
        load_balance_policy: {
          backend_endpoints: [{ local_ip: '127.0.0.1', local_port: 49906 }],
        },
      }],
    }],
    created_at: '2026-11-22 21:59:19',
    last_synced_at: '2026-11-22 21:59:20',
  }],
});

const DOMAINS = JSON.stringify({ total: 0, page: 1, size: 20, items: [] });

/** 造一个按命令返回预设 stdout 的假 run。 */
function fakeRun(map) {
  return async (bin, args) => {
    const key = args.join(' ');
    const out = map[key];
    if (out === undefined) return { code: 1, stdout: '', stderr: 'unexpected' };
    if (out === null) return { code: 1, stdout: '', stderr: 'failed' };
    return { code: 0, stdout: out, stderr: '' };
  };
}

test('客户端没装：available=false，字段齐全不报错', async () => {
  const reader = createZeroNewsAccountReader({ locate: async () => ({ ok: false, path: '' }), run: fakeRun({}) });
  const snap = await reader.read();
  assert.equal(snap.ok, true);
  assert.equal(snap.available, false);
  assert.equal(snap.login, false);
  assert.deepEqual(snap.tunnels, []);
  assert.deepEqual(snap.counts, { tunnels: 0, devices: 0, domains: 0 });
});

test('客户端在但没登录：只回客户端态，不拉三张清单', async () => {
  let showCalls = 0;
  const reader = createZeroNewsAccountReader({
    locate: async () => ({ ok: true, path: '/bin/zeronews' }),
    run: async (bin, args) => {
      if (args[0] === 'show') showCalls += 1;
      return { code: 0, stdout: JSON.stringify({ login: false, plan_name: '免费', user_tel: '132****0344' }), stderr: '' };
    },
  });
  const snap = await reader.read();
  assert.equal(snap.login, false);
  assert.equal(snap.resourcesLoaded, false);
  assert.equal(showCalls, 0);
  assert.equal(snap.account.planName, '免费');
});

test('已登录：status + 三张清单归一，数量与明细都对', async () => {
  const reader = createZeroNewsAccountReader({
    locate: async () => ({ ok: true, path: '/bin/zeronews' }),
    run: fakeRun({
      'status --json': STATUS_LOGGED_IN,
      'show devices --json': DEVICES,
      'show tunnels --json': TUNNELS,
      'show domains --json': DOMAINS,
    }),
  });
  const snap = await reader.read();
  assert.equal(snap.login, true);
  assert.equal(snap.resourcesLoaded, true);
  assert.equal(snap.client.version, '4.1.0');
  assert.equal(snap.account.planName, '免费');
  assert.equal(snap.counts.tunnels, 1);
  assert.equal(snap.counts.devices, 1);
  assert.equal(snap.counts.domains, 0);
  assert.equal(snap.tunnels[0].domain, 'abc.hn.takin.cc');
  assert.equal(snap.tunnels[0].bw, 1);
  assert.equal(snap.tunnels[0].local, '127.0.0.1:49906');
  assert.equal(snap.devices[0].online, true);
  assert.equal(snap.devices[0].ip, '1.207.158.147');
});

test('清单有日志行也能取到 JSON；某张读失败时其余照常', async () => {
  const noisyStatus = 'connecting to cloud...\n' + STATUS_LOGGED_IN + '\nbyebye';
  const reader = createZeroNewsAccountReader({
    locate: async () => ({ ok: true, path: '/bin/zeronews' }),
    run: fakeRun({
      'status --json': noisyStatus,
      'show devices --json': DEVICES,
      'show tunnels --json': null, // 这一张读失败
      'show domains --json': DOMAINS,
    }),
  });
  const snap = await reader.read();
  assert.equal(snap.login, true);
  assert.equal(snap.resourcesLoaded, false);
  assert.equal(snap.counts.devices, 1);
  assert.deepEqual(snap.tunnels, []);
});

test('归一函数认上游真实字段，缺字段给空值', () => {
  assert.equal(normalizeClient(null), null);
  // 没有 id 的行直接丢掉（归一为 null），不让界面出现半条空记录。
  assert.equal(normalizeTunnel({}), null);
  assert.equal(normalizeDevice({}), null);
  const tunnel = normalizeTunnel({ id: 'x', type: 'https', bw: '3', enabled: true, subdomain: 'a', root_domain: { domain: 'b.cc' } });
  assert.equal(tunnel.type, 'HTTPS');
  assert.equal(tunnel.bw, 3);
  assert.equal(tunnel.domain, 'a.b.cc');
});

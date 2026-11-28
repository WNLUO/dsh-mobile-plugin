// 2026-11-28：补 `show traffic` 的流量用量（4.1.1 起才有，读不出就不显示）。
// ZeroNews 只读账号快照：定位 / status / show 四张清单归一，用注入假体走完整条分支。
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createZeroNewsAccountReader, normalizeClient, normalizeTunnel, normalizeDevice, normalizeTraffic,
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

test('登录被拒（quota_exceeded）：快照带出可读原因，而不只是「没登录」', async () => {
  const reader = createZeroNewsAccountReader({
    locate: async () => ({ ok: true, path: '/bin/zeronews' }),
    run: async () => ({ code: 1, stdout: JSON.stringify({ login: false, login_error: 'quota_exceeded' }), stderr: '' }),
  });
  const snap = await reader.read();
  assert.equal(snap.login, false);
  assert.match(snap.loginError, /一台设备|名额|控制台/, '配额满要给出可操作的整句');
});

test('status 只有 stderr 的数量上限报错：快照也带出可读原因', async () => {
  const reader = createZeroNewsAccountReader({
    locate: async () => ({ ok: true, path: '/bin/zeronews' }),
    run: async () => ({ code: 1, stdout: '', stderr: 'auth client failed: client count limit reached for this plan' }),
  });
  const snap = await reader.read();
  assert.equal(snap.login, false);
  assert.match(snap.loginError, /名额|控制台/, '只打在 stderr 的报错也要认出来');
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

test('已登录：带上本计费周期的流量用量，超了就标出来', async () => {
  const reader = createZeroNewsAccountReader({
    locate: async () => ({ ok: true, path: '/bin/zeronews' }),
    run: fakeRun({
      'status --json': STATUS_LOGGED_IN,
      'show devices --json': DEVICES,
      'show tunnels --json': TUNNELS,
      'show domains --json': DOMAINS,
      'show traffic --json': JSON.stringify({ '总流量': '1.00 GiB', '已使用流量': '1.41 GiB' }),
    }),
  });
  const snap = await reader.read();
  assert.equal(snap.traffic.total, '1.00 GiB', '数值原样带单位，不自己换算');
  assert.equal(snap.traffic.used, '1.41 GiB');
  assert.equal(snap.traffic.over, true, '已用超过总量：面板据此提示可能被限速');
  assert.equal(snap.resourcesLoaded, true);
});

test('老客户端没有 show traffic：只打帮助文本，流量那格留空且不算读失败', async () => {
  const reader = createZeroNewsAccountReader({
    locate: async () => ({ ok: true, path: '/bin/zeronews' }),
    run: fakeRun({
      'status --json': STATUS_LOGGED_IN,
      'show devices --json': DEVICES,
      'show tunnels --json': TUNNELS,
      'show domains --json': DOMAINS,
      // 4.1.0 实测就是这个形状：不认识的子命令打帮助、退出码 0。
      'show traffic --json': 'List account tunnels, domains, or clients from the control plane\n\nUsage:\n  zeronews show [command]',
    }),
  });
  const snap = await reader.read();
  assert.equal(snap.traffic, null, '读不出就不显示这一行');
  assert.equal(snap.resourcesLoaded, true, '少这一格别把「清单读失败」的提示带出来');
});

test('流量归一：单位换算、缺少字段、超出判定', () => {
  const over = normalizeTraffic({ '总流量': '1.00 GiB', '已使用流量': '1.41 GiB' });
  assert.equal(over.totalBytes, 1073741824);
  assert.equal(over.usedBytes, 1513975972);
  assert.equal(over.over, true);
  const half = normalizeTraffic({ '总流量': '500 MiB', '已使用流量': '0.2 GiB' });
  assert.equal(half.over, false, '单位不同也要按字节比');
  assert.equal(normalizeTraffic({}), null, '键名对不上就当没有');
  assert.equal(normalizeTraffic(null), null);
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

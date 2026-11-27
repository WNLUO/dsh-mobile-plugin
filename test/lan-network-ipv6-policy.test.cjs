'use strict';
// 协议族策略对 IPv6 候选产出的影响：ipv4-only 时整条 v6 通道不产出，手填 v6 也不上报。
const test = require('node:test');
const assert = require('node:assert/strict');
const lan = require('../lib/relay/lan-network.cjs');

const IFACES = {
  en0: [
    { address: '240e:338:5213:6c11::1', family: 'IPv6', internal: false },
    { address: '192.168.9.10', family: 'IPv4', internal: false },
  ],
};

test('ipv4-only：IPv6 网卡候选与手填 IPv6 都不产出，恢复 auto 后回到默认', () => {
  try {
    lan.setIpVersionPolicy('ipv4-only');
    assert.deepEqual(lan.ipv6Candidates(49906, IFACES), []);
    assert.deepEqual(lan.ipv6Urls(49906, IFACES), []);
    assert.deepEqual(
      lan.withManualIpv6Candidate(
        [{ url: 'http://[240e:338:5213:6c11::1]:49906', address: '240e:338:5213:6c11::1' }],
        'http://[240e:9::1]:49906',
      ),
      [],
    );
  } finally {
    lan.setIpVersionPolicy('auto');
  }
});

test('auto / ipv4-first 仍产出 IPv6 候选', () => {
  try {
    for (const policy of ['auto', 'ipv4-first']) {
      lan.setIpVersionPolicy(policy);
      // 首轮活性账为空，候选原样返回（探测在后台起，不影响这一次同步结果）。
      assert.equal(lan.ipv6Candidates(49906, IFACES).length, 1, `${policy} 应保留 v6 候选`);
    }
  } finally {
    lan.setIpVersionPolicy('auto');
  }
});

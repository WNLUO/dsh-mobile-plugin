'use strict';
// 出站协议族策略的纯函数口径：三档归一、IPv6 候选开关、出站 agent、cloudflared edge 版本。
const test = require('node:test');
const assert = require('node:assert/strict');
const nf = require('../lib/relay/net-family.cjs');

test('normalizeIpVersionPolicy 只认三档，其余与缺失一律 auto', () => {
  assert.equal(nf.normalizeIpVersionPolicy('auto'), 'auto');
  assert.equal(nf.normalizeIpVersionPolicy('ipv4-first'), 'ipv4-first');
  assert.equal(nf.normalizeIpVersionPolicy('ipv4-only'), 'ipv4-only');
  assert.equal(nf.normalizeIpVersionPolicy('bogus'), 'auto');
  assert.equal(nf.normalizeIpVersionPolicy(undefined), 'auto');
  assert.equal(nf.normalizeIpVersionPolicy(null), 'auto');
});

test('allowsIpv6Candidates 只有 ipv4-only 关闭', () => {
  assert.equal(nf.allowsIpv6Candidates('auto'), true);
  assert.equal(nf.allowsIpv6Candidates('ipv4-first'), true);
  assert.equal(nf.allowsIpv6Candidates('ipv4-only'), false);
  assert.equal(nf.allowsIpv6Candidates(undefined), true);
});

test('outboundAgentFor：auto 不给 agent（交给系统），其余强制 family:4', () => {
  assert.equal(nf.outboundAgentFor('auto', true), undefined);
  assert.equal(nf.outboundAgentFor(undefined, false), undefined);
  for (const secure of [true, false]) {
    const agent = nf.outboundAgentFor('ipv4-first', secure);
    assert.ok(agent, '非 auto 必须给出 agent');
    assert.equal(agent.options.family, 4);
  }
});

test('cloudflaredEdgeIpVersion：auto 不传，其余传 4', () => {
  assert.equal(nf.cloudflaredEdgeIpVersion('auto'), undefined);
  assert.equal(nf.cloudflaredEdgeIpVersion('ipv4-first'), '4');
  assert.equal(nf.cloudflaredEdgeIpVersion('ipv4-only'), '4');
});

// 2026-11-27：线路级问题码也归这一处守卫，搬出装配层后逐条钉住。
// 2026-11-25：回环入口判据守卫：每条判据都配一次变异，旧实现必须转红。
'use strict';

/**
 * 任务 A 的判据测试。除了正常取值，这里逐条把源码改坏一遍（mutation）再跑同一组断言：
 * 断言必须在变异版上失败，否则说明它没钉住真正的行为。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const GUARD = require.resolve('../lib/relay/ingress-guard.cjs');
const guard = require(GUARD);

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`mutation anchor must match once: ${before}`);
  return source.replace(before, after);
}

/** 用改过的源码另装一份判据，与通过 require 拿到的那份互不干扰。 */
function loadMutated(mutate) {
  const loaded = { exports: {} };
  vm.runInNewContext(mutate(fs.readFileSync(GUARD, 'utf8')), {
    module: loaded, exports: loaded.exports, Date, Number, Object, Set, Boolean, String,
  }, { filename: GUARD });
  return loaded.exports;
}

test('专属入口端口只认正整数，字段名是唯一契约', () => {
  assert.equal(guard.INGRESS_PORT_FIELD, 'tunnelIngressPort');
  assert.equal(guard.ingressPortOf({ tunnelIngressPort: 41081 }), 41081);
  assert.equal(guard.ingressPortOf({ tunnelIngressPort: 0 }), 0);
  assert.equal(guard.ingressPortOf({}), 0);
  for (const bad of [-1, 1.5, '41081', 65536, null]) {
    assert.equal(guard.ingressPortOf({ tunnelIngressPort: bad }), 0, `坏值 ${bad} 不能当成可用入口`);
  }
  assert.throws(() => {
    const mutated = loadMutated(src => replaceOnce(src, 'value > 0 && value <= 65535', 'value >= -1 && value <= 65535'));
    assert.equal(mutated.ingressPortOf({ tunnelIngressPort: -1 }), 0);
  }, assert.AssertionError, '把 0 当有效端口必须被上面那条断言拒绝');
});

test('漂移与遮蔽各自发出信号，两者都在时报回环被抢', () => {
  assert.deepEqual(guard.signalsOf({ requestedPort: 18787, boundPort: 18787, loopbackBlocked: false }), {
    drifted: false, shadowed: false, needsBypass: false, conflict: '',
  });
  assert.deepEqual(guard.signalsOf({ requestedPort: 18787, boundPort: 41080, loopbackBlocked: false }), {
    drifted: true, shadowed: false, needsBypass: true, conflict: 'occupied',
  });
  assert.deepEqual(guard.signalsOf({ requestedPort: 18787, boundPort: 18787, loopbackBlocked: true }), {
    drifted: false, shadowed: true, needsBypass: true, conflict: 'shadowed',
  });
  assert.deepEqual(guard.signalsOf({ requestedPort: 18787, boundPort: 41080, loopbackBlocked: true }), {
    drifted: true, shadowed: true, needsBypass: true, conflict: 'shadowed',
  });
  // 老机器没有专属入口端口：算不出漂移，但回环被抢仍要绕开。
  assert.equal(guard.signalsOf({ loopbackBlocked: true }).needsBypass, true);
  assert.throws(() => {
    const mutated = loadMutated(src => replaceOnce(src, "const conflict = shadowed ? 'shadowed' : drifted ? 'occupied' : '';", "const conflict = drifted ? 'occupied' : shadowed ? 'shadowed' : '';"));
    assert.equal(mutated.signalsOf({ requestedPort: 18787, boundPort: 41080, loopbackBlocked: true }).conflict, 'shadowed');
  }, assert.AssertionError, '把遮蔽优先级改掉必须被同一条断言拒绝');
});

test('探测失败一律当没证据，不误切', () => {
  for (const value of [undefined, null, false, 0, 1, 'blocked', {}, { state: 'blocked' }]) {
    const result = guard.signalsOf({ requestedPort: 18787, boundPort: 18787, loopbackBlocked: value });
    assert.equal(result.shadowed, false, `${String(value)} 不是明确的回环被抢`);
    assert.equal(result.needsBypass, false);
  }
  assert.throws(() => {
    const mutated = loadMutated(src => replaceOnce(src, 'input.loopbackBlocked === true', 'Boolean(input.loopbackBlocked)'));
    assert.equal(mutated.signalsOf({ requestedPort: 18787, boundPort: 18787, loopbackBlocked: 1 }).shadowed, false);
  }, assert.AssertionError, '把「严格 true」放宽成真值必须转红');
});

test('漂移可沿用已有端口策略的账，不必从两个端口重算', () => {
  const signals = guard.signalsOf({ requestedPort: 18787, boundPort: 18787, drifted: true, loopbackBlocked: false });
  assert.deepEqual(signals, { drifted: true, shadowed: false, needsBypass: true, conflict: 'occupied' });
  assert.throws(() => {
    const mutated = loadMutated(src => replaceOnce(src, "const drifted = typeof input.drifted === 'boolean' ? input.drifted : derived;", 'const drifted = derived;'));
    assert.equal(mutated.signalsOf({ requestedPort: 18787, boundPort: 18787, drifted: true }).drifted, true);
  }, assert.AssertionError, '丢掉现成的漂移账必须转红');
});

test('三条线路落点：绕开走专属入口，已有隧道留在它自己的端口', () => {
  const bypass = guard.signalsOf({ requestedPort: 18787, boundPort: 18787, loopbackBlocked: true });
  const calm = guard.signalsOf({ requestedPort: 18787, boundPort: 18787, loopbackBlocked: false });
  for (const provider of ['cloudflare', 'frp', 'zeronews']) {
    assert.equal(guard.tunnelPortOf({ ingressPort: 41081, lanPort: 18787, signals: bypass, provider }), 41081, `${provider} 绕开后落到专属入口`);
    assert.equal(guard.tunnelPortOf({ ingressPort: 41081, lanPort: 18787, signals: calm, provider }), 18787, `${provider} 没绕开就保持局域网端口`);
  }
  // 已有隧道：哪怕正在绕开，也绝不把它改到新端口（改成新端口就判失配，删旧的又没公开参数）。
  assert.equal(guard.tunnelPortOf({ ingressPort: 41081, lanPort: 18787, signals: bypass, existingTunnelPort: 18787 }), 18787);
  assert.equal(guard.tunnelPortOf({ ingressPort: 41081, lanPort: 18787, signals: bypass, existingTunnelPort: 44444 }), 44444, '沿用隧道自己的端口，而不是猜一个');
  assert.equal(guard.tunnelPortOf({ ingressPort: 0, lanPort: 18787, signals: bypass, provider: 'cloudflare' }), 18787, '入口还没分配不许指到 0');
  assert.throws(() => {
    const mutated = loadMutated(src => replaceOnce(src, 'if (existing > 0) return existing;', ''));
    assert.equal(mutated.tunnelPortOf({ ingressPort: 41081, lanPort: 18787, signals: bypass, existingTunnelPort: 18787 }), 18787);
  }, assert.AssertionError, '已有隧道被改到新端口必须转红');
  assert.throws(() => {
    const mutated = loadMutated(src => replaceOnce(src, 'input.signals.needsBypass === true && ingressPort > 0', 'ingressPort > 0'));
    assert.equal(mutated.tunnelPortOf({ ingressPort: 41081, lanPort: 18787, signals: calm, provider: 'frp' }), 18787);
  }, assert.AssertionError, '没绕开也切走必须转红');
});

test('兜底原因码：有可用线路不重复起，cloudflared 不在如实报不可用', () => {
  const bypass = guard.signalsOf({ requestedPort: 18787, boundPort: 18787, loopbackBlocked: true });
  const calm = guard.signalsOf({ requestedPort: 18787, boundPort: 18787, loopbackBlocked: false });
  const base = { signals: bypass, cloudflareAvailable: true };
  assert.equal(guard.fallbackReasonOf({ ...base, signals: calm }), '');
  assert.equal(guard.fallbackReasonOf({ ...base, hasUsableRoute: true }), '', '已有线路就不该给面板一个兜底原因');
  assert.equal(guard.fallbackReasonOf({ ...base, hasUsableRoute: false, cloudflareAvailable: false }), 'cloudflare-unavailable');
  assert.equal(guard.fallbackReasonOf({ ...base, hasUsableRoute: false, portLocked: true }), 'port-locked');
  assert.equal(guard.fallbackReasonOf({ ...base, hasUsableRoute: false, externalTarget: true }), 'external-target');
  assert.equal(guard.fallbackReasonOf({ ...base, hasUsableRoute: false, provider: 'zeronews', hasLegacyTunnel: true }), 'zeronews-stale');
  assert.equal(guard.fallbackReasonOf({ ...base, hasUsableRoute: false }), 'port-conflict');
  assert.throws(() => {
    const mutated = loadMutated(src => replaceOnce(src, 'if (input.hasUsableRoute === true) return \'\';', ''));
    assert.equal(mutated.fallbackReasonOf({ ...base, hasUsableRoute: true }), '');
  }, assert.AssertionError, '重复起兜底必须转红');
  assert.throws(() => {
    const mutated = loadMutated(src => replaceOnce(src, "return 'cloudflare-unavailable';", "return 'port-conflict';"));
    assert.equal(mutated.fallbackReasonOf({ ...base, cloudflareAvailable: false }), 'cloudflare-unavailable');
  }, assert.AssertionError, 'cloudflared 不可用被吞掉必须转红');
});

test('线路级问题码：兜底顶上时仍说出旧隧道落点、外部目标与端口被抢', () => {
  const bypass = guard.signalsOf({ requestedPort: 18787, boundPort: 18787, loopbackBlocked: true });
  const calm = guard.signalsOf({ requestedPort: 18787, boundPort: 18787, loopbackBlocked: false });
  const base = {
    signals: bypass, ingressPort: 41081, hasUsableRoute: true, cloudflareAvailable: true,
    hasLegacyTunnel: true, legacyTunnelPort: 18787,
  };
  assert.equal(guard.routeIssueOf(base).routeIssue, 'zeronews-stale', '兜底已顶上也要让用户看见旧隧道落在旧端口');
  assert.equal(guard.routeIssueOf(base).fallbackReason, '', '有可用路线时不报兜底失败');
  assert.equal(guard.routeIssueOf({ ...base, legacyTunnelPort: 41081, externalTarget: true }).routeIssue,
    'external-target', '旧隧道落点对了就报外部手填目标');
  assert.equal(guard.routeIssueOf({ ...base, hasLegacyTunnel: false, ingressPort: 0 }).routeIssue,
    'port-conflict', '回环被抢又没拿到专属入口');
  assert.equal(guard.routeIssueOf({ ...base, signals: calm }).routeIssue, '', '没绕开就没有线路问题');
  const blocked = { ...base, hasUsableRoute: false, cloudflareAvailable: false };
  assert.equal(guard.routeIssueOf(blocked).routeIssue, 'cloudflare-unavailable', '兜底也顶不上时线路码让位给兜底码');
  assert.throws(() => {
    const mutated = loadMutated(src => replaceOnce(src,
      'if (fallbackReason) return { fallbackReason, routeIssue: fallbackReason };',
      "if (fallbackReason) return { fallbackReason, routeIssue: 'x' };"));
    assert.equal(mutated.routeIssueOf(blocked).routeIssue, 'cloudflare-unavailable');
  }, assert.AssertionError, '丢掉兜底码必须转红');
  assert.throws(() => {
    const mutated = loadMutated(src => replaceOnce(src, '!== ingressPort)', '=== ingressPort)'));
    assert.equal(mutated.routeIssueOf(base).routeIssue, 'zeronews-stale');
  }, assert.AssertionError, '不比旧隧道落点必须转红');
  assert.throws(() => {
    const mutated = loadMutated(src => replaceOnce(src,
      "else if (input.externalTarget === true) routeIssue = 'external-target';",
      "else if (false) routeIssue = 'external-target';"));
    assert.equal(mutated.routeIssueOf({ ...base, legacyTunnelPort: 41081, externalTarget: true }).routeIssue, 'external-target');
  }, assert.AssertionError, '漏掉外部手填目标必须转红');
});

test('自检回环判据记进来，状态能读到；没探测就当没证据', () => {
  assert.deepEqual(guard.snapshot(), { state: '', reason: '', at: 0 });
  guard.noteLoopback({ state: 'blocked', reason: '回环 health 回的是别的程序（proxy）' });
  const blocked = guard.snapshot();
  assert.equal(blocked.state, 'blocked');
  assert.match(blocked.reason, /别的程序/);
  assert.ok(blocked.at > 0);
  // 状态读到的是副本，调用方就地改了不能污染下一次读取。
  blocked.state = 'ok';
  assert.equal(guard.snapshot().state, 'blocked');
  assert.equal(guard.signalsOf({ requestedPort: 18787, boundPort: 18787, loopbackBlocked: guard.snapshot().state === 'blocked' }).needsBypass, true);
  guard.noteLoopback({ state: 'ok', reason: '' });
  assert.equal(guard.snapshot().state, 'ok');
  guard.noteLoopback(null);
  assert.deepEqual(guard.snapshot(), { state: '', reason: '', at: 0 }, '探测失败必须清掉证据');
  assert.throws(() => {
    const mutated = loadMutated(src => replaceOnce(src, "KNOWN_STATES.has(verdict.state) ? verdict.state : 'unknown'", 'verdict.state'));
    assert.equal(mutated.noteLoopback({ state: 'made-up' }).state, 'unknown');
  }, assert.AssertionError, '任意状态混进判据必须转红');
});

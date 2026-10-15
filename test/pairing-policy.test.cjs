'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { evaluate, normalize, hostPlatform, DEFAULT_POLICY } = require('../lib/relay/pairing-policy.js')

test("'code' approves once the transport has already verified the pairing code", () => {
  const decision = evaluate('code', { name: 'iPhone', ip: '203.0.113.7' })
  assert.equal(decision.approved, true)
  assert.equal(decision.policy, 'code')
  // The audit line is the only record now that the popup is gone.
  assert.equal(decision.device, 'iPhone')
  assert.equal(decision.ip, '203.0.113.7')
})

test("'deny' reproduces the previous fail-closed behaviour", () => {
  const decision = evaluate('deny', { name: 'iPhone' })
  assert.equal(decision.approved, false)
  assert.equal(decision.reason, 'pairing policy is deny')
})

// A missing value means state written before the policy existed. It must land on
// the documented default rather than throwing, or upgrading would break pairing.
test('a missing policy falls back to the default instead of throwing', () => {
  for (const value of [undefined, null, '']) {
    assert.equal(normalize(value), DEFAULT_POLICY)
    assert.equal(evaluate(value, {}).approved, true)
  }
})

test('an unrecognised policy normalises to the default', () => {
  assert.equal(normalize('always-yes'), DEFAULT_POLICY)
  assert.equal(normalize(1), DEFAULT_POLICY)
  assert.equal(normalize({}), DEFAULT_POLICY)
})

// 'deny' is the only setting that must never be lost to a round-trip through
// state, so normalisation has to preserve it in both directions.
test("normalisation round-trips both policies", () => {
  assert.equal(normalize(normalize('deny')), 'deny')
  assert.equal(normalize(normalize('code')), 'code')
})

test('a malformed device payload cannot crash the decision', () => {
  for (const device of [undefined, null, 'iPhone', 42, []]) {
    const decision = evaluate('code', device)
    assert.equal(decision.approved, true)
    assert.equal(decision.device, 'unknown')
    assert.equal(decision.ip, '')
  }
})

test('a missing device name is reported as unknown rather than empty', () => {
  assert.equal(evaluate('code', { name: '' }).device, 'unknown')
  assert.equal(evaluate('code', { name: 123 }).device, 'unknown')
})

// The host's own OS must ride along with the approval: the phone paints the device
// row icon from it, and it cannot wait for the first status poll to know the answer.
test('the approval carries the host platform, not the pairing device one', () => {
  assert.equal(hostPlatform().platform, process.platform)
})

test('the host platform is a bare platform identifier the phone can switch on', () => {
  const { platform } = hostPlatform()
  assert.equal(typeof platform, 'string')
  assert.ok(platform.length > 0)
  // `evaluate` reports the *phone's* platform from the request; keep them distinct.
  const decision = evaluate('code', { name: 'iPhone', platform: 'ios' })
  assert.equal(decision.device, 'iPhone')
  assert.notEqual(platform, 'ios')
})

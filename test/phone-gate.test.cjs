'use strict';

/**
 * 付款申报闸门的守卫：五级风险分级、申报-同意-单次放行、以及 irreversible 新增的三条判据。
 *
 * 钉住的都是「错了就会掉包或误付」的那几处：
 *   1. 金额对不上、文字差一个字、换了 App、超过 3 步 —— 一律不放行；
 *   2. 付款永远只走接管（takeover），绝不返回 allowed；
 *   3. 一份同意只能放行一步，用过即废；
 *   4. irreversible 新判据：待付款/付款成功/订单记录不算、优惠金额不算。
 *
 * 运行：node --test test/phone-gate.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGate, declarationKind } = require('../lib/mobile/phone/gate.js');
const { classify } = require('../lib/mobile/phone/risk.js');
const { judge, payableAmounts } = require('../lib/mobile/phone/irreversible.js');

/** 建一个已通过用户同意的闸门。 */
function granted(declaration, step = 0) {
  const gate = createGate();
  gate.declare(declaration);
  gate.approve(step);
  return gate;
}

const SEND = { app: 'com.tencent.mm', action: 'send', target: '张三', textToSend: '你好' };

test('正常放行：同 App、同动作、目标在屏上、文字逐字相等', () => {
  const gate = granted(SEND, 0);
  const r = gate.check({
    app: 'com.tencent.mm', action: 'send', target: '张三',
    screenText: '张三\n你好', textToSend: '你好', stepIndex: 1,
  });
  assert.equal(r.decision, 'allowed');
});

test('金额对不上不放行', () => {
  const gate = granted({ app: 'com.shop', action: 'order', target: '提交订单', amountText: '¥39.90' }, 0);
  const r = gate.check({
    app: 'com.shop', action: 'tap', target: '提交订单',
    screenText: '应付 ¥29.90\n提交订单', stepIndex: 1,
  });
  assert.equal(r.decision, 'mismatch');
  assert.match(r.reason, /金额/);
});

test('金额对上才放行', () => {
  const gate = granted({ app: 'com.shop', action: 'order', target: '提交订单', amountText: '¥39.90' }, 0);
  const r = gate.check({
    app: 'com.shop', action: 'tap', target: '提交订单',
    screenText: '应付 ¥39.90\n提交订单', stepIndex: 1,
  });
  assert.equal(r.decision, 'allowed');
});

test('文字差一个字不放行', () => {
  const gate = granted(SEND, 0);
  const r = gate.check({
    app: 'com.tencent.mm', action: 'send', target: '张三',
    screenText: '张三\n你好', textToSend: '你号', stepIndex: 1,
  });
  assert.equal(r.decision, 'mismatch');
  assert.match(r.reason, /逐字/);
});

test('换 App 不放行', () => {
  const gate = granted(SEND, 0);
  const r = gate.check({
    app: 'com.other.app', action: 'send', target: '张三',
    screenText: '张三\n你好', textToSend: '你好', stepIndex: 1,
  });
  assert.equal(r.decision, 'mismatch');
  assert.match(r.reason, /App|屏上/);
});

test('超过 3 步作废', () => {
  const gate = granted(SEND, 10);
  const r = gate.check({
    app: 'com.tencent.mm', action: 'send', target: '张三',
    screenText: '张三\n你好', textToSend: '你好', stepIndex: 14,
  });
  assert.equal(r.decision, 'mismatch');
  assert.match(r.reason, /过期/);
});

test('第 3 步内仍有效', () => {
  const gate = granted(SEND, 10);
  const r = gate.check({
    app: 'com.tencent.mm', action: 'send', target: '张三',
    screenText: '张三\n你好', textToSend: '你好', stepIndex: 13,
  });
  assert.equal(r.decision, 'allowed');
});

test('付款请求返回 takeover，而不是 allowed', () => {
  const gate = granted({ app: 'com.pay', action: 'pay', target: '立即付款' }, 0);
  const r = gate.check({
    app: 'com.pay', action: 'tap', target: '立即付款',
    screenText: '立即付款 ¥99.00', stepIndex: 1,
  });
  assert.equal(r.decision, 'takeover');
  assert.notEqual(r.decision, 'allowed');
});

test('当前这一步是付款时也走 takeover，即使有同意', () => {
  const gate = granted(SEND, 0);
  const r = gate.check({
    app: 'com.tencent.mm', action: 'tap', target: '确认支付',
    screenText: '确认支付 ¥9.90', stepIndex: 1,
  });
  assert.equal(r.decision, 'takeover');
});

test('同一份同意不能放行两步', () => {
  const gate = granted(SEND, 0);
  const first = gate.check({
    app: 'com.tencent.mm', action: 'send', target: '张三',
    screenText: '张三\n你好', textToSend: '你好', stepIndex: 1,
  });
  assert.equal(first.decision, 'allowed');
  const second = gate.check({
    app: 'com.tencent.mm', action: 'send', target: '张三',
    screenText: '张三\n你好', textToSend: '你好', stepIndex: 2,
  });
  assert.equal(second.decision, 'no-grant');
});

test('目标不在屏上不放行', () => {
  const gate = granted(SEND, 0);
  const r = gate.check({
    app: 'com.tencent.mm', action: 'send', target: '张三',
    screenText: '李四\n你好', textToSend: '你好', stepIndex: 1,
  });
  assert.equal(r.decision, 'mismatch');
  assert.match(r.reason, /不在屏上/);
});

test('同类动作对不上不放行', () => {
  const gate = granted(SEND, 0);
  const r = gate.check({
    app: 'com.tencent.mm', action: 'tap', target: '删除',
    screenText: '张三\n删除', stepIndex: 1,
  });
  assert.equal(r.decision, 'mismatch');
  assert.match(r.reason, /申报的是/);
});

test('invalidate 作废已同意的操作', () => {
  const gate = granted(SEND, 0);
  gate.invalidate();
  const r = gate.check({
    app: 'com.tencent.mm', action: 'send', target: '张三',
    screenText: '张三\n你好', textToSend: '你好', stepIndex: 1,
  });
  assert.equal(r.decision, 'no-grant');
});

test('用户拒绝后同类同 App 不再申报', () => {
  const gate = createGate();
  gate.declare(SEND);
  gate.reject();
  const again = gate.declare(SEND);
  assert.equal(again.status, 'declined');
  assert.equal(gate.state().grant, null);
});

// —— 风险五级 ——

test('risk：五级映射', () => {
  assert.equal(classify({ action: 'screen.read' }).level, 'Read');
  assert.equal(classify({ action: 'tap', target: '关注' }).level, 'Change');
  assert.equal(classify({ action: 'tap', target: '发送' }).level, 'External');
  assert.equal(classify({ action: 'tap', target: '删除' }).level, 'Irreversible');
  assert.equal(classify({ action: 'tap' }).level, 'Unknown');
  assert.equal(classify({ action: 'tap', target: '付款' }).outward, true);
  assert.equal(classify({ action: 'screen.read' }).outward, false);
});

// —— irreversible 新增判据 ——

test('irreversible：订单状态不算动作', () => {
  for (const text of ['待付款', '付款成功', '订单记录', '付款方式']) {
    const r = judge({ action: 'tap', args: { text } });
    assert.equal(r.irreversible, false, `${text} 不该判成不可逆`);
  }
  // 真正的动作照旧认。
  assert.equal(judge({ action: 'tap', args: { text: '立即付款' } }).kind, 'payment');
  assert.equal(judge({ action: 'tap', args: { text: '提交订单' } }).kind, 'payment');
});

test('irreversible：优惠金额不算应付金额', () => {
  assert.deepEqual(payableAmounts('满25减3，实付 ¥39.90'), [39.9]);
  assert.deepEqual(payableAmounts('优惠 ¥10 已省 ¥10'), []);
  assert.deepEqual(payableAmounts('运费 ¥8，合计 ¥99'), [99]);
});

test('gate：declarationKind 区分付款与下单', () => {
  assert.equal(declarationKind('pay', '立即付款'), 'pay');
  assert.equal(declarationKind('order', '提交订单'), 'order');
  assert.equal(declarationKind('', '立即付款'), 'pay');
  assert.equal(declarationKind('', '提交订单'), 'order');
});

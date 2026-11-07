'use strict';

/**
 * 不可逆动作判定的守卫：词表真值表（简 / 繁 / 英）、ref 无文字不误判、删除类、payment 与 submit 的区分。
 *
 * 运行：node --test test/phone-irreversible.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { judge } = require('../lib/mobile/phone/irreversible.js');

/** 用一个有文字的 tap 判一下，返回整份结果。 */
function tapText(text, extra) {
  return judge({ action: 'tap', args: { text, ...(extra || {}) } });
}

test('中文词表真值表', () => {
  const cases = [
    ['发送', 'send'],
    ['提交', 'submit'],
    ['下单', 'payment'],
    ['支付', 'payment'],
    ['付款', 'payment'],
    ['确认购买', 'payment'],
    ['立即购买', 'payment'],
    ['删除', 'delete'],
    ['清空', 'delete'],
  ];
  for (const [text, kind] of cases) {
    const r = tapText(text);
    assert.equal(r.irreversible, true, `${text} 应判为不可逆`);
    assert.equal(r.kind, kind, `${text} 的 kind 应为 ${kind}`);
    assert.ok(r.reason.length > 0);
  }
});

test('繁体词表也认', () => {
  const cases = [
    ['傳送', 'send'],
    ['提交', 'submit'],
    ['付款', 'payment'],
    ['確認購買', 'payment'],
    ['刪除', 'delete'],
    ['清空', 'delete'],
  ];
  for (const [text, kind] of cases) {
    const r = tapText(text);
    assert.equal(r.irreversible, true, `${text} 应判为不可逆`);
    assert.equal(r.kind, kind, `${text} 的 kind 应为 ${kind}`);
  }
});

test('英文词表真值表', () => {
  const cases = [
    ['Send', 'send'],
    ['Submit', 'submit'],
    ['Order', 'payment'],
    ['Pay', 'payment'],
    ['Buy', 'payment'],
    ['Delete', 'delete'],
  ];
  for (const [text, kind] of cases) {
    const r = tapText(text);
    assert.equal(r.irreversible, true, `${text} 应判为不可逆`);
    assert.equal(r.kind, kind, `${text} 的 kind 应为 ${kind}`);
  }
});

test('payment 与 submit 分开：支付是 payment，提交是 submit', () => {
  assert.equal(tapText('支付').kind, 'payment');
  assert.equal(tapText('提交').kind, 'submit');
});

test('删除类单独认成 delete', () => {
  assert.equal(tapText('删除').kind, 'delete');
  assert.equal(tapText('清空').kind, 'delete');
  assert.equal(tapText('Delete').kind, 'delete');
});

test('tap 带 ref 但没有文字时，不把整屏文字当成目标', () => {
  const screen = '发送\n删除\n支付\n提交订单';
  const r = judge({ action: 'tap', args: { ref: 'e12' }, screenText: screen });
  assert.equal(r.irreversible, false);
  assert.equal(r.kind, 'none');

  // 就算整屏文字只有一个「删除」，只有 ref 也判不了。
  const single = judge({ action: 'tap', args: { ref: 'e12' }, screenText: '删除' });
  assert.equal(single.irreversible, false);
  assert.equal(single.kind, 'none');
});

test('坐标点按靠 target 判，不当成没文字', () => {
  const r = judge({ action: 'tap', args: { x: 40, y: 80, target: '立即购买' } });
  assert.equal(r.irreversible, true);
  assert.equal(r.kind, 'payment');
});

test('ref 点按带了 target 文字时照常判', () => {
  const r = judge({ action: 'tap', args: { ref: 'e3', target: '发送' } });
  assert.equal(r.irreversible, true);
  assert.equal(r.kind, 'send');
});

test('不是 tap 就不判', () => {
  const r = judge({ action: 'type', args: { text: '发送' } });
  assert.equal(r.irreversible, false);
  assert.equal(r.kind, 'none');
});

test('普通文字不误判', () => {
  for (const text of ['返回', '搜索', '关注', '设置', '取消', 'Cancel']) {
    const r = tapText(text);
    assert.equal(r.irreversible, false, `${text} 不该判成不可逆`);
    assert.equal(r.kind, 'none');
  }
});

test('英文按整词匹配，不被包含在别的词里误命中', () => {
  // reorder 里含 order、undelete 里含 delete 都不该算。
  assert.equal(tapText('Reorder').irreversible, false);
  assert.equal(tapText('Undelete').irreversible, false);
});

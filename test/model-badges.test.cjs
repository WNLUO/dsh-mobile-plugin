'use strict';

/**
 * 模型徽标归一化（`lib/mobile/model-badges.js`）的行为测试。
 *
 * 这段的逻辑全在「形状会变」上：上游 `badge.text` 可以是字面量，也可以是以语言为键的表
 * （英文必填），`tone` 只有四档且可以缺。判错的后果不报错、只是标签不出现或出现错的语言，
 * 所以按输入形状逐条钉住，而不是只测一个「正常样例」。
 *
 * 运行：node --test test/model-badges.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { modelBadgeOf, badgeText, badgeTone, requestLanguage } = require('../lib/mobile/model-badges.js');

test('字面量文案直接用，超长截断', () => {
  assert.deepEqual(modelBadgeOf({ badge: { text: '1017', tone: 'info' } }, 'en'), { badge: { text: '1017', tone: 'info' } });
  assert.equal(badgeText('x'.repeat(100), 'en').length, 32, '标签是单行小字，超长必须截断');
  assert.deepEqual(modelBadgeOf({ badge: { text: '' } }, 'en'), {}, '空文案等于没给，别挂一个空标签');
});

test('本地化对象按请求语言挑，精确优先、其次主语言、最后英文', () => {
  const text = { en: 'New', 'zh-hans': '新版', 'zh-hant': '新版（繁）' };
  assert.equal(badgeText(text, 'zh-hans'), '新版');
  assert.equal(badgeText(text, 'zh-Hant'), '新版（繁）', '大小写不敏感');
  assert.equal(badgeText(text, 'zh-cn'), '新版', 'zh-cn 的主语言 zh 要能对上 zh-hans');
  assert.equal(badgeText(text, 'ja'), 'New', '没有这门语言时退英文');
  assert.equal(badgeText(text, ''), 'New', '读不到语言也退英文');
});

test('本地化表里连英文都没有时，退回表里第一条能用的字符串', () => {
  assert.equal(badgeText({ ja: '新着' }, 'en'), '新着');
  assert.equal(badgeText({ en: 3, ja: '新着' }, 'en'), '新着', '英文那条不是字符串就跳过');
  assert.equal(badgeText({}, 'en'), '');
});

test('tone 只认四档，其余丢掉（而不是原样透传）', () => {
  for (const tone of ['neutral', 'info', 'success', 'warning']) {
    assert.equal(badgeTone(tone), tone);
    assert.deepEqual(modelBadgeOf({ badge: { text: 'x', tone } }, 'en'), { badge: { text: 'x', tone } });
  }
  for (const bad of ['loud', '', null, undefined, 1, { tone: 'info' }]) {
    assert.equal(badgeTone(bad), '');
  }
  assert.deepEqual(modelBadgeOf({ badge: { text: 'x', tone: 'loud' } }, 'en'), { badge: { text: 'x' } }, '不认识的 tone 不挂这个键');
});

test('没有 badge / 不像对象时返回空对象（老宿主目录形状不变）', () => {
  for (const model of [{}, { badge: null }, { badge: 'x' }, null, undefined]) {
    assert.deepEqual(modelBadgeOf(model, 'en'), {});
  }
});

test('请求语言取 Accept-Language 第一段并转小写', () => {
  assert.equal(requestLanguage({ 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' }), 'zh-cn');
  assert.equal(requestLanguage({ 'Accept-Language': 'EN-US' }), 'en-us');
  assert.equal(requestLanguage({}), 'en');
  assert.equal(requestLanguage(null), 'en');
  assert.equal(requestLanguage({ 'accept-language': '' }), 'en');
});

'use strict';

/**
 * redact.js（统一脱敏）单测：Key / JWT / 长杂串 / 卡号 / 凭据字段 / OAuth / 验证码 该遮的遮住，
 * 普通文字、author/keyword 这类字段、普通数字不该误杀。
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { redact, redactObject, redactNetwork, secretName, MASK } = require('../lib/mobile/phone/redact.js');

test('已知格式的 Key 一律遮住', () => {
  assert.equal(redact('sk-' + 'a'.repeat(24)), MASK);
  assert.equal(redact('AIza' + 'B'.repeat(34)), MASK);
  assert.equal(redact('AQ.' + 'a'.repeat(24)), MASK);
  assert.equal(redact('ghp_' + 'a'.repeat(36)), MASK);
  assert.equal(redact('Authorization: Bearer abcdefghijklmnop'), 'Authorization: Bearer ' + MASK);
});

test('JWT 遮住', () => {
  const jwt = 'eyJ' + 'a'.repeat(12) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(12);
  assert.equal(redact('token=' + jwt), 'token=' + MASK);
});

test('又长又杂的串遮住，纯小写的长串不误杀', () => {
  const messy = 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv';
  assert.equal(redact(messy), MASK);
  const plain = 'a'.repeat(40);
  assert.equal(redact(plain), plain);
});

test('16 / 19 位卡号遮住，15 位不误杀', () => {
  assert.equal(redact('4111 1111 1111 1111'), MASK);
  assert.equal(redact('4111111111111111111'), MASK);
  const amex = '3782 822463 10005';
  assert.equal(redact(amex), amex);
});

test('验证码：词后 4–8 位数字遮住，无关数字不动', () => {
  assert.equal(redact('验证码 482913'), '验证码 ' + MASK);
  assert.ok(!redact('您的短信验证码是123456').includes('123456'));
  assert.ok(!redact('code: 1234').includes('1234'));
  // 没有码这个词的普通数字原样
  assert.equal(redact('订单号 20241108'), '订单号 20241108');
});

test('普通文字不误杀', () => {
  assert.equal(redact('作者 author=张三，keyword=你好'), '作者 author=张三，keyword=你好');
});

test('secretName：按驼峰 / 下划线拆词判断', () => {
  assert.equal(secretName('access_token'), true);
  assert.equal(secretName('accessToken'), true);
  assert.equal(secretName('api_key'), true);
  assert.equal(secretName('apikey'), true);
  assert.equal(secretName('Password'), true);
  assert.equal(secretName('author'), false);
  assert.equal(secretName('keyword'), false);
});

test('redactObject：凭据名整段打码，普通字段保留，递归处理嵌套与数组', () => {
  const input = {
    name: '张三',
    password: 'hunter2',
    token: 'abc',
    nested: { apiKey: 'xyz', note: 'hi' },
    list: ['sk-' + 'a'.repeat(20)],
  };
  const out = redactObject(input);
  assert.equal(out.name, '张三');
  assert.equal(out.password, MASK);
  assert.equal(out.token, MASK);
  assert.equal(out.nested.apiKey, MASK);
  assert.equal(out.nested.note, 'hi');
  assert.equal(out.list[0], MASK);
});

test('redactNetwork：URL 里的凭据与 OAuth 的 code/state 遮住，keyword 保留', () => {
  const url = 'https://a.com/cb?code=abc123&state=st4te&token=tokval&keyword=hello';
  const out = redactNetwork(url);
  assert.ok(out.includes('code=' + MASK));
  assert.ok(out.includes('state=' + MASK));
  assert.ok(out.includes('token=' + MASK));
  assert.ok(out.includes('keyword=hello'));
  assert.ok(!out.includes('abc123'));
});

test('redactNetwork：JSON 正文里凭据字段遮住', () => {
  const body = '{"user":"bob","session_token":"abcdef","note":"hi"}';
  const out = redactNetwork(body);
  assert.ok(out.includes('"session_token":"' + MASK + '"'));
  assert.ok(!out.includes('abcdef'));
  assert.ok(out.includes('"user":"bob"'));
});

test('redactNetwork：表单里的 password 遮住', () => {
  const out = redactNetwork('username=bob&password=s3cret');
  assert.equal(out, 'username=bob&password=' + MASK);
});

test('redactNetwork：头表按名字遮住', () => {
  const out = redactNetwork({ Authorization: 'Bearer abcdefghijkl', 'Content-Type': 'application/json', Cookie: 'sid=1' });
  assert.equal(out.Authorization, MASK);
  assert.equal(out.Cookie, MASK);
  assert.equal(out['Content-Type'], 'application/json');
});

test('空值原样', () => {
  assert.equal(redact(null), null);
  assert.equal(redactObject(null), null);
  assert.equal(redactNetwork(null), null);
});

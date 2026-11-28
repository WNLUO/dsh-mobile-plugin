// 2026-11-28：报错本地化的守卫：映射键必须在字典里，界面报错必须走本地化出口。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const SRC = path.join(__dirname, '..', 'React', 'src');
const read = (...parts) => fs.readFileSync(path.join(SRC, ...parts), 'utf8');

test('错误码映射到的键都在本地化字典里', () => {
  const api = read('lib', 'api.ts');
  const errors = read('lib', 'i18n', 'messages', 'errors.ts');
  const mapped = [...new Set([...api.matchAll(/'(panel\.error\.[\w.]+)'/g)].map((m) => m[1]))];
  assert.ok(mapped.length >= 10, `只读到 ${mapped.length} 个映射键，抽取逻辑可能坏了`);
  for (const key of mapped) {
    assert.ok(errors.includes(`'${key}':`), `${key} 没有对应的多语言文案`);
  }
});

test('常见宿主错误码都有映射，不再靠中文原文撑界面', () => {
  const api = read('lib', 'api.ts');
  for (const code of ['frp-unavailable', 'cloudflare-unavailable', 'zeronews-unavailable', 'update_unavailable', 'ota_unavailable', 'bad-request']) {
    assert.ok(api.includes(`'${code}':`), `${code} 没进错误码映射`);
  }
  assert.match(api, /export function errorText[\s\S]{0,160}localizedError/, '统一报错出口要走本地化');
  assert.match(api, /export function replyErrorText[\s\S]{0,400}localizedError/, '回包里的错误也要本地化');
  assert.match(api, /export function apiMessageText[\s\S]{0,120}localizedError/, '状态里的错误也要本地化');
});

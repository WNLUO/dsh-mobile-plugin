// 2026-11-27：插件不再代理宿主凭据，这里只留设置页从 schema 推导凭据引用的纯函数契约。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { credentialRefOf, normalizeNamespace } = require('../lib/mobile/host-settings.js');

test('credentialRefOf：从 schema 的 role 标记推导凭据引用', () => {
  const webSearch = {
    uid: 294,
    refs: {
      277: { type: 'string', meta: { role: 'secret' } },
      280: { type: 'string', meta: { role: 'credential-ref', default: 'DEEPSEEK_API_KEY' } },
      283: { type: 'string', meta: { default: 'deepseek-v4-flash' } },
      294: { type: 'object', meta: { default: {} }, dict: { apiKey: 277, apiKeyEnv: 280, model: 283 } },
    },
  };
  assert.deepEqual(credentialRefOf(webSearch, { apiKeyEnv: 'DEEPSEEK_API_KEY' }), { ref: 'DEEPSEEK_API_KEY', refField: 'apiKeyEnv' });
  // 值里没写就用 schema 的 default。
  assert.deepEqual(credentialRefOf(webSearch, {}), { ref: 'DEEPSEEK_API_KEY', refField: 'apiKeyEnv' });
  // 值里写了就以值为准。
  assert.deepEqual(credentialRefOf(webSearch, { apiKeyEnv: 'MY_KEY' }), { ref: 'MY_KEY', refField: 'apiKeyEnv' });
  // 空白值回落到 default。
  assert.deepEqual(credentialRefOf(webSearch, { apiKeyEnv: '   ' }), { ref: 'DEEPSEEK_API_KEY', refField: 'apiKeyEnv' });

  // 只有 credential-ref、没有 secret：这个命名空间没有可写的密钥槽。
  const llm = { uid: 9, refs: { 8: { type: 'string', meta: { role: 'credential-ref', default: 'DEEPSEEK_API_KEY' } }, 9: { type: 'object', dict: { apiKeyEnv: 8 } } } };
  assert.equal(credentialRefOf(llm, { apiKeyEnv: 'DEEPSEEK_API_KEY' }), null);
  // 有 secret 但没有 credential-ref（也没有 default）：推不出来。
  const noRef = { uid: 2, refs: { 1: { type: 'string', meta: { role: 'secret' } }, 2: { type: 'object', dict: { apiKey: 1 } } } };
  assert.equal(credentialRefOf(noRef, {}), null);

  // 两个密钥槽共用一个 credential-ref：引用是命名空间级的，写哪个都不对，宁可不给入口。
  const twoSecrets = {
    uid: 5,
    refs: {
      3: { type: 'string', meta: { role: 'secret' } },
      4: { type: 'string', meta: { role: 'secret' } },
      6: { type: 'string', meta: { role: 'credential-ref', default: 'DEEPSEEK_API_KEY' } },
      5: { type: 'object', dict: { apiKey: 3, backupKey: 4, apiKeyEnv: 6 } },
    },
  };
  assert.equal(credentialRefOf(twoSecrets, { apiKeyEnv: 'DEEPSEEK_API_KEY' }), null);

  for (const bad of [null, undefined, 7, 'nope', [], {}, { uid: 1 }, { uid: 1, refs: {} }, { uid: 1, refs: { 1: { dict: 'x' } } }, { uid: 1, refs: { 1: {} } }]) {
    assert.equal(credentialRefOf(bad, {}), null, JSON.stringify(bad));
  }
});

test('normalizeNamespace：只有既有密钥槽又推导得出引用时才给 credentialRef', () => {
  const schema = {
    uid: 294,
    refs: {
      277: { type: 'string', meta: { role: 'secret' } },
      280: { type: 'string', meta: { role: 'credential-ref', default: 'DEEPSEEK_API_KEY' } },
      294: { type: 'object', dict: { apiKey: 277, apiKeyEnv: 280 } },
    },
  };
  const withSecret = normalizeNamespace({
    ns: 'web-search-deepseek',
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
    applies: 'live',
    revision: 3,
    secrets: [{ path: ['apiKey'], set: false }],
    schema,
  });
  assert.equal(withSecret.credentialRef, 'DEEPSEEK_API_KEY');
  assert.deepEqual(withSecret.secrets, [{ path: 'apiKey', set: false }]);

  // 宿主没报密钥槽：即使 schema 里有 role 标记也不给。
  const noSlots = normalizeNamespace({
    ns: 'web-search-deepseek',
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
    applies: 'live',
    revision: 3,
    secrets: [],
    schema,
  });
  assert.equal('credentialRef' in noSlots, false);

  // schema 畸形：不给，但也不抛错。
  const badSchema = normalizeNamespace({
    ns: 'x',
    value: { apiKey: 'v' },
    applies: 'live',
    revision: 1,
    secrets: [{ path: ['apiKey'], set: true }],
    schema: 'nope',
  });
  assert.equal('credentialRef' in badSchema, false);
  assert.deepEqual(badSchema.secrets, [{ path: 'apiKey', set: true }]);
});

test('源码契约：host-settings 仍导出 credentialRefOf，但插件没有凭据代理路由', () => {
  const root = path.join(__dirname, '..');
  const settings = fs.readFileSync(path.join(root, 'lib/mobile/host-settings.js'), 'utf8');
  assert.match(settings, /function credentialRefOf\(schema, value\)/);
  assert.match(settings, /out\.credentialRef = credential\.ref/);
  assert.equal(fs.existsSync(path.join(root, 'lib/mobile/credentials.js')), false);
});

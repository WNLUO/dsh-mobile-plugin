// ZeroNews 彻底清理：reset 失败必须留住缓存二进制供手动重试，成功才删。
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { purgeZeroNews, RESET_TIMEOUT_MS } = require('../lib/zeronews/purge.cjs');

const ROOT = '/tmp/dsh-zeronews-purge-test';
const CACHED = path.join(ROOT, 'zeronews');
const SYSTEM_BIN = '/Applications/zeronews/zeronews';

function harness({ resetOk = true, located = true, rmThrows = false } = {}) {
  const commands = [];
  const removed = [];
  return {
    commands,
    removed,
    options: {
      root: ROOT,
      platform: { platform: 'darwin' },
      fsImpl: {
        rmSync(target, opts) {
          if (rmThrows) throw new Error('permission denied');
          removed.push([target, opts]);
        },
      },
      locate: async () => (located ? { ok: true, path: SYSTEM_BIN, source: 'system' } : { ok: false, path: '', code: 'not-installed' }),
      run: async (bin, args, opts) => {
        commands.push([bin, args, opts]);
        return resetOk
          ? { code: 0, stdout: 'reset ok', stderr: '' }
          : { code: 1, stdout: '', stderr: 'need administrator privileges' };
      },
    },
  };
}

test('reset 成功：跑官方 reset 后删掉插件缓存的客户端', async () => {
  const h = harness();
  const result = await purgeZeroNews(h.options);
  assert.equal(result.ok, true);
  assert.equal(result.reset.attempted, true);
  assert.equal(result.reset.ok, true);
  assert.deepEqual(h.commands[0][1], ['reset'], '官方 reset 命令');
  assert.equal(h.commands[0][0], SYSTEM_BIN, '用定位到的客户端执行，不另下一份');
  assert.equal(h.commands[0][2].timeoutMs, RESET_TIMEOUT_MS);
  assert.deepEqual(h.removed, [[CACHED, { force: true }]], '只删缓存那份，系统安装的不碰');
  assert.equal(result.cacheRemoved, true);
  assert.equal(result.error, '');
});

test('reset 失败：如实报错、留住缓存二进制，让人能在终端手动重试', async () => {
  const h = harness({ resetOk: false });
  const result = await purgeZeroNews(h.options);
  assert.equal(result.ok, false);
  assert.equal(result.reset.ok, false);
  assert.match(result.error, /administrator privileges/);
  assert.match(result.error, /zeronews reset/);
  assert.deepEqual(h.removed, [], 'reset 没成功就绝不能删掉最后一份二进制');
});

test('本机没装客户端：跳过 reset，仍清掉缓存残留', async () => {
  const h = harness({ located: false });
  const result = await purgeZeroNews(h.options);
  assert.equal(result.ok, true);
  assert.equal(result.reset.attempted, false);
  assert.deepEqual(h.commands, [], '没二进制就不跑命令');
  assert.deepEqual(h.removed, [[CACHED, { force: true }]]);
});

test('缓存删不掉：如实报，不让界面说已经清理干净', async () => {
  const h = harness({ rmThrows: true });
  const result = await purgeZeroNews(h.options);
  assert.equal(result.ok, false);
  assert.equal(result.reset.ok, true, '身份已经重置成功');
  assert.match(result.error, /permission denied/);
  assert.equal(result.cacheRemoved, false);
});

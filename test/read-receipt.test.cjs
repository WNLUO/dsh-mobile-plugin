'use strict';

/**
 * 已读回执台账（lib/read-receipt.cjs）的行为守卫。
 *
 * 这张台账是「手机端读过了 → 桌面端灭灯」的唯一载体，所以钉住三件事：
 *   1. 水位**只前进不后退**（客户端半边拿它当游标，回退会让同一个会话被反复处理）；
 *   2. 损坏 / 缺失 / 形状不对的文件一律按「还没有台账」处理，绝不抛错 —— 它只是旁路，
 *      读不动不能让手机端的「已读」这个动作跟着失败；
 *   3. 条数按 readAt 截断，别让文件无限长。
 *
 * DSH_HOME 在每次 load 前指到临时目录，并清掉 require 缓存：模块把台账记忆化在模块
 * 顶层（与 desktop-view.cjs 同款），不换实例就测不出「文件损坏」这类冷启动路径。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const MODULE = require.resolve('../lib/read-receipt.cjs');

/** 换一个全新的 DSH_HOME 并重新加载模块，拿到没有记忆的实例。 */
function fresh(home) {
  process.env.DSH_HOME = home;
  delete require.cache[MODULE];
  return require(MODULE);
}

const homes = [];
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-read-receipt-'));
  homes.push(home);
  return home;
}

test.after(() => {
  delete process.env.DSH_HOME;
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
});

test('没写过任何一条时 snapshot() 是 null，路径落在 DSH_HOME 下', () => {
  const home = makeHome();
  const receipt = fresh(home);
  assert.equal(receipt.snapshot(), null);
  assert.equal(receipt.stateFile(), path.join(home, 'read-receipts.json'));
});

test('recordRead 落盘，水位只前进不后退', () => {
  const home = makeHome();
  const receipt = fresh(home);

  const first = receipt.recordRead('session-a', 1000);
  assert.deepEqual(first, { sessionId: 'session-a', readAt: 1000, changed: true });
  assert.equal(receipt.snapshot().readAt['session-a'], 1000);

  // 同一个会话在更早的时刻被「又读了一次」（乱序 / 时钟回拨）：保留原水位，不报变化。
  const older = receipt.recordRead('session-a', 500);
  assert.equal(older.changed, false);
  assert.equal(older.readAt, 1000);
  assert.equal(receipt.snapshot().readAt['session-a'], 1000);

  // 前进才报变化，客户端半边的游标才有意义。
  const newer = receipt.recordRead('session-a', 2000);
  assert.equal(newer.changed, true);
  assert.equal(receipt.snapshot().readAt['session-a'], 2000);
});

test('落盘之后重新加载仍然读得到（换实例 = 冷启动）', () => {
  const home = makeHome();
  fresh(home).recordRead('session-a', 1234);
  const reloaded = fresh(home);
  assert.deepEqual(reloaded.snapshot(), { readAt: { 'session-a': 1234 } });
});

test('非法 sessionId 不落盘也不报变化', () => {
  const home = makeHome();
  const receipt = fresh(home);
  for (const bad of ['', '   ', 42, null, undefined, 'x'.repeat(201)]) {
    assert.equal(receipt.recordRead(bad, 1000).changed, false, `应当拒绝 ${String(bad)}`);
  }
  assert.equal(receipt.snapshot(), null);
  assert.equal(fs.existsSync(receipt.stateFile()), false);
});

test('文件损坏 / 形状不对都按「还没有台账」处理，不抛错', () => {
  const home = makeHome();
  const file = path.join(home, 'read-receipts.json');

  fs.writeFileSync(file, '{ 这不是 JSON');
  assert.equal(fresh(home).snapshot(), null);

  fs.writeFileSync(file, JSON.stringify({ readAt: 'nope' }));
  assert.equal(fresh(home).snapshot(), null);

  fs.writeFileSync(file, JSON.stringify({ readAt: { good: 10, bad: 'x', zero: 0, neg: -1 } }));
  assert.deepEqual(fresh(home).snapshot(), { readAt: { good: 10 } });
});

test('条数按 readAt 截断到上限，保留最新的', () => {
  const home = makeHome();
  const file = path.join(home, 'read-receipts.json');
  const readAt = {};
  for (let index = 0; index < 600; index += 1) readAt[`session-${index}`] = 1000 + index;
  fs.writeFileSync(file, JSON.stringify({ readAt }));

  const snapshot = fresh(home).snapshot();
  const ids = Object.keys(snapshot.readAt);
  assert.equal(ids.length, 512);
  // 最大 readAt 的那些留下，最小的那些被丢掉。
  assert.equal(snapshot.readAt['session-599'], 1599);
  assert.equal(snapshot.readAt['session-0'], undefined);
});

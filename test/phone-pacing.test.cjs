'use strict';

/**
 * 节奏控制的守卫：三档真值表、落盘读回、坏文件退化、对外动作随时间加间隔的边界。
 *
 * 用临时 DSH_HOME 驱动真实现（paths 在调用时解析 env），所以这里能真的读写一遍设置文件。
 *
 * 运行：node --test test/phone-pacing.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-phone-pacing-'));
process.env.DSH_HOME = home;
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const pacing = require('../lib/mobile/phone/pacing.js');

/** 每个用例从「没有设置文件、没有计数、没有内存缓存」开始。 */
function fresh() {
  try {
    fs.rmSync(pacing.settingsFile(), { force: true });
  } catch {
    /* 本来就没有 */
  }
  pacing.resetCacheForTest();
  pacing.resetOutwardForTest();
}

test('三档真值表', () => {
  assert.deepEqual(pacing.paceFor('fast'), {
    betweenActionsMs: [0, 0],
    outwardMinMs: [0, 0],
    typingChunkMs: 0,
  });
  assert.deepEqual(pacing.paceFor('standard'), {
    betweenActionsMs: [500, 1200],
    outwardMinMs: [8000, 20000],
    typingChunkMs: 40,
  });
  assert.deepEqual(pacing.paceFor('human'), {
    betweenActionsMs: [1000, 2000],
    outwardMinMs: [15000, 30000],
    typingChunkMs: 90,
  });
});

test('认不出的档按 standard 给，不返回 undefined', () => {
  assert.deepEqual(pacing.paceFor('bogus'), pacing.paceFor('standard'));
  assert.deepEqual(pacing.paceFor(undefined), pacing.paceFor('standard'));
});

test('默认档是 standard', () => {
  fresh();
  assert.equal(pacing.get(), 'standard');
});

test('set 之后落盘、get 能读回', () => {
  fresh();
  assert.equal(pacing.get(), 'standard');
  assert.equal(pacing.set('human'), 'human');
  assert.equal(pacing.get(), 'human');

  const raw = JSON.parse(fs.readFileSync(pacing.settingsFile(), 'utf8'));
  assert.equal(raw.mode, 'human');

  assert.equal(pacing.set('fast'), 'fast');
  assert.equal(pacing.get(), 'fast');
});

test('坏文件当 standard', () => {
  fresh();
  fs.mkdirSync(path.dirname(pacing.settingsFile()), { recursive: true });
  fs.writeFileSync(pacing.settingsFile(), '{ 这不是 JSON', 'utf8');
  pacing.resetCacheForTest();
  assert.equal(pacing.get(), 'standard');

  fs.writeFileSync(pacing.settingsFile(), JSON.stringify({ mode: 'ludicrous' }), 'utf8');
  pacing.resetCacheForTest();
  assert.equal(pacing.get(), 'standard');
});

test('落盘失败不崩，按新档在内存里继续', () => {
  fresh();
  // 用一个文件当 DSH_HOME，mkdir 会失败（ENOTDIR），模拟写盘失败。
  const blocker = path.join(home, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(blocker, 'nested');
  try {
    pacing.resetCacheForTest();
    assert.doesNotThrow(() => pacing.set('human'));
    assert.equal(pacing.get(), 'human');
  } finally {
    process.env.DSH_HOME = saved;
    pacing.resetCacheForTest();
  }
});

test('对外动作：0 次时不额外等', () => {
  fresh();
  pacing.set('standard');
  pacing.resetOutwardForTest();
  assert.equal(pacing.noteOutward(1000), 0);
});

test('对外动作：次数越多间隔越大（3 次边界）', () => {
  fresh();
  pacing.set('standard');
  pacing.resetOutwardForTest();
  const t = 1000;
  assert.equal(pacing.noteOutward(t), 0); // 第 1 次：不等
  assert.equal(pacing.noteOutward(t), 8000); // 第 2 次：下限 8000
  assert.equal(pacing.noteOutward(t), 8500); // 第 3 次：+0.5s
  assert.equal(pacing.noteOutward(t), 9000); // 第 4 次：再 +0.5s
});

test('对外动作：很多次封顶 30 秒，且永不为负', () => {
  fresh();
  pacing.set('standard');
  pacing.resetOutwardForTest();
  let last = 0;
  for (let i = 0; i < 100; i += 1) {
    last = pacing.noteOutward(0);
    assert.ok(last >= 0, `第 ${i + 1} 次返回了负数：${last}`);
    assert.ok(last <= pacing.MAX_OUTWARD_MS, `第 ${i + 1} 次超过上限：${last}`);
  }
  assert.equal(last, pacing.MAX_OUTWARD_MS);
});

test('对外动作：隔够了就不额外等', () => {
  fresh();
  pacing.set('standard');
  pacing.resetOutwardForTest();
  assert.equal(pacing.noteOutward(0), 0);
  // 第一次之后本来要等 8000ms，这里已过了 60 秒，余量为 0。
  assert.equal(pacing.noteOutward(60 * 1000), 0);
});

test('fast 档对外动作永远是 0', () => {
  fresh();
  pacing.set('fast');
  pacing.resetOutwardForTest();
  for (let i = 0; i < 10; i += 1) assert.equal(pacing.noteOutward(0), 0);
});

test('human 档第一段间隔是 15 秒下限', () => {
  fresh();
  pacing.set('human');
  pacing.resetOutwardForTest();
  assert.equal(pacing.noteOutward(0), 0);
  assert.equal(pacing.noteOutward(0), 15000);
  assert.equal(pacing.noteOutward(0), 15500);
});

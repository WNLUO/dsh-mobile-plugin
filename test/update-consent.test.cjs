'use strict';

/**
 * 「有手机连着就先问一声」状态机的守卫。
 *
 * 这里钉的都是从代码上看不出来、错了会让用户被莫名其妙打断（或永远更不了）的判断：
 * 没人在用要照旧更；有人在用要先停；等太久没人理要兜底更；手机断开要更；用户说「过一会儿」
 * 就要等到点；推迟期间出新版不许提前动；等的过程换了目标版本要重排窗口。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { createUpdateConsent } = require('../lib/shell/update-consent.js');

/** 可控时钟。 */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const updatable = (over = {}) => ({ latestVersion: '0.5.105', updateAvailable: true, appActive: true, ...over });

test('没有新版：idle，不留待确认', () => {
  const c = createUpdateConsent();
  const r = c.evaluate(updatable({ updateAvailable: false }));
  assert.equal(r.action, 'idle');
  assert.equal(r.status.pendingVersion, null);
});

test('没手机连着：照旧直接装', () => {
  const c = createUpdateConsent();
  assert.equal(c.evaluate(updatable({ appActive: false })).action, 'update');
});

test('有手机连着：先停住，记下待确认版本', () => {
  const c = createUpdateConsent();
  const r = c.evaluate(updatable());
  assert.equal(r.action, 'hold');
  assert.equal(r.status.pendingVersion, '0.5.105');
  assert.ok(r.status.deadlineAt);
});

test('等过 10 分钟还没人理：兜底直接装', () => {
  const c = clock();
  const consent = createUpdateConsent({ now: c.now });
  assert.equal(consent.evaluate(updatable()).action, 'hold');
  c.advance(9 * 60 * 1000);
  assert.equal(consent.evaluate(updatable()).action, 'hold', '不到 10 分钟还得等');
  c.advance(2 * 60 * 1000);
  assert.equal(consent.evaluate(updatable()).action, 'update', '超过上限就当人不在，直接装');
});

test('等的过程里手机断开：直接装，并清掉待确认', () => {
  const consent = createUpdateConsent();
  assert.equal(consent.evaluate(updatable()).action, 'hold');
  const r = consent.evaluate(updatable({ appActive: false }));
  assert.equal(r.action, 'update');
  assert.equal(r.status.pendingVersion, null);
});

test('用户「过一会儿」：到点之前一直 hold，哪怕有新版本也不动', () => {
  const c = clock();
  const consent = createUpdateConsent({ now: c.now });
  consent.snooze(30);
  // 推迟期间有新版、也有手机连着 → 仍然 hold
  const r = consent.evaluate(updatable({ latestVersion: '0.5.106' }));
  assert.equal(r.action, 'hold');
  assert.ok(r.status.snoozedUntil);
  c.advance(31 * 60 * 1000);
  // 推迟到点：有手机连着 → 按当时最新那一版进入等确认
  const r2 = consent.evaluate(updatable({ latestVersion: '0.5.106' }));
  assert.equal(r2.action, 'hold');
  assert.equal(r2.status.pendingVersion, '0.5.106');
});

test('推迟到点时没手机连着：直接装', () => {
  const c = clock();
  const consent = createUpdateConsent({ now: c.now });
  consent.snooze(10);
  c.advance(11 * 60 * 1000);
  assert.equal(consent.evaluate(updatable({ appActive: false })).action, 'update');
});

test('等待期间换了目标版本：窗口重排（不先更旧的）', () => {
  const c = clock();
  const consent = createUpdateConsent({ now: c.now });
  consent.evaluate(updatable({ latestVersion: '0.5.105' }));
  const firstDeadline = consent.status().deadlineAt;
  c.advance(5 * 60 * 1000);
  const r = consent.evaluate(updatable({ latestVersion: '0.5.106' }));
  assert.equal(r.action, 'hold');
  assert.equal(r.status.pendingVersion, '0.5.106');
  assert.notEqual(r.status.deadlineAt, firstDeadline, '换了目标版本要重新计时');
});

test('推迟分钟数不合法：按默认（不报错、也不会立刻过期）', () => {
  const c = clock();
  const consent = createUpdateConsent({ now: c.now });
  const st = consent.snooze(Number.NaN);
  assert.ok(st.snoozedUntil, '给了非法分钟数也要进入推迟');
  assert.equal(consent.evaluate(updatable()).action, 'hold');
});

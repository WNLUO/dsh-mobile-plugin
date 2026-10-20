/**
 * 「桌面侧栏折叠态变了」这条信号的守卫。
 *
 * 它把 App 那一侧从「每 5 分钟猜一次」改成「变了才拉」，所以两件事必须钉住：
 *  1. **内容没变不许广播** —— 客户端半边在页面重载 / 切窗口时会重发同一份；
 *     照单全推等于把白问的轮询换成白推的帧。
 *  2. **变化必须广播一次** —— 少了它，手机上的折叠态就永远停在首次拉到的那一份。
 *
 * 与 desktop-view.cjs 同款模块级状态，所以本文件自带临时 DSH_HOME，且一个进程只
 * require 一次（node --test 每个文件独立进程）。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-view-signal-'));
process.env.DSH_HOME = home;

const desktopView = require('../lib/desktop-view.cjs');
const { desktopViewSignal } = require('../lib/shared/desktop-view-signal.js');

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

test('首次上报：落盘并广播一次，updatedAt 就是这份快照的 receivedAt', () => {
  const seen = [];
  const release = desktopViewSignal.onBump((event) => seen.push(event));
  try {
    const view = desktopView.update({ groupExpansion: { 'ws-1': true } }, 1_700_000_000_000);
    assert.deepEqual(view.groupExpansion, { 'ws-1': true });
    assert.equal(seen.length, 1, '首次上报必须广播，否则手机永远拿不到这份折叠态');
    assert.equal(seen[0].updatedAt, 1_700_000_000_000);
    assert.equal(desktopViewSignal.snapshot().updatedAt, 1_700_000_000_000);
  } finally {
    release();
  }
});

test('同一份折叠态重复上报（键序不同）不广播、也不重写快照', () => {
  const seen = [];
  const release = desktopViewSignal.onBump((event) => seen.push(event));
  try {
    const before = desktopView.snapshot();
    desktopView.update({ groupExpansion: { 'ws-1': true } }, 1_700_000_111_000);
    assert.equal(seen.length, 0, '内容没变还广播，等于每次页面重载都给每台手机推一帧');
    assert.equal(desktopView.snapshot().updatedAt, before.updatedAt, '没变就不该改写 receivedAt');
  } finally {
    release();
  }
});

test('折叠态真的变了：广播一次，快照前移', () => {
  const seen = [];
  const release = desktopViewSignal.onBump((event) => seen.push(event));
  try {
    desktopView.update({ groupExpansion: { 'ws-1': false, 'ws-2': true } }, 1_700_000_222_000);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].updatedAt, 1_700_000_222_000);
    assert.deepEqual(desktopView.snapshot().groupExpansion, { 'ws-1': false, 'ws-2': true });
  } finally {
    release();
  }
});

test('非法形状抛错，且不许广播', () => {
  const seen = [];
  const release = desktopViewSignal.onBump((event) => seen.push(event));
  try {
    assert.throws(() => desktopView.update({ groupExpansion: 'nope' }), /groupExpansion/);
    assert.equal(seen.length, 0);
  } finally {
    release();
  }
});

test('同一个 updatedAt 连推两次只算一次（幂等）', () => {
  const signal = require('../lib/shared/desktop-view-signal.js').createDesktopViewSignal();
  const seen = [];
  signal.onBump((event) => seen.push(event));
  assert.equal(signal.bump(1234), true);
  assert.equal(signal.bump(1234), false);
  assert.equal(seen.length, 1);
});

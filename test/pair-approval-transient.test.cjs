// 2026-11-24：配对被拒要分得清「暂时没答上」和「真被策略拒」，别让内部抖动冒充「电脑拒绝新设备」。
'use strict';

/**
 * 守卫：局域网 / 中转配对的「拒绝」必须能分辨来源。
 *
 * 现场：手机在局域网可扫、电脑「允许配对」也开着，同一张有效二维码却时好时坏——扫三四次才成。
 * 根因是旁车问主进程「放不放行」这一发自己挂了（启动 / 重配那几秒、内部超时）时，旧实现把
 * 它 `catch { approved:false }`，于是和「策略真的拒绝」长得一模一样，手机只会看到那句
 * 「码不对 / 电脑拒绝新设备」，看不出是一台电脑自己的抖动。
 *
 * 约定：内部 RPC 失败要**抛出去**（接入层回 5xx 让手机重试），并把真因写进日志；真正的拒绝
 * 与解票失败各有各的日志。这三样任缺一样，守卫就红。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

test('旁车局域网配对：问主进程放不放行失败时抛错（5xx 重试），不冒充「拒绝」', () => {
  const worker = read('lib', 'sidecar-facade-worker.cjs');
  // 旧的「内部失败 = 拒绝」写法必须消失：它正是这句误报的来源。
  assert.doesNotMatch(
    worker,
    /catch \{ return \{ approved: false, token: null \} \}/,
    '内部 RPC 失败不许直接 return approved:false（会冒充策略拒绝）',
  );
  assert.match(worker, /lan pair approval RPC failed/, '内部 RPC 失败要写日志，真因可查');
  assert.match(worker, /approval-unavailable/, '失败要抛成可识别的原因，交给接入层回 5xx');
});

test('旁车中转配对：内部 RPC 失败同样要记日志', () => {
  const worker = read('lib', 'sidecar-facade-worker.cjs');
  assert.match(worker, /tunnel pair approval RPC failed/, '隧道那条的内部失败也要留痕');
});

test('局域网代理：解票失败 / 真被策略拒各写各的日志，不再混成一句', () => {
  const proxy = read('lib', 'relay', 'lan-proxy.js');
  assert.match(proxy, /lan pair: sealed open failed/, '解票失败要单独记（票据 / 实例号对不上）');
  assert.match(proxy, /lan pair: approval denied by host policy/, '真被策略拒要单独记');
});

test('宿主 /pair：解票失败与策略拒绝各写各的日志', () => {
  const pairing = read('lib', 'mobile', 'pairing.js');
  assert.match(pairing, /pair: sealed open failed/, '解票失败要单独记');
  assert.match(pairing, /pair: approval denied by policy=/, '真被策略拒要单独记');
});

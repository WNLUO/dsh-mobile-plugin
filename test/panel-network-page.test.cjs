// 网络配置独立页：hash 路由、隐藏顶栏、自建中转检测与明文 http 提示。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('网络配置是独立子页：用 hash 路由，刷新留在这一页，并隐藏顶部状态栏', () => {
  const consoleSrc = read('React', 'src', 'Console.tsx');
  assert.match(consoleSrc, /window\.location\.hash/, '视图要跟地址栏 hash 走');
  assert.match(consoleSrc, /networkFromHash/, '初始视图由 hash 决定（刷新不丢）');
  assert.match(consoleSrc, /'hashchange'/, '前进后退 / 手改 hash 要跟着切视图');
  assert.match(consoleSrc, /\{configOpen \? null : \(/, '在网络配置页时不显示顶部状态栏');
});

test('自建中转有「检测」：确认是不是我们的中转、取版本与延迟', () => {
  const page = read('React', 'src', 'components', 'RelayConfigDialog.tsx');
  assert.match(page, /async function checkSelfRelay/, '要有检测函数');
  assert.match(page, /\/api\/relay\/probe-relays/, '复用宿主已有的中转探测端点');
  assert.match(page, /hit\.service === 'dsh-mobile-relay'/, '只认我们中转的服务标识');
  for (const key of ['panel.relay.detect', 'panel.relay.detectOk', 'panel.relay.detectNotOurs', 'panel.relay.detectFail']) {
    assert.ok(page.includes(`'${key}'`), `要用到 ${key}`);
  }
  const panel = read('React', 'src', 'lib', 'i18n', 'messages', 'panel.ts');
  for (const key of ['panel.relay.detect', 'panel.relay.detecting', 'panel.relay.detectOk', 'panel.relay.detectNotOurs', 'panel.relay.detectFail']) {
    assert.equal(panel.split(`'${key}':`).length - 1, 10, `${key} 要十门齐全`);
  }
});

test('明文 http 的直连 / 自建中转给出 iPhone ATS 提醒', () => {
  const page = read('React', 'src', 'components', 'RelayConfigDialog.tsx');
  assert.match(page, /panel\.address\.plainHttpWarn/, '明文 http 要提示 ATS');
  const panel = read('React', 'src', 'lib', 'i18n', 'messages', 'panel.ts');
  assert.equal(panel.split("'panel.address.plainHttpWarn':").length - 1, 10, '提示文案十门齐全');
});

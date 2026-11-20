/** 扫码成功后收起二维码并结束引导；首次读取、普通续码和重开弹窗不误触发。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const src = path.join(__dirname, '..', 'React', 'src');
const read = (name) => fs.readFileSync(path.join(src, name), 'utf8');

function completionHook(mutate = (source) => source) {
  let ref;
  let effect;
  let dependencies;
  const code = stripTypeScriptTypes(mutate(read('lib/usePairingCompletion.ts')), { mode: 'strip' })
    .replace(/import[^\n]+\n/g, '')
    .replace('export function', 'function');
  const context = { useRef(value) { return ref ??= { current: value }; },
    useEffect(callback, next) {
      if (!dependencies || next.some((value, index) => value !== dependencies[index])) effect = callback;
      dependencies = next;
    } };
  vm.createContext(context);
  vm.runInContext(`${code}\nthis.hook = usePairingCompletion;`, context);
  return (lastPairingAt, onCompleted) => {
    context.hook(lastPairingAt, onCompleted);
    const pending = effect;
    effect = null;
    if (pending) pending();
  };
}

function assertCompletionFlow(run) {
  let completed = 0;
  const render = (time) => run(time, () => { completed++; });
  render(undefined);
  render(0);
  render(0);
  assert.equal(completed, 0, '首次取状态、手动换码与普通续码不关闭二维码');
  render(1000);
  assert.equal(completed, 1, '绑定成功后关闭一次');
  render(1000);
  render(1000);
  assert.equal(completed, 1, '重开弹窗、父组件重渲染不再次关闭');
  render(undefined);
  render(1000);
  assert.equal(completed, 1, '短暂缺失状态不重复报成功');
  render(2000);
  assert.equal(completed, 2, '下一台手机绑定也能关闭');
  render(1000);
  render(2000);
  assert.equal(completed, 2, '晚到的旧状态不算新绑定，也不降低基线');
}

test('实际绑定成功时间增加才通知完成，续码与重复状态不误触发', () => {
  assertCompletionFlow(completionHook());
});

test('首次就拿到状态时不误报完成', () => {
  let completed = 0;
  const run = completionHook();
  const onCompleted = () => { completed++; };
  run(1000, onCompleted);
  assert.equal(completed, 0, '首次状态含有历史绑定也不报成功');
  run(2000, onCompleted);
  assert.equal(completed, 1);
});

test('主页关闭二维码，引导页关闭二维码并进入主页，两处共用完成判断', () => {
  const card = read('components/PairingCard.tsx');
  const page = read('Onboarding.tsx');
  assert.match(card, /usePairingCompletion\(status\.lastPairingAt, \(\) => setQrZoom\(false\)\)/);
  assert.match(page, /usePairingCompletion\(status\?\.lastPairingAt, \(\) => \{\s*setQrZoomOpen\(false\)\s*enterNow\(\)/);
  assert.match(page, /window\.setInterval\(\(\) => void tick\(\), 3000\)/);
  assert.match(page, /if \(!pageVisible\(\)\) return/);
  assert.match(page, /if \(active\) setStatus\(current\)/);
  assert.match(page, /active = false\s*window\.clearInterval\(timer\)/);
  assert.match(page, /document\.removeEventListener\('visibilitychange', tick\)/);
  assert.match(card, /const qrCurrent = pairing\?\.pairingCode === status\.pairingCode/);
  assert.match(card, /!pairing\?\.svg \|\| !qrCurrent/);
  assert.match(card, /pairing\?\.svg && qrCurrent/);
});

test('状态视图始终回出绑定成功时间，无历史时明确为零', () => {
  const { createStatusView } = require('../lib/relay/status.js');
  const state = {};
  const status = createStatusView({ state,
    getSidecarSnapshot: () => ({}), getLanPortAdjusted: () => false,
    getMirrorPush: () => ({}), lanPortInUse: () => 18787,
    getSidecarState: () => 'healthy', getSidecarRestarts: () => 0,
    getSidecarRestartedAt: () => 0, getSidecarRestartError: () => null,
  });
  assert.equal(status().lastPairingAt, 0);
  state.lastPairingAt = 123456;
  assert.equal(status().lastPairingAt, 123456);
  state.pairingCode = '654321';
  assert.equal(status().lastPairingAt, 123456, '配对码独立变化不伪造绑定成功');
});

test('变异证明：不回调、首次即回调或不记录成功时间都会被完成流程断言抓住', () => {
  const mutations = [
    (source) => source.replace('onCompleted()', 'void 0'),
    (source) => source.replace('if (previous === undefined) previousAt.current = lastPairingAt', 'if (previous === undefined) { previousAt.current = lastPairingAt; onCompleted() }'),
    (source) => source.replace('previousAt.current = lastPairingAt', 'void lastPairingAt'),
  ];
  for (const mutate of mutations) {
    assert.throws(() => assertCompletionFlow(completionHook(mutate)), assert.AssertionError);
  }
});

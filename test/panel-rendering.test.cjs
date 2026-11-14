/** Android 内嵌控制台只隔离承载 iframe，不改变正文布局、定位与卡片样式。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const root = path.join(__dirname, '..', 'React');
const source = fs.readFileSync(path.join(root, 'src/lib/embedded-rendering.ts'), 'utf8');

function prepare({ android = true, embedded = true, owned = true, tag = 'IFRAME' } = {}, text = source) {
  const frame = { tagName: tag, classList: { contains: () => owned }, style: {} };
  const window = { frameElement: frame };
  window.parent = embedded ? {} : window;
  const document = { documentElement: { style: {} }, body: { style: {} } };
  const code = stripTypeScriptTypes(text, { mode: 'strip' }).replace('export function', 'function');
  const context = vm.createContext({ window, document, navigator: { userAgent: android ? 'Mozilla/5.0 (Linux; Android 16)' : 'Mozilla/5.0 (iPhone)' } });
  vm.runInContext(code + '\nprepareEmbeddedRendering();', context);
  return { frame, document };
}

test('Android 目标 iframe 有独立绘制与裁切边界，正文 fixed 定位不变', () => {
  const { frame, document } = prepare();
  assert.deepEqual(frame.style, { transform: 'translateZ(0)', isolation: 'isolate', contain: 'paint' });
  assert.deepEqual(document.body.style, {});
  assert.deepEqual(document.documentElement.style, {});
});

test('iOS、独立打开、其他 iframe 和非 iframe 元素不修改', () => {
  for (const input of [{ android: false }, { embedded: false }, { owned: false }, { tag: 'DIV' }]) {
    assert.deepEqual(prepare(input).frame.style, {});
  }
});

test('变异：移除独立合成后，绘制边界断言会失败', () => {
  const { frame } = prepare({}, source.replace("frame.style.transform = 'translateZ(0)'", ''));
  assert.throws(() => assert.equal(frame.style.transform, 'translateZ(0)'), assert.AssertionError);
});

test('正式入口在 React 挂载前隔离 Android 绘制', () => {
  const main = fs.readFileSync(path.join(root, 'src/main.tsx'), 'utf8');
  assert.ok(main.indexOf('prepareEmbeddedRendering()') < main.indexOf("createRoot(document.getElementById('root')"));
});

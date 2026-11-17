/**
 * 内嵌窗顶栏那两颗窗口按钮的守卫：按钮进页面、动作走消息、只发给父窗口。
 * 这里只钉接线（读源码），真正的执行路径由 client-factory.test.cjs 那侧的消息测试覆盖。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'React', 'src');
const actions = fs.readFileSync(path.join(SRC, 'components', 'PanelWindowActions.tsx'), 'utf8');
const consolePage = fs.readFileSync(path.join(SRC, 'Console.tsx'), 'utf8');
const remotePage = fs.readFileSync(path.join(SRC, 'Remote.tsx'), 'utf8');
const shell = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');

const TYPE = 'dsh-mobile-plugin:panel-action';

test('窗口按钮画在页面里：两页都接了，按钮走统一组件', () => {
  for (const [name, source] of [['Console', consolePage], ['Remote', remotePage]]) {
    assert.match(source, /import \{ PanelWindowActions \} from '\.\/components\/PanelWindowActions\.tsx'/, `${name} 要接窗口按钮组件`);
    assert.match(source, /<PanelWindowActions \/>/, `${name} 顶栏要渲染窗口按钮`);
  }
  assert.match(actions, /import \{ Button \} from '@appica\/ui-react\/button'/, '按钮用现成基类，不手搓');
  assert.equal((actions.match(/<Button\b/g) || []).length, 2, '就两颗按钮');
});

test('动作只发给父窗口、类型与外壳一致、两种动作齐全', () => {
  assert.ok(actions.includes(TYPE), '页面与外壳的消息类型必须同一个');
  assert.ok(shell.includes(`const PANEL_ACTION = '${TYPE}'`), '外壳认同一个类型');
  assert.match(actions, /window\.parent !== window/, '只在内嵌时渲染 / 发消息');
  assert.match(actions, /window\.parent\.postMessage\(/, '发给父窗口，不广播给自己');
  for (const action of ['open-browser', 'close']) {
    assert.ok(actions.includes(`'${action}'`), `页面发得出 ${action}`);
    assert.ok(shell.includes(`'${action}'`), `外壳接得住 ${action}`);
  }
});

test('两颗按钮的文案走字典，不写死中文', () => {
  assert.match(actions, /t\('panel\.console\.openBrowser'\)/, '浏览器打开走字典');
  assert.match(actions, /t\('panel\.common\.close'\)/, '关闭走字典');
  assert.doesNotMatch(actions.replace(/\/\*[\s\S]*?\*\//g, ''), /'[^']*[\u4e00-\u9fa5][^']*'/, '组件里不许有硬编码中文');
});

test('外壳按 iframe 来源校验动作消息，不认别的窗口', () => {
  assert.match(shell, /event\.source !== frame\.contentWindow/, '来源校验还在');
  assert.match(shell, /data\.type === PANEL_ACTION && typeof spec\.onAction === 'function'/, '只执行接了 onAction 的窗');
});

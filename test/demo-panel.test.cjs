'use strict';

/**
 * 守卫：演示页（`React/demo.html` + `src/demo/`）只活在开发服务器里，不进发布产物。
 *
 * 起因：这一页是给录屏用的**假宿主**——它把界面会打的那组 `/api/relay/*` 全部就地答掉，
 * 二维码是仓库里的假图。它必须满足两件事，缺一件就会出事：
 *
 *  1. **不进正式产物**：`lib/panel/index.html` 是提交物、由宿主吐给用户。演示分支要是漏进去，
 *     用户打开设置页看到的可能就是一份假数据（或者一个改过 `window.fetch` 的页面）。
 *     现在正式入口 `src/main.tsx` 里没有任何演示引用，`React/index.html` 也没指向演示入口，
 *     这套断言钉的就是这两条别被人「顺手合进去」。
 *  2. **假宿主不回落**：`installDemoHost()` 覆写的 `fetch` 在遇到表里没写的路径时必须抛错，
 *     不能悄悄调用真 `fetch`。少了这一条，漏写一条路由就等于把请求打到正在用的那台宿主上，
 *     录完屏手机连不上——正是这一页要防的那件事。
 *
 * 变异证明：把 `src/demo/main.tsx` 里的 `installDemoHost()` 删掉、或在假宿主里加一句
 * `return fetch(input, init)` 回落、或让正式入口 import 演示模块，三条各自都会红。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REACT = path.join(__dirname, '..', 'React');
const read = (...parts) => fs.readFileSync(path.join(REACT, ...parts), 'utf8');

test('正式入口一行演示代码都不引用', () => {
  const main = read('src', 'main.tsx');
  assert.ok(!/demo/i.test(main), 'src/main.tsx 里不许出现演示相关引用：正式产物会把它一起打进去');
  // 正式入口必须还是 index.html 指的那个（构建只吃 index.html，见 vite.config.ts 的 outDir）。
  const html = read('index.html');
  assert.match(html, /src="\/src\/main\.tsx"/, 'React/index.html 必须挂正式入口');
  assert.ok(!html.includes('demo'), 'React/index.html 不许指向演示入口');
});

test('演示页有自己的入口，且真的先装假宿主再渲染', () => {
  const html = read('demo.html');
  assert.match(html, /src="\/src\/demo\/main\.tsx"/, 'demo.html 要指向演示入口');
  const main = read('src', 'demo', 'main.tsx');
  assert.match(main, /installDemoHost\(\)/, '演示入口必须装假宿主');
  // 顺序是硬要求：装假宿主必须在 createRoot 之前，否则首批请求已经发出去了。
  assert.ok(
    main.indexOf('installDemoHost()') < main.indexOf('createRoot('),
    'installDemoHost() 必须在 createRoot 之前调用',
  );
});

test('假宿主只认自己的路由表，漏写即失败、绝不回落真 fetch', () => {
  const host = read('src', 'demo', 'host.ts');
  // 「没有这条接口就抛」是隔离的唯一保证。
  assert.match(host, /if \(!response\) throw new TypeError/, '表里没有的路径必须抛错，不能回落真 fetch');
  assert.ok(
    !/window\.fetch\s*=\s*fetch/.test(host) && !/return fetch\(/.test(host),
    '假宿主里不许出现对真 fetch 的转发',
  );
  // 隔离的支点是覆写 window.fetch：表外的路径连窗口都出不去。
  assert.match(host, /window\.fetch\s*=\s*handler/, '假宿主必须覆写 window.fetch');
  // 演示数据必须真的假：二维码走仓库里的预生成图，不是宿主吐的那张。
  assert.match(host, /import qr1 from '\.\/qr-\d\.svg\?raw'/, '二维码必须来自仓库里的假图');
  // 版本号与插件包一致：否则画面上会报一个不存在的版本。
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.match(host, new RegExp(`DEMO_VERSION = '${pkg.version.replace(/\./g, '\\.')}'`), '演示里报的版本必须与插件包一致');
});

test('演示二维码带的是文档网段，扫出来连不到任何机器', () => {
  for (const name of ['qr-1.svg', 'qr-2.svg', 'qr-3.svg']) {
    const svg = read('src', 'demo', name);
    assert.ok(svg.startsWith('<svg'), `${name} 不是一张 SVG`);
    assert.equal(svg.match(/<script|<foreignObject|<use /g), null, `${name} 里不许有脚本或外部引用`);
  }
  const host = read('src', 'demo', 'host.ts');
  // TEST-NET-1（192.0.2.0/24）：RFC 5737 规定只能出现在文档与示例里，不会被路由。
  assert.match(host, /DEMO_LAN_ADDRESS = '192\.0\.2\.\d+'/, '演示用的局域网地址必须是文档网段');
  // 真实二维码是宿主按当前实例 ID 现算的，这里一份都不该有。
  assert.ok(!host.includes('dshpair://'), '演示页里不许出现真实二维码内容');
});

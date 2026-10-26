'use strict';

/**
 * 守卫：网页版面板的单文件产物（`lib/panel/index.html`）必须真是一份能跑的页面。
 *
 * 面板产物一度被浏览器解析成**一屏 JavaScript 源码** —— 页面能打开、HTTP 200、字节数对得
 * 上，界面上却只有源码文本。根因在 `React/scripts/inline.mjs`：把 bundle 塞进 `<script>`
 * 时用的是**替换字符串**，而 bundle 里含 `$&`、`$'` 这类字面量（React internals 的写法被
 * 压缩成模板字面量），`String.prototype.replace` 把它们当替换模式展开：`$&` 展开成原始
 * `<script src="…">` 标签，标签自带一个 `</script>`，HTML 解析器在那儿**提前闭合**脚本，
 * 剩下的 bundle 全落成可见正文。症状极不对称：`npm test`、typecheck、ssr-smoke 全绿
 * （它们都不读产物内容），只有真浏览器打开才看得见。
 *
 * 所以这里钉两件事：**产物的形状**（单文件页面里 `.js`/`.css` 必须真内联完，且只有一个
 * `</script>`，bundle 自带的那些在打包时已转义成 `<\/script>`）；**产生它的那行代码**
 * （`inline.mjs` 替换标签时不得再用字符串形式的替换串，否则下一次 bundle 出现 `$&` 就会
 * 重演，而产物是提交物，只有重跑 build 才会暴露）。
 *
 * 还有一条：**读不到产物时报什么**。真机上「装了打不开」几乎从不是「没构建」，而是「装完
 * 没重启」（旧实例挂在被删掉的目录上）或「装了老版本」—— 三者解法不同，所以
 * `panelDiagnosis` 必须分开报，这里按临时目录跑那几条分支。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_DIR = path.join(__dirname, '..');
const PANEL = path.join(PLUGIN_DIR, 'lib', 'panel', 'index.html');
const INLINE = path.join(PLUGIN_DIR, 'React', 'scripts', 'inline.mjs');

const countOf = (text, needle) => text.match(needle)?.length ?? 0;

test('面板产物：js/css 已内联成单文件，没有残留资产引用', () => {
  const html = fs.readFileSync(PANEL, 'utf8');
  assert.ok(html.length > 200_000, `产物只有 ${html.length} 字节，不像是构建出来的`);
  assert.equal(countOf(html, /src="\/assets\//g), 0, '产物里还有 <script src="/assets/…">，没内联完');
  assert.equal(countOf(html, /href="\/assets\//g), 0, '产物里还有 <link href="/assets/…">，没内联完');
  assert.ok(html.includes('<style>'), '样式没有内联进来');
  assert.ok(html.includes('<div id="root">'), '产物里没有挂载点 #root，React 起不来');
});

test('面板产物：脚本只有一个收尾标签，源码不会漏成正文', () => {
  const html = fs.readFileSync(PANEL, 'utf8');
  // 正确产物 = 1：bundle 自己的 `</script>` 字面量在 inline 时被转义成 `<\/script>`。
  // 被打坏的那一版是 3（原始标签被重复插进 JS 里，且其中一个提前闭合了脚本）。
  const closers = countOf(html, /<\/script/gi);
  assert.equal(closers, 1, `产物里有 ${closers} 个 </script>，脚本被提前闭合，页面会显示源码`);
  const rootScript = html.indexOf('<script');
  const rootCloser = html.search(/<\/script/i);
  assert.ok(rootScript >= 0 && rootCloser > rootScript, '产物里找不到完整的 <script>…</script>');
  assert.ok(
    html.slice(rootCloser).includes('<style>'),
    '脚本收尾之后没有接上内联样式，产物结构不对'
  );
});

test('内联脚本：替换标签必须走函数形式，否则 $& 与 $ 撇号 会被展开', () => {
  const source = fs.readFileSync(INLINE, 'utf8');
  // 这一行的旧写法（带模板字面量替换串）就是这个 bug 的形状。
  const stringReplacement = /html\.replace\(\s*tag\[0\]\s*,\s*`/;
  assert.ok(
    !stringReplacement.test(source),
    'inline.mjs 又用字符串替换串了：bundle 里的 $& 与 $ 撇号 会被 String.replace 当替换模式展开'
  );
  assert.ok(source.includes('replaceTag('), 'inline.mjs 里没有归还标签的 replaceTag 包装');
});

/**
 * 面板读不到时的三条分支。
 *
 * 起因是 2026-10-10 的真机现场：另一台电脑上从市场装了包、DSH 没完整重启，旧实例所在的
 * 目录已被这次安装删掉，于是 `/api/relay/panel` 吐了一段 `panel_missing` —— 而那段文案
 * 只会说「去 React 里跑一次 pnpm run build」，把**三件完全不同的事**（没重启 / 装了老版本 /
 * 真没构建）说成了一件，现场照它做只会白折腾。
 *
 * 所以这里钉的是「分开报」这件事本身：三种现场必须给出三个能照着做的答案，且都带路径。
 */
test('面板读不到：三种现场分开报，别把「没重启」说成「没构建」', () => {
  const { panelDiagnosis } = require(path.join(PLUGIN_DIR, 'lib', 'routes', 'control-plane.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-diagnosis-'));

  // ① 安装目录整个不见了 = 装完没重启（旧实例挂在被删掉的目录上）。
  const goneDir = path.join(tmp, 'gone');
  const gone = panelDiagnosis({ packageDir: goneDir, panelFile: path.join(goneDir, 'lib', 'panel', 'index.html') });
  assert.equal(gone.reason, 'install-gone');
  assert.match(gone.message, /重启/, '这条必须先说重启，而不是构建');
  assert.match(gone.message, /gone/, '报错要带上是哪个目录不见了');

  // ② 目录在、产物不在、且没有 React 源码树 = 装进来的老包（0.1.47 及更早没有这一页）。
  const installed = path.join(tmp, 'installed');
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: 'dsh-mobile-plugin', version: '0.1.42' }));
  const installedPanel = path.join(installed, 'lib', 'panel', 'index.html');
  const missing = panelDiagnosis({ packageDir: installed, panelFile: installedPanel });
  assert.equal(missing.reason, 'artifact-missing');
  assert.match(missing.message, /0\.1\.42/, '要说清楚当前装的是哪个版本');
  assert.match(missing.message, /市场/, '装进来的包该走市场更新，而不是让用户去跑构建');
  assert.ok(!/pnpm run build/.test(missing.message), '装进来的包里没有 React/，提示跑构建是错的');

  // ③ 同一份目录里补出 React/src = 源码树，这时才该让他去构建。
  fs.mkdirSync(path.join(installed, 'React', 'src'), { recursive: true });
  const devTree = panelDiagnosis({ packageDir: installed, panelFile: installedPanel });
  assert.equal(devTree.reason, 'artifact-missing');
  assert.match(devTree.message, /pnpm run build/, '源码树里产物缺席就是要他构建');

  fs.rmSync(tmp, { recursive: true, force: true });
});


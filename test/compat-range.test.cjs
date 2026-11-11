'use strict';

/**
 * 守卫：本包的兼容声明必须跟得上 DSH 抬代。
 *
 * 起因是 0.2.2 抬代时漏了这一处：`engines.dsh` 写的是 `>=0.2.0`（上界放开），本包自身
 * 因此永远放行；但 `peerDependencies` 里那三个 `@deepseek-ai/dsh-*` 与 `devDependencies`
 * 里三个官方工具包还停在 `^0.2.1-rc.x`。semver 的预发布匹配规则是「范围里没提到的那条
 * 预发布线一律不算命中」，于是 `0.2.2-rc.1` 对 `^0.2.1-rc.2` 是**不满足**的。
 *
 * 后果分两处：`host.js` 的 `resolveGeneration` 拿 `evaluatePluginCompatibility` 判「本包
 * 自带那份能不能在这个运行时上挂起来」，判不过就只认运行时那棵树；运行时那棵树里没有
 * 这几个包时（干净安装、profile 没装官方工具），`dsh-tool-ask-user` / `dsh-tool-present`
 * / 目录浏览这三行就整行禁用，现象只是模型说「没有这个工具」。
 *
 * 这里钉的是**声明的覆盖面**，不是解析结果：闭合范围（`^` / `~`）里必须出现当前这条
 * 预发布线（`^0.2.2-rc.1`），敞开范围（`>=x`）本来就覆盖得到。光比 `^` 前缀不够 ——
 * `^0.2.1-rc.2` 也以 `^` 开头。这个文件不 require semver：它在整仓与单独 clone 两种
 * 检出下都要能跑，而 semver 只在 app/ 的依赖树里。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

/** 这条预发布线必须被每份闭合声明覆盖；抬到下一代时只改这一个常量。 */
const REQUIRED_TRACK = '^0.2.2-rc.1';

/** 声明里的 `||` 分支；构建元数据不参与比较，切掉。 */
const alternativesOf = (range) => range.split('||').map((piece) => piece.trim().replace(/^([\^~]?[^+]+)\+.*$/, '$1'));

/** 敞开范围（`>=x`、`*`）上界不限，天然覆盖后来的版本线。 */
const isOpenEnded = (alternative) => alternative === '*' || alternative.startsWith('>=');

/**
 * 这份声明覆盖不覆盖 REQUIRED_TRACK。
 * 只认两种覆盖：敞开范围，或者 `||` 分支里明写了那条预发布线。
 */
const covers = (range) => {
  const alternatives = alternativesOf(range);
  return alternatives.some(isOpenEnded) || alternatives.includes(REQUIRED_TRACK);
};

/** 精确版本（`0.2.1-rc.3`）只在那一代有效，官方抬代就失效。 */
const isExactVersion = (range) => /^\d/.test(range.trim());

test('peerDependencies 里每个 @deepseek-ai/dsh-* 都覆盖当前这条预发布线', () => {
  const peers = pkg.peerDependencies || {};
  const dshPeers = Object.keys(peers).filter((name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'));
  assert.ok(dshPeers.length > 0, 'peerDependencies 里一个 @deepseek-ai/dsh-* 都没有？本包是要跑在 dsh 上的');
  for (const name of dshPeers) {
    assert.ok(
      covers(peers[name]),
      `${name} 的 peer 声明 ${peers[name]} 没覆盖 ${REQUIRED_TRACK} —— 抬代后自带那份会被判不兼容`,
    );
  }
});

test('devDependencies 里那三个官方工具包同样覆盖当前这条预发布线', () => {
  // 三个一起钉：它们互相精确咬版本，漏一个就等于那一行永远只认运行时那棵树。
  const tools = [
    '@deepseek-ai/dsh-host-directory-picker-browse',
    '@deepseek-ai/dsh-tool-ask-user',
    '@deepseek-ai/dsh-tool-present',
  ];
  const dev = pkg.devDependencies || {};
  for (const name of tools) {
    const range = dev[name];
    assert.ok(range !== undefined, `${name} 不在 devDependencies 里`);
    assert.ok(covers(range), `${name} 的 dev 声明 ${range} 没覆盖 ${REQUIRED_TRACK}`);
  }
});

test('这批声明都是范围，不是精确版本', () => {
  // 精确版本只在那一代有效，官方每抬一次代就失效一次 —— 见 A1-63 的刻意设计。
  const ranges = { ...(pkg.peerDependencies || {}), ...(pkg.devDependencies || {}) };
  for (const [name, range] of Object.entries(ranges)) {
    if (!name.startsWith('@deepseek-ai/dsh')) continue;
    assert.equal(isExactVersion(range), false, `${name} 的声明 ${range} 是精确版本，抬代即失效`);
  }
});

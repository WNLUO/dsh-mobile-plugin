'use strict';

/**
 * 凭据包入口的两代盘上布局。
 *
 * 布局迁移那一次真实踩过：旧外壳把 `dsh-mobile-credentials` 放在与插件包**同级**的目录，
 * 新实现却按**嵌在插件包内**的路径 require —— 热更装完、激活时才炸 `Cannot find module`，
 * 而且留下的那一代是残缺的。这个入口两条路都试，布局迁移就不再是地雷。
 *
 * 用例把真实的入口文件拷进临时搭的两种布局里跑：默认路径字符串写错、或只认一种布局，
 * 都会在这里红。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPER = path.join(__dirname, '..', 'lib', 'shared', 'credentials-entry.js');

/** 搭一棵临时的包树；`layout` 决定凭据包落在嵌套位置还是同级位置。 */
function buildLayout(layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creds-layout-'));
  const shared = path.join(root, 'dsh-mobile-plugin', 'lib', 'shared');
  fs.mkdirSync(shared, { recursive: true });
  fs.copyFileSync(HELPER, path.join(shared, 'credentials-entry.js'));
  if (layout !== 'none') {
    const lib = layout === 'nested'
      ? path.join(root, 'dsh-mobile-plugin', 'dsh-mobile-credentials', 'lib')
      : path.join(root, 'dsh-mobile-credentials', 'lib');
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(lib, 'credentials.js'), "module.exports = { mark: 'creds-ok' };\n");
  }
  return require(path.join(shared, 'credentials-entry.js'));
}

test('凭据包入口：嵌在插件包内（新布局）能找到', () => {
  const entry = buildLayout('nested');
  assert.equal(entry.credentialsEntry().mark, 'creds-ok');
  assert.equal(entry.credentialsEntry(), entry.credentialsEntry(), '找到之后应当复用同一个模块');
});

test('凭据包入口：与插件包同级（旧布局）也能找到', () => {
  const entry = buildLayout('sibling');
  assert.equal(entry.credentialsEntry().mark, 'creds-ok');
});

test('凭据包入口：两条路都没有时报错，并说清试过哪些路径', () => {
  const entry = buildLayout('none');
  assert.throws(
    () => entry.credentialsEntry(),
    (error) => error.code === 'MODULE_NOT_FOUND' && /dsh-mobile-credentials/.test(error.message),
    '两条布局都找不到时应抛 MODULE_NOT_FOUND，而不是一个语焉不详的 require 报错',
  );
});

test('凭据包入口：候选顺序是先嵌套、后同级（新布局优先）', () => {
  const entry = buildLayout('nested');
  assert.deepEqual(entry.CREDENTIALS_CANDIDATES, [
    '../../dsh-mobile-credentials/lib/credentials.js',
    '../../../dsh-mobile-credentials/lib/credentials.js',
  ]);
});

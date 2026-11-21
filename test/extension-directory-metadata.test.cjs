// 目录元数据契约：真实来源与声明透传，未知年龄不变成全年龄。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalog = require('../lib/mobile/extension-catalog.js');
const dev = require('../lib/mobile/extension-dev.js');
const plugins = require('../lib/mobile/plugin-catalog.js');
const { metadataOf } = require('../lib/mobile/extension-metadata.cjs');

function packageAt(root, relative, manifest) {
  const directory = path.join(root, relative);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ name: '工具', ...manifest }));
  fs.writeFileSync(path.join(directory, 'index.html'), '<html/>');
}
function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-directory-metadata-'));
  try { run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const declared = {
  purpose: '整理用户交付的笔记', sourceUrl: 'https://example.com/source',
  publicUrl: 'https://example.com/extensions/notes/',
  ageRating: { system: 'Author declaration', value: '16+', minAge: 16, url: 'https://example.com/rating' },
};

test('缺失或畸形年龄保持未知，非公开协议不变为可访问链接', () => {
  assert.equal(metadataOf({}).ageRating, null);
  assert.equal(metadataOf({ ageRating: '4+' }).ageRating, null);
  assert.equal(metadataOf({ ageRating: { system: 'Apple', value: 4 } }).ageRating, null);
  assert.equal(metadataOf({ sourceUrl: 'file:///private/x', publicUrl: 'javascript:alert(1)' }).publicUrl, null);
  assert.equal(metadataOf({ description: '旧说明' }).purpose, '旧说明');
  assert.equal(metadataOf({ ageRating: { system: '作者', value: '16+' } }).ageRating.minAge, null);
  for (const minAge of [null, '16', -1, 22, 1.5]) {
    assert.equal(metadataOf({ ageRating: { system: '作者', value: '16+', minAge } }).ageRating.minAge, null);
  }
  assert.equal(metadataOf({ ageRating: { system: '作者', value: '0+', minAge: 0 } }).ageRating.minAge, 0);
});

test('包内目录和开发目录透传真实声明，能力来自manifest', () => fixture(root => {
  packageAt(root, 'notes', { ...declared, capabilities: ['content.read', 'content.read', 1] });
  fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify({ packages: [{ slug: 'notes' }] }));
  const [published] = catalog.listPackages(root);
  const [developing] = dev.listPackages(root);
  for (const item of [published, developing]) {
    for (const key of Object.keys(declared)) assert.deepEqual(item[key], declared[key]);
    assert.deepEqual(item.capabilities, ['content.read']);
    assert.equal(item.sourcePackage, null);
  }
}));

test('第三方插件标明实际包名和仓库，不给私装包生成官网详情或年龄', () => fixture(root => {
  const owner = path.join(root, 'private-tool');
  fs.mkdirSync(owner);
  fs.writeFileSync(path.join(owner, 'package.json'), JSON.stringify({
    name: 'private-tool', dshMobileExtensions: true,
    repository: { url: 'git+https://github.com/example/private-tool.git' },
  }));
  packageAt(owner, 'extensions/notes', { description: '说明' });
  const [item] = catalog.listThirdParty(root);
  assert.equal(item.slug, 'private-tool.notes');
  assert.equal(item.sourcePackage, 'private-tool');
  assert.equal(item.sourceUrl, 'https://github.com/example/private-tool');
  assert.equal(item.publicUrl, null);
  assert.equal(item.ageRating, null);
  assert.equal(item.purpose, '说明');
}));

test('已登记实际slug取得真实公开详情，manifest仍是能力事实来源', () => fixture(root => {
  const owner = path.join(root, 'dsh-magpie-plugin');
  fs.mkdirSync(owner);
  fs.writeFileSync(path.join(owner, 'package.json'), JSON.stringify({ name: 'dsh-magpie-plugin', dshMobileExtensions: true }));
  packageAt(owner, 'extensions/magpie', { capabilities: ['host.data'] });
  const [item] = catalog.listThirdParty(root);
  assert.equal(item.publicUrl, 'https://ai-hub.wnluo.com/extensions/dsh-magpie-plugin.magpie/');
  assert.equal(item.ageRating, null);
  assert.deepEqual(item.capabilities, ['host.data']);
}));

test('宿主插件市场保留用途年龄及公开详情', () => {
  const item = plugins.normalizeItem({ name: 'test', owner: 'example', url: 'https://github.com/example/test', ...declared }, 'registry');
  assert.equal(item.purpose, declared.purpose);
  assert.deepEqual(item.ageRating, declared.ageRating);
  assert.equal(item.publicUrl, declared.publicUrl);
});

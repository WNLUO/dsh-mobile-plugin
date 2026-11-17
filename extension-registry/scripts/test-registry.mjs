#!/usr/bin/env node
/**
 * 清单仓库守卫：投稿条目的形状、build 产物一致性、扫描判据。纯本地，不联网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entriesDir = path.join(ROOT, 'entries');
const indexFile = path.join(ROOT, 'index.json');

function readEntries() {
  return fs.readdirSync(entriesDir).filter((f) => f.endsWith('.json')).sort().map((f) => ({
    file: f,
    value: JSON.parse(fs.readFileSync(path.join(entriesDir, f), 'utf8')),
  }));
}

test('投稿条目字段齐全、owner 与 repo 对得上', () => {
  const files = readEntries();
  assert.ok(files.length > 0, '清单至少有一条');
  for (const { file, value } of files) {
    assert.match(file, /^[A-Za-z0-9._-]+__[A-Za-z0-9._-]+\.json$/, `${file} 命名不符`);
    assert.ok(typeof value.name === 'string' && value.name.trim(), `${file} 缺 name`);
    const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/?$/.exec(value.repo || '');
    assert.ok(match, `${file} repo 不是 GitHub 地址`);
    if (value.owner) assert.equal(value.owner.toLowerCase(), match[1].toLowerCase(), `${file} owner 与 repo 不符`);
    assert.ok(value.description && typeof value.description === 'object', `${file} 缺 description`);
    assert.ok([value.description.en, value.description.zh].some((s) => typeof s === 'string' && s.trim()), `${file} 描述至少要有一门语言`);
  }
});

test('index.json 是合法 format-1，条目数与 entries 一致', () => {
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  assert.ok(index.title && typeof index.title === 'string');
  assert.ok(index.categories && typeof index.categories === 'object' && !Array.isArray(index.categories));
  assert.ok(Array.isArray(index.plugins));
  assert.equal(index.plugins.length, readEntries().length);
  const seen = new Set();
  for (const plugin of index.plugins) {
    assert.ok(plugin.name && plugin.url && plugin.repository && plugin.repository.url);
    assert.ok(plugin.description && Object.keys(plugin.description).length);
    const key = `${plugin.owner}/${plugin.name}`.toLowerCase();
    assert.ok(!seen.has(key), `索引里有重名条目 ${key}`);
    seen.add(key);
  }
});

test('build --check 能验证当前 index.json 与 entries 一致', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('首条收录的是 magpie，显示名与 npm 安装目标都在', () => {
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const magpie = index.plugins.find((p) => p.npm === 'dsh-magpie-plugin');
  assert.ok(magpie, 'magpie 应在清单里');
  assert.equal(magpie.name, 'Magpie', '显示名用 title，不是包名');
  assert.equal(magpie.npm, 'dsh-magpie-plugin', '安装目标是 npm 包');
  assert.equal(magpie.repository.url, 'https://github.com/WNLUO/dsh-magpie-plugin');
});

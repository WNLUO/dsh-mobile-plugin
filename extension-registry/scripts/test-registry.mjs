#!/usr/bin/env node
/**
 * 清单仓库守卫：投稿规范（名称=npm 包名、11 门语言、图标可选）、build 产物一致性、变异证明。
 * 纯本地，不联网。需求变更 2026-11-18：从"至少一门语言"收紧为"必须齐 11 门"。
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
const buildScript = path.join(ROOT, 'scripts', 'build.mjs');
const LANGUAGES = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko', 'de', 'es', 'fr', 'pt', 'ru', 'tr'];

function readEntries() {
  return fs.readdirSync(entriesDir).filter((f) => f.endsWith('.json')).sort().map((f) => ({
    file: f,
    value: JSON.parse(fs.readFileSync(path.join(entriesDir, f), 'utf8')),
  }));
}

/** 用一份改造过的条目跑 build，返回 { status, stderr }；不碰真实 entries 目录。 */
function buildWith(entries) {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'reg-guard-'));
  try {
    fs.mkdirSync(path.join(tmp, 'entries'));
    fs.mkdirSync(path.join(tmp, 'scripts'));
    for (const [name, value] of Object.entries(entries)) {
      fs.writeFileSync(path.join(tmp, 'entries', name), JSON.stringify(value));
    }
    fs.copyFileSync(buildScript, path.join(tmp, 'scripts', 'build.mjs'));
    return spawnSync(process.execPath, [path.join(tmp, 'scripts', 'build.mjs')], { encoding: 'utf8' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const sample = () => ({
  name: 'dsh-sample-plugin',
  repo: 'https://github.com/owner/dsh-sample-plugin',
  owner: 'owner',
  title: Object.fromEntries(LANGUAGES.map((l) => [l, 'Sample'])),
  description: Object.fromEntries(LANGUAGES.map((l) => [l, 'A sample plugin.'])),
  category: 'tools',
  npm: 'dsh-sample-plugin',
  added: '2026-11-18',
});

test('投稿条目字段齐全、name 是 npm 包名、owner 与 repo 对得上', () => {
  const files = readEntries();
  assert.ok(files.length > 0, '清单至少有一条');
  for (const { file, value } of files) {
    assert.match(file, /^[A-Za-z0-9._-]+__[A-Za-z0-9._-]+\.json$/, `${file} 命名不符`);
    assert.match(value.name || '', /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, `${file} 的 name 不是合法 npm 包名`);
    if (value.npm) assert.equal(value.npm, value.name, `${file} 的 npm 与 name 不一致`);
    const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/?$/.exec(value.repo || '');
    assert.ok(match, `${file} repo 不是 GitHub 地址`);
    if (value.owner) assert.equal(value.owner.toLowerCase(), match[1].toLowerCase(), `${file} owner 与 repo 不符`);
  }
});

test('title / description 齐 11 门，且语言标签与 App 完全一致', () => {
  for (const { file, value } of readEntries()) {
    for (const field of ['title', 'description']) {
      assert.deepEqual(Object.keys(value[field] || {}).sort(), [...LANGUAGES].sort(), `${file} 的 ${field} 没齐 11 门`);
      for (const lang of LANGUAGES) {
        assert.ok(typeof value[field][lang] === 'string' && value[field][lang].trim(), `${file} 的 ${field}.${lang} 空`);
      }
    }
  }
});

test('index.json 形状对、条目数一致、每条都带 11 门语言', () => {
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  assert.ok(index.title && typeof index.title === 'string');
  assert.deepEqual(index.languages, LANGUAGES);
  assert.ok(Array.isArray(index.plugins));
  assert.equal(index.plugins.length, readEntries().length);
  const seen = new Set();
  for (const plugin of index.plugins) {
    assert.match(plugin.name, /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, '索引 name 必须是包名');
    assert.equal(plugin.npm, plugin.name, '索引 npm 与 name 一致');
    assert.deepEqual(Object.keys(plugin.title).sort(), [...LANGUAGES].sort());
    assert.deepEqual(Object.keys(plugin.description).sort(), [...LANGUAGES].sort());
    const key = `${plugin.owner}/${plugin.name}`.toLowerCase();
    assert.ok(!seen.has(key), `索引里有重名条目 ${key}`);
    seen.add(key);
  }
});

test('build --check 能验证当前 index.json 与 entries 一致', () => {
  const r = spawnSync(process.execPath, [buildScript, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('变异：缺一门语言、name 非包名、npm 与 name 打架，build 都挡下', () => {
  const missingLang = sample();
  delete missingLang.description.tr;
  assert.notEqual(buildWith({ 'a.json': missingLang }).status, 0, '缺 tr 应挡下');

  const wrongTag = sample();
  wrongTag.title['zh-TW'] = wrongTag.title['zh-Hant'];
  delete wrongTag.title['zh-Hant'];
  assert.notEqual(buildWith({ 'a.json': wrongTag }).status, 0, '语言标签写 zh-TW 应挡下');

  const badName = sample();
  badName.name = 'Not A Package';
  badName.npm = 'Not A Package';
  assert.notEqual(buildWith({ 'a.json': badName }).status, 0, 'name 非包名应挡下');

  const clash = sample();
  clash.npm = 'dsh-other-plugin';
  assert.notEqual(buildWith({ 'a.json': clash }).status, 0, 'npm 与 name 不一致应挡下');
});

test('首条收录的是 magpie：包名、11 门语言、可用图标地址、npm 安装目标', () => {
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const magpie = index.plugins.find((p) => p.name === 'dsh-magpie-plugin');
  assert.ok(magpie, 'magpie 应在清单里');
  assert.equal(magpie.npm, 'dsh-magpie-plugin');
  assert.equal(magpie.title['zh-Hans'], 'Magpie');
  assert.ok(magpie.description['ja'] && magpie.description['tr'], '机翻语言要在');
  assert.match(magpie.icon, /^https:\/\/raw\.githubusercontent\.com\/WNLUO\/dsh-magpie-plugin\/master\//, '图标用 master 分支的可用地址');
  assert.equal(magpie.repository.url, 'https://github.com/WNLUO/dsh-magpie-plugin');
});

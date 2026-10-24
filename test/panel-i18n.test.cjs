'use strict';

/**
 * 面板多语言的守卫：字典对称性 + 「界面不再直接写中文」。
 *
 * 面板（`React/src`）与手机 App 是两套构建，各有各的字典，但**规矩一样**：
 *   · `zh-Hans` 是键集真源，其余四门逐键对齐，多一个少一个都算错；
 *   · 每条文案里的 `{占位符}` 集合必须与源语言一致 —— 漏一个占位符不会报错，
 *     只会在界面上少一块字；
 *   · 不许有空串（空串等于静默丢文案）；
 *   · 同一个键不许落在两个领域文件里（那会让「这页的文案跑到那页去」）。
 *
 * 另外钉一条「不留硬编码中文」：组件里再冒出中文，海外用户就会在那一处看到中文。
 * 只查**字符串字面量**，不查注释 —— 这个仓库的注释全是中文，查了就是一片红。
 *
 * 为什么这条守卫值得存在：面板的字典是 2026-10-11 删过一次、2026-10-24 整页重建的。
 * 重建之后最容易发生的退化是「新加一行文案时直接写中文」，而它不会有任何报错。
 */

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const SRC = path.join(__dirname, '..', 'React', 'src');
const I18N = path.join(SRC, 'lib', 'i18n');
const MESSAGES = path.join(I18N, 'messages');

const LANGUAGES = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko'];

/** 读一个领域文件，返回 `{ 键: { 语言: 文案 } }`。 */
function loadDomain(file) {
  const text = fs.readFileSync(path.join(MESSAGES, file), 'utf8');
  // 不引 TS 运行时：用正则把「语言块 → 键值对」抽出来，够这条守卫用。
  const out = {};
  const blocks = [...text.matchAll(/^  (?:'([\w-]+)'|(\w+)): \{\n([\s\S]*?)^  \},$/gm)];
  for (const block of blocks) {
    const language = block[1] || block[2];
    if (!LANGUAGES.includes(language)) continue;
    for (const line of block[3].matchAll(/^\s+'([\w.]+)': '((?:[^'\\]|\\.)*)',$/gm)) {
      const key = line[1];
      out[key] = out[key] || {};
      out[key][language] = line[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    }
  }
  return out;
}

const DOMAIN_FILES = fs
  .readdirSync(MESSAGES)
  .filter((name) => name.endsWith('.ts') && name !== 'shell.ts')
  .sort();

/** 所有领域文件合起来：键 → 语言 → 文案。 */
const ALL = {};
const OWNER = {};
for (const file of DOMAIN_FILES) {
  for (const [key, byLang] of Object.entries(loadDomain(file))) {
    ALL[key] = byLang;
    OWNER[key] = OWNER[key] || [];
    OWNER[key].push(file);
  }
}

/** 一条文案里的占位符集合。 */
function placeholders(text) {
  return [...new Set([...String(text || '').matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]))].sort();
}

test('字典里至少有一批键（守卫本身没读空）', () => {
  assert.ok(Object.keys(ALL).length > 100, `只读到 ${Object.keys(ALL).length} 个键，抽取逻辑可能坏了`);
});

test('每门语言都有全部键，且没有空串', () => {
  for (const language of LANGUAGES) {
    const missing = [];
    const empty = [];
    for (const [key, byLang] of Object.entries(ALL)) {
      const value = byLang[language];
      if (value === undefined) missing.push(key);
      else if (value.length === 0) empty.push(key);
    }
    assert.deepEqual(missing, [], `${language} 缺这些键`);
    assert.deepEqual(empty, [], `${language} 这些键是空串`);
  }
});

test('占位符集合与源语言一致', () => {
  const mismatched = [];
  for (const [key, byLang] of Object.entries(ALL)) {
    const want = placeholders(byLang['zh-Hans']).join(',');
    for (const language of LANGUAGES) {
      if (placeholders(byLang[language]).join(',') !== want) {
        mismatched.push(`${key}[${language}: ${placeholders(byLang[language]).join(' ')} vs ${want}]`);
      }
    }
  }
  assert.deepEqual(mismatched.slice(0, 20), [], '占位符对不上（漏一个就是运行期少一块字）');
});

test('同一个键不许落在两个领域文件里', () => {
  const dupes = Object.entries(OWNER).filter(([, files]) => files.length > 1);
  assert.deepEqual(dupes.map(([key, files]) => `${key}: ${files.join(' + ')}`), []);
});

test('键名带 panel. 前缀（与 App 的 key 不会撞）', () => {
  const stray = Object.keys(ALL).filter((key) => !key.startsWith('panel.'));
  assert.deepEqual(stray.slice(0, 20), []);
});

/** 组件与 lib 里的源码（排除字典自身）。 */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'i18n' || entry.name === 'demo') continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(SRC);
  return out;
}

test('已经接过字典的文件里不许再写中文文案（注释不算）', () => {
  // 判据是「这个文件已经 import 了取词出口」：那种文件一旦又冒出中文字面量，
  // 就是「同一页里一半跟着语言走、一半钉死中文」—— 这是最难发现的一种退化。
  //
  // 还没接字典的文件不在这里判：面板是**整页分批搬**的，新加的文件可能属于
  // 另一条在途工作（本仓有多个对话并行改同一个工作区）。它们列在下面那份
  // 未迁移清单里，谁接手谁搬，别让这条守卫替别人拍板。
  const migrated = [];
  const notYet = [];
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('lib/i18n/index.ts')) continue;
    migrated.push(file);
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    for (const match of stripped.matchAll(/(['"])((?:[^'"\\\n]|\\.)*?)\1/g)) {
      if (/[\u4e00-\u9fff]/.test(match[2])) {
        notYet.push(`${path.relative(SRC, file)}: ${match[2].slice(0, 40)}`);
      }
    }
  }
  assert.ok(migrated.length > 8, `只有 ${migrated.length} 个文件接了字典`);
  assert.deepEqual(notYet.slice(0, 20), [], '这些已接字典的文件还在直接写中文，那一处会永远是中文');
});

test('未接字典的文件登记在册（新加的界面文案要有人接手）', () => {
  // 只报不判：列出还没 import 取词出口的界面文件。清单是给人看的，
  // 用来确认「新加的那一屏有没有人负责翻」。
  const pending = sourceFiles()
    .filter((file) => !fs.readFileSync(file, 'utf8').includes('lib/i18n/index.ts'))
    .map((file) => path.relative(SRC, file))
    .sort();
  if (pending.length > 0) {
    console.log(`  还没接字典的界面文件（${pending.length}）：${pending.join(', ')}`);
  }
  assert.ok(Array.isArray(pending));
});

test('组件里取词走统一的出口', () => {
  const files = sourceFiles();
  const usingT = files.filter((file) => fs.readFileSync(file, 'utf8').includes("from '../lib/i18n/index.ts'")
    || fs.readFileSync(file, 'utf8').includes("from './i18n/index.ts'"));
  assert.ok(usingT.length > 8, `只有 ${usingT.length} 个文件接了字典，看起来没接完`);
});

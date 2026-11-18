#!/usr/bin/env node
/**
 * 把 entries/*.json 合成一份清单索引（index.json），给宿主按目录源读。
 *
 * 投稿硬规范（2026-11-18 定，缺一不合成、PR 挡下）：
 *  1. name 就是这个 DSH 插件的 npm 包名（合法 npm 名）；填了 npm 字段必须与 name 一致；
 *  2. title / description 必须齐 App 支持的全部 11 门语言，用户用哪种语言就显示哪种；
 *     语言标签与 App 的 AppLanguage 一字不差（zh-Hans 不是 zh、zh-Hant 不是 zh-TW）。
 *  3. icon 可选：填合法的 https 图片地址，不填显示名字首字母；repo/owner 对得上。
 *
 * 输出成社区「主源」形状：name 是包名、title 是双语显示名、npm 是安装目标，宿主按主源分支收窄。
 * 纯文件操作，不联网。--check 时只比对现有 index.json 与合成结果是否一致（CI 用）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRIES_DIR = path.join(ROOT, 'entries');
const INDEX_FILE = path.join(ROOT, 'index.json');

const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** 与 App 的 AppLanguage 完全一致；多一门少一门都不行。 */
const LANGUAGES = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko', 'de', 'es', 'fr', 'pt', 'ru', 'tr'];
const CATEGORIES = {
  tools: { en: 'Tools', zh: '工具' },
  office: { en: 'Office', zh: '办公' },
  life: { en: 'Life', zh: '生活' },
  fun: { en: 'Fun', zh: '趣味' },
  dev: { en: 'Development', zh: '开发' },
};

function text(value, max = 400) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

/** 收一门多语言表，缺任何一门都抛错；顺带拒绝多出来的语言标签（拼错 zh-TW 之类）。 */
function requiredLocalized(value, field, file) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${file} 的 ${field} 必须是 {语言: 文本} 表`);
  }
  const out = {};
  for (const lang of LANGUAGES) {
    const clean = text(value[lang], 600);
    if (!clean) throw new Error(`${file} 的 ${field} 缺 ${lang}（11 门语言必须齐全，可用机器翻译）`);
    out[lang] = clean;
  }
  for (const key of Object.keys(value)) {
    if (!LANGUAGES.includes(key)) throw new Error(`${file} 的 ${field} 有多余语言 ${key}（只认 App 的 11 门，注意 zh-Hans / zh-Hant）`);
  }
  return out;
}

function normalize(entry, file) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${file} 不是对象`);
  const name = text(entry.name, 214);
  if (!name || !NPM_NAME.test(name)) {
    throw new Error(`${file} 的 name 必须是合法 npm 包名（形如 dsh-xxx 或 @scope/xxx）`);
  }
  const match = GITHUB_REPO.exec(text(entry.repo, 300) || '');
  if (!match) throw new Error(`${file} 缺合法的 GitHub 仓库地址`);
  const owner = match[1];
  const repo = match[2];
  const declaredOwner = text(entry.owner, 100);
  if (declaredOwner && declaredOwner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`${file} 的 owner 与 repo 不符`);
  }
  const npm = text(entry.npm, 214);
  if (npm && npm !== name) throw new Error(`${file} 的 npm（${npm}）与 name（${name}）不一致，只留一个或写同一个`);
  const version = text(entry.version, 64);
  const title = requiredLocalized(entry.title, 'title', file);
  const description = requiredLocalized(entry.description, 'description', file);
  const icon = text(entry.icon, 1000);
  if (icon && !/^https:\/\//i.test(icon)) throw new Error(`${file} 的 icon 必须是 https 地址`);
  return {
    name,
    url: `https://github.com/${owner}/${repo}`,
    repository: { url: `https://github.com/${owner}/${repo}` },
    owner,
    title,
    description,
    npm: name,
    category: text(entry.category, 64) || 'other',
    stars: Number.isSafeInteger(entry.stars) && entry.stars >= 0 ? entry.stars : 0,
    downloads: Number.isSafeInteger(entry.downloads) && entry.downloads >= 0 ? entry.downloads : null,
    icon: icon || null,
    screenshots: Array.isArray(entry.screenshots)
      ? entry.screenshots.filter((s) => typeof s === 'string' && /^https:\/\//i.test(s)).slice(0, 4)
      : [],
    capabilities: Array.isArray(entry.capabilities)
      ? entry.capabilities.filter((c) => typeof c === 'string' && c.trim()).slice(0, 12)
      : [],
    added: typeof entry.added === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.added) ? entry.added : null,
    version,
  };
}

function build() {
  const files = fs.readdirSync(ENTRIES_DIR).filter((f) => f.endsWith('.json')).sort();
  const plugins = [];
  const used = new Set();
  const categories = {};
  for (const file of files) {
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(ENTRIES_DIR, file), 'utf8'));
    } catch (error) {
      throw new Error(`${file} 不是合法 JSON：${error.message}`);
    }
    const item = normalize(entry, file);
    const key = `${item.owner}/${item.name}`.toLowerCase();
    if (used.has(key)) throw new Error(`${file} 与已有条目重名：${key}`);
    used.add(key);
    plugins.push(item);
    if (!categories[item.category]) {
      categories[item.category] = CATEGORIES[item.category] || { en: item.category };
    }
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name));
  return {
    title: 'DSH Mobile Extension Market',
    categories,
    languages: LANGUAGES,
    plugins,
  };
}

let index;
try {
  index = build();
} catch (error) {
  console.error(`✖ 清单校验失败：${error.message}`);
  process.exit(1);
}
const output = `${JSON.stringify(index, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const existing = fs.existsSync(INDEX_FILE) ? fs.readFileSync(INDEX_FILE, 'utf8') : '';
  if (existing !== output) {
    console.error('✖ index.json 与 entries/ 不一致，请跑 node scripts/build.mjs 重新生成');
    process.exit(1);
  }
  console.log(`✔ index.json 与 ${index.plugins.length} 条 entries 一致`);
} else {
  fs.writeFileSync(INDEX_FILE, output);
  console.log(`✔ 已生成 index.json（${index.plugins.length} 条，${LANGUAGES.length} 门语言）`);
}

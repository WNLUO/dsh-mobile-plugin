#!/usr/bin/env node
/**
 * 把 entries/*.json 合成一份 DSH format-1 索引（index.json），给宿主按目录源读。
 *
 * 判据跟宿主 plugin-catalog.js 的 normalizeItem 对齐：条目要有合法名字、GitHub 仓库、
 * 合法 npm 名或可退回的 github: 安装目标；脏条目整条丢，不在索引里留。
 * 分类表从条目的 category 收集，缺文案时退回 id。
 *
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

function localized(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [lang, line] of Object.entries(value)) {
    const clean = text(line, 600);
    if (clean) out[lang] = clean;
  }
  return Object.keys(out).length ? out : null;
}

function normalize(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const name = text(entry.name, 200);
  const match = GITHUB_REPO.exec(text(entry.repo, 300) || '');
  if (!name || !match) return null;
  const owner = match[1];
  const repo = match[2];
  const declaredOwner = text(entry.owner, 100);
  if (declaredOwner && declaredOwner.toLowerCase() !== owner.toLowerCase()) return null;
  const npm = text(entry.npm, 214);
  const npmValid = npm && NPM_NAME.test(npm) ? npm : null;
  const version = text(entry.version, 64);
  const description = localized(entry.description);
  if (!description) return null;
  const title = localized(entry.title) || { en: name };
  // 输出成社区「主源」那种形状（name 是显示名、npm 是安装包名），宿主按主源分支收窄，
  // 安装目标由它从 npm 名或 github: 算好。这样跟清单 id 叫什么无关，不会踩 format-1
  // 那条「name 即包名」的镜像约定。
  return {
    name: title.en || name,
    url: `https://github.com/${owner}/${repo}`,
    repository: { url: `https://github.com/${owner}/${repo}` },
    owner,
    title,
    description,
    npm: npmValid,
    category: text(entry.category, 64) || 'other',
    stars: Number.isSafeInteger(entry.stars) && entry.stars >= 0 ? entry.stars : 0,
    downloads: Number.isSafeInteger(entry.downloads) && entry.downloads >= 0 ? entry.downloads : null,
    icon: text(entry.icon, 1000) && /^https:\/\//i.test(entry.icon) ? entry.icon : null,
    screenshots: Array.isArray(entry.screenshots)
      ? entry.screenshots.filter((s) => typeof s === 'string' && /^https:\/\//i.test(s)).slice(0, 4)
      : [],
    capabilities: Array.isArray(entry.capabilities)
      ? entry.capabilities.filter((c) => typeof c === 'string' && c.trim()).slice(0, 12)
      : [],
    added: typeof entry.added === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.added) ? entry.added : null,
    // installSpec 由宿主算好；这里只给源信息，宿主按 npm 名或 github: 目标二选一。
    installTarget: npmValid || `github:${owner}/${repo}`,
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
    const item = normalize(entry);
    if (!item) throw new Error(`${file} 缺名字 / 仓库 / 说明，或与 owner 打架`);
    const key = `${item.owner}/${item.name}`.toLowerCase();
    if (used.has(key)) throw new Error(`${file} 与已有条目重名：${key}`);
    used.add(key);
    plugins.push(item);
    if (!categories[item.category]) {
      categories[item.category] = CATEGORIES[item.category] || { en: item.category };
    }
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name));
  // 主源形状（与社区 plugins.json 同构）：categories 是 { id: {en,zh} }，宿主按 plugins 分支收窄。
  return {
    title: 'DSH Mobile Extension Market',
    categories,
    plugins,
  };
}

const index = build();
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
  console.log(`✔ 已生成 index.json（${index.plugins.length} 条）`);
}

#!/usr/bin/env node
/**
 * 自动扫描：核对每个投稿条目指向的仓库还活着、是真 DSH 插件、包内声明了手机扩展。
 *
 * 照 dsh-market / awesome 那套「CI 定时扫描，失效的提 issue 等确认」的轻量版：
 *  - 查 GitHub API 的仓库元数据（存在、没归档）与 package.json（root 或 packages/* 子包）；
 *  - 认 dsh.bundle 或 dshMobileExtensions 声明：没有就不是我们要收的「带手机扩展的 DSH 插件」；
 *  - 不自动删条目、不自动改 index.json —— 只报告，维护者确认后再动手。
 *
 * 需要网络与 GitHub token（CI 里用 secrets.GITHUB_TOKEN）；没 token 也能跑公开仓库，只是有频率限制。
 * --json 时把结果打到标准输出，给 workflow 生成报告用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRIES_DIR = path.join(ROOT, 'entries');

function repoOf(entry) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(entry?.repo || '');
  return match ? { owner: match[1], repo: match[2] } : null;
}

async function gh(url, token) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-extension-registry-scan' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** 在 package.json（根 / packages/* / plugins/*）里找 dsh.bundle 或 dshMobileExtensions 声明。 */
function declaresMobileExtension(manifests) {
  for (const pkg of manifests) {
    if (!pkg || typeof pkg !== 'object') continue;
    if (pkg.dsh?.bundle || pkg.dshMobileExtensions) return true;
  }
  return false;
}

async function scanEntry(entry, token) {
  const repo = repoOf(entry);
  if (!repo) return { name: entry?.name || '?', ok: false, reason: '仓库地址不合法' };
  const base = `https://api.github.com/repos/${repo.owner}/${repo.repo}`;
  try {
    const meta = await gh(base, token);
    if (meta.archived) return { name: entry.name, ok: false, reason: '仓库已归档' };
    if (meta.disabled) return { name: entry.name, ok: false, reason: '仓库已禁用' };
    let contents;
    try {
      contents = await gh(`${base}/contents/package.json`, token);
    } catch (error) {
      if (error.status !== 404) throw error;
      // 根包没有就试常见子包目录，覆盖 monorepo 投稿。
      const folders = ['packages', 'plugins'];
      const manifests = [];
      for (const folder of folders) {
        let list;
        try {
          list = await gh(`${base}/contents/${folder}`, token);
        } catch (sub) {
          if (sub.status === 404) continue;
          throw sub;
        }
        for (const dir of list.filter((x) => x.type === 'dir')) {
          try {
            const raw = await gh(`${base}/contents/${folder}/${dir.name}/package.json`, token);
            if (raw.content) {
              manifests.push(JSON.parse(Buffer.from(raw.content, 'base64').toString('utf8')));
            }
          } catch (sub) {
            if (sub.status !== 404) throw sub;
          }
        }
      }
      if (!manifests.length) {
        return { name: entry.name, ok: false, reason: '仓库里没有 package.json' };
      }
      return declaresMobileExtension(manifests)
        ? { name: entry.name, ok: true }
        : { name: entry.name, ok: false, reason: '包里没有 dsh.bundle / dshMobileExtensions 声明' };
    }
    if (!contents.content) return { name: entry.name, ok: false, reason: 'package.json 读不到内容' };
    const pkg = JSON.parse(Buffer.from(contents.content, 'base64').toString('utf8'));
    return declaresMobileExtension([pkg])
      ? { name: entry.name, ok: true }
      : { name: entry.name, ok: false, reason: '包里没有 dsh.bundle / dshMobileExtensions 声明' };
  } catch (error) {
    return { name: entry.name, ok: false, reason: `拉取失败：${error.message}` };
  }
}

async function main() {
  const files = fs.readdirSync(ENTRIES_DIR).filter((f) => f.endsWith('.json')).sort();
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const results = [];
  for (const file of files) {
    const entry = JSON.parse(fs.readFileSync(path.join(ENTRIES_DIR, file), 'utf8'));
    const result = await scanEntry(entry, token);
    results.push({ file, ...result });
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const row of results) {
      console.log(`${row.ok ? '✔' : '✖'} ${row.name}${row.ok ? '' : ` — ${row.reason}`}`);
    }
  }
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`扫描失败：${error.message}`);
  process.exit(1);
});

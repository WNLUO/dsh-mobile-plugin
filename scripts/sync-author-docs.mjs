#!/usr/bin/env node
/**
 * 作者文档与样例的同步。
 *
 * 唯一来源是独立仓库 `dsh-mobile-extensions` 的 `docs/`：`extension-authoring.md` 与
 * `extension-sample/`。插件包随 npm 发出去时要带上这两份（写扩展的人只装这个包、不翻
 * 维护者的仓库），所以发版前把它们从那个仓库同步进本包的 `docs/`、跟着提交。
 *
 *   node scripts/sync-author-docs.mjs            把来源拷进本包 docs/
 *   node scripts/sync-author-docs.mjs --check    只比对，不一致退出 1（发版预检用）
 *   node scripts/sync-author-docs.mjs --require-source
 *                                               --check 模式下来源不在也判红（默认跳过）
 *
 * 来源目录：`$DSH_EXTENSIONS_DOCS`（仓库根或它的 docs/ 都行），否则试同级的
 * `dsh-mobile-extensions` 检出。同步方向只有一个：来源 → 本包，别反向手改。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');
const DEST_DOCS = path.join(PLUGIN, 'docs');

/** 同步的内容：一个文件加一个目录。别的地方的 docs 文件不受影响。 */
const ITEMS = ['extension-authoring.md', 'extension-sample'];

const args = new Set(process.argv.slice(2));
const MODE_CHECK = args.has('--check');
const REQUIRE_SOURCE = args.has('--require-source');

function log(text) {
  process.stdout.write(`${text}\n`);
}

/** 来源仓库根：env 优先，否则同级检出。都没有就回 null。 */
function resolveSourceRoot() {
  const fromEnv = process.env.DSH_EXTENSIONS_DOCS;
  const candidates = [];
  if (fromEnv) candidates.push(fromEnv);
  candidates.push(path.resolve(PLUGIN, '../../dsh-mobile-extensions'));
  for (const candidate of candidates) {
    const docsDir = path.join(candidate, 'docs');
    if (fs.existsSync(docsDir)) return docsDir;
    // env 直接指到 docs/ 也认。
    if (fs.existsSync(path.join(candidate, 'extension-authoring.md'))) return candidate;
  }
  return null;
}

function walk(rel) {
  const abs = path.join(DEST_DOCS, rel);
  if (!fs.existsSync(abs)) return [];
  const stat = fs.statSync(abs);
  if (stat.isFile()) return [rel];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    out.push(...walk(path.join(rel, entry.name)));
  }
  out.sort();
  return out;
}

function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 比较来源 docs 与本包 docs 在这几项上是否一致。返回差异描述数组。 */
function diffAgainstSource(srcDocs) {
  const diffs = [];
  for (const item of ITEMS) {
    const srcAbs = path.join(srcDocs, item);
    if (!fs.existsSync(srcAbs)) {
      diffs.push(`来源里缺 ${item}`);
      continue;
    }
    const srcFiles = listFiles(srcAbs).map((abs) => path.relative(srcDocs, abs));
    const destFiles = listFiles(path.join(DEST_DOCS, item)).map((abs) =>
      path.relative(DEST_DOCS, abs));
    const srcSet = new Set(srcFiles);
    const destSet = new Set(destFiles);
    for (const file of srcFiles) {
      if (!destSet.has(file)) {
        diffs.push(`本包缺 ${file}`);
      } else if (digest(path.join(srcDocs, file)) !== digest(path.join(DEST_DOCS, file))) {
        diffs.push(`内容不一致 ${file}`);
      }
    }
    for (const file of destFiles) {
      if (!srcSet.has(file)) diffs.push(`本包多出 ${file}（来源里已没有）`);
    }
  }
  return diffs;
}

function listFiles(abs) {
  if (!fs.existsSync(abs)) return [];
  const stat = fs.statSync(abs);
  if (stat.isFile()) return [abs];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    out.push(...listFiles(path.join(abs, entry.name)));
  }
  out.sort();
  return out;
}

function copyFromSource(srcDocs) {
  const changed = [];
  for (const item of ITEMS) {
    const srcAbs = path.join(srcDocs, item);
    const destAbs = path.join(DEST_DOCS, item);
    if (!fs.existsSync(srcAbs)) {
      throw new Error(`来源里缺 ${item}：${srcAbs}`);
    }
    if (fs.statSync(srcAbs).isDirectory()) {
      // 整个目录镜像：先删掉本包那份，避免来源删了文件这边还留着。
      fs.rmSync(destAbs, { recursive: true, force: true });
      fs.cpSync(srcAbs, destAbs, { recursive: true });
    } else {
      fs.mkdirSync(DEST_DOCS, { recursive: true });
      fs.copyFileSync(srcAbs, destAbs);
    }
    changed.push(item);
  }
  return changed;
}

const srcDocs = resolveSourceRoot();

if (MODE_CHECK) {
  if (!srcDocs) {
    if (REQUIRE_SOURCE) {
      log('✘ 找不到 dsh-mobile-extensions 来源，且要求必须有（--require-source）');
      process.exit(1);
    }
    log('· 跳过：本机没有 dsh-mobile-extensions 检出，无法比对（设 DSH_EXTENSIONS_DOCS 可指定）');
    process.exit(0);
  }
  const diffs = diffAgainstSource(srcDocs);
  if (diffs.length) {
    log(`✘ 作者文档/样例与本仓库对不上（共 ${diffs.length} 处）：`);
    for (const diff of diffs.slice(0, 12)) log(`    ${diff}`);
    log('  跑 node scripts/sync-author-docs.mjs 同步，再把改动一起提交。');
    process.exit(1);
  }
  log('✔ 作者文档/样例与来源仓库一致');
  process.exit(0);
}

if (!srcDocs) {
  log('✘ 找不到 dsh-mobile-extensions 来源：设 DSH_EXTENSIONS_DOCS 指向它，或放到同级检出');
  process.exit(1);
}
const changed = copyFromSource(srcDocs);
log(`✔ 已从 ${srcDocs} 同步：${changed.join('、')}`);

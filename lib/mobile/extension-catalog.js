'use strict';

/**
 * 已审核扩展清单：随 dsh-mobile-plugin 的 npm 包一起发布的第三方扩展（包内 `extensions/`）。
 *
 * 与开发包那条路的分界：开发包读作者电脑上的 `$DSH_HOME/extension-dev`（边写边看），这条读
 * 插件包自带的只读目录 —— 只有审过、登记进 `extensions/catalog.json` 的包才下发，目录里有但
 * 没登记的一律当不存在。审核闸门在清单，不在目录。
 *
 * 能力面只多「读这一个固定目录」：根由 `__dirname` 定位，不依赖进程 cwd，也不建目录；每个
 * 文件的 size 与 sha256 由宿主扫目录现算，不信清单里写的数字。取文件先挡绝对路径与 `..` 段，
 * 再 resolve 之后判前缀（带分隔符），不接受任意路径。仍然不暴露 shell、系统设置、任意文件读写。
 *
 * 坏包一律静默跳过：没登记、目录不在、manifest 读不出、超限（20MB / 200 个文件）都不该让整张
 * 列表变红；catalog.json 不在或坏了就是一份空清单，不抛。取文件那条才逐个回错误码。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { sendJson } = require('../shared/http-util');

/** 审核清单文件名。只有列进来的 slug 才下发。 */
const CATALOG_FILE = 'catalog.json';
/** slug 直接当包目录名，所以只认这套字符；别的名字连读都不读。 */
const SLUG_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** 整包上限：与开发包同一档，太重的包手机也不该整份拉。 */
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const MAX_PACKAGE_FILES = 200;
/** 单个文件上限：一条 base64 响应要塞进手机内存，再大就不该走这条路。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** 包内固定目录：从 lib/mobile/ 往上两级就是包根。不依赖 cwd、不建目录（随 npm 包发布）。 */
function catalogRoot() {
  return path.join(__dirname, '..', '..', 'extensions');
}

/** 400 信封：与其余移动端接口同形，App 按 code 翻人话。 */
function fail(res, status, code, message) {
  return sendJson(res, status, { ok: false, error: { code, message } });
}

/** manifest 里取一个非空字符串，缺了 / 类型不对 / 空串都退回默认值。 */
function textField(value, fallback) {
  return typeof value === 'string' && value ? value : fallback;
}

/** 清单里的可选文案：非空字符串才收，其余一律 null。 */
function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** 能力声明收窄成字符串数组：表外的类型与空串丢掉，重复的不给第二份。 */
function capabilitiesOf(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function sha256Hex(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * 读审核清单。文件不在、读坏、形状不对都当空清单 —— 空的插件包本来就没有第三方扩展。
 * 只收 slug / description / author / releaseNotes 四样，其余字段（包括任何 size / sha256）
 * 一概不认：清单只负责「谁审过了」，文件事实由扫目录算。
 */
function readCatalog(root) {
  let text;
  try { text = fs.readFileSync(path.join(root, CATALOG_FILE), 'utf8'); } catch { return []; }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.packages)) return [];
  const rows = [];
  const seen = new Set();
  for (const raw of parsed.packages) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const slug = typeof raw.slug === 'string' ? raw.slug.trim() : '';
    if (!SLUG_PATTERN.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    rows.push({
      slug,
      description: textOrNull(raw.description),
      author: textOrNull(raw.author),
      releaseNotes: textOrNull(raw.releaseNotes),
    });
  }
  return rows;
}

/**
 * 递归收集包内的普通文件，`path` 是相对包目录的 POSIX 路径。与 extension-dev.js 同一套口径：
 * 点开头的文件与目录不看，符号链接不是普通文件，超限当场收手返回 false（先收完再判等于把
 * 500MB 的目录整个哈希一遍）。
 */
function collectFiles(directory, acc) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!collectFiles(full, acc)) return false;
      continue;
    }
    if (!entry.isFile()) continue;
    let raw;
    try { raw = fs.readFileSync(full); } catch { continue; }
    acc.bytes += raw.length;
    acc.files.push({
      path: path.relative(acc.root, full).split(path.sep).join('/'),
      size: raw.length,
      sha256: sha256Hex(raw),
    });
    if (acc.bytes > MAX_PACKAGE_BYTES || acc.files.length > MAX_PACKAGE_FILES) return false;
  }
  return true;
}

/**
 * 扫审核清单，把每个登记过、且目录与 manifest 都在的包读成一份 Package。
 *
 * 入口页固定是包目录下那层 `index.html`：App 侧 `extensionEntryPath` 找的就是这个名字，
 * `manifest.json` 里写 `main` 不生效。所以这里在列包时先确认 `index.html` 真的在文件清单里，
 * 缺了就把整包跳过 —— 装到手机上再报「需要重新安装」，比根本不出现在清单里难查得多。
 *
 * 纯函数、root 由调用方给：守卫拿假目录跑，线上 handler 给包内那个固定目录。
 */
function listPackages(root) {
  const packages = [];
  for (const entry of readCatalog(root)) {
    const directory = path.join(root, entry.slug);
    let stats;
    try { stats = fs.statSync(directory); } catch { continue; }
    if (!stats.isDirectory()) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    } catch { continue; }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) continue;
    const acc = { root: directory, files: [], bytes: 0 };
    if (!collectFiles(directory, acc) || acc.files.length === 0) continue;
    if (!acc.files.some((file) => file.path === 'index.html')) continue;
    packages.push({
      slug: entry.slug,
      name: textField(manifest.name, entry.slug),
      description: entry.description,
      author: entry.author,
      versionName: textField(manifest.versionName, textField(manifest.version, '0.0.0')),
      apiVersion: textField(manifest.apiVersion, textField(manifest.api_version, '1')),
      releaseNotes: entry.releaseNotes,
      capabilities: capabilitiesOf(manifest.capabilities),
      size: acc.bytes,
      fileCount: acc.files.length,
      files: acc.files,
    });
  }
  return packages;
}

/**
 * GET /api/mobile/v1/extension/catalog（token）
 *
 * 回审核过的第三方扩展清单。`root` 只是给守卫传假目录的可选参数，线上由 route() 调用时
 * 不传，永远走包内那个固定目录。
 */
async function handleCatalog(_ctx, _req, res, root = catalogRoot()) {
  sendJson(res, 200, { ok: true, packages: listPackages(root) });
}

/**
 * GET /api/mobile/v1/extension/catalog/file?slug=…&path=…（token）
 *
 * 取一个已审核包里的一个文件，回 base64 与 sha256（与列表里那条同一份算法）。审核闸门对取文件
 * 同样生效：没登记进 catalog.json 的 slug 一律 404，免得绕过清单直接把目录里的字节读走。
 *
 * 路径检查两道：先挡明显不该出现的（绝对路径、`..` 段），再 resolve 之后判前缀 —— 后者才是
 * 判据，前缀比较必须带分隔符，否则 `/x/extensions/foobar` 会被 `/x/extensions/foo` 认成子路径。
 */
async function handleCatalogFile(_ctx, req, res, root = catalogRoot()) {
  const url = new URL(req.url || '/', 'http://x');
  const slug = (url.searchParams.get('slug') || '').trim();
  const requested = (url.searchParams.get('path') || '').trim();
  if (!slug || !requested || !SLUG_PATTERN.test(slug)) {
    return fail(res, 400, 'bad-request', '需要合法的 slug 与 path（path 是相对包目录的路径）');
  }

  if (!readCatalog(root).some((entry) => entry.slug === slug)) {
    return fail(res, 404, 'package-missing', `审核清单里没有 ${slug} 这个包`);
  }
  const directory = path.join(root, slug);
  if (!fs.existsSync(path.join(directory, 'manifest.json'))) {
    return fail(res, 404, 'package-missing', `${slug} 没有可下发的包（缺 manifest.json）`);
  }

  if (path.isAbsolute(requested) || requested.split(/[\\/]/).includes('..')) {
    return fail(res, 400, 'bad-request', 'path 必须是包目录内的相对路径');
  }
  const target = path.resolve(directory, requested);
  if (!target.startsWith(`${directory}${path.sep}`)) {
    return fail(res, 400, 'bad-request', 'path 必须是包目录内的相对路径');
  }

  let stats;
  try { stats = fs.statSync(target); } catch { stats = null; }
  if (!stats || !stats.isFile()) {
    return fail(res, 404, 'file-missing', `这个包里没有 ${requested}`);
  }
  if (stats.size > MAX_FILE_BYTES) {
    return fail(res, 413, 'file-too-large', `单个文件上限 ${MAX_FILE_BYTES} 字节，这个超了`);
  }

  let raw;
  try { raw = fs.readFileSync(target); } catch {
    return fail(res, 404, 'file-missing', `这个包里没有 ${requested}`);
  }

  const relative = path.relative(directory, target).split(path.sep).join('/');
  sendJson(res, 200, {
    ok: true,
    path: relative,
    size: raw.length,
    sha256: sha256Hex(raw),
    content: raw.toString('base64'),
  });
}

module.exports = {
  catalogRoot,
  listPackages,
  handleCatalog,
  handleCatalogFile,
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_FILES,
  MAX_FILE_BYTES,
};

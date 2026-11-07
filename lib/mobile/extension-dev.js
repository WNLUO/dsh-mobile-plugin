'use strict';

/**
 * 扩展开发包：让手机直接读作者放在电脑上的本地扩展目录（`$DSH_HOME/extension-dev`）。
 *
 * 扩展平时的产物走 App 分发系统，装到手机自己那份扩展目录里；要让作者边写边在手机上看，
 * 得有一个「从电脑现读」的入口。这个目录就是那个入口：一个子目录一个包，`manifest.json`
 * 必须在，目录名即 slug。
 *
 * 能力面只多了「读这一个固定目录」：根写死在 `dshHome()` 下面，路径由 slug 与包内相对
 * 路径拼出来，取文件前先 resolve 再判前缀 —— 不接受的是一份任意路径，不是一个被拼坏的
 * 字符串。仍然不暴露 shell、系统设置、写文件。
 *
 * 坏包一律**静默跳过**而不是报错：作者当前正在编辑的那个包大概率是半成品，它不该让整张
 * 列表变红；超限（20MB / 200 个文件）同理，不列表就是答案。取文件那条才逐个回错误码。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { sendJson } = require('../shared/http-util');
const { dshHome } = require('../shared/paths');

/** 开发包根目录名。目录不存在时按需建出来 —— 作者要往里放东西。 */
const DEV_ROOT_NAME = 'extension-dev';
/** 目录名直接当 slug 用，所以只认这套字符；别的名字连读都不读。 */
const SLUG_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** 整包上限：这是「现读现看」的通道，不是分发管道，太重的包手机也不该整份拉。 */
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
// 2026-11-08 从 200 抬到 400：整份网页前端做成的扩展（例如 magpie）光图标就一两百个、
// 按名字动态引用删不得，260 多个文件是常态；400 仍挡得住离谱的大包。
const MAX_PACKAGE_FILES = 400;
/** 单个文件上限：一条 base64 响应要塞进手机内存，再大就该走别的路（发布到分发系统）。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function devRoot() {
  return path.join(dshHome(), DEV_ROOT_NAME);
}

/** 400 信封：与其余移动端接口同形，App 按 code 翻人话。 */
function fail(res, status, code, message) {
  return sendJson(res, status, { ok: false, error: { code, message } });
}

/** manifest 里取一个非空字符串，缺了 / 类型不对 / 空串都退回默认值。 */
function textField(value, fallback) {
  return typeof value === 'string' && value ? value : fallback;
}

function sha256Hex(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * 递归收集包内的普通文件，`path` 是相对包目录的 POSIX 路径。
 *
 * 名字以 `.` 开头的文件与目录一律不看：`.git`、`.DS_Store`、编辑器临时文件都属于作者自
 * 己的现场，不是包内容。超限当场收手返回 false，让调用方把整包丢掉 —— 先收集完再判超限
 * 等于把 500MB 的目录整个哈希一遍。
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
 * 扫一遍根目录，把每个子目录读成一个包描述。坏 manifest、超限、slug 不合规都直接跳过。
 */
function listPackages(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SLUG_PATTERN.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    } catch { continue; }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) continue;
    const acc = { root: directory, files: [], bytes: 0 };
    if (!collectFiles(directory, acc)) continue;
    packages.push({
      slug: entry.name,
      name: textField(manifest.name, entry.name),
      versionName: textField(manifest.versionName, textField(manifest.version, '0.0.0')),
      apiVersion: textField(manifest.apiVersion, textField(manifest.api_version, '1')),
      size: acc.bytes,
      fileCount: acc.files.length,
      files: acc.files,
    });
  }
  return packages;
}

/**
 * GET /api/mobile/v1/extension/dev/packages（token）
 *
 * 根目录不存在就建出来再回空列表：作者第一次打开开发包页时看到的是「目录已经在这儿了」，
 * 而不是「宿主没给我建」。
 */
async function handleDevPackages(_ctx, _req, res) {
  const root = devRoot();
  try { fs.mkdirSync(root, { recursive: true }); } catch { /* 建不出来就按空列表回，读的时候自然也没有 */ }
  sendJson(res, 200, { ok: true, root, packages: listPackages(root) });
}

/**
 * GET /api/mobile/v1/extension/dev/file?slug=…&path=…（token）
 *
 * 读一个包里的一个文件，回 base64 与 sha256。sha256 与列表里那条是同一份算法，手机据此
 * 判断「这份和我列表上看到的是不是同一版」。
 *
 * 路径检查是两道：先挡明显不该出现的（绝对路径、`..` 段），再 resolve 之后判前缀 ——
 * 后者才是真正判据，前缀比较必须带上分隔符，否则 `/x/extension-dev/foobar` 会被
 * `/x/extension-dev/foo` 认成自己的子路径。
 */
async function handleDevFile(_ctx, req, res) {
  const url = new URL(req.url || '/', 'http://x');
  const slug = (url.searchParams.get('slug') || '').trim();
  const requested = (url.searchParams.get('path') || '').trim();
  if (!slug || !requested || !SLUG_PATTERN.test(slug)) {
    return fail(res, 400, 'bad-request', '需要合法的 slug 与 path（path 是相对包目录的路径）');
  }

  const directory = path.join(devRoot(), slug);
  if (!fs.existsSync(path.join(directory, 'manifest.json'))) {
    return fail(res, 404, 'dev-package-missing', `开发包目录里没有 ${slug} 这个包（缺 manifest.json）`);
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
  devRoot,
  listPackages,
  handleDevPackages,
  handleDevFile,
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_FILES,
  MAX_FILE_BYTES,
};

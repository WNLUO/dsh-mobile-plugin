'use strict';

/**
 * 已审核扩展清单：随 dsh-mobile-plugin 的 npm 包一起发布的第三方扩展（包内 `extensions/`）。
 *
 * 与开发包那条路的分界：开发包读作者电脑上的 `$DSH_HOME/extension-dev`（边写边看），这条读
 * 插件包自带的只读目录 —— 只有审过、登记进 `extensions/catalog.json` 的包才下发，目录里有但
 * 没登记的一律当不存在。审核闸门在清单，不在目录。
 *
 * 第三方插件自己带的那一批走另一档（见 `third-party-extensions.js`）：那边没有清单，能列就能装，
 * 整包也由宿主把这台电脑上的目录现打成一个 zip（不会有预先产好的 `<slug>.zip`）。
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
const thirdParty = require('./third-party-extensions');

/** 审核清单文件名。只有列进来的 slug 才下发。 */
const CATALOG_FILE = 'catalog.json';
/** slug 直接当包目录名，所以只认这套字符；别的名字连读都不读。 */
const SLUG_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** 整包上限：与开发包同一档，太重的包手机也不该整份拉。 */
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
// 2026-11-08 从 200 抬到 400：整份网页前端做成的扩展（例如 magpie）光图标就一两百个、
// 按名字动态引用删不得，260 多个文件是常态；400 仍挡得住离谱的大包。
const MAX_PACKAGE_FILES = 400;
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
 * 收窄清单里那一格 `devServer`：只认本机 / 局域网 / 回环上的 **http** 地址。
 *
 * 与开发包那条（`extension-dev.js` 的同名函数）同一套判据、同一份理由：这一格让手机把远程页面
 * 装进扩展页的 WebView，写歪了重则把一个公网站点塞进 App 的沙箱里跑，所以只放行私网与回环、
 * 只放行 http，其余一律当没写（页面退回加载本地那份，作者至少还能看到东西）。
 */
function devServerOf(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw === '' || raw.length > 200) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'http:') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  const host = url.hostname;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const octets = ipv4.slice(1).map((part) => Number(part));
    if (octets.some((part) => part > 255)) return null;
    const [a, b] = octets;
    const privateOrLoop =
      a === 127
      || a === 10
      || (a === 192 && b === 168)
      || (a === 172 && b >= 16 && b <= 31);
    return privateOrLoop ? `http://${host}:${url.port || '80'}/` : null;
  }
  if (host === 'localhost') return `http://localhost:${url.port || '80'}/`;
  if (/\.local$/i.test(host)) return `http://${host}:${url.port || '80'}/`;
  return null;
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
 * 把一个已经定位好的包目录读成一份 Package；不合规（没 manifest、没入口页、超限）回 null。
 *
 * 两条来源（随本插件发布的 `catalog.json`、第三方插件自己声明的目录）共用这一份判据：
 * 判的是「这个包能不能装到手机上」，与它从哪来无关。`meta` 里那几格文案由来源各给各的。
 *
 * 入口页固定是包目录下那层 `index.html`：App 侧 `extensionEntryPath` 找的就是这个名字，
 * `manifest.json` 里写 `main` 不生效。所以这里先确认 `index.html` 真的在文件清单里，
 * 缺了就把整包跳过 —— 装到手机上再报「需要重新安装」，比根本不出现在清单里难查得多。
 */
function readPackage(directory, slug, meta = {}) {
  let stats;
  try { stats = fs.statSync(directory); } catch { return null; }
  if (!stats.isDirectory()) return null;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  } catch { return null; }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  const acc = { root: directory, files: [], bytes: 0 };
  if (!collectFiles(directory, acc) || acc.files.length === 0) return null;
  if (!acc.files.some((file) => file.path === 'index.html')) return null;
  return {
    slug,
    name: textField(manifest.name, slug),
    description: meta.description ?? null,
    author: meta.author ?? null,
    versionName: textField(manifest.versionName, textField(manifest.version, '0.0.0')),
    apiVersion: textField(manifest.apiVersion, textField(manifest.api_version, '1')),
    releaseNotes: meta.releaseNotes ?? null,
    capabilities: capabilitiesOf(manifest.capabilities),
    // 作者在自己机器上开发时写进清单的开发服务器地址（可选，缺省 null）：手机只在开发者模式下
    // 读它拿 HMR，其余情况仍加载装到本地的那份。收窄判据同开发包那条。
    devServer: devServerOf(manifest.devServer),
    // 取数声明一起下发：手机上「已装记录」里若缺这一项（早期版本装下的包），App 用当前电脑上
    // 这一份清单把老记录补上，页面才不会把 /api/… 解析成 file://… 而永远转圈。只下发声明，
    // 不在这里做任何放行判断（真正的边界在 extension-data.js 的服务登记表里）。
    hostData: manifest.hostData && typeof manifest.hostData === 'object' && !Array.isArray(manifest.hostData)
      ? manifest.hostData
      : null,
    size: acc.bytes,
    fileCount: acc.files.length,
    files: acc.files,
  };
}

/**
 * 扫审核清单，把每个登记过、且目录与 manifest 都在的包读成一份 Package。
 *
 * 纯函数、root 由调用方给：守卫拿假目录跑，线上 handler 给包内那个固定目录。
 */
function listPackages(root) {
  const packages = [];
  for (const entry of readCatalog(root)) {
    const pkg = readPackage(path.join(root, entry.slug), entry.slug, entry);
    if (pkg) packages.push(pkg);
  }
  return packages;
}

/**
 * 第三方插件自带的扩展：profile 里任何一个插件的 `package.json` 声明了 `dshMobileExtensions`，
 * 它那份目录里的每个子目录就是一个扩展（见 `third-party-extensions.js`）。
 *
 * 这一档**没有登记清单**：作者装好自己的插件，他的手机就能拉到，我们这边不认识他。
 * 审核不在仓库里做，所以判据只剩「能不能装」—— 与上一条同一个 `readPackage`，判不过就不列。
 *
 * 文案从包里自己的 `manifest.json` 读（`description` / `author` 也认包内的，缺了才退到插件名），
 * 不另立一份清单文件：作者已经在写 manifest 了，再要求一张表就是又一个要同步的东西。
 */
function listThirdParty(pluginsRoot) {
  const packages = [];
  for (const found of thirdParty.discoverPackages(pluginsRoot)) {
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(found.directory, 'manifest.json'), 'utf8'));
    } catch { manifest = null; }
    const author = manifest && typeof manifest.author === 'string' && manifest.author.trim()
      ? manifest.author
      : found.packageName;
    const description = manifest && typeof manifest.description === 'string' && manifest.description.trim()
      ? manifest.description
      : null;
    const pkg = readPackage(found.directory, found.slug, { description, author });
    if (pkg) packages.push(pkg);
  }
  return packages;
}

/**
 * GET /api/mobile/v1/extension/catalog（token）
 *
 * 回这台电脑能给手机装的全部扩展：随本插件发布的（审核清单）+ 第三方插件自己带的那几条。
 *
 * `root` 只是给守卫传假目录的可选参数，线上由 route() 调用时不传，永远走包内那个固定目录；
 * `pluginsRoot` 同理，是 profile 的 `node_modules`（运行时由外壳报上来）。
 */
async function handleCatalog(_ctx, _req, res, root = catalogRoot(), pluginsRoot = null) {
  const packages = listPackages(root);
  const seen = new Set(packages.map((entry) => entry.slug));
  for (const pkg of listThirdParty(pluginsRoot)) {
    // 同 slug 以随本插件发布那份为准：那是我们发的包，不该被某个插件里的同名目录顶掉。
    if (seen.has(pkg.slug)) continue;
    seen.add(pkg.slug);
    packages.push(pkg);
  }
  sendJson(res, 200, { ok: true, packages });
}

/**
 * GET /api/mobile/v1/extension/catalog/archive?slug=…（token）
 *
 * 整包一次下发：把一个扩展的 **zip** 整个回成 base64。手机下载一个包、本地解包，
 * 不再按文件逐个拉几百次（那正是「269 次往返、两三百 KB/s」的病根）。
 *
 * 两档来源各给各的 zip：
 *  - 随本插件发布的：zip 由产包脚本预先放在 `<root>/<slug>.zip`（与 slug 目录平级，不属于任何
 *    一包的文件清单），这里只读；没有 zip 照旧 404，交给老插件的逐文件那条。
 *  - 第三方插件自带的：这台电脑上不会有人给它打包，所以与开发包那条一样**现打** —— 目录此刻的
 *    样子就是手机装到的样子，不会拿到一份过期的 zip。
 *
 * 闸门与取单文件一致：slug 不合法 400，两档都不认识的 404，整包体积按包上限兜住（413）。
 */
async function handleCatalogArchive(_ctx, req, res, root = catalogRoot(), pluginsRoot = null) {
  const url = new URL(req.url || '/', 'http://x');
  const slug = (url.searchParams.get('slug') || '').trim();
  if (!slug || !SLUG_PATTERN.test(slug)) {
    return fail(res, 400, 'bad-request', '需要合法的 slug');
  }
  if (readCatalog(root).some((entry) => entry.slug === slug)) {
    const zipPath = path.join(root, `${slug}.zip`);
    let raw;
    try {
      const stat = fs.statSync(zipPath);
      if (stat.size > MAX_PACKAGE_BYTES) return fail(res, 413, 'package-too-large', `${slug}.zip 超过整包上限`);
      raw = fs.readFileSync(zipPath);
    } catch {
      // 没有 zip 不算错误：老插件 / 没打 zip 的包照旧走逐文件那条（App 侧会回退）。
      return fail(res, 404, 'archive-missing', `${slug} 没有整包 zip，走逐文件下载`);
    }
    return sendJson(res, 200, { ok: true, slug, size: raw.length, sha256: sha256Hex(raw), content: raw.toString('base64') });
  }

  // 剩下只可能是第三方插件自己带的那一档：目录现扫（插件随手装 / 卸，缓存一版就要回答何时失效）。
  const directory = thirdParty.directoryOf(pluginsRoot, slug);
  if (!directory || !fs.existsSync(path.join(directory, 'manifest.json'))) {
    return fail(res, 404, 'package-missing', `这台电脑上没有 ${slug} 这个扩展`);
  }

  let raw;
  try {
    raw = zipDirectory(directory);
  } catch (error) {
    return fail(res, 500, 'archive-failed', `打包失败：${String(error?.message || error).slice(0, 200)}`);
  }
  if (raw.length > MAX_PACKAGE_BYTES) {
    return fail(res, 413, 'package-too-large', `${slug} 整包 ${raw.length} 字节，超过上限 ${MAX_PACKAGE_BYTES}`);
  }
  sendJson(res, 200, { ok: true, slug, size: raw.length, sha256: sha256Hex(raw), content: raw.toString('base64') });
}

/**
 * 把一个目录打成 zip 字节（与 `extension-dev.js` 的整包同一条命令）。
 *
 * 用系统的 `zip`：宿主不引第三方压缩库，而 `zip` 三个桌面系统都有。`-X` 去掉多余的扩展属性、
 * `-q` 安静、`-r` 递归；从目录里执行、打包 `.`，所以包内路径是相对路径，手机解出来的键与文件
 * 清单里的 `path` 对得上。
 */
function zipDirectory(directory) {
  const outFile = path.join(require('node:os').tmpdir(), `dshm-catalog-${process.pid}-${Date.now()}.zip`);
  try {
    require('node:child_process').execFileSync('zip', ['-r', '-q', '-X', outFile, '.'], {
      cwd: directory,
      stdio: 'pipe',
    });
    return fs.readFileSync(outFile);
  } finally {
    try { fs.rmSync(outFile, { force: true }); } catch { /* 临时文件删不掉不影响结果 */ }
  }
}

/**
 * 一个 slug 对应的包目录：先查本插件里那批登记过的，再查第三方插件自己声明的。
 *
 * 两档都不认就返回 null —— 取文件那条据此回 404，目录里的字节读不到。
 */
function packageDirOf(root, pluginsRoot, slug) {
  if (readCatalog(root).some((entry) => entry.slug === slug)) {
    return path.join(root, slug);
  }
  return thirdParty.directoryOf(pluginsRoot, slug);
}

/**
 * GET /api/mobile/v1/extension/catalog/file?slug=…&path=…（token）
 *
 * 取一个包里的一个文件，回 base64 与 sha256（与列表里那条同一份算法）。两档来源共用这道闸：
 * 既不在本插件的审核清单里、也不是哪个插件声明过的 slug，一律 404，免得绕过清单直接把字节读走。
 *
 * 路径检查两道：先挡明显不该出现的（绝对路径、`..` 段），再 resolve 之后判前缀 —— 后者才是
 * 判据，前缀比较必须带分隔符，否则 `/x/extensions/foobar` 会被 `/x/extensions/foo` 认成子路径。
 */
async function handleCatalogFile(_ctx, req, res, root = catalogRoot(), pluginsRoot = null) {
  const url = new URL(req.url || '/', 'http://x');
  const slug = (url.searchParams.get('slug') || '').trim();
  const requested = (url.searchParams.get('path') || '').trim();
  if (!slug || !requested || !SLUG_PATTERN.test(slug)) {
    return fail(res, 400, 'bad-request', '需要合法的 slug 与 path（path 是相对包目录的路径）');
  }

  const directory = packageDirOf(root, pluginsRoot, slug);
  if (!directory) {
    return fail(res, 404, 'package-missing', `这台电脑上没有 ${slug} 这个扩展`);
  }
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
  listThirdParty,
  handleCatalog,
  handleCatalogFile,
  handleCatalogArchive,
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_FILES,
  MAX_FILE_BYTES,
};

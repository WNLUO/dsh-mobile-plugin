// CLOUDFLARED 下载逐源分配预算，响应体同样受时限约束，坏校验不阻断后续镜像。
'use strict';

// 2026-11-22：cloudflared 获取层，照 frpc 那套「自带 → PATH → 缓存 → 下载」写，钉版本并填全四平台校验和。

/**
 * 在用户电脑上「弄到一份能用的 cloudflared」：先看用户自己有没有，再看有没有缓存，都没有就按平台
 * 从官方 release 拉一份、校验、解包、落到缓存目录。
 *
 * 为什么单独一层：cloudflared 是第三方二进制，我们既不想把它打进 npm 包（每个平台一个包，维护不动），
 * 也不能指望用户自己会装。这里只做「拿到可执行文件」这一件事——真正怎么起隧道、连哪个地址、
 * 传什么配置，留给调用方（这一步之后再说）。
 *
 * 三条来源，按优先级：
 *   ① 用户指定的路径（环境变量 `DSHM_CLOUDFLARED_BIN`）或系统 PATH 里已有的 cloudflared —— 直接用，不下载；
 *   ② 以前下载过的缓存（按「版本 + 平台」存）—— 直接用；
 *   ③ 都没有 —— 按当前系统与架构从官方 release 下载对应产物，sha256 校验通过后再落盘。
 *      国内常连不上 GitHub，下载这一步会依次回退几条公开加速镜像；镜像只换传输路径，
 *      仍是同一份资产、同一份钉死的 sha256，校验不符当场拒掉，不因为「换源」放松验证。
 *
 * 失败抛带 code 的错误（`download-failed` / `checksum` / `unsupported-platform`），由调用方决定
 * 是当「这台机器没有 cloudflared」继续降级，还是提示用户。全源都不通时把每条源的底层原因
 * （从 undici 的 `cause` 里挖出来的真话，而不是一句 `fetch failed`）一并列出来。
 *
 * 纯 Node 实现，不依赖系统 tar：下载的是官方 .tgz（macOS）或裸二进制（Linux/Windows），
 * .tgz 解包在本文件里手写，只挑出里面那个 cloudflared 可执行文件，其余不落盘。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { dshHome } = require('../shared/paths.js');

/** 钉死的 cloudflared 版本。换版本时改这一个常量，并把下面的文件名与 sha256 一起更新。 */
const CLOUDFLARED_VERSION = '2026.11.0';

/**
 * 官方 release 的下载根；国内常连不上，下面挂着几条公开加速镜像，按顺序回退。
 * 只换「同一份字节的传输路径」，资产与 sha256 不变——镜像给错内容照样在校验那步被拒。
 * 镜像是第三方服务，会失效也会变，所以做成一张可替换的表，且永远最后才动失败文案。
 */
const DEFAULT_BASE_URL = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;

const MIRROR_BASE_URLS = [
  `https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`,
  `https://ghfast.top/https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`,
  `https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`,
];

/**
 * 这一轮下载要按顺序试的根地址。
 *
 * 优先级：`baseUrl`（部署方/测试显式钉死，只试这一条）> 官方 + 镜像。任何一环给出的
 * 字节都要过同一份 sha256，镜像进不了「少校验」的捷径。
 */
function baseUrlsOf(options = {}) {
  if (typeof options.baseUrl === 'string' && options.baseUrl) return [options.baseUrl];
  return [DEFAULT_BASE_URL, ...MIRROR_BASE_URLS];
}

/**
 * undici 把真正的 syscall 错塞在 `cause` 里，表层只有一句没信息的 `fetch failed`。
 * 沿 cause 链找第一句比 "fetch failed" 更具体的话；找不到就退回表层那句，不凭空编。
 */
function fetchErrorMessage(error) {
  let cursor = error;
  let generic = '';
  for (let depth = 0; depth < 4 && cursor; depth += 1) {
    const message = typeof cursor.message === 'string' ? cursor.message.trim() : '';
    if (message && message.toLowerCase() !== 'fetch failed') return message;
    if (message) generic = message;
    cursor = cursor.cause;
  }
  return generic || (error && error.message ? error.message : String(error));
}

/**
 * 支持的平台 → 资产描述。
 *
 * `file` 是官方 release 里那个产物的名字，`archive` 决定是不是要解包（macOS 是 .tgz，
 * Linux/Windows 是裸二进制），`bin` 是落盘后的可执行名，`sha256` 是官方发布的校验值
 * （写死在这里，防的是「下到的包被换掉」，而不是防文件坏）。只列我们真正支持的平台；
 * 不在表里的（FreeBSD、32 位等）一律当「不支持」，不猜。
 */
const ASSETS = {
  'darwin-x64': { file: 'cloudflared-darwin-amd64.tgz', archive: 'tar.gz', bin: 'cloudflared', sha256: 'be6be8d4aa0c3ff66917e265002fc9f702d42eae877edf495143f5b874c424af' },
  'darwin-arm64': { file: 'cloudflared-darwin-arm64.tgz', archive: 'tar.gz', bin: 'cloudflared', sha256: '97e24268d9704a570fab276293028f3580ae2c7d5d2678621a4809e90f776a5e' },
  'linux-x64': { file: 'cloudflared-linux-amd64', archive: 'binary', bin: 'cloudflared', sha256: '51f7c68b57ed7269164075d7e789efce5b59355982f06392deeb037d982a51fd' },
  'linux-arm64': { file: 'cloudflared-linux-arm64', archive: 'binary', bin: 'cloudflared', sha256: 'abe54a006acf9faf2d19ee9d953cb0d0804e92f59c5382a162e57b84d086f56f' },
  'win32-x64': { file: 'cloudflared-windows-amd64.exe', archive: 'binary', bin: 'cloudflared.exe', sha256: 'd5c1d82031da6253dcdcff64c944cd0fe063016edeb2e4fd088075fc9bd52d0a' },
};

/** 下载超时：cloudflared 的产物二三十 MB，给足两分钟；卡住也不至于让调用方一直等。 */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** 同一平台同一时刻只拉一次：多个入口同时触发时共用同一个 Promise。 */
const inflight = new Map();

/** 这台机器对应哪个平台（与 frpc 的 `platformId` 同一套命名）。不支持就返回 undefined。 */
function platformId(platform = process.platform, arch = process.arch) {
  const os = platform === 'win32' ? 'win32' : platform;
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch;
  const id = `${os}-${cpu}`;
  return Object.prototype.hasOwnProperty.call(ASSETS, id) ? id : undefined;
}

/** 缓存根：`<DSH 数据目录>/cloudflared`（测试可注入）。 */
function cacheRoot(options = {}) {
  return options.cacheRoot || path.join(dshHome(), 'cloudflared');
}

/** 某一版本 + 平台的缓存目录。 */
function cacheDirOf(options = {}) {
  const version = options.version || CLOUDFLARED_VERSION;
  const platform = options.platformId || platformId(options.platform, options.arch);
  if (!platform) return null;
  return path.join(cacheRoot(options), version, platform);
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isFile(target) {
  try { return fs.statSync(target).isFile(); } catch { return false; }
}

/**
 * 在 PATH 里找一个可执行文件。
 *
 * `PATH` 分隔符跟随平台（Windows 是 `;`，其余是 `:`）；只判「在、且是普通文件」，不判可执行位
 * ——Windows 上没有可执行位那一说，而 POSIX 上用户既然把它放进 PATH，基本就是能跑的。
 */
function findOnPath(binName, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform;
  const raw = env.PATH || env.Path || '';
  const sep = platform === 'win32' || path.delimiter === ';' ? ';' : path.delimiter;
  for (const dir of raw.split(sep)) {
    if (!dir) continue;
    const candidate = path.join(dir, binName);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * 用户已经有的 cloudflared（优先级最高）。
 *
 * ① 环境变量 `DSHM_CLOUDFLARED_BIN` 指的那一份；② 系统 PATH 里的 cloudflared。
 * 都没有返回 null。这里不关心平台资产表——用户给了就直接用。
 */
function resolveInstalled(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const override = env.DSHM_CLOUDFLARED_BIN;
  if (typeof override === 'string' && override && isFile(override)) {
    return { path: override, source: 'env' };
  }
  const binName = options.bin || (platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  const found = findOnPath(binName, { env, platform });
  if (found) return { path: found, source: 'path' };
  return null;
}

/** 从 tar.gz 里读出名为 `basename` 的那个文件（只挑这一个，别的不要）。 */
function extractTarGzEntry(input, basename) {
  const zlib = require('node:zlib');
  const tar = input.length >= 2 && input[0] === 0x1f && input[1] === 0x8b ? zlib.gunzipSync(input) : input;
  const str = (buf, start, length) => {
    const slice = buf.subarray(start, start + length);
    const zero = slice.indexOf(0);
    return (zero === -1 ? slice : slice.subarray(0, zero)).toString('utf8');
  };
  const BLOCK = 512;
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = str(header, 0, 100);
    const prefix = str(header, 345, 155);
    const sizeText = str(header, 124, 12).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    const type = String.fromCharCode(header[156]) || '0';
    const start = offset + BLOCK;
    const end = start + (Number.isFinite(size) ? size : 0);
    if (end > tar.length) throw new Error(`压缩包被截断：条目 ${name || '(无名)'} 声明的长度超出文件`);
    const full = prefix ? `${prefix}/${name}` : name;
    if ((type === '0' || type === '\u0000') && path.basename(full) === basename) {
      return Buffer.from(tar.subarray(start, end));
    }
    offset = start + Math.ceil((Number.isFinite(size) ? size : 0) / BLOCK) * BLOCK;
  }
  throw new Error(`压缩包里没有找到 ${basename}`);
}

/** 按 `archive` 类型从下载到的字节里挑出可执行文件；裸二进制直接用整份响应体。 */
function extractEntry(buffer, asset) {
  return asset.archive === 'tar.gz' ? extractTarGzEntry(buffer, asset.bin) : buffer;
}

/** macOS 上尽力摘掉 quarantine 标记；摘不掉（没有 xattr / 本来没有该属性）也不阻断。 */
function clearQuarantine(target, platform) {
  if (platform !== 'darwin') return;
  try {
    require('node:child_process').execFileSync('xattr', ['-d', 'com.apple.quarantine', target], { stdio: 'ignore' });
  } catch { /* 没有该属性或系统不带 xattr：留着也不影响执行 */ }
}

/**
 * 下载一份资产、校验、解包，把可执行文件写到 `dir/bin`。
 *
 * 只写这一个文件；先写进调用方给的暂存目录，最后由 `ensureCloudflared` 原子换上，所以半截文件
 * 不会出现在正式缓存目录里。可执行位与去 quarantine 都在这里一并处理。
 */
async function downloadTo({ url, asset, dir, platform, fetchImpl, timeoutMs = DOWNLOAD_TIMEOUT_MS }) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw codedError('no-fetch', '当前环境没有可用的 fetch');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let buffer;
  try {
    const response = await doFetch(url, controller ? { signal: controller.signal } : {});
    if (!response || response.ok !== true) {
      throw new Error(`HTTP ${response ? response.status : '无响应'}`);
    }
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw codedError('download-failed', `下载 cloudflared 失败：${fetchErrorMessage(error)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const got = sha256Hex(buffer);
  if (asset.sha256 && got !== asset.sha256) {
    throw codedError('checksum', `cloudflared 校验失败：下载内容的 sha256 与预期不一致（预期 ${asset.sha256}，实际 ${got}）`);
  }
  let binary;
  try {
    binary = extractEntry(buffer, asset);
  } catch (error) {
    throw codedError('extract-failed', `解包 cloudflared 失败：${error && error.message ? error.message : error}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, asset.bin);
  fs.writeFileSync(dest, binary);
  // 可执行位只在 POSIX 有意义；Windows 上 chmod 只改只读标记，别去碰。
  if (platform !== 'win32') {
    try { fs.chmodSync(dest, 0o755); } catch { /* 权限位没打上也不至于跑不了 */ }
  }
  clearQuarantine(dest, platform);
  return dest;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 把目录换成目标目录；同盘 rename，跨盘退回复制再删（与 OTA 那条同一套兜底）。 */
function moveDir(src, dst) {
  try {
    fs.renameSync(src, dst);
    return;
  } catch (error) {
    const code = error && error.code;
    if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EEXIST'].includes(code)) throw error;
  }
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
  fs.rmSync(src, { recursive: true, force: true });
}

/** 成功后清掉**其它版本目录**的缓存，失败不影响主流程。只清版本号样式的目录，别动同目录下的配置/标记。 */
function pruneOldVersions(root, currentVersion) {
  let names;
  try { names = fs.readdirSync(root); } catch { return; }
  for (const name of names) {
    if (name === currentVersion || !/^\d+\.\d+\.\d+/.test(name)) continue;
    try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); } catch { /* 占着就下次再清 */ }
  }
}

/** 同一平台的并发触发合并成一次下载。 */
function withLock(key, task) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = Promise.resolve().then(task).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/**
 * 拿到一份可用的 cloudflared。
 *
 * @returns {Promise<{path:string, version:string|null, source:'env'|'path'|'cache'|'download'}>}
 *   失败时抛带 `code` 的错误：`unsupported-platform` / `checksum` / `download-failed`。
 *
 * 选项中可注入（测试用）：platform/platformId、arch、env、cacheRoot、version、asset、baseUrl、fetchImpl、
 * offline（true = 不允许联网，只认已有/缓存）。
 */
async function ensureCloudflared(options = {}) {
  const platform = options.platformId || platformId(options.platform, options.arch);
  const version = options.version || CLOUDFLARED_VERSION;

  // ① 用户自己有的（显式路径 / PATH）：平台认不出也先认这一份。
  const installed = resolveInstalled(options);
  if (installed) {
    return { path: installed.path, version: null, source: installed.source };
  }

  // ② 平台/资产：认不出就不猜。
  const asset = options.asset || (platform ? ASSETS[platform] : null);
  if (!platform || !asset) {
    throw codedError('unsupported-platform', `这台机器（${options.platform || process.platform}/${options.arch || process.arch}）不在支持的平台上，装不了 cloudflared`);
  }

  const dir = options.cacheRoot
    ? path.join(options.cacheRoot, version, platform)
    : cacheDirOf({ ...options, platformId: platform, version });
  const binaryPath = path.join(dir, asset.bin);
  // ③ 缓存命中。
  if (isFile(binaryPath)) {
    return { path: binaryPath, version, source: 'cache' };
  }

  // ④ 要联网：不允许就直接回，别让调用方等超时。
  if (options.offline) {
    throw codedError('download-failed', '本机没有找到 cloudflared，且当前不允许联网下载');
  }

  return withLock(platform, async () => {
    // 排队期间可能已经被别的调用拉好了，再确认一次。
    if (isFile(binaryPath)) {
      return { path: binaryPath, version, source: 'cache' };
    }
    const root = options.cacheRoot || cacheRoot(options);
    const staging = path.join(root, `.staging-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    const bases = baseUrlsOf(options);
    const attempts = [];
    // 在总预算内给每个剩余源留一份，首源挂起也不能独占整轮。
    const budgetMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DOWNLOAD_TIMEOUT_MS;
    const deadline = performance.now() + budgetMs;
    let lastError = null;
    try {
      for (const [index, base] of bases.entries()) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        const timeoutMs = Math.max(1, remaining / (bases.length - index));
        const url = `${String(base).replace(/\/+$/, '')}/${asset.file}`;
        try {
          await downloadTo({ url, asset, dir: staging, platform, fetchImpl: options.fetchImpl, timeoutMs });
          // 先剔掉可能残留的旧目录，再把暂存目录原子换上。
          fs.rmSync(dir, { recursive: true, force: true });
          fs.mkdirSync(path.dirname(dir), { recursive: true });
          moveDir(staging, dir);
          pruneOldVersions(root, version);
          return { path: binaryPath, version, source: 'download' };
        } catch (error) {
          lastError = error;
          const reason = error && error.message ? error.message : String(error);
          attempts.push(reason.replace(/^下载 cloudflared 失败：/, ''));
          // 本源响应可能是门户页或镜像错误页；后源仍必须通过同一份钉死校验。
          fs.rmSync(staging, { recursive: true, force: true });
        }
      }
      if (bases.length === 1 && lastError) throw codedError(lastError.code || 'download-failed', lastError.message || String(lastError));
      throw codedError('download-failed', `下载 cloudflared 失败：${attempts.length} 个源均失败（${attempts.join('；')}）`);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });
}

module.exports = {
  CLOUDFLARED_VERSION,
  ASSETS,
  DEFAULT_BASE_URL,
  MIRROR_BASE_URLS,
  baseUrlsOf,
  fetchErrorMessage,
  platformId,
  cacheRoot,
  cacheDirOf,
  resolveInstalled,
  findOnPath,
  extractTarGzEntry,
  ensureCloudflared,
};

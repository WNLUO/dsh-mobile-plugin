'use strict';

// 2026-11-18：下载加国内镜像回退（官方不通自动换源，仍按同一份 sha256 校验），失败文案挖出 cause 真话。

/**
 * 在用户电脑上「弄到一份能用的 frpc」：先看用户自己有没有，再看有没有缓存，都没有就按平台
 * 从官方 release 拉一份、校验、解包、落到缓存目录。
 *
 * 为什么单独一层：frpc 是第三方二进制，我们既不想把它打进 npm 包（每个平台一个包，维护不动），
 * 也不能指望用户自己会装。所以这里只做「拿到可执行文件」这一件事——真正怎么起、连哪台服务器、
 * 传什么配置，留给调用方（这一步之后再说）。
 *
 * 三条来源，按优先级：
 *   ① 用户指定的路径（环境变量 `DSHM_FRPC_BIN`）或系统 PATH 里已有的 frpc —— 直接用，不下载；
 *   ② 以前下载过的缓存（按「版本 + 平台」存）—— 直接用；
 *   ③ 都没有 —— 按当前系统与架构从官方 release 下载对应包，sha256 校验通过后再解包落盘。
 *      国内常连不上 GitHub，下载这一步会依次回退几条公开加速镜像；镜像只换传输路径，
 *      仍是同一份资产、同一份钉死的 sha256，校验不符当场拒掉，不因为「换源」放松验证。
 *
 * 失败一律走返回值（`{ ok: false, reason, message }`），从不抛给调用方：这条只是可选能力，
 * 弄不到就等于「这台机器没有 frpc」，插件其它功能一点不受影响。全源都不通时把每条源的
 * 底层原因（从 undici 的 `cause` 里挖出来的真话，而不是一句 `fetch failed`）一并列出来。
 *
 * 纯 Node 实现，不依赖系统 tar/unzip：下载的是官方 .tar.gz（Linux/macOS）或 .zip（Windows），
 * 两种解包都在本文件里手写，只挑出里面那个 frpc 可执行文件，其余（frps、LICENSE…）不落盘。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { dshHome } = require('../shared/paths.js');

/** 钉死的 frp 版本。换版本时改这一个常量，并把下面的文件名与 sha256 一起更新。 */
const FRP_VERSION = '0.72.0';

/**
 * 官方 release 的下载根；国内常连不上，下面挂着几条公开加速镜像，按顺序回退。
 * 只换「同一份字节的传输路径」，资产与 sha256 不变——镜像给错内容照样在校验那步被拒。
 * 镜像是第三方服务，会失效也会变，所以做成一张可替换的表，且永远最后才动失败文案。
 */
const DEFAULT_BASE_URL = `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}`;

const MIRROR_BASE_URLS = [
  `https://gh-proxy.com/https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}`,
  `https://ghfast.top/https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}`,
  `https://ghproxy.net/https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}`,
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
 * 沿 cause 链找第一句比 "fetch failed" 更具体的话（connect ETIMEDOUT / ENOTFOUND /
 * ECONNREFUSED / 证书问题…）；找不到就退回表层那句，不凭空编。
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
 * `file` 是官方 release 里那个压缩包的名字，`archive` 决定用哪种解包，`bin` 是包内可执行名，
 * `sha256` 是官方发布的校验值（写死在这里，防的是「下到的包被换掉」，而不是防文件坏）。
 * 只列我们真正支持的平台；不在表里的（FreeBSD、32 位等）一律当「不支持」，不猜。
 */
const ASSETS = {
  'darwin-x64': { file: `frp_${FRP_VERSION}_darwin_amd64.tar.gz`, archive: 'tar.gz', bin: 'frpc', sha256: '60439dc6bf794c4182a1a4cac147d642f839d55201607208979eb23aecd09be9' },
  'darwin-arm64': { file: `frp_${FRP_VERSION}_darwin_arm64.tar.gz`, archive: 'tar.gz', bin: 'frpc', sha256: '6e8576c5b6b9914a86850f6ff4fb81c5a09e706f91f70f64d5f398558bdc9db8' },
  'linux-x64': { file: `frp_${FRP_VERSION}_linux_amd64.tar.gz`, archive: 'tar.gz', bin: 'frpc', sha256: 'daf719b32ca2778770bb92955e231a07414d754378b9af328aa2642862479804' },
  'linux-arm64': { file: `frp_${FRP_VERSION}_linux_arm64.tar.gz`, archive: 'tar.gz', bin: 'frpc', sha256: '02180b857480302fd934e9ddbd50fe2f73229f99062f88756abc6de9df5e95cf' },
  'win32-x64': { file: `frp_${FRP_VERSION}_windows_amd64.zip`, archive: 'zip', bin: 'frpc.exe', sha256: '5197c1b69564089cdc229fc1260a0e25db1e722b1b7db45fe1542c3c43edf9ae' },
  'win32-arm64': { file: `frp_${FRP_VERSION}_windows_arm64.zip`, archive: 'zip', bin: 'frpc.exe', sha256: 'e4b83b66c4045971dd9a47cdef16dd02af471aaa6667dd303e63b1a669162927' },
};

/** 下载超时：frp 的包十来 MB，给足两分钟；卡住也不至于让调用方一直等。 */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** 同一平台同一时刻只拉一次：多个入口同时触发时共用同一个 Promise。 */
const inflight = new Map();

/** 这台机器对应哪个平台（与 tailcat 的 `platformId` 同一套命名）。不支持就返回 undefined。 */
function platformId(platform = process.platform, arch = process.arch) {
  const os = platform === 'win32' ? 'win32' : platform;
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch;
  const id = `${os}-${cpu}`;
  return Object.prototype.hasOwnProperty.call(ASSETS, id) ? id : undefined;
}

/** 缓存根：`<DSH 数据目录>/frpc`（测试可注入）。 */
function cacheRoot(options = {}) {
  return options.cacheRoot || path.join(dshHome(), 'frpc');
}

/** 某一版本 + 平台的缓存目录。 */
function cacheDirOf(options = {}) {
  const version = options.version || FRP_VERSION;
  const platform = options.platformId || platformId(options.platform, options.arch);
  if (!platform) return null;
  return path.join(cacheRoot(options), version, platform);
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function fail(reason, message) {
  return { ok: false, reason, message };
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
 * 用户已经有的 frpc（优先级最高）。
 *
 * ① 环境变量 `DSHM_FRPC_BIN` 指的那一份（用户/部署方自己放好的路径）；
 * ② 系统 PATH 里的 frpc。
 * 都没有返回 null。这里不关心平台资产表——用户给了就直接用。
 */
function resolveInstalled(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const override = env.DSHM_FRPC_BIN;
  if (typeof override === 'string' && override && isFile(override)) {
    return { path: override, source: 'configured' };
  }
  const binName = options.bin || (platform === 'win32' ? 'frpc.exe' : 'frpc');
  const found = findOnPath(binName, { env, platform });
  if (found) return { path: found, source: 'system' };
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

/** 从 zip 里读出名为 `basename` 的那个文件（只挑这一个）。支持 store(0) 与 deflate(8)。 */
function extractZipEntry(input, basename) {
  const zlib = require('node:zlib');
  const u16 = (buf, at) => buf.readUInt16LE(at);
  const u32 = (buf, at) => buf.readUInt32LE(at);
  // 从尾部找中央目录结束记录（EOCD），签名 0x06054b50，后面最多跟 65535 字节注释。
  let eocd = -1;
  const floor = Math.max(0, input.length - 22 - 0xffff);
  for (let at = input.length - 22; at >= floor; at -= 1) {
    if (u32(input, at) === 0x06054b50) { eocd = at; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到中央目录');
  const total = u16(input, eocd + 10);
  let cursor = eocd;
  // 中央目录在 EOCD 前面；从「中央目录偏移」开始逐条扫更稳。
  const centralOffset = u32(input, eocd + 16);
  let at = centralOffset;
  for (let index = 0; index < total; index += 1) {
    if (u32(input, at) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = u16(input, at + 10);
    const compressedSize = u32(input, at + 20);
    const nameLen = u16(input, at + 28);
    const extraLen = u16(input, at + 30);
    const commentLen = u16(input, at + 32);
    const localOffset = u32(input, at + 42);
    const name = input.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    if (path.basename(name.replace(/\\/g, '/')) === basename) {
      if (u32(input, localOffset) !== 0x04034b50) throw new Error('zip 本地头损坏');
      const localNameLen = u16(input, localOffset + 26);
      const localExtraLen = u16(input, localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const raw = input.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return zlib.inflateRawSync(raw);
      throw new Error(`zip 用了不支持的压缩方式：${method}`);
    }
    at += 46 + nameLen + extraLen + commentLen;
    cursor = at;
  }
  throw new Error(`压缩包里没有找到 ${basename}`);
}

/** 按 `archive` 类型从解出的字节里挑出可执行文件。 */
function extractEntry(buffer, asset) {
  return asset.archive === 'zip'
    ? extractZipEntry(buffer, asset.bin)
    : extractTarGzEntry(buffer, asset.bin);
}

/**
 * 下载一个资产包、校验、解包，把可执行文件写到 `dir/bin`。
 *
 * 只写这一个文件；先写进调用方给的暂存目录，最后由 `ensureFrpc` 原子换上，所以半截文件
 * 不会出现在正式缓存目录里。
 */
async function downloadTo({ url, asset, dir, fetchImpl, timeoutMs = DOWNLOAD_TIMEOUT_MS }) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw codedError('no-fetch', '当前环境没有可用的 fetch');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await doFetch(url, controller ? { signal: controller.signal } : {});
  } catch (error) {
    throw codedError('download-failed', `下载 frpc 失败：${fetchErrorMessage(error)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!response || response.ok !== true) {
    throw codedError('download-failed', `下载 frpc 失败：HTTP ${response ? response.status : '无响应'}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const got = sha256Hex(buffer);
  if (asset.sha256 && got !== asset.sha256) {
    throw codedError('checksum', `frpc 校验失败：下载内容的 sha256 与预期不一致（预期 ${asset.sha256}，实际 ${got}）`);
  }
  let binary;
  try {
    binary = extractEntry(buffer, asset);
  } catch (error) {
    throw codedError('extract-failed', `解包 frpc 失败：${error && error.message ? error.message : error}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, asset.bin);
  fs.writeFileSync(dest, binary);
  // 可执行位只在 POSIX 有意义；Windows 上 chmod 只改只读标记，别去碰。
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dest, 0o755); } catch { /* 权限位没打上也不至于跑不了 */ }
  }
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
 * 拿到一份可用的 frpc。
 *
 * @returns {Promise<{ok:true, path:string, source:'configured'|'system'|'cache'|'downloaded', version:string|null, platform:string}
 *   | {ok:false, reason:string, message:string}>}
 *
 * 选项中可注入（测试用）：platform/platformId、arch、env、cacheRoot、version、asset、baseUrl、fetchImpl、
 * offline（true = 不允许联网，只认已有/缓存）。
 */
async function ensureFrpc(options = {}) {
  const platform = options.platformId || platformId(options.platform, options.arch);
  const version = options.version || FRP_VERSION;

  // ① 用户自己有的（显式路径 / PATH）：平台认不出也先认这一份。
  const installed = resolveInstalled(options);
  if (installed) {
    return { ok: true, path: installed.path, source: installed.source, version: null, platform: platform || null };
  }

  // ② 平台/资产：认不出就不猜。
  const asset = options.asset || (platform ? ASSETS[platform] : null);
  if (!platform || !asset) {
    return fail('unsupported-platform', `这台机器（${options.platform || process.platform}/${options.arch || process.arch}）不在支持的平台上，装不了 frpc`);
  }

  const dir = options.cacheRoot
    ? path.join(options.cacheRoot, version, platform)
    : cacheDirOf({ ...options, platformId: platform, version });
  const binaryPath = path.join(dir, asset.bin);
  // ③ 缓存命中。
  if (isFile(binaryPath)) {
    return { ok: true, path: binaryPath, source: 'cache', version, platform };
  }

  // ④ 要联网：不允许就直接回，别让调用方等超时。
  if (options.offline) {
    return fail('offline', '本机没有找到 frpc，且当前不允许联网下载');
  }

  return withLock(platform, async () => {
    // 排队期间可能已经被别的调用拉好了，再确认一次。
    if (isFile(binaryPath)) {
      return { ok: true, path: binaryPath, source: 'cache', version, platform };
    }
    const root = options.cacheRoot || cacheRoot(options);
    const staging = path.join(root, `.staging-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    const bases = baseUrlsOf(options);
    const attempts = [];
    // 整轮回退共用一份时间预算（与过去单源超时相同）：否则 GitHub 卡住不吃不吐时，
    // 逐源各等满 120 秒会把面板晾八分钟。排在后面的镜像只拿得到「剩下的时间」。
    const budgetMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DOWNLOAD_TIMEOUT_MS;
    const deadline = Date.now() + budgetMs;
    try {
      for (const base of bases) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const url = `${String(base).replace(/\/+$/, '')}/${asset.file}`;
        try {
          await downloadTo({ url, asset, dir: staging, fetchImpl: options.fetchImpl, timeoutMs: remaining });
          // 先剔掉可能残留的旧目录，再把暂存目录原子换上。
          fs.rmSync(dir, { recursive: true, force: true });
          fs.mkdirSync(path.dirname(dir), { recursive: true });
          moveDir(staging, dir);
          pruneOldVersions(root, version);
          return { ok: true, path: binaryPath, source: 'downloaded', version, platform };
        } catch (error) {
          const reason = error && error.message ? error.message : String(error);
          attempts.push(reason.replace(/^下载 frpc 失败：/, ''));
          // 校验不符不是「网络不通」：字节到了却对不上钉死的 sha256，换镜像也是同一份坏包，
          // 继续试只会让人以为在尽力。当场拒掉，和过去单源的行为一致。
          if (error && error.code === 'checksum') throw error;
        }
      }
      return fail('download-failed', `下载 frpc 失败：${attempts.length} 个源都不通（${attempts.join('；')}）`);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      return fail(error && error.code ? error.code : 'download-failed', error && error.message ? error.message : String(error));
    }
  });
}

/**
 * 不联网地看一下现状：当前平台、能不能用、用的是哪一份。给界面/日志用，触发不到下载。
 */
function inspectFrpc(options = {}) {
  const platform = options.platformId || platformId(options.platform, options.arch) || null;
  const asset = (platform && ASSETS[platform]) || null;
  const installed = resolveInstalled(options);
  if (installed) {
    return { ok: true, available: true, source: installed.source, path: installed.path, platform, version: null };
  }
  const version = options.version || FRP_VERSION;
  if (!asset) return { ok: false, available: false, reason: 'unsupported-platform', platform, version };
  const dir = options.cacheRoot ? path.join(options.cacheRoot, version, platform) : cacheDirOf({ ...options, platformId: platform, version });
  const cached = path.join(dir, asset.bin);
  return { ok: true, available: isFile(cached), source: isFile(cached) ? 'cache' : null, path: isFile(cached) ? cached : null, platform, version };
}

module.exports = {
  FRP_VERSION,
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
  extractZipEntry,
  ensureFrpc,
  inspectFrpc,
};

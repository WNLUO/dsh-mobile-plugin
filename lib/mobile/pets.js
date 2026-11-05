'use strict';

/**
 * 悬浮宠物的包目录（见 docs/pet-overlay.md §1）：素材存在跑对话的这台电脑上，手机连着哪台
 * 就看哪台的；换手机、清缓存都不丢。
 *
 * ## 两个根
 *
 *  · 用户包：`<DSH_HOME>/storages/mobile-plugin/pets/<id>/`，可写、可删；
 *  · 内置包：插件包自己的 `assets/pets/<id>/`，只读、随发版走，删不掉。
 *
 * 用户目录里同 id 的包覆盖内置那份（`builtin` 回 false）—— 这就是「整体覆盖内置」的方式。
 * 内置目录不存在是常态（素材由发版那边放），那时列表就是少几个包，不报错。
 *
 * ## 坏包静默跳过
 *
 * 少一个目录、pack.json 读不出、schema 不是 1、id 不合规矩、图片超限、没有能用的 idle，
 * 一律当作「这个包不存在」，不抛、不让整张列表变红。取文件那条才逐个回错误码。
 *
 * ## 能力面
 *
 * 只认包目录内**单层**的 `.gif` / `.png`：id 与文件名都卡成不含斜杠的形状，取文件时再按
 * 列表里的那一份核对，路径全由宿主拼，客户端给不了路径。没有「写任意文件」这条口子。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { sendJson, readJsonBody } = require('../shared/http-util');
const { dshHome } = require('../shared/paths.js');

/** 包 id 也是目录名：只认这套形状，顺带把路径穿越挡在门外。 */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** 认得的状态键。表外的键原样忽略，以后加状态时老 App 还能用这份包。 */
const KNOWN_STATES = Object.freeze(['idle', 'working', 'attention', 'done', 'error', 'sleeping']);
/** 默认循环播的那几档（与 §1.1 一致）。 */
const DEFAULT_LOOP = Object.freeze(['idle', 'working', 'attention']);
/** 单张图上限：一张 GIF 一般几十到几百 KB，四 MB 是「明显不对劲」的那条线。 */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** 整包上限：手机要整份拉下来，超了整包拒收。 */
const MAX_PACK_BYTES = 20 * 1024 * 1024;
const MAX_PACK_FILES = 60;
/** 档案文件名。 */
const PACK_FILE = 'pack.json';
/** 图片扩展名：GIF 自带帧就是一段动画，PNG 是一张静帧。 */
const IMAGE_EXT_RE = /\.(?:gif|png)$/i;

/** 用户包根。`DSH_MOBILE_PETS` 只给测试用。 */
function rootDir() {
  return process.env.DSH_MOBILE_PETS || path.join(dshHome(), 'storages', 'mobile-plugin', 'pets');
}

/**
 * 内置包根：从 lib/mobile/ 往上两级就是包根。不依赖 cwd、不建目录（随 npm 包发布）。
 * `DSH_MOBILE_PETS_BUILTIN` 只给测试用。
 */
function builtinRoot() {
  return process.env.DSH_MOBILE_PETS_BUILTIN || path.join(__dirname, '..', '..', 'assets', 'pets');
}

/** 400 信封：与其余移动端接口同形，App 按 code 翻人话。 */
function fail(res, status, code, message) {
  return sendJson(res, status, { ok: false, error: { code, message } });
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** 可选文案：非空字符串才收，其余一律 null（页脚按 null 决定不画这一行）。 */
function textOrNull(value) {
  const text = textOf(value, 200);
  return text ? text : null;
}

function finiteOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 包内图片名：单层、不带斜杠、不以点开头、扩展名只认 `.gif` / `.png`。
 *
 * 这一条同时是「路径穿越」的判据：`..` 段与绝对路径都拼不出这个形状。
 */
function isImageName(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > 120) return false;
  if (name.startsWith('.')) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  return IMAGE_EXT_RE.test(name);
}

/** 按扩展名给媒体类型：只认 gif / png 两种，其余在上一步已经被挡掉了。 */
function mediaTypeOf(name) {
  return /\.gif$/i.test(name) ? 'image/gif' : 'image/png';
}

/** `{w,h}` / `{x,baseline}` 这类小坐标：字段齐且都是有限数才收，缺一个就当没填。 */
function pairOf(value, keys) {
  if (!isRecord(value)) return undefined;
  const out = {};
  for (const key of keys) {
    const number = finiteOf(value[key]);
    if (number === null) return undefined;
    out[key] = number;
  }
  return out;
}

/**
 * 扫包目录里的图片：单层、名字合规矩、不点开头；超限当场返回 null（整包拒收）。
 *
 * 只认普通文件：子目录一律不看（§1 的形状就是一层）。
 */
function scanImages(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = [];
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.') || !isImageName(entry.name)) continue;
    let size;
    try {
      size = fs.statSync(path.join(directory, entry.name)).size;
    } catch {
      continue;
    }
    if (size > MAX_FILE_BYTES) return null;
    total += size;
    files.push({ path: entry.name, size });
    if (files.length > MAX_PACK_FILES || total > MAX_PACK_BYTES) return null;
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

/**
 * 把一份 pack.json 收成内部形状。`entries` 是包里实际有的图片（`[{path, size}]`）。
 *
 * 返回 `{ pack, problems }`：列表那条路只认 `pack`（拿不到就是坏包，静默跳过），写那条路
 * 把 `problems` 原样说给模型听 —— 同一套判据，两种说法。
 */
function buildPack(raw, id, entries) {
  const problems = [];
  if (!isRecord(raw)) return { pack: null, problems: ['pack.json 不是一个对象。'] };

  if (raw.schema !== 1) problems.push('schema 必须是 1。');
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id.trim())) {
    problems.push('id 不合规矩：只认 1-64 位小写字母、数字与连字符，且不以连字符开头。');
  } else if (raw.id.trim() !== id) {
    // id 同时是目录名：写的和所在的目录对不上，这份包到底叫哪个名字就说不清了。
    problems.push(`pack.json 里的 id（"${raw.id.trim()}"）和目录名（"${id}"）对不上。`);
  }
  const name = textOf(raw.name, 80);
  if (!name) problems.push('name 必填（界面上显示的就是它）。');

  const present = new Set(entries.map((entry) => entry.path));

  // states：认识的键才收，文件得真在包里；其余键（以后加的）原样忽略，不是错误。
  const states = {};
  if (!isRecord(raw.states)) {
    problems.push('states 必填，而且至少要有一个 idle。');
  } else {
    for (const key of KNOWN_STATES) {
      const entry = raw.states[key];
      if (!isRecord(entry)) continue;
      const file = textOf(entry.file, 120);
      if (!isImageName(file) || !present.has(file)) continue;
      states[key] = { file };
    }
    if (!states.idle) problems.push('states 里至少要有一个能用的 idle（file 得是包里真有的 .gif / .png）。');
  }

  // tiers.working：按「同时在跑几条」换图，min 从大到小匹配。
  const tiers = {};
  if (isRecord(raw.tiers) && Array.isArray(raw.tiers.working)) {
    const rows = [];
    for (const item of raw.tiers.working) {
      if (!isRecord(item)) continue;
      const min = finiteOf(item.min);
      const file = textOf(item.file, 120);
      if (min === null || min < 1) continue;
      if (!isImageName(file) || !present.has(file)) continue;
      rows.push({ min: Math.floor(min), file });
    }
    rows.sort((a, b) => b.min - a.min);
    if (rows.length > 0) tiers.working = rows;
  }

  const loop = [];
  if (Array.isArray(raw.loop)) {
    for (const item of raw.loop) {
      if (typeof item !== 'string' || !KNOWN_STATES.includes(item) || loop.includes(item)) continue;
      loop.push(item);
    }
  }
  const sleepAfterMs = finiteOf(raw.sleepAfterMs);

  if (problems.length > 0) return { pack: null, problems };

  return {
    pack: {
      id,
      name,
      author: textOrNull(raw.author),
      license: textOrNull(raw.license),
      canvas: pairOf(raw.canvas, ['w', 'h']),
      anchor: pairOf(raw.anchor, ['x', 'baseline']),
      states,
      tiers,
      loop: loop.length > 0 ? loop : [...DEFAULT_LOOP],
      sleepAfterMs: sleepAfterMs !== null && sleepAfterMs > 0 ? sleepAfterMs : undefined,
      size: entries.reduce((sum, entry) => sum + entry.size, 0),
      files: entries,
    },
    problems: [],
  };
}

/** 读一个包目录。不成立就 null（坏包静默跳过这条路的入口）。 */
function readPackAt(root, id, builtin) {
  if (!ID_RE.test(id)) return null;
  const directory = path.join(root, id);
  let stats;
  try {
    stats = fs.statSync(directory);
  } catch {
    return null;
  }
  if (!stats.isDirectory()) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(directory, PACK_FILE), 'utf8'));
  } catch {
    return null;
  }
  const entries = scanImages(directory);
  if (!entries || entries.length === 0) return null;
  const { pack } = buildPack(raw, id, entries);
  if (!pack) return null;
  return { ...pack, builtin, dir: directory };
}

/**
 * 列包：内置在前、用户在后，同 id 的话用户那份顶掉内置那份（`builtin` 变 false）。
 *
 * 哪个目录不在都不算错：用户还没做过宠物的机器上，用户目录根本不存在；素材还没放进去的
 * 构建里，内置目录也不存在 —— 两种都只是「列表里少几个包」。
 */
function listPacks() {
  const byId = new Map();
  for (const id of dirNames(builtinRoot())) {
    const pack = readPackAt(builtinRoot(), id, true);
    if (pack) byId.set(pack.id, pack);
  }
  for (const id of dirNames(rootDir())) {
    const pack = readPackAt(rootDir(), id, false);
    if (pack) byId.set(pack.id, pack);
  }
  const packs = [...byId.values()];
  packs.sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return packs;
}

/** 目录下的一层子目录名。读不到就是空表。 */
function dirNames(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && ID_RE.test(entry.name))
    .map((entry) => entry.name);
}

/** 只留列表要的形状：内部的 `dir` 不出去。 */
function publicPack(pack) {
  return {
    id: pack.id,
    name: pack.name,
    builtin: pack.builtin,
    author: pack.author,
    license: pack.license,
    canvas: pack.canvas,
    anchor: pack.anchor,
    states: pack.states,
    tiers: pack.tiers,
    loop: pack.loop,
    sleepAfterMs: pack.sleepAfterMs,
    size: pack.size,
    files: pack.files,
  };
}

/** 找一个包：用户那份优先，其次内置。 */
function findPack(id) {
  if (!ID_RE.test(id)) return null;
  return readPackAt(rootDir(), id, false) || readPackAt(builtinRoot(), id, true);
}

/**
 * 取一个文件。
 *
 * 判据是「这份包列出来的文件里有没有它」而不是拼路径 —— id 与文件名都已经是不含斜杠的
 * 形状了，再加上这一步，读到的永远是列表里那一张。
 */
function readPackFile(id, name) {
  if (!ID_RE.test(id) || !isImageName(name)) return null;
  const pack = findPack(id);
  if (!pack) return null;
  if (!pack.files.some((file) => file.path === name)) return null;
  let bytes;
  try {
    bytes = fs.readFileSync(path.join(pack.dir, name));
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) return null;
  return { bytes, mediaType: mediaTypeOf(name) };
}

/**
 * 删一个**用户**包。内置包删不掉：它是随发版走的只读素材。
 *
 * 用户目录里没有同 id 的包、而内置里有，回 `forbidden` 而不是 not-found —— App 那边听到的是
 * 「这是内置的」，不是一个看起来像出错的「不在了」。
 */
async function deletePack(id) {
  if (!ID_RE.test(id)) {
    const error = new Error('宠物包 id 不合规矩。');
    error.code = 'bad-request';
    throw error;
  }
  const isDir = (directory) => {
    try {
      return fs.statSync(directory).isDirectory();
    } catch {
      return false;
    }
  };
  if (isDir(path.join(rootDir(), id))) {
    await fsp.rm(path.join(rootDir(), id), { recursive: true, force: true });
    return { builtin: false };
  }
  if (isDir(path.join(builtinRoot(), id))) {
    const error = new Error('这是内置的宠物，删不掉；想换成自己的一份就用同一个 id 写一个用户包。');
    error.code = 'forbidden';
    throw error;
  }
  const error = new Error('没有这个宠物包。');
  error.code = 'not-found';
  throw error;
}

/** 本机路径统一收一遍：绝对路径、`~/`、`file://`，相对地址按当前目录解析。 */
function resolveLocalPath(value) {
  let text = String(value || '').trim();
  if (!text) return null;
  if (text.startsWith('<') && text.endsWith('>')) text = text.slice(1, -1).trim();
  if (/^file:\/\//i.test(text)) {
    try {
      text = decodeURIComponent(text.slice(7));
    } catch {
      return null;
    }
  } else if (text === '~' || text.startsWith('~/')) {
    text = path.join(require('node:os').homedir(), text.slice(1));
  }
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(process.cwd(), text);
}

/**
 * 一项文件的字节：优先读电脑上的那个文件，其次才认 base64。
 *
 * 以 `filePath` 为主：让模型把几 MB 的 base64 写进工具参数里走不通（与公众号那条同一个
 * 理由），它手里真有的是那张图落在盘上的位置。
 */
async function bytesOfItem(item) {
  const fromPath = textOf(item.filePath, 1024);
  if (fromPath) {
    const filePath = resolveLocalPath(fromPath);
    if (!filePath) return null;
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_BYTES) return null;
      return await fsp.readFile(filePath);
    } catch {
      return null;
    }
  }
  const data = typeof item.base64 === 'string' ? item.base64.trim() : '';
  if (!data) return null;
  let bytes;
  try {
    bytes = Buffer.from(data, 'base64');
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) return null;
  return bytes;
}

/**
 * 写一个用户包。
 *
 * 判据与列表那条是同一套（`buildPack`）：先按「盘上已有的图 + 这次给的图」拼出完整的一份，
 * 成立才落盘 —— 不成立就整包不动，不会把原来那份写坏。
 *
 * 覆盖内置 id 是允许的：那是用户明说要改，`overriddenBuiltin` 让工具那条路能告警一句。
 */
async function writePack(input) {
  const id = textOf(input && input.id, 64);
  if (!ID_RE.test(id)) {
    const error = new Error(`宠物包 id 不合规矩（收到 "${id || ''}"）：只认 1-64 位小写字母、数字与连字符，且不以连字符开头。`);
    error.code = 'bad-request';
    throw error;
  }
  if (!isRecord(input.pack)) {
    const error = new Error('pack 必填：整份 pack.json 的对象（至少要有 name 与 states.idle）。');
    error.code = 'bad-request';
    throw error;
  }

  const directory = path.join(rootDir(), id);
  const existing = scanImages(directory) || [];
  const entries = new Map(existing.map((entry) => [entry.path, entry.size]));
  const incoming = [];
  const rejected = [];
  const items = Array.isArray(input.files) ? input.files : [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const name = textOf(item.path, 120);
    if (!isImageName(name)) {
      rejected.push(name || '(没有文件名)');
      continue;
    }
    const bytes = await bytesOfItem(item);
    if (!bytes) {
      rejected.push(name);
      continue;
    }
    entries.set(name, bytes.length);
    incoming.push({ path: name, bytes });
  }

  const scan = [...entries.entries()].map(([file, size]) => ({ path: file, size }));
  if (scan.length > MAX_PACK_FILES) {
    const error = new Error(`一个包最多 ${MAX_PACK_FILES} 个文件，现在会到 ${scan.length} 个。`);
    error.code = 'too-large';
    throw error;
  }
  const total = scan.reduce((sum, entry) => sum + entry.size, 0);
  if (total > MAX_PACK_BYTES) {
    const error = new Error(`整包上限 ${Math.round(MAX_PACK_BYTES / 1024 / 1024)}MB，现在会到 ${(total / 1024 / 1024).toFixed(1)}MB。`);
    error.code = 'too-large';
    throw error;
  }

  const manifest = { ...input.pack, schema: 1, id };
  const built = buildPack(manifest, id, scan);
  if (!built.pack) {
    const error = new Error(`这份 pack.json 还不成立：${built.problems.join(' ')}`);
    error.code = 'bad-pack';
    throw error;
  }

  await fsp.mkdir(directory, { recursive: true });
  for (const file of incoming) {
    await fsp.writeFile(path.join(directory, file.path), file.bytes);
  }
  // 档案最后写、并且先写临时文件再改名：宿主随时可能被杀，半个 JSON 会让这个包从此不出现。
  const tmp = path.join(directory, `${PACK_FILE}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  await fsp.rename(tmp, path.join(directory, PACK_FILE));

  const pack = readPackAt(rootDir(), id, false) || readPackAt(builtinRoot(), id, true);
  return {
    pack,
    rejected,
    written: incoming.map((file) => file.path),
    // 内置里有同 id 的那份：覆盖是允许的（用户明说要改），只是工具那条路该说一句。
    overriddenBuiltin: Boolean(readPackAt(builtinRoot(), id, true)),
  };
}

// ── 路由 ─────────────────────────────────────────────────────────────────────

/** `GET /pet/packs` —— 这台电脑上现有的宠物包（内置 + 用户）。 */
async function handlePackList(_ctx, _req, res) {
  sendJson(res, 200, { ok: true, packs: listPacks().map(publicPack) });
}

/**
 * `GET /pet/pack/file?id=&path=` —— 取一张图（base64 JSON，与 `wechat/media` 同形）。
 *
 * 走 JSON 而不是直接回字节：App 取回来之后要交给原生落地播放，中间还得带鉴权头，形状与
 * 公众号那条一致，也能复用同一套解包。
 */
async function handlePackFile(_ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const id = (url.searchParams.get('id') || '').trim();
  const name = (url.searchParams.get('path') || '').trim();
  if (!ID_RE.test(id) || !isImageName(name)) return fail(res, 400, 'bad-request', '参数不对。');
  const file = readPackFile(id, name);
  if (!file) return fail(res, 404, 'file-not-found', '这个包里没有这张图。');
  sendJson(res, 200, { ok: true, base64: file.bytes.toString('base64'), mediaType: file.mediaType });
}

/** `POST /pet/pack/delete` —— 删一个用户包；内置的回 forbidden。 */
async function handlePackDelete(_ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  if (!isRecord(body)) return fail(res, 400, 'bad-request', '请求体不是对象。');
  const id = textOf(body.id, 64);
  try {
    await deletePack(id);
  } catch (error) {
    const code = error && error.code;
    if (code === 'bad-request') return fail(res, 400, 'bad-request', error.message);
    if (code === 'forbidden') return fail(res, 403, 'forbidden', error.message);
    if (code === 'not-found') return fail(res, 404, 'pack-not-found', error.message);
    return fail(res, 500, 'delete-failed', '没能删掉，稍后重试。');
  }
  sendJson(res, 200, { ok: true, id });
}

module.exports = {
  handlePackList,
  handlePackFile,
  handlePackDelete,
  // 工具那一侧直接用这几个（不经过 HTTP）
  listPacks,
  readPackFile,
  writePack,
  deletePack,
  rootDir,
  builtinRoot,
  isImageName,
  ID_RE,
  KNOWN_STATES,
  MAX_FILE_BYTES,
  MAX_PACK_BYTES,
  MAX_PACK_FILES,
};

'use strict';

/**
 * 「这次的产出」：一屏清单的 stat 补格 + 勾几份打成一个 zip。
 *
 * 两条路由，都只读，都包在 `guarded` 里（见 `routes/mobile-api.js`）：
 *  - `POST /api/mobile/v1/session/artifacts`：给一批路径回 `ok / missing / denied` 三档。
 *    这是「给清单补一格细节」的接口，一条失败只影响那一行，**任何一条都不许变成 4xx**。
 *  - `POST /api/mobile/v1/session/archive`：把勾中的几份现打成一个 zip 字节流回给手机。
 *
 * 两条边界：
 * 1. **放行面与 `/session/file` 完全同一份**：直接调 `session-file.js` 的
 *    `createSessionFileScope`，不在这里另写一遍判定。手机上能 stat / 打包的路径 = 本来就能
 *    下载的那一批（本会话工作区 ∪ 本会话声明过），放开工作区不等于能打包这台电脑上的任意路径。
 * 2. **不把文件整份读进内存**：zip 逐条用 `zlib.createDeflateRaw` 流式压，任何时刻内存里只有
 *    一块。压完先落到 `os.tmpdir()` 的临时文件，拿到确定字节数再边读边发 —— 加密响应的
 *    `content-length` 必须在写头之前知道，而 deflate 之后多大要压完才知道；安卓那个原生下载器
 *    没有 `content-length` 会判成「传输中断」。临时文件在 `finally` 里删，成功失败两条路都删。
 *
 * 单条 denied / missing 只跳过，不使整包失败；一条可用都没有才 404 `empty-archive`。
 *
 * 批量判定 + stat 那一段（`inspectPaths` / `mapLimit`）同时给交付声明的补格
 * （`presented-file-stats.js`）复用：两处读的是同一件事，放行面也必须只有一份。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { sendJson, readJsonBody } = require('../shared/http-util');
const {
  createSessionFileScope,
  writeEncryptedStream,
  encryptedLengthOf,
  dispositionOf,
  FILE_CHUNK_BYTES,
  SESSION_FILE_MAX_BYTES,
} = require('./session-file.js');
const { statFile, setStatForTests } = require('./file-stat.js');

/** 一次最多问多少条：清单本身一屏几十行，200 是给「全选 + 翻过几屏」留的余量。 */
const MAX_ARTIFACT_PATHS = 200;

/**
 * stat 的并发上限。
 *
 * 这条接口的延迟由「最慢的那一条」决定，串行 200 次 stat 能把一次开屏拖成几百毫秒；但真并发
 * 200 条对机械盘 / 网络盘并不友好，而且宿主那边一次开 200 个 fd 也没有必要。8 是「一屏内
 * 基本一轮跑完」与「不把 IO 打满」之间的折中。
 */
const ARTIFACT_STAT_CONCURRENCY = 8;

/**
 * 打包的明文总量上限：与单文件那条同一个 512MB。
 *
 * 判定用的是各条 **stat 出来的 size 之和**，不是压缩后的字节数 —— 压缩比在这里不可预测
 * （文本能压到一成一，已经是 zip 的文档压不动），拿压缩后的数去卡等于把上限交给内容。
 */
const ARCHIVE_MAX_BYTES = SESSION_FILE_MAX_BYTES;

/** 临时 zip 的文件名前缀：测试按它确认「成功与失败两条路上都没留下东西」。 */
const ARCHIVE_TMP_PREFIX = 'dshm-artifacts-';

let tmpSeq = 0;

/** 分档错误信封：与其余移动端接口同形，App 按 code 翻人话。 */
function fail(res, status, code, message) {
  return sendJson(res, status, { ok: false, error: { code, message } });
}

/** 8 位时间戳（年月日）当下载文件名的一部分。 */
function archiveStampOf(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/**
 * 读并收窄 `{ sessionId, paths }`。
 *
 * 去重之后最多 200 条，每条必须是非空字符串。回 `null` 表示已经写过 400 响应 —— 两个 handler
 * 都长一样，收窄只写一份。**空数组不算类型不对**：那两条路由对它的态度不一样（stat 回空清单，
 * 打包 400），所以留给调用方判。
 */
async function readPathsBody(req, res) {
  const body = await readJsonBody(req);
  const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  const raw = body && Array.isArray(body.paths) ? body.paths : null;
  if (!sessionId || !raw) {
    fail(res, 400, 'bad-request', '需要 { sessionId, paths }（paths 是字符串数组）');
    return null;
  }
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string' || item === '') {
      fail(res, 400, 'bad-request', 'paths 里的每一项都必须是非空字符串');
      return null;
    }
    seen.add(item);
  }
  if (seen.size > MAX_ARTIFACT_PATHS) {
    fail(res, 400, 'bad-request', `一次最多 ${MAX_ARTIFACT_PATHS} 条路径，这次给了 ${seen.size} 条`);
    return null;
  }
  return { sessionId, paths: [...seen] };
}

/**
 * 以固定并发跑一遍 `worker`，顺序与 `items` 一致（结果按下标落）。
 *
 * 不排队、不轮询：一个固定大小的「工人池」，每个工人自己从游标里取下一条，取完就结束。
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) workers.push(run());
  await Promise.all(workers);
  return results;
}

/**
 * 逐条判定放行面并 stat。回一条一条对应的结果。
 *
 * 每条结果带 `target`（判过了的落点，打包要接着用）。任何一条的失败都收成它自己的状态：
 * 判定不认 / 读历史失败 → `denied`，盘上没有 / 不是普通文件 → `missing`，都不抛。
 *
 * 导出出去给交付声明的补格（`presented-file-stats.js`）复用：两处读的是同一件事 ——
 * 「这一批路径里哪些认、认了的盘上还在不在、多大、什么时候改的」。放行面也必须是同一份，
 * 所以它只收 `createSessionFileScope` 建出来的作用域，不自己判。
 */
async function inspectPaths(ctx, sessionId, paths) {
  const scope = createSessionFileScope(ctx, sessionId);
  return mapLimit(paths, ARTIFACT_STAT_CONCURRENCY, async (requested) => {
    let target;
    try {
      const decided = await scope.resolve(requested);
      if (!decided.ok) return { path: requested, status: 'denied' };
      target = decided.target;
    } catch {
      // 历史读不出来时不假装「没有声明」：认不了就是认不了，这一行标 denied，整条请求照旧 200。
      return { path: requested, status: 'denied' };
    }
    let info;
    try {
      info = await statFile(target);
    } catch {
      return { path: requested, status: 'missing', target };
    }
    if (!info || typeof info.isFile !== 'function' || !info.isFile()) {
      return { path: requested, status: 'missing', target };
    }
    return {
      path: requested,
      status: 'ok',
      target,
      size: Number(info.size) || 0,
      mtime: Math.round(Number(info.mtimeMs) || 0),
    };
  });
}

/**
 * POST { sessionId, paths } → `{ ok:true, items:[{path, status, size?, mtime?}] }`
 *
 * 给清单补 size / mtime 那一格。**只读**，一条失败只影响那一行，绝不把整条请求打成 4xx。
 */
async function handleSessionArtifacts(ctx, req, res) {
  const body = await readPathsBody(req, res);
  if (!body) return;
  const inspected = await inspectPaths(ctx, body.sessionId, body.paths);
  const items = inspected.map((row) => {
    if (row.status !== 'ok') return { path: row.path, status: row.status };
    return { path: row.path, status: 'ok', size: row.size, mtime: row.mtime };
  });
  sendJson(res, 200, { ok: true, items });
}

/** zip 里一个条目名：只取 basename（避免出现 `../`），同名按 `a.txt` / `a (2).txt` 去重。 */
function entryNameOf(target, taken) {
  const base = path.basename(target) || 'file';
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length) || 'file';
  for (let index = 2; index < 10000; index += 1) {
    const candidate = `${stem} (${index})${ext}`;
    if (taken.has(candidate)) continue;
    taken.add(candidate);
    return candidate;
  }
  // 一万份同名文件在现实里不存在；真到了这里就退回一个不会重复的兜底名。
  const fallback = `${base}-${taken.size + 1}`;
  taken.add(fallback);
  return fallback;
}

// ---- zip 的字节形状 -------------------------------------------------------
//
// 只写 zip 需要的最小结构：逐条 local file header + 数据，最后一份 central directory 与
// end-of-central-directory。不用系统的 `zip` 命令（那要多起一个进程、还要假设三个平台都装了
// 它），也不引第三方压缩库：deflate 由 `node:zlib` 出，crc32 就是下面这张表。

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
/** 通用标志的第 11 位：条目名是 UTF-8。中文文件名不加它就是一堆乱码。 */
const ZIP_FLAG_UTF8 = 0x0800;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_VERSION = 20;

/** crc32 的查表（IEEE 802.3 反射多项式）。表只算一次。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** 增量 crc32：`previous` 传上一次的结果，初值 0。 */
function crc32Update(previous, chunk) {
  let value = (previous ^ 0xffffffff) >>> 0;
  for (let index = 0; index < chunk.length; index += 1) {
    value = CRC_TABLE[(value ^ chunk[index]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/** DOS 时间戳（zip 的老格式，1980 起算、2 秒粒度）。mtime 取不到就写 0。 */
function dosDateTime(mtimeMs) {
  const date = new Date(Number(mtimeMs) || 0);
  if (Number.isNaN(date.getTime()) || date.getFullYear() < 1980) return { time: 0, date: 0 };
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** 顺序追加一段字节到当前打开的文件末尾。 */
async function appendBytes(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    offset += bytesWritten;
  }
}

/**
 * 写一个条目：local header + 流式 deflate 出来的数据。
 *
 * header 里的 crc / 压缩长度 / 原始长度先留 0，压完之后用 pwrite 回来补 —— 这样不必把整份
 * 压缩结果攒在内存里等长度，也不必用 data descriptor（那对某些解压器更挑）。
 *
 * 读文件的流在 `pipeline` 前一刻才建：早建的话「盘上没有这个文件」的 error 事件会在写到
 * 一半的 await 之间先冒出来，变成没人接的 uncaught（而这一发本该是干净的一次 500）。
 *
 * @returns {Promise<{crc:number, compressed:number, size:number, offset:number}>}
 */
async function writeZipEntry(handle, offset, target, name, mtimeMs) {
  const nameBytes = Buffer.from(name, 'utf8');
  const stamp = dosDateTime(mtimeMs);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(ZIP_LOCAL_SIG, 0);
  header.writeUInt16LE(ZIP_VERSION, 4);
  header.writeUInt16LE(ZIP_FLAG_UTF8, 6);
  header.writeUInt16LE(ZIP_METHOD_DEFLATE, 8);
  header.writeUInt16LE(stamp.time, 10);
  header.writeUInt16LE(stamp.date, 12);
  // 14..21 是 crc / 压缩长度 / 原始长度，压完补。
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  await appendBytes(handle, header);
  await appendBytes(handle, nameBytes);

  // 边读边数：crc 与原始长度都在数据流经时算，压缩长度在写盘时数。
  const meter = { crc: 0, size: 0 };
  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      meter.crc = crc32Update(meter.crc, chunk);
      meter.size += chunk.length;
      callback(null, chunk);
    },
  });
  let compressed = 0;
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      compressed += chunk.length;
      appendBytes(handle, chunk).then(() => callback(), callback);
    },
  });
  // 这一条从打开文件到压完都在这里：任何一步抛（盘上没有、读失败、写满）都由调用方兜成
  // 一次请求级的失败，而不是让一条坏文件把整包拖成半截。
  await pipeline(fs.createReadStream(target, { highWaterMark: FILE_CHUNK_BYTES }), tap, zlib.createDeflateRaw(), sink);

  const patch = Buffer.alloc(12);
  patch.writeUInt32LE(meter.crc, 0);
  patch.writeUInt32LE(compressed, 4);
  patch.writeUInt32LE(meter.size, 8);
  await handle.write(patch, 0, patch.length, offset + 14);

  return { crc: meter.crc, compressed, size: meter.size, offset };
}

/**
 * 把一批文件打成一份 zip 落在临时文件里，**回它的字节数**。
 *
 * 之所以要两段：加密响应的 `content-length` 必须在 `writeHead` 之前算出来，而 deflate 之后
 * 多大要压完才知道。临时文件是这两段之间唯一的落点 —— 内存里始终只有一块。
 */
async function buildZipToFile(tmpPath, entries) {
  const handle = await fs.promises.open(tmpPath, 'wx');
  try {
    const written = [];
    let offset = 0;
    // **必须串行**：`appendBytes` 不带 position，靠的是「文件当前写指针往后追加」，而写指针只有
    // 一条。并发写两条就会互相插进对方的字节中间，产出的是结构合法、内容错位的 zip。
    // 补 crc 那一处相反，是带 position 的定点写（见 `writeZipEntry` 末尾），并发也无所谓。
    for (const entry of entries) {
      const row = await writeZipEntry(handle, offset, entry.target, entry.name, entry.mtime);
      written.push({ ...row, name: entry.name, mtime: entry.mtime });
      // local header 30 字节 + 名字 + 压缩数据
      offset = row.offset + 30 + Buffer.byteLength(entry.name, 'utf8') + row.compressed;
    }

    const centralStart = offset;
    let centralSize = 0;
    for (const row of written) {
      const nameBytes = Buffer.from(row.name, 'utf8');
      const record = Buffer.alloc(46);
      record.writeUInt32LE(ZIP_CENTRAL_SIG, 0);
      record.writeUInt16LE(ZIP_VERSION, 4);
      record.writeUInt16LE(ZIP_VERSION, 6);
      record.writeUInt16LE(ZIP_FLAG_UTF8, 8);
      record.writeUInt16LE(ZIP_METHOD_DEFLATE, 10);
      const stamp = dosDateTime(row.mtime);
      record.writeUInt16LE(stamp.time, 12);
      record.writeUInt16LE(stamp.date, 14);
      record.writeUInt32LE(row.crc, 16);
      record.writeUInt32LE(row.compressed, 20);
      record.writeUInt32LE(row.size, 24);
      record.writeUInt16LE(nameBytes.length, 28);
      // 30..41 的额外字段 / 注释 / 磁盘号 / 属性都留 0，最后是 local header 的偏移。
      record.writeUInt32LE(row.offset, 42);
      await appendBytes(handle, record);
      await appendBytes(handle, nameBytes);
      centralSize += record.length + nameBytes.length;
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(ZIP_EOCD_SIG, 0);
    end.writeUInt16LE(written.length, 8);
    end.writeUInt16LE(written.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    await appendBytes(handle, end);

    return centralStart + centralSize + end.length;
  } finally {
    await handle.close();
  }
}

/** 一个临时 zip 的落点。带 pid 与进程内序号，测试按前缀就能认出自己的那些。 */
function tmpZipPathOf() {
  tmpSeq += 1;
  return path.join(os.tmpdir(), `${ARCHIVE_TMP_PREFIX}${process.pid}-${Date.now()}-${tmpSeq}.zip`);
}

/** 删临时文件：成功与失败两条路都要走，删不掉也不影响这一发的结果。 */
async function removeQuietly(target) {
  try {
    await fs.promises.rm(target, { force: true });
  } catch {
    /* 临时文件删不掉就交给系统的清理策略，不因为这一下把响应改掉 */
  }
}

/**
 * POST { sessionId, paths } → zip 字节流。
 *
 * 头部形状与 `/session/file` 一致：明文会话回 `application/zip` + 准确 `content-length`；
 * 协议 v2 回分块信封 + `encryptedLengthOf(zipSize)`，`x-dsh-file-size` 给的是**zip 的**大小。
 */
async function handleSessionArchive(ctx, req, res) {
  const body = await readPathsBody(req, res);
  if (!body) return;
  // 空的 paths 是调用方写错了（界面上「打包选中的 N 份」在 N=0 时不会发），不是「没东西可打」。
  if (body.paths.length === 0) {
    return fail(res, 400, 'bad-request', 'paths 是空的，没有要打包的路径');
  }

  const inspected = await inspectPaths(ctx, body.sessionId, body.paths);
  const usable = inspected.filter((row) => row.status === 'ok');

  const totalBytes = usable.reduce((sum, row) => sum + row.size, 0);
  if (totalBytes > ARCHIVE_MAX_BYTES) {
    return fail(res, 413, 'too-large', `这几份加起来 ${totalBytes} 字节，超过单次打包上限 ${ARCHIVE_MAX_BYTES}`);
  }

  const taken = new Set();
  const entries = usable.map((row) => ({
    target: row.target,
    name: entryNameOf(row.target, taken),
    mtime: row.mtime,
  }));
  // 全部 missing / denied 时连临时文件都不建：一个空 zip 解出来什么都没有，手机上会以为
  // 「打是打成功了，但里面是空的」，而那与「这些都打不开了」是两件事。
  if (entries.length === 0) {
    return fail(res, 404, 'empty-archive', '没有可打包的文件：这些路径现在都不在这台电脑上了');
  }

  const tmpPath = tmpZipPathOf();
  let zipSize;
  try {
    // 先把 zip 完整压进临时文件，拿到确定字节数 —— 加密响应的 content-length 必须在写头之前知道。
    try {
      zipSize = await buildZipToFile(tmpPath, entries);
    } catch (error) {
      return fail(res, 500, 'archive-failed', `打包失败：${String((error && error.message) || error).slice(0, 200)}`);
    }

    const filename = `dsh-artifacts-${archiveStampOf()}.zip`;
    const header = {
      'content-type': 'application/zip',
      'content-disposition': dispositionOf(filename),
      'cache-control': 'no-store',
    };

    const opened = req && req.__dshE2ee;
    if (opened && opened.keys && opened.req) {
      res.writeHead(200, {
        ...header,
        'content-type': 'application/x-dsh-e2ee-chunks',
        'content-length': String(encryptedLengthOf(zipSize)),
        // 这一格是**解密之后**那份 zip 有多大，不是线上字节数：客户端拿它判「到底收全没有」。
        'x-dsh-file-size': String(zipSize),
        'x-dsh-proto': '2',
        'x-dsh-content-type': 'application/zip',
      });
      const stream = fs.createReadStream(tmpPath);
      res.on('close', () => stream.destroy());
      await writeEncryptedStream(req, res, stream);
      return;
    }

    res.writeHead(200, { ...header, 'content-length': String(zipSize) });
    const stream = fs.createReadStream(tmpPath);
    res.on('close', () => stream.destroy());
    try {
      await pipeline(stream, res);
    } catch {
      // 头已经发出去了，改不了状态码，只能断开让对端按截断处理（与 `/session/file` 一致）。
      try { res.destroy(); } catch { /* 连接已关闭 */ }
    }
  } finally {
    // 成功、打包失败、发送中途被掐断，三条路都在这里把临时 zip 删掉。
    await removeQuietly(tmpPath);
  }
}

module.exports = {
  handleSessionArtifacts,
  handleSessionArchive,
  MAX_ARTIFACT_PATHS,
  ARTIFACT_STAT_CONCURRENCY,
  ARCHIVE_MAX_BYTES,
  ARCHIVE_TMP_PREFIX,
  // 纯逻辑（守卫直接加载）
  crc32Update,
  entryNameOf,
  archiveStampOf,
  // 批量判定 + stat：交付声明补格（`presented-file-stats.js`）复用同一份，
  // 放行面因此与 `/session/file`、打包那条**完全重合**。
  mapLimit,
  inspectPaths,
  // 测试注入：假 stat（真跑时一直是 node:fs/promises 的 stat）
  __setStatForTests: setStatForTests,
};

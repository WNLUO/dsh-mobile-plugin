'use strict';

/**
 * 移动端文件分片上传：把手机分享进来的文件落到宿主机的收件目录，或落到指定的那个目录。
 *
 * 四步：begin（登记文件名，拿 uploadId 与片大小）→ chunk（按 index 顺序追加）→ finish
 * （落盘成 `<收件根>/<日期>/<文件名>`，重名自动加后缀）→ abort（放弃）。
 *
 * 落点两条路：不带 `destPath` 时仍进固定收件箱（分享进来的文件本来就没有归处，攥在
 * `~/.dsh/mobile-inbox` 里等用户自己搬）；带 `destPath` 时落进那个目录 —— 右栏文件浏览器
 * 「传到这里」要的就是它。后者必须在 `allowed-zone.js` 的允许区内（工作区 ∪ 当前会话项目
 * 目录），能力面与按路径读文件同一份判据，写入不可能比读更宽。
 *
 * 分片而不是一次传完：单请求因此与中转的 `MAX_BODY_BYTES`、readJsonBody 的 256KB 上限无关，
 * 手机网络不稳时也能只重传坏掉的那一片。片内容走 base64 而不是原始字节：App 侧没有发二进制
 * body 的先例，图片通道本来就以 base64 走 JSON；代价是 33% 膨胀，仍远低于各层上限。
 *
 * 顺序与幂等：chunk 只接受下一片，重复送达同一片按重传处理，跳号直接 409。
 *
 * v3（`caps.wire === 'bin'`，见 docs/native-upload.md 的 v3 章）：请求体换成裸密文，一片
 * 按**字节偏移**收、允许乱序，靠一个按偏移排序的待拼窗口把连续的部分落盘。协商进去的 job
 * 走这条路；老客户端没有 `caps`，仍走上面那套按 index 的口径 —— 两条路靠 job 上记的 wire
 * 分流，不做「猜」。
 *
 * 图片走两段：先按上面那套把字节传完拿 uploadId，`session/send` 再把 uploadId 换回内联
 * base64 交给宿主 prompt。换的时候整份字节要读进内存 —— 宿主只认内联块，这条通道没有流式
 * 入口。也正因为如此，单张图片的大小上限由桌面端的附件限制定，这里不设体积门槛。
 *
 * 收件根固定 `~/.dsh/mobile-inbox`，与工作区解耦（工作区被删不影响已收到的文件）；
 * `DSH_MOBILE_INBOX` 可覆盖，只给测试用。
 *
 * 落盘那一段（finish 里判候选名 + rename）进 `project-write-queue.js` 的项目级单写者队列，
 * 键与 `file-ops.js` 同一个算法（`queueKeyOf`）。分片阶段不排队：那是往暂存文件追加字节，
 * 不碰任何用户看得见的落点。finish 在排队与落盘期间保留身份，同一上传的重试共用结果；
 * 指定目录跨卷时只对 EXDEV 改用复制，复制完成后才清暂存。
 */

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { sendJson, readJsonBody, readRawBody } = require('../shared/http-util');
// 头名的大小写不保证（中转会压成小写，Node 版本之间也有差异），复用信封那一份读法。
const { headerOf } = require('../shared/e2ee-request');
const { allowedRoots, inAllowedZone } = require('./allowed-zone.js');
const { withProjectWrite, queueKeyOf } = require('./project-write-queue.js');

// 片大小的**起步值** 256KB（base64 后约 341KB）：客户端一次请求的硬预算是 8s
// （`app/src/api/core.ts` 的 REQUEST_TIMEOUT_MS），一上来就给大片的机器会在慢速上行
// 网络上撞超时。客户端从这一档起步、按实测周期自己往上爬，爬到 `CHUNK_MAX_BYTES` 为止 ——
// 局域网里能一路放大，公网上爬两下就停住。所以 begin 回的是「起步值 + 上限」两个数，
// 不是「就传这么大」。
const CHUNK_BYTES = 256 * 1024;
// 片大小的上限（原始字节）：base64 后约 2.73MB，仍在下面 8MB 的请求体预算内。
const CHUNK_MAX_BYTES = 2 * 1024 * 1024;
/**
 * 单片请求体上限（**明文**字节）：4MB base64 后约 5.33MB，再按 §8.3(9) 的 4/3 信封
 * 放大到 11MB —— 按线上长度直接卡 8MB 等于悄悄砍掉四分之一的可用额度。
 */
const CHUNK_MAX_BODY = Math.ceil(8 * 1024 * 1024 * 4 / 3);
/**
 * v3（二进制分片体）的片长：起步 4MB、天花板 6MB。
 *
 * 天花板的来历是**中转隧道单帧 8MB**：v3 一片的线上字节只是明文加 AEAD 的 12 字节 nonce
 * 与 16 字节 tag（不 base64、不套 JSON），所以 6MB 明文装得进一帧还留出信封余量。v2 只能到
 * 2MB 是因为同一份字节被 base64 了两遍（片一次、整条信封再一次），1.78 倍膨胀先把额度吃了。
 */
const BIN_CHUNK_BYTES = 4 * 1024 * 1024;
const BIN_CHUNK_MAX_BYTES = 6 * 1024 * 1024;
/** 同时在飞的片数缺省值：再小就藏不掉高延迟链路上的一片空等。 */
const BIN_PIPELINE = 4;
/**
 * 客户端给的 pipeline 最多认到 8：它是内存与窗口的乘数，没有理由跟着请求往上翻。
 *
 * 窗口的字节上限由它乘出来（片数 × 片长）：窗口只需要装下「在飞的那几片」，再大等于给一个
 * 发疯的客户端留一块几十 MB 的无主内存。乘出来的那个数就是 `begin` 回给客户端的那一格。
 */
const BIN_PIPELINE_MAX = 8;
/** 文件名上限（按字符算，避开各文件系统的字节上限差异）。 */
const NAME_MAX_CHARS = 120;
/**
 * 暂存残片的最长寿命：手机上传中断后没人来 abort 的清理依据。
 *
 * 7 天，跟着手机侧的续传凭据走：凭据活多久，暂存就得留多久，否则手机回来续传的第一片必撞
 * 404（判据见 `app/src/services/viewmodels/upload-resume.ts` 的 `HOST_STAGING_TTL_MS`）。
 */
const STAGING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 分片必须是标准 base64：Node 的 Buffer.from 会静默丢弃非法字符，光靠解码判不出坏片。 */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * 刚落盘的上传：uploadId → { path, name, bytes, at }。
 *
 * 存在的理由：`session/send` 以前只认内联 base64 的图片块，一张 4MB 照片线上要
 * 7MB 左右，而那条请求的预算只有 8 秒 —— 大图必超时。现在图片先走分片上传（每片都
 * 落在预算内），再在 send 里用 uploadId 换字节。这张表就是那个「换」的凭据。
 *
 * 只在内存里、30 分钟过期、条数封顶：过期之后手机重传一次就行，不留长期文件索引。
 */
const finishedUploads = new Map();
const FINISHED_TTL_MS = 30 * 60 * 1000;
const FINISHED_MAX = 64;

function rememberFinishedUpload(uploadId, record) {
  if (!uploadId) return;
  finishedUploads.set(uploadId, { ...record, at: Date.now() });
  if (finishedUploads.size > FINISHED_MAX) {
    const oldest = [...finishedUploads.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, finishedUploads.size - FINISHED_MAX);
    for (const [key] of oldest) finishedUploads.delete(key);
  }
}

/**
 * 按 uploadId 取刚落盘的上传。过期 / 不存在返回 null。
 *
 * 记录带 `path`（图片内联要用它），能原样回放给重收一次口的客户端。
 *
 * @returns {{ path?: string, name: string, bytes: number } | null}
 */
function resolveFinishedUpload(uploadId) {
  const id = String(uploadId || '');
  const record = finishedUploads.get(id);
  if (!record) return null;
  if (Date.now() - record.at > FINISHED_TTL_MS) {
    finishedUploads.delete(id);
    return null;
  }
  const { at, ...rest } = record;
  return rest;
}

/**
 * 进行中的上传：uploadId → job。
 *
 * 两种 wire 共用这张表，靠 job 上的 `wire` 分流（`json` 是老行为，`bin` 是 v3）：
 *  - json：`received` 是**片数**，chunk 只吃下一片。
 *  - bin：`receivedBytes` 是**已连续落盘的字节数**，片按偏移收，乱序的先进 `window`。
 */
const uploads = new Map();

function removeUpload(uploadId, job) {
  if (uploads.get(uploadId) !== job) return false;
  uploads.delete(uploadId);
  if (job.expiryTimer) clearTimeout(job.expiryTimer);
  job.expiryTimer = null;
  // 待拼窗口是纯内存的片缓冲：job 从 Map 摘掉之后还可能被定时器闭包抓着，不清的话一次
  // 中断的大文件能让几十 MB 多活到进程退出（`unlink` 只管暂存文件，管不到这些 Buffer）。
  if (job.window) {
    job.window.length = 0;
    job.pendingWindowBytes = 0;
  }
  return true;
}

async function expireUpload(uploadId, job) {
  if (uploads.get(uploadId) !== job || job.finishPromise) return;
  const remaining = job.expiresAt - Date.now();
  if (remaining > 0) {
    job.expiryTimer = setTimeout(() => { void expireUpload(uploadId, job); }, remaining);
    job.expiryTimer.unref?.();
    return;
  }
  if (!removeUpload(uploadId, job)) return;
  try { await fsp.unlink(job.stagingPath); } catch { /* 暂存文件可能已由磁盘清扫移除 */ }
}

function scheduleUploadExpiry(uploadId, job) {
  if (job.expiryTimer) clearTimeout(job.expiryTimer);
  job.expiryTimer = setTimeout(() => { void expireUpload(uploadId, job); }, Math.max(0, job.expiresAt - Date.now()));
  job.expiryTimer.unref?.();
}

/** 清理过期上传状态及其暂存文件；传入 now 便于测试 TTL 边界。 */
async function sweepExpiredUploads(now = Date.now()) {
  await Promise.all([...uploads].map(async ([uploadId, job]) => {
    if (job.finishPromise || job.expiresAt > now || !removeUpload(uploadId, job)) return;
    try { await fsp.unlink(job.stagingPath); } catch { /* 暂存文件可能已由磁盘清扫移除 */ }
  }));
}

/** 收件根目录。每次取用都重算，好让测试用环境变量分派。 */
function inboxRoot() {
  const override = process.env.DSH_MOBILE_INBOX;
  return override ? path.resolve(override) : path.join(os.homedir(), '.dsh', 'mobile-inbox');
}

/**
 * 清成一个能安全当作文件名的名字：去掉路径成分、文件系统保留字符与控制字符，
 * 压掉连续空白，掐掉前导点（避免生成隐藏文件），并限长（保住扩展名）。
 */
function sanitizeName(raw) {
  const base = path.basename(String(raw == null ? '' : raw).replace(/\\/g, '/'));
  const cleaned = base
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned) return '未命名文件';
  if (cleaned.length <= NAME_MAX_CHARS) return cleaned;
  const ext = path.extname(cleaned).slice(0, 16);
  return cleaned.slice(0, NAME_MAX_CHARS - ext.length) + ext;
}

/** 本地日期 yyyy-mm-dd（收件目录按天分堆，`os` 本地时区更贴近「今天收到的」）。 */
function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 在 dir 下给 name 找一个不冲突的落点（`名字-1.ext`、`名字-2.ext`…）。 */
async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length) || '未命名文件';
  for (let i = 0; i < 200; i += 1) {
    const candidate = path.join(dir, i === 0 ? name : `${stem}-${i}${ext}`);
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

/**
 * 清掉过期残片；尽力而为，失败不影响本次上传。
 *
 * 返回删掉了几个、腾了多少字节 —— `begin` 那条路不看它（`void` 掉），但收件目录的清理
 * 与占用读数要拿它报数，所以别改成只在内部记账。
 *
 * **这条清扫只在 `begin` 时跑**：手机不再上传的那台机器上，残片就一直躺着（实测过：
 * 一份 12MB 的 `.part` 从 10-20 睡到今天）。所以 `mobile/inbox-clean.js` 的清理与启动
 * 收尾也会调它，TTL 判据只有这一份。
 */
async function sweepStaging(stagingDir) {
  let entries;
  try {
    entries = await fsp.readdir(stagingDir, { withFileTypes: true });
  } catch {
    return { deleted: 0, bytes: 0 };
  }
  const cutoff = Date.now() - STAGING_TTL_MS;
  const removed = await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !entry.name.endsWith('.part')) return null;
    // finish 可能被项目暂停留在队列里，不能按暂存 mtime 把它仍要落盘的片扫掉。
    if (uploads.get(entry.name.slice(0, -5))?.finishPromise) return null;
    const target = path.join(stagingDir, entry.name);
    try {
      const stat = await fsp.stat(target);
      if (stat.mtimeMs >= cutoff) return null;
      await fsp.unlink(target);
      return stat.size;
    } catch {
      // 已被别人清掉，或者删不掉：都不算这次腾出来的量。
      return null;
    }
  }));
  const sizes = removed.filter((size) => typeof size === 'number');
  return { deleted: sizes.length, bytes: sizes.reduce((sum, size) => sum + size, 0) };
}

function fail(res, status, code, message) {
  return sendJson(res, status, { ok: false, error: { code, message } });
}

/**
 * begin 里那个可选落点：解析、判允许区、确认它是个**已经存在的目录**。
 *
 * 返回 `{ dir }`（字符串，未指定时为空串）或 `{ status, code, message }`。目录不存在与
 * 「不是目录」都按 400 报：这条路上 404 只留给 uploadId，混用会让 App 把「目录没了」
 * 当成「上传丢了」，从而把一个还在的上传重投一遍。
 *
 * `sessionId` 与 `/file/read` 同义：给上它，这条会话的项目目录也算在允许区里（右栏那份
 * 「当前目录」未必被登记成了工作区）。
 */
async function resolveDestDir(ctx, body) {
  if (body.destPath === undefined || body.destPath === null) return { dir: '' };
  if (typeof body.destPath !== 'string' || !body.destPath.trim()) {
    return { status: 400, code: 'bad-request', message: 'destPath 必须是绝对目录路径' };
  }
  const asked = body.destPath.trim();
  if (!path.isAbsolute(asked)) {
    return { status: 400, code: 'bad-request', message: 'destPath 必须是绝对路径' };
  }
  const dir = path.resolve(asked);
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  let roots;
  try {
    roots = await allowedRoots(ctx, sessionId);
  } catch (error) {
    return {
      status: 502,
      code: (error && error.code) || 'workspace-list-failed',
      message: String((error && error.message) || error),
    };
  }
  if (!inAllowedZone(roots, dir)) {
    return {
      status: 403,
      code: 'outside-allowed',
      message: '这个目录不在能写的范围里（只放行工作区目录和这条会话的项目目录）',
    };
  }
  // 根数组跟着落点一起带回去：finish 落盘时要拿它算写队列的键，而那时候再调一次宿主
  // 工作区清单既慢又可能失败（失败就得改错误码）。判允许区用的和算队列键用的是同一份根。
  let info;
  try {
    info = await fsp.stat(dir);
  } catch {
    info = null;
  }
  if (!info || !info.isDirectory()) {
    return { status: 400, code: 'not-a-directory', message: 'destPath 不是一个已经存在的目录' };
  }
  return { dir, roots };
}

/**
 * begin 里的能力协商（v3）。
 *
 * **只有明确说了 `caps.wire === 'bin'` 才进 v3**：老 App 一个字段都不带，`caps` 为空，
 * 于是它拿到的是和从前一模一样的响应，走的也是从前那条代码路径。
 *
 * v3 必须同时给出 `size`（总字节数）：收口时要靠它证明「字节齐了」，没有它就没法区分
 * 「一次传完」和「少了一片但客户端以为传完了」。
 *
 * @returns {{ wire: 'json' } | { wire: 'bin', pipeline: number, windowBytes: number, windowPieces: number, total: number }
 *          | { status: number, code: string, message: string }}
 */
function resolveCaps(body) {
  const caps = body.caps && typeof body.caps === 'object' ? body.caps : null;
  if (!caps || caps.wire !== 'bin') return { wire: 'json' };
  // 只认真的数字：`null` 会被 Number() 悄悄变成 0，那等于把「没给」当成「传了个空文件」。
  const size = body.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    return { status: 400, code: 'bad-request', message: '二进制分片需要 { size }（总字节数）' };
  }
  const asked = Number(caps.pipeline);
  const pipeline = Number.isInteger(asked) && asked > 0 ? Math.min(asked, BIN_PIPELINE_MAX) : BIN_PIPELINE;
  return {
    wire: 'bin',
    pipeline,
    windowBytes: pipeline * BIN_CHUNK_MAX_BYTES,
    // 与字节上限并行的第二道封顶：一片只有几字节时，光靠字节数能塞进几千片。
    windowPieces: Math.max(4, pipeline * 2),
    total: size,
  };
}

/** POST /api/mobile/v1/upload/begin { name, size?, destPath?, sessionId?, caps? } → { ok, uploadId, chunkSize, maxChunkSize, … }。 */
async function handleUploadBegin(ctx, req, res) {
  const body = await readJsonBody(req);
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    return fail(res, 400, 'bad-request', '需要 { name }');
  }
  const caps = resolveCaps(body);
  if (caps.status) return fail(res, caps.status, caps.code, caps.message);
  // 落点先判：越界 / 不是目录在这一步就回，不先建暂存再报错 —— 残片要躺满 7 天才清。
  const destination = await resolveDestDir(ctx, body);
  if (destination.status) return fail(res, destination.status, destination.code, destination.message);
  const stagingDir = path.join(inboxRoot(), '.staging');
  try {
    await fsp.mkdir(stagingDir, { recursive: true });
  } catch (error) {
    return fail(res, 500, 'inbox-unavailable', `收件目录不可用：${error.message}`);
  }
  void sweepStaging(stagingDir);
  void sweepExpiredUploads();

  const uploadId = crypto.randomUUID();
  const stagingPath = path.join(stagingDir, `${uploadId}.part`);
  try {
    await fsp.writeFile(stagingPath, Buffer.alloc(0));
  } catch (error) {
    return fail(res, 500, 'inbox-unavailable', `无法建立暂存文件：${error.message}`);
  }
  const job = {
    name: sanitizeName(body.name),
    // 指定落点就记在这里，finish 才用得上（中途不再判一次范围：begin 已经认过）。
    destDir: destination.dir,
    // begin 那一步算出来的允许区根：finish 落盘要拿它算写队列的键（见 `queueKeyOf`），
    // 与 `file-ops.js` 同一个口径。收件箱那条路没有落点根，留空数组。
    destRoots: destination.roots || [],
    stagingPath,
    // 老路径（json）的两个计数器；v3 另起 `receivedBytes`，两者语义不同，不混用同一格。
    received: 0,
    bytes: 0,
    wire: caps.wire,
    // v3 才有意义：偏移收片的账、待拼窗口与它的两块封顶。
    receivedBytes: 0,
    total: caps.wire === 'bin' ? caps.total : 0,
    pipeline: caps.wire === 'bin' ? caps.pipeline : 0,
    windowBytes: caps.wire === 'bin' ? caps.windowBytes : 0,
    windowPieces: caps.wire === 'bin' ? caps.windowPieces : 0,
    window: [],
    pendingWindowBytes: 0,
    expiresAt: Date.now() + STAGING_TTL_MS,
    expiryTimer: null,
  };
  uploads.set(uploadId, job);
  scheduleUploadExpiry(uploadId, job);
  // chunkSize 是起步值、maxChunkSize 是天花板：客户端从前者开始按实测周期往上爬。
  //
  // 老客户端（没协商 caps）拿到的是**和从前逐字节相同**的那五个字段：多一个 `wire` 都会
  // 让「不带 caps 就走 v2」这条承诺落空，所以 v3 的字段只在真协商成功时追加。
  if (caps.wire === 'bin') {
    return sendJson(res, 200, {
      ok: true,
      uploadId,
      chunkSize: BIN_CHUNK_BYTES,
      maxChunkSize: BIN_CHUNK_MAX_BYTES,
      wire: 'bin',
      pipeline: job.pipeline,
      windowBytes: job.windowBytes,
    });
  }
  sendJson(res, 200, { ok: true, uploadId, chunkSize: CHUNK_BYTES, maxChunkSize: CHUNK_MAX_BYTES });
}

/**
 * 把一片按偏移接到暂存文件末尾，**只追加 `receivedBytes` 之后的那部分**。
 *
 * 「只追加尾巴」是为了容忍客户端切片的边界与上一片重叠：重叠字节已经在盘上了，再追加一遍
 * 就把文件写坏（大文件里表现为某一段重复，且字节数悄悄变多）。返回写入字节数，0 表示这片
 * 整段落在已收区间内。
 */
async function appendPiece(job, offset, data) {
  const skip = job.receivedBytes - offset;
  if (skip >= data.length) return 0;
  const tail = skip > 0 ? data.subarray(skip) : data;
  await fsp.appendFile(job.stagingPath, tail);
  job.receivedBytes += tail.length;
  // finish 落盘报的 `bytes` 与 json 分支同一个字段：两条 wire 的收口代码因此只差那一句判据。
  job.bytes = job.receivedBytes;
  return tail.length;
}

/** 顺着窗口把接得上的后续片一并落盘（它们的偏移正好从 `receivedBytes` 开始）。 */
async function flushWindow(job) {
  let wrote = false;
  while (job.window.length) {
    const next = job.window[0];
    if (next.offset > job.receivedBytes) break;
    job.window.shift();
    job.pendingWindowBytes -= next.data.length;
    if (await appendPiece(job, next.offset, next.data)) wrote = true;
  }
  return wrote;
}

/**
 * v3 的一条二进制分片：`X-Dsh-Wire: bin` + `X-Dsh-Upload-Id` + `X-Dsh-Upload-Offset`，
 * 请求体是这一片的裸密文（守卫已解成 `req.rawBody` 里的明文）。
 *
 * 偏移三分法（见 docs/native-upload.md 的「偏移与窗口」）：
 *  - `offset < receivedBytes`：整片已收过 → 200 幂等；跨过边界 → 400 `bad-offset`。
 *  - `offset === receivedBytes`：追加，并顺着窗口把接得上的后续片一起落盘。
 *  - `offset > receivedBytes`：进窗口等前面补齐；窗口按字节数或积压片数封顶 → 409。
 */
async function handleBinChunk(req, res) {
  const uploadId = headerOf(req, 'x-dsh-upload-id').trim();
  const job = uploads.get(uploadId);
  if (!job || job.finishPromise) return fail(res, 404, 'unknown-upload', '上传会话不存在或已结束');
  // 同一 job 中途换 wire 一律拒：两种 wire 的 `received` 一个数片、一个数字节，混着收
  // 会拼出一个对不上账的暂存文件，而客户端还以为自己在续传。
  if (job.wire !== 'bin') {
    return fail(res, 400, 'wire-mismatch', '这个上传是按 JSON 分片协商的，不能混发二进制分片');
  }

  const offsetText = headerOf(req, 'x-dsh-upload-offset').trim();
  const offset = Number(offsetText);
  if (!/^\d+$/.test(offsetText) || !Number.isSafeInteger(offset)) {
    return fail(res, 400, 'bad-offset', 'X-Dsh-Upload-Offset 必须是非负整数');
  }
  const piece = await readRawBody(req, BIN_CHUNK_MAX_BYTES);
  if (!piece) return fail(res, 413, 'too-large', '分片过大');
  if (!piece.length) return fail(res, 400, 'bad-offset', '分片不能是空的');

  const end = offset + piece.length;
  if (offset < job.receivedBytes) {
    if (end <= job.receivedBytes) return sendJson(res, 200, { ok: true, received: job.receivedBytes });
    return fail(res, 400, 'bad-offset', `这一片跨过了已收边界（已收 ${job.receivedBytes} 字节）`);
  }

  if (offset === job.receivedBytes) {
    try {
      await appendPiece(job, offset, piece);
      await flushWindow(job);
    } catch (error) {
      removeUpload(uploadId, job);
      return fail(res, 500, 'inbox-unavailable', `写入暂存文件失败：${error.message}`);
    }
    job.expiresAt = Date.now() + STAGING_TTL_MS;
    scheduleUploadExpiry(uploadId, job);
    return sendJson(res, 200, { ok: true, received: job.receivedBytes });
  }

  // 到这里就是乱序：这一片比已连续落盘的字节跑得靠后，先攒着。
  const existing = job.window.find((entry) => entry.offset === offset);
  const added = existing ? piece.length - existing.data.length : piece.length;
  if (
    job.pendingWindowBytes + added > job.windowBytes
    || (!existing && job.window.length >= job.windowPieces)
  ) {
    return fail(res, 409, 'window-exceeded', `乱序窗口已满（${job.windowPieces} 片 / ${job.windowBytes} 字节），请退避后重发这一片`);
  }
  if (existing) {
    // 同一偏移重发：以新的字节为准（客户端重传的是同一片，内容应当一样），不重复计数。
    existing.data = piece;
  } else {
    // 保持按偏移升序：flushWindow 只认队首，插错位置会让窗口永远不前进。
    const at = job.window.findIndex((entry) => entry.offset > offset);
    const entry = { offset, data: piece };
    if (at < 0) job.window.push(entry);
    else job.window.splice(at, 0, entry);
  }
  job.pendingWindowBytes += added;
  job.expiresAt = Date.now() + STAGING_TTL_MS;
  scheduleUploadExpiry(uploadId, job);
  return sendJson(res, 200, { ok: true, received: job.receivedBytes });
}

/** POST /api/mobile/v1/upload/chunk { uploadId, index, data } → { ok, received }。 */
async function handleUploadChunk(_ctx, req, res) {
  // wire 在最前面分流：bin 的请求体是裸密文（守卫已解成 `req.rawBody`），拿它当 JSON 读
  // 只会得到一个「畸形 JSON」的 413 —— 那是假象，不是真的太大。
  if (headerOf(req, 'x-dsh-wire').trim().toLowerCase() === 'bin') return handleBinChunk(req, res);

  const body = await readJsonBody(req, CHUNK_MAX_BODY);
  if (!body) return fail(res, 413, 'too-large', '分片过大或不是合法 JSON');

  const job = uploads.get(String(body.uploadId == null ? '' : body.uploadId));
  if (!job || job.finishPromise) return fail(res, 404, 'unknown-upload', '上传会话不存在或已结束');
  if (job.wire === 'bin') {
    return fail(res, 400, 'wire-mismatch', '这个上传是按二进制分片协商的，不能混发 JSON 分片');
  }

  const index = Number(body.index);
  if (!Number.isInteger(index) || index < 0) return fail(res, 400, 'bad-request', 'index 必须是非负整数');
  if (typeof body.data !== 'string') return fail(res, 400, 'bad-request', 'data 必须是 base64 字符串');
  if (index < job.received) return sendJson(res, 200, { ok: true, received: job.received });
  if (index > job.received) {
    return fail(res, 409, 'out-of-order', `期望分片 ${job.received}，收到 ${index}`);
  }

  const chunk = Buffer.from(body.data, 'base64');
  if (!BASE64_RE.test(body.data) || body.data.length % 4 !== 0) {
    return fail(res, 400, 'bad-request', 'data 不是合法 base64');
  }
  try {
    await fsp.appendFile(job.stagingPath, chunk);
  } catch (error) {
    removeUpload(String(body.uploadId), job);
    return fail(res, 500, 'inbox-unavailable', `写入暂存文件失败：${error.message}`);
  }
  job.received += 1;
  job.bytes += chunk.length;
  job.expiresAt = Date.now() + STAGING_TTL_MS;
  scheduleUploadExpiry(String(body.uploadId), job);
  sendJson(res, 200, { ok: true, received: job.received });
}

/** POST /api/mobile/v1/upload/finish { uploadId } → { ok, path, name, bytes }。
 *
 * **同一 uploadId 再收一次是回放，不是新上传**：落盘（rename）已经做完、回包却在路上丢了
 * 的时候，手机那边只能再收一次 —— 那一发必须拿回第一次的那份结果，否则它会把一次成功的
 * 上传判成失败、让用户白传一遍整个文件。认不出的 uploadId 仍然 404（不能靠「新建一个空
 * 上传」蒙过去）。
 */
async function handleUploadFinish(_ctx, req, res) {
  const body = await readJsonBody(req);
  const uploadId = String((body && body.uploadId) || '');
  const job = uploads.get(uploadId);
  if (!job) {
    const replay = resolveFinishedUpload(uploadId);
    if (replay) return sendJson(res, 200, { ok: true, ...replay, uploadId });
    return fail(res, 404, 'unknown-upload', '上传会话不存在或已结束');
  }

  // v3 的收口必须先证明字节齐了：分片可以乱序、可以重发，少一片时落盘出来的文件是残缺的，
  // 而文件名照样对、客户端照样以为传完了。**job 不删** —— 客户端补上缺的那几片后还能再收一次口。
  if (job.wire === 'bin' && job.receivedBytes !== job.total) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'incomplete', message: `上传还没收齐（已收 ${job.receivedBytes} / ${job.total} 字节）`, received: job.receivedBytes },
    });
  }
  if (!job.finishPromise) {
    if (job.expiryTimer) clearTimeout(job.expiryTimer);
    job.expiryTimer = null;
    const dir = job.destDir || path.join(inboxRoot(), today());
    // 判重与落盘共用同一个项目独占窗口。Promise 只存结果，不捕获任何一次请求的 res：
    // 首个请求超时断开之后，重试仍然等同一次落盘，并向自己的连接回包。
    job.finishPromise = withProjectWrite(queueKeyOf(job.destRoots, dir), async () => {
      try {
        // 指定落点已在 begin 确认存在，中途被删就报错，不悄悄重建。
        if (!job.destDir) await fsp.mkdir(dir, { recursive: true });
        const target = await uniquePath(dir, job.name);
        try {
          await fsp.rename(job.stagingPath, target);
        } catch (error) {
          if (error.code !== 'EXDEV') throw error;
          await fsp.copyFile(job.stagingPath, target);
          try { await fsp.unlink(job.stagingPath); } catch { /* 落点已完整写好，残片留给清扫 */ }
        }
        const result = { path: target, name: path.basename(target), bytes: job.bytes };
        rememberFinishedUpload(uploadId, result);
        return { status: 200, body: { ok: true, ...result, uploadId } };
      } catch (error) {
        try { await fsp.unlink(job.stagingPath); } catch { /* 已经不在了 */ }
        return { status: 500, body: { ok: false, error: { code: 'inbox-unavailable', message: `落盘失败：${error.message}` } } };
      } finally {
        // 成功回执已经可回放，或者这一趟明确失败，才交还上传身份与暂存的所有权。
        removeUpload(uploadId, job);
      }
    });
  }
  const result = await job.finishPromise;
  return sendJson(res, result.status, result.body);
}

/** POST /api/mobile/v1/upload/abort { uploadId } → { ok }。 */
async function handleUploadAbort(_ctx, req, res) {
  const body = await readJsonBody(req);
  const uploadId = String((body && body.uploadId) || '');
  const job = uploads.get(uploadId);
  // finish 一经接收就由落盘任务持有暂存，和已完成后 abort 一样只确认，不撤回收口。
  if (job && !job.finishPromise) {
    removeUpload(uploadId, job);
    try { await fsp.unlink(job.stagingPath); } catch { /* 已经不在了 */ }
  }
  sendJson(res, 200, { ok: true });
}

const UPLOAD_EXPIRED_MESSAGE = '这张图片的上传已过期，请重新发送';

/**
 * 把 content 里带 `uploadId` 的图片块补成内联 base64。
 *
 * 宿主的 `session.prompt` 只认 `{type:'image', mediaType, data}`，所以这一步要在宿主
 * 那一跳之前完成：手机到宿主这一段只传 uploadId，字节早就在分片上传时落盘了。
 *
 * 整份读进内存是这条通道的形状决定的 —— 内联块本身就是一个 base64 字符串，没有按流交给宿主
 * 的入口。也是因此这里不设体积门槛：单张多大由桌面端的附件限制定，真超了由宿主在 prompt 那
 * 一跳用原话回绝；插件再拦一道，只会把「宿主说附件太大」变成一句假的「上传已过期」。
 *
 * @returns {Promise<string|null>} 有块补不上就回一句给用户看的话，全补上了回 null。
 */
async function inlineUploadedImageBlocks(content) {
  for (const block of content) {
    if (!block || block.type !== 'image') continue;
    if (typeof block.data === 'string' && block.data) continue;
    const record = resolveFinishedUpload(block.uploadId);
    // 画布素材那份没有 `path`（只按哈希躺在画布库里），不能拿来内联：照旧报「过期」。
    if (!record || !record.path) return UPLOAD_EXPIRED_MESSAGE;
    try {
      const bytes = await fsp.readFile(record.path);
      if (!bytes.length) return UPLOAD_EXPIRED_MESSAGE;
      block.data = bytes.toString('base64');
      if (!block.name) block.name = record.name;
    } catch {
      return UPLOAD_EXPIRED_MESSAGE;
    }
  }
  return null;
}

module.exports = {
  handleUploadBegin,
  handleUploadChunk,
  handleUploadFinish,
  handleUploadAbort,
  sanitizeName,
  inboxRoot,
  sweepStaging,
  sweepExpiredUploads,
  STAGING_TTL_MS,
  CHUNK_BYTES,
  CHUNK_MAX_BYTES,
  resolveFinishedUpload,
  inlineUploadedImageBlocks,
};

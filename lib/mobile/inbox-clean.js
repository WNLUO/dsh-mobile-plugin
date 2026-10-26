'use strict';

/**
 * 收件目录（`~/.dsh/mobile-inbox`）的占用统计与按龄清理。
 *
 * 手机分享进来的文件由 `uploads.js` 落到 `<收件根>/<日期>/<消毒名>`，那条通道只进不出：盘上
 * 只认文件名，不认识会话，会话日志里的 `@路径` 也不会触发回收。不设出口，目录只会按天堆。
 *
 * 口径是按龄：只删 mtime 超过 24 小时的文件。按文件而不是按日期目录删，才和「放满一天」这个
 * 承诺一致；今天传的文件不在范围内，正在跑的那一回合碰不到它。空出来的日期目录顺手删掉。
 *
 * 自动清理是开关、默认关：启动时那次只有开关打开才跑，面板上的按钮永远可用。开关落盘在
 * `<DSH_HOME>/storages/mobile-plugin/inbox-auto-clear.json`，读不到或读坏都当关。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { dshHome } = require('../shared/paths');
const { sendJson, readJsonBody } = require('../shared/http-util');
const { inboxRoot, sweepStaging, STAGING_TTL_MS } = require('./uploads.js');

/** 保留期：文件落盘之后满这么久才进清理范围。 */
const INBOX_KEEP_MS = 24 * 60 * 60 * 1000;

/** 收件根下的暂存目录（`uploads.js` 的 `.staging`）：半截上传的残片住在这里。 */
const STAGING_DIR = '.staging';

/** 日期堆的名字（`uploads.js` 的 `today()`）。不是这个形状的一律当残渣跳过。 */
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 自动清理开关的落盘文件：与自动更新开关同一个目录。 */
function autoClearFile() {
  return path.join(dshHome(), 'storages', 'mobile-plugin', 'inbox-auto-clear.json');
}

/**
 * 读自动清理开关。读不到 / 读坏了都当「关」—— 无人值守删盘这种事，
 * 缺省必须在用户这一侧（与 `updater.js` 的 `autoUpdateEnabled` 同一条口径）。
 */
function autoClearEnabled() {
  try {
    const raw = JSON.parse(fs.readFileSync(autoClearFile(), 'utf8'));
    return raw?.enabled === true;
  } catch {
    return false;
  }
}

/** 写开关。 */
function setAutoClear(enabled) {
  const file = autoClearFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ enabled: enabled === true }, null, 2)}\n`);
  return autoClearEnabled();
}

async function readEntries(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * 暂存残片的占用：`.staging/*.part` 里已经超过 TTL 的那些。
 *
 * 单列一份是因为它们**不归日期堆那份扫描管**（文件名不是按天分堆的、也没有目录名可读），
 * 但它跟落盘文件是同一个收件根、同样只进不出：`sweepStaging` 只在 `begin` 时跑，手机不再
 * 上传的机器上残片就一直躺在那儿（实测一份 12MB 的 `.part` 从 10-20 睡到现在）。
 * 判据与 `sweepStaging` 完全一致（同一个 `STAGING_TTL_MS`），这里只读不删。
 */
async function scanStaging(now = Date.now()) {
  const dir = path.join(inboxRoot(), STAGING_DIR);
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { files: 0, bytes: 0, deletableFiles: 0, deletableBytes: 0 };
  }
  const cutoff = now - STAGING_TTL_MS;
  let files = 0;
  let bytes = 0;
  let deletableFiles = 0;
  let deletableBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.part')) continue;
    try {
      const stat = await fsp.stat(path.join(dir, entry.name));
      files += 1;
      bytes += stat.size;
      if (stat.mtimeMs < cutoff) {
        deletableFiles += 1;
        deletableBytes += stat.size;
      }
    } catch {
      continue;
    }
  }
  return { files, bytes, deletableFiles, deletableBytes };
}

/**
 * 走一遍收件目录，按 mtime 把文件分成「还留着」与「够龄可删」两堆。
 *
 * 只走一层日期目录、不进任何子目录：落盘路径是 `<根>/<日期>/<文件>`，客户端给不出更深的
 * 路径（`sanitizeName` 把 `/` 与 `\` 都换成 `_`）。暂存残片单独算（见 `scanStaging`），
 * 但**并进同一份读数**：用户问的是「这个收件目录占了多少」，分两行报只会让他去猜哪一行该点。
 */
async function scanInbox(now = Date.now(), keepMs = INBOX_KEEP_MS) {
  const root = inboxRoot();
  const cutoff = now - keepMs;
  let bytes = 0;
  let files = 0;
  let deletableBytes = 0;
  let deletableFiles = 0;
  let oldestMs = 0;
  for (const dirEntry of await readEntries(root)) {
    if (!dirEntry.isDirectory() || !DATE_DIR_RE.test(dirEntry.name)) continue;
    const dir = path.join(root, dirEntry.name);
    for (const entry of await readEntries(dir)) {
      if (!entry.isFile()) continue;
      const file = path.join(dir, entry.name);
      let stat;
      try {
        stat = await fsp.stat(file);
      } catch {
        continue;
      }
      files += 1;
      bytes += stat.size;
      if (!oldestMs || stat.mtimeMs < oldestMs) oldestMs = stat.mtimeMs;
      if (stat.mtimeMs < cutoff) {
        deletableFiles += 1;
        deletableBytes += stat.size;
      }
    }
  }
  // 暂存残片并进同一份读数，但**它们不是「收件文件」**：多出来的两个字段让界面能分开说。
  const staging = await scanStaging(now);
  return {
    root,
    files: files + staging.files,
    bytes: bytes + staging.bytes,
    deletableFiles: deletableFiles + staging.deletableFiles,
    deletableBytes: deletableBytes + staging.deletableBytes,
    stagingFiles: staging.files,
    stagingBytes: staging.bytes,
    oldestMs,
    keepMs,
  };
}

/**
 * 删掉够龄的文件，再把空下来的日期目录收掉。
 *
 * 删一个失败不算整轮失败（被别人删掉、权限、占用），照删其余：这个动作的结果本来就是
 * 「这次腾了多少」，不是「盘上一定干净了」。目录只在真的空了之后才删，`rmdir` 失败同样
 * 不影响结论。
 */
async function clearInbox(now = Date.now(), keepMs = INBOX_KEEP_MS) {
  const root = inboxRoot();
  const cutoff = now - keepMs;
  let deletedFiles = 0;
  let freedBytes = 0;
  let failedFiles = 0;
  for (const dirEntry of await readEntries(root)) {
    if (!dirEntry.isDirectory() || !DATE_DIR_RE.test(dirEntry.name)) continue;
    const dir = path.join(root, dirEntry.name);
    for (const entry of await readEntries(dir)) {
      if (!entry.isFile()) continue;
      const file = path.join(dir, entry.name);
      let stat;
      try {
        stat = await fsp.stat(file);
      } catch {
        continue;
      }
      if (stat.mtimeMs >= cutoff) continue;
      try {
        await fsp.unlink(file);
        deletedFiles += 1;
        freedBytes += stat.size;
      } catch {
        failedFiles += 1;
      }
    }
    // 只剩空壳的日期目录一起收掉；里面还有今天传的文件时 rmdir 会失败，正好留着。
    try {
      await fsp.rmdir(dir);
    } catch { /* 还有文件，或者删不掉：都不是错误 */ }
  }
  // 暂存残片交给 `uploads.js` 自己那份判据（同一个 TTL），别在这里抄一遍：抄了就是第二份账，
  // 改一处忘一处时两边会各删各的。它删不掉的项不进 `failedFiles` —— 那是「收件文件」的账。
  let stagingDeleted = 0;
  let stagingBytes = 0;
  try {
    const swept = await sweepStaging(path.join(root, STAGING_DIR));
    stagingDeleted = swept.deleted;
    stagingBytes = swept.bytes;
  } catch { /* 残片清不动不影响这一轮：下次启动还会再试 */ }
  return {
    deletedFiles: deletedFiles + stagingDeleted,
    freedBytes: freedBytes + stagingBytes,
    failedFiles,
    keepMs,
  };
}

function usageView(scan) {
  return {
    ok: true,
    root: scan.root,
    files: scan.files,
    bytes: scan.bytes,
    deletableFiles: scan.deletableFiles,
    deletableBytes: scan.deletableBytes,
    /** 其中暂存残片占了多少（半截上传留下的 `.part`，与落盘文件同一份读数、但来源不同）。 */
    stagingFiles: scan.stagingFiles,
    stagingBytes: scan.stagingBytes,
    oldestAt: scan.oldestMs || null,
    keepHours: Math.round(scan.keepMs / (60 * 60 * 1000)),
    /**
     * 自动清理开着没有。两个界面都靠它画那颗开关 —— 不自己猜、也不各自存一份，
     * 真值只在这台机器的 json 里。**默认 false**。
     */
    autoClear: autoClearEnabled(),
  };
}

/**
 * GET /api/mobile/v1/inbox/status（token）
 *
 * 只读：收件目录现在占了多少、其中多少已经够龄可删。App 与网页面板共用这一条，
 * 两边都不必自己扫盘、也不会各算一套口径。
 */
async function handleInboxStatus(_ctx, _req, res) {
  sendJson(res, 200, usageView(await scanInbox()));
}

/**
 * POST /api/mobile/v1/inbox/clear（token）{ confirm: true }
 *
 * 与「清理已归档会话」同一条手感：不可恢复的磁盘删除必须显式带 `confirm`，
 * 手机端少点一次不值得把它变成滑一下就没了的动作。
 */
async function handleInboxClear(_ctx, req, res) {
  const body = await readJsonBody(req);
  if (!body || body.confirm !== true) {
    sendJson(res, 400, { ok: false, error: { code: 'confirm-required', message: '清理收件文件不可恢复，请求需要带 confirm: true' } });
    return;
  }
  const result = await clearInbox();
  sendJson(res, 200, { ok: true, ...result });
}

/**
 * POST /api/mobile/v1/inbox/auto（token）{ enabled: boolean }
 *
 * 自动清理开关。与自动更新那条（`/api/relay/update/auto`）同一条手感：只收布尔、
 * 缺省关、写失败就整次失败（回「开好了」却没落盘，下次启动又是关的，用户会以为是坏的）。
 */
async function handleInboxAuto(_ctx, req, res) {
  const body = await readJsonBody(req);
  if (!body || typeof body.enabled !== 'boolean') {
    sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'enabled 必须是布尔值' } });
    return;
  }
  try {
    const enabled = setAutoClear(body.enabled);
    sendJson(res, 200, { ok: true, autoClear: enabled });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: { code: 'write-failed', message: `开关没写进去：${error && error.message ? error.message : error}` } });
  }
}

/** 每进程只清一次：代际热替换会再跑一遍装载，但盘上已经清过了。 */
const CLEARED_ONCE = Symbol.for('dsh-mobile-plugin.inbox-cleared-once');

/**
 * 宿主刚起来时顺手清一次 —— **只在自动清理开关打开时**。
 *
 * 与两个入口（App / 面板）调的是同一个 `clearInbox`，只是不需要确认：这里没有人在按键，
 * 而够龄这个判据本身就是「这些文件已经放满一天了」。但「没人按键」也正是它必须默认关的
 * 理由 —— 没有人在场时替用户删盘的，得是他明确打开过的开关。开关关着就直接返回，连盘都
 * 不扫（扫一遍也是成本，而且开没开是读一个 json 的事）。
 *
 * 失败只记一行日志：收尾动作不该把装载拖下水。
 */
async function clearInboxOnce(log) {
  if (globalThis[CLEARED_ONCE]) return null;
  globalThis[CLEARED_ONCE] = true;
  if (!autoClearEnabled()) return null;
  try {
    const result = await clearInbox();
    if (result.deletedFiles > 0) {
      log?.(`inbox cleanup: deleted ${result.deletedFiles} files (${Math.round(result.freedBytes / 1024)} KB)`);
    }
    return result;
  } catch (error) {
    log?.(`inbox cleanup failed: ${error && error.message ? error.message : String(error)}`);
    return null;
  }
}

module.exports = {
  scanInbox,
  clearInbox,
  clearInboxOnce,
  autoClearEnabled,
  setAutoClear,
  autoClearFile,
  usageView,
  handleInboxStatus,
  handleInboxClear,
  handleInboxAuto,
  INBOX_KEEP_MS,
};

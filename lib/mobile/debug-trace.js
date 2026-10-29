'use strict';

/**
 * 手机端调试轨迹的落盘口（`POST /api/mobile/v1/debug/trace`）。
 *
 * 为什么要有它：滑动手感出问题时，现场在手机上（偏移轨迹、每一行的实际高度、图片什么时候
 * 才到），而能看这些东西的人在这台电脑上。让人把几万行日志抄进聊天不现实，所以 App 边录边把
 * 一行行 JSONL 打到这里，插件落进 `<DSH_HOME>/mobile-debug/<capture>.jsonl`，维护者在这台
 * 电脑上直接读文件。
 *
 * 三条边界，别放宽：
 *  - **不是任意文件写入**：文件名只由 `capture` 生成，且只认 `[A-Za-z0-9._-]`。构造一个别的
 *    capture 只会在这一个目录里多一份空文件，碰不到用户的任何东西；
 *  - **只追加**：一次请求往 `<capture>.jsonl` 末尾续一段，从不覆盖、从不删别的文件；
 *  - **封顶**：一份轨迹 8MB 之后停写（回 `capped: true`，App 收到就停手），目录里最多留 10 份，
 *    第 11 份进来时删掉最旧那份。录音不会把盘写满。
 *
 * 与 `session/file`、`session/attachment` 那些读口方向相反：这条只写、写的位置固定，回给手机
 * 的只有文件名与字节数，不回路径。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { dshHome } = require('../shared/paths');
const { sendJson, readJsonBody } = require('../shared/http-util');

/** 一份轨迹的字节上限。真到这一步说明录得太久，该停了。 */
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
/** 目录里最多留几份（按 mtime，新的来、旧的走）。 */
const MAX_CAPTURES = 10;
/** 一次请求最多带多少行；App 那边按 40KB 切批，正常远小于这个数。 */
const MAX_LINES_PER_BATCH = 4000;
/** 一次请求最多多少字节（`readJsonBody` 本身还有 344KB 的封顶，这里再收一道）。 */
const MAX_BATCH_BYTES = 512 * 1024;
/** 轨迹名（也就是文件名）：只认这几类字符，别的一律 400。 */
const CAPTURE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** 轨迹目录。按调用时解析，测试可注入 `DSH_HOME`。 */
function traceDir() {
  return path.join(dshHome(), 'mobile-debug');
}

/** 某一份轨迹的落盘路径（`capture` 已经过白名单校验）。 */
function capturePath(capture) {
  return path.join(traceDir(), `${capture}.jsonl`);
}

/**
 * 目录里留最近 `MAX_CAPTURES` 份。
 *
 * 按 mtime 而不是文件名：轨迹名由 App 带时间戳生成，但同一秒的两份、或者用户手改过的名字都
 * 不该让清理算错。读不动 stat 的（正在被删）直接跳过，清理失败不该让这次上传失败。
 */
async function pruneCaptures() {
  let names;
  try {
    names = await fsp.readdir(traceDir());
  } catch {
    return;
  }
  const files = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const full = path.join(traceDir(), name);
    try {
      const info = await fsp.stat(full);
      if (info.isFile()) files.push({ name, full, mtime: info.mtimeMs });
    } catch { /* 刚被删掉 / 读不动：跳过 */ }
  }
  if (files.length <= MAX_CAPTURES) return;
  files.sort((a, b) => a.mtime - b.mtime);
  for (const file of files.slice(0, files.length - MAX_CAPTURES)) {
    try {
      await fsp.unlink(file.full);
    } catch { /* 删不掉就留着，下次再说 */ }
  }
}

/**
 * 续写一段轨迹。
 *
 * `lines` 是已经序列化好的 JSON 行（App 侧拼的），这里只做「拼成一段文本 + 追加」。一行都
 * 不合法的批次按空处理：回 ok、写 0 字节，别让手机那头因为一次形状不对就整段录不上。
 */
async function handleDebugTrace(_ctx, req, res) {
  const body = await readJsonBody(req);
  const capture = body && typeof body.capture === 'string' ? body.capture : '';
  if (!CAPTURE_RE.test(capture)) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { capture }，且只认字母数字与 ._-' } });
  }
  const raw = body && Array.isArray(body.lines) ? body.lines : null;
  if (!raw) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { lines: string[] }' } });
  }
  if (raw.length > MAX_LINES_PER_BATCH) {
    return sendJson(res, 413, { ok: false, error: { code: 'too-many-lines', message: `一次最多 ${MAX_LINES_PER_BATCH} 行` } });
  }
  const lines = raw.filter((line) => typeof line === 'string' && line.length > 0);
  if (lines.length === 0) {
    return sendJson(res, 200, { ok: true, file: `${capture}.jsonl`, bytes: 0, lines: 0, capped: false });
  }
  const text = `${lines.join('\n')}\n`;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_BATCH_BYTES) {
    return sendJson(res, 413, { ok: false, error: { code: 'too-large', message: `一次最多 ${MAX_BATCH_BYTES} 字节` } });
  }

  const file = capturePath(capture);
  try {
    await fsp.mkdir(traceDir(), { recursive: true });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: { code: 'io', message: `建目录失败：${error && error.message ? error.message : ''}` } });
  }

  let existing = 0;
  let created = false;
  try {
    existing = (await fsp.stat(file)).size;
  } catch {
    created = true;
  }

  if (existing >= MAX_CAPTURE_BYTES) {
    // 已经写满：回 capped 让 App 停手。文件留着，人要看的正是前面那一段。
    return sendJson(res, 200, { ok: true, file: `${capture}.jsonl`, bytes: existing, lines: 0, capped: true });
  }
  // 快写满时**按整行留**：切在字节中间会让最后一行变成半截 JSON，读的人只会看到一行坏数据。
  const room = MAX_CAPTURE_BYTES - existing;
  let payload = text;
  if (bytes > room) {
    const kept = [];
    let used = 0;
    for (const line of lines) {
      const size = Buffer.byteLength(line, 'utf8') + 1;
      if (used + size > room) break;
      kept.push(line);
      used += size;
    }
    payload = kept.length > 0 ? `${kept.join('\n')}\n` : '';
  }
  try {
    await fsp.appendFile(file, payload);
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: { code: 'io', message: `写盘失败：${error && error.message ? error.message : ''}` } });
  }
  // 清理放在写完之后：这一份刚建出来的文件按 mtime 是最新的，留下来的正是它。
  if (created) await pruneCaptures();
  let total = existing;
  try {
    total = (await fsp.stat(file)).size;
  } catch { /* 写成功但 stat 失败：回一个估计值，不影响 App */ }
  sendJson(res, 200, {
    ok: true,
    file: `${capture}.jsonl`,
    bytes: total,
    lines: payload === text ? lines.length : (payload ? payload.split('\n').length - 1 : 0),
    // 「这一段被切了」或「已经顶到上限」都算满：App 收到就停手，别继续往一条死路上发。
    capped: payload !== text || total >= MAX_CAPTURE_BYTES,
  });
}

/** 同步读一份轨迹（维护者在电脑上直接看文件；这里只给测试与将来的面板用）。 */
function readCapture(capture) {
  if (!CAPTURE_RE.test(capture)) return null;
  try {
    return fs.readFileSync(capturePath(capture), 'utf8');
  } catch {
    return null;
  }
}

module.exports = {
  handleDebugTrace,
  readCapture,
  traceDir,
  MAX_CAPTURE_BYTES,
  MAX_CAPTURES,
};

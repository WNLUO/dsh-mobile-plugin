'use strict';

/**
 * 右栏文件浏览器的写操作：新建、删除、重命名。三条都只在「允许区」里动 —— 与
 * `file-read.js` 同一条判据（宿主已登记的工作区 ∪ 当前会话的项目目录），不碰整台电脑。
 *
 * 与 `uploads.js` 的关系：那条负责「把手机上一份文件传进来」（分片、续传、加密信封），
 * 落点同样受 `allowed-zone` 约束；这里是「已经在右栏里了，就地新建一个空文件 / 改个名字 /
 * 删掉」。两者都不提供「任意路径写」，能力面没有放宽。
 *
 * 四条边界：
 * 1. `path` 必须是绝对路径，且 `resolve` 之后的落点在允许区内。`..` 爬出去按最终落点算，
 *    一律 403。判定与 `file-read.js` 共用 `allowed-zone.js`，不另抄一份。
 * 2. **符号链接不逃逸**：只比字符串不够 —— `工作区/软链目录/x` 字面上在工作区里，物理上可能
 *    指到工作区外。所以写之前先 `realpath` 目标所在的父目录，要求它落在某个「realpath 之后
 *    的根」里。删除时先 `lstat`：目标是符号链接就拒绝（既不删链接本身、也绝不顺着删链接指向
 *    的文件）。
 * 3. 新建不能凭空替换别人的文件：目标已存在时默认 409，要 `overwrite: true` 才覆盖；覆盖前
 *    仍然拒绝符号链接与目录。父目录必须已经存在（建目录走 `directory-browse.js` 的
 *    `directory/create`），这条不顺手递归 `mkdir` —— 少一层就少一处能爬出允许区的路径。
 * 4. 不写 shell，全程 `node:fs/promises`。
 *
 * 5. **按项目串行**：同一个项目目录同一时刻只让一个写落盘（`project-write-queue`）。手机能
 *    一口气派几条会话，落点又在同一个项目里，并发写就是后写的覆盖先写的。只读不进这条队列。
 *    队列键由 `queueKeyOf` 统一给，`uploads.js` 的落盘与 `directory-browse.js` 的建目录算的
 *    是同一份 —— 口径分叉等于没排队。
 */

const { writeFile, unlink, rename, lstat, realpath } = require('node:fs/promises');
const path = require('node:path');

const { sendJson, readJsonBody } = require('../shared/http-util');
const { allowedRoots, inAllowedZone } = require('./allowed-zone.js');
const { withProjectWrite, queueKeyOf } = require('./project-write-queue.js');

const FILE_PATH_MAX = 4096;             // 绝对路径长度上限
const FILE_NAME_MAX = 255;              // 单个文件名上限（多数文件系统同值）
const FILE_MAX_CONTENT_BYTES = 256 * 1024; // 新建时正文上限（文本文件；更大的走上传）

/** 400 / 403 / 404 / 409 等统一错误体。 */
function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } });
}

/** 解析并按允许区校验请求里的 `path`，同时确认「父目录的物理落点」也在允许区里。 */
async function preparePath(ctx, body, res) {
  const declared = body && typeof body.path === 'string' ? body.path.trim() : '';
  const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId.trim() : '';

  if (!declared) {
    sendError(res, 400, 'bad-request', '需要 { path }（绝对路径）');
    return null;
  }
  if (!path.isAbsolute(declared)) {
    sendError(res, 400, 'bad-request', 'path 必须是绝对路径');
    return null;
  }
  if (declared.length > FILE_PATH_MAX) {
    sendError(res, 400, 'bad-request', 'path 太长');
    return null;
  }

  const target = path.resolve(declared);

  let roots;
  try {
    roots = await allowedRoots(ctx, sessionId);
  } catch (error) {
    // 宿主那句原话回给手机：这条路上「没取到」与「你没有这个目录」必须分得开。
    sendFailure(res, error);
    return null;
  }
  if (!inAllowedZone(roots, target)) {
    sendError(res, 403, 'outside-allowed', '这个位置不在能改的范围里（只放行工作区目录和这条会话的项目目录）');
    return null;
  }

  const parent = path.dirname(target);
  let realParent;
  try {
    realParent = await realpath(parent);
  } catch {
    sendError(res, 404, 'parent-missing', '上级目录不在这台电脑上');
    return null;
  }
  const realRoots = await realRootsOf(roots);
  if (!inAllowedZone(realRoots, realParent)) {
    sendError(res, 403, 'outside-allowed', '上级目录的物理位置不在允许区里（可能经过了符号链接）');
    return null;
  }
  return { target, parent, roots };
}

/** 允许区每个根 realpath 之后的样子；解析不了的根直接跳过（跳过是缩小范围）。 */
async function realRootsOf(roots) {
  const resolved = await Promise.all(roots.map((root) => realpath(root).catch(() => null)));
  return resolved.filter((root) => typeof root === 'string');
}

/** 502：宿主工作区清单读取失败，把宿主原话转给手机。 */
function sendFailure(res, error) {
  sendJson(res, 502, {
    ok: false,
    error: {
      code: (error && error.code) || 'workspace-list-failed',
      message: String((error && error.message) || error),
    },
  });
}

/**
 * 一段正文落到**已校验的落点**上：`file/create` 与 `session/write-body` 共用这一段。
 *
 * 两处共用是因为这里只有一份正确顺序 —— 按项目排队 → 判重 / 拒符号链接与目录 →
 * 落盘 → 出包。抄第二份迟早会出现「一条路由拒软链、另一条顺着写」这类只在一边成立的
 * 边界，而两条路由的落点判定本来就是同一份 `preparePath`。
 *
 * @param {{ target: string, roots: string[] }} prepared `preparePath` 的结果
 * @param {object} body 请求体（只读 `overwrite`）
 * @param {string} content 正文
 * @param {object} res node:http ServerResponse
 * @param {Record<string, unknown>} [extra] 回包里额外带的格子（写路由自己的字段）
 */
async function writeContentAt(prepared, body, content, res, extra) {
  const { target, roots } = prepared;
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > FILE_MAX_CONTENT_BYTES) {
    return sendError(res, 413, 'too-large', '文件太大，手机这边不支持一次性写这么大的文件');
  }

  // 落盘这一段按项目串行：判重与写入必须在同一个独占窗口里，否则两条并发请求会都判「不存在」。
  await withProjectWrite(queueKeyOf(roots, target), async () => {
    let existing = null;
    try {
      existing = await lstat(target);
    } catch {
      existing = null;
    }
    if (existing) {
      if (existing.isSymbolicLink()) return sendError(res, 400, 'symlink-refused', '这是一个符号链接，不在这里新建或覆盖');
      if (existing.isDirectory()) return sendError(res, 400, 'not-a-file', '这条路径已经是一个目录');
      if (!body.overwrite) return sendError(res, 409, 'file-exists', '同名文件已经存在');
    }

    try {
      await writeFile(target, content, { encoding: 'utf8', flag: existing ? 'w' : 'wx' });
    } catch (error) {
      if (error && error.code === 'EEXIST') return sendError(res, 409, 'file-exists', '同名文件已经存在');
      return sendError(res, 502, 'write-failed', `写文件失败：${String((error && error.message) || error)}`);
    }

    sendJson(res, 200, {
      ok: true,
      path: target,
      created: !existing,
      overwritten: !!existing,
      bytes,
      ...extra,
    });
  });
}

/**
 * POST /api/mobile/v1/file/create
 * body { path（绝对）, sessionId?, content?, overwrite? }
 */
async function handleFileCreate(ctx, req, res) {
  const body = (await readJsonBody(req)) || {};
  const prepared = await preparePath(ctx, body, res);
  if (!prepared) return;

  const content = typeof body.content === 'string' ? body.content : (body.content == null ? '' : null);
  if (content === null) return sendError(res, 400, 'invalid-content', 'content 必须是字符串');
  await writeContentAt(prepared, body, content, res);
}

/**
 * POST /api/mobile/v1/file/delete
 * body { path（绝对）, sessionId? }
 */
async function handleFileDelete(ctx, req, res) {
  const body = (await readJsonBody(req)) || {};
  const prepared = await preparePath(ctx, body, res);
  if (!prepared) return;
  const { target, roots } = prepared;

  await withProjectWrite(queueKeyOf(roots, target), async () => {
    let info;
    try {
      info = await lstat(target);
    } catch {
      return sendError(res, 404, 'missing', '这个文件已经不在这台电脑上了');
    }
    if (info.isSymbolicLink()) {
      // 既不移除链接、也绝不顺着链接去删它指向的文件。
      return sendError(res, 400, 'symlink-refused', '这是一个符号链接，不删除');
    }
    if (!info.isFile()) {
      return sendError(res, 400, 'not-a-file', '这条路径不是一个文件');
    }

    try {
      await unlink(target);
    } catch (error) {
      return sendError(res, 502, 'delete-failed', `删除失败：${String((error && error.message) || error)}`);
    }
    sendJson(res, 200, { ok: true, path: target, deleted: true });
  });
}

/** 单个路径段：非空、不是 . / ..、不含分隔符、不过长。 */
function validSegment(name) {
  if (typeof name !== 'string') return '';
  const text = name.trim();
  if (!text || text === '.' || text === '..' || /[/\\]/.test(text)) return '';
  if (text.length > FILE_NAME_MAX) return '';
  return text;
}

/**
 * POST /api/mobile/v1/file/rename
 * body { path（绝对，原路径）, name（新文件名，单段）, sessionId?, overwrite? }
 *
 * 只做同目录改名（`name` 是单个路径段），不实现跨目录移动 —— 移动会把「源」和「目标」两个
 * 落点都变成要各自校验的东西，改名只是在同一个已校验的父目录里换一个名字。
 */
async function handleFileRename(ctx, req, res) {
  const body = (await readJsonBody(req)) || {};
  const prepared = await preparePath(ctx, body, res);
  if (!prepared) return;
  const { target, parent, roots } = prepared;

  const name = validSegment(body.name);
  if (!name) return sendError(res, 400, 'invalid-name', 'name 必须是单个文件名（不含路径分隔符）');

  await withProjectWrite(queueKeyOf(roots, target), async () => {
    let source;
    try {
      source = await lstat(target);
    } catch {
      return sendError(res, 404, 'missing', '这个文件已经不在这台电脑上了');
    }
    if (source.isDirectory()) return sendError(res, 400, 'not-a-file', '这条路径是一个目录，不在这里改名');

    const destination = path.join(parent, name);
    if (!inAllowedZone(roots, destination)) {
      // 正常到不了：name 是单段、parent 已校验。留着是防「以后有人把 name 放宽成相对路径」。
      return sendError(res, 403, 'outside-allowed', '改名后的位置不在允许区里');
    }
    if (destination === target) {
      return sendJson(res, 200, { ok: true, path: target, from: target, renamed: false });
    }

    let destinationInfo = null;
    try {
      destinationInfo = await lstat(destination);
    } catch {
      destinationInfo = null;
    }
    if (destinationInfo) {
      if (!body.overwrite) return sendError(res, 409, 'file-exists', '目标名字已经有文件了');
      if (destinationInfo.isSymbolicLink()) return sendError(res, 400, 'symlink-refused', '目标是一个符号链接，不覆盖');
      if (destinationInfo.isDirectory()) return sendError(res, 400, 'not-a-file', '目标名字已经是一个目录');
    }

    try {
      await rename(target, destination);
    } catch (error) {
      return sendError(res, 502, 'rename-failed', `改名失败：${String((error && error.message) || error)}`);
    }
    sendJson(res, 200, { ok: true, path: destination, from: target, renamed: true });
  });
}

module.exports = {
  FILE_PATH_MAX,
  FILE_NAME_MAX,
  FILE_MAX_CONTENT_BYTES,
  validSegment,
  // 「一段正文落成文件」那条路由（`session-write-body.js`）与 `file/create` 共用这三份：
  // 落点判定、错误体、带内容写入。抄第二份就等于让两条路各有一套允许区判据。
  preparePath,
  sendError,
  writeContentAt,
  handleFileCreate,
  handleFileDelete,
  handleFileRename,
};

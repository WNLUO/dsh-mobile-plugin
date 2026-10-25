'use strict';

/**
 * 手机端右栏「文件浏览器」的目录列表：**文件与文件夹都列**，每条带类型、大小、修改时间。
 *
 * 与 `/directory/list` 的分工：那条是「为设备挑一个工作区目录」用的，走宿主 directoryPicker，
 * 只列**能进去的目录**、每条只有 `{name,path,hidden}`（见 lib/mobile/workspaces.js）。右栏
 * 要的是「这个目录里有什么」——文件也是内容，而且要知道类型、大小、修改时间，所以那条路
 * 一个字段都对不上。老那条**一个字都不改**：选目录那条流程还挂在它上面。
 *
 * 这条直接读宿主自己的文件系统，**不经 directoryPicker 网关**。能力面没有因此变大：宿主
 * 那份 browse 后端与本地兜底原语（lib/mobile/directory-browse.js）本来都是全文件系统范围、
 * 没有白名单，`workspace.create` 也接受任意已存在目录；而「桌面 profile 宿主 + 手机远程连」
 * 这一格宿主只服务 native，经网关只会拿到那句 `needs the browse capability`，右栏一个条目
 * 都没有。策略原语（隐藏项标记、上限、面包屑）直接 import 那份副本，不抄第二份。
 *
 * 契约（App 侧 app/src/services/viewmodels/apiPaths.ts 的 directoryListing 同时按这份改）：
 *   - `path` 可选、绝对路径；缺省 / 空串 / 全空白 = 被控端主目录（os.homedir()）。相对路径
 *     直接 400 —— 不拿宿主进程的当前目录去猜，那是另一个语义；
 *   - entries 名字升序（**大小写不敏感**），文件与文件夹混在一份里，分组由客户端做；
 *   - hidden = 名字以 '.' 开头，照旧标记但返回，过滤交给客户端；
 *   - kind 由 stat 得出（**跟随符号链接**）：目录是 'folder'，其余是 'file'，指向目录的
 *     链接算 'folder'；
 *   - size（字节）/ modified（epoch 毫秒）**只对文件给**；单条 stat 失败（断链、权限）按
 *     'file' 返回且不带这两格 —— 一个坏条目不许把整条列表带走；
 *   - 上限复用 directory-browse.js 的 DEFAULT_MAX_ENTRIES，超了截断并置 truncated = true；
 *   - crumbs 复用 directory-browse.js 的 ancestryCrumbs（根 → 当前），形状与选目录那条一致。
 * 失败一律 400 + `{ ok:false, error:{ code, message } }`，code 取 bad-request / not-found /
 * not-directory / permission，message 是简短英文，人话由 App 侧自己的字典翻。
 */

const { opendir, stat } = require('node:fs/promises');
const { join, resolve } = require('node:path');

const { sendJson } = require('../shared/http-util');
const { DEFAULT_MAX_ENTRIES, ancestryCrumbs, fullyQualified, homeDirectory } = require('./directory-browse.js');

/** 400 信封：与其余移动端接口同形，App 按 code 翻人话。 */
function fail(res, code, message) {
  return sendJson(res, 400, { ok: false, error: { code, message } });
}

/** 任意抛出值 → 文案（abort reason 之类可以不是 Error）。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 一次失败的 syscall → 契约里那四个码之一。 */
function codeOf(error) {
  const raw = error && typeof error === 'object' ? error.code : undefined;
  if (raw === 'EACCES' || raw === 'EPERM') return 'permission';
  if (raw === 'ENOENT' || raw === 'ENOTDIR') return 'not-found';
  return 'bad-request';
}

/**
 * 名字升序、大小写不敏感（契约）。折成同一个主权重后仍视为相同的（`README.md` 与
 * `readme.md`）用码位序兜底：否则比较器回 0，顺序就跟 readdir 的返回顺序走，同一个目录
 * 两次请求可能给出不同顺序。
 */
function compareNames(a, b) {
  const folded = a.localeCompare(b, undefined, { sensitivity: 'base' });
  if (folded !== 0) return folded;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 一条列表行：stat 跟到最终目标上，目录为 folder，其余为 file（断了也照样是 file）。 */
async function listingRow(directory, name) {
  const path = join(directory, name);
  const row = { name, path, hidden: name.startsWith('.') };
  let stats = null;
  try {
    stats = await stat(path);
  } catch {
    // 断链 / 权限：这一条按 file 返回、不带 size 与 modified，整条列表继续。
  }
  if (stats && stats.isDirectory()) {
    row.kind = 'folder';
    return row;
  }
  row.kind = 'file';
  if (stats) {
    row.size = stats.size;
    row.modified = Math.round(stats.mtimeMs);
  }
  return row;
}

/**
 * GET /api/mobile/v1/directory/listing?path=…（token，path 缺省 = 被控端主目录）
 *
 * 200：`{ ok:true, listing:{ path, home, crumbs, entries, truncated } }`。
 * 名字必须整体排序（大小写不敏感）才谈得上「升序」，所以这里读全量名字再截断：上限约束的
 * 是随响应下发的行数与后面逐条 stat 的次数，那两样才是这条路的成本。
 */
async function handleDirectoryListing(_ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const asked = (url.searchParams.get('path') || '').trim();
  if (asked && !fullyQualified(asked)) {
    return fail(res, 'bad-request', `cannot list "${asked}": not a fully qualified path`);
  }
  const home = homeDirectory();
  const target = resolve(asked || home);
  let info;
  try {
    // 先 stat 一次：它把「不存在」「不是目录」「权限不够」三件事分开，也跟随符号链接
    //（指向目录的链接按目录列）。opendir 在非目录上的报错各平台不一致，分不出这三种。
    info = await stat(target);
  } catch (error) {
    return fail(res, codeOf(error), `cannot list ${target}: ${messageOf(error)}`);
  }
  if (!info.isDirectory()) {
    return fail(res, 'not-directory', `cannot list ${target}: not a directory`);
  }

  const names = [];
  try {
    const level = await opendir(target);
    try {
      for (;;) {
        const dirent = await level.read();
        if (dirent === null) break;
        names.push(dirent.name);
      }
    } finally {
      await level.close();
    }
  } catch (error) {
    return fail(res, codeOf(error), `cannot list ${target}: ${messageOf(error)}`);
  }

  names.sort(compareNames);
  const truncated = names.length > DEFAULT_MAX_ENTRIES;
  const kept = truncated ? names.slice(0, DEFAULT_MAX_ENTRIES) : names;
  const entries = [];
  for (const name of kept) entries.push(await listingRow(target, name));

  sendJson(res, 200, {
    ok: true,
    listing: { path: target, home, crumbs: ancestryCrumbs(target), entries, truncated },
  });
}

module.exports = { handleDirectoryListing };

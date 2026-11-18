'use strict';

/**
 * 盘符层：被控端那一排可跳的根，供手机端「添加工作区」跨盘浏览。
 *
 * 为什么需要这一层：宿主 browse 后端只列**某一层目录的内容**、从不枚举盘符/挂载卷，而目录
 * 浏览器一打开就落在被控端主目录，面包屑又只回得到「主目录」上不去根 —— Windows 上它永远
 * 在 C 盘，Mac 上永远在 /Users/<name>。于是别的盘从来不是「读不到」，而是客户端根本没有任何
 * 入口能跳过去（手输完整路径能进，但那条路藏起来了）。
 *
 * Windows 是 A–Z 逐个 `stat('X:\\')` 探盘符（本插件没有 shell 能力面，也不该为了 26 次 stat
 * 去开一个）；macOS 是列 `/Volumes` 下挂的卷（外接硬盘、磁盘镜像都挂这儿）。
 *
 * Linux 等其余平台返回根目录一项：调用方只需处理「一排根」这一种形状，不必自己判平台；只有
 * 一项时客户端不显示这一层，所以这些平台的界面一个像素都不变。
 */

const { readdir, stat } = require('node:fs/promises');

/** 盘符顺序取 A–Z，`Promise.all` 保序，所以结果天然按字母排。 */
const DRIVE_LETTERS = Object.freeze('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));

/** 一块盘在客户端眼里的样子：与目录行同形状（`hidden` 恒 false）。 */
function driveRoot(letter) {
  return { name: `${letter}:`, path: `${letter}:\\`, hidden: false };
}

/**
 * Windows：真实存在的盘符。软盘 A:/B: 在现代机器上 stat 一下就 ENOENT，不会卡住。
 *
 * @param {(path: string) => Promise<{ isDirectory(): boolean }>} statFile 注入点，测试用。
 * @returns 盘符行数组（按盘符升序，探不到的跳过）
 */
async function listWindowsRoots({ statFile = stat } = {}) {
  const rows = await Promise.all(
    DRIVE_LETTERS.map(async (letter) => {
      const root = driveRoot(letter);
      try {
        return (await statFile(root.path)).isDirectory() ? root : null;
      } catch {
        return null;
      }
    }),
  );
  return rows.filter((row) => row !== null);
}

/**
 * macOS：外接硬盘、磁盘镜像都挂在 `/Volumes` 下。逐个列出来，跳过点开头的隐藏项和符号链接
 * （引导卷的别名 `Macintosh HD -> /` 就是一条符号链接，跳过它才不会和下面的根重复）。
 * `/Volumes` 读不出来（权限/异常）时退回只有根一项，不让这条路由整体失败。
 *
 * @param {{ readdirFile?: typeof readdir, statFile?: typeof stat }} [options] 注入点，测试用。
 * @returns 根行数组：文件系统根 + 各挂载卷
 */
async function listMacRoots({ readdirFile = readdir, statFile = stat } = {}) {
  const roots = [{ name: '/', path: '/', hidden: false }];
  let entries;
  try {
    entries = await readdirFile('/Volumes', { withFileTypes: true });
  } catch {
    return roots;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const path = `/Volumes/${entry.name}`;
    try {
      if (!(await statFile(path)).isDirectory()) continue;
    } catch {
      continue;
    }
    roots.push({ name: entry.name, path, hidden: false });
  }
  return roots;
}

/**
 * 这台被控端可跳的根：Windows 是各块盘，macOS 是根 + 各挂载卷，其余平台是文件系统根。
 *
 * @param {{ platform?: string, statFile?: typeof stat, readdirFile?: typeof readdir }} [options]
 *   平台与 fs 注入点（测试用）。
 * @returns 根行数组
 */
async function listRoots({ platform = process.platform, statFile = stat, readdirFile = readdir } = {}) {
  if (platform === 'win32') return listWindowsRoots({ statFile });
  if (platform === 'darwin') return listMacRoots({ readdirFile, statFile });
  return [{ name: '/', path: '/', hidden: false }];
}

module.exports = { DRIVE_LETTERS, listMacRoots, listRoots, listWindowsRoots };

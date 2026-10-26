'use strict';

/**
 * 盘符层：Windows 上「此电脑」里那一排盘，供手机端「添加工作区」跨盘浏览。
 *
 * 为什么需要这一层：宿主 browse 后端只列**某一层目录的内容**、从不枚举盘符，而目录浏览器
 * 一打开就落在被控端主目录 —— Windows 上它永远在 C 盘。于是 D/E 盘从来不是「读不到」，
 * 而是客户端根本没有任何入口能跳过去（手输完整路径能进，但那条路藏起来了）。
 *
 * 为什么是探而不是查：本插件没有 shell 能力面，也不该为了 26 次 stat 去开一个。A–Z 逐个
 * `stat('X:\\')`，能 stat 成目录的才算那块盘存在；不存在的盘符会很快返回 ENOENT，整个过程
 * 只有一次网络请求的开销。
 *
 * 非 Windows 返回根目录一项：调用方只需处理「一排根」这一种形状，不必自己判平台；只有一项
 * 时客户端不显示这一层，所以 Mac/Linux 的界面一个像素都不变。
 */

const { stat } = require('node:fs/promises');

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
 * 这台被控端可跳的根：Windows 是各块盘，其余平台是文件系统根。
 *
 * @param {{ platform?: string, statFile?: typeof stat }} [options] 平台与 stat 注入点（测试用）。
 * @returns 根行数组
 */
async function listRoots({ platform = process.platform, statFile = stat } = {}) {
  if (platform === 'win32') return listWindowsRoots({ statFile });
  return [{ name: '/', path: '/', hidden: false }];
}

module.exports = { DRIVE_LETTERS, listRoots, listWindowsRoots };

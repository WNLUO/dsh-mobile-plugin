// 给手机下发整包时按平台选打包命令：Windows 没有系统 zip，改用自带的 tar。
'use strict';

const { execFileSync } = require('node:child_process');

/**
 * 按平台给出把目录打成 zip 的命令。
 *
 * 宿主不引第三方压缩库：mac/Linux 用系统 zip，Windows 用系统自带的 bsdtar —— `tar -a`
 * 按输出文件名推断格式，`.zip` 就是 zip。Windows 上直接调 zip 会 `spawnSync zip ENOENT`，
 * 装第三方插件自带的扩展时整包那步就失败了。
 *
 * `platform` 单独收一个参数，是为了让守卫在 mac 上也能钉住 Windows 那条命令。
 */
function packCommand(platform, outFile) {
  if (platform === 'win32') return { command: 'tar', args: ['-a', '-cf', outFile, '.'] };
  return { command: 'zip', args: ['-r', '-q', '-X', outFile, '.'] };
}

/** 从 directory 里打成 outFile 这份 zip；包内是相对路径，不带目录那一层。 */
function packDirectory(directory, outFile) {
  const { command, args } = packCommand(process.platform, outFile);
  execFileSync(command, args, { cwd: directory, stdio: 'pipe' });
}

module.exports = { packCommand, packDirectory };

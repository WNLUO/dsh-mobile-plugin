'use strict';

/**
 * 「添加工作区」的盘符层：`GET /api/mobile/v1/directory/roots`。
 *
 * 这一层是为了 Windows 多硬盘：宿主 browse 后端只列某一层目录的内容、从不枚举盘符，而手机端
 * 的目录浏览器一打开就落在被控端主目录（Windows 上永远在 C 盘），D/E 盘于是没有任何入口。
 * 枚举由插件自己做（见 lib/mobile/drive-roots.js），不经过宿主的目录选择器 —— 它在 browse
 * 与 native 两种部署形态下的答案一样。
 *
 * 钉四件事：盘符探测的判定（存在的才算、stat 成目录的才算、失败一律跳过而不是整条报错）、
 * macOS 列 `/Volumes` 下挂载卷（跳过隐藏项/符号链接、读不出来只退回根）、Linux 等其余平台
 * 只回根一项（App 靠「只有一项就不显示」保住这些平台的界面不变）、路由挂上了。
 *
 * 运行：node --test test/drive-roots.test.cjs
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { readRouteTable } = require('./lib/wiring.cjs');
const { listRoots, listWindowsRoots } = require('../lib/mobile/drive-roots.js');

/** 一组只有给定盘符存在的假 stat。 */
function statOf(present) {
  return async (path) => {
    if (!present.has(path)) {
      const error = new Error(`ENOENT: no such file or directory, stat '${path}'`);
      error.code = 'ENOENT';
      throw error;
    }
    return { isDirectory: () => true };
  };
}

test('Windows：只回真实存在的盘符，按盘符升序，形状与目录行一致', async () => {
  const roots = await listRoots({ platform: 'win32', statFile: statOf(new Set(['C:\\', 'D:\\'])) });
  assert.deepEqual(roots, [
    { name: 'C:', path: 'C:\\', hidden: false },
    { name: 'D:', path: 'D:\\', hidden: false },
  ]);
});

test('Windows：stat 得到但不是目录的盘符不算一块盘（光驱空仓 / 畸形挂载）', async () => {
  const roots = await listWindowsRoots({
    statFile: async (path) => ({ isDirectory: () => path === 'E:\\' }),
  });
  assert.deepEqual(roots.map((root) => root.name), ['E:']);
});

test('Windows：每个盘符各探一次，探测失败只丢那一块、不整条报错', async () => {
  const probed = [];
  const roots = await listWindowsRoots({
    statFile: async (path) => {
      probed.push(path);
      if (path === 'D:\\') throw new Error('EPERM: 拿不到这块盘');
      return { isDirectory: () => path === 'C:\\' };
    },
  });
  assert.equal(probed.length, 26, 'A–Z 各探一次');
  assert.deepEqual(roots.map((root) => root.path), ['C:\\']);
});

test('Windows：一块盘都探不到时回空数组（不是错误）', async () => {
  assert.deepEqual(await listRoots({ platform: 'win32', statFile: statOf(new Set()) }), []);
});

test('其余平台（Linux）回文件系统根一项：调用方只需处理「一排根」这一种形状', async () => {
  assert.deepEqual(await listRoots({ platform: 'linux' }), [{ name: '/', path: '/', hidden: false }]);
});

/** 目录项假体：只需要 `name` 与 `isSymbolicLink()`（macOS 分支靠符号链接跳过引导卷别名）。 */
function direntOf(name, { symlink = false } = {}) {
  return { name, isSymbolicLink: () => symlink };
}

test('macOS：根 + /Volumes 下挂载卷，跳过隐藏项、符号链接、非目录与 stat 失败项', async () => {
  const roots = await listRoots({
    platform: 'darwin',
    readdirFile: async (path) => {
      assert.equal(path, '/Volumes', '扫的是挂载点目录');
      return [
        direntOf('Macintosh HD', { symlink: true }), // 引导卷别名 -> /，必须跳过，别和根重复
        direntOf('.hidden'), // 点开头的隐藏项
        direntOf('移动硬盘'), // 真外接盘
        direntOf('stat 会失败'), // 探测异常：跳过这一项，不整条报错
        direntOf('不是目录'), // stat 到但不是目录
      ];
    },
    statFile: async (path) => {
      if (path === '/Volumes/移动硬盘') return { isDirectory: () => true };
      if (path === '/Volumes/不是目录') return { isDirectory: () => false };
      throw new Error('ENOENT: no such file or directory');
    },
  });
  assert.deepEqual(roots, [
    { name: '/', path: '/', hidden: false },
    { name: '移动硬盘', path: '/Volumes/移动硬盘', hidden: false },
  ]);
});

test('macOS：/Volumes 读不出来时只回根一项（不是错误）', async () => {
  const roots = await listRoots({
    platform: 'darwin',
    readdirFile: async () => {
      throw new Error('EPERM: operation not permitted');
    },
    statFile: async () => ({ isDirectory: () => true }),
  });
  assert.deepEqual(roots, [{ name: '/', path: '/', hidden: false }]);
});

test('这条路由挂上了，且挂在需要 token 的 route() 上', () => {
  assert.match(
    readRouteTable(),
    /route\('\/api\/mobile\/v1\/directory\/roots', workspaces\.handleDirectoryRoots\)/,
    'App 会打这一条；没注册就是手机端永远没有别的盘',
  );
});

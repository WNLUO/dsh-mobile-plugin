'use strict';

/**
 * 「添加工作区」的盘符层：`GET /api/mobile/v1/directory/roots`。
 *
 * 这一层是为了 Windows 多硬盘：宿主 browse 后端只列某一层目录的内容、从不枚举盘符，而手机端
 * 的目录浏览器一打开就落在被控端主目录（Windows 上永远在 C 盘），D/E 盘于是没有任何入口。
 * 枚举由插件自己做（见 lib/mobile/drive-roots.js），不经过宿主的目录选择器 —— 它在 browse
 * 与 native 两种部署形态下的答案一样。
 *
 * 钉三件事：盘符探测的判定（存在的才算、stat 成目录的才算、失败一律跳过而不是整条报错）、
 * 非 Windows 只回根一项（App 靠「只有一项就不显示」保住 Mac/Linux 的界面不变）、路由挂上了。
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

test('其余平台回文件系统根一项：调用方只需处理「一排根」这一种形状', async () => {
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(await listRoots({ platform }), [{ name: '/', path: '/', hidden: false }]);
  }
});

test('这条路由挂上了，且挂在需要 token 的 route() 上', () => {
  assert.match(
    readRouteTable(),
    /route\('\/api\/mobile\/v1\/directory\/roots', workspaces\.handleDirectoryRoots\)/,
    'App 会打这一条；没注册就是手机端永远没有别的盘',
  );
});

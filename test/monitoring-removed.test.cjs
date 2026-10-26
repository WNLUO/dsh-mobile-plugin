'use strict';

/**
 * 服务器监控面板已从插件侧一并下线（App 侧与中转侧更早就删干净了）。
 *
 * 这不是单纯清死代码：那三条路由把宿主机器的信息直接发给任何一台配过对的手机 —— 主机名、
 * CPU 核数与利用率、内存与 swap 用量、磁盘总量与占用、网络收发字节与错误计数、进程运行
 * 时长。零消费方，纯粹是白送出去的机器指纹。
 *
 * 所以这里钉一条：谁想把监控面板加回来，先想清楚上面这些东西是不是该给手机看。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PKG_DIR = path.join(__dirname, '..');
// 装配层（随包发布的基础代实现）。lib/index.js 自「热替换」起只剩稳定外壳，
// 路由与依赖都在这里，所以扫引用要扫这个文件。
const INDEX = path.join(PKG_DIR, 'lib', 'impl.js');

const read = (p) => fs.readFileSync(p, 'utf8');

test('监控模块和三条路由都不在了', () => {
  assert.equal(
    fs.existsSync(path.join(PKG_DIR, 'lib', 'mobile', 'monitoring.js')),
    false,
    'lib/mobile/monitoring.js 应当已删除；它对外暴露主机名/CPU/内存/磁盘/网络/运行时长，且已无任何消费方',
  );
  const src = read(INDEX);
  assert.doesNotMatch(src, /require\(['"]\.\/mobile\/monitoring\.js['"]\)/, 'lib/impl.js 不该再 require 它');
  for (const route of [
    '/api/mobile/v1/monitoring/servers',
    '/api/mobile/v1/monitoring/alerts',
    '/api/mobile/v1/monitoring/servers/local/snapshot',
  ]) {
    assert.equal(src.includes(route), false, `路由 ${route} 应当已下线`);
  }
});

test('整棵插件树里不再有人引用 monitoring 模块', () => {
  // 压成单行的旧文件最容易漏网：正则要跨行扫，光看 route('/api/...') 那几行不够。
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      // 跳过本文件：它自己就带着那个正则字面量，扫到自己会永远命中自己。
      if (full === __filename) continue;
      if (!/\.(js|cjs|mjs|ts|tsx)$/.test(entry.name)) continue;
      const src = read(full);
      if (/mobile\/monitoring|monitoring\.(list|alerts|snapshot|collect)\s*\(/.test(src)) {
        hits.push(path.relative(PKG_DIR, full));
      }
    }
  };
  walk(PKG_DIR);
  assert.deepEqual(hits, [], `这些文件还在引用已删除的监控模块：${hits.join(', ')}`);
});

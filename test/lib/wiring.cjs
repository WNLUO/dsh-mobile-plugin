'use strict';

/**
 * 读「路由接线」的源码文本。
 *
 * 移动端路由表住在 lib/routes/mobile-api.js，装配层只留一句 registerMobileRoutes(...)
 * 调用。断言「某条路由挂没挂、某个 handler 模块有没有被引入」时，两端都要看，所以这里
 * 把两个文件拼起来返回；断言里写 `require\(['"](?:\.\.?\/mobile)\/X` 就能同时容忍
 * `./mobile/X.js`（装配层侧）与 `../mobile/X.js`（路由表侧）两种相对写法。
 *
 * 读的是 `lib/impl.js` 而不是 `lib/index.js`：后者自「热替换」起只剩稳定外壳
 * （发现代际、装载、换代），路由与 handler 依赖全在 impl.js 里。
 */

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..', '..');

/** 装配层 + 移动端路由表。用于「这条路由挂没挂」「这个 handler 有没有被引用」。 */
const readWiring = () => `${readFileSync(join(ROOT, 'lib', 'impl.js'), 'utf8')}\n${readFileSync(join(ROOT, 'lib', 'routes', 'mobile-api.js'), 'utf8')}`;

/** 只看路由表本身。用于「这张表里不该出现某些东西」这类反向断言。 */
const readRouteTable = () => readFileSync(join(ROOT, 'lib', 'routes', 'mobile-api.js'), 'utf8');

/**
 * 镜像推送与 sidecar 生命周期的实现文本。
 *
 * 与 readWiring 分开而不是并进去：readWiring 被十几条「某条路由没被引入」的反向断言
 * 依赖，把旁支代码混进来会让那些断言的噪声变大、失败更难读。
 */
const readMirrorWiring = () =>
  `${readFileSync(join(ROOT, 'lib', 'mirror', 'pusher.cjs'), 'utf8')}\n${readFileSync(join(ROOT, 'lib', 'sidecar-lifecycle.cjs'), 'utf8')}`;

module.exports = { ROOT, readWiring, readRouteTable, readMirrorWiring };
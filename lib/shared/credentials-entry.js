'use strict';

/**
 * 凭据包 `dsh-mobile-credentials` 的入口。
 *
 * 它在盘上有**两代布局**：
 *
 *   - 新布局：嵌在插件包内 —— `<插件包>/dsh-mobile-credentials/lib/credentials.js`
 *     （一代自包含，回滚时凭据版本跟着一起回滚）；
 *   - 旧布局：与插件包同级 —— `node_modules/dsh-mobile-credentials/…`，
 *     代际目录下则是 `<代>/dsh-mobile-credentials/…`。
 *
 * 往哪里落由**外壳**（`lib/shell/ota.js` 的资产重映射）决定，而外壳在进程启动时就被 Node
 * 缓存住、换不掉。布局迁移那一次，旧外壳把凭据放进同级目录、新实现却按嵌套路径 require，
 * 结果是「装完激活才炸 Cannot find module」——热更半装成功，留下的一代还是残缺的。
 *
 * 所以这里两条路都试，谁在就用谁：旧外壳配新实现也能跑起来，布局迁移不再是地雷。
 */

/** 新布局：`<插件包>/dsh-mobile-credentials/`（本文件在 `<插件包>/lib/shared/`）。 */
const NESTED = '../../dsh-mobile-credentials/lib/credentials.js';
/** 旧布局：与插件包同级。 */
const SIBLING = '../../../dsh-mobile-credentials/lib/credentials.js';

let cached = null;

/** 找到凭据包入口；两条布局都没有时抛 MODULE_NOT_FOUND，并说清试过哪两条路。 */
function credentialsEntry() {
  if (cached) return cached;
  const tried = [];
  for (const candidate of [NESTED, SIBLING]) {
    try {
      cached = require(candidate);
      return cached;
    } catch (error) {
      if (!error || error.code !== 'MODULE_NOT_FOUND') throw error;
      tried.push(candidate);
    }
  }
  const error = new Error(
    `找不到凭据包 dsh-mobile-credentials（试过 ${tried.join('、')}）：它要么嵌在插件包内，`
    + '要么与插件包同级。请重新完整安装插件。',
  );
  error.code = 'MODULE_NOT_FOUND';
  throw error;
}

module.exports = { credentialsEntry, CREDENTIALS_CANDIDATES: [NESTED, SIBLING] };

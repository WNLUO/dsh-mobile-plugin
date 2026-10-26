'use strict';

/**
 * 凭据包 `dsh-mobile-credentials` 的入口。
 *
 * 它在盘上有两代布局：新布局嵌在插件包内（一代自包含，回滚时凭据跟着一起回滚），旧布局与
 * 插件包同级。往哪里落由外壳的资产重映射决定，而外壳在进程启动时就被 Node 缓存住、换不掉；
 * 迁移期新旧外壳可能各按一种布局放置，只认一条路就会「装完激活才炸 Cannot find module」。
 *
 * 所以这里两条路都试，谁在就用谁。
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

'use strict';

/**
 * 网页版入口携带电脑插件目录能力，App 不向旧插件发送尚未支持的直达请求。
 *
 * 网页版里装着全部插件的管理界面，手机上要直接用它，就得让 App 的 WebView 以已登录身份
 * 打开宿主自己的 web 端口。而那个端口只认环回、网页版每次启动换一枚一次性令牌，所以
 * 这件事只能由宿主来办：它已经把令牌签好了，没有理由让手机再走一遍登录。
 *
 * 令牌是凭据，所以这条端点走 `guarded`——只有已配对设备拿得到，令牌也绝不进日志。
 *
 * 两个值都现取，不缓存：端口会被配置改，连接服务会随宿主重启换一份实例。任何一环取不到
 * 都如实回「不可用」，让 App 退回「请在电脑上打开网页版」；这里抛错只会把一次能力探测
 * 变成一条 500，反而看不出是哪一格缺了。
 */

const { sendJson } = require('../shared/http-util');

/**
 * 宿主 web 服务真正在听的端口。
 *
 * 取 `ctx.webServer.port` 而不是配置里的首选值：真正在听的是它，网页版也只绑在这个号上。
 */
function hostPortOf(ctx) {
  try {
    const port = ctx?.webServer?.port;
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

/**
 * 网页版的一次性登录令牌，挂在连接服务的 `browserAuth` 上。
 *
 * 用 `ctx.get('connection')` 而不是把它写进 `inject`：注入一个这个宿主版本里没有的服务，
 * 会让整行永远 pending（见 `host-bridge/transport.js` 里 `peerOf` 的注释）。服务不在、
 * 字段不在、值不是非空字符串，都算这台宿主现在给不出令牌。
 */
function launchTokenOf(ctx) {
  try {
    const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : null;
    const token = connection && connection.browserAuth ? connection.browserAuth.launchToken : null;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** `GET /api/mobile/v1/host-web` */
async function handleHostWeb(ctx, _req, res) {
  const port = hostPortOf(ctx);
  if (port === null) return sendJson(res, 200, { ok: true, available: false, reason: 'no-port' });
  const token = launchTokenOf(ctx);
  if (token === null) return sendJson(res, 200, { ok: true, available: false, reason: 'no-launch-token' });
  sendJson(res, 200, { ok: true, available: true, port, token, pluginPages: true });
}

module.exports = {
  handleHostWeb,
  hostPortOf,
  launchTokenOf,
};

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
 * 令牌有两条来路：老宿主的 `connection.browserAuth`，以及 0.2.3-alpha.1 起认证拆包后由
 * `webserver/entry-url` 事件同步交回的入口。后者是兼容适配，事件名与字段格式属宿主内部
 * 约定，本仓无法独立证实，待真机验证。
 *
 * 两个值都现取，不缓存：端口会被配置改，连接服务会随宿主重启换一份实例，令牌是否在同一
 * 实例内轮换也无据可查（同步 emit 很便宜，宁可每次现取）。任何一环取不到都如实回
 * 「不可用」，让 App 退回「请在电脑上打开网页版」；这里抛错只会把一次能力探测
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
 * 新宿主兜底：主动派发一次 `webserver/entry-url`，让认证监听器把入口同步填进数组。
 *
 * baseUrl 用已知端口自拼，不调 `webServer.getOrigin()` —— 本仓只用 `webServer.port/.host`，
 * 那个方法是否存在无法证实。事件名、入口的 `url` 字段和 `token` 参数也都是宿主内部约定，
 * 本仓 0 命中；宿主再改版这条兜底会再失效，这是兼容适配不是根因已证。
 *
 * 只认环回且端口就是本插件 web 端口的入口：同一事件会跑所有监听器，别的服务的入口也带
 * 自己的 token，不按 origin/host 过滤就会把凭据串给人家。
 */
function launchTokenFromEntries(ctx) {
  const port = hostPortOf(ctx);
  const webServer = ctx?.webServer;
  if (port === null || !webServer || typeof ctx?.emit !== 'function') return null;
  const entries = [];
  ctx.emit(webServer, 'webserver/entry-url', `http://127.0.0.1:${port}`, entries);
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    const raw = entry && entry.url;
    if (typeof raw !== 'string') continue;
    let url;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:') continue;
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') continue;
    if (url.port !== String(port)) continue;
    const token = url.searchParams.get('token');
    if (typeof token === 'string' && token.length > 0) return token;
  }
  return null;
}

/**
 * 网页版的一次性登录令牌。
 *
 * 老宿主挂在连接服务的 `browserAuth` 上；0.2.3-alpha.1 起认证拆到独立包、这个字段被删掉，
 * 就走 `webserver/entry-url` 同步收回（见 `launchTokenFromEntries`）。两条路都给不出才算
 * 这台宿主现在没有令牌。
 *
 * 用 `ctx.get('connection')` 而不是把它写进 `inject`：注入一个这个宿主版本里没有的服务，
 * 会让整行永远 pending（见 `host-bridge/transport.js` 里 `peerOf` 的注释）。值不是非空字符串
 * 也算取不到。任何异常一律回 null，能力探测不该变成 500。
 */
function launchTokenOf(ctx) {
  try {
    const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : null;
    const legacy = connection && connection.browserAuth ? connection.browserAuth.launchToken : null;
    if (typeof legacy === 'string' && legacy.length > 0) return legacy;
    return launchTokenFromEntries(ctx);
  } catch {
    return null;
  }
}

/** `GET /api/mobile/v1/host-web` */
async function handleHostWeb(ctx, _req, res) {
  const port = hostPortOf(ctx);
  const token = port === null ? null : launchTokenOf(ctx);
  if (port === null) return sendJson(res, 200, { ok: true, available: false, reason: 'no-port' });
  if (token === null) return sendJson(res, 200, { ok: true, available: false, reason: 'no-launch-token' });
  sendJson(res, 200, { ok: true, available: true, port, token, pluginPages: true });
}

module.exports = {
  handleHostWeb,
  hostPortOf,
  launchTokenOf,
};

'use strict';

/**
 * POST /api/mobile/v1/push-token —— iOS 推送令牌上报。
 *
 * App 拿到 APNs 令牌（应用启动时向系统注册）就打到这里；宿主核对完设备身份
 * （guarded 已做），经隧道帧 `pushRegister` 转交中转落表。中转没配 APNs 密钥时
 * 那头静默忽略——这条路由照常回 ok：「推没推成」不是 App 要操心的事，它没有
 * 可以据此改变行为的下一步。
 *
 * 隧道不在时也回 ok：令牌上报是幂等的，App 下次启动会再报，不值得为它排队重试。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');

/**
 * @param {object} deps 装配注入。`pushNotify` 是 `mobile/push-notify.js` 的出口
 *   （缺了就只回 ok——推送没接线时令牌上报不该 500）。
 */
function createPushTokenHandler(deps) {
  const pushNotify = deps.pushNotify || null;
  return function handlePushToken(_ctx, req, res) {
    void readJsonBody(req).then((body) => {
      const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim() : '';
      const token = typeof body?.token === 'string' ? body.token.trim() : '';
      const platform = typeof body?.platform === 'string' ? body.platform.trim() : 'ios';
      if (!deviceId || !token) {
        sendJson(res, 400, { ok: false, error: 'deviceId and token are required' });
        return;
      }
      if (pushNotify) pushNotify.registerToken(deviceId, token, platform);
      sendJson(res, 200, { ok: true });
    }, () => sendJson(res, 400, { ok: false, error: 'invalid json' }));
  };
}

module.exports = { createPushTokenHandler };

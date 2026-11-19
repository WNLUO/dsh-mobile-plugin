'use strict';

/**
 * 认领当前身份：`POST /api/mobile/v1/device-credential/sync-identity`。
 *
 * 场景是「换身份」的过渡期：宿主把实例号从旧号换成新号后，已配对的手机手上的凭据还挂在
 * 旧号下（凭据串整串哈希查库，改号那枚就查不到了）。这条接口让手机用**旧号下仍有效的凭据**
 * 换一枚**当前号**的新凭据：deviceKey / keyId / 权限 / 设备信息原样继承，旧记录**不立刻吊销**
 * （手机可能还没把新的存下来，立刻吊销会把它锁在门外——与 credential-upgrade 同一口径）。
 *
 * 鉴权在路由守卫那层完成（它已经同时认新旧号，见 mobile/auth.js 的 instanceIdsOf）；这里只
 * 按出示的凭据反查记录，判断它挂在当前号还是旧号：
 *  - 已是当前号 → 原样返回出示的那一枚（幂等，续期交给鉴权顺手做）；
 *  - 挂在旧号 → 按当前号重签一枚返回（供 APP 复用 upgrade 那套 patch 逻辑原子替换）。
 *
 * 响应形状与 `device-credential/upgrade` 对齐：`{ ok, instanceId, token, cookie,
 * deviceCredential, keyId?, permissions?, credentialExpiresAt, serverTime }`。
 */

const { sendJson } = require('../shared/http-util.js');
const permissions = require('./permissions.js');
const { presentedCredential } = require('./credential-upgrade.js');

/** 一条记录的有效权限位：设过就照抄，没设过（老记录）按全权回。 */
function effectivePermissions(record) {
  return Array.isArray(record && record.permissions) ? record.permissions.slice() : permissions.permissionsForTier('full');
}

/** 从记录里挑出重建凭据要继承的设备元信息。 */
function deviceMetaOf(record) {
  const src = record && typeof record === 'object' ? record : {};
  const meta = {};
  for (const key of ['deviceId', 'name', 'model', 'platform', 'osVersion', 'appVersion', 'packageId', 'buildNumber', 'channel']) {
    if (typeof src[key] === 'string' && src[key]) meta[key] = src[key];
  }
  return meta;
}

/** 一枚凭据对应的 cookie 值（与 upgrade 回包同口径）。 */
function cookieOf(token) {
  return 'dsh_lan=' + token;
}

/**
 * 处理认领当前身份。
 *
 * @param {object} req
 * @param {object} res
 * @param {{ instanceId: string, previousInstanceId?: string, store: object }} deps
 */
async function handleSyncIdentity(req, res, deps) {
  const currentId = String((deps && deps.instanceId) || '');
  const previousId = String((deps && deps.previousInstanceId) || '');
  const store = deps && deps.store;
  if (!store || !currentId) {
    return sendJson(res, 503, { ok: false, error: { code: 'unavailable', message: '凭据库不可用' } });
  }

  const presented = presentedCredential(req);
  if (!presented) {
    return sendJson(res, 401, { ok: false, error: { code: 'unauthorized', message: '缺少凭据' } });
  }

  // 出示的凭据挂在哪个号下：当前号优先，再试旧号（过渡期手机还没换过来）。
  const ids = [currentId, previousId].filter((id, index, all) => id && all.indexOf(id) === index);
  let record = null;
  let ownerId = '';
  for (const id of ids) {
    const found = store.lookup(presented, id);
    if (found) { record = found; ownerId = id; break; }
  }
  if (!record) {
    return sendJson(res, 401, { ok: false, error: { code: 'unauthorized', message: '凭据无法识别' } });
  }
  if (record.revokedAt) {
    return sendJson(res, 401, { ok: false, error: { code: 'revoked', message: '凭据已失效' } });
  }
  if (record.expiresAt && record.expiresAt <= Date.now()) {
    return sendJson(res, 401, { ok: false, error: { code: 'expired', message: '凭据已过期' } });
  }

  // 已经是当前号：幂等返回出示的那一枚。
  if (ownerId === currentId) {
    return sendJson(res, 200, {
      ok: true,
      instanceId: currentId,
      token: presented,
      cookie: cookieOf(presented),
      deviceCredential: presented,
      ...(typeof record.keyId === 'string' && record.keyId ? { keyId: record.keyId } : {}),
      permissions: effectivePermissions(record),
      credentialExpiresAt: record.expiresAt || null,
      serverTime: Date.now(),
    });
  }

  // 挂在旧号下：按当前号重签一枚，继承设备密钥 / 权限 / 设备信息；旧记录保持有效。
  const issued = store.issue(currentId, deviceMetaOf(record), '', undefined, {
    ...(typeof record.deviceKey === 'string' && record.deviceKey ? { deviceKey: record.deviceKey } : {}),
    ...(typeof record.keyId === 'string' && record.keyId ? { keyId: record.keyId } : {}),
    ...(Array.isArray(record.permissions) ? { permissions: record.permissions.slice() } : {}),
  });
  return sendJson(res, 200, {
    ok: true,
    instanceId: currentId,
    token: issued.credential,
    cookie: cookieOf(issued.credential),
    deviceCredential: issued.credential,
    ...(typeof issued.keyId === 'string' && issued.keyId ? { keyId: issued.keyId } : {}),
    permissions: Array.isArray(issued.permissions) ? issued.permissions : permissions.permissionsForTier('full'),
    credentialExpiresAt: issued.expiresAt || null,
    serverTime: Date.now(),
  });
}

module.exports = { handleSyncIdentity, effectivePermissions, deviceMetaOf, cookieOf };

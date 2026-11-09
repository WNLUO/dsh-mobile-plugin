'use strict';

/**
 * 手机自助降档：`POST /api/mobile/v1/device-credential/permissions`，body `{ tier }`。
 *
 * 这是「手机只能收回、不能提权」那条在请求层的一道兜底：即使界面被绕过、请求被伪造，
 * 宿主也只接受「比当前权限更小或相等」的档位 —— 请求里要的权限位只要有一个不在当前集合里，
 * 当场 400 拒绝，绝不放宽。真正的授予 / 提权在电脑控制面的 `/api/relay/devices/permissions`，
 * 手机手上根本没有那条路的入口。
 *
 * 降的是这台设备名下**所有**活记录的权限（与电脑侧同一口径），否则重配 / 升级留下的旧凭据
 * 还是原来的档。
 */

const { sendJson } = require('../shared/http-util.js');
const { readJsonBody } = require('../shared/http-util.js');
const permissions = require('./permissions.js');

/** 请求出示的设备凭据（独立头优先，`Authorization` 只兼容早期客户端）。 */
function presentedCredential(req) {
  const header = req.headers && req.headers['x-dsh-device-credential'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const match = /^Bearer\s+([^\s]+)$/.exec(String((req.headers && req.headers.authorization) || ''));
  return match ? match[1] : null;
}

/** 一条记录当前的有效权限位（没设过 = 全权）。 */
function currentPermissions(record) {
  return Array.isArray(record && record.permissions) ? record.permissions.slice() : permissions.permissionsForTier('full');
}

/**
 * @param {object} req
 * @param {object} res
 * @param {{ instanceId: string, store: object }} deps
 */
function handleDevicePermissions(req, res, deps) {
  return handleAsync(req, res, deps).catch((error) => {
    sendJson(res, 500, { ok: false, error: { code: 'internal', message: String(error && error.message ? error.message : error) } });
  });
}

async function handleAsync(req, res, deps) {
  const instanceId = String((deps && deps.instanceId) || '');
  const store = deps && deps.store;
  if (!store) return sendJson(res, 503, { ok: false, error: { code: 'unavailable', message: '凭据库不可用' } });

  const presented = presentedCredential(req);
  const record = presented ? store.lookup(presented, instanceId) : null;
  // 升级前的无状态 HMAC 通行证在库里没有记录、也就没有 deviceId —— 那种没法按设备改权限，
  // 如实回一句让人重新扫码升级，而不是偷偷放行或失败得不明白。
  if (!record) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'no-device-record', message: '这台设备还没有可管理的凭据记录，请更新 App 后重新扫码' },
    });
  }

  // 协议 v2 的 body 由守卫解好后放在 req.body；明文老会话的 body 还挂在流上，现读。
  const body = req.body && typeof req.body === 'object' ? req.body : ((await readJsonBody(req, 16 * 1024)) || {});
  const tier = body.tier;
  if (!permissions.isKnownTier(tier)) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '权限档位只能是 readonly / approve / full' } });
  }

  const requested = permissions.permissionsForTier(tier);
  const current = currentPermissions(record);
  // 只许收窄：requested 必须是 current 的子集。多出任何一个位就是提权，直接拒。
  const isSubset = requested.every((perm) => current.includes(perm));
  if (!isSubset) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'permission-escalation-denied', message: '手机只能收回权限，提权请在那台电脑上操作', current, requested },
    });
  }

  let updated = 0;
  try {
    updated = store.setDevicePermissions(instanceId, record.deviceId, requested);
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: { code: 'internal', message: String(error && error.message ? error.message : error) } });
  }
  return sendJson(res, 200, { ok: true, tier, permissions: requested, updated });
}

module.exports = { handleDevicePermissions, presentedCredential, currentPermissions };

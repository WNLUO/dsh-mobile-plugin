'use strict';

/**
 * 移动端「这台电脑上还连着哪些手机」：只读清单 + 单台吊销，外加凭据时效投影。
 *
 * 真源是宿主的每设备凭据库（`dsh-mobile-credentials` 的 `listDevices` / `revokeDevice`）。
 * 这里只做两件事：把一行设备压成手机要画的东西，以及按设备标识吊销一台。控制面那条
 * `/api/relay/devices` 只认本机，手机打不到；移动端此前也只能看到自己这一台，所以要
 * 单开这两条。清单里的 `hash` / `hostToken` / `deviceKey` 一律不回，跟控制面同一口径。
 *
 * 吊销按 `deviceId` 整台做（该名下所有活记录一起收），不是只收出示的那一枚 —— 同一台
 * 手机重配、升级会留下好几条活凭据，只吊一条等于旧的那枚还能用。被吊销的设备下一次请求
 * 由守卫回 `device-revoked`（「请重新扫码」），这条不用在这里再拼文案。
 *
 * 时效投影（第 54 条）：凭据库记录里只有 `createdAt` / `expiresAt`，续期是「剩余不足一半
 * 就把 `expiresAt` 后推一个 TTL」，所以「最近一次续期」= `expiresAt - TTL`（早于签发时刻
 * 就是从未续期，不回这一格）。这几格只从记录算，不改凭据库本身。
 */

const { sendJson, readJsonBody } = require('../shared/http-util.js');

const DEVICE_ID_MAX = 128;                 // 与凭据库签发时同一个截断长度
const FALLBACK_TTL_MS = 365 * 24 * 3600 * 1000; // 凭据库默认有效期（`DEFAULT_TTL_MS` 的兜底）
const RENEW_EPSILON_MS = 60 * 1000;        // 续期时刻与签发时刻差不到一分钟，按「从未续期」处理

/** 凭据库的默认 TTL；拿不到就用本文件的兜底，保证时效投影总能算出一个结果。 */
function ttlOf(store) {
  const ttl = store && Number(store.DEFAULT_TTL_MS);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : FALLBACK_TTL_MS;
}

/**
 * 一条凭据（或一台设备聚合后）的时效投影。
 *
 * @param {{ createdAt?: number, boundAt?: number, expiresAt?: number }} record
 * @param {object} store 凭据库（用来读默认 TTL）
 * @returns {{ authorizedAt: number|null, renewedAt: number|null, expiresAt: number|null } | null}
 */
function credentialTiming(record, store) {
  if (!record || typeof record !== 'object') return null;
  const authorizedAt = Number(record.createdAt ?? record.boundAt) || 0;
  const expiresAt = Number(record.expiresAt) || 0;
  if (!authorizedAt && !expiresAt) return null;
  let renewedAt = 0;
  if (expiresAt) {
    const renewed = expiresAt - ttlOf(store);
    if (authorizedAt && renewed > authorizedAt + RENEW_EPSILON_MS) renewedAt = renewed;
  }
  return {
    authorizedAt: authorizedAt || null,
    renewedAt: renewedAt || null,
    expiresAt: expiresAt || null,
  };
}

/**
 * 本机这枚凭据的时效投影（`GET /api/mobile/v1/status` 的 `credential` 那一格用它）。
 *
 * 传请求对象：从它出示的那枚凭据查记录。查不到记录（升级前的无状态 HMAC 通行证）就回
 * null —— 那种凭据本来就没有记录，也就没有签发 / 到期时刻可报。
 */
function credentialTimingFor(store, instanceId, req) {
  if (!store || typeof store.lookup !== 'function' || !req) return null;
  const headers = req.headers || {};
  const header = headers['x-dsh-device-credential'];
  const presented = typeof header === 'string' && header.trim()
    ? header.trim()
    : ((/^Bearer\s+([^\s]+)$/.exec(String(headers.authorization || '')) || [])[1] || null);
  if (!presented) return null;
  const record = store.lookup(presented, String(instanceId || ''));
  return record ? credentialTiming(record, store) : null;
}

/** 设备标识清洗：只留短串，畸形的一律拒绝，别拿垃圾去碰凭据库。 */
function normalizeDeviceId(value) {
  if (typeof value !== 'string') return null;
  const deviceId = value.trim();
  if (!deviceId || deviceId.length > DEVICE_ID_MAX) return null;
  return deviceId;
}

/** 一台设备的一行（`listDevices` 的活动行 → 手机要的形状）。 */
function toPairedDevice(row, store, latest) {
  return {
    deviceId: String(row.deviceId || ''),
    name: typeof row.name === 'string' ? row.name : '',
    model: typeof row.model === 'string' ? row.model : '',
    platform: typeof row.platform === 'string' ? row.platform : '',
    osVersion: typeof row.osVersion === 'string' ? row.osVersion : '',
    appVersion: typeof row.appVersion === 'string' ? row.appVersion : '',
    boundAt: Number(row.boundAt) || 0,
    lastSeenAt: Number(row.lastSeenAt) || 0,
    bindings: Number(row.bindings) || 0,
    legacy: row.legacy === true,
    encrypted: row.encrypted === true,
    // 时效取**这一台最新签发的那条**：聚合行只给「最早的绑定时刻 + 最晚的到期时刻」，
    // 拿它俩相减会把「重配过一次」说成「续期过」。续期只发生在单条记录上。
    credential: credentialTiming(latest || { createdAt: row.boundAt, expiresAt: row.expiresAt }, store),
  };
}

/**
 * 每台设备最新签发的那条活记录（按 `deviceId`）。
 *
 * `listActive` 一条记录一行，这里按签发时刻取最大 —— 时效要算在它上面，见 `toPairedDevice`。
 * 老凭据库没有 `listActive` 就回空表，调用方退回聚合行那两格。
 */
function latestRecords(store, instanceId) {
  const out = new Map();
  if (typeof store.listActive !== 'function') return out;
  for (const record of store.listActive(instanceId) || []) {
    const key = String(record.deviceId || '');
    if (!key) continue;
    const previous = out.get(key);
    if (!previous || (Number(record.createdAt) || 0) > (Number(previous.createdAt) || 0)) out.set(key, record);
  }
  return out;
}

/**
 * `GET /api/mobile/v1/paired-devices` —— 这台电脑上仍有效的设备清单（只读）。
 *
 * `serverNow` 给手机算「几分钟前」用（手机与宿主的时钟可能差得多，但都是同一台机器的基准）。
 */
async function handlePairedDevices(_req, res, deps) {
  const instanceId = String((deps && deps.instanceId) || '');
  const store = deps && deps.store;
  if (!store || typeof store.listDevices !== 'function') {
    return sendJson(res, 503, { ok: false, error: { code: 'unavailable', message: '凭据库不可用' } });
  }
  try {
    const now = Date.now();
    const latest = latestRecords(store, instanceId);
    const devices = (store.listDevices(instanceId) || [])
      .map((row) => toPairedDevice(row, store, latest.get(String(row.deviceId || ''))));
    return sendJson(res, 200, { ok: true, serverNow: now, devices });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: { code: 'internal', message: String(error && error.message ? error.message : error) } });
  }
}

/**
 * `POST /api/mobile/v1/paired-devices/revoke` —— body `{ deviceId }`，吊销一台设备。
 *
 * 尽力而为地主动收掉这台设备已开着的流（`dropDeviceStreams`，装配层可选注入）：token 换了
 * 只保证「下一次请求」被拒，一条已经开着的 SSE 不会自己停。
 */
async function handlePairedDevicesRevoke(req, res, deps) {
  const instanceId = String((deps && deps.instanceId) || '');
  const store = deps && deps.store;
  if (!store || typeof store.revokeDevice !== 'function') {
    return sendJson(res, 503, { ok: false, error: { code: 'unavailable', message: '凭据库不可用' } });
  }
  // 协议 v2 的 body 由守卫解好后放在 req.body；明文老会话的 body 还挂在流上，现读。
  const body = req.body && typeof req.body === 'object'
    ? req.body
    : ((await readJsonBody(req, 16 * 1024)) || {});
  const deviceId = normalizeDeviceId(body.deviceId);
  if (!deviceId) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { deviceId }' } });
  }
  let revoked = 0;
  try {
    revoked = store.revokeDevice(instanceId, deviceId);
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: { code: 'internal', message: String(error && error.message ? error.message : error) } });
  }
  let closed = 0;
  try {
    closed = typeof deps.dropDeviceStreams === 'function' ? deps.dropDeviceStreams(deviceId) : 0;
  } catch { /* 尽力：断流失败不影响吊销已经落地 */ }
  return sendJson(res, 200, { ok: true, revoked, closed });
}

module.exports = {
  handlePairedDevices,
  handlePairedDevicesRevoke,
  credentialTiming,
  credentialTimingFor,
  normalizeDeviceId,
  toPairedDevice,
  latestRecords,
};

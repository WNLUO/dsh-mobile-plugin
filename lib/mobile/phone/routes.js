'use strict';

/**
 * 「让 AI 操作手机」的三条普通状态路由（动作字节流在 `phone/service.js` 的升级口上）。
 *
 * - `GET  /api/mobile/v1/phone/status`：这台电脑上「操作手机」这一侧的状态 —— 服务在不在、
 *   哪几台手机连着、这条会话绑的是哪台。App 的配对向导与设置页读它。
 * - `GET  /api/mobile/v1/phone/devices`：此刻认识哪几台手机。模型改绑、用户看「另一台」时
 *   都读这份清单。
 * - `POST /api/mobile/v1/phone/unbind`：解除。带 `sessionId` 只清这条会话的绑定；不带就断开
 *   所有连接并清掉所有指向它们的绑定。
 *
 * 三条都只读状态或做收尾，**没有一条能往手机上发动作**：发动作只有 `phone/tools.js` 那条路，
 * 且只由模型在会话里触发。这个分界是刻意的 —— 路由服务的是「正在看设置页的人」，工具服务的
 * 是「正在替用户干活的模型」。
 *
 * 装配方式：路由表（`routes/mobile-api.js`）只认「路径 → handler」，所以这里给的是
 * `createPhoneRoutes(deps)` 造出来的一组 handler，`deps` 由装配层从 `phone/index.js` 转来。
 */

const { sendJson, readJsonBody } = require('../../shared/http-util');
const binding = require('./binding.js');

/** 设备标题：机型优先，没有机型才用 deviceId 的短尾巴。与凭据面板同一口径。 */
function deviceLabel(row) {
  const model = row && typeof row.model === 'string' ? row.model.trim() : '';
  if (model) return row.suffix ? `${model} · ${row.suffix}` : model;
  const id = row && typeof row.deviceId === 'string' ? row.deviceId : '';
  return id ? `手机 ${id.slice(0, 8)}` : '一台没认出身份的手机';
}

/**
 * 这台电脑认识哪几台手机、哪几台此刻连着。
 *
 * 名字从凭据库拿（那里才是「这台电脑认识哪些手机」的真值），拿不到就退回 id 的短尾巴；
 * 已经连上来但凭据库里没有的（老记录、刚重置过的库）也照样报出来 —— 否则模型看不见一台
 * 明明能用的手机。
 */
function listDevices(deps) {
  const known = [];
  try {
    if (deps.credentials && deps.instanceId) {
      for (const row of deps.credentials.listDevices(deps.instanceId)) known.push(row);
    }
  } catch {
    // 凭据库读不出来不影响「谁在线」这件事：退化成只报 id。
  }
  const service = deps.getService ? deps.getService() : null;
  const online = new Map();
  if (service && service.devices) for (const [deviceId, link] of service.devices) online.set(deviceId, link);

  const rows = new Map();
  for (const row of known) {
    const live = online.get(row.deviceId);
    rows.set(row.deviceId, {
      deviceId: row.deviceId,
      name: deviceLabel(row),
      model: row.model || '',
      platform: row.platform || '',
      osVersion: row.osVersion || '',
      appVersion: row.appVersion || '',
      online: Boolean(live),
      lastSeenAt: row.lastSeenAt || 0,
    });
    if (live) online.delete(row.deviceId);
  }
  for (const [deviceId, link] of online) {
    const device = link.device || {};
    rows.set(deviceId, {
      deviceId,
      name: deviceLabel({ deviceId, model: device.model }),
      model: device.model || '',
      platform: device.platform || '',
      osVersion: device.osVersion || '',
      appVersion: device.appVersion || '',
      online: true,
      lastSeenAt: Date.now(),
    });
  }
  return [...rows.values()].sort((a, b) => (Number(b.online) - Number(a.online)) || (b.lastSeenAt - a.lastSeenAt));
}

function describeDevice(deps, deviceId) {
  const row = listDevices(deps).find((item) => item.deviceId === deviceId);
  return row ? row.name : deviceId;
}

/** GET /phone/status?sessionId=… */
async function handlePhoneStatus(deps, _ctx, req, res) {
  const url = new URL(req.url || '/', 'http://x');
  const sessionId = (url.searchParams.get('sessionId') || '').trim();
  const service = deps.getService ? deps.getService() : null;
  const devices = listDevices(deps);
  const payload = {
    ok: true,
    running: Boolean(service),
    online: devices.filter((row) => row.online).map((row) => row.deviceId),
    devices,
  };
  if (sessionId) {
    const bound = binding.boundDeviceOf(sessionId);
    payload.binding = {
      deviceId: bound || '',
      name: bound ? describeDevice(deps, bound) : '',
      lastSender: binding.lastSenderOf(sessionId) || '',
    };
  }
  sendJson(res, 200, payload);
}

/** GET /phone/devices */
async function handlePhoneDevices(deps, _ctx, _req, res) {
  sendJson(res, 200, { ok: true, devices: listDevices(deps) });
}

/**
 * POST /phone/unbind —— `{ sessionId?, deviceId? }`
 *
 * 不带参数是「这台电脑上操作手机这件事整个解除」：断开所有连接、清掉所有指向它们的绑定。
 * 带 `sessionId` 只清这一条会话的绑定（用户只是想让这条对话别再用那台手机）。
 *
 * 卸掉手机上那枚 adb 钥匙这一步只能由手机侧自己做（壳在手机上，宿主碰不到它），所以回包里
 * 如实写 `localReset: 'requested'`，界面据此提示「回手机上确认一下」。
 */
async function handlePhoneUnbind(deps, _ctx, req, res) {
  const body = await readJsonBody(req);
  const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  const deviceId = body && typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
  if (sessionId) {
    return sendJson(res, 200, {
      ok: true,
      clearedSession: binding.clearBinding(sessionId),
      disconnected: [],
      localReset: '',
    });
  }
  const service = deps.getService ? deps.getService() : null;
  const targets = deviceId ? [deviceId] : listDevices(deps).map((row) => row.deviceId);
  for (const id of targets) service?.kick?.(id);
  const cleared = targets.reduce((sum, id) => sum + binding.clearBindingForDevice(id), 0);
  sendJson(res, 200, { ok: true, clearedSession: false, clearedBindings: cleared, disconnected: targets, localReset: 'requested' });
}

/**
 * 造出路由表要的那组 handler。
 *
 * @param {object} deps
 * @param {() => object|null} deps.getService 取值器（服务随插件重载整体替换）
 * @param {object} [deps.credentials] 凭据库
 * @param {string} [deps.instanceId]
 */
function createPhoneRoutes(deps) {
  return {
    status: (ctx, req, res) => handlePhoneStatus(deps, ctx, req, res),
    devices: (ctx, req, res) => handlePhoneDevices(deps, ctx, req, res),
    unbind: (ctx, req, res) => handlePhoneUnbind(deps, ctx, req, res),
  };
}

module.exports = {
  createPhoneRoutes,
  handlePhoneStatus,
  handlePhoneDevices,
  handlePhoneUnbind,
  listDevices,
  describeDevice,
  deviceLabel,
};

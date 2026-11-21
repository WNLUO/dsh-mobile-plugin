// SSE 登记随本机换号迁移，清理回调与吊销始终使用当前实例归属。
'use strict';

const streams = new Map();
const registrations = new WeakMap();

/** 无实例参数保留旧调用口径；业务入口显式传当前实例。 */
function track(deviceId, res, instanceId = '') {
  if (typeof deviceId !== 'string' || !deviceId || !res) return () => {};
  const scope = String(instanceId || '');
  let devices = streams.get(scope);
  if (!devices) { devices = new Map(); streams.set(scope, devices); }
  let set = devices.get(deviceId);
  if (!set) { set = new Set(); devices.set(deviceId, set); }
  set.add(res);
  const registration = { scope };
  registrations.set(res, registration);
  return () => {
    const currentScope = registration.scope;
    const current = streams.get(currentScope);
    const active = current?.get(deviceId);
    if (!active) return;
    active.delete(res);
    if (active.size === 0) current.delete(deviceId);
    if (current.size === 0) streams.delete(currentScope);
  };
}

function reassignInstance(fromInstanceId, toInstanceId) {
  const from = String(fromInstanceId || '');
  const to = String(toInstanceId || '');
  if (from === to) return;
  const source = streams.get(from);
  if (!source) return;
  streams.delete(from);
  let target = streams.get(to);
  if (!target) { target = new Map(); streams.set(to, target); }
  for (const [deviceId, responses] of source) {
    let active = target.get(deviceId);
    if (!active) { active = new Set(); target.set(deviceId, active); }
    for (const res of responses) {
      const registration = registrations.get(res);
      if (registration) registration.scope = to;
      active.add(res);
    }
  }
}

function closeSet(set, deferClose) {
  const active = [...set].filter(res => !res.destroyed && !res.writableEnded);
  const close = () => {
    for (const res of active) {
      try { res.end?.(); } catch { /* 对端已经关闭 */ }
      try { res.destroy?.(); } catch { /* 同上 */ }
    }
  };
  if (deferClose) deferClose(close);
  else close();
  return active.length;
}

function drop(deviceId, instanceId, deferClose) {
  let closed = 0;
  for (const [scope, devices] of streams) {
    if (instanceId !== undefined && scope !== String(instanceId || '')) continue;
    const set = devices.get(deviceId);
    if (!set) continue;
    devices.delete(deviceId);
    if (devices.size === 0) streams.delete(scope);
    closed += closeSet(set, deferClose);
  }
  return closed;
}

function dropAll(instanceId) {
  let closed = 0;
  for (const [scope, devices] of streams) {
    if (instanceId !== undefined && scope !== String(instanceId || '')) continue;
    streams.delete(scope);
    for (const set of devices.values()) closed += closeSet(set);
  }
  return closed;
}

function size() {
  let total = 0;
  for (const devices of streams.values()) for (const set of devices.values()) total += set.size;
  return total;
}
function reset() { streams.clear(); }

module.exports = { track, reassignInstance, drop, dropAll, size, reset };

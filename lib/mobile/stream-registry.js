'use strict';

/**
 * 按设备登记的 SSE 流。
 *
 * token 换了只保证**下一次请求**被拒；一条已经开着的流不会自己断，被踢的手机还能继续收
 * 消息，直到它自己重连。不做这一步，「单台吊销」就只完成了一半。
 *
 * 登记表按 deviceId 分组：同一台手机可能同时开着两条流（会话流 + 设备级事件流），
 * 两台手机之间互不影响。收流由吊销那条路径调 `drop`，逐条 `end()` 掉。
 *
 * 这里**不做超时与配额**：宿主本来就是给自己那几台设备推东西，流的上限由它们自己的
 * 打开次数决定，加一层闸只会把「手机连着却收不到」变成一种新的失败形态。
 */
const streams = new Map();

/**
 * 登记一条流。
 *
 * @param {string} deviceId 设备 id（凭据记录上的 `deviceId`）
 * @param {object} res 这条流的响应对象（只需要 `end` 与 `destroy`）
 * @returns {() => void} 注销函数；流自己关掉时调用，避免表越攒越大
 */
function track(deviceId, res) {
  const key = typeof deviceId === 'string' ? deviceId : '';
  if (!key || !res) return () => {};
  let set = streams.get(key);
  if (!set) {
    set = new Set();
    streams.set(key, set);
  }
  set.add(res);
  return () => {
    const current = streams.get(key);
    if (!current) return;
    current.delete(res);
    if (current.size === 0) streams.delete(key);
  };
}

/**
 * 收掉这台设备上所有已建立的流。
 *
 * 先 `end()` 再 `destroy()`：`end` 让对端看到正常的流结束（App 会在下一次请求上收到
 * `device-revoked`，而不是一个「网络出错」）；对已经卡住的连接 `destroy` 是兜底。
 *
 * @returns {number} 实际收掉了多少条
 */
function drop(deviceId) {
  const key = typeof deviceId === 'string' ? deviceId : '';
  const set = streams.get(key);
  if (!set) return 0;
  streams.delete(key);
  let closed = 0;
  for (const res of set) {
    closed += 1;
    try { res.end?.(); } catch { /* 对端已经走了 */ }
    try { res.destroy?.(); } catch { /* 同上 */ }
  }
  return closed;
}

/** 测试与自检用：当前登记了多少条流。 */
function size() {
  let total = 0;
  for (const set of streams.values()) total += set.size;
  return total;
}

/** 测试用：清空登记表。 */
function reset() { streams.clear(); }

module.exports = { track, drop, size, reset };

'use strict';

/**
 * 换中转地址前的「搬迁登记」：在**旧隧道**上告诉中转「这台搬家到 to」，给帧留出真的离开
 * 本机的时间，再建新隧道；新隧道注册不上就把那条登记收回来（`to:""`）。
 *
 * 为什么非得在旧隧道上说：设备手上握的是旧地址，它只会在旧中转上找这台电脑。不先登记，
 * 换完地址那一刻，所有不在同一个局域网的设备就永远找不到它了 —— 「换服务器之后拿旧地址的
 * 设备永远学不到新地址」就是缺这一帧。
 *
 * 旧隧道**不立刻关**（两条路都一样）：新隧道注册期间它还在服务在途请求；失败时更是只有它
 * 还能发撤销。注册完成后再留 `OLD_TUNNEL_LINGER_MS`，让「已受理」或「失败」那一发响应
 * 沿着老路回去 —— 这一发的结果是用户填完地址之后唯一的反馈。
 *
 * 顺序只有这一份实现：worker 的 `configure()` 在检测到中转地址变了之后调 `switchRelay`，
 * 手机端与控制面两个入口都走同一条下发路径，不各写一套。
 */

const { T } = require('./protocol.js');
const core = require('./core.js');

/** MIGRATE 帧发出后留给它离开发送队列的时间：一次 `ws.send` 就进内核，200ms 足够。 */
const MIGRATE_FLUSH_MS = 200;

/** 新隧道注册成功后旧隧道还留多久：够一发 HTTP 响应（含中转那段）沿着旧路回完。 */
const OLD_TUNNEL_LINGER_MS = 1500;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 登记用的目标地址：与配置、设备手上那份同一个规范形态。 */
function migrateTarget(relayUrl) {
  return core.normalizeRelayUrl(relayUrl);
}

/** 在旧隧道上登记迁移；没连着就回 false（那就没什么可登记的）。 */
function announce(tunnel, relayUrl) {
  if (!tunnel || !tunnel.connected) return false;
  return tunnel.sendJson(T.migrate, 0, { to: migrateTarget(relayUrl), at: Date.now() }) === true;
}

/** 撤销登记（`to` 空串 = 这台没搬走）。 */
function revoke(tunnel) {
  if (!tunnel || !tunnel.connected) return false;
  return tunnel.sendJson(T.migrate, 0, { to: '', at: Date.now() }) === true;
}

/**
 * 换地址：登记 → 等帧出去 → 起新隧道 → 成功则稍后收旧隧道 / 失败则撤销并抛错。
 *
 * @param {object} opts
 * @param {object|null} opts.oldTunnel 旧隧道（可能没连上，那就只是重建）
 * @param {string} opts.relayUrl 要切过去的中转地址
 * @param {() => Promise<unknown>} opts.open 建一条**新**隧道并返回它的注册 Promise；
 *   不许先停旧的（旧的还要发撤销、还要把响应送回去）
 * @param {(tunnel: object) => void} opts.drop 停掉一条隧道
 * @returns {Promise<boolean>} 旧隧道上到底登记出去没有
 */
async function switchRelay({ oldTunnel, relayUrl, open, drop }) {
  /** 留一段再收旧隧道：那一发「已受理 / 失败原因」的响应还在它上面往回走。 */
  const dropLater = (tunnel) => {
    if (!tunnel) return;
    const linger = setTimeout(() => { try { drop(tunnel); } catch { /* 已经断开 */ } }, OLD_TUNNEL_LINGER_MS);
    if (typeof linger.unref === 'function') linger.unref();
  };
  const announced = announce(oldTunnel, relayUrl);
  // 帧必须先真的离开发送队列：紧接着建新隧道（以及失败后的撤销）都和这一帧的到达顺序有关。
  if (announced) await wait(MIGRATE_FLUSH_MS);
  let registered;
  try {
    registered = await open();
  } catch (error) {
    // 新地址没通：把登记收回去，旧中转别再把设备往一个连不上的地址送。
    revoke(oldTunnel);
    // 撤销之后也别立刻关：错误要沿旧隧道回到发起这次切换的那一发请求上 ——「如实回给
    // 调用方」只有这一条物理路径。
    dropLater(oldTunnel);
    throw error;
  }
  dropLater(oldTunnel);
  return announced && Boolean(registered);
}

module.exports = {
  switchRelay,
  announce,
  revoke,
  migrateTarget,
  MIGRATE_FLUSH_MS,
  OLD_TUNNEL_LINGER_MS,
};

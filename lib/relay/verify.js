'use strict';

/**
 * 试连中转：拿**新地址**真注册一次，注册上了才算这个地址能用，随后立刻断开。
 *
 * 手机和电脑面板上改中转地址，最坏的结果是这台电脑从网上消失 —— 而改地址的入口本身就挂在
 * 那条隧道上。先落盘再重建等于让用户在一次手滑之后自己走回电脑前，所以改之前必须先验证：
 * 这个动作就是那个验证。
 *
 * **临时实例 id**：中转按实例 id 认人，拿正式 id 去试连会把正在服务的那条顶掉（真机上表现
 * 为「点了一下验证，手机立刻掉线」）。所以用正式 id 加 `~probe~` 加随机段，连完马上断，
 * 不在中转上留实例。随机段不是防御性加盐：同一个实例连第二次探测时，中转那条旧记录还没被
 * 心跳清掉，撞上就会互相取代。
 */

const { randomBytes } = require('node:crypto');

const { RelayTunnel } = require('./tunnel.js');
const core = require('./core.js');

/** 临时实例 id 里的标记段：出错时一眼能看出这不是一台真的宿主。 */
const PROBE_MARK = '~probe~';

/** 试连的实例 id：正式 id + 标记 + 随机段，必然与正式 id 不同。 */
function probeInstanceId(instanceId) {
  return `${String(instanceId || '')}${PROBE_MARK}${randomBytes(4).toString('hex')}`;
}

/**
 * 用 `instanceId`（调用方给的是临时 id）连 `relayUrl` 并等到 `registered` 帧。
 *
 * resolve = 这个地址登录得了；reject = 地址形状不对、连不上、注册被拒或超时（消息原样往上
 * 回，手机上看的就是这句）。无论成败都断开：留一个实例在中转上，下次真连接会被它顶一下。
 */
async function verifyRelayRegistration({ relayUrl, instanceId, upstreamPort, name, registerSecret }) {
  // 地址形状不对在这里当场抛（与保存配置同一个判据），别等到 WebSocket 才炸。
  const tunnel = new RelayTunnel({
    relayUrl: core.tunnelWsUrl(relayUrl),
    instanceId,
    name: name || '',
    upstream: `http://127.0.0.1:${upstreamPort}`,
    registerSecret: typeof registerSecret === 'string' ? registerSecret : '',
  });
  try {
    await tunnel.start();
    return { ok: true };
  } finally {
    try { tunnel.stop(); } catch { /* 已经断开 */ }
  }
}

module.exports = { probeInstanceId, verifyRelayRegistration, PROBE_MARK };

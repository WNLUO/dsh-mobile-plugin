'use strict';

/**
 * iOS 推送的宿主侧出口：完成 / 失败 / 待回话发生时，经隧道发一帧给中转，
 * 由中转调 APNs 送到苹果。中转没配密钥时那头静默忽略，这里照发不误——
 * 「推没推成」不是宿主的账，宿主只负责「该推的时候说一声」。
 *
 * 走隧道而不是直接 HTTP 打中转：隧道连接已带准入校验（x-dsh-license），复用它
 * 就不用在中转上再开一条要鉴权的 HTTP 面。隧道不在时这次提醒就放弃——App 端
 * 自己的本地通知通道会在它回到前台 / 后台刷新时补上，推送只是增强。
 */

const FRAME_TTL_MS = 10_000;

/**
 * @param {object} deps
 * @param {() => object|null} deps.getSidecar 取 sidecar facade 的取值器（它有 pushSync 通道）。
 * @param {() => boolean} deps.tunnelConnected 隧道在不在。
 * @param {() => string} [deps.instanceId] 实例标识，帧里带上便于中转日志定位。
 */
function createPushNotifier(deps) {
  const getSidecar = typeof deps.getSidecar === 'function' ? deps.getSidecar : () => null;
  const tunnelConnected = typeof deps.tunnelConnected === 'function' ? deps.tunnelConnected : () => false;
  const instanceId = typeof deps.instanceId === 'function' ? deps.instanceId : () => '';

  /** 最近一次已发送的（会话, 轮次, 结局）指纹：同一次收尾会被事件流与列表折叠两条路
   *  各观察到一次，中转那边没有去重账，宿主必须自己只放一帧过去。 */
  let lastSent = null;
  let lastSentAt = 0;

  /**
   * 报告一轮收尾。`fact` 是 session-last-turn 的 `lastTurnOf` 形状
   * （{ turn, endedAt, status, ... }），只有 completed / failed 两种值得推。
   */
  function notifyTurnEnded(sessionId, fact, title) {
    if (!sessionId || !fact || typeof fact.turn !== 'number') return;
    if (fact.status !== 'completed' && fact.status !== 'failed') return;
    const fingerprint = `${sessionId}:${fact.turn}:${fact.status}`;
    const now = Date.now();
    if (fingerprint === lastSent && now - lastSentAt < FRAME_TTL_MS) return;
    lastSent = fingerprint;
    lastSentAt = now;
    const body = fact.status === 'failed'
      ? `出错了${fact.message ? `：${String(fact.message).slice(0, 60)}` : ''}`
      : '回复已完成';
    void send('push', {
      kind: 'push',
      pushFrame: 'send',
      deviceId: '',
      // deviceId 留空 = 这台实例上全部已登记设备都推。completion 的按设备记账
      // 在 App 自己手里（本机已读水位），中转只存「实例 → 令牌」一级。
      title: title || '任务提醒',
      body,
      sessionId,
      kind: fact.status === 'failed' ? 'failed' : 'completed',
      instanceId: instanceId(),
    });
  }

  /** App 侧上报的推送令牌转交给中转（登记 / 删除）。 */
  function registerToken(deviceId, token, platform) {
    return send('push', {
      kind: 'push',
      pushFrame: 'register',
      deviceId,
      ...(token ? { token, platform: platform || 'ios' } : { action: 'delete' }),
      instanceId: instanceId(),
    });
  }

  function send(kind, payload) {
    if (!tunnelConnected()) return Promise.resolve(false);
    const sidecar = getSidecar();
    if (!sidecar) return Promise.resolve(false);
    return sidecar.pushSync(payload).then(
      () => true,
      () => false,
    );
  }

  return { notifyTurnEnded, registerToken };
}

module.exports = { createPushNotifier };

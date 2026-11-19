'use strict';

/**
 * 读取隔离（镜像快照直回）这层的鉴权。
 *
 * `snapshotRead` 命中本地快照时直接序列化好 JSON 回给手机，**绕开了主进程的守卫**。早先
 * 这里只挡了「协议 v2 要回源信封」那一面，鉴权这一面还开着：只要知道实例号（它就印在配对
 * 二维码上），不带任何凭据也能经中转读到会话列表、工作区列表。所以这条捷径在回任何快照
 * 之前，必须自己按主进程守卫同样的口径验一遍凭据。
 *
 * 口径（与 `lib/mobile/auth.js` 的 `authOutcome`、`lib/relay/lan-proxy.js` 的 `authOutcome`
 * 一致，顺序是这里唯一要紧的东西）：
 *   - 凭据头 / `Authorization: Bearer` / `dsh_lan` cookie 三处，取所有非空候选；
 *   - 候选里**只要有一枚**是本机签发过的记录，就以记录为准：被吊销、已过期立即判否，
 *     **不许**再退回更宽松的无状态令牌（否则吊销永远不生效）；
 *   - 本机**一枚都查不到**时，才回退旧的无状态 HMAC token（升级前配过的老 App 走这条）
 *     与「中转签发的凭据」。
 *
 * 这里不复用 `authOutcome`：那条路每次都要读一遍 relay 状态文件拿实例号，而这是每条高频
 * 读都走的快路径；实例号、lanSecret 在本进程的 config 里都是现成的，用依赖注入传进来即可。
 *
 * @param {object} headers 请求头（原始大小写都行）
 * @param {{ lookup?: (presented: string) => object|null, verifyLanToken?: (token: string) => boolean }} deps
 * @returns {boolean} 是否放行；false 时调用方应回源，交给主进程守卫如实驳回。
 */
function snapshotAuthorized(headers, deps = {}) {
  const { lookup, verifyLanToken } = deps;
  const candidates = credentialCandidates(headers);
  if (!candidates.length) return false;

  const now = Date.now();
  for (const presented of candidates) {
    const known = typeof lookup === 'function' ? lookup(presented) : null;
    if (!known) continue;
    if (known.revokedAt) return false;
    if (known.expiresAt && known.expiresAt <= now) return false;
    return true;
  }

  // 本机不认识这些凭据：可能是升级前的 HMAC token，或中转签的。按无状态令牌再验一次。
  for (const presented of candidates) {
    try {
      if (typeof verifyLanToken === 'function' && verifyLanToken(presented)) return true;
    } catch { /* 验不过就继续看下一枚 */ }
  }
  return false;
}

/** 按大小写不敏感取一个头部的值；数组取第一个，非字符串或空值返回空串。 */
function headerValue(headers, target) {
  if (!headers || typeof headers !== 'object') return '';
  const lower = target.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== lower) continue;
    const raw = headers[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' ? value.trim() : '';
  }
  return '';
}

/** 三条出示凭据的通道：独立凭据头 → Bearer → dsh_lan cookie。去重后返回非空候选。 */
function credentialCandidates(headers) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    if (typeof value !== 'string') return;
    const token = value.trim();
    if (!token || seen.has(token)) return;
    seen.add(token);
    out.push(token);
  };

  push(headerValue(headers, 'x-dsh-device-credential'));
  const bearer = /^Bearer\s+([^\s]+)$/i.exec(headerValue(headers, 'authorization'));
  if (bearer) push(bearer[1]);
  const cookie = /(?:^|;\s*)dsh_lan=([^;]+)/.exec(headerValue(headers, 'cookie'));
  if (cookie) push(cookie[1]);
  return out;
}

/**
 * 与 `snapshotAuthorized` 同口径，但把**命中的那条记录**一并取出来。
 *
 * 存在只为一件事：判「这枚凭据是不是按协议 v2 配的」。绑了 `deviceKey` 的凭据说明设备
 * 当初走的是逐请求信封，它的高频读一旦被中转删掉 `x-dsh-proto` 头就会被当成老客户端，
 * 而快照捷径**不封信封**——那样列表 / 工作区就会以明文经中转送出去（主进程那条
 * `e2ee-required` 守不到捷径）。调用方拿到 `deviceKey` 就回源，交给主进程如实驳回。
 *
 * 只回本机记录；走旧无状态令牌兜底的（升级前老 App / 中转签发）没有记录，返回 null——
 * 那种凭据本来就不是 v2 绑定，不触发降级拦截。
 *
 * @param {object} headers 请求头（原始大小写都行）
 * @param {{ lookup?: (presented: string) => object|null }} deps
 * @returns {object|null} 命中且有效（未吊销 / 未过期）的本机凭据记录，否则 null
 */
function snapshotAuthRecord(headers, deps = {}) {
  const { lookup } = deps;
  const candidates = credentialCandidates(headers);
  if (!candidates.length) return null;
  const now = Date.now();
  for (const presented of candidates) {
    const known = typeof lookup === 'function' ? lookup(presented) : null;
    if (!known) continue;
    if (known.revokedAt) return null;
    if (known.expiresAt && known.expiresAt <= now) return null;
    return known;
  }
  return null;
}

module.exports = { snapshotAuthorized, snapshotAuthRecord, credentialCandidates };

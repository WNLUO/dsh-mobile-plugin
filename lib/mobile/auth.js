'use strict';

/**
 * dsh-mobile 鉴权：每设备凭据（T1）查库 + 旧 HMAC token 兜底。
 *
 * 新配对只发一枚 `<instanceId>.<exp>.<random>`（讨论记录 §3.2），它同时是 Bearer、
 * `dsh_lan` cookie 与 `X-Dsh-Device-Credential`。服务端按整串的 sha256 查凭据库，
 * **查到就以记录为准**（吊销 / 过期立即拒绝，不再回退）；查不到才回退到旧的
 * `<instanceId>.<exp>.<hmac(lanSecret)>` 无状态令牌 —— 那条只为升级前配过的老 App 保留。
 *
 * 顺序（凭据头 → Bearer → 旧 HMAC）是这里唯一要紧的东西。允许「本机签发的凭据被吊销后
 * 回退去验 HMAC」等于吊销永远不生效：那个 HMAC token 一年有效。
 */

const fs = require('node:fs');

const sharedToken = require('../shared/dshtoken');
const credentials = require('../shared/credentials-entry.js').credentialsEntry();

// Resolved lazily: freezing the path at module load ignored a later DSH_HOME
// change and made the lookup order-dependent on import timing.
function relayStatePath() {
  return require('../shared/paths').relayStateFile();
}

function loadRelayState() {
  try {
    return JSON.parse(fs.readFileSync(relayStatePath(), 'utf8'));
  } catch {
    return null;
  }
}

/** 校验旧的无状态移动 token：`<instanceId>.<exp>.<hmac(lanSecret)>`。 */
function verifyMobileToken(token) {
  if (!token) return false;
  const state = loadRelayState();
  if (!state || !state.lanSecret || !state.instanceId) return false;
  return sharedToken.verifyLanToken(state.lanSecret, token, state.instanceId);
}

/**
 * 请求出示的凭据原文，取不到返回 null。
 *
 * 接受**任意非空串**，不再只认 `dshc_` 前缀：协议 v2 的 T1 是 `<实例号>.<exp>.<随机>`，
 * 旧版是 `dshc_…`，升级前的老 App 还有 HMAC Bearer —— 三种都从这里过，由查库结果决定
 * 走哪条路。App 把设备凭据放在独立的 `X-Dsh-Device-Credential` 头里、`Authorization`
 * 留给宿主 token；`Authorization` 分支是给「只有一枚 Bearer 的旧客户端」的兜底。
 */
function presentedCredential(req) {
  const raw = req.headers['x-dsh-device-credential'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header === 'string' && header.trim()) return header.trim();
  const m = /^Bearer\s+([^\s]+)$/.exec(req.headers.authorization || '');
  return m ? m[1] : null;
}

/** 请求是否持有有效凭据。 */
function authorized(req) {
  return authOutcome(req).ok;
}

/**
 * 鉴权结果，**带上「为什么被拒」**（§3.8）。
 *
 * 只回 `true/false` 的话，被吊销的手机看到的永远是「请求失败（HTTP 401）」——用户既不知道
 * 自己是被踢了，也不知道该重新扫码。所以判定分三种：通过、被吊销、已过期。
 *
 * 通过时顺手 `renew`（§3.9 的滑动续期）并交出记录：装配层的 `onAuthorized` 拿它记
 * 「最近连接」，两件事都只在鉴权通过后才有意义。
 *
 * @returns {{ ok: true, record?: object }
 *          | { ok: false, reason: 'revoked' | 'expired' | 'unauthorized' }}
 */
function authOutcome(req) {
  const presented = presentedCredential(req);
  if (presented) {
    const state = loadRelayState();
    if (state && state.instanceId) {
      const known = credentials.lookup(presented, state.instanceId);
      if (known) {
        if (known.revokedAt) return { ok: false, reason: 'revoked' };
        if (known.expiresAt && known.expiresAt <= Date.now()) return { ok: false, reason: 'expired' };
        // 还剩不到一半就顺手续期：所有设备会在同一天集体掉线，而这件事完全可以用一次
        // 现成的调用避免 —— 用户不需要为此做任何事。
        try { credentials.renew(known); } catch { /* 续期失败不影响这一次请求 */ }
        return { ok: true, record: known };
      }
      // 查不到就是「本机没签发过它」：可能是中转签的凭据（那条库在中转那边），也可能是
      // 升级前的 HMAC token。两种都往下走旧令牌校验，不在这里判死。
    }
  }
  const m = /^Bearer\s+([^\s]+)$/.exec(req.headers.authorization || '');
  if (m && verifyMobileToken(m[1])) return { ok: true };
  return { ok: false, reason: 'unauthorized' };
}

module.exports = { loadRelayState, presentedCredential, verifyMobileToken, authorized, authOutcome };

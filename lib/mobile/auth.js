'use strict';

/**
 * dsh-mobile 鉴权：移动 token 校验（HMAC，与中转同构）。
 *
 * token 格式 <instanceId>.<exp>.<hmac(lanSecret)>，算法/常数时间比较收在
 * ../shared/dshtoken.js；本模块保留原公开导出面、内部改调共享实现。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

/** 校验移动 token：格式 <instanceId>.<exp>.<hmac(lanSecret)>，且 instanceId 与当前实例一致。 */
function verifyMobileToken(token) {
  if (!token) return false;
  const state = loadRelayState();
  if (!state || !state.lanSecret || !state.instanceId) return false;
  return sharedToken.verifyLanToken(state.lanSecret, token, state.instanceId);
}

/**
 * 请求出示的设备凭据（`dshc_…`），取不到返回 null。
 *
 * App 把设备凭据放在独立的 `X-Dsh-Device-Credential` 头里，`Authorization` 留给
 * 宿主 token；`Authorization` 分支仅用于兼容早期客户端。
 */
function presentedCredential(req) {
  const raw = req.headers['x-dsh-device-credential'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header === 'string' && header.startsWith('dshc_')) return header;
  const m = /^Bearer\s+([^\s]+)$/.exec(req.headers.authorization || '');
  return m && m[1].startsWith('dshc_') ? m[1] : null;
}

/**
 * 请求是否持有有效凭据。两条路径：
 *  1) `Authorization: Bearer <instanceId>.<exp>.<hmac>` —— 与中转同构的 HMAC token；
 *  2) `X-Dsh-Device-Credential: dshc_…` —— 宿主本机凭据库中按 instanceId 核对。
 *
 * 顺序是这里唯一的要点。出示了**本机签发过**的设备凭据时必须以它为准：一经吊销
 * 或过期立即拒绝，不再回退到无状态 token。HMAC token 有效期一年，若允许回退，
 * 吊销就永远不生效，第 2 条也就形同虚设。
 *
 * 「本机不认识这张凭据」则必须回退：公网配对时凭据由中转签发、存在中转的凭据库
 * 里（`dsh-mobile-server/lib/tunnel-handler.js`），宿主这里查不到；若一律拒绝，
 * 「公网配对后回到局域网直连」会直接 401。
 */
function authorized(req) {
  const presented = presentedCredential(req);
  if (presented) {
    const state = loadRelayState();
    if (!state || !state.instanceId) return false;
    const known = credentials.lookup(presented, state.instanceId);
    if (known) return credentials.isLive(known);
  }
  const m = /^Bearer\s+([^\s]+)$/.exec(req.headers.authorization || '');
  return Boolean(m && verifyMobileToken(m[1]));
}

module.exports = { loadRelayState, presentedCredential, verifyMobileToken, authorized };

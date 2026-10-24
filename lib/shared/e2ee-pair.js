'use strict';

/**
 * 配对请求与回包的加解密（协议 v2 配对）。**宿主侧**。
 *
 * 密钥只有一个来源：二维码里那张一次性票据。
 *
 *   pairKey = HKDF-SHA256(ikm = ticket, salt = instanceId, info = 'dsh-pair-v2', len = 32)
 *
 * 票据由宿主生成、写进二维码、绝不经过中转 —— 所以配对阶段不需要任何公钥操作
 * （HPKE / X25519 在 §8.2 被实测否掉了）。
 *
 * 为什么回包也必须加密：里面有 `token`、`cookie`、`deviceCredential`，全是能直接冒用的
 * 凭据。明文回包等于前面白做 —— 链路上的任何人只要老实转发，就顺手拿到这台设备未来
 * 一年的通行证。
 *
 * 两条入口（宿主的主路由与局域网代理）共用这一份：它们在两个进程里，但字节口径必须一样。
 */

const e2ee = require('../shared/e2ee');

/** 设备主密钥与标识的形状。两者都要进凭据库：验签要用 deviceKey 重算。 */
const DEVICE_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID_RE = /^[0-9a-f]{16}$/;

/**
 * 解一份加密的配对请求。
 *
 * @param {object} input
 * @param {string} input.ticket 宿主当前的配对票据（base64url 43 字符）
 * @param {string} input.instanceId 宿主实例号
 * @param {string} input.sealed 请求体里的 `sealed`（base64）
 * @param {string} [input.claimedInstanceId] 请求体里自报的实例号
 * @returns {{ ok: true, pairKey: Buffer, device: object, deviceKey: string, keyId: string }
 *          | { ok: false }}
 */
function openSealedPairRequest(input) {
  const ticket = typeof input.ticket === 'string' ? input.ticket : '';
  const instanceId = String(input.instanceId || '');
  // 没有票据（旧状态文件、或者刚被换过）就无从解起。
  if (!ticket || !instanceId) return { ok: false };
  // 请求体里的实例号必须与本机一致：一张二维码只能配它自己那台机器。
  const claimed = typeof input.claimedInstanceId === 'string' ? input.claimedInstanceId.trim() : '';
  if (claimed && claimed !== instanceId) return { ok: false };

  let pairKey;
  let plain;
  try {
    pairKey = e2ee.derivePairKey(Buffer.from(ticket, 'base64url'), instanceId);
    plain = e2ee.open(pairKey, Buffer.from(input.sealed, 'base64'), e2ee.pairAad(instanceId));
  } catch {
    return { ok: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(plain).toString('utf8'));
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false };

  const deviceKey = typeof parsed.deviceKey === 'string' ? parsed.deviceKey : '';
  const keyId = typeof parsed.keyId === 'string' ? parsed.keyId : '';
  // 形状不对就是实现错了（这两个值要进凭据库并被拿去验签），当场拒掉，
  // 别把一条坏记录写进去。
  if (!DEVICE_KEY_RE.test(deviceKey)) return { ok: false };
  if (!KEY_ID_RE.test(keyId)) return { ok: false };

  return {
    ok: true,
    pairKey,
    device: parsed.device && typeof parsed.device === 'object' ? parsed.device : {},
    deviceKey,
    keyId,
  };
}

/**
 * 把配对回包封成 `{ ok, proto, sealed }`。
 *
 * @param {Buffer} pairKey
 * @param {string} instanceId
 * @param {object} payload 明文回包（token / cookie / deviceCredential / serverTime …）
 * @returns {{ ok: true, proto: 2, sealed: string }}
 */
function sealPairResponse(pairKey, instanceId, payload) {
  const sealed = e2ee.seal(pairKey, Buffer.from(JSON.stringify(payload), 'utf8'), e2ee.pairAad(instanceId));
  return { ok: true, proto: 2, sealed: Buffer.from(sealed).toString('base64') };
}

module.exports = { openSealedPairRequest, sealPairResponse, DEVICE_KEY_RE, KEY_ID_RE };

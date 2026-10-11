'use strict';

/**
 * 插件侧 LAN/mobile token（HMAC-SHA256 base64url）共享实现。
 *
 * token 格式：<instanceId>.<exp>.<hmac-sha256(secret, "<instanceId>.<exp>") base64url>
 * 其中 exp 为秒级过期时间戳。signLanToken/verifyLanToken 显式收 ttlSec / secret 参数，
 * 由调用方显式传入各自历史缺省值（本函数不隐藏调用点差异）。
 */

const crypto = require('node:crypto');

/** 常数时间字符串比较（长度不等直接 false，恰好相等时用 timingSafeEqual）。 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** HMAC 迭代中安全地把 secret 规整为字符串（与各调用点历史一致，字符串 secret 等价）。 */
function hmacPayload(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * 签发 LAN/mobile token：<instanceId>.<exp>.<sig>。
 * 缺省 ttlSec=30d（与 relay core / browser core 历史缺省一致），但**消费方必须显式传原值**
 * （LAN 主进程 3600、30d 处 30*24*3600），本函数不隐藏调用点的默认值差异。
 * @param {string} secret      lanSecret（~/.dsh/relay.json 密钥）
 * @param {string} instanceId  实例 id（~/.dsh/relay.json）
 * @param {number} ttlSec      有效期（秒），缺省 30*24*3600
 * @param {number} [nowSec]    秒级「当前时间」覆盖（测试/主进程签名用）；缺省 Date.now()/1000
 * @returns {string}
 */
function signLanToken(secret, instanceId, ttlSec = 30 * 24 * 3600, nowSec) {
  const sec = Number(ttlSec);
  const ttl = Number.isFinite(sec) && sec > 0 ? sec : 30 * 24 * 3600;
  const now = Number.isFinite(nowSec) && nowSec >= 0 ? nowSec : Math.floor(Date.now() / 1000);
  const exp = now + ttl;
  const payload = `${instanceId}.${exp}`;
  const sig = hmacPayload(secret, payload);
  return `${payload}.${sig}`;
}

/**
 * 校验 token：实例匹配、未过期、签名一致（常数时间）。
 * @param {string} secret      lanSecret
 * @param {string} token       <instanceId>.<exp>.<sig>
 * @param {string} instanceId  期望实例 id
 * @returns {boolean}
 */
function verifyLanToken(secret, token, instanceId) {
  if (!token) return false;
  const [id, expStr, sig] = String(token).split('.');
  if (id !== instanceId || !expStr || !sig) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expect = hmacPayload(secret, `${id}.${expStr}`);
  return safeEqual(expect, sig);
}

module.exports = { signLanToken, verifyLanToken, safeEqual };

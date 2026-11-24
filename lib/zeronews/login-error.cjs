// ZeroNews 登录失败原因归一：厂商 `status --json` 的 login_error 与 CLI 报错原文，翻成能直接给用户看的话。
'use strict';

/**
 * 官方客户端把登录失败原因放在 status 的 `login_error` 里，取值是固定枚举（见 ZeroNews Skills
 * 的 install-client 规程）：denied / expired / quota_exceeded / failed。
 *
 * 但认证失败还有一类更常见、只出现在 CLI 原文里的情况：`auth client failed: client count limit
 * reached for this plan`——免费套餐只允许绑定 1 台客户端，账号名额已被另一台占着，第二台就认证不上。
 * 官方 FAQ 明确「要在控制台删除不再使用的客户端释放名额，或升级套餐」，而且只在本机退出登录 /
 * reset 并不会删云端记录、不会释放名额。所以这里把文本也一起认出来，给用户可操作的整句。
 */
const HINTS = {
  quota_exceeded:
    '免费套餐只允许绑定 1 台客户端，当前名额已被另一台设备占用，这台认证不上。要在别处测试，请二选一：① 到控制台「关联客户端」删除占用名额的那台（先解绑它的隧道），再认证这台；② 想换机又保留原隧道，先停掉旧机，在这台执行 reset 后用「恢复客户端」的方式（authtoken 带上原 client ID）接管同一客户端。只在本机退出登录或重置不会释放云端名额；也可以升级套餐获得更多客户端配额。',
  denied:
    '登录被拒绝：这台设备未被允许接入（可能设备名额已满或被管理员拒绝）。请到控制台「关联客户端」检查，或升级套餐后再试。',
  expired: '登录确认已过期，请重新发起登录。',
  failed: '登录失败，请重新发起登录再试。',
  invalid: 'AuthToken 无效或已失效，请从「快速开始」页重新复制完整的 token。',
};

/** 从任意报错原文里认出已知类别，返回整句；认不出返回空串（交给调用方保留原文）。 */
function friendlyAuthError(text) {
  const key = String(text == null ? '' : text).trim().toLowerCase();
  if (!key) return '';
  if (/client count limit|count limit reached|limit reached for this plan|quota|名额|配额/.test(key)) return HINTS.quota_exceeded;
  if (/invalid authtoken|invalid token/.test(key)) return HINTS.invalid;
  if (/\bdenied\b/.test(key)) return HINTS.denied;
  if (/\bexpired\b/.test(key)) return HINTS.expired;
  return '';
}

/** 把枚举或原始报错翻成整句；认不出的原样带出来，不吞。 */
function loginErrorHint(code) {
  const raw = String(code == null ? '' : code).trim();
  if (!raw) return '';
  const byEnum = HINTS[raw.toLowerCase()];
  if (byEnum) return byEnum;
  return friendlyAuthError(raw) || `登录失败：${raw}`;
}

module.exports = { loginErrorHint, friendlyAuthError };

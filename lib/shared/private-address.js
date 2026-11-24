// 「这个 IPv4 是不是 RFC1918 私有地址」——纯判断，内核与线路都能引用，改动极少。
'use strict';

/**
 * 内核里的半路由守卫要用它判「请求是不是从局域网转发来的」，所以它必须住在内核能引用、
 * 又不会随线路代码频繁变动的地方（`relay/lan-network.cjs` 会随候选算法一起变，不能当内核依赖）。
 *
 * 判定口径与 `relay/lan-network.cjs` 的候选筛选一致：只认点分四段、无前导零的 IPv4 字面量，
 * 落在 10/8、172.16/12、192.168/16 三类里才算私有。
 *
 * @param {unknown} address
 * @returns {boolean}
 */
function isPrivateLanAddress(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map(part => Number(part));
  for (let i = 0; i < 4; i += 1) {
    const n = nums[i];
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
    // 与 lan-network 同口径：不接受前导零（`010.0.0.1`）这类非常规写法。
    if (String(n) !== parts[i]) return false;
  }
  const a = nums[0];
  const b = nums[1];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

module.exports = { isPrivateLanAddress };

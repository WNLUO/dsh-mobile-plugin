'use strict';

/**
 * 一次性入场券（transfer ticket）的进程内 TTL 表。
 *
 * 设备批量导入/导出时，手机 A 向某台电脑申领一张入场券，塞进二维码交给手机 B；B 拿这张券
 * 走一次正常配对（`/pair` 带 `ticketId`），配对成功券即作废。券的内容与配对票据同一种原语
 * （32 字节 base64url，用来派生 pairKey），但**不进 state、不落盘**——它只活在这台电脑的内存
 * 里、只活很短一段时间（默认 10 分钟）。
 *
 * 为什么一次性 + 短 TTL：券等价于「可以跟这台电脑配一次对」的资格。二维码要在屏幕上长显，
 * 截图 / 偷看都可能发生；配对成功立刻 `consume`，同一张券就配不了第二台手机；短 TTL 让一张
 * 没被用掉的券自己过期。这是拿「可用窗口」换「被截屏后的暴露面」的取舍：窗口之外，即使券
 * 泄露也换不到任何东西。
 *
 * 进程内表：插件重载即清空——券本来就是为了下一次配对临时生成的，没配上的重扫一张新的即可。
 */

const crypto = require('node:crypto');

/** 默认有效期：10 分钟。够用户扫完码、走完配对，又不至于让一张漏出去的券长期可用。 */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** 单次最多发几张：一张码换一台新手机，一次导出最多扩 8 台，再多该分批或先看是不是刷券。 */
const MAX_COUNT = 8;

/** 单张券有效期上限（24 小时）：自动同步收件箱里的券要活到后开 App 的手机来取，封顶一天。 */
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

/** 键的分隔符：instanceId 与 ticketId 都来自内部生成，用不可见字符只为拼出唯一键。 */
const SEP = '\u0000';

/**
 * 建一张券表。默认用真实时钟与 10 分钟 TTL；测试可注入 `now` / `ttlMs` 观察过期。
 *
 * @param {object} [options]
 * @param {number} [options.ttlMs]  券的有效期（毫秒）
 * @param {() => number} [options.now] 当前时刻的取值器（测试用）
 */
function createTransferTickets(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;

  /** 键 → { ticket, expiresAt }。键把实例号也编进去：两张不同宿主的券不会互相顶掉。 */
  const table = new Map();
  const keyOf = (instanceId, ticketId) => `${String(instanceId || '')}${SEP}${ticketId}`;

  /**
   * 发券：返回 [{ ticket, ticketId }]，`count` 默认 1、封顶 `MAX_COUNT`。
   *
   * `opts.ttlMs` 覆盖单张券的有效期（封顶 `MAX_TTL_MS`）；`opts.reusable` 为真时这张券
   * **可被多台手机各用一次、配对成功后不作废**（到期才失效）。两种券用途不同：
   *  · 导出二维码里的是**一次性短券**（默认），防截图；
   *  · 自动同步收件箱里的是**可复用长券**（24h 内多台组内手机各领一次），因为它只经 SGK
   *    密文投递、不暴露给外人，短 TTL 反而会让后开 App 的手机永远配不上、多台手机只有
   *    第一台抢得到。
   */
  function mint(instanceId, count, opts = {}) {
    prune();
    const n = Number.isInteger(count) && count > 0 ? Math.min(count, MAX_COUNT) : 1;
    const wantTtl = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : ttlMs;
    const life = Math.min(wantTtl, MAX_TTL_MS);
    const reusable = opts.reusable === true;
    const issued = [];
    const expiresAt = now() + life;
    for (let i = 0; i < n; i += 1) {
      const ticket = crypto.randomBytes(32).toString('base64url');
      const ticketId = crypto.randomBytes(16).toString('base64url');
      table.set(keyOf(instanceId, ticketId), { ticket, expiresAt, reusable });
      issued.push({ ticket, ticketId });
    }
    return issued;
  }

  /** 取券：不存在或已过期都返回 null（过期的顺手清掉）。 */
  function resolve(instanceId, ticketId) {
    if (typeof ticketId !== 'string' || !ticketId) return null;
    const key = keyOf(instanceId, ticketId);
    const entry = table.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      table.delete(key);
      return null;
    }
    return entry.ticket;
  }

  /** 用掉一张券：一次性券直接删除；可复用券不动它（到期由 prune 清）。 */
  function consume(instanceId, ticketId) {
    if (typeof ticketId !== 'string' || !ticketId) return;
    const key = keyOf(instanceId, ticketId);
    const entry = table.get(key);
    if (entry && entry.reusable) return;
    table.delete(key);
  }

  /** 清掉所有过期券；每次 mint / 可在别处定期调用。 */
  function prune(at = now()) {
    for (const [key, entry] of table) {
      if (entry.expiresAt <= at) table.delete(key);
    }
  }

  return { mint, resolve, consume, prune, size: () => table.size };
}

module.exports = { createTransferTickets, DEFAULT_TTL_MS, MAX_COUNT };

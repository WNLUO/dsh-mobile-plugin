'use strict';

/**
 * 配对入口的限速闸门（讨论记录 §10.4）。
 *
 * 原来那套是「按来源分桶、错五次锁一分钟」，而这条链路上**没有可靠的来源**：经中转进来
 * 的请求，宿主看到的对端永远是本机回环；客户端自带一个来源头又能覆盖它。于是这套机制
 * 两头都错 —— 陌生人连错五次把所有人一起锁死，而换一个来源头就绕过。
 *
 * 换成不看来源的全局令牌桶：
 *  - 正常每分钟 60 次，正经用户永远用不到上限；
 *  - 连续失败超过 10 次降到 10 次/分钟，超过 30 次降到 2 次/分钟；
 *  - 计数按「每 10 分钟减半」自己衰减，一次邻居乱按不会让这台机器长期变慢；
 *  - 满了直接回 429 + `retry-after`，**不排队、不硬锁**。队列本身是新的拒绝服务把柄
 *    （一个人挂着半条请求就能攥死整条队列），所以这里刻意没有队列。
 *
 * 为什么够了：六位码 100 万种，期望要试五十万次；按最低档 2 次/分钟，一天 2880 次，
 * 期望半年。而任何一次成功都立刻换码（§5.1），所以这把「磨」的有效时间窗只对「一直没人
 * 配成功」的机器成立 —— 那台机器本来也没人等着配。多来源并发也买不到更多次数，因为
 * 桶是全局的。
 *
 * 新形状（带 `sealed`）没有可猜的东西，但它仍然要过这道闸：「解一次封」是无限次可做的
 * 动作，需要有上限。
 */

/** 三档速率：每分钟允许的尝试次数。 */
const PAIR_RATE_NORMAL = 60;
const PAIR_RATE_WARN = 10;
const PAIR_RATE_FLOOR = 2;

/** 连续失败到这些次数就降档。 */
const PAIR_FAILS_WARN = 10;
const PAIR_FAILS_FLOOR = 30;

/** 失败计数每这么久减半一次（按最后一次失败的时刻算，不做定时器）。 */
const PAIR_DECAY_MS = 10 * 60 * 1000;

/**
 * 一道闸的全部状态。**两个入口各持一份**，不是共用：
 *
 * 局域网代理跑在旁路子进程里、宿主那条跑在主进程里，跨进程共用一份计数要么加锁要么走 RPC，
 * 而两者的网络含义本来就不同（一条在局域网上、一条经中转）。各自限自己的就够 ——
 * 攻击者要绕过必须同时打两条，而局域网那条他根本进不来。
 */
function createPairThrottle(options = {}) {
  const now = () => (typeof options.now === 'function' ? options.now() : Date.now());
  let tokens = PAIR_RATE_NORMAL;
  let refilledAt = now();
  let fails = 0;
  let lastFailAt = 0;

  /** 当前档位（每分钟多少次）。 */
  function rate() {
    if (fails >= PAIR_FAILS_FLOOR) return PAIR_RATE_FLOOR;
    if (fails >= PAIR_FAILS_WARN) return PAIR_RATE_WARN;
    return PAIR_RATE_NORMAL;
  }

  /** 按经过的时间补令牌。上限定成「一分钟的量」。 */
  function refill(at) {
    const limit = rate();
    const elapsed = at - refilledAt;
    if (elapsed <= 0) return;
    const gained = (elapsed * limit) / 60_000;
    tokens = Math.min(limit, tokens + gained);
    refilledAt = at;
    // 令牌上限跟着档位走：降档后如果还留着 60 个令牌，降档就形同虚设。
    if (tokens > limit) tokens = limit;
  }

  /** 失败计数的衰减：每当过了一个衰减周期就折半，并且把基准往前推。 */
  function decay(at) {
    if (!lastFailAt) return;
    const periods = Math.floor((at - lastFailAt) / PAIR_DECAY_MS);
    if (periods <= 0) return;
    fails = Math.floor(fails / (2 ** Math.min(periods, 30)));
    lastFailAt += periods * PAIR_DECAY_MS;
    if (fails === 0) lastFailAt = 0;
  }

  /**
   * 试取一个令牌。
   *
   * @returns {{ allowed: true } | { allowed: false, retryAfterSec: number }}
   *   `retryAfterSec` 供 429 的 `retry-after` 头用：按当前档位算出「下一个令牌要等多久」。
   */
  function take() {
    const at = now();
    decay(at);
    refill(at);
    if (tokens >= 1) {
      tokens -= 1;
      return { allowed: true };
    }
    const limit = rate();
    const need = 1 - tokens;
    const seconds = Math.max(1, Math.ceil((need * 60_000) / limit / 1000));
    return { allowed: false, retryAfterSec: seconds };
  }

  /** 记一次失败。 */
  function noteFail() {
    const at = now();
    // 上一次失败已经衰减干净了就先衰减，免得跨档位累计。
    decay(at);
    fails += 1;
    lastFailAt = at;
    // 降档立刻生效：不把旧档位攒下的令牌留着用。
    const limit = rate();
    if (tokens > limit) tokens = limit;
  }

  /** 成功：清零并回到最高档。 */
  function noteSuccess() {
    fails = 0;
    lastFailAt = 0;
    const at = now();
    const limit = PAIR_RATE_NORMAL;
    refill(at);
    if (tokens > limit) tokens = limit;
  }

  /** 完全重置成满桶（测试用；`noteSuccess` 只清失败计数，不清已用掉的令牌）。 */
  function reset() {
    refilledAt = now();
    fails = 0;
    lastFailAt = 0;
    tokens = PAIR_RATE_NORMAL;
  }

  /** 测试与自检用：当前状态快照。 */
  function snapshot() {
    const at = now();
    decay(at);
    refill(at);
    return { rate: rate(), tokens, fails };
  }

  return { take, noteFail, noteSuccess, snapshot, reset };
}

module.exports = {
  createPairThrottle,
  PAIR_RATE_NORMAL,
  PAIR_RATE_WARN,
  PAIR_RATE_FLOOR,
  PAIR_FAILS_WARN,
  PAIR_FAILS_FLOOR,
  PAIR_DECAY_MS,
};

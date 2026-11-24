/**
 * 插件自动更新的「先问一声」状态机（shell/update-consent）。
 *
 * 自动更新每两分钟跑一次。以前它查到新版就装、就地换代，不管有没有人正用着；用户在手机上聊着
 * 天，插件可能就在背后被换掉，还可能短暂断连。这里把「有没有手机正连着」接进决策：
 *
 *  - 没手机连着（没人在用）→ 照旧直接装；
 *  - 有手机连着 → 先停住，记一个「待确认」，等用户点「允许」或「过一会儿」；
 *  - 等太久没人理（默认 10 分钟）→ 当他不在跟前，直接装（原地换代不掐断正在跑的对话，兜得住）；
 *  - 等的过程里手机断开了 → 更明确的「人走了」，直接装；
 *  - 用户点「过一会儿」→ 按他给的时间推迟，到点之前不再动；
 *  - 推迟期间又出了更新的版 → 不动，等他设的推迟到点，届时按**当时最新**那一版重来。
 *
 * 这是纯状态机，不碰网络、不碰磁盘：调用方（`lib/index.js` 的自动更新 tick）把「有没有新版、
 * 有没有手机连着、现在几点」喂进来，拿回「这一步该装还是该停」。好落成裸 Node 单测。
 */

const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_SNOOZE_MINUTES = 60;

/**
 * @param {object} [opts]
 * @param {number} [opts.windowMs] 没人理时的等待上限，默认 10 分钟。
 * @param {() => number} [opts.now] 取当前毫秒（测试注入）。
 */
export function createUpdateConsent({ windowMs = DEFAULT_WINDOW_MS, now = () => Date.now() } = {}) {
  /** 正在等确认的那一版：`{ version, since, deadline }`；没有就是 null。 */
  let pending = null;
  /** 用户「过一会儿」推迟到的时刻（毫秒）；0 = 没推迟。 */
  let snoozeUntil = 0;

  function clearPending() { pending = null; }

  /**
   * 这一步该怎么办。
   *
   * @param {{ runningVersion?: string|null, latestVersion?: string|null, updateAvailable?: boolean, appActive?: boolean }} input
   * @returns {{ action: 'idle'|'hold'|'update', status: object }}
   *   `idle` = 没有可装的；`hold` = 先停着；`update` = 现在装。
   */
  function evaluate(input = {}) {
    const { latestVersion = null, updateAvailable = false, appActive = false } = input;
    const t = now();

    // 没有新版、或版本号读不出来：清掉待确认，什么都不做。
    if (!updateAvailable || !latestVersion) {
      clearPending();
      return { action: 'idle', status: status() };
    }

    // 用户明确「过一会儿」：到点之前一律不动（推迟期间出新版也照旧不动）。
    if (snoozeUntil > t) {
      clearPending();
      return { action: 'hold', status: status() };
    }
    if (snoozeUntil) snoozeUntil = 0; // 推迟到点了，作废

    // 没人在用：照旧直接装。
    if (!appActive) {
      clearPending();
      return { action: 'update', status: status() };
    }

    // 有人连着：进入等待。换了目标版本就重排一次窗口（绝不先更旧的再更新的）。
    if (!pending || pending.version !== latestVersion) {
      pending = { version: latestVersion, since: t, deadline: t + windowMs };
    }
    // 等过上限还没人理：当他不在，直接装。
    if (t >= pending.deadline) {
      return { action: 'update', status: status() };
    }
    return { action: 'hold', status: status() };
  }

  /**
   * 用户点了「过一会儿」：推迟 `minutes` 分钟（不合法就按默认 60 分钟）。
   * @returns {object} 最新状态
   */
  function snooze(minutes) {
    const value = Number(minutes);
    const mins = Number.isFinite(value) && value > 0 ? value : DEFAULT_SNOOZE_MINUTES;
    snoozeUntil = now() + mins * 60 * 1000;
    clearPending();
    return status();
  }

  /** 清空（手动更新开始、或开关关掉时用）。 */
  function clear() {
    clearPending();
    snoozeUntil = 0;
  }

  /** 给手机看的状态快照。 */
  function status() {
    const t = now();
    return {
      /** 正在等确认的版本；没有就是 null。 */
      pendingVersion: pending ? pending.version : null,
      /** 从什么时候开始等的（ISO）。 */
      pendingSince: pending ? new Date(pending.since).toISOString() : null,
      /** 等到这个时刻还没人理就兜底装（ISO）。 */
      deadlineAt: pending ? new Date(pending.deadline).toISOString() : null,
      /** 用户「过一会儿」推迟到什么时候（ISO）；没推迟就是 null。 */
      snoozedUntil: snoozeUntil > t ? new Date(snoozeUntil).toISOString() : null,
    };
  }

  return { evaluate, snooze, clear, status, windowMs };
}

export { DEFAULT_WINDOW_MS, DEFAULT_SNOOZE_MINUTES };

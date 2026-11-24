/**
 * 自动更新的「先问一声」编排（shell/auto-updater）。
 *
 * 从稳定外壳 `lib/index.js` 里搬出来：外壳要保持薄（只装载、不长业务），而这一块是货真价实的
 * 业务编排 —— 从业务上回答「这一步该不该装」。
 *
 * 职责只有一件：自动更新每拍做一次「查新版 → 问状态机（有人连着就先停、10 分钟兜底）→ 该装
 * 才装」。定时器不在这里，仍在 index.js（它得进 ctx.effect、unref、能随卸载清掉）；这里只给
 * 一拍 `tick()`，index.js 到点调它。
 *
 * 判断「有没有人在用」由外部喂 `activeMuxConnections()`（外壳持着 mux 服务，知道现在有几条
 * 手机长连接）。号数拿不到一律当 0：那台机器也没人在用，照旧直接更。
 */
export function createAutoUpdater({ consent, check, applyUpdate, log = () => {}, runningVersion = () => null, activeMuxConnections = () => 0 }) {
  const appActive = () => {
    try {
      return Number(activeMuxConnections()) > 0;
    } catch {
      return false;
    }
  };

  /**
   * 自动更新的一拍：查到有没有新版，再按「有没有手机连着 / 有没有推迟」决定装还是先停。
   *
   * 有人连着就停住等确认（最多 10 分钟，见 `shell/update-consent.js`）；没人用照旧直接装。
   * 手动更新（手机上点「更新」）不走这条，直接 `applyUpdate`。
   */
  async function tick() {
    const result = await check();
    const decision = consent.evaluate({
      runningVersion: (() => { try { return runningVersion(); } catch { return null; } })(),
      latestVersion: result?.latestVersion ?? null,
      updateAvailable: result?.updateAvailable === true,
      appActive: appActive(),
    });
    if (decision.action !== 'update') {
      if (decision.action === 'hold') {
        log('info', 'dsh-mobile-plugin: 有手机正连着，插件更新先等用户确认（%s）', decision.status.pendingVersion ?? '');
      }
      return null;
    }
    return applyUpdate({ auto: true });
  }

  return { tick, appActive };
}

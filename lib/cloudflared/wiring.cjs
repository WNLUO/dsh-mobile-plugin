// 2026-11-25：自动兜底只在「需要绕开且没有可用公网线路」时启用；先备份再收起手填直连地址，停掉后原样还原。
// Cloudflare 兜底隧道接线：runner 创建、地址回报（写独立字段 cloudflareUrl）、过期地址撤回、自动启动与启停包装。
'use strict';

/**
 * 把 Cloudflare 兜底隧道挂进装配层：本地拉起 cloudflared 快速隧道，把拿到的 https 地址
 * 写进**独立字段** `cloudflareUrl`（它是一条独立线路，上报时走自己的 `kind:'cf'`）。
 *
 * 单独一个文件是因为装配层有行数上限（`test/assembly-layer.test.cjs` 钉着）——那些上限是
 * 「实现不许搬回装配层」。进程生命周期、banner 解析在 `runner.cjs`，二进制获取在
 * `provision.cjs`，这里只做挂载与那几处装配动作。
 *
 * 自动兜底（注入 `signals` / `hasUsableRoute` 时）只在回环判据说要绕开、而此刻没有别的公网
 * 线路时起作用；已有线路不重复起第二条。绕开期间用户手填的直连地址先原样备份再收起 ——
 * 它们指向的正是被遮蔽的入口，不收起会让手机继续拨过去；兜底一停就按备份还原，不静默吞掉。
 * 地址仍只写 `cloudflareUrl`，不并进用户的手填格。停用只停 runner，不回写其它线路。
 *
 * 那条地址是「此刻真连得上」的声明，不是「这条隧道以前有过地址」：只有 cloudflared 真连上
 * Cloudflare 边缘才写进去；停用、卸载、连不上放弃时立刻撤掉。留着一条死地址，总控会一直把它
 * 发给手机，手机拨过去就是 1033。
 */

const { createCloudflaredRunner } = require('./runner.cjs');

/** 兜底期间要收起的手填直连地址；顺序就是还原顺序。 */
const MANUAL_FIELDS = ['manualLanUrl', 'manualIpv6Url', 'manualIpv4Url', 'manualTcpUrl'];

/**
 * @param {object} options
 * @param {(label: string, fn: Function) => any} options.mount 装配层的兜底挂载
 * @param {(message: string, ...rest: any[]) => void} options.warn 告警出口
 * @param {object} options.state relay.json 那份内存状态（唯一真值）
 * @param {{ update: (patch: object) => Promise<any>, watch?: (fn: Function) => Function }} options.settings 配置仓
 * @param {() => number} options.portOf 本机落点端口（判据给出：绕开时是专属入口）
 * @param {() => object} [options.signals] 回环入口判据（ingress-guard.signalsOf 的结果）
 * @param {() => boolean} [options.hasUsableRoute] 此刻还有没有别的可用公网线路
 * @param {object} options.ctx 插件 ctx（只为 `ctx.effect` 与 `ctx.get`）
 * @param {string} options.name 插件名，用于 effect 标签
 * @returns {{ start: Function, stop: Function, status: Function, syncLocalPort: Function, reconcile: Function }}
 */
function mountCloudflare(options) {
  const { mount, warn, state, settings, portOf, ctx, name } = options;
  const signals = typeof options.signals === 'function' ? options.signals : null;
  const hasUsableRoute = typeof options.hasUsableRoute === 'function' ? options.hasUsableRoute : null;
  const hasGate = Boolean(signals && hasUsableRoute);
  // 外壳持有 runner 时沿用（换代不重启隧道）；缺省走本地。
  let host = null;
  try { host = typeof ctx.get === 'function' ? ctx.get('dshMobileTransportCloudflare') || null : null } catch { host = null; }
  // 运行器创建本身万一抛错，也不能让插件加载失败：给一个「不可用但可查询原因」的降级壳。
  let runner;
  try {
    runner = host && host.runner ? host.runner : createCloudflaredRunner({ portOf, ipVersionPolicy: () => state.ipVersionPolicy });
  } catch (error) {
    warn('Cloudflare 隧道运行器创建失败：%s', error && error.message ? error.message : error);
    const degraded = () => ({ available: false, running: false, pid: null, url: '', error: `Cloudflare 隧道初始化失败：${error && error.message ? error.message : error}`, startedAt: 0, starting: false, retrying: false, waitingForPort: false, enabled: false });
    return { start: async () => degraded(), stop: async () => degraded(), status: degraded, syncLocalPort: async () => degraded(), reconcile: async () => degraded() };
  }

  const readSignals = () => { try { return signals() || {} } catch { return {} } };
  const routeAvailable = () => { try { return hasUsableRoute() === true } catch { return false } };
  const shouldFallback = () => hasGate && readSignals().needsBypass === true && !routeAvailable();

  const emptyBackup = () => ({ manualLanUrl: '', manualIpv6Url: '', manualIpv4Url: '', manualTcpUrl: '' });
  const savedManual = () => {
    const raw = state.cloudflareFallbackBackup && typeof state.cloudflareFallbackBackup === 'object' ? state.cloudflareFallbackBackup : {};
    const out = emptyBackup();
    for (const key of MANUAL_FIELDS) out[key] = typeof raw[key] === 'string' ? raw[key] : '';
    return out;
  };
  const hasSavedManual = () => MANUAL_FIELDS.some(key => savedManual()[key]);

  /** 先存后收：`notify:false` 只落盘并改内存状态，不惊动正在跑的隧道与 sidecar。 */
  const rememberManual = async () => {
    if (hasSavedManual()) return;
    const saved = {};
    for (const key of MANUAL_FIELDS) saved[key] = typeof state[key] === 'string' ? state[key] : '';
    if (!MANUAL_FIELDS.some(key => saved[key])) return;
    try {
      await settings.update({ cloudflareFallbackBackup: saved }, { notify: false });
      const patch = emptyBackup();
      await settings.update(patch, { notify: false });
    } catch (error) {
      warn('备份手填直连地址失败：%s', error && error.message ? error.message : error);
    }
  };
  /** 兜底停掉就按备份原样还原；还原用默认 notify，让总控与手机立即拿到原来的线路。 */
  const restoreManual = async () => {
    if (!hasSavedManual()) return;
    const patch = { ...savedManual(), cloudflareFallbackBackup: emptyBackup() };
    try { await settings.update(patch); }
    catch (error) { warn('还原手填直连地址失败：%s', error && error.message ? error.message : error); }
  };

  // 控制面开关：start 幂等（runner 自己写 enabled 标记）；stop 幂等（runner 删标记、停进程）。
  // 任何一步出错都不许把异常抛回调用方（会变成面板 500 / 甚至未捕获拒绝），只记日志并把状态交回去。
  const start = async () => {
    try { await runner.start(); }
    catch (error) { warn('启动 Cloudflare 隧道失败：%s', error && error.message ? error.message : error); }
    return runner.status();
  };
  /** 撤掉状态里那条已经连不上的地址；没写过就什么都不做。 */
  const clearAddress = async () => {
    if (typeof state.cloudflareUrl !== 'string' || !state.cloudflareUrl) return;
    try { await settings.update({ cloudflareUrl: '' }); }
    catch (error) { warn('撤掉 Cloudflare 地址失败：%s', error && error.message ? error.message : error); }
  };
  const stop = async () => {
    try { await runner.stop(); }
    catch (error) { warn('停止 Cloudflare 隧道失败：%s', error && error.message ? error.message : error); }
    // runner 停进程时会走「地址撤回」，这里再兜一次：面板回包里也不能留旧地址。
    await clearAddress();
    await restoreManual();
    return runner.status();
  };
  const status = () => runner.status();
  const syncLocalPort = () => (typeof runner.syncLocalPort === 'function' ? runner.syncLocalPort() : Promise.resolve(runner.status()));

  /**
   * 重新判一次兜底。注入了判据时才管；没有注入的老调用方行为一字不变（runner 自己决定默认开）。
   * 起兜底前先备份手填地址，停止时一并还原；有别的线路时不重复起。
   */
  let fallbackOn = false;
  const reconcile = async (initial = false) => {
    if (!hasGate) return runner.status();
    if (shouldFallback()) {
      if (!fallbackOn) { await rememberManual(); fallbackOn = true; }
      const now = status();
      if (!now.running && !now.starting) await start();
    } else if (fallbackOn) {
      fallbackOn = false;
      await stop();
    } else if (initial && !routeAvailable() && runner.shouldAutoStart()) {
      const now = status();
      if (!now.running && !now.starting) await start();
    } else if (!initial) {
      await restoreManual();
    }
    return runner.status();
  };

  // 地址回报：隧道拿到新 https 地址时写进独立字段 `cloudflareUrl`（不再写 `manualLanUrl`）。
  // settings.update 会经 settings.watch → applyServices → control.sync() 自动把新地址报给总控，
  // 总控那头从 `kind:'cf'` 这条线路上读，和用户手填的直连互不覆盖。
  mount('cloudflare 地址', () => ctx.effect(() => {
    if (typeof runner.setAddressGoneListener === 'function') runner.setAddressGoneListener(clearAddress);
    if (typeof runner.setAddressListener !== 'function') return () => {};
    runner.setAddressListener(async (address, isCurrent) => {
      if (!isCurrent() || state.cloudflareUrl === address) return;
      try { await settings.update({ cloudflareUrl: address }); }
      catch (error) { warn('把 Cloudflare 地址写回状态失败：%s', error && error.message ? error.message : error); }
    });
    return () => runner.setAddressListener(null);
  }, `${name}: cloudflare address`));
  // 上次运行留下的地址（relay.json 里那条）来自上一条隧道，这次进程还没连上之前它一定是死链：
  // 先撤掉，等这轮真连上边缘再由地址监听写回来。重启 DSH / 插件热重载都走这里。
  if (typeof state.cloudflareUrl === 'string' && state.cloudflareUrl && !status().running) void clearAddress();
  // 自动启动：注入了判据时按兜底条件起，没注入时沿用「用户没显式关掉就拉起」。
  // 卸载时杀进程并还原手填地址，但不写关闭标记，供下次恢复。
  if (!(host && host.runner)) {
    mount('cloudflare 隧道进程', () => ctx.effect(() => {
      if (hasGate) void reconcile(true).catch(error => warn('自动判定 Cloudflare 兜底失败：%s', error && error.message ? error.message : error));
      else if (runner.shouldAutoStart()) Promise.resolve(runner.start()).catch((error) => warn('自动启动 Cloudflare 隧道失败：%s', error && error.message ? error.message : error));
      return () => { void runner.dispose(); void restoreManual(); };
    }, `${name}: cloudflare runner`));
  }
  // 线路状态变了重新判一次：别的线路接上就停兜底并还原；它断了而回环又被遮蔽就补起。
  if (hasGate && typeof settings.watch === 'function') {
    mount('cloudflare 兜底判定', () => ctx.effect(() => settings.watch(() => {
      void reconcile().catch(error => warn('重新判定 Cloudflare 兜底失败：%s', error && error.message ? error.message : error));
    }), `${name}: cloudflare fallback`));
  }

  return { start, stop, status, syncLocalPort, reconcile };
}

module.exports = { mountCloudflare };

/** 2026-11-28：可选线路的通用登记表——以后新增线路在代里声明即可，不用再改外壳。 */
/**
 * 可选线路（按实现指纹「沿用 / 重建」）的通用登记表。
 *
 * 为什么需要它：可选线路是长活进程，必须由外壳跨代持有（否则每次换代都要重连、用户能感觉到断）。
 * 以前 frp / 隧道助手 / 点对点是在 transport-host 里逐条手写的，于是**每加一条线路都要改外壳、
 * 也就意味着要重启 DSH**——这是文档里记的最容易复发的一条。
 *
 * 这个登记表把「一条可选线路」抽象成一份声明：名字 + 指纹 + 取值器（providers）+ 建法（mount）。
 * 外壳只认这份声明、管它的生命周期与换代沿用；线路自己的实现住在代里（可热更）。以后加线路
 * 只需要代里调一次 `adopt(...)`，外壳一行都不用动。
 *
 * 契约（`mount(bag)` 返回一个至少有 `stop` 的对象，可选 `start` / `status`）：
 * - `fingerprint` 不变：沿用同一个实例（不重连），只把 `providers` 刷新成新代给的取值器
 *   （避免闭包着上一代那个已经失效的 ctx）。
 * - `fingerprint` 变了：先停掉旧实例、按新声明重建（短暂重连，DSH 不重启）。
 * - `bag.mount`：逐块兜住的挂载器；`bag.warn`：告警出口；`bag.provider(name)`：取当前代注入的
 *   取值器；`bag.effect(fn,label)`：登记随这条线路生命周期回收的 effect（重建或卸载时一起撤）。
 *
 * @param {{ctx: object, warn?: Function}} deps 外壳 ctx（用 `ctx.effect` 管生命周期）与告警出口。
 */
export function createOptionalLineRegistry({ ctx, warn = () => {} } = {}) {
  if (!ctx || typeof ctx.effect !== 'function') throw new Error('可选线路登记表需要外壳 ctx')

  /** name -> { fingerprint, door, providers, disposers } */
  const lines = new Map()

  function disposeLine(entry) {
    if (!entry) return
    const { door, disposers } = entry
    entry.door = null
    entry.disposers = []
    for (const dispose of disposers) { try { dispose() } catch { /* 已经撤过 */ } }
    try { if (door && typeof door.stop === 'function') void door.stop() } catch { /* 已经停了 */ }
  }

  /**
   * 登记/接管一条可选线路。返回这条线路当前的实例（door）。
   * 只传 `providers`（不传 `mount`）时：刷新取值器并返回现有实例。
   */
  function adopt({ name, fingerprint = null, providers = null, mount = null } = {}) {
    if (typeof name !== 'string' || !name) return null
    let entry = lines.get(name) || null
    if (providers && typeof providers === 'object') {
      entry = entry || { fingerprint: null, door: null, providers: {}, disposers: [] }
      entry.providers = { ...entry.providers, ...providers }
      lines.set(name, entry)
    }
    if (typeof mount !== 'function') return entry ? entry.door : null
    // 指纹没变且实例还在：沿用（不断线），providers 上面已经刷新过。
    if (entry && entry.door && fingerprint === entry.fingerprint) return entry.door
    if (entry) disposeLine(entry)
    entry = entry || { providers: {} }
    entry.fingerprint = fingerprint
    entry.disposers = []
    const pick = key => (typeof entry.providers[key] === 'function' ? entry.providers[key] : null)
    const bag = {
      mount: fn => { try { return fn() } catch (error) { warn(`${name} 没挂上：${error && error.message ? error.message : error}`); return undefined } },
      warn,
      provider: pick,
      effect: (fn, label) => {
        const dispose = ctx.effect(fn, label)
        entry.disposers.push(dispose)
        return dispose
      },
    }
    try { entry.door = mount(bag) } catch (error) { entry.door = null; warn(`${name} 建实例失败：${error && error.message ? error.message : error}`) }
    lines.set(name, entry)
    return entry.door
  }

  /** 取下某条线路当前实例（不建）。 */
  function get(name) {
    const entry = lines.get(name)
    return entry ? entry.door : null
  }

  /** 某条线路的统一控制面：停 / 起 / 查状态都转发到它当前的实例。 */
  function control(name) {
    const door = () => get(name)
    return {
      stop: () => { const d = door(); return d && typeof d.stop === 'function' ? d.stop() : Promise.resolve() },
      start: () => { const d = door(); return d && typeof d.start === 'function' ? d.start() : undefined },
      status: () => { const d = door(); return d && typeof d.status === 'function' ? d.status() : null },
    }
  }

  // 外壳卸载时把全部可选线路一起撤掉（每条各自的 effect 也一并收回）。
  ctx.effect(() => () => {
    for (const entry of lines.values()) disposeLine(entry)
    lines.clear()
  }, 'dsh-mobile-plugin: optional line registry')

  return { adopt, get, control }
}

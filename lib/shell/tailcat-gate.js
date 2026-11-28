/** 2026-11-28：更新前让隧道助手松开 Windows 平台包；停不掉就拦下这一轮，不硬装再回滚。 */
/**
 * 更新前对隧道助手（tailcat）的处理。
 *
 * 为什么要有这道闸：Windows 上隧道助手的平台包（exe）正在跑时，pnpm 换不掉那个目录，装完
 * 会被判「安装不完整」再回滚；回滚把盘上版本退回旧版、registry 还是那一版，于是下一次检查
 * 又说有新版，形成「每两分钟失败重装再回滚」的死循环，全程还握着 profile 写锁。
 *
 * 所以这里做成「停得掉就继续、停不掉就把失败如实返回」，由调用方（热更的实现侧）决定是否
 * 放弃这一轮、按重试退避。其它平台没有这个文件锁，停掉助手只会白白断一条直连、整段装包时间
 * 都不在 —— 直接放行、不碰它。
 *
 * 只依赖注入进来的「取控制服务」与日志出口，不读外壳的 ctx，也便于单测。
 *
 * @param {{getControl?: () => any, log?: (level: string, message: string, ...rest: any[]) => void,
 *   platform?: string}} [options]
 */
export function createTailcatGate({ getControl = () => null, log = () => {}, platform = process.platform } = {}) {
  let paused = false

  return {
    /**
     * 停隧道助手。不是 Windows、没有控制服务、或已经停过都当作「不用停」，返回 `{ ok: true }`；
     * 真去停并且失败时返回 `{ ok: false, error }`，由调用方据此拦下这一轮。
     */
    async stop() {
      if (platform !== 'win32') return { ok: true, stopped: false }
      if (paused) return { ok: true, stopped: false }
      const ctl = getControl()
      if (!ctl || typeof ctl.stop !== 'function') return { ok: true, stopped: false }
      try {
        await ctl.stop()
        paused = true
        return { ok: true, stopped: true }
      } catch (error) {
        log('warn', 'dsh-mobile-plugin: 更新前停隧道助手失败：%s', error?.message || error)
        return { ok: false, error }
      }
    },

    /** 装完/失败后把之前停掉的助手拉回来；没停过就什么都不做。 */
    async resume() {
      if (!paused) return
      paused = false
      const ctl = getControl()
      if (!ctl || typeof ctl.start !== 'function') return
      try {
        const state = typeof ctl.status === 'function' ? ctl.status() : null
        if (!state || state.running !== true) ctl.start()
      } catch (error) {
        log('warn', 'dsh-mobile-plugin: 更新后恢复隧道助手失败：%s', error?.message || error)
      }
    },
  }
}

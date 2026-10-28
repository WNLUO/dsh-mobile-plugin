/**
 * 宿主半边自检的响应体：把 `runtime.status()` 收成设置页能读的那几格。
 *
 * 为什么单独一个纯函数：拼响应体的地方在外壳里，而外壳不好在测试里跑起来（它一 apply
 * 就真的去装载实现）。这里只做取值与白名单，测试直接喂一份 status 就能钉住形状。
 *
 * **`lastError` 是这一条接口存在的理由**：实现装载失败时外壳仍然活着，于是路由 404、
 * 设置页只显示一句「插件宿主侧没有加载」，而真正的原因（等哪个服务超时、哪一代装不上）
 * 只打在宿主 stderr 里，桌面端不落盘、用户看不见、我们也就查不出来。这条接口把它原样
 * 交给设置页。
 */

/**
 * @param {object} status `runtime.status()` 的快照。
 * @param {{installedVersion?: string|null, shellChanged?: boolean}} [extra]
 *   盘上那一份的坐标（市场装完立刻变，和跑着的对照就看得出要不要重启）。
 */
export function hostHalfView(status, extra = {}) {
  const s = status && typeof status === 'object' ? status : {};
  const info = extra && typeof extra === 'object' ? extra : {};
  return {
    ok: true,
    half: {
      version: typeof s.version === 'string' ? s.version : null,
      source: typeof s.source === 'string' ? s.source : null,
      previousVersion: typeof s.previousVersion === 'string' ? s.previousVersion : null,
      activatedAt: typeof s.activatedAt === 'string' ? s.activatedAt : null,
      lastError: typeof s.lastError === 'string' ? s.lastError : null,
      /** 启动时那几次没成、现在仍在后台按长间隔重试 —— 面板据此劝人「再等等」而不是重装。 */
      retrying: s.retrying === true,
      retryAttempts: Number.isFinite(s.retryAttempts) ? s.retryAttempts : 0,
      nextRetryAt: typeof s.nextRetryAt === 'string' ? s.nextRetryAt : null,
      installedVersion: typeof info.installedVersion === 'string' ? info.installedVersion : null,
      shellChanged: info.shellChanged === true,
    },
  };
}

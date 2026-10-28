/**
 * 宿主半边的自检口：`/api/relay/host-half` 与它的 `/reload`。
 *
 * 这两条**必须由外壳注册**，不能放进实现：实现装载失败时整张 `/api/relay/*` 都不在，
 * 而「它为什么没起来」只有外壳答得出来（外壳自己活得好好的是刻意的故障边界）。
 * 现场的样子是设置页一句「插件宿主侧没有加载」，原因只打在宿主 stderr 里、桌面端不落盘，
 * 用户看不见、我们也查不出来 —— 这两条就是那个原因唯一的出口。
 *
 * 放在 `lib/shell/` 而不是 `lib/index.js` 里，是因为外壳的守卫钉着「只该有装载逻辑」。
 * 这里只干两件小事：把 state 拍成响应体（`half-view.js`），以及把「重新装载」转给
 * runtime 那套换代秩序（串行、先停后起、失败回滚）。
 *
 * 两条都走 `localOnly`：拒绝中转/局域网转发来的请求、拒绝跨站、钉住 method。它们能读到的
 * 是这台机器的插件装载状态，不值得让别处看见。
 */

import { createRequire } from 'node:module'
import { hostHalfView } from './half-view.js'

const require = createRequire(import.meta.url)
const { localOnly } = require('../http/routing.js')
const { sendJson } = require('../shared/http-util.js')

export const HOST_HALF_PATH = '/api/relay/host-half'
export const HOST_HALF_RELOAD_PATH = '/api/relay/host-half/reload'

/**
 * 挂上两条路由，返回清理函数（给 `ctx.effect` 当返回值用）。
 *
 * @param {object} ctx 外壳那份 context（只用它的 `webServer`）。
 * @param {{status: () => object, reload: () => Promise<unknown>}} runtime 代际运行时。
 * @param {{installedVersion?: () => string|null, installedShellHash?: () => string|null,
 *   runningShellHash?: string|null}} [deps] 盘上那一份的坐标，只为「要不要重启」这一格。
 */
export function installHostHalf(ctx, runtime, deps = {}) {
  const server = ctx?.webServer
  if (typeof server?.register !== 'function') return () => {}
  const installedVersion = typeof deps.installedVersion === 'function' ? deps.installedVersion : () => null
  const installedShellHash = typeof deps.installedShellHash === 'function' ? deps.installedShellHash : () => null
  const runningShellHash = typeof deps.runningShellHash === 'string' ? deps.runningShellHash : null
  const view = () => hostHalfView(runtime.status(), {
    installedVersion: installedVersion(),
    shellChanged: installedShellHash() !== null && installedShellHash() !== runningShellHash,
  })
  const offs = [
    server.register({
      kind: 'exact',
      path: HOST_HALF_PATH,
      handler: localOnly('GET', async (_req, res) => sendJson(res, 200, view())),
    }),
    server.register({
      kind: 'exact',
      path: HOST_HALF_RELOAD_PATH,
      handler: localOnly('POST', async (_req, res) => {
        try {
          await runtime.reload()
          return sendJson(res, 200, view())
        } catch (error) {
          // 装载失败时外壳已经按老规矩回滚过了，这里只把原因与回滚后的状态一起交出去：
          // 面板要能原样显示「还是不行，因为……」。
          return sendJson(res, 200, {
            ...view(),
            ok: false,
            error: { code: 'reload-failed', message: String((error && error.message) || error) },
          })
        }
      }),
    }),
  ].filter(off => typeof off === 'function')
  return () => {
    for (const off of offs) off()
  }
}

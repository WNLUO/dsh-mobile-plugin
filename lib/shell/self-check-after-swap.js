/**
 * 换代之后的自检：新版装起来之后，**手机要打的那批接口**真的能用吗？不能就退回上一代。
 *
 * ## 为什么这一条不能交给手机
 *
 * 装坏的后果是「App 连不上这台设备」。那一刻手机上没有任何按钮发得出去 —— 让 App 去按
 * 「回滚」等于让一个已经断线的客户端去救自己的连接。所以这件事必须由**还活着的宿主进程**
 * 自己做完，手机那边只在事后读到一条「上次装失败了，已自动退回 X」。
 *
 * ## 判据：问它自己的 `/health`，看回的是什么
 *
 * 不看日志、不猜堆栈，直接打本机的 `127.0.0.1:<宿主端口>`：
 *
 *  · 回 200 + `service: 'dsh-mobile-plugin'` → 活，路由挂上了；
 *  · 回 401 → 也活：移动端守卫先核 token 再谈路由，没带 token 回 401 说明实现与守卫都在；
 *  · 回 404 / 别的 service → **死了**：端口在、但插件那批路由没挂上，手机打过去就是这个 404；
 *  · 超时 → **死了**：连上了但不回包，多半是某个 handler 卡在等一个永远不来的依赖；
 *  · 连不上（ECONNREFUSED）→ **不算数**：那是宿主 webServer 自己没起来，与新代无关，
 *    退回去也救不了。如实报 `skip`。
 *
 * 最后那一条是这次刻意分开的：把「宿主没在监听」当成「新版坏了」会退掉一次其实成功的
 * 更新（开发机上跑测试时就是这么一种现场：假 webServer 有个端口号，但没有任何东西在听）。
 *
 * ## 端口从哪儿来
 *
 * 用宿主的 `ctx.webServer.port`（运行中那一份），不是配置里的默认值 —— 端口被改过之后，
 * 配置与实绑可能不同，按配置去问会问到一个没人监听的地方，于是「自检失败」全是假的。
 */

/** 自检的超时上限：本机环回，正常几十毫秒。给 3 秒已经很宽。 */
export const SELF_CHECK_TIMEOUT_MS = 3000

/** 请求的那条路径：与 App 首屏打的是同一条（见 lib/routes/mobile-api.js）。 */
export const SELF_CHECK_PATH = '/api/mobile/v1/health'

/** 服务标识：宿主自己的 /health 回的就是这个（中转回 'dsh-mobile-relay'）。 */
export const SELF_CHECK_SERVICE = 'dsh-mobile-plugin'

/** 连接层失败（宿主 webServer 没起来）的错误码。 */
const CONNECTION_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL'])

/** 从 fetch 抛出来的东西里挖出底层 syscall 错误码（undici 把它塞在 cause 里）。 */
function connectionCodeOf(error) {
  let cursor = error
  for (let depth = 0; depth < 4 && cursor; depth += 1) {
    if (typeof cursor.code === 'string' && CONNECTION_ERRORS.has(cursor.code)) return cursor.code
    cursor = cursor.cause
  }
  return null
}

/**
 * 问一次：这一代实现活着吗？
 *
 * @param {object} options
 * @param {number} options.port 宿主 webServer 实绑端口
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl] 注入只为测试
 * @returns {Promise<{ok: true} | {skip: true, reason: string} | {ok: false, reason: string}>}
 */
export async function checkGenerationAlive({ port, timeoutMs = SELF_CHECK_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const value = Number(port)
  if (!Number.isFinite(value) || value <= 0) {
    return { skip: true, reason: '拿不到宿主端口，跳过自检' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`http://127.0.0.1:${value}${SELF_CHECK_PATH}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (response.status === 401) return { ok: true }
    if (response.status === 404) {
      return { ok: false, reason: `自检接口 404：新版没有把 ${SELF_CHECK_PATH} 挂上` }
    }
    if (!response.ok) return { ok: false, reason: `自检接口回了 HTTP ${response.status}` }
    const body = await response.json().catch(() => null)
    if (!body || body.service !== SELF_CHECK_SERVICE) {
      return { ok: false, reason: `自检接口回的不是本插件（${body && body.service ? String(body.service) : '没有 service 字段'}）` }
    }
    return { ok: true }
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { ok: false, reason: `自检超时（${timeoutMs}ms）：插件起来了但接口没应答` }
    }
    const code = connectionCodeOf(error)
    if (code) return { skip: true, reason: `宿主 webServer 没在 ${value} 端口上监听（${code}），与新版无关，跳过自检` }
    return { ok: false, reason: `自检请求失败：${String(error?.message || error)}` }
  } finally {
    clearTimeout(timer)
  }
}

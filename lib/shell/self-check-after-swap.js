/**
 * 换代之后的自检：新版装起来之后，手机要打的那批接口真的能用吗？不能就退回上一代。
 *
 * 这条不能交给手机：装坏的后果是 App 连不上这台设备，那一刻手机上的回滚按钮发不出去。
 * 必须由还活着的宿主做完，手机只在事后读到「上次装失败了，已自动退回 X」。
 *
 * 判据是打本机的 `127.0.0.1:<宿主端口>`：200 且 `service: 'dsh-mobile-plugin'` 算活；401 也
 * 算活（守卫先核 token，说明实现与守卫都在）；404 / 别的 service / 超时算死。连不上
 * （ECONNREFUSED）不算数——那是宿主 webServer 自己没起来，与新代无关，退回去也救不了，
 * 如实报 `skip`。
 *
 * 端口用 `ctx.webServer.port`（运行中那份），不是配置里的默认值：端口被改过之后按配置去问
 * 会问到一个没人监听的地方。
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

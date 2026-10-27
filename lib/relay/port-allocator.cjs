'use strict'

/**
 * 局域网代理端口的自适应分配。
 *
 * 背景：默认端口 18787 是个「谁都能想到」的数字，于是同一台机器上只要还有别的
 * 服务先占了它，局域网代理的 `listen` 就会 EADDRINUSE，整条 LAN 直连链路直接死掉
 * ——而 `/api/relay/status` 只会说 `lan.state='error'`，用户看到的现象是「手机配不上对」，
 * 和真正的原因（端口被占）隔了十万八千里。
 *
 * 这里把「挑端口」从配置里解耦出来：先探测首选端口，空闲就用它；被占就让内核
 * 分配一个空闲端口，并把实际端口回传（由调用方写进状态、状态接口和配对二维码，
 * 否则二维码里带的会是那个根本没在监听的死端口）。
 */

const net = require('node:net')

/** 试绑一次端口确认它可用。占用/权限等一切失败都算「不可用」。 */
function canListen(port, host) {
  return new Promise(resolve => {
    const probe = net.createServer()
    probe.unref()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    try {
      probe.listen(port, host)
    } catch {
      resolve(false)
    }
  })
}

/** 让内核分配一个当前空闲的端口（bind(0) 后立刻释放）。 */
function freePort(host) {
  return new Promise(resolve => {
    const probe = net.createServer()
    probe.unref()
    probe.once('error', () => resolve(0))
    probe.listen(0, host, () => {
      const address = probe.address()
      const port = address && typeof address.port === 'number' ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

/**
 * 解析出本次真正要监听的端口。
 *
 * @param {number} requested 首选端口（不合法就回落 18787）。
 * @param {string} [host] 试绑地址。
 * @param {object} [options]
 * @param {number} [options.ours] 我们**自己占着**的端口（= 最近一次下发给局域网代理的那个号），
 *   没有给 0。试绑一个自己占着的端口必然失败，但那不是「被别人占了」——调用方给这个值时，
 *   等于告诉我们「这个号是我的」，于是原样保留、连试绑都不做。
 *   **这一条不认，只读动作也会改落盘状态**：插件面板上「看一眼二维码」那条路由也会解析
 *   一次端口，代理已经在那个号上之后每次解析都会判它「被占」、换一个内核随手给的空闲端口
 *   回传，而调用方会把它写回 relay.json——于是状态里记的端口与真实监听分叉，平时看不出来，
 *   **下次重启按漂过的值去绑，手机里存的地址就废了**。判据怎么来的见 sidecar-lifecycle 的
 *   getOwnLanPort：**不能**用「快照说它在 listening」，那个在重绑窗口里还是上一个号。
 * @returns {Promise<{port: number, adjusted: boolean, requested: number, ours?: boolean}>}
 *   `adjusted=true` 表示首选端口被占、换了一个；`ours=true` 表示这个号本来就是自己的。
 */
async function resolvePort(requested, host = '0.0.0.0', options = {}) {
  const wanted = Number.isInteger(requested) && requested >= 1024 && requested <= 65535 ? requested : 18787
  if (Number.isInteger(options.ours) && options.ours === wanted) {
    return { port: wanted, adjusted: false, requested: wanted, ours: true }
  }
  if (await canListen(wanted, host)) return { port: wanted, adjusted: false, requested: wanted }
  const port = await freePort(host)
  return { port: port > 0 ? port : wanted, adjusted: true, requested: wanted }
}

module.exports = { canListen, freePort, resolvePort }

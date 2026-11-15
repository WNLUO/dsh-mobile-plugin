'use strict'

// 端口自检与测试分配；运行入口直接绑定保存值，不预探测换号。

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

module.exports = { canListen, freePort }

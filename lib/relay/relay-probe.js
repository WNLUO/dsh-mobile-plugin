'use strict'
// 公用中转「电脑决定」的延迟探测：worker 连中转前先量一遍各候选的 /healthz 延迟，
// 把最快的那台排在前面再按序连（失败仍按现有逻辑顺延到下一台）。
//
// 两件事分开：`orderByLatency` 是纯函数（只排顺序、不碰网络），`probeRelayHealth` 是薄探测
// （发一次 GET、量到响应为止、超时或报错返回 null）。探测结果交给排序函数，两者互不依赖。

const http = require('node:http')
const https = require('node:https')

/**
 * 按实测延迟给候选地址排序：量到延迟的按升序在前，不可达 / 没量到的排后面。
 *
 * 不可达那一段保持它们原来在 `urls` 里的相对顺序（稳定），所以探测全挂时这里退化成原序。
 * 只读入参、返回新数组，不改 `urls`。
 *
 * @param {string[]} urls 候选地址，原序
 * @param {Map<string, number|null>|Object<string, number|null>} latencyByUrl URL→延迟毫秒，
 *   null / 缺失 = 不可达或未测到
 * @returns {string[]} 新数组
 */
function orderByLatency(urls, latencyByUrl) {
  const readLatency = (url) => {
    if (latencyByUrl instanceof Map) return latencyByUrl.get(url)
    return latencyByUrl ? latencyByUrl[url] : undefined
  }
  const reachable = []
  const unreachable = []
  for (const url of urls) {
    const latency = readLatency(url)
    if (typeof latency === 'number' && Number.isFinite(latency)) reachable.push({ url, latency })
    else unreachable.push(url)
  }
  // 数组的 sort 是稳定排序：延迟相同的几条保持原相对顺序。
  reachable.sort((a, b) => a.latency - b.latency)
  return [...reachable.map((item) => item.url), ...unreachable]
}

/**
 * 对 `url + '/healthz'` 发一次 GET，量出从发起到拿到响应（任意状态码都算）的毫秒数。
 *
 * 超时或报错返回 null（= 这条当期不可达）。按 URL 协议选 http / https，用 `req.setTimeout`
 * 起超时后 `destroy`，不走全局 fetch。
 *
 * @param {string} url 中转地址
 * @param {{ timeoutMs?: number }} [options] 超时毫秒，默认 1500
 * @returns {Promise<number|null>} 延迟毫秒，或 null
 */
function probeRelayHealth(url, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1500
  return new Promise((resolve) => {
    let healthUrl
    try {
      healthUrl = new URL(`${String(url).replace(/\/+$/, '')}/healthz`)
    } catch {
      resolve(null)
      return
    }
    const client = healthUrl.protocol === 'https:' ? https : http
    const startedAt = Date.now()
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let req
    try {
      // agent:false：一次性连接，探完就关，别把 keep-alive 的 socket 留在进程里。
      req = client.get(healthUrl, { agent: false }, (res) => {
        res.resume()
        finish(Date.now() - startedAt)
      })
    } catch {
      finish(null)
      return
    }
    req.on('error', () => finish(null))
    req.setTimeout(timeoutMs, () => {
      finish(null)
      req.destroy()
    })
  })
}

module.exports = { orderByLatency, probeRelayHealth }

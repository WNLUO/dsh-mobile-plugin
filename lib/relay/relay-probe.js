// 中转健康响应与注册失败分账，延迟、冷却和衰减均按单调经过时间计算。
'use strict'
// 中转「电脑决定」的延迟探测：worker 连中转前先量各候选的健康响应延迟，
// 把最快的那台排在前面再连。健康响应不代表隧道注册成功，注册失败证据由调用方单独保存。
//
// 两件事分开：`orderByLatency` 是纯函数（只排顺序、不碰网络），`probeRelayHealth` 是薄探测
// （发一次 GET、校验完整响应，失败返回 null）。探测结果交给排序函数，两者互不依赖。

const http = require('node:http')
const https = require('node:https')
const { performance } = require('node:perf_hooks')

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

const RELAY_HEALTH_SERVICE = 'dsh-mobile-relay'
const MAX_HEALTH_BODY_BYTES = 16 * 1024

/**
 * 对现有 `/api/mobile/v1/health` 发一次 GET，只认 2xx、ok 与中转固定服务名。
 *
 * 校验完整的小响应体后才接受首字节延迟；不跟随重定向，避免把门户页当成健康中转。
 * 一个总定时器覆盖 DNS、连接、响应头和响应体，滴流也不能延长探测预算。
 *
 * @param {string} url 中转地址
 * @param {{ timeoutMs?: number }} [options] 总超时毫秒，默认 1500
 * @returns {Promise<number|null>} 首字节延迟毫秒，或 null
 */
function probeRelayHealth(url, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 1500
  return new Promise((resolve) => {
    let healthUrl
    try {
      healthUrl = new URL(`${String(url).replace(/\/+$/, '')}/api/mobile/v1/health`)
      if (healthUrl.protocol !== 'http:' && healthUrl.protocol !== 'https:') {
        resolve(null)
        return
      }
    } catch {
      resolve(null)
      return
    }
    const client = healthUrl.protocol === 'https:' ? https : http
    const startedAt = performance.now()
    let settled = false
    let req
    let response
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (value === null) {
        if (response) response.destroy()
        if (req) req.destroy()
      }
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    try {
      // agent:false：一次性连接，探完就关，别把 keep-alive 的 socket 留在进程里。
      req = client.get(healthUrl, { agent: false }, (res) => {
        response = res
        const latency = performance.now() - startedAt
        let size = 0
        const chunks = []
        res.on('error', () => finish(null))
        res.on('aborted', () => finish(null))
        res.on('close', () => { if (!res.complete) finish(null) })
        if (!(res.statusCode >= 200 && res.statusCode < 300)) {
          finish(null)
          return
        }
        if (Number(res.headers['content-length']) > MAX_HEALTH_BODY_BYTES) {
          finish(null)
          return
        }
        res.on('data', (chunk) => {
          if (settled) return
          size += chunk.length
          if (size > MAX_HEALTH_BODY_BYTES) {
            finish(null)
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          if (settled) return
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            finish(body && body.ok === true && body.service === RELAY_HEALTH_SERVICE ? latency : null)
          } catch {
            finish(null)
          }
        })
      })
      req.on('error', () => finish(null))
    } catch {
      finish(null)
    }
  })
}

/** 注册失败与健康延迟分账：只有真实注册成功清账，失败成本随时间衰减。 */
function createRelayRegistrationLedger({ now = () => performance.now() } = {}) {
  const failures = new Map()
  const penaltyOf = (url) => {
    const fact = failures.get(url)
    if (!fact) return 0
    const count = Math.max(0, fact.count - Math.floor(Math.max(0, now() - fact.at) / 300000))
    if (!count) failures.delete(url)
    return count * 8000
  }
  return {
    noteFailure(url) {
      const count = penaltyOf(url) / 8000
      failures.set(url, { count: Math.min(4, count + 1), at: now() })
    },
    noteSuccess(url) { failures.delete(url) },
    order(urls, latencyByUrl) {
      const latency = (url) => latencyByUrl instanceof Map ? latencyByUrl.get(url) : latencyByUrl?.[url]
      const measured = urls.map(latency).filter((ms) => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0)
      const unknown = Math.max(1500, ...measured) + 1
      const cost = (url) => {
        const ms = latency(url)
        return (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : unknown) + penaltyOf(url)
      }
      const present = new Set(urls)
      for (const url of failures.keys()) if (!present.has(url)) failures.delete(url)
      const cooling = (url) => penaltyOf(url) > 0 && Math.max(0, now() - failures.get(url).at) < 30000
      return [...urls].sort((a, b) => {
        const aCooling = cooling(a), bCooling = cooling(b)
        if (aCooling !== bCooling) return aCooling ? 1 : -1
        // 全部都在短冷却时照样重试，先试最久没失败的，封顶后也不能粘在固定前几条。
        if (aCooling && bCooling && failures.get(a).at !== failures.get(b).at) return failures.get(a).at - failures.get(b).at
        return cost(a) - cost(b)
      })
    },
  }
}

/** 只报告真实环境配置或代理失败证据，不输出代理地址与认证材料。 */
function relayFailureMessage(error, env = process.env) {
  const message = String(error && typeof error.message === 'string' ? error.message : error || '连接失败')
  if (message.includes('宿主中转与总控目前只支持直连出网')) return message
  const configured = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']
    .filter((name) => typeof env[name] === 'string' && env[name].trim())
  if (!configured.length && !/\b407\b|proxy authentication|proxy connect/i.test(message)) return message
  const evidence = configured.length ? `检测到环境代理 ${configured.join('、')}` : '对端返回代理认证或连接错误'
  return `${message}；${evidence}。宿主中转与总控目前只支持直连出网，未使用环境代理；请允许目标地址直连或更换可直连网络。`
}

module.exports = { orderByLatency, probeRelayHealth, createRelayRegistrationLedger, relayFailureMessage }

// 本机公网 IPv4 自动识别：依次问几个回显服务，供面板的 IPv4 栏自动填候选。
/**
 * 公网 IPv4 探测。
 *
 * 面板要「这台机器现在对外是哪个 IPv4」，网卡枚举答不上来：机器挂在 NAT 后面时，网卡上只有
 * 私网地址，公网那一条只存在于网关的地址转换表里。唯一能问到的办法是从外网回显服务读一次
 * 「你看到我是谁」，所以这一格是网络请求，不是本机信息。
 *
 * 为什么要串行、按固定顺序试：这几个服务在国内外的可达性完全不同，排在前面的两个（ipify /
 * icanhazip）正文就是一个地址，解析最不容易出错；后两个是国内的接口，给前两个不通的网络兜底。
 * 并发问等于每次开页都打四个外网，串行则第一个通就停。
 *
 * 为什么要校验 `isPublicAddress`：回显服务在透明代理、企业网关后面可能看到的是内网地址，
 * 那不是「本机公网 IPv4」，拿去填面板只会让用户选一条拨不进来的地址。这个判据同时覆盖
 * IPv4 字面量形状（四段、每段 0-255）与私网 / CGNAT / 回环 / 链路本地等不该当公网的段。
 *
 * 缓存按进程内存、不落盘：成功结果 5 分钟内复用，失败只复用 60 秒 —— 公网地址在一次会话里
 * 基本不变，而失败可能只是当下网络抖动，缓存太久会让面板一直空着。失败也缓存，是为了不让
 * 每次开页都重新把四个外网服务敲一遍。
 */
'use strict'

const { isPublicAddress } = require('./lan-network.cjs')

const TIMEOUT_MS = 2500
const SUCCESS_TTL_MS = 5 * 60 * 1000
const FAILURE_TTL_MS = 60 * 1000

// 后两个服务的正文是整句话，只取其中第一段像 IPv4 的东西；前两个整段就是地址。
const IPV4_IN_TEXT = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/

const SOURCES = [
  { url: 'https://api.ipify.org', pick: (text) => text.trim() },
  { url: 'https://ipv4.icanhazip.com', pick: (text) => text.trim() },
  { url: 'https://myip.ipip.net', pick: (text) => (IPV4_IN_TEXT.exec(text) || [])[1] || '' },
  { url: 'https://ddns.oray.com/checkip', pick: (text) => (IPV4_IN_TEXT.exec(text) || [])[1] || '' },
]

let cached = null

/**
 * 依次探测到第一个合法公网 IPv4 为止。全部失败时如实回三个 null，不抛错 —— 它只是面板上
 * 一格自动填充，外网全不通不该把控制面那条请求一起拖红。
 *
 * `ms` 是整轮探测的耗时：命中的那条可能排在第三位，用户关心的是「等这一格要多久」，不是
 * 单个请求的耗时。缓存命中时回的是当初那一次的值。
 */
async function detectPublicIpv4({ fetchImpl = fetch } = {}) {
  const now = Date.now()
  if (cached && now - cached.at < (cached.result.ip ? SUCCESS_TTL_MS : FAILURE_TTL_MS)) {
    return { ...cached.result }
  }

  const started = now
  for (const source of SOURCES) {
    let text
    try {
      const response = await fetchImpl(source.url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (response && response.ok === false) continue
      text = await response.text()
    } catch {
      // 超时、DNS 失败、证书失败、连接被重置都只是「这个源不可用」，换下一个。
      continue
    }
    const ip = source.pick(text)
    if (!ip || !isPublicAddress(ip)) continue
    const result = { ip, source: source.url, ms: Date.now() - started }
    cached = { at: Date.now(), result }
    return { ...result }
  }

  const result = { ip: null, source: null, ms: null }
  cached = { at: Date.now(), result }
  return { ...result }
}

/** 只给测试用：清掉进程内缓存，让下一次调用重新走网络。 */
function resetPublicIpCache() {
  cached = null
}

module.exports = { detectPublicIpv4, resetPublicIpCache }

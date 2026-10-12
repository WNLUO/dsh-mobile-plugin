/**
 * 网卡枚举与候选地址：私网 / 公网两份清单，外加「用户选中的那条排最前」。
 *
 * 收口在这一个文件里，是因为 App 只认「按顺序挨个试」这一种语义 —— 顺序就是优先级。
 */
'use strict'

const os = require('node:os')

// Only advertise RFC1918 addresses. This intentionally excludes VPN/CGNAT,
// link-local and benchmarking/test ranges (notably 198.18.0.0/15).
function ipv4Number(address) {
  const parts = String(address).split('.').map(Number)
  if (parts.length !== 4 || parts.some((part, i) => !Number.isInteger(part) || part < 0 || part > 255 || String(part) !== String(address).split('.')[i])) return null
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0
}
function inRange(value, start, end) { return value >= start && value <= end }
function isPrivateLanAddress(address) {
  const value = ipv4Number(address)
  if (value === null) return false
  return inRange(value, 0x0a000000, 0x0affffff) // 10/8
    || inRange(value, 0xac100000, 0xac1fffff) // 172.16/12
    || inRange(value, 0xc0a80000, 0xc0a8ffff) // 192.168/16
}
function isVpnInterface(name) {
  return /^(?:utun|tun|tap|ppp|ipsec|wg|tailscale|vpn|zt|nebula)/i.test(String(name))
}

// Interfaces that routinely hold an RFC1918 address but are NOT reachable from a
// phone sitting on the physical LAN: container bridges, hypervisor host-only
// networks and overlay VPNs. Advertising them used to cost the app one 1.2s
// probe per dead candidate before it reached the real address.
//
// Container/WAF bridges are the easy ones to miss because they are named after
// the product, not after Docker: `safeline-ce` (SafeLine WAF) sits on
// 192.168.0.1/24 and used to be the ONLY candidate on a host whose physical NIC
// carries public addresses, so the app was told to dial a WAF container. Same
// for `cni0` / `lxcbr0` / `podman0` / `flannel.1` / `cali<hash>` / `kube-ipvs0`.
//
// Deliberately NOT filtered: macOS `bridge100` / `ap*`, because Internet Sharing
// hands out a genuine LAN on those interfaces.
const VIRTUAL_INTERFACE = /^(?:docker|br-|veth|virbr|virbr-|vmnet|vboxnet|vbox|vnic|vEthernet|Hyper-V|Default Switch|zt|nebula|ham\d|llw\d|awdl\d|safeline|cni|lxcbr|podman|flannel|cali|kube)/i
function isVirtualInterface(name) { return VIRTUAL_INTERFACE.test(String(name)) }

// Rank candidates so the address most likely to face the phone goes first. The
// relay and the app both probe in order, so ordering is a latency optimisation,
// not a correctness requirement.
function interfaceRank(name) {
  const n = String(name)
  if (/^(?:eth\d+$|enp\ds?\d*$|ens\d|eno\d|enx)/i.test(n)) return 0 // Linux ethernet
  if (/^en\d+$/i.test(n)) return 1 // macOS: en0 (Wi-Fi) / enN (thunderbolt ethernet)
  if (/^(?:wl|wlan)/i.test(n)) return 2 // Linux Wi-Fi
  return 3
}

/**
 * 扫一遍网卡，把 `accept` 认的 IPv4 地址收成候选（剔除虚拟/VPN 网卡、按物理网卡优先级
 * 排序、去重、最多 16 条）。
 *
 * `lanInterfaces` 与 `publicInterfaces` 共用这一段：两者的差别**只在 accept**——一个挑私网、
 * 一个挑公网。网卡黑名单与排序规则必须一模一样，否则同一台机器上两份候选会给出互相矛盾的顺序。
 */
function collectEndpoints(interfaces, accept) {
  const found = []
  let order = 0
  for (const [name, entries] of Object.entries(interfaces || {})) {
    const current = order++
    if (isVpnInterface(name) || isVirtualInterface(name)) continue
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue
      if (entry.family !== 'IPv4' && entry.family !== 4) continue
      if (!accept(entry.address)) continue
      found.push({ name, address: entry.address, order: current })
    }
  }
  const seen = new Set()
  return found
    .sort((a, b) => interfaceRank(a.name) - interfaceRank(b.name) || a.order - b.order)
    .filter((item) => {
      if (seen.has(item.address)) return false
      seen.add(item.address)
      return true
    })
    .slice(0, 16)
}

function toCandidates(list, port) {
  return list.map((item) => ({ url: `http://${item.address}:${port}`, interface: item.name, family: 'IPv4', address: item.address }))
}

// Structured view of the usable LAN endpoints. The relay's `normalizeLanMetadata`
// and the app's `candidateUrls()` both accept this shape, so callers that want
// interface metadata (for diagnostics or smarter ordering) should prefer it.
function lanInterfaces(port, interfaces = os.networkInterfaces()) {
  return toCandidates(collectEndpoints(interfaces, isPrivateLanAddress), port)
}
function lanUrls(port, interfaces = os.networkInterfaces()) {
  return lanInterfaces(port, interfaces).map((candidate) => candidate.url)
}
function lanCandidates(port, interfaces = os.networkInterfaces()) {
  return lanInterfaces(port, interfaces)
}

/**
 * 公网地址：同一遍扫描，挑出**真能从外网拨过来**的那些。
 *
 * 判据是「不在任何特殊网段里」，而不是「不是 RFC1918」——后者会把 169.254/16（链路本地）、
 * 100.64/10（CGNAT）、198.18/15（基准测试）这些同样拨不通的地址当成公网地址发出去。
 * 实测踩过：macOS 上一块多出来的网卡带着 `169.254.87.131`，被当成「公网地址」摆到面板上。
 * 这份特殊网段清单和本文件开头那句「intentionally excludes VPN/CGNAT, link-local and
 * benchmarking/test ranges」是同一条口径。
 *
 * 为什么不并进 `lanInterfaces`：那份列表的语义是「手机和这台机器在同一个 Wi-Fi 里能直连的
 * 地址」，混进公网地址会改掉 App 的探测顺序与中转上报的内容（`test/lan-network.test.cjs`
 * 既钉着「WAF 容器的 192.168.0.1 被当成候选」那次事故，也钉着「只有公网地址的机器候选为空」）。
 *
 * 需要公网地址的地方只有两处，都在取回来之后再决定怎么用：面板显示「手机该填哪个地址」，
 * 以及一台只有公网 IP 的机器上给不出任何私网候选时的兜底（见 `../impl.js` 的
 * `safeLanCandidates`）。
 */
const NOT_PUBLIC_RANGES = [
  [0x00000000, 0x00ffffff], // 0/8        “本网络”
  [0x64400000, 0x647fffff], // 100.64/10  CGNAT（运营商级 NAT，外网拨不进来）
  [0x7f000000, 0x7fffffff], // 127/8      回环
  [0xa9fe0000, 0xa9feffff], // 169.254/16 链路本地
  [0xc6120000, 0xc613ffff], // 198.18/15  基准测试
]
function isPublicAddress(address) {
  const value = ipv4Number(address)
  if (value === null) return false
  if (isPrivateLanAddress(address)) return false
  // 224/4 起是组播与保留（含 255.255.255.255）。
  if (value >= 0xe0000000) return false
  return !NOT_PUBLIC_RANGES.some(([start, end]) => inRange(value, start, end))
}
function publicInterfaces(port, interfaces = os.networkInterfaces()) {
  return toCandidates(collectEndpoints(interfaces, isPublicAddress), port)
}
function publicUrls(port, interfaces = os.networkInterfaces()) {
  return publicInterfaces(port, interfaces).map((candidate) => candidate.url)
}
function publicCandidates(port, interfaces = os.networkInterfaces()) {
  return publicInterfaces(port, interfaces)
}

/**
 * 对外公布的候选地址：**先私网，一个都没有时才退到公网**。
 *
 * 为什么要有这一条：`lanInterfaces` 只认 RFC1918，于是「DSH 装在一台只有公网 IP 的服务器上」
 * 时那份列表**恒为空** —— 二维码里一个可拨的地址都没有，「手机直连」这条路从根上走不通
 * （2026-10-11 用户报的现场）。只在为空时才退：有私网地址的机器，候选列表一个字都不变。
 *
 * 取不到网卡（异常）时回空清单、绝不抛：它喂的是二维码与移动端的连接信息，
 * 让它把整条控制面拖下水不值得。
 */
function advertisedCandidates(port, interfaces = os.networkInterfaces()) {
  try {
    const lan = lanCandidates(port, interfaces)
    if (lan.length > 0) return lan
    return publicCandidates(port, interfaces)
  } catch {
    return []
  }
}

/**
 * 把用户选中的那条排到最前面（面板上的「手机优先用这条」，存在设置项 `preferredLanAddress`）。
 *
 * 为什么只能是「排前面」：App 拿到候选之后是**按顺序挨个试**的，顺序就是唯一的表达方式
 * （见 `impl.js` 的 `pairingPayload` 与 `routes/mobile-api.js` 的 `/connection-info`）。
 * 所以这里刻意只挪位置：
 *
 *  - **不删任何东西**：其余的照旧跟在后面当兜底。用户选错了（比如选了一块手机根本到不了的
 *    网卡）、或者那条以后不通了，手机还能顺着试下去，不会因为一次选择就把整条局域网路走死；
 *  - **匹配不上就原样返回**：换了网段、拔了网卡之后，用户当初选的那个 IP 就不在清单里了，
 *    这时必须退回宿主自己的网卡优先级排序。绝不能因为「选过一条现在没有的地址」把候选清空；
 *  - 比对的是**地址**而不是整条 URL —— URL 里带着端口，用户改端口不该让这次选择失效。
 */
function orderCandidates(list, preferred) {
  if (!Array.isArray(list)) return []
  if (list.length < 2) return list
  const want = String(preferred || '').trim()
  if (!want) return list
  const index = list.findIndex(item => item && item.address === want)
  // 已经在首位（宿主的排序正好就是它），或者压根没有这条：原样返回。
  if (index <= 0) return list
  const ordered = list.slice()
  const [picked] = ordered.splice(index, 1)
  ordered.unshift(picked)
  return ordered
}

module.exports = {
  ipv4Number,
  isPrivateLanAddress,
  isPublicAddress,
  isVpnInterface,
  isVirtualInterface,
  interfaceRank,
  lanInterfaces,
  lanUrls,
  lanCandidates,
  publicInterfaces,
  publicUrls,
  publicCandidates,
  advertisedCandidates,
  orderCandidates,
}

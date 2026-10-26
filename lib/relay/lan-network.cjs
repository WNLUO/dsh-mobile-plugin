/**
 * 网卡枚举与候选地址：私网 / 公网 / IPv6 全球单播三份清单，外加「用户选中的那条排最前」。
 *
 * 收口在一个文件里，是因为 App 只认「按顺序挨个试」这一种语义，顺序就是优先级。
 *
 * 三份的区别在手机在哪：私网是「同一个 Wi-Fi 里能直连」，公网是「这台机器自己就挂在公网上」，
 * IPv6 是「手机在别的网络里拨过来」。IPv6 不并进前两份：App 对它的用法不同，要和公网中转
 * 比速度。
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

/**
 * RFC1918 里不由容器 / 虚拟机 / 虚拟网桥占掉的那几段。
 *
 * Docker 默认拿走 172.17/16，compose / k3d / kubeadm 又按默认值各占几段；把它们当候选，
 * 手机拨过去要么不通，要么连到容器上的别的东西。我们读不到网络配置，只能按「常见工具会不会
 * 默认占用」收敛；网卡名黑名单仍然是第一道闸。
 */
const RESERVED_172 = [
  [0xac110000, 0xac11ffff], // 172.17/16 docker0
  [0xac120000, 0xac12ffff], // 172.18/16 docker compose 默认网络
  [0xac130000, 0xac13ffff], // 172.19/16 compose 的下一个
  [0xac140000, 0xac14ffff], // 172.20/16 compose / k3d
  [0xac180000, 0xac1fffff], // 172.24~172.31/16 kubeadm / overlay
]

/**
 * 能不能把它当成「手机在同一个 Wi-Fi 里能直连的地址」。
 *
 * 注意它**不等于** `isPrivateLanAddress`：后者是「这个地址属于私有段」这个事实判断，
 * 前者是「要不要拿它当候选」这个用法判断。172.17.0.1 是私有地址，但它是 docker0 的网桥
 * 地址，当成候选就是让手机去拨一个它到不了的地方。
 */
function isLanCandidateAddress(address) {
  const value = ipv4Number(address)
  if (value === null) return false
  if (inRange(value, 0x0a000000, 0x0affffff)) return true // 10/8
  if (inRange(value, 0xc0a80000, 0xc0a8ffff)) return true // 192.168/16
  if (inRange(value, 0xac100000, 0xac1fffff)) {
    return !RESERVED_172.some(([start, end]) => inRange(value, start, end)) // 172.16/12 去掉上面那几段
  }
  return false
}

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
 * 扫一遍网卡，把 `accept` 认的、属于 `family` 的地址收成候选（剔除虚拟/VPN 网卡、按物理
 * 网卡优先级排序、去重、最多 16 条）。
 *
 * 三份清单共用这一段：差别**只在 accept 与 family**——一个挑私网 v4、一个挑公网 v4、
 * 一个挑全球单播 v6。网卡黑名单与排序规则必须一模一样，否则同一台机器上几份候选会给出
 * 互相矛盾的顺序。
 *
 * 去重按 `key`：IPv4 是地址本身，IPv6 是解出来的数值 —— 同一个地址的压缩写法、展开写法
 * 与大小写（`240e::1` / `240E:0:0:0:0:0:0:1`）必须算成一条，否则 App 会为同一个地址
 * 各探一次。
 */
function collectEndpoints(interfaces, accept, family = 'IPv4') {
  const wantV6 = family === 'IPv6'
  const found = []
  let order = 0
  for (const [name, entries] of Object.entries(interfaces || {})) {
    const current = order++
    if (isVpnInterface(name) || isVirtualInterface(name)) continue
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue
      // family 必须**显式**对上：缺字段的畸形条目不参与任何一份清单
      // （`test/lan-network.test.cjs` 的「空 / 异常入参不抛错」钉着这一条）。
      const entryV6 = entry.family === 'IPv6' || entry.family === 6
      const entryV4 = entry.family === 'IPv4' || entry.family === 4
      if (wantV6 ? !entryV6 : !entryV4) continue
      if (!accept(entry.address)) continue
      found.push({
        name,
        address: entry.address,
        order: current,
        key: wantV6 ? String(ipv6Number(entry.address)) : entry.address,
      })
    }
  }
  const seen = new Set()
  return found
    .sort((a, b) => interfaceRank(a.name) - interfaceRank(b.name) || a.order - b.order)
    .filter((item) => {
      if (seen.has(item.key)) return false
      seen.add(item.key)
      return true
    })
    .slice(0, 16)
}

/**
 * 产候选。IPv6 在 URL 里**必须带方括号**（`http://[240e::1]:18787`），裸着写出来是
 * `http://240e::1:18787` —— 一个解析不出来的坏地址。
 *
 * `address` 字段刻意**不带**方括号：面板的「手机优先用这条」是按地址匹配的
 * （`orderCandidates`），用户看到与填进去的都是裸地址。
 */
function toCandidates(list, port, family = 'IPv4') {
  const v6 = family === 'IPv6'
  return list.map((item) => ({
    url: `http://${v6 ? `[${item.address}]` : item.address}:${port}`,
    interface: item.name,
    family,
    address: item.address,
  }))
}

// Structured view of the usable LAN endpoints. The relay's `normalizeLanMetadata`
// and the app's `candidateUrls()` both accept this shape, so callers that want
// interface metadata (for diagnostics or smarter ordering) should prefer it.
function lanInterfaces(port, interfaces = os.networkInterfaces()) {
  return toCandidates(collectEndpoints(interfaces, isLanCandidateAddress), port)
}
function lanUrls(port, interfaces = os.networkInterfaces()) {
  return lanInterfaces(port, interfaces).map((candidate) => candidate.url)
}
function lanCandidates(port, interfaces = os.networkInterfaces()) {
  return lanInterfaces(port, interfaces)
}

/**
 * 公网地址：同一遍扫描，挑出真能从外网拨过来的那些。
 *
 * 判据是「不在任何特殊网段里」，而不是「不是 RFC1918」——后者会把 169.254/16（链路本地）、
 * 100.64/10（CGNAT）、198.18/15（基准测试）这些同样拨不通的地址当成公网地址发出去。
 *
 * 不并进 `lanInterfaces`：那份的语义是「同一 Wi-Fi 里能直连」，混进公网地址会改掉 App 的
 * 探测顺序与中转上报的内容。需要公网地址的只有两处：面板显示该填哪个地址，以及一台只有
 * 公网 IP 的机器上给不出任何私网候选时的兜底。
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
  // 被工具抢走的私有段（172.17 之类）既不是「同一 Wi-Fi 能直连的地址」，也不是公网地址：
  // 它们只是容器网桥，摆到哪一份清单里都只会让手机拨一个到不了的地方。
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
 * 把 IPv6 文本解成 8 段 16 位十六进制，处理内嵌 IPv4 尾巴、压缩写法与 zone id。
 * 解不出来一律回 null —— 判据函数宁可不认，也不能把一串看不懂的东西当地址发出去。
 */
function ipv6Groups(text) {
  const [head, tail, ...rest] = text.split('::')
  if (rest.length) return null
  const toGroups = (part) => (part === '' ? [] : part.split(':'))
  const headGroups = toGroups(head)
  const tailGroups = tail === undefined ? [] : toGroups(tail)
  // 内嵌 IPv4 尾巴（`::ffff:192.168.1.1`、`64:ff9b::1.2.3.4`）折成两段。
  const last = tailGroups.length ? tailGroups : headGroups
  const embedded = last.length ? last[last.length - 1] : ''
  if (embedded.includes('.')) {
    const value = ipv4Number(embedded)
    if (value === null) return null
    last.splice(last.length - 1, 1, ((value >>> 16) & 0xffff).toString(16), (value & 0xffff).toString(16))
  }
  const isHexGroup = (group) => /^[0-9a-f]{1,4}$/.test(group)
  if (![...headGroups, ...tailGroups].every(isHexGroup)) return null
  if (tail === undefined) return headGroups.length === 8 ? headGroups : null
  const fill = 8 - headGroups.length - tailGroups.length
  if (fill < 1) return null
  return [...headGroups, ...Array(fill).fill('0'), ...tailGroups]
}

/** IPv6 文本 → 128 位数值；非法回 null。方括号与 `%en0` 这类 zone id 都先剥掉。 */
function ipv6Number(address) {
  const text = String(address === null || address === undefined ? '' : address)
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split('%')[0]
  if (!text.includes(':')) return null
  const groups = ipv6Groups(text)
  if (!groups) return null
  let value = 0n
  for (const group of groups) value = (value << 16n) | BigInt(parseInt(group, 16))
  return value
}

function inV6Prefix(value, prefix, length) {
  const shift = BigInt(128 - length)
  return value >> shift === prefix >> shift
}

/**
 * 值得上报的 IPv6 地址：**全球单播**（`2000::/3`）且不是下面这三种假公网。
 *
 *   - `2002::/16`（6to4）：地址里的那截 IPv4 要靠一台公网中继转，今天基本没人还在跑中继，
 *     报出去就是一个拨不通的地址；
 *   - `2001::/32`（Teredo）：隧道端点，本身不是能直接连的服务地址；
 *   - `2001:db8::/32`：文档示例段。
 *
 * 其余非全球单播的一律不收：链路本地（`fe80::/10`）只在本链路内通，手机拿不到；
 * ULA（`fc00::/7`）要同一个内网前缀，手机同样拿不到 —— 报了都是死地址；已废弃的站点本地
 * `fec0::/10`、组播、回环、未指定、IPv4-mapped 同理。
 *
 * **不做**的事：不猜哪条是 RFC 4941 临时地址（`os.networkInterfaces()` 根本不暴露这个标志，
 * 硬造的判据只会误伤稳定地址）。同一块网卡上并存的一条稳定地址与两条临时地址会一起报出去
 * ——临时地址也是全球单播、当下也真的能连，等它轮换掉时 App 早就在下一轮发现里拿到新清单了。
 */
const V6_GLOBAL_UNICAST = [ipv6Number('2000::'), 3]
const V6_NOT_GLOBAL = [
  ['2002::', 16],
  ['2001::', 32],
  ['2001:db8::', 32],
].map(([spec, length]) => [ipv6Number(spec), length])

function isGlobalUnicastV6(address) {
  const value = ipv6Number(address)
  if (value === null) return false
  if (!inV6Prefix(value, V6_GLOBAL_UNICAST[0], V6_GLOBAL_UNICAST[1])) return false
  return !V6_NOT_GLOBAL.some(([prefix, length]) => inV6Prefix(value, prefix, length))
}

/**
 * IPv6 全球单播候选：手机**不在同一个 Wi-Fi 里**时唯一有可能直连进来的地址。
 *
 * 为什么单独一份、不并进 `lanInterfaces`：那份的语义是「手机在同一 Wi-Fi 里能直连」，
 * App 对它的处理是「在网就在、不在就连不上」——共用退避窗口的话，手机刚离开家里 Wi-Fi
 * 的那一刻（正是最该试 IPv6 的时刻）局域网一进退避就把 IPv6 一起压住了。App 侧对应一条
 * 独立通道，还要拿它和公网中转**比速度**，所以这里只负责如实产出、不去猜哪条更快。
 *
 * 最多 4 条：这台机器上通常是一到三条（一条稳定地址 + 一两条临时地址）。上限是为了二维码
 * ——候选是随二维码一起带走的，条数一多二维码就密到扫不动。
 */
const IPV6_CANDIDATE_MAX = 4
function ipv6Interfaces(port, interfaces = os.networkInterfaces()) {
  return toCandidates(collectEndpoints(interfaces, isGlobalUnicastV6, 'IPv6'), port, 'IPv6')
    .slice(0, IPV6_CANDIDATE_MAX)
}
function ipv6Urls(port, interfaces = os.networkInterfaces()) {
  return ipv6Interfaces(port, interfaces).map((candidate) => candidate.url)
}
function ipv6Candidates(port, interfaces = os.networkInterfaces()) {
  // 与 `advertisedCandidates` 同一条口径：取不到网卡（异常）时回空清单、绝不抛 —— 它喂的
  // 也是二维码与 `/connection-info`，把它整条控制面拖下水不值得。
  try {
    return ipv6Interfaces(port, interfaces)
  } catch {
    return []
  }
}

/**
 * 对外公布的候选地址：**先私网，一个都没有时才退到公网**。
 *
 * 为什么要有这一条：`lanInterfaces` 只认 RFC1918，于是「DSH 装在一台只有公网 IP 的服务器上」
 * 时那份列表**恒为空** —— 二维码里一个可拨的地址都没有，「手机直连」这条路从根上走不通。
 * 只在为空时才退：有私网地址的机器，候选列表一个字都不变。
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
 * 用户**自己填的**直连地址（设置项 `manualLanUrl`，通常是内网穿透域名）→ 候选。
 *
 * 为什么需要它：网卡扫描只能产出这台机器身上的 IP，域名一条都扫不出来。手机在「网络」页
 * 手填的地址从前只活在手机自己那份会话里 —— 重启、换网、重新配对之后全没了，而且只要同网
 * 还有一条扫出来的 IP 更快，手填的那条还会被顶掉。放进宿主配置之后，候选的唯一真源就回到
 * 宿主：手机每次核对连接信息都重新拿到它，二维码里也带着它。
 *
 * 只挡明显不能用的：空、非 http(s)、解析不出主机。不校验端口、不要求是 IP —— 穿透域名后面
 * 接的是什么由反代决定，宿主无从判断也没必要判断。
 */
function manualCandidate(value) {
  const url = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
  if (!url || !/^https?:\/\/[^\s/]+/i.test(url)) return null
  let host = ''
  try { host = new URL(url).hostname } catch { return null }
  if (!host) return null
  // `address` 与网卡候选同形（面板按裸地址显示、`orderCandidates` 按地址匹配）。
  return { url, address: host, interface: 'manual', family: 'IPv4' }
}

/**
 * 候选 = 用户填的那条（有的话）在前 + 其余照旧。按 url 去重，**不删**任何一条 NIC 候选：
 * 穿透域名不通时手机还得能顺着网卡地址摸回这台机器。值不合法时原样返回 NIC 候选，
 * 不让一条坏配置把整份候选清空（那正是彻底失联的形状）。
 */
function withManualCandidate(list, value) {
  const manual = manualCandidate(value)
  const rest = Array.isArray(list) ? list : []
  if (!manual) return rest
  return [manual, ...rest.filter(item => item && item.url !== manual.url)]
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

/**
 * 报给手机的直连候选 —— 二维码、配对响应与 `/connection-info` 三处**只许走这一份**。
 *
 * 两步顺序不能反：先让「手机优先用这条」调网卡候选的顺序，再把用户手填的地址盖到最前
 * （那条是用户在手机上手打的，`preferredLanAddress` 只是面板上对网卡地址的选择，压不过它）。
 * 三处各写一遍的结果就是「画面上说这条、手机去试另一条」。
 */
function phoneCandidates(list, options = {}) {
  return withManualCandidate(orderCandidates(list, options.preferred || ''), options.manual || '')
}

module.exports = {
  ipv4Number,
  ipv6Number,
  isPrivateLanAddress,
  isLanCandidateAddress,
  isPublicAddress,
  isGlobalUnicastV6,
  isVpnInterface,
  isVirtualInterface,
  interfaceRank,
  lanInterfaces,
  lanUrls,
  lanCandidates,
  publicInterfaces,
  publicUrls,
  publicCandidates,
  ipv6Interfaces,
  ipv6Urls,
  ipv6Candidates,
  advertisedCandidates,
  manualCandidate,
  withManualCandidate,
  orderCandidates,
  phoneCandidates,
}

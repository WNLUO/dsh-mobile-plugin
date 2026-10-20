'use strict'

/**
 * 局域网候选地址枚举的回归测试。
 *
 * 背景：`lanInterfaces()` 会把主机上的 RFC1918 地址当作「手机可达的局域网地址」
 * 通过中转上报给 App，App 再逐个探测。一旦把容器/WAF 网桥当成物理网卡，App 就
 * 会被告知去连一个永远连不上的地址（每个死候选白花一次 1.2s 探测）。
 *
 * 真实事故：测试服务器 210.16.177.228 的物理网卡只有公网地址，唯一的 RFC1918
 * 地址来自 SafeLine WAF 的 `safeline-ce`（192.168.0.1/24）。旧的黑名单没有
 * `safeline`，于是 `lanUrls()` 只返回 `http://192.168.0.1:18787` —— 一个 WAF
 * 容器地址。下面的用例把它钉死。
 *
 * 2026-10 起这个文件还钉着**第三份清单**：IPv6 全球单播候选（手机不在同一个 Wi-Fi 里、
 * 从公网拨进来时唯一有可能直连的那条地址）。它的判据面比 IPv4 那两份窄得多 —— 只认
 * `2000::/3`，并在其中排掉 6to4 / Teredo / 文档段这三段「长得像公网却收不到入站」的地址；
 * 它同样**不并进**上面那份局域网清单（有私网就只带私网，见 `docs/decisions.md` 2026-10-11
 * 那条，以及本文件末尾那条刻意钉死的边界回归）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  ipv4Number,
  isPrivateLanAddress,
  isLanCandidateAddress,
  isPublicAddress,
  publicUrls,
  isVpnInterface,
  isVirtualInterface,
  interfaceRank,
  lanInterfaces,
  lanUrls,
  lanCandidates,
  advertisedCandidates,
  ipv6Number,
  isGlobalUnicastV6,
  ipv6Interfaces,
  ipv6Urls,
  ipv6Candidates,
  orderCandidates,
} = require('../lib/relay/lan-network.cjs')

/** 把 {name: address} 简写展开成 os.networkInterfaces() 的形状。 */
function ifaces(spec) {
  const out = {}
  for (const [name, addresses] of Object.entries(spec)) {
    out[name] = [].concat(addresses).map((address) => ({ address, family: 'IPv4', internal: false }))
  }
  return out
}

/** 同上，但按 os.networkInterfaces() 里 IPv6 那一条的形状写 family:'IPv6'。 */
function v6ifaces(spec) {
  const out = {}
  for (const [name, addresses] of Object.entries(spec)) {
    out[name] = [].concat(addresses).map((address) => ({ address, family: 'IPv6', internal: false }))
  }
  return out
}

test('ipv4Number 只接受规范的十进制点分地址', () => {
  assert.equal(ipv4Number('192.168.0.1'), 0xc0a80001)
  assert.equal(ipv4Number('0.0.0.0'), 0)
  assert.equal(ipv4Number('255.255.255.255'), 0xffffffff)
  // 前导零 / 越界 / 非数字都必须拒绝，否则 010.0.0.1 会被当成 10.0.0.1
  assert.equal(ipv4Number('010.0.0.1'), null)
  assert.equal(ipv4Number('256.0.0.1'), null)
  assert.equal(ipv4Number('1.2.3'), null)
  assert.equal(ipv4Number('1.2.3.4.5'), null)
  assert.equal(ipv4Number('a.b.c.d'), null)
  assert.equal(ipv4Number(''), null)
})

test('isPrivateLanAddress 只认 RFC1918', () => {
  assert.equal(isPrivateLanAddress('10.0.0.5'), true)
  assert.equal(isPrivateLanAddress('10.255.255.255'), true)
  assert.equal(isPrivateLanAddress('172.16.0.1'), true)
  assert.equal(isPrivateLanAddress('172.31.255.254'), true)
  assert.equal(isPrivateLanAddress('192.168.31.253'), true)
  // 边界外：172.15/172.32 不是私有段
  assert.equal(isPrivateLanAddress('172.15.0.1'), false)
  assert.equal(isPrivateLanAddress('172.32.0.1'), false)
  // 公网 / 回环 / 链路本地 / 基准测试段
  assert.equal(isPrivateLanAddress('210.16.177.228'), false)
  assert.equal(isPrivateLanAddress('127.0.0.1'), false)
  assert.equal(isPrivateLanAddress('169.254.1.1'), false)
  assert.equal(isPrivateLanAddress('198.18.0.1'), false)
})

test('isPublicAddress 只认真能从外网拨过来的地址', () => {
  assert.equal(isPublicAddress('210.16.177.228'), true)
  assert.equal(isPublicAddress('111.180.197.228'), true)
  // 私网、回环、链路本地、CGNAT、基准测试、组播/保留、0/8 全都不是公网地址。
  // 实测踩过：macOS 上一块多出来的网卡带着 169.254.87.131，被当成「公网地址」摆到面板上。
  for (const address of [
    '10.0.0.5',
    '172.16.0.1',
    '192.168.31.69',
    '127.0.0.1',
    '169.254.87.131',
    '100.64.0.1',
    '100.127.255.254',
    '198.18.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    'a.b.c.d',
    '',
  ]) {
    assert.equal(isPublicAddress(address), false, address)
  }
  // CGNAT 的两头边界：100.64/10 之内都是，100.63/100.128 就出了这个段。
  assert.equal(isPublicAddress('100.128.0.1'), true)
  assert.equal(isPublicAddress('100.63.255.255'), true)
})

test('172.16/12 里被容器/虚拟机默认占掉的段不算局域网候选', () => {
  // 客户现场：一块网卡带着 172.17.0.1 —— 那是 docker0 的网桥地址，手机拨过去到不了。
  // 它**仍然是私有地址**（isPrivateLanAddress 为真），但不是「能当候选」的地址。
  assert.equal(isPrivateLanAddress('172.17.0.1'), true)
  assert.equal(isLanCandidateAddress('172.17.0.1'), false)

  for (const address of [
    '172.18.0.1', // docker compose 默认网络
    '172.19.0.1',
    '172.20.0.1',
    '172.24.0.1', // kubeadm / overlay
    '172.31.255.254',
  ]) {
    assert.equal(isLanCandidateAddress(address), false, address)
  }

  // 172.16/12 里没被主流工具默认占用的部分照旧是候选，别把整段砍了。
  for (const address of ['172.16.0.1', '172.21.5.9', '172.23.255.254']) {
    assert.equal(isLanCandidateAddress(address), true, address)
  }
  // 另外两段 RFC1918 一个字都没变。
  assert.equal(isLanCandidateAddress('10.0.0.5'), true)
  assert.equal(isLanCandidateAddress('192.168.31.69'), true)
  assert.equal(isLanCandidateAddress('210.16.177.228'), false)
  assert.equal(isLanCandidateAddress('169.254.1.1'), false)
})

test('docker 网桥上的 172.17.0.1 不会被当成局域网地址摆出来', () => {
  // 网卡名不在黑名单里也拦得住：判据是地址段，不是网卡叫什么 ——
  // 有人把 docker 网桥改名成 en0 也不可能因此变成候选。
  const host = ifaces({
    en0: '192.168.31.69',
    eth1: '172.17.0.1',
  })
  assert.deepEqual(lanUrls(18787, host), ['http://192.168.31.69:18787'])
  // 一台机器**只有** 172.17 的时候，候选为空：给一个连不上的地址不如不给。
  assert.deepEqual(lanUrls(18787, ifaces({ eth1: '172.17.0.1' })), [])
})

test('publicInterfaces 与 lanInterfaces 共用同一套网卡黑名单与排序', () => {
  const host = ifaces({
    lo0: '127.0.0.1',
    en0: ['192.168.31.69', '210.16.177.228'],
    'docker0': '172.17.0.1',
    'safeline-ce': '192.168.0.1',
    utun3: '10.8.0.2',
    en9: '169.254.87.131',
  })
  assert.deepEqual(lanUrls(18787, host), ['http://192.168.31.69:18787'])
  assert.deepEqual(publicUrls(18787, host), ['http://210.16.177.228:18787'])
})

test('VPN 网卡一律排除', () => {
  for (const name of ['utun3', 'tun0', 'tap0', 'ppp0', 'ipsec0', 'wg0', 'tailscale0', 'vpn0', 'zt0', 'nebula1']) {
    assert.equal(isVpnInterface(name), true, name)
  }
  assert.equal(isVpnInterface('en0'), false)
  assert.equal(isVpnInterface('eth0'), false)
})

test('容器 / WAF / 虚拟网桥一律排除', () => {
  const virtual = [
    'docker0', 'br-4fda23006641', 'veth1a2b3c', 'virbr0', 'vmnet8', 'vboxnet0',
    'vEthernet (Default Switch)', 'Hyper-V Virtual', 'Default Switch', 'ham0', 'llw0', 'awdl0',
    // 本次事故与同类产品
    'safeline-ce', 'cni0', 'cni-podman0', 'lxcbr0', 'podman0', 'flannel.1', 'cali9f2b1c3d4e5f', 'kube-ipvs0',
  ]
  for (const name of virtual) assert.equal(isVirtualInterface(name), true, name)
})

test('物理网卡（含 macOS 互联网共享）不能被误杀', () => {
  // bridge100 / ap* 是 macOS 互联网共享，确实是真实局域网，必须保留。
  for (const name of ['en0', 'en1', 'eth0', 'enp3s0', 'ens18', 'eno1', 'wlan0', 'wl0', 'bridge100', 'ap1']) {
    assert.equal(isVirtualInterface(name), false, name)
    assert.equal(isVpnInterface(name), false, name)
  }
})

test('网卡排序：Linux 以太网 → macOS en → Linux 无线 → 其它', () => {
  assert.equal(interfaceRank('eth0'), 0)
  assert.equal(interfaceRank('enp3s0'), 0)
  assert.equal(interfaceRank('ens18'), 0)
  assert.equal(interfaceRank('eno1'), 0)
  assert.equal(interfaceRank('en0'), 1)
  assert.equal(interfaceRank('en7'), 1)
  assert.equal(interfaceRank('wlan0'), 2)
  assert.equal(interfaceRank('wl0'), 2)
  assert.equal(interfaceRank('bridge100'), 3)
  assert.equal(interfaceRank('safeline-ce'), 3)
})

test('事故复现：测试服务器的 safeline-ce 不再被当成局域网地址', () => {
  // 210.16.177.228 的真实快照：物理网卡只有公网，唯一 RFC1918 来自 WAF 容器。
  const server = ifaces({
    lo: '127.0.0.1',
    ens37f0: ['111.180.197.228', '210.16.177.228'],
    'br-4fda23006641': '172.21.0.1',
    'safeline-ce': '192.168.0.1',
    docker0: '172.17.0.1',
  })
  assert.deepEqual(lanUrls(18787, server), [])
  assert.deepEqual(lanCandidates(18787, server), [])
  // 直接锁住具体地址，防止将来又通过别的网卡名漏进来
  assert.equal(lanUrls(18787, server).includes('http://192.168.0.1:18787'), false)
})

test('物理网卡上的私有地址正常上报并带上端口', () => {
  const mac = ifaces({
    lo0: '127.0.0.1',
    en0: '192.168.31.253',
    utun3: '10.8.0.2',
    awdl0: '169.254.1.1',
  })
  assert.deepEqual(lanUrls(18787, mac), ['http://192.168.31.253:18787'])
  assert.deepEqual(lanCandidates(18787, mac), [
    { url: 'http://192.168.31.253:18787', interface: 'en0', family: 'IPv4', address: '192.168.31.253' },
  ])
})

test('多网卡按 rank 排序，同 rank 保持声明顺序', () => {
  const host = ifaces({
    wlan0: '192.168.1.50',
    en0: '10.0.0.9',
    eth0: '172.16.5.5',
    en1: '10.0.0.10',
  })
  assert.deepEqual(lanUrls(9000, host), [
    'http://172.16.5.5:9000', // eth0 rank 0
    'http://10.0.0.9:9000', // en0 rank 1
    'http://10.0.0.10:9000', // en1 rank 1，保持声明顺序
    'http://192.168.1.50:9000', // wlan0 rank 2
  ])
})

test('公网地址、回环与 internal 网卡被排除', () => {
  const host = ifaces({ eth0: '203.0.113.7' })
  host.eth0.push({ address: '192.168.9.9', family: 'IPv4', internal: true })
  host.eth0.push({ address: '192.168.9.10', family: 'IPv6', internal: false })
  assert.deepEqual(lanUrls(18787, host), [])
})

test('重复地址只保留一次，且最多 16 个候选', () => {
  const dup = ifaces({ eth0: '192.168.1.5', en0: '192.168.1.5' })
  assert.deepEqual(lanUrls(18787, dup), ['http://192.168.1.5:18787'])

  const many = {}
  for (let i = 1; i <= 20; i += 1) many[`eth${i}`] = `10.0.${i}.1`
  assert.equal(lanUrls(18787, ifaces(many)).length, 16)
})

test('空 / 异常入参不抛错', () => {
  assert.deepEqual(lanUrls(18787, {}), [])
  assert.deepEqual(lanUrls(18787, null), [])
  assert.deepEqual(lanUrls(18787, { eth0: null }), [])
  // 缺 family 的条目一律跳过（真实 os.networkInterfaces() 总会给 family，
  // 这里只是保证畸形条目不会让整次枚举抛错或漏出未校验的地址）。
  assert.deepEqual(lanUrls(18787, { eth0: [null, { address: '192.168.1.1' }] }), [])
  assert.deepEqual(lanUrls(18787, { eth0: [null, { address: '192.168.1.1', family: 'IPv4', internal: false }] }), ['http://192.168.1.1:18787'])
  // 注意：显式传 undefined 会命中 `= os.networkInterfaces()` 默认值，
  // 结果取决于跑测试的机器，因此这里不覆盖该分支。
})

/**
 * 「手机优先用这条」（面板上那个选择，存成设置项 `preferredLanAddress`）。
 *
 * 这个选择能兑现的唯一方式是**顺序**：App 拿到候选之后按顺序挨个试，所以宿主只能把选中的
 * 那条挪到最前。下面这几条钉的就是这次挪动的边界——尤其是「另外几条必须留着当兜底」和
 * 「选的那条不存在了就退回宿主排序」，这两条错了就是真机上「选一次反而连不上」。
 */
test('选中的候选排到最前，其余原样留在后面当兜底', () => {
  const list = [
    { url: 'http://10.0.0.9:18787', address: '10.0.0.9', interface: 'en0' },
    { url: 'http://172.16.5.5:18787', address: '172.16.5.5', interface: 'eth0' },
    { url: 'http://192.168.1.50:18787', address: '192.168.1.50', interface: 'wlan0' },
  ]
  const ordered = orderCandidates(list, '192.168.1.50')
  assert.deepEqual(ordered.map((item) => item.address), ['192.168.1.50', '10.0.0.9', '172.16.5.5'])
  // 原数组不许被就地改掉：调用方（二维码与 connection-info 两个消费点）共用同一份清单。
  assert.deepEqual(list.map((item) => item.address), ['10.0.0.9', '172.16.5.5', '192.168.1.50'])
})

test('已经排在最前、没指定、或者压根没这条，都原样返回', () => {
  const list = [
    { url: 'http://10.0.0.9:18787', address: '10.0.0.9' },
    { url: 'http://172.16.5.5:18787', address: '172.16.5.5' },
  ]
  assert.equal(orderCandidates(list, '10.0.0.9'), list)
  assert.equal(orderCandidates(list, ''), list)
  assert.equal(orderCandidates(list, '   '), list)
  assert.equal(orderCandidates(list, undefined), list)
  // 换了网段/拔了网卡之后选的那条就不在了：必须退回宿主的排序，绝不能把候选清空。
  assert.equal(orderCandidates(list, '192.168.9.9'), list)
})

test('只有一条或空清单时不折腾', () => {
  const one = [{ url: 'http://10.0.0.9:18787', address: '10.0.0.9' }]
  assert.equal(orderCandidates(one, '172.16.5.5'), one)
  assert.deepEqual(orderCandidates([], '10.0.0.9'), [])
  // 异常入参不抛：它喂的是二维码与移动端连接信息，跟 advertisedCandidates 同一个口径。
  assert.deepEqual(orderCandidates(null, '10.0.0.9'), [])
  assert.deepEqual(orderCandidates(undefined, '10.0.0.9'), [])
  // 畸形条目既不算命中也不被抹掉：读 `item.address` 走的是 `item &&`，整条照旧留在原位。
  assert.deepEqual(orderCandidates([null, { address: '10.0.0.9' }], '10.0.0.9'), [
    { address: '10.0.0.9' },
    null,
  ])
})

/**
 * 手机不在同一个 Wi-Fi 里时，唯一有可能直连进来的就是**宿主这块网卡上的 IPv6 全球单播
 * 地址**。下面这一组钉的是它的判据面：收哪些、不收哪些、产出什么形状、去重按什么算。
 *
 * 为什么判据必须写得这么死：这些地址会被塞进二维码、由 App 拿去直连，错收一条的代价是
 * 手机上多一次拨不通的探测（和 IPv4 那份同一个道理）；而**假公网**（6to4 / Teredo）更糟
 * ——它们看起来像公网地址、事实上要靠一台外部中继才通，报出去等于骗 App 去走一条死路。
 */
test('ipv6Number 剥掉方括号与 zone id，支持压缩写法与内嵌 IPv4 尾巴', () => {
  const base = ipv6Number('240e::1')
  assert.equal(base, 0x240e0000000000000000000000000001n)
  assert.equal(ipv6Number('[240e::1]'), base)
  // macOS 上 os.networkInterfaces() 会给带 zone 的地址写成 `fe80::1%en0`，方括号与 zone
  // id 都先剥掉再解 —— 剥不掉就整条解析失败，这块网卡的地址会被静默漏掉。
  assert.equal(ipv6Number('240e::1%en0'), base)
  // 压缩写法、展开写法与大小写解出来是同一个数值（去重按这个值算，见后面那条）。
  assert.equal(ipv6Number('240e:1:2::998'), ipv6Number('240E:1:2:0:0:0:0:998'))
  // 内嵌 IPv4 尾巴折成最后两段。
  assert.equal(ipv6Number('::ffff:192.168.1.1'), 0xffffc0a80101n)
  // 非法串一律 null：看不懂的文本绝不能当成地址发出去。
  for (const bad of ['not-an-ip', '[240e::1]:18787', '', '192.168.1.1', '240e::1::2', '240e:1:2:3:4:5:6:7:8']) {
    assert.equal(ipv6Number(bad), null, bad)
  }
})

test('isGlobalUnicastV6 只收 2000::/3，并排掉三种长得像公网的假地址', () => {
  for (const address of [
    '240e::1', // 中国电信的段，就是「手机在别的网络里拨回来」那条
    '240e:1:2::998',
    '240E:0:0:0:0:0:0:1',
    '[240e::1]',
    '2000::',
    '3fff:ffff::1',
    '2001:4860:4860::8888', // 2001::/32 只吃掉 2001:0000:/32，这个是真的公网地址
  ]) {
    assert.equal(isGlobalUnicastV6(address), true, address)
  }
  // 2000::/3 的两头之外不是全球单播。
  for (const address of ['1fff::1', '4000::1']) assert.equal(isGlobalUnicastV6(address), false, address)
  // 三种「长得像公网却收不到入站」：6to4（要靠公网中继）、Teredo（隧道端点）、文档段。
  for (const address of ['2002::1', '2002:0102:0304::1', '2001::1', '2001:0:0:0:0:0:0:1', '2001:db8::1']) {
    assert.equal(isGlobalUnicastV6(address), false, address)
  }
  // 非全球单播：链路本地 / ULA / 已废弃的站点本地 / 组播 / 回环 / 未指定 / IPv4 映射。
  for (const address of [
    'fe80::1',
    'fc00::1',
    'fd00::1',
    'fec0::1',
    'ff00::1',
    'ff02::1',
    '::1',
    '::',
    '::ffff:192.168.1.1',
  ]) {
    assert.equal(isGlobalUnicastV6(address), false, address)
  }
  // 解析不出来的串同样一律 false。
  for (const address of ['not-an-ip', '[240e::1]:18787', '', '192.168.1.1', null, undefined]) {
    assert.equal(isGlobalUnicastV6(address), false, String(address))
  }
})

test('zone id 与内嵌 IPv4 尾巴：剥得掉，但不等于放行', () => {
  // zone id 只对本链路有意义，剥它是为了让后面那层判定能跑；剥完仍是链路本地，一律不收。
  assert.equal(ipv6Number('fe80::1%en0'), ipv6Number('fe80::1'))
  assert.equal(isGlobalUnicastV6('fe80::1%en0'), false)
  assert.equal(isGlobalUnicastV6('[fe80::1%en0]'), false)
  // 带 zone id 的全球单播照旧收得到（别因为多了一截 zone 就把整块网卡丢掉）。
  assert.equal(isGlobalUnicastV6('240e::1%en0'), true)
  // 内嵌 IPv4 尾巴：`::ffff:192.168.1.1` 是 IPv4 映射地址，解得出数值但不是全球单播；
  // 收下它等于让手机去拨 `http://[::ffff:192.168.1.1]:18787` 这种到不了的地方。
  assert.equal(isGlobalUnicastV6('::ffff:192.168.1.1'), false)
  assert.equal(isGlobalUnicastV6('::ffff:8.8.8.8'), false)
})

test('IPv6 候选的 url 带方括号，address 留裸地址', () => {
  const host = v6ifaces({ en0: '240e::1' })
  assert.deepEqual(ipv6Candidates(18787, host), [
    { url: 'http://[240e::1]:18787', interface: 'en0', family: 'IPv6', address: '240e::1' },
  ])
  // 裸着拼出来是 `http://240e::1:18787` —— 一个解析不出来的坏地址，App 拨过去必失败。
  const [candidate] = ipv6Candidates(18787, host)
  assert.equal(candidate.url.includes('['), true)
  assert.equal(candidate.address.includes('['), false)
  // 面板的「手机优先用这条」是按**裸地址**匹配的（`orderCandidates`）：address 一旦也带上
  // 方括号，用户选过的那条就再也匹配不上，那次选择等于白做。
  const picked = orderCandidates(ipv6Candidates(18787, v6ifaces({ eth0: '240e::2', en0: '240e::1' })), '240e::1')
  assert.equal(picked[0].url, 'http://[240e::1]:18787')
  assert.equal(picked[0].address, '240e::1')
})

test('同一个地址的压缩、展开与大小写写法只算一条候选', () => {
  const same = v6ifaces({
    en0: ['240e:1:2::998', '240E:1:2:0:0:0:0:998', '240e:1:2:0:0:0:0:998'],
  })
  assert.equal(ipv6Urls(18787, same).length, 1)
  // 跨网卡的同一个地址同样只算一条 —— 它挂在两块网卡上也还是一个地址，各探一次是白花一次超时。
  // 去重发生在按网卡优先级排序之后，所以留下的是 rank 更靠前的那块的写法。
  assert.deepEqual(
    ipv6Urls(18787, v6ifaces({ en0: '240e:1:2::998', eth0: '240E:1:2:0:0:0:0:998' })),
    ['http://[240E:1:2:0:0:0:0:998]:18787'],
  )
})

test('IPv6 候选最多 4 条', () => {
  // 上限是为二维码设的：候选随二维码一起被带走，条数一多二维码就密到扫不动。
  const many = {}
  for (let i = 1; i <= 8; i += 1) many[`eth${i}`] = `240e::${i}`
  assert.equal(ipv6Interfaces(18787, v6ifaces(many)).length, 4)
  assert.equal(ipv6Urls(18787, v6ifaces(many)).length, 4)
  // 一条稳定地址 + 两条临时地址是常见的一台机器，别把上限当成「只留一条」。
  assert.equal(ipv6Urls(18787, v6ifaces({ en0: ['240e::1', '240e::2', '240e::3'] })).length, 3)
})

test('虚拟 / VPN 网卡与 internal 网卡上的 IPv6 一律跳过', () => {
  const host = v6ifaces({
    lo0: '::1',
    en0: '240e::1',
    docker0: '240e::9',
    utun3: '240e::10',
    awdl0: '240e::11',
    'safeline-ce': '240e::12',
  })
  assert.deepEqual(ipv6Urls(18787, host), ['http://[240e::1]:18787'])
  // internal: true 的地址不摆出来（lo0 那条就是），显式再来一条全球单播的钉住它。
  const internal = v6ifaces({ en0: '240e::1' })
  internal.en0.push({ address: '240e::2', family: 'IPv6', internal: true })
  assert.deepEqual(ipv6Urls(18787, internal), ['http://[240e::1]:18787'])
})

test('family 必须显式对上，IPv4 记录与缺 family 的畸形条目不进 IPv6 候选', () => {
  // 注意 `ifaces()` 助手把一切写成 family:'IPv4'：拿它喂 IPv6 这几份清单必须一无所获，
  // 否则「IPv4 记录漏进 IPv6 候选」会被当成通过。
  assert.deepEqual(ipv6Urls(18787, ifaces({ en0: '240e::1' })), [])
  // os.networkInterfaces() 在新版本 node 上给数字 6，两种写法都得认。
  assert.deepEqual(ipv6Urls(18787, { en0: [{ address: '240e::1', family: 6, internal: false }] }), [
    'http://[240e::1]:18787',
  ])
  assert.deepEqual(ipv6Urls(18787, { en0: [{ address: '240e::1', family: 4, internal: false }] }), [])
  assert.deepEqual(ipv6Urls(18787, { en0: [{ address: '240e::1', internal: false }] }), [])
})

test('IPv6 清单的空 / 异常入参不抛错', () => {
  assert.deepEqual(ipv6Urls(18787, {}), [])
  assert.deepEqual(ipv6Urls(18787, null), [])
  assert.deepEqual(ipv6Urls(18787, { eth0: null }), [])
  assert.deepEqual(ipv6Urls(18787, { eth0: [null, { address: '240e::1' }] }), [])
  assert.deepEqual(ipv6Urls(18787, { eth0: [null, { address: '240e::1', family: 'IPv6', internal: false }] }), [
    'http://[240e::1]:18787',
  ])
  // 整条枚举炸掉时回空清单：`ipv6Candidates` 喂的是二维码与 /connection-info，
  // 不能让一份畸形网卡快照把整条控制面拖下水。
  assert.deepEqual(ipv6Candidates(18787, { eth0: 42 }), [])
})

test('只有 IPv6、没有任何 IPv4 的机器上 advertisedCandidates 仍然为空', () => {
  // 刻意设计（`docs/decisions.md` 2026-10-11）：那份清单的语义是「手机和这台机器在同一个
  // Wi-Fi 里能直连的地址」，有私网就只带私网；IPv6 那份单独走 `ipv6Candidates`、由 App 另开
  // 一条通道（它要和公网中转比速度，退避窗口也不同），**不并进来**。
  const onlyV6 = {
    lo0: [{ address: '::1', family: 'IPv6', internal: true }],
    en0: [{ address: '240e::1', family: 'IPv6', internal: false }],
  }
  assert.deepEqual(advertisedCandidates(18787, onlyV6), [])
  // 同一份快照在 IPv6 那份清单里照常产出：回空是因为「不掺进来」，不是因为枚举瞎了。
  assert.deepEqual(ipv6Urls(18787, onlyV6), ['http://[240e::1]:18787'])
})

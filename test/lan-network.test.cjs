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
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  ipv4Number,
  isPrivateLanAddress,
  isPublicAddress,
  publicUrls,
  isVpnInterface,
  isVirtualInterface,
  interfaceRank,
  lanInterfaces,
  lanUrls,
  lanCandidates,
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

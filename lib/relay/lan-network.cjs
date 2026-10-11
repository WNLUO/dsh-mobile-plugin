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

// Structured view of the usable LAN endpoints. The relay's `normalizeLanMetadata`
// and the app's `candidateUrls()` both accept this shape, so callers that want
// interface metadata (for diagnostics or smarter ordering) should prefer it.
function lanInterfaces(port, interfaces = os.networkInterfaces()) {
  const found = []
  let order = 0
  for (const [name, entries] of Object.entries(interfaces || {})) {
    const current = order++
    if (isVpnInterface(name) || isVirtualInterface(name)) continue
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue
      if (entry.family !== 'IPv4' && entry.family !== 4) continue
      if (!isPrivateLanAddress(entry.address)) continue
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
    .map((item) => ({ url: `http://${item.address}:${port}`, interface: item.name, family: 'IPv4', address: item.address }))
}
function lanUrls(port, interfaces = os.networkInterfaces()) {
  return lanInterfaces(port, interfaces).map((candidate) => candidate.url)
}
function lanCandidates(port, interfaces = os.networkInterfaces()) {
  return lanInterfaces(port, interfaces)
}

module.exports = { ipv4Number, isPrivateLanAddress, isVpnInterface, isVirtualInterface, interfaceRank, lanInterfaces, lanUrls, lanCandidates }

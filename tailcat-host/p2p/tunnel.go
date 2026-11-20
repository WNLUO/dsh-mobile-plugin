// 点对点隧道持续核对数据面健康，限时通告公网映射并统一回收网络资源。
//
// 与直连隧道（tailcat）的区别只在**怎么找到对方**：tailcat 借公共中继会合，这条借
// 「此刻已经通着的那条通道」互换几个字节的地址，然后两端同时往对方打洞。数据面是标准
// WireGuard，两端直连，任何第三方都不承载一个字节的业务数据。
//
// 会合为什么不算「架服务器」：交换发生在我们**已经有**的那条链路上（局域网、中转、或者
// tailcat 隧道），只是搭一段信令过去，不新增任何部署物、不新增任何常驻服务。
//
// 打洞失败是正常结局（两端都在对称 NAT 后面时无解），不是异常：如实报 `nat-blocked`，
// 由 App 退回原来的通道。**绝不伪装成「已连通」**——那会让用户以为问题已经解决了。
//
// 2026-11 这一版的三个结论：
//
//   - **`direct` 的判据是「数据面真的通着」**：分流器收到对端的探测包只说明洞开了（UDP
//     与密钥无关，洞开了照样可能一个包都过不去），所以 `direct` 现在要 WireGuard 的
//     `latest_handshake_time` 真的写上过一笔才算。这一点对 `Path()` 的对外词汇没有影响：
//     仍然只有 `direct / failed / punching / waiting` 四个词（插件与 App 就认这四个）。
//   - **打洞不是一次性的**：一轮没成就如实报 `failed`，但会按退避再打有限几轮 ——
//     网络刚切换、NAT 映射刚被回收这两种情况，下一轮往往就能通。退避保留原样：
//     **第一次失败就退避**，不退化成密集重试。
//   - **STUN 只在需要时刷新**：映射会在网络切换后变，所以隧道活着的期间隔一阵重问一次，
//     新地址会出现在 `Candidates()` 里，下一次会合就能换给对端。
//   - **重试期间失败态不翻回 punching**：一轮报过 failed 之后，退避重试哪怕又收到对端探测包，
//     `Path()` 也继续报 failed，直到握手真的落定才改口 direct —— 否则界面会跟着各轮打洞在
//     「没打通 / 正在打洞」之间来回跳。

package p2p

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 固定错误码：事件与回执里只出现这些词，不回显输入、不带密钥材料。
const (
	ErrInvalid = "invalid-request"
	ErrKey     = "invalid-key"
	ErrStart   = "start-failed"
	ErrNoPeer  = "no-peer"
	ErrNat     = "nat-blocked"
	// ErrHandshake 是「洞开了、但对端没能握上手」：数据面没通，所以不算 direct。
	// 它与 nat-blocked 分开，因为下一步排查方向不同（前者多半是两端的公钥配错了）。
	ErrHandshake = "handshake-failed"
	ErrClosed    = "closed"
)

const (
	// 内层仅用 IPv4：1200 加上 WireGuard/UDP/IPv6 的 80 字节仍能落在 1280 路径内。
	tunnelMTU = 1200
	// holeTimeout 是**一轮**打洞的预算：两端同时在打，通常一秒内就有结论。
	holeTimeout = 8 * time.Second
	// holeAttempts 是整条隧道一共打几轮。一轮没成不判死刑：网络刚切换、NAT 映射刚被
	// 回收这两种情况，下一轮往往就通了。上限刻意小 —— 打不通的 NAT 组合打一百轮也
	// 打不通，而每一轮都要占住界面上的「正在打洞」。
	holeAttempts = 3
	// holeBackoff 是两轮之间的退避：**第一次失败就退避**，不退化成密集重试（与本项目
	// 局域网那条「攒够阈值才退避」刻意不同：打洞的失败要么是还没打穿、要么是这条路根本
	// 无解，两种都该让它歇一轮，而不是每发请求先白等一次握手超时）。
	holeBackoff = 15 * time.Second
	// handshakeWait 是「洞开了之后等 WireGuard 握手」的上限。握手没回音时它每 5 秒重
	// 发一次，所以这里要盖住一个重传周期，否则「第一次发丢了、第二次才通」会被误判成失败。
	handshakeWait = 12 * time.Second
	// stunRefresh 是隧道活着时重问出口地址的周期。NAT 映射会随网络切换而变，问一次就
	// 再也不问的后果是：重连时还在报上一个网络的地址，对端往那儿打永远打不到。
	stunRefresh = 20 * time.Second
	stunLifetime = 30 * time.Second
	// WireGuard 空闲连接也会重握手；留出其 120 秒周期与重传时间。
	directLifetime = 3 * time.Minute
	healthCheck = time.Second
	// holeInterval 是往每个候选打洞的间隔。
	holeInterval = 250 * time.Millisecond
	// keepAlive 是打通之后保活 NAT 映射的周期。
	keepAlive = 25 * time.Second
	// PathPunching / PathWaiting 是「还没有结论」的两种细分（见 Path）：
	// 在打、以及在等人来打。对外仍然只是「没通」，但界面上必须说得清是哪一种 ——
	// 一直说「正在打洞」会让人以为它在干活，而它其实只是站在那儿等。
	PathPunching = "punching"
	PathWaiting  = "waiting"
	// holePayload / livePayload 仅供打洞，不能延长认证数据面的健康窗口。
	holePayload = "dsh-p2p-hole"
	livePayload = "dsh-p2p-keepalive"
)

// 这两个做成变量只为让测试能缩短它们，正式代码不碰。
var (
	holeRoundTimeout = holeTimeout
	holeRetryBackoff = holeBackoff
)

// Options 是拉起一条 P2P 隧道需要的一切。
type Options struct {
	// PrivateKey 是本端 WireGuard 私钥（base64 或 hex）。配对时生成，与设备凭据一起存。
	PrivateKey string
	// PeerPublicKey 是对方的公钥；只有持有对应私钥的一端能握上手。
	PeerPublicKey string
	// PeerCandidates / PeerLocalCandidates 是对方给的候选，一律当不可信数据。
	PeerCandidates      []string
	PeerLocalCandidates []string
	// ListenPort 是**在隧道里**要监听 / 要拨通的端口：手机拨它，电脑在虚拟网卡上听它。
	// 两端用同一个数（配对时由电脑告诉手机）。
	ListenPort int
	// TargetPort 是电脑侧真正把连接转给谁（本机插件在听的那个口）。手机侧不用。
	TargetPort int
	// Mode 决定这条隧道往哪边拨：手机 dial、电脑 accept。
	Mode Mode
	// STUN 可替换，测试用。
	STUN []string
}

// Tunnel 是一条跑起来的 P2P 隧道。
type Tunnel struct {
	// LocalURL 是本机那个回环地址（手机侧）；电脑侧是隧道里的地址。
	LocalURL string

	cancel context.CancelFunc
	done   chan struct{}
	once   sync.Once

	mu       sync.Mutex
	path     string
	peerAddr string
	lastErr  string
	// 还没有结论时，区分「我在打」与「我在等人打」（见 Path）。两者都不算通，但界面上
	// 必须说得清是哪一种 —— 一直说「正在打洞」会让人以为它在干活。
	dialPending bool
	listenOnly  bool
	// holeOpen 是「这一轮收到了对端的探测包」：洞开了，但数据面通没通要看握手（见 Path）。
	holeOpen bool
	// localAddr 是 STUN 报出来的「我从外面看是什么样」；localPort 是本端 socket 的端口。
	// 两样合起来就是我要告诉对端的候选 —— 没有它，对端只能往空气里打洞。
	localAddr netip.AddrPort
	localAt   time.Time
	localPort int
	lastHandshake string
	lastRx uint64
	healthAt time.Time
	wake chan struct{}
	refresh chan struct{}

	conn    *net.UDPConn
	bind    *punchedBind
	forward *dialForward
	// device 只用到两样：收尾、以及读一次配置回执看握手（其余动作走包级函数）。
	device interface {
		Close()
		IpcGet() (string, error)
	}
	// stun 是「这块 socket 上 STUN 回包归谁」的登记处：分流器是唯一读者，STUN 靠它转交。
	stun *stunWaiter
	// attempts 是已经打过几轮（诊断用：能让「它到底还在试还是已经放弃」一眼看出来）。
	attempts int
}

// Path 报这条隧道打通了没有：`direct` / `failed` / `punching` / `waiting` / `unknown`。
//
// 对外**仍然只有这四个词**（加上还没结论时的 `unknown`）：插件 `session.cjs` 与 App 的
// `p2pPath` 就认这几个，多造一个新词只会被折成 unknown。收紧的是 `direct` 的**置上条件**：
// 早先是「收到过对端的探测包」，现在还要 WireGuard 的握手真的写过一笔 —— 探测包只说
// 明洞开了，UDP 打洞与密钥无关，公钥配错时洞照样开、`direct` 照样置上，而数据面一个包
// 都过不去（这条通道踩过一次，见开发地图 A2-92）。所以这里读一次 `latest_handshake_time`。
//
// direct 只在本地健康窗口内有效，失联后回到打洞，后台有限重试期间失败仍如实报告。
func (t *Tunnel) Path() string {
	t.mu.Lock()
	path := t.path
	holeOpen := t.holeOpen
	dialPending := t.dialPending
	listenOnly := t.listenOnly
	closed := t.lastErr == ErrClosed
	t.mu.Unlock()
	if closed {
		return "failed"
	}

	// 历史握手非零不代表现在仍通；只用新握手或已认证接收增量延长本地健康窗口。
	if t.handshakeSeen() {
		t.confirmDirect()
		return "direct"
	}
	if path == "direct" {
		t.loseDirect(ErrHandshake)
		return PathPunching
	}
	// **已经报过 failed 的，重试期间继续报 failed**，哪怕这一轮又收到对端探测包。
	// 把 failed 翻回 punching 会让同一个事实在界面上来回跳（洞开着不等于这轮就不会再失败），
	// 也让「打了几轮都打不通」永远落不到一个终态上。真要通了由上面的握手改口成 direct。
	// 只有**第一轮**（path 还空着）才会走到下面的 `holeOpen → punching`。
	if path == "failed" {
		return "failed"
	}
	if holeOpen {
		// 洞开着、握手还没落定：这不是「在等」也不是「失败」，是正在拿数据面验证。
		return PathPunching
	}
	// 还没有结论。
	//
	// **电脑侧「只听不打」时这里不能一直报 unknown**：那一半没有对端候选、压根不发探测包，
	// 而 `direct` 只有数据面真的通了才会置上、`failed` 只有每一轮打洞都超时才置上 ——
	// 两件事在这种情况下都不会发生，于是它永远停在 `unknown`，界面就一直显示「正在打洞」，
	// 用户没法判断到底是还在试、还是卡住了。
	//
	// 这里如实分开三种：真的在打（有人在发探测包）、在等人来打（没有候选、只监听）、
	// 以及刚起来还不知道。`waiting` 不是「通了」也不是「失败」，它说的是「这半边准备好了，
	// 等对端来会合」。
	if dialPending {
		return PathPunching
	}
	if listenOnly {
		return PathWaiting
	}
	return "unknown"
}

// handshakeSeen 只让 WireGuard 的认证证据更新本地单调健康窗口。
func (t *Tunnel) handshakeSeen() bool {
	raw, err := t.readIpcGet()
	if err != nil {
		return false
	}
	var seconds, nanos string
	var rx uint64
	for _, line := range strings.Split(raw, "\n") {
		name, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch name {
		case "last_handshake_time_sec":
			if secs, err := strconv.ParseInt(value, 10, 64); err == nil && secs > 0 {
				seconds = value
			}
		case "last_handshake_time_nsec":
			nanos = value
		case "rx_bytes":
			rx, _ = strconv.ParseUint(value, 10, 64)
		}
	}
	now := time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	handshake := seconds + ":" + nanos
	if seconds != "" && handshake != t.lastHandshake || rx > t.lastRx {
		t.healthAt = now
	}
	if seconds != "" {
		t.lastHandshake = handshake
	}
	t.lastRx = rx
	return !t.healthAt.IsZero() && now.Sub(t.healthAt) <= directLifetime
}

func (t *Tunnel) loseDirect(code string) {
	t.mu.Lock()
	changed := t.path == "direct"
	if changed {
		t.path = ""
		t.holeOpen = false
		t.dialPending = true
		t.healthAt = time.Time{}
		t.lastErr = code
	}
	t.mu.Unlock()
	if !changed {
		return
	}
	t.requestRefresh()
	select {
	case t.wake <- struct{}{}:
	default:
	}
}

func (t *Tunnel) requestRefresh() {
	select {
	case t.refresh <- struct{}{}:
	default:
	}
}

// readIpcGet 取一份 WireGuard 的配置回执（`IpcGet` 是它的导出接口）。
//
// 设备是在 `assemble` 里建的、而握手观察协程也在那儿就起来了，所以这里必须走锁：
// 直接读那个字段会与赋值撞上（读到一个半写入的值）。
func (t *Tunnel) readIpcGet() (string, error) {
	t.mu.Lock()
	dev := t.device
	t.mu.Unlock()
	if dev == nil {
		return "", errNoDevice
	}
	return dev.IpcGet()
}

// setDevice 记下这台设备（同时也只有它能读配置回执）。
func (t *Tunnel) setDevice(dev interface {
	Close()
	IpcGet() (string, error)
}) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.device = dev
}

// getDevice 取设备本身，收尾时用。
func (t *Tunnel) getDevice() interface {
	Close()
	IpcGet() (string, error)
} {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.device
}

var errNoDevice = errors.New("p2p-no-device")

// markListenOnly 记下「我这边没有对端候选，只监听、不主动打」。
func (t *Tunnel) markListenOnly() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.listenOnly = true
}

// markDialing 记下「我这边有对端候选，正在主动打」。
func (t *Tunnel) markDialing() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.dialPending = true
}

// setLocalEndpoint 记下 STUN 报出来的出口地址。
func (t *Tunnel) setLocalEndpoint(addr netip.AddrPort) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.localAddr = addr
	t.localAt = time.Now()
}

// setLocalPort 记下本端 socket 的端口（同一张网里直连用得上）。
func (t *Tunnel) setLocalPort(port int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.localPort = port
}

// Candidates 报「对端要往哪些地址打我」：本机私网 IPv4 + 本机全球 IPv6 + STUN 那份公网地址。
//
// 顺序是刻意的：**私网 IPv4 在前**（同一张网里那一跳往往直接就通，不必等公网打洞），
// **IPv6 居中**（它没有 NAT，本机地址就是对方能直接到达的地址 —— 双/对称 NAT 打不通时
// 这是那条出路），**STUN 公网 IPv4 放最后**（对称 NAT 上多半没用）。
//
// 这是会合的核心：没有这份东西，对端不知道往哪打，这条通道一次都连不上。
func (t *Tunnel) Candidates() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]string, 0, 4)
	if t.localPort > 0 {
		// 本机的私网地址：扫一遍非回环的 IPv4 网卡地址拼上去。同一张网里对端直接能用。
		for _, addr := range localPrivateAddrs() {
			out = append(out, netip.AddrPortFrom(addr, uint16(t.localPort)).String())
		}
		// 本机的全球 IPv6 地址：不需要 NAT 也不需要 STUN，本机地址即对方可达地址。
		for _, addr := range localGlobalV6Addrs() {
			out = append(out, netip.AddrPortFrom(addr, uint16(t.localPort)).String())
		}
	}
	if t.localAddr.IsValid() && time.Since(t.localAt) <= stunLifetime {
		out = append(out, t.localAddr.String())
	}
	return out
}

// localPrivateAddrs 列出本机的私网 IPv4 地址（回环与链路本地不要）。
//
// **必须留兜底**：安卓普通 App 的 UID 拿不到 NETLINK_ROUTE，`net.InterfaceAddrs()` 会直接
// 报 permission denied（`mobile/android_net.go` 里对 netmon 已经挂过一次同样的兜底）。
// 这里不兜的话手机上候选就是空的 —— 电脑那边只能「只听不打」，这条通道永远通不了。
// 兜底与那份同源：拨一个 UDP 套接字（不发任何包）让内核挑出本机的出口源地址。
func localPrivateAddrs() []netip.Addr {
	out := interfacePrivateAddrs()
	if len(out) > 0 {
		return out
	}
	if addr, ok := outboundLocalAddr(); ok && addr.IsPrivate() && !addr.IsLoopback() {
		return []netip.Addr{addr}
	}
	return nil
}

// interfacePrivateAddrs 走系统接口表；权限不够或没网卡时回空（交给调用方兜底）。
func interfacePrivateAddrs() []netip.Addr {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	out := make([]netip.Addr, 0, 2)
	for _, item := range addrs {
		value, ok := item.(*net.IPNet)
		if !ok || value == nil {
			continue
		}
		addr, ok := netip.AddrFromSlice(value.IP)
		if !ok {
			continue
		}
		addr = addr.Unmap()
		if !addr.Is4() || !addr.IsPrivate() || addr.IsLoopback() {
			continue
		}
		out = append(out, addr)
	}
	return out
}

// localGlobalV6Addrs 列出本机的**全球单播 IPv6** 地址（回环 / 链路本地 / ULA / 6to4 /
// Teredo / 文档段都不要）。
//
// 为什么要单独一份：IPv6 没有 NAT，本机这个地址就是对方能直接到达的地址 —— 把它当候选报
// 出去，双/对称 NAT 的 IPv4 打不通时，对端还能直接连过来。它与私网 IPv4 是并列的两份，
// 不合并：一份在 IPv4 世界里走打洞，一份在 IPv6 世界里根本不用打洞。
//
// 安卓上 `net.InterfaceAddrs()` 同样可能拿不到（与私网那份同源），所以也留了兜底：拨一个
// UDP6 套接字让内核挑出口 v6 地址。
func localGlobalV6Addrs() []netip.Addr {
	out := interfaceGlobalV6Addrs()
	if len(out) > 0 {
		return out
	}
	if addr, ok := outboundLocalV6Addr(); ok && isGlobalUnicastV6(addr) {
		return []netip.Addr{addr}
	}
	return nil
}

// interfaceGlobalV6Addrs 走系统接口表；权限不够或没网卡时回空（交给调用方兜底）。
func interfaceGlobalV6Addrs() []netip.Addr {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	out := make([]netip.Addr, 0, 2)
	for _, item := range addrs {
		value, ok := item.(*net.IPNet)
		if !ok || value == nil {
			continue
		}
		addr, ok := netip.AddrFromSlice(value.IP)
		if !ok {
			continue
		}
		addr = addr.Unmap()
		// IPv4 那条由 localPrivateAddrs 负责，这里只要 v6。
		if !addr.Is6() || !isGlobalUnicastV6(addr) {
			continue
		}
		if !containsAddr(out, addr) {
			out = append(out, addr)
		}
	}
	return out
}

// isGlobalUnicastV6 只认 `2000::/3` 的全球单播，排掉几类看起来像但其实不可直接到达的段：
// 回环 / 链路本地 / ULA（`fc00::/7`，局域网私用）/ 6to4（`2002::/16`）/ Teredo（`2001::/32`）/
// 文档段（`2001:db8::/32`）。判据与插件侧 `lan-network.cjs` 的 `isGlobalUnicastV6` 同一口径。
func isGlobalUnicastV6(addr netip.Addr) bool {
	if !addr.Is6() || addr.IsLoopback() || addr.IsLinkLocalUnicast() || addr.IsMulticast() {
		return false
	}
	if !netip.MustParsePrefix("2000::/3").Contains(addr) {
		return false
	}
	for _, bad := range deniedV6Prefixes {
		if bad.Contains(addr) {
			return false
		}
	}
	return true
}

// deniedV6Prefixes 是「在 2000::/3 里但不可直接到达」的那几段。
var deniedV6Prefixes = []netip.Prefix{
	netip.MustParsePrefix("fc00::/7"),      // ULA，私网
	netip.MustParsePrefix("2002::/16"),     // 6to4
	netip.MustParsePrefix("2001::/32"),     // Teredo
	netip.MustParsePrefix("2001:db8::/32"), // 文档段
}

func containsAddr(list []netip.Addr, want netip.Addr) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

// outboundLocalV6Addr 拨一个 UDP6 套接字，取内核为本机挑的源 v6 地址；不做任何 I/O。
//
// 与 v4 那份同理：UDP 的 connect 不发包，只让内核按路由表挑出口，目标地址不需要真的可达。
func outboundLocalV6Addr() (netip.Addr, bool) {
	conn, err := net.Dial("udp6", "[2606:4700:4700::1111]:53")
	if err != nil {
		return netip.Addr{}, false
	}
	defer func() { _ = conn.Close() }()
	local, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok || local == nil {
		return netip.Addr{}, false
	}
	addr, ok := netip.AddrFromSlice(local.IP)
	if !ok {
		return netip.Addr{}, false
	}
	return addr.Unmap(), true
}

// outboundLocalAddr 拨一个 UDP 套接字，取内核为本机挑的源地址；不做任何 I/O。
//
// 目标地址取一个只在通告里出现的文档网段（TEST-NET-3）：UDP 的 connect 不发包，只让内核
// 按路由表挑出口，所以这个地址不需要真的可达 —— 也不能选一个真会被访问的第三方。
func outboundLocalAddr() (netip.Addr, bool) {
	conn, err := net.Dial("udp4", "203.0.113.9:9")
	if err != nil {
		return netip.Addr{}, false
	}
	defer func() { _ = conn.Close() }()
	local, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok || local == nil {
		return netip.Addr{}, false
	}
	addr, ok := netip.AddrFromSlice(local.IP)
	if !ok {
		return netip.Addr{}, false
	}
	addr = addr.Unmap()
	if addr.IsUnspecified() || addr.IsLoopback() {
		return netip.Addr{}, false
	}
	return addr, true
}

// Peer 报打洞最终落定的对方地址（没打通回空串）。
func (t *Tunnel) Peer() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.peerAddr
}

// LastError 报最后一次失败原因码。
func (t *Tunnel) LastError() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.lastErr
}

// Close 收掉隧道。重复调用是空操作。
func (t *Tunnel) Close() error {
	t.once.Do(func() {
		t.cancel()
		if t.forward != nil {
			t.forward.close()
		}
		// **先关 socket，再关设备**：分流器那条 goroutine 正阻塞在 `ReadFromUDPAddrPort` 上，
		// 不关 socket 它就一直不返回，而 `device.Close()` 要等它的接收协程退出 —— 反过来做
		// 就是一次卡到超时的收尾（表现为「点了关闭，界面转几秒」）。
		if t.conn != nil {
			_ = t.conn.Close()
		}
		if t.bind != nil {
			// 这里必须用 `shutdown()` 而不是 `Close()`：后者是给 WireGuard 内部
			// （`BindUpdate` 的 close→reopen）用的，故意做成可逆、不关队列。收尾时如果只调它，
			// 接收协程还阻塞在队列上，`device.Close()` 会一直等它 —— 表现就是「点了关闭没反应」。
			t.bind.shutdown()
		}
		if dev := t.getDevice(); dev != nil {
			dev.Close()
		}
		<-t.done
	})
	return nil
}

var (
	registryMu sync.Mutex
	nextHandle int64 = 1
	running          = map[int64]*Tunnel{}
)

// Start 拉起一条隧道，回一个句柄；失败时回 0 与错误码。
//
// 成功只代表**本机这半边准备好了**（回环端口已经在监听），不代表已经打通——打通是异步
// 的，由 Path() 报结论。这样 App 不必为了等打洞把界面卡住，也不必为「还在打」多一个状态。
func Start(opts Options) (int64, string) {
	private, err := parseKey(opts.PrivateKey)
	if err != nil {
		return 0, ErrKey
	}
	peerKey, err := parseKey(opts.PeerPublicKey)
	if err != nil {
		return 0, ErrKey
	}
	if opts.ListenPort < 1024 || opts.ListenPort > 65534 {
		return 0, ErrInvalid
	}
	// 电脑侧要往本机插件转，落点也必须是个合法端口（手机侧不填）。
	if opts.Mode == ModeAccept && (opts.TargetPort < 1024 || opts.TargetPort > 65534) {
		return 0, ErrInvalid
	}
	// 私网候选排前面：同一张网里那一跳往往直接就通，不必等公网打洞。
	peers := append(parseEndpoints(opts.PeerLocalCandidates), parseEndpoints(opts.PeerCandidates)...)
	// **没有候选也允许起**，这叫「只听不打」：电脑侧就是靠这个先把自己挂起来、把出口地址
	// 报出去，等手机拿着这份地址来打。手机一打过来，分流器从来源地址就学到了对方 —— WG
	// 本来就支持「先配好用对方的公钥、但没有初始 endpoint」，收到握手再定地址。
	// 早先这里要求必须有候选，于是电脑侧永远起不来、也永远报不出自己的地址，整条通道一次
	// 都连不上。
	// 给了 STUN 清单就用它（测试用空清单表示「别去问」）；没给（nil）才用默认那几家。
	// 空切片与非 nil 是两件事，这里刻意区分开。
	servers := opts.STUN
	if servers == nil {
		servers = STUNServers
	}

	ctx, cancel := context.WithCancel(context.Background())
	tunnel := &Tunnel{cancel: cancel, done: make(chan struct{}), stun: newStunWaiter(),
		wake: make(chan struct{}, 1), refresh: make(chan struct{}, 1)}

	socket, bind, localURL, err := assemble(ctx, private, peerKey, tunnel, servers, peers, opts)
	if err != nil {
		cancel()
		return 0, ErrStart
	}
	tunnel.conn = socket
	tunnel.bind = bind
	tunnel.LocalURL = localURL

	go func() {
		defer close(tunnel.done)
		<-ctx.Done()
		// 等一小会儿让打洞 / 保活那条协程看到 ctx 已经结束、自己退出去，再交还 done。
		// 不这样的话 Close() 会在它们还在往 socket 写的时候就把 socket 关掉（写已关的 fd
		// 不会崩，但日志里会多一串没意义的错误）。
		time.Sleep(50 * time.Millisecond)
	}()

	registryMu.Lock()
	handle := nextHandle
	nextHandle++
	running[handle] = tunnel
	registryMu.Unlock()
	return handle, ""
}

// Stop 按句柄收掉一条隧道，回 1 表示确实停了一条。
func Stop(handle int64) int {
	registryMu.Lock()
	tunnel, ok := running[handle]
	if ok {
		delete(running, handle)
	}
	registryMu.Unlock()
	if !ok {
		return 0
	}
	_ = tunnel.Close()
	return 1
}

// LocalURL 按句柄取本机地址（手机侧把它当普通 base URL 用）。
func LocalURL(handle int64) string {
	registryMu.Lock()
	tunnel, ok := running[handle]
	registryMu.Unlock()
	if !ok {
		return ""
	}
	return tunnel.LocalURL
}

// Path 按句柄报打通了没有。
func Path(handle int64) string {
	registryMu.Lock()
	tunnel, ok := running[handle]
	registryMu.Unlock()
	if !ok {
		return "unknown"
	}
	return tunnel.Path()
}

// Candidates 按句柄报「对端要往哪些地址打我」。前端拿到这份才能开始打洞。
func Candidates(handle int64) []string {
	registryMu.Lock()
	tunnel, ok := running[handle]
	registryMu.Unlock()
	if !ok {
		return nil
	}
	return tunnel.Candidates()
}

// Diagnose 报一条隧道的现场，形状是 JSON 字符串，供面板与守卫读。
func Diagnose(handle int64) string {
	registryMu.Lock()
	tunnel, ok := running[handle]
	registryMu.Unlock()
	if !ok {
		return `{"error":"` + ErrNoPeer + `"}`
	}
	tunnel.mu.Lock()
	attempts := tunnel.attempts
	tunnel.mu.Unlock()
	payload := map[string]any{
		"path":     tunnel.Path(),
		"peer":     tunnel.Peer(),
		"error":    tunnel.LastError(),
		"attempts": attempts,
		"candidates": tunnel.Candidates(),
		"candidateMaxAgeMs": stunLifetime.Milliseconds(),
		"healthMaxAgeMs": directLifetime.Milliseconds(),
		"mtu": tunnelMTU,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return `{"error":"` + ErrStart + `"}`
	}
	return string(raw)
}

// keepHoleAlive 定期往对方发一个探测包，保住 NAT 上那条映射。
//
// 不发的话，多数家用路由器空闲十几秒就把映射收走，隧道会在「看起来正常」的情况下
// 静默断掉，而且再也不会自己恢复。
func keepHoleAlive(ctx context.Context, socket *net.UDPConn, tunnel *Tunnel) {
	ticker := time.NewTicker(keepAlive)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tunnel.wake:
			return
		case <-ticker.C:
			if tunnel.Path() != "direct" {
				return
			}
			peer, err := netip.ParseAddrPort(tunnel.Peer())
			if err != nil {
				tunnel.loseDirect(ErrNoPeer)
				return
			}
			if _, err := socket.WriteToUDPAddrPort([]byte(livePayload), peer); err != nil {
				tunnel.loseDirect(ErrStart)
				return
			}
		}
	}
}

// noteHoleOpen 记下「收到了对端的探测包，洞开了，对方这个地址能回」。
//
// 洞开**不等于**通了：这里只更新可回包的地址，不置 `direct` —— `direct` 要等握手。
func (t *Tunnel) noteHoleOpen(from netip.AddrPort) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.holeOpen = true
	t.peerAddr = from.String()
}

// confirmDirect 是数据面真的通了之后才调用的一步。
func (t *Tunnel) confirmDirect() {
	t.mu.Lock()
	changed := t.path != "direct"
	t.path = "direct"
	t.holeOpen = true
	t.lastErr = ""
	t.dialPending = false
	t.listenOnly = false
	t.mu.Unlock()
	if changed {
		select {
		case t.wake <- struct{}{}:
		default:
		}
	}
}

// startAttempt 标记「新的一轮打洞开始了」。
//
// **故意不清 `path`**：上一轮已经如实报过 failed，重试期间对外继续报 failed —— 界面与
// 插件的账都按「打不通」记着，等真的握上手再由 confirmDirect 改口成 direct。中途把
// failed 抹回 punching 会让同一个事实在界面上来回跳。第一次开始时 path 本来是空的，
// 不受影响。
func (t *Tunnel) startAttempt() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.holeOpen = false
	t.dialPending = true
	t.attempts++
}

// holeOpen 报「这一轮有没有收到过对方的探测包」。
func (t *Tunnel) hasHole() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.holeOpen
}

// setFailure 如实记下这一轮的失败码（打不通就是打不通，绝不改口说通了）。
func (t *Tunnel) setFailure(code string) {
	t.mu.Lock()
	t.path = "failed"
	t.lastErr = code
	t.dialPending = false
	t.mu.Unlock()
	t.requestRefresh()
}

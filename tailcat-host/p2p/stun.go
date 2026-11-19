// 极简 STUN 客户端：只做一件事，问「我从外面看是什么地址」。
//
// 为什么要它：手机与电脑要直接对话，必须先知道自己穿过多层 NAT 之后在公网上是哪个
// IP:端口，对方也只能往这个地址打洞。这一步用现成的公共 STUN 服务器就够，不需要我们
// 自己架任何东西 —— 这与「用户没有服务器、我们也不提供服务器」是同一件事：STUN 只是
// 被问一句「我长什么样」，它不承载任何业务数据。
//
// 服务器清单里先放国内可达的几家：境外 STUN 在国内经常整段不通，而这一步不通，后面的
// 打洞就没有起点。
//
// **节奏与所有权**（2026-11 收紧）：打洞用的那块 socket 只有一个读者 —— `device.go` 的
// 分流器（多一个人读就会把包读散，还会把 STUN 回包当成数据塞给 WireGuard）。所以 STUN
// 不自己去读那块 socket，而是在 `stunWaiter` 上登记「这几个来源地址的回包归我」，分流器
// 见到就转进来。问的时候**一次问遍全清单**、谁先答就用谁，总时长一个预算封顶 —— 早先
// 是五家串行、每家三秒，最坏十几秒，而手机侧这条调用是同步阻塞的（`P2PModule.kt` 标了
// `isBlockingSynchronousMethod`），卡住就是卡界面。

package p2p

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"sync"
	"time"
)

const (
	stunHeaderLen = 20
	// STUN 魔数（RFC 5389 §6）：固定值，跟事务 ID 一起用来解 XOR-MAPPED-ADDRESS。
	stunMagic   = 0x2112A442 // RFC 5389 magic cookie
	stunBinding = 0x0001
	stunSuccess = 0x0101
	attrMapped  = 0x0001
	attrXor     = 0x0020
	// stunBudget 是一次「我外面长什么样」的**总**预算。并发问、第一个答出来就收工，
	// 所以这个数就是最坏情况，不再是「每家三秒 × 家数」。
	stunBudget = 2 * time.Second
)

// STUNServers 是默认探测清单：先国内、后兜底。
//
// 只用来问出口地址，一问几十字节。多问几家是为了「某一家不通时还能有结论」，不是要
// 冗余——真正决定连通性的是打洞本身。
var STUNServers = []string{
	"stun.miwifi.com:3478",
	"stun.chat.bilibili.com:3478",
	"stun.hitv.com:3478",
	"stun.l.google.com:19302",
	"stun.cloudflare.com:3478",
}

var errStunTimeout = errors.New("stun-timeout")

// stunWaiter 是「这块 socket 上 STUN 回包归谁」的登记处。
//
// 分流器是唯一的读者，它拿不准的包先来这里问一句：是我在等的那几家的回包就转进去，
// 否则照原样交给 WireGuard。查询期间登记、结束就撤，不查询时这个登记处是空的透传。
//
// `queryMu` 让同一时刻只有一次查询：首次探测与周期刷新会撞，两次查询共用一个收件箱
// 会把答案交换掉。`mu` 只护登记表本身，分流器每次读包都要拿它，所以里面不许做慢事。
type stunWaiter struct {
	queryMu sync.Mutex
	mu      sync.Mutex
	pending map[netip.AddrPort]bool
	inbox   chan []byte
}

func newStunWaiter() *stunWaiter {
	return &stunWaiter{pending: map[netip.AddrPort]bool{}}
}

// open 登记这次查询关心的来源地址，回一个收件箱。调用方必须 HOLD 住 queryMu。
func (w *stunWaiter) open(targets []*net.UDPAddr) chan []byte {
	inbox := make(chan []byte, 4)
	w.mu.Lock()
	defer w.mu.Unlock()
	w.pending = make(map[netip.AddrPort]bool, len(targets))
	for _, target := range targets {
		addr, ok := netip.AddrFromSlice(target.IP)
		if !ok {
			continue
		}
		w.pending[netip.AddrPortFrom(addr.Unmap(), uint16(target.Port))] = true
	}
	w.inbox = inbox
	return inbox
}

// close 撤掉登记（收件箱关掉之后迟到的回包一律当普通数据）。
func (w *stunWaiter) close(inbox chan []byte) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.inbox == inbox {
		w.inbox = nil
		w.pending = map[netip.AddrPort]bool{}
	}
}

// offer 由分流器调用：这个来源是 STUN 查询在等的那一家吗？
//
// 只有真的登记着、且收件箱还有空位时才收下；收下了就回 true，分流器不再把它当数据。
func (w *stunWaiter) offer(from netip.AddrPort, data []byte) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.inbox == nil || !w.pending[from] {
		return false
	}
	select {
	case w.inbox <- append([]byte(nil), data...):
		return true
	default:
		// 收件箱满了（同一家回了好几条）：丢掉这一条，查询还在等第一条能解开的。
		return true
	}
}

// discoverSelf 问一次「我从外面看是什么地址」：一次问遍清单，谁先答就用谁。
//
// **必须用同一个 socket、而不是新开一个**：NAT 上的映射是**按本地端口**分的，换端口去问
// 得到的地址与真正要用来打洞的那个端口对不上，打洞必然失败。
//
// waiter 非 nil 时走「分流器转交」那条路（隧道里就是这条）；为 nil 时自己读这块 socket
// （测试里那条独立 socket，它没有分流器）。
//
// 问不到不是致命错误：对方也可能主动打过来（一端 Full Cone 时成立），所以调用方继续走。
func discoverSelf(conn *net.UDPConn, servers []string, waiter *stunWaiter) (netip.AddrPort, error) {
	targets := make([]*net.UDPAddr, 0, len(servers))
	for _, server := range servers {
		if addr, err := net.ResolveUDPAddr("udp", server); err == nil && addr != nil {
			targets = append(targets, addr)
		}
	}
	if len(targets) == 0 {
		return netip.AddrPort{}, errStunTimeout
	}
	req := make([]byte, stunHeaderLen)
	binary.BigEndian.PutUint16(req[0:], stunBinding)
	binary.BigEndian.PutUint32(req[4:], stunMagic)
	if _, err := rand.Read(req[8:20]); err != nil {
		return netip.AddrPort{}, err
	}

	if waiter != nil {
		// **先登记再发**：回包几乎立刻就到，先发后登记会把最早的答案漏在门外。
		// 整段查询都握着 queryMu：两次查询共用一个收件箱，第二个一开就把第一个的答案
		// 收走了，第一个只能等到超时。
		waiter.queryMu.Lock()
		defer waiter.queryMu.Unlock()
		inbox := waiter.open(targets)
		defer waiter.close(inbox)
		for _, target := range targets {
			if _, err := conn.WriteToUDP(req, target); err != nil {
				continue
			}
		}
		budget := time.NewTimer(stunBudget)
		defer budget.Stop()
		for {
			select {
			case <-budget.C:
				return netip.AddrPort{}, errStunTimeout
			case packet := <-inbox:
				if mapped, err := parseStunResponse(packet); err == nil {
					return mapped, nil
				}
			}
		}
	}

	// 没有分流器的那条路：自己读，并且**收尾时必须把读超时清掉** —— 这块 socket 之后
	// 要交给 WireGuard 的分流器长期收包，留着 STUN 那几秒的 deadline，它第一次读就会
	// 立刻报超时，打洞看着在跑、实际一个包都收不到。
	defer func() { _ = conn.SetReadDeadline(time.Time{}) }()
	for _, target := range targets {
		if _, err := conn.WriteToUDP(req, target); err != nil {
			continue
		}
	}
	deadline := time.Now().Add(stunBudget)
	buf := make([]byte, 1500)
	for {
		if err := conn.SetReadDeadline(deadline); err != nil {
			return netip.AddrPort{}, err
		}
		n, from, err := conn.ReadFromUDP(buf)
		if err != nil {
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				return netip.AddrPort{}, errStunTimeout
			}
			return netip.AddrPort{}, err
		}
		// 打洞期间同一个 socket 上可能同时收到对方的包，按来源筛掉再解。
		if !knownStunSource(from, targets) {
			continue
		}
		if mapped, err := parseStunResponse(buf[:n]); err == nil {
			return mapped, nil
		}
	}
}

// knownStunSource 判断这一发是不是清单里某一家发来的。
func knownStunSource(from *net.UDPAddr, targets []*net.UDPAddr) bool {
	for _, target := range targets {
		if sameHostPort(from, target) {
			return true
		}
	}
	return false
}

func sameHostPort(a, b *net.UDPAddr) bool {
	return a != nil && b != nil && a.Port == b.Port && a.IP.Equal(b.IP)
}

// parseStunResponse 解一条 Binding Success Response，取映射地址。
//
// 优先 XOR-MAPPED-ADDRESS：老式 MAPPED-ADDRESS 在不少 NAT 上会被改写成内网地址，
// 拿那个值去打洞等于往自己家里打。
func parseStunResponse(packet []byte) (netip.AddrPort, error) {
	if len(packet) < stunHeaderLen {
		return netip.AddrPort{}, errors.New("stun-short")
	}
	if binary.BigEndian.Uint16(packet[0:]) != stunSuccess {
		return netip.AddrPort{}, errors.New("stun-not-success")
	}
	length := int(binary.BigEndian.Uint16(packet[2:]))
	if stunHeaderLen+length > len(packet) {
		length = len(packet) - stunHeaderLen
	}
	cookie := binary.BigEndian.Uint32(packet[4:])
	var fallback netip.AddrPort
	for offset := stunHeaderLen; offset+4 <= stunHeaderLen+length; {
		kind := binary.BigEndian.Uint16(packet[offset:])
		size := int(binary.BigEndian.Uint16(packet[offset+2:]))
		if offset+4+size > len(packet) {
			break
		}
		value := packet[offset+4 : offset+4+size]
		switch kind {
		case attrXor:
			if addr, ok := decodeMapped(value, cookie, true); ok {
				return addr, nil
			}
		case attrMapped:
			if addr, ok := decodeMapped(value, cookie, false); ok {
				fallback = addr
			}
		}
		offset += 4 + size + ((4 - size%4) % 4)
	}
	if fallback.IsValid() {
		return fallback, nil
	}
	return netip.AddrPort{}, errors.New("stun-no-mapped")
}

func decodeMapped(value []byte, cookie uint32, xor bool) (netip.AddrPort, bool) {
	if len(value) < 4 {
		return netip.AddrPort{}, false
	}
	family := value[1]
	port := binary.BigEndian.Uint16(value[2:4])
	if xor {
		port ^= uint16(cookie >> 16)
	}
	var raw []byte
	switch family {
	case 0x01:
		if len(value) < 8 {
			return netip.AddrPort{}, false
		}
		raw = append([]byte(nil), value[4:8]...)
		if xor {
			var mask [4]byte
			binary.BigEndian.PutUint32(mask[:], cookie)
			for i := range raw {
				raw[i] ^= mask[i]
			}
		}
	case 0x02:
		if len(value) < 20 {
			return netip.AddrPort{}, false
		}
		raw = append([]byte(nil), value[4:20]...)
		if xor {
			var mask [16]byte
			binary.BigEndian.PutUint32(mask[0:4], cookie)
			for i := range raw {
				raw[i] ^= mask[i]
			}
		}
	default:
		return netip.AddrPort{}, false
	}
	addr, ok := netip.AddrFromSlice(raw)
	if !ok {
		return netip.AddrPort{}, false
	}
	return netip.AddrPortFrom(addr.Unmap(), port), true
}

// formatEndpoints 把候选地址拼成 `ip:port` 字样，供 IPC 与接口传输。
func formatEndpoints(addrs []netip.AddrPort) []string {
	out := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		if addr.IsValid() {
			out = append(out, addr.String())
		}
	}
	return out
}

// parseEndpoints 解一组 `ip:port`，跳过解不出来的那些——对端给的一律当不可信数据。
func parseEndpoints(list []string) []netip.AddrPort {
	out := make([]netip.AddrPort, 0, len(list))
	for _, text := range list {
		addr, err := netip.ParseAddrPort(text)
		if err != nil || !addr.IsValid() || addr.Port() == 0 {
			continue
		}
		out = append(out, addr)
	}
	return out
}

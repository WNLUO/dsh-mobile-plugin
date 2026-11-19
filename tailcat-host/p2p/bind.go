// 一个把「打洞那块 socket 收到的包」交给 WireGuard 的传输层。
//
// 为什么自己写而不直接用 wireguard-go 自带的 bind：打洞用的是某一个特定的本地端口，
// NAT 上的洞是**按那个端口**开的。WireGuard 要是自己再开一个 socket，出去的包换了源
// 端口，洞立刻就不认了 —— 表现是「打洞测通了、真数据一个字节都不动」。所以复用同一块 socket。
//
// 但 socket 只能有一个读者（两个 goroutine 同时 ReadFrom 会把包读散），所以真正读 socket 的
// 是 `device.go` 里的分流器。这个 bind 因此是一个**内存队列**，不是 socket 的持有者。
//
// 队列用自己的一把条件变量，不用 channel：WireGuard 的接收协程在收尾时必须能被叫醒退出，
// 而 channel 那套要么空转（回 0 让它立刻再来问，白烧 CPU）、要么纯阻塞（收尾时叫不醒它、
// `device.Close()` 就永远等下去）。条件变量两个毛病都没有。

package p2p

import (
	"errors"
	"net"
	"net/netip"
	"sync"

	"golang.zx2c4.com/wireguard/conn"
)

// endpoint 是 WireGuard 眼中的「对端地址」：只有 UDP 的 ip:port 一种形态。
//
// 这条通道不支持多播 / 域名 / 多路径，也不打算支持 —— 多一种形态就多一处能对不上。
type endpoint struct {
	addr netip.AddrPort
}

func (e *endpoint) ClearSrc() {}

func (e *endpoint) SrcToString() string { return "" }

func (e *endpoint) DstToString() string { return e.addr.String() }

// DstToBytes 给 WireGuard 的 cookie 校验用，必须是稳定的字节表示。
func (e *endpoint) DstToBytes() []byte {
	raw, _ := e.addr.MarshalBinary()
	return raw
}

func (e *endpoint) DstIP() netip.Addr { return e.addr.Addr() }

func (e *endpoint) SrcIP() netip.Addr { return netip.Addr{} }

var errBindClosed = errors.New("p2p-bind-closed")

// packet 是从分流器交过来的一发数据。
type packet struct {
	data []byte
	addr netip.AddrPort
}

// punchedBind 把分流器收到的包喂给 WireGuard。
//
// **按「代」管开合**：WireGuard 会先 `Close()` 再 `Open()`（`BindUpdate` 那一步），
// 收尾时又靠 `Close()` 叫醒接收协程退出。于是 Close 不能是「永久作废」，也不能是空操作 ——
// 前一种 BindUpdate 之后再也开不起来，后一种收尾时接收协程永远不退出、`device.Close()` 一直等。
// 所以每代一个 generation：Open 开新代，Close 只结束**当前**这代。
type punchedBind struct {
	mu     sync.Mutex
	cond   *sync.Cond
	closed bool // 隧道级的收尾（shutdown），此后不再接受任何包
	gen    int  // 当前代；每 Open 一次加一
	queue  []packet
	// write 由分流器注入：真正往那块 socket 写包的动作归它管，这里只是借用。
	write func([]byte, netip.AddrPort) error
}

// queueLimit 是队列上限。
//
// 有界：WireGuard 跟不上时宁可丢包（它自己会重传），也不能把内存堆满。
const queueLimit = 256

func newPunchedBind() *punchedBind {
	bind := &punchedBind{}
	bind.cond = sync.NewCond(&bind.mu)
	return bind
}

// Open 只交一个接收函数：socket 不归这里管，所以端口由分流器那边报（回 0）。
func (b *punchedBind) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil, 0, errBindClosed
	}
	b.gen++
	gen := b.gen
	b.mu.Unlock()
	return []conn.ReceiveFunc{func(packets [][]byte, sizes []int, eps []conn.Endpoint) (int, error) {
		return b.receive(gen, packets, sizes, eps)
	}}, 0, nil
}

// receive 交出一发包；队列空时**挂在条件变量上等**，不是空转。
//
// `gen` 是它被 Open 那一刻的代：代一变（Close 过、或者又重新 Open 了）就该退出 ——
// 上一代那条接收协程继续留着只会跟新一代抢同一个队列。
func (b *punchedBind) receive(gen int, packets [][]byte, sizes []int, eps []conn.Endpoint) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for len(b.queue) == 0 && !b.closed && b.gen == gen {
		b.cond.Wait()
	}
	if b.closed || b.gen != gen {
		return 0, net.ErrClosed
	}
	pkt := b.queue[0]
	b.queue = b.queue[1:]
	n := copy(packets[0], pkt.data)
	sizes[0] = n
	if len(eps) > 0 {
		eps[0] = &endpoint{addr: pkt.addr}
	}
	return 1, nil
}

// deliver 由分流器调用，把一发非探测包交给 WireGuard。
//
// 投递与「关没关」在同一把锁里判断，才不会出现「刚判完没关、正要入队就被关掉」。
func (b *punchedBind) deliver(data []byte, addr netip.AddrPort) {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return
	}
	if len(b.queue) >= queueLimit {
		// 满了就丢这一发：WireGuard 的上层会重传，而阻塞会把分流器一起拖住。
		b.mu.Unlock()
		return
	}
	b.queue = append(b.queue, packet{data: append([]byte(nil), data...), addr: addr})
	b.cond.Signal()
	b.mu.Unlock()
}

// Send 把一批包发给同一个对端（真正的写由注入的 write 完成）。
func (b *punchedBind) Send(bufs [][]byte, ep conn.Endpoint) error {
	target, ok := ep.(*endpoint)
	if !ok || !target.addr.IsValid() {
		return conn.ErrWrongEndpointType
	}
	b.mu.Lock()
	write := b.write
	closed := b.closed
	b.mu.Unlock()
	if closed || write == nil {
		return net.ErrClosed
	}
	for _, buf := range bufs {
		if err := write(buf, target.addr); err != nil {
			return err
		}
	}
	return nil
}

func (b *punchedBind) ParseEndpoint(text string) (conn.Endpoint, error) {
	addr, err := netip.ParseAddrPort(text)
	if err != nil || !addr.IsValid() {
		return nil, errors.New(ErrInvalid)
	}
	return &endpoint{addr: addr}, nil
}

func (b *punchedBind) BatchSize() int { return 1 }

func (b *punchedBind) SetMark(mark uint32) error { return nil }

// Close 是给 WireGuard 内部用的（`BindUpdate()` 那一步会先 Close 再 Open），**必须可逆**。
//
// 做成「关掉队列、再也不许开」的话，设备从 down 转 up 那一刻 bind 就被自己关掉，接着的
// Open 直接报 closed，整条隧道永远起不来（现场表现是 `start-failed`，日志里只有一句
// `failed to set listen_port: p2p-bind-closed`）。真正的收尾走 `shutdown()`。
func (b *punchedBind) Close() error {
	b.mu.Lock()
	// 只结束**当前**这一代：把 gen 推上去，正在等的那条接收协程就会看到「我不是这一代了」
	// 并返回错误退出；而下次 Open 又会开一代新的，`BindUpdate` 因此仍然能重开。
	b.gen++
	b.mu.Unlock()
	b.cond.Broadcast()
	return nil
}

// shutdown 是隧道自己的收尾：关队列、叫醒所有等在接收上的协程。
func (b *punchedBind) shutdown() {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return
	}
	b.closed = true
	b.queue = nil
	b.mu.Unlock()
	// Broadcast 而非 Signal：收尾时可能不止一条接收协程在等，少叫一条就少一个人退出。
	b.cond.Broadcast()
}

// attachWriter 把「真的往 socket 写」这一步交进来。
func (b *punchedBind) attachWriter(write func([]byte, netip.AddrPort) error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.write = write
}

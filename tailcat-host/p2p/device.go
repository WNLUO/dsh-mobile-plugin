// 装配 UDP、WireGuard 与回环转发；拨号监听和连接随所属隧道一起关闭。
//
// 关键在于**只有一块 socket、一个读者**。NAT 上的洞是按本地端口开的，WireGuard 要是
// 自己再开一个 socket，出去的包换了源端口，洞立刻就不认了 —— 表现就是「打洞测通了、
// 真数据一个字节都不动」。所以这里只有一个 UDP socket，上面挂一个分流器：
//
//   - 探测包（hole / keepalive）→ 在这里吃掉，顺带确认洞开了、对方从哪个地址来；
//   - 其余所有包 → 交给 WireGuard（握手、数据、重传）。
//
// 手机侧与电脑侧跑的是同一份代码，区别只有谁主动拨（手机）谁等着被拨（电脑）。
//
// 2026-11 这一版补了三处：**打洞按退避重试有限几轮**（一轮没成如实报 failed，但不是
// 永久放弃）、**`direct` 要握手凭据**（收到探测包只说明洞开了，`latest_handshake_time`
// 才说明数据面真的通）、**STUN 的包从分流器转进来**并在隧道活着时周期刷新（网络切换后
// 出口地址会变，问一次就再也不问等于拿旧地址去打洞）。
//
// **socket 是双栈的**：一块 `[::]` 端口同时收发 IPv4 与 IPv6。IPv6 没有 NAT，本机地址就是
// 对方能直接到达的地址 —— 这是穿过对称 NAT / 双 NAT 唯一一条干净的路（那条路上 IPv4 打洞
// 怎么打都打不通）。一个必须记住的细节：v4 的包在双栈 socket 上会以 `::ffff:a.b.c.d` 这种
// 映射地址回来，**用之前一律先 Unmap**，否则它跟候选里的纯 v4 地址永远不相等。

package p2p

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"sync"
	"time"

	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

// 隧道里的两个地址。两端各自独立的虚拟网卡，不存在冲突，所以可以共用同一对。
//
// 手机侧（dial）占 .2、电脑侧（accept）占 .1；对端地址就是对方那个。
const (
	dialAddr   = "10.99.0.2"
	acceptAddr = "10.99.0.1"
)

// listenTunnelSocket 开一块**双栈** UDP socket（绑 `[::]`，IPv6 与 IPv4 同一个口）。
//
// 双栈不能起时（内核关掉 IPv6、或 system 不认 `::`）退化成纯 IPv4：这条通道必须在不支持
// IPv6 的机器上照常能跑，IPv6 是加分项、不是前提。退化时 IPv6 候选自然一条都没有。
func listenTunnelSocket() (*net.UDPConn, error) {
	if socket, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv6unspecified, Port: 0}); err == nil {
		return socket, nil
	}
	return net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: 0})
}

// normalizeFrom 把双栈 socket 上收到的来源地址还原成「干净的」形态。
//
// v4 的包在 `[::]` 这类 IPv6 socket 上以 `::ffff:a.b.c.d`（IPv4-mapped IPv6）回来；
// 而候选、endpoint、比较全用纯 v4 地址 —— 不还原的话，`::ffff:192.168.1.1` 与
// `192.168.1.1` 永远不相等，打洞「收到了却认不到」、STUN 回包也筛不出来。
func normalizeFrom(from netip.AddrPort) netip.AddrPort {
	return netip.AddrPortFrom(from.Addr().Unmap(), from.Port())
}

// assemble 装好一条隧道，回本机那个地址。
// 设备自己登记进隧道（见 setDevice），不从这里回出去：收尾走隧道那一份，避免两笔账。
func assemble(ctx context.Context, private, peerKey []byte, tunnel *Tunnel, servers []string, peers []netip.AddrPort, opts Options) (*net.UDPConn, *punchedBind, string, error) {
	// **双栈**：绑 `[::]` 一块口同时收 IPv4 与 IPv6。IPv6 那一半没有 NAT，本机地址就是
	// 对方能直接到达的地址 —— 这正是双/对称 NAT 打不通时的那条出路。IPv4 那一半照旧走
	// 打洞 + STUN。退化成纯 IPv4 的机器上也能起（见 listenTunnelSocket）。
	socket, err := listenTunnelSocket()
	if err != nil {
		return nil, nil, "", fmt.Errorf("socket: %w", err)
	}

	// 把自己这块 socket 的端口记下来：NAT 上有端口映射时 STUN 报的是公网那一份；同一张
	// 网里直连时用的是本地那份。两条都留给对端当候选。这一步只读 socket 属性，不抢读包。
	if local, ok := socket.LocalAddr().(*net.UDPAddr); ok && local != nil {
		tunnel.setLocalPort(local.Port)
	}

	localTun, peerTun := dialAddr, acceptAddr
	if opts.Mode == ModeAccept {
		localTun, peerTun = acceptAddr, dialAddr
	}

	tunDevice, netStack, err := netstack.CreateNetTUN(
		[]netip.Addr{netip.MustParseAddr(localTun)}, nil, tunnelMTU,
	)
	if err != nil {
		_ = socket.Close()
		return nil, nil, "", err
	}

	bind := newPunchedBind()
	bind.attachWriter(func(data []byte, to netip.AddrPort) error {
		_, err := socket.WriteToUDPAddrPort(data, to)
		return err
	})

	logger := device.NewLogger(device.LogLevelError, "p2p: ")
	dev := device.NewDevice(tunDevice, bind, logger)
	// **立刻登记**：握手观察协程下面就要起来，它每次都要读这台设备的配置回执。
	tunnel.setDevice(dev)

	// 分流器要先起来：它是这块 socket 唯一的读者，也是唯一能把包交给 WireGuard 的人。
	// 反过来的话（先 configure）`IpcSet` 里那一步 rebind 会把设备拉起来、接收协程随即
	// 挂在这个队列上等包，而此刻还没有任何人从 socket 往队列里投递 —— 两边互相等，
	// 初始化当场卡死（现场就是「起了半天起不来」）。
	go demux(socket, bind, dev, peerKey, tunnel)

	// 问自己的出口地址。**必须在分流器起来之后**：分流器是这块 socket 唯一的读者，STUN
	// 的回包要它转交（见 `stunWaiter`）。这也正是本项目的铁律 —— 不能有第二个读者。
	//
	// 问不到不算错（对方也可能主动打过来），但总时长要封住：手机侧这条调用是同步阻塞的
	// （`P2PModule.kt` 标了 `isBlockingSynchronousMethod`），几秒钟卡在那里就是卡界面。
	// 现在一次问遍清单、第一个答出来就收工，最坏也就是一个 stunBudget。
	//
	// **结果必须留下**：这就是「我这边从外面看长什么样」，对端要拿它来打洞。早先这里
	// 直接丢掉了返回值，于是两端永远互报空候选、谁也打不到谁 —— 那条通道一次都通不了。
	if len(servers) > 0 {
		if mapped, err := discoverSelf(socket, servers, tunnel.stun); err == nil {
			tunnel.setLocalEndpoint(mapped)
		}
	}

	// WireGuard 一开始指的必须是候选里第一条，否则它连第一个握手包都不知道往哪发；
	// 洞一开，分流器会把 endpoint 改成对方真实的来源地址。
	// 有候选就配 endpoint（我们主动打）；没有就只配公钥与 allowed_ip，等对方打过来 ——
	// WireGuard 收到握手 initiation 会自己把 endpoint 定下来，这条是「只听不打」那半边。
	var initial netip.AddrPort
	if len(peers) > 0 {
		initial = peers[0]
	}
	if err := configureDevice(dev, private, peerKey, initial, peerTun); err != nil {
		bind.shutdown()
		dev.Close()
		_ = socket.Close()
		return nil, nil, "", fmt.Errorf("configure: %w", err)
	}

	// 打洞单独跑，不挡住「回环端口先给出去」这件事。**必须挂在隧道自己的 ctx 上**：
	// 用 Background 的话，隧道停了打洞协程还在往旧地址发包、保活也继续发 —— 用户看到的是
	// 「这条通道已经关了，网卡却还在活动」。
	//
	// 没有候选就不打（「只听不打」）：分流器照样收包，收到对方的打洞包就学到了地址并回过去。
	// 「洞开了之后数据面通没通」两边都要判：主动打的这半边由 punch 等握手，只听不打
	// 的那半边没人等它 —— 没有一个共同的观察者，手机打过来、握手成功，电脑这边也永远
	// 停在 `waiting`。所以握手凭据统一由这一条协程置上，与谁先起谁后起无关。
	go watchHandshake(ctx, tunnel)
	// 出口地址要周期刷新（网络切换后 NAT 映射会变），与打洞成没成无关。
	go refreshSelf(ctx, socket, tunnel, servers)

	if len(peers) > 0 {
		// 有对端候选：这半边在主动打洞。`Path()` 据此报 `punching` 而不是 `waiting`。
		tunnel.markDialing()
		go punch(ctx, socket, peers, tunnel)
	} else {
		// 没有对端候选：只监听，等对端来打（「只听不打」）。
		//
		// **必须显式标一下**：这种情况下既不会收到自己的探测包、也不会走到打洞超时，
		// `path` 会一直空着。不标的话 `Path()` 只能报 `unknown`，界面就一直显示
		// 「正在打洞」—— 而它其实只是在等人来。
		tunnel.markListenOnly()
	}

	var localURL string
	if opts.Mode == ModeAccept {
		// 在隧道里听 ListenPort，进来什么就转给本机插件的 TargetPort —— 两个端口各司其职。
		localURL, err = acceptLoop(netStack, opts.ListenPort, opts.TargetPort, localTun)
	} else {
		// 手机侧：把对端（电脑）隧道里那个 ListenPort 拨通。
		localURL, tunnel.forward, err = dialLoop(ctx, netStack, netip.AddrPortFrom(netip.MustParseAddr(peerTun), uint16(opts.ListenPort)))
	}
	if err != nil {
		dev.Close()
		_ = socket.Close()
		return nil, nil, "", err
	}
	return socket, bind, localURL, nil
}

// configureDevice 把这一对密钥与对端地址交给 WireGuard。
//
// 用 IpcSet 而不是逐字段设：它的语法稳定、也一眼看得出隧道里允许什么 ——
// 只放对端那一个 /32，不整段放行。
func configureDevice(dev *device.Device, private, peerKey []byte, target netip.AddrPort, peerTun string) error {
	// endpoint 那一行按需加：没有就省略，WireGuard 会接受来自这个公钥的任一来源地址，
	// 并把第一次握手包的来源记成对方的 endpoint（这就是「只听不打」能成立的原因）。
	endpointLine := ""
	if target.IsValid() {
		endpointLine = "endpoint=" + target.String() + "\n"
	}
	config := fmt.Sprintf(
		"private_key=%s\nlisten_port=0\nreplace_peers=true\npublic_key=%s\n%sallowed_ip=%s/32\npersistent_keepalive_interval=25\n",
		hex.EncodeToString(private),
		hex.EncodeToString(peerKey),
		endpointLine,
		peerTun,
	)
	return dev.IpcSet(config)
}

// updateEndpoint 把对端地址改成刚打通的那个。
//
// 为什么要重设：一开始配的是候选里第一条，而真正能通的往往是另一条（比如私网那条试完
// 才轮到公网）。洞开之后我们知道对方究竟从哪个地址来，必须当场改过去，否则 WireGuard
// 会继续往那个打不通的地址重试握手，表现是「洞开着、却一直握不上手」。
func updateEndpoint(dev *device.Device, peerKey []byte, addr netip.AddrPort) {
	config := fmt.Sprintf(
		"public_key=%s\nupdate_only=true\nendpoint=%s\n",
		hex.EncodeToString(peerKey),
		addr.String(),
	)
	_ = dev.IpcSet(config)
}

// demux 是那块 socket 唯一的读者：探测包吃掉，其余交给 WireGuard。
func demux(socket *net.UDPConn, bind *punchedBind, dev *device.Device, peerKey []byte, tunnel *Tunnel) {
	buf := make([]byte, 2048)
	learned := ""
	for {
		n, from, err := socket.ReadFromUDPAddrPort(buf)
		if err != nil {
			// 超时不算坏：这条 socket 上任何一处（STUN、打洞）都可能临时设过 deadline，
			// 清掉继续收就是。只有真被关掉（收尾）才该退出。
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				continue
			}
			bind.shutdown()
			return
		}
		if n == 0 || !from.IsValid() {
			continue
		}
		// **先还原映射地址**：双栈 socket 上 v4 包以 `::ffff:a.b.c.d` 回来，后面所有比较
		// 与 endpoint 都用纯地址，不还原就永远对不上（STUN 筛不出、探测包认不到）。
		from = normalizeFrom(from)
		// STUN 的回包先问一句是不是查询在等的那一家：是就转交（它不能进 WireGuard，
		// 那是一条没被任何密钥认过的报文），不是再往下走。
		if tunnel.stun.offer(from, buf[:n]) {
			continue
		}
		switch text := string(buf[:n]); text {
		case holePayload, livePayload:
			// 洞开了：先把握手的目标地址改过去，然后**只记下洞开了** —— `direct` 得等
			// 握手凭据（见 Tunnel.Path）。探测包只证明双方能互相发 UDP，与密钥无关。
			if learned != from.String() {
				learned = from.String()
				updateEndpoint(dev, peerKey, from)
			}
			tunnel.noteHoleOpen(from)
			continue
		}
		bind.deliver(buf[:n], from)
	}
}

// hole 打一轮：往对方所有候选同时打、同时等；谁先回来就认那一条。
//
// 两端都在打，所以只要有一边的 NAT 允许「先出包、反向就能进来」（端点无关映射，即
// Full Cone / Restricted Cone / Port Restricted Cone），洞就会开；只有两端都是对称
// NAT 时才真的无解，那时如实报 nat-blocked。
//
// 一轮的结论只有两种：洞开了（还等握手）或者超时。
func hole(ctx context.Context, socket *net.UDPConn, peers []netip.AddrPort, tunnel *Tunnel) {
	deadline := time.Now().Add(holeRoundTimeout)
	stop := make(chan struct{})
	var wg sync.WaitGroup

	for _, peer := range peers {
		wg.Add(1)
		go func(target netip.AddrPort) {
			defer wg.Done()
			ticker := time.NewTicker(holeInterval)
			defer ticker.Stop()
			for {
				select {
				case <-stop:
					return
				case <-ctx.Done():
					return
				case <-ticker.C:
					if time.Now().After(deadline) {
						return
					}
					_, _ = socket.WriteToUDPAddrPort([]byte(holePayload), target)
				}
			}
		}(peer)
	}

	// 等这一轮的结论：分流器收到对方的探测包就会标上「洞开了」。
	for time.Now().Before(deadline) && ctx.Err() == nil {
		if tunnel.hasHole() {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	close(stop)
	wg.Wait()
}

// punch 是整条隧道级别的打洞：按退避打有限几轮，每一轮的结果如实上报。
//
// 一轮没成**不是永久放弃**：网络刚切换、NAT 映射刚被回收这两种情况，下一轮往往就能通；
// 早先八秒没成就把它钉成 failed，于是「刚才还在家里、现在到了外面」这种再普通不过的
// 场景，这条通道要等到下次重开才肯再试一次。
//
// 同时别把它做成密集重试：**第一次失败就退避**，而且轮数有上限 —— 打不通的 NAT 组合
// 打一百轮也打不通。
//
// 洞开了之后还要等数据面：`direct` 由 WireGuard 的握手凭据置上。等握手超时的话如实报
// failed（`handshake-failed`，与 `nat-blocked` 分开 —— 前者多半是两端公钥配错了），
// 绝不因为「收到过探测包」就说通了。
func punch(ctx context.Context, socket *net.UDPConn, peers []netip.AddrPort, tunnel *Tunnel) {
	for attempt := 1; attempt <= holeAttempts; attempt++ {
		if ctx.Err() != nil {
			return
		}
		// 退避期间对方可能自己打过来了（握手已落定）：那就别再往旧地址白打一轮。
		if tunnel.Path() == "direct" {
			keepHoleAlive(ctx, socket, tunnel)
			return
		}
		tunnel.startAttempt()
		hole(ctx, socket, peers, tunnel)
		if ctx.Err() != nil {
			return
		}
		if tunnel.hasHole() {
			// 洞开了：等数据面拿到凭据。这里等不到就如实报失败，不冒充已连通 ——
			// 然后按同一套退避再打一轮：洞开着而握手没成，多半是这一发的包丢了。
			if waitHandshake(ctx, tunnel) {
				keepHoleAlive(ctx, socket, tunnel)
				return
			}
			// 走到这里说明洞开了但握不上手：这一轮同样是「没通」，如实标出来。
			//
			// **不排掉共享凭据那条分支**：如果握手其实成了（`watchHandshake` 那边先看见），
			// 这里下一拍就会被 `Path()` 认成 direct，不会被误记成失败。
			if tunnel.Path() == "direct" {
				keepHoleAlive(ctx, socket, tunnel)
				return
			}
			tunnel.setFailure(ErrHandshake)
		} else {
			// 这一轮没打穿：如实说这一轮的结论是失败（不伪装成在打，也不伪装成通了）。
			tunnel.setFailure(ErrNat)
		}
		if attempt == holeAttempts {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(holeRetryBackoff):
		}
	}
}

// watchHandshake 是这条隧道唯一的「握手落定」观察者：洞一开就隔一会儿问一次 WireGuard，
// 握上了就把 `direct` 置上。
//
// 与 `punch` 的 `waitHandshake` 分工不同：那一条决定「这一轮算不算失败」，这一条保证
// 「只听不打」的那半边也认得出通了 —— 它没人等，但手机打过来照样会握手。
func watchHandshake(ctx context.Context, tunnel *Tunnel) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// 握上了就置 direct，然后这条协程就没事了：`direct` 是终态，不会自己退回。
			if tunnel.handshakeSeen() {
				tunnel.confirmDirect()
				return
			}
		}
	}
}

// waitHandshake 等 WireGuard 真的握上手（回 true）或超时（回 false）。
//
// **只看握手**：`direct` 的含义就是「数据面通着」，而 UDP 洞开与密钥无关 —— 公钥配错时
// 洞照样开、探测包照样来回，数据面却一个包都过不去。
func waitHandshake(ctx context.Context, tunnel *Tunnel) bool {
	deadline := time.Now().Add(handshakeWait)
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return false
		}
		if tunnel.handshakeSeen() {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return tunnel.handshakeSeen()
}

// refreshSelf 周期重问出口地址：网络切换之后 NAT 映射会变，问一次就再也不问的后果是
// 重新会合时还在报上一个网络的地址，对端往那儿打永远打不到。
//
// 只更新候选，不动已经打通的路径：映射变了而洞还开着的情况很常见（同一张网内重连），
// 这里改坏它才是真正的回归。
func refreshSelf(ctx context.Context, socket *net.UDPConn, tunnel *Tunnel, servers []string) {
	if len(servers) == 0 {
		return
	}
	ticker := time.NewTicker(stunRefresh)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if mapped, err := discoverSelf(socket, servers, tunnel.stun); err == nil {
				tunnel.setLocalEndpoint(mapped)
			}
		}
	}
}

type dialForward struct {
	listener net.Listener
	mu       sync.Mutex
	closed   bool
	active   map[net.Conn]bool
	wg       sync.WaitGroup
}

func (f *dialForward) track(conn net.Conn) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		_ = conn.Close()
		return false
	}
	f.active[conn] = true
	return true
}

func (f *dialForward) untrack(conn net.Conn) {
	_ = conn.Close()
	f.mu.Lock()
	delete(f.active, conn)
	f.mu.Unlock()
}

func (f *dialForward) close() {
	_ = f.listener.Close()
	f.mu.Lock()
	f.closed = true
	for conn := range f.active {
		_ = conn.Close()
	}
	f.mu.Unlock()
	f.wg.Wait()
}

// dialLoop 是拨号侧那一半：回环监听和活动连接交给 Tunnel 收尾。
func dialLoop(ctx context.Context, netStack *netstack.Net, remote netip.AddrPort) (string, *dialForward, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, err
	}
	forward := &dialForward{listener: listener, active: make(map[net.Conn]bool)}
	forward.wg.Add(1)
	go func() {
		defer forward.wg.Done()
		for {
			local, err := listener.Accept()
			if err != nil {
				return
			}
			if !forward.track(local) {
				return
			}
			forward.wg.Add(1)
			go func(in net.Conn) {
				defer forward.wg.Done()
				defer forward.untrack(in)
				dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
				defer cancel()
				out, err := netStack.DialContextTCPAddrPort(dialCtx, remote)
				if err != nil {
					return
				}
				if !forward.track(out) {
					return
				}
				defer forward.untrack(out)
				pipe(in, out)
			}(local)
		}
	}()
	return "http://" + listener.Addr().String(), forward, nil
}

// acceptLoop 是电脑侧那一半：隧道里听一个端口，进来的连接转给本机插件。
//
// 转给 127.0.0.1 而不是改插件的监听：插件那套鉴权、路由、日志一行都不用动，
// 它看到的仍然是一条普通的本机连接。
func acceptLoop(netStack *netstack.Net, listenPort, targetPort int, localTun string) (string, error) {
	listener, err := netStack.ListenTCPAddrPort(netip.AddrPortFrom(netip.MustParseAddr(localTun), uint16(listenPort)))
	if err != nil {
		return "", err
	}
	go func() {
		for {
			remote, err := listener.Accept()
			if err != nil {
				return
			}
			go func(out net.Conn) {
				defer out.Close()
				in, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", targetPort), 5*time.Second)
				if err != nil {
					return
				}
				defer in.Close()
				pipe(out, in)
			}(remote)
		}
	}()
	return fmt.Sprintf("http://%s:%d", localTun, listenPort), nil
}

// pipe 双向搬运，任意一侧收尾就把两侧一起收掉。
func pipe(a, b net.Conn) {
	var once sync.Once
	closeBoth := func() {
		once.Do(func() {
			_ = a.Close()
			_ = b.Close()
		})
	}
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(a, b); done <- struct{}{} }()
	go func() { _, _ = io.Copy(b, a); done <- struct{}{} }()
	<-done
	closeBoth()
	<-done
}

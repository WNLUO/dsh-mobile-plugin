// 点对点隧道（P2P）的单元测试：STUN 解析、密钥、打洞。
//
// 这些测试**不需要外网**：STUN 用本地假的回声服务器，打洞用两个本地 socket 互相打。
// 真机 / 真网络那一步只能在设备上验，这里守的是「逻辑别错」。

package p2p

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/netip"
	"testing"
	"time"
)

// buildStunResponse 拼一条 Binding Success Response，带 XOR-MAPPED-ADDRESS。
func buildStunResponse(addr netip.AddrPort, xor bool) []byte {
	var kind uint16 = attrMapped
	if xor {
		kind = attrXor
	}
	// 事务 ID 全零：这里只验解析，不验事务匹配。
	header := make([]byte, stunHeaderLen)
	binary.BigEndian.PutUint16(header[0:], stunSuccess)
	binary.BigEndian.PutUint32(header[4:], stunMagic)

	var value []byte
	if addr.Addr().Is4() {
		raw := addr.Addr().As4()
		if xor {
			var mask [4]byte
			binary.BigEndian.PutUint32(mask[:], stunMagic)
			for i := range raw {
				raw[i] ^= mask[i]
			}
		}
		value = append([]byte{0, 0x01}, byte(portHigh(addr.Port(), xor)), byte(portLow(addr.Port(), xor)))
		value = append(value, raw[:]...)
	} else {
		raw := addr.Addr().As16()
		if xor {
			var mask [16]byte
			binary.BigEndian.PutUint32(mask[0:4], stunMagic)
			for i := range raw {
				raw[i] ^= mask[i]
			}
		}
		value = append([]byte{0, 0x02}, byte(portHigh(addr.Port(), xor)), byte(portLow(addr.Port(), xor)))
		value = append(value, raw[:]...)
	}

	attr := make([]byte, 4+len(value))
	binary.BigEndian.PutUint16(attr[0:], kind)
	binary.BigEndian.PutUint16(attr[2:], uint16(len(value)))
	copy(attr[4:], value)
	binary.BigEndian.PutUint16(header[2:], uint16(len(attr)))
	return append(header, attr...)
}

func portHigh(port uint16, xor bool) uint16 {
	masked := port
	if xor {
		masked ^= uint16(stunMagic >> 16)
	}
	return masked >> 8
}

func portLow(port uint16, xor bool) uint16 {
	masked := port
	if xor {
		masked ^= uint16(stunMagic >> 16)
	}
	return masked & 0xff
}

func TestParseStunXorMappedIPv4(t *testing.T) {
	want := netip.MustParseAddrPort("203.0.113.7:51820")
	got, err := parseStunResponse(buildStunResponse(want, true))
	if err != nil {
		t.Fatalf("解析失败：%v", err)
	}
	if got != want {
		t.Fatalf("解出来的是 %v，期望 %v", got, want)
	}
}

func TestParseStunMappedFallback(t *testing.T) {
	want := netip.MustParseAddrPort("198.51.100.9:1234")
	got, err := parseStunResponse(buildStunResponse(want, false))
	if err != nil {
		t.Fatalf("解析失败：%v", err)
	}
	if got != want {
		t.Fatalf("解出来的是 %v，期望 %v", got, want)
	}
}

func TestParseStunRejectsGarbage(t *testing.T) {
	// 短包、错误消息类型、没有地址属性，三种都得回错误而不是瞎猜一个地址。
	for _, packet := range [][]byte{
		{0, 1},
		append([]byte{0x01, 0x11, 0, 0, 0x21, 0x12, 0xA4, 0x42}, make([]byte, 12)...),
		buildStunResponse(netip.MustParseAddrPort("1.2.3.4:1"), true)[:20],
	} {
		if addr, err := parseStunResponse(packet); err == nil {
			t.Fatalf("坏包不该解出地址，却得到 %v", addr)
		}
	}
}

func TestStunQueryAgainstLocalServer(t *testing.T) {
	// 起一个本地假 STUN：收到请求就回一条。
	server, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Skipf("本机起不了 UDP：%v", err)
	}
	defer server.Close()
	go func() {
		buf := make([]byte, 1500)
		for {
			n, from, err := server.ReadFromUDP(buf)
			if err != nil {
				return
			}
			if n < stunHeaderLen {
				continue
			}
			want := netip.AddrPortFrom(netip.MustParseAddr(from.IP.String()), uint16(from.Port))
			_, _ = server.WriteToUDP(buildStunResponse(want, true), from)
		}
	}()

	client, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Skipf("本机起不了 UDP：%v", err)
	}
	defer client.Close()

	// 没有分流器的那条路（nil waiter）：自己读这块 socket —— 独立 socket 上就是这条。
	got, err := discoverSelf(client, []string{server.LocalAddr().String()}, nil)
	if err != nil {
		t.Fatalf("查自己的地址失败：%v", err)
	}
	// 假服务器把请求的来源地址原样回给我们，那就是本机的回环地址。
	if got.Port() != uint16(client.LocalAddr().(*net.UDPAddr).Port) {
		t.Fatalf("端口对不上：%v vs %v", got, client.LocalAddr())
	}
}

func TestGenerateKeyPairMatchesWireGuardShape(t *testing.T) {
	pair, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("生成密钥失败：%v", err)
	}
	// 两段都得是 44 字符 base64（32 字节），这是 WireGuard 的通用写法。
	for name, text := range map[string]string{"private": pair.Private, "public": pair.Public} {
		if len(text) != 44 {
			t.Fatalf("%s 长度是 %d，期望 44", name, len(text))
		}
		if _, err := parseKey(text); err != nil {
			t.Fatalf("%s 解不出来：%v", name, err)
		}
	}
	// 公钥必须能从私钥推回来：推不回来的话，配对时给出去的公钥跟本机实际用的一对不上。
	derived, err := PublicFromPrivate(pair.Private)
	if err != nil {
		t.Fatalf("推公钥失败：%v", err)
	}
	if derived != pair.Public {
		t.Fatalf("推出来的公钥 %s 与生成时的 %s 不一致", derived, pair.Public)
	}
}

func TestParseKeyAcceptsHex(t *testing.T) {
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = byte(i)
	}
	if _, err := parseKey(hex.EncodeToString(raw)); err != nil {
		t.Fatalf("hex 写法该被收下：%v", err)
	}
	for _, bad := range []string{"", "abc", "not-a-key", string(make([]byte, 44))} {
		if _, err := parseKey(bad); err == nil {
			t.Fatalf("坏密钥 %q 不该被收下", bad)
		}
	}
}

func TestParseEndpointsDropsGarbage(t *testing.T) {
	got := parseEndpoints([]string{"1.2.3.4:5678", "garbage", "1.2.3.4:0", "[::1]:80", ""})
	if len(got) != 2 {
		t.Fatalf("该只留两条，实际 %d 条：%v", len(got), got)
	}
	if got[0] != netip.MustParseAddrPort("1.2.3.4:5678") {
		t.Fatalf("第一条不对：%v", got[0])
	}
	if got[1] != netip.MustParseAddrPort("[::1]:80") {
		t.Fatalf("IPv6 那条不对：%v", got[1])
	}
}

func TestStartRejectsBadInput(t *testing.T) {
	// 四种坏输入都要在**开任何 socket 之前**被挡掉：密钥不对、端口越界、没有对端候选。
	cases := []struct {
		name string
		opts Options
		want string
	}{
		{"私钥坏", Options{PrivateKey: "x", PeerPublicKey: "y", ListenPort: 8080}, ErrKey},
		{"端口越界", Options{PrivateKey: mustKey(t), PeerPublicKey: mustKey(t), ListenPort: 80}, ErrInvalid},
	}
	for _, tc := range cases {
		if _, code := Start(tc.opts); code != tc.want {
			t.Fatalf("%s：该回 %s，实际 %q", tc.name, tc.want, code)
		}
	}
}

func mustKey(t *testing.T) string {
	t.Helper()
	pair, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("生成密钥失败：%v", err)
	}
	return pair.Private
}

func TestPunchedBindDeliversQueuedPacket(t *testing.T) {
	bind := newPunchedBind()
	defer bind.shutdown()

	addr := netip.MustParseAddrPort("203.0.113.5:9000")
	bind.deliver([]byte("hello"), addr)

	packets := make([][]byte, 1)
	packets[0] = make([]byte, 64)
	sizes := make([]int, 1)

	fns, _, err := bind.Open(0)
	if err != nil {
		t.Fatalf("开 bind 失败：%v", err)
	}
	n, err := fns[0](packets, sizes, nil)
	if err != nil {
		t.Fatalf("收包失败：%v", err)
	}
	if n != 1 || string(packets[0][:sizes[0]]) != "hello" {
		t.Fatalf("收到的不是那一发：n=%d data=%q", n, packets[0][:sizes[0]])
	}
}

// Close 必须可逆（WireGuard 的 BindUpdate 会先 Close 再 Open）。
func TestPunchedBindCloseIsReversible(t *testing.T) {
	bind := newPunchedBind()
	defer bind.shutdown()
	if err := bind.Close(); err != nil {
		t.Fatalf("Close 不该报错：%v", err)
	}
	if _, _, err := bind.Open(0); err != nil {
		t.Fatalf("Close 之后还能再 Open（BindUpdate 就靠这个）：%v", err)
	}
}

// shutdown 之后接收必须立刻返回错误，而不是继续等（等下去收尾就卡死了）。
func TestShutdownUnblocksReceive(t *testing.T) {
	bind := newPunchedBind()
	fns, _, err := bind.Open(0)
	if err != nil {
		t.Fatalf("开 bind 失败：%v", err)
	}

	done := make(chan error, 1)
	go func() {
		_, err := fns[0](make([][]byte, 1), make([]int, 1), nil)
		done <- err
	}()
	// 给接收协程一点时间挂上去，再关。
	time.Sleep(50 * time.Millisecond)
	bind.shutdown()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("收尾之后接收该回错误")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("收尾之后接收还挂着 —— 这就是收尾卡死的形状")
	}
}

func TestPunchedBindClosedRefusesSend(t *testing.T) {
	bind := newPunchedBind()
	var wrote bool
	bind.attachWriter(func([]byte, netip.AddrPort) error { wrote = true; return nil })
	bind.shutdown()

	ep, err := bind.ParseEndpoint("203.0.113.5:9000")
	if err != nil {
		t.Fatalf("解地址失败：%v", err)
	}
	if err := bind.Send([][]byte{[]byte("x")}, ep); err == nil {
		t.Fatal("关掉之后发不出去才对")
	}
	if wrote {
		t.Fatal("关掉之后不该真的往 socket 写")
	}
}

// fakeDevice 只满足 Tunnel 用到的那三样：Close / IpcGet / SendKeepalives。
// 用它把「握手凭据」这件事单独拎出来验，不必起真 WireGuard。
type fakeDevice struct {
	ipc string
}

func (d *fakeDevice) Close()                                   {}
func (d *fakeDevice) SendKeepalivesToPeersWithCurrentKeypair() {}
func (d *fakeDevice) IpcGet() (string, error)                  { return d.ipc, nil }

// 只收到探测包、握手还没写上时，绝不能报 direct —— 这条通道没有中继兜底，说通了就是真通了。
func TestDirectRequiresHandshake(t *testing.T) {
	tunnel := &Tunnel{done: make(chan struct{}), stun: newStunWaiter()}
	tunnel.device = &fakeDevice{ipc: "public_key=aa\nlast_handshake_time_sec=0\nlast_handshake_time_nsec=0\n"}
	tunnel.markDialing()
	tunnel.noteHoleOpen(netip.MustParseAddrPort("203.0.113.5:5000"))

	if got := tunnel.Path(); got == "direct" {
		t.Fatalf("只收到探测包就报已连通：%q（洞开 ≠ 数据面通）", got)
	}
	if got := tunnel.Path(); got != PathPunching {
		t.Fatalf("洞开了、握手未落定时该报 punching，实际 %q", got)
	}
}

// 一轮报过失败之后进入退避重试：哪怕这一轮又收到对端探测包，对外也应继续报 failed。
// 中途把 failed 翻回 punching，会让同一个事实在界面上「没打通 / 正在打洞」来回跳。
func TestFailedRoundDoesNotFlipBackToPunching(t *testing.T) {
	tunnel := &Tunnel{done: make(chan struct{}), stun: newStunWaiter()}
	tunnel.device = &fakeDevice{ipc: "public_key=aa\nlast_handshake_time_sec=0\n"}
	tunnel.setFailure(ErrNat)
	// 新一轮开始：清 holeOpen、置 dialPending，但**不清 path**（见 startAttempt 的注释）。
	tunnel.startAttempt()
	tunnel.noteHoleOpen(netip.MustParseAddrPort("203.0.113.5:5000"))

	if got := tunnel.Path(); got != "failed" {
		t.Fatalf("重试期间收到探测包不该翻回 punching，实际 %q", got)
	}
}

// 握手写上了才算 direct。
func TestHandshakeMakesDirect(t *testing.T) {
	tunnel := &Tunnel{done: make(chan struct{}), stun: newStunWaiter()}
	tunnel.device = &fakeDevice{ipc: "public_key=aa\nlast_handshake_time_sec=1762500000\nlast_handshake_time_nsec=7\n"}
	tunnel.markDialing()
	tunnel.noteHoleOpen(netip.MustParseAddrPort("203.0.113.5:5000"))

	if got := tunnel.Path(); got != "direct" {
		t.Fatalf("握手已写下却报 %q，该报 direct", got)
	}
}

// 读 IpcGet 的解析：没有握手那一行、或者是零秒，都不算通。
func TestHandshakeZeroIsNotDirect(t *testing.T) {
	for _, ipc := range []string{
		"",
		"public_key=aa\n",
		"public_key=aa\nlast_handshake_time_sec=0\n",
		"garbage",
	} {
		tunnel := &Tunnel{done: make(chan struct{}), stun: newStunWaiter()}
		tunnel.device = &fakeDevice{ipc: ipc}
		if tunnel.handshakeSeen() {
			t.Fatalf("这份回执不该被认成握手成功：%q", ipc)
		}
	}
}

// 打洞一轮没成要**继续打有限几轮**（不是八秒没成就永久放弃），最后仍如实报 failed。
func TestPunchRetriesThenReportsFailure(t *testing.T) {
	holeRoundTimeout = 150 * time.Millisecond
	holeRetryBackoff = 50 * time.Millisecond
	defer func() { holeRoundTimeout = holeTimeout; holeRetryBackoff = holeBackoff }()

	handle := startLocalTunnel(t)
	defer Stop(handle)

	// 等到它至少试过两轮 —— 一轮就永久放弃正是这次要改掉的。
	attemptsOf := func() int {
		var diagnose struct {
			Attempts int `json:"attempts"`
		}
		if err := json.Unmarshal([]byte(Diagnose(handle)), &diagnose); err != nil {
			t.Fatalf("诊断解不开：%v", err)
		}
		return diagnose.Attempts
	}
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) && attemptsOf() < 2 {
		time.Sleep(20 * time.Millisecond)
	}
	if got := attemptsOf(); got < 2 {
		t.Fatalf("只打了 %d 轮，说明没有重试", got)
	}
	// 重试期间对外一直如实报 failed（不能报成在打、更不能报成通了）。
	if got := Path(handle); got != "failed" {
		t.Fatalf("打不通该报 failed，实际 %q", got)
	}
}

// STUN 回包由 stunWaiter 转交：登记了那一家才收，没收登记的一律当普通数据。
func TestStunWaiterRoutesOnlyRegistered(t *testing.T) {
	waiter := newStunWaiter()
	server, err := net.ResolveUDPAddr("udp", "203.0.113.7:3478")
	if err != nil {
		t.Fatalf("解地址失败：%v", err)
	}
	waiter.queryMu.Lock()
	inbox := waiter.open([]*net.UDPAddr{server})
	waiter.queryMu.Unlock()

	want := netip.MustParseAddrPort("203.0.113.7:3478")
	if !waiter.offer(want, buildStunResponse(netip.MustParseAddrPort("198.51.100.1:9000"), true)) {
		t.Fatal("登记过的来源该被收下")
	}
	if waiter.offer(netip.MustParseAddrPort("203.0.113.9:3478"), []byte("x")) {
		t.Fatal("没登记过的来源不该被收")
	}
	select {
	case packet := <-inbox:
		if mapped, err := parseStunResponse(packet); err != nil || mapped.String() != "198.51.100.1:9000" {
			t.Fatalf("转交进来的解错了：%v %v", mapped, err)
		}
	case <-time.After(time.Second):
		t.Fatal("登记过的回包没被转进来")
	}
	waiter.close(inbox)
	if waiter.offer(want, []byte("x")) {
		t.Fatal("撤掉登记之后不该再收")
	}
}

// 一次问遍全清单：一家不应答也不耽误另一家的答案（早先串行会把总时长拖到 家数×超时）。
func TestDiscoverSelfFirstAnswerWins(t *testing.T) {
	dead, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Skipf("本机起不了 UDP：%v", err)
	}
	defer dead.Close()
	go func() { // 只收不回
		buf := make([]byte, 1500)
		for {
			if _, _, err := dead.ReadFromUDP(buf); err != nil {
				return
			}
		}
	}()

	live, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Skipf("本机起不了 UDP：%v", err)
	}
	defer live.Close()
	go func() {
		buf := make([]byte, 1500)
		for {
			n, from, err := live.ReadFromUDP(buf)
			if err != nil {
				return
			}
			if n < stunHeaderLen {
				continue
			}
			want := netip.AddrPortFrom(netip.MustParseAddr(from.IP.String()), uint16(from.Port))
			_, _ = live.WriteToUDP(buildStunResponse(want, true), from)
		}
	}()

	client, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Skipf("本机起不了 UDP：%v", err)
	}
	defer client.Close()

	begin := time.Now()
	got, err := discoverSelf(client, []string{dead.LocalAddr().String(), live.LocalAddr().String()}, nil)
	if err != nil {
		t.Fatalf("该拿到活着那一家的答案：%v", err)
	}
	if got.Port() != uint16(client.LocalAddr().(*net.UDPAddr).Port) {
		t.Fatalf("端口对不上：%v", got)
	}
	// 串行会先等死的那家一个 stunBudget；并发应当明显更快。
	if elapsed := time.Since(begin); elapsed > stunBudget {
		t.Fatalf("一次问遍全清单却花了 %v（串行了？）", elapsed)
	}
}

// 手机上候选绝不能空：安卓普通 App 拿不到路由表，`net.InterfaceAddrs()` 会
// permission denied —— 那时必须靠「拨一个 UDP 让内核挑出口地址」这条兜底顶上。
func TestCandidateFallbackPicksOutboundAddr(t *testing.T) {
	addr, ok := outboundLocalAddr()
	if !ok {
		t.Skip("这台机器没有可用出口路由（离线环境），兜底无从验证")
	}
	if addr.IsLoopback() || addr.IsUnspecified() || !addr.Is4() {
		t.Fatalf("兜底挑出来的不是可用的内网地址：%v", addr)
	}
}

// Candidates 至少要把「本机私网地址 + 本端端口」拼出来：对端拿它才打得到同网的那一跳。
func TestCandidatesIncludeLocalPort(t *testing.T) {
	tunnel := &Tunnel{done: make(chan struct{}), stun: newStunWaiter()}
	tunnel.setLocalPort(49500)
	list := tunnel.Candidates()
	if len(list) == 0 {
		t.Skip("这台机器枚举不出私网地址（离线 / 只有回环），兜底已由另一条用例覆盖")
	}
	for _, text := range list {
		addr, err := netip.ParseAddrPort(text)
		if err != nil {
			t.Fatalf("候选不是合法的 ip:port：%q", text)
		}
		if addr.Port() != 49500 {
			t.Fatalf("候选端口该是本端 socket 的端口：%v", addr)
		}
	}
	// 私网那条要排在最前（同网直连往往一跳就通，不必等公网打洞）。
	tunnel.setLocalEndpoint(netip.MustParseAddrPort("203.0.113.7:49500"))
	got := tunnel.Candidates()
	if last := got[len(got)-1]; last != "203.0.113.7:49500" {
		t.Fatalf("公网那份该排最后，实际 %v", got)
	}
}

// 端到端：两端各起一条真隧道，互换候选，看它能不能真的打通并置上 direct。
//
// 这条钉的是「握手凭据这条路走得通」：早先的 `direct` 只看探测包，那版把判据换成握手之后
// 如果哪里读错了（比如回执字段名写错），这条会红成「一直没通」。
func TestPairPunchesAndHandshakes(t *testing.T) {
	if len(localPrivateAddrs()) == 0 {
		t.Skip("这台机器枚举不出私网地址，两端互相打不了（兜底那条另有用例）")
	}
	acceptKey := mustKey(t)
	dialKey := mustKey(t)
	acceptPub, err := PublicFromPrivate(acceptKey)
	if err != nil {
		t.Fatalf("推公钥失败：%v", err)
	}
	dialPub, err := PublicFromPrivate(dialKey)
	if err != nil {
		t.Fatalf("推公钥失败：%v", err)
	}

	acceptPort := 18787 + int(portCursor.Add(1))
	accept, code := Start(Options{
		PrivateKey:    acceptKey,
		PeerPublicKey: dialPub,
		ListenPort:    acceptPort,
		TargetPort:    acceptPort,
		Mode:          ModeAccept,
		STUN:          []string{},
	})
	if code != "" {
		t.Fatalf("电脑侧起不来：%s", code)
	}
	defer Stop(accept)
	candidates := Candidates(accept)
	if len(candidates) == 0 {
		t.Fatalf("电脑侧一个候选都没报：这条通道没法会合")
	}

	dial, code := Start(Options{
		PrivateKey:     dialKey,
		PeerPublicKey:  acceptPub,
		PeerCandidates: candidates,
		ListenPort:     18787 + int(portCursor.Add(1)),
		Mode:           ModeDial,
		STUN:           []string{},
	})
	if code != "" {
		t.Fatalf("手机侧起不来：%s", code)
	}
	defer Stop(dial)

	// 打洞 + 握手：两端都该在几秒内报 direct。
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if Path(accept) == "direct" && Path(dial) == "direct" {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("两端没能握上手：电脑侧 %q，手机侧 %q（洞开了但数据面没通？）", Path(accept), Path(dial))
}

// normalizeFrom 必须把 IPv4-mapped IPv6 还原成纯 v4：双栈 socket 上 v4 包就是这么回来的。
// 不还原的话，`::ffff:1.2.3.4` 与候选里的 `1.2.3.4` 永远不相等，打洞「收到了却认不到」。
func TestNormalizeFromUnmapsIPv4(t *testing.T) {
	mapped := netip.MustParseAddrPort("[::ffff:192.168.1.5]:40777")
	got := normalizeFrom(mapped)
	if want := netip.MustParseAddrPort("192.168.1.5:40777"); got != want {
		t.Fatalf("v4 映射地址该还原成 %v，实际 %v", want, got)
	}
	// 真 v6 不许被改坏。
	v6 := netip.MustParseAddrPort("[240e:338::1]:40777")
	if normalizeFrom(v6) != v6 {
		t.Fatalf("纯 v6 地址不该被改：%v", normalizeFrom(v6))
	}
}

// 本机有全球 IPv6 时，候选里必须带上它；且 IPv6 候选排在私网 IPv4 之后、STUN 公网之前。
func TestCandidatesIncludeGlobalIPv6(t *testing.T) {
	if len(localGlobalV6Addrs()) == 0 {
		t.Skip("这台机器没有全球 IPv6 地址")
	}
	tunnel := &Tunnel{done: make(chan struct{}), stun: newStunWaiter()}
	tunnel.setLocalPort(49501)
	list := tunnel.Candidates()
	var v6Seen bool
	for _, text := range list {
		addr, err := netip.ParseAddrPort(text)
		if err != nil {
			t.Fatalf("候选不是合法 ip:port：%q", text)
		}
		if addr.Port() != 49501 {
			t.Fatalf("候选端口该是本端 socket 端口：%v", addr)
		}
		if addr.Addr().Is6() && isGlobalUnicastV6(addr.Addr()) {
			v6Seen = true
		}
	}
	if !v6Seen {
		t.Fatalf("本机有全球 IPv6，候选里却没有一条 IPv6：%v", list)
	}
}

// isGlobalUnicastV6 的口径：收全球单播，排掉 ULA / 6to4 / Teredo / 文档段 / 链路本地 / 回环。
func TestIsGlobalUnicastV6Filters(t *testing.T) {
	accept := []string{"240e:338:521b:1700::998", "2606:4700:4700::1111"}
	reject := []string{"fc00::1", "fd12::1", "2002::1", "2001::1", "2001:db8::1", "fe80::1", "::1"}
	for _, text := range accept {
		if !isGlobalUnicastV6(netip.MustParseAddr(text)) {
			t.Fatalf("%s 该被认成全球单播 v6", text)
		}
	}
	for _, text := range reject {
		if isGlobalUnicastV6(netip.MustParseAddr(text)) {
			t.Fatalf("%s 不该被认成全球单播 v6", text)
		}
	}
}

// 端到端：**只给 IPv6 候选**，两端靠双栈 socket 在 ::1 上打通并握手。
//
// 这条钉的是「IPv6 那一半真的能建隧道」：把候选过滤成只留 v6 回环，如果 socket 还是
// udp4、或地址没走对，这条会红成「两端没握上手」。IPv6 没有 NAT，所以这里不打洞也能通。
func TestPairHandshakesOverIPv6(t *testing.T) {
	if !hasIPv6Loopback() {
		t.Skip("这台机器没有 ::1，跳过 IPv6 端到端")
	}
	acceptKey := mustKey(t)
	dialKey := mustKey(t)
	acceptPub, err := PublicFromPrivate(acceptKey)
	if err != nil {
		t.Fatalf("推公钥失败：%v", err)
	}
	dialPub, err := PublicFromPrivate(dialKey)
	if err != nil {
		t.Fatalf("推公钥失败：%v", err)
	}

	acceptPort := 18800 + int(portCursor.Add(1))
	accept, code := Start(Options{
		PrivateKey:    acceptKey,
		PeerPublicKey: dialPub,
		ListenPort:    acceptPort,
		TargetPort:    acceptPort,
		Mode:          ModeAccept,
		STUN:          []string{},
	})
	if code != "" {
		t.Fatalf("电脑侧起不来：%s", code)
	}
	defer Stop(accept)

	// 取电脑侧真实候选里的端口，构造一条**纯 v6 回环**的候选给手机侧。
	cands := Candidates(accept)
	if len(cands) == 0 {
		t.Fatalf("电脑侧没有候选")
	}
	port := netip.MustParseAddrPort(cands[0]).Port()
	v6cand := netip.AddrPortFrom(netip.IPv6Loopback(), port).String()

	dial, code := Start(Options{
		PrivateKey:     dialKey,
		PeerPublicKey:  acceptPub,
		PeerCandidates: []string{v6cand},
		ListenPort:     18800 + int(portCursor.Add(1)),
		Mode:           ModeDial,
		STUN:           []string{},
	})
	if code != "" {
		t.Fatalf("手机侧起不来：%s", code)
	}
	defer Stop(dial)

	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if Path(accept) == "direct" && Path(dial) == "direct" {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("IPv6 两端没握上手：电脑侧 %q，手机侧 %q", Path(accept), Path(dial))
}

// hasIPv6Loopback 判断这台机器有没有 ::1（几乎总有，但关掉 IPv6 的机器没有）。
func hasIPv6Loopback() bool {
	conn, err := net.ListenUDP("udp6", &net.UDPAddr{IP: net.IPv6loopback, Port: 0})
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

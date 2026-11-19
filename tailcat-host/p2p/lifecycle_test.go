// 隧道生命周期守卫：停止时收回回环监听、活动连接与打洞协程。
//
// 这些都不碰真网络对端：起一条隧道只要求本机有个能写 UDP 的 socket，打洞打不通是正常
// 结局（本地没有真对端），正好用来验证「失败也收得干净」。

package p2p

import (
	"net"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// portCursor 给每条测试隧道分配一个不同的本地端口（见 startLocalTunnel）。
var portCursor atomic.Int64

// 起一条真隧道（打洞注定失败，但生命周期该是完整的）。
func startLocalTunnel(t *testing.T) int64 {
	t.Helper()
	// 每次换一个本地端口：前一条隧道刚停下时它那个回环监听可能还没完全释放，
	// 同一个端口上再起一条会拿到 start-failed —— 那是测试自己的竞态，不是被测代码的问题。
	localPort := 18787 + int(portCursor.Add(1))
	private := mustKey(t)
	peerPrivate := mustKey(t)
	peerPublic, err := PublicFromPrivate(peerPrivate)
	if err != nil {
		t.Fatalf("推公钥失败：%v", err)
	}
	handle, code := Start(Options{
		PrivateKey:    private,
		PeerPublicKey: peerPublic,
		// 一个必然没人听的本地地址：打洞会走满预算然后如实报失败。
		PeerCandidates: []string{"127.0.0.1:1"},
		ListenPort:     localPort,
		Mode:           ModeDial,
		// 空清单 = 别去问 STUN：这一步在测试里没有意义，还会让每条用例多等几轮超时。
		STUN: []string{},
	})
	if code != "" {
		t.Fatalf("起隧道失败：%s", code)
	}
	return handle
}

func TestStartReturnsUsableHandle(t *testing.T) {
	handle := startLocalTunnel(t)
	defer Stop(handle)
	if handle <= 0 {
		t.Fatalf("句柄不合法：%d", handle)
	}
	url := LocalURL(handle)
	if url == "" || url[:8] != "http://1" {
		t.Fatalf("回环地址不对：%q", url)
	}
	// 刚起来时打洞还没结论：可以是 unknown / punching / waiting，但**绝不能是 direct**
	// （那等于把「还没打穿」说成「已连通」—— 这条通道没有中继兜底，装不出来）。
	if got := Path(handle); got == "direct" {
		t.Fatalf("刚起来就报已连通：%q", got)
	}
}

func TestStopIsIdempotent(t *testing.T) {
	handle := startLocalTunnel(t)
	if Stop(handle) != 1 {
		t.Fatal("第一次停该回 1")
	}
	if Stop(handle) != 0 {
		t.Fatal("重复停该回 0")
	}
	// 停掉之后问什么都该是「没有这条」。
	if Path(handle) != "unknown" {
		t.Fatal("停掉之后不该还有结论")
	}
	if LocalURL(handle) != "" {
		t.Fatal("停掉之后不该还有地址")
	}
}

func TestStopUnknownHandleIsNoop(t *testing.T) {
	if Stop(999999) != 0 {
		t.Fatal("停一个不存在的句柄该回 0，不该崩")
	}
	if Diagnose(999999) == "" {
		t.Fatal("诊断不存在的句柄该给一段 JSON，不是空串")
	}
}

// 「只听不打」那一半不能永远报 unknown。
//
// 电脑侧没有对端候选时压根不发探测包，于是 `direct` 永远置不上、`failed` 也永远等不到，
// 早先它就永远停在 `unknown` —— 界面上一直显示「正在打洞」，用户没法判断到底是还在试
// 还是卡住了。现在这种情况报 `waiting`（我准备好了，等对端来打）。
//
// 同样不能报成 `direct`：这条通道没有中继兜底，把「还没打穿」说成「已连通」比不显示更糟。
func TestListenOnlyReportsWaiting(t *testing.T) {
	private := mustKey(t)
	peerPublic, err := PublicFromPrivate(mustKey(t))
	if err != nil {
		t.Fatalf("推公钥失败：%v", err)
	}
	handle, code := Start(Options{
		PrivateKey: private,
		// 对端公钥要有，否则配不出设备 —— 但**候选一个都不给**，这才是「只听不打」。
		PeerPublicKey: peerPublic,
		ListenPort:    18787 + int(portCursor.Add(1)),
		TargetPort:    18080,
		Mode:          ModeAccept,
		// 空清单表示别去问 STUN（测试不该依赖外网）。
		STUN: []string{},
	})
	if code != "" {
		t.Fatalf("起不来：%s", code)
	}
	defer Stop(handle)
	got := Path(handle)
	if got == "direct" {
		t.Fatalf("还没打穿就报已连通：%q", got)
	}
	if got == "unknown" {
		t.Fatalf("只听不打时不该永远 unknown（界面会一直显示「正在打洞」）：%q", got)
	}
	if got != "waiting" {
		t.Fatalf("只听不打该报 waiting，实际 %q", got)
	}
}

// 打洞必然失败时，隧道要如实报失败、而不是永远停在 unknown 或者假装通了。
func TestHoleFailureIsReported(t *testing.T) {
	handle := startLocalTunnel(t)
	defer Stop(handle)
	// 打洞预算是 8 秒；这里给足，等它落定。
	//
	// 等的是**终态**（direct / failed），不是「不再是 unknown」：`punching` 也是非 unknown
	// 的中间态，按那个条件会在打洞刚开始时就跳出循环、然后误报「该 failed 却拿到 punching」。
	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		if path := Path(handle); path == "direct" || path == "failed" {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if got := Path(handle); got != "failed" {
		t.Fatalf("打不通时该报 failed，实际 %q", got)
	}
	if Diagnose(handle) == "" {
		t.Fatal("诊断该给一段 JSON")
	}
}

// 停掉之后打洞协程不该还活着（这里靠「停得快」间接验证：卡住的收尾会超时）。
func TestCloseReturnsPromptly(t *testing.T) {
	handle := startLocalTunnel(t)
	begin := time.Now()
	Stop(handle)
	if elapsed := time.Since(begin); elapsed > 5*time.Second {
		t.Fatalf("收尾花了 %v，说明有协程没收掉", elapsed)
	}
}

func TestStopClosesDialListenerAndActiveConnection(t *testing.T) {
	handle := startLocalTunnel(t)
	address := strings.TrimPrefix(LocalURL(handle), "http://")
	conn, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatalf("回环连接失败：%v", err)
	}
	defer conn.Close()
	Stop(handle)
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := conn.Read(make([]byte, 1)); err == nil {
		t.Fatal("停止后活动连接仍未关闭")
	} else if timed, ok := err.(net.Error); ok && timed.Timeout() {
		t.Fatal("停止后活动连接仍在等待数据")
	}
	if extra, err := net.DialTimeout("tcp", address, time.Second); err == nil {
		_ = extra.Close()
		t.Fatal("停止后回环端口仍在监听")
	}
}

func TestParseEndpointsKeepsOrder(t *testing.T) {
	// 私网候选要排前面（同网直连往往一跳就通），所以顺序是契约而不是细节。
	got := parseEndpoints([]string{"10.0.0.2:11010", "203.0.113.1:11010"})
	if len(got) != 2 || got[0] != netip.MustParseAddrPort("10.0.0.2:11010") {
		t.Fatalf("顺序不对：%v", got)
	}
}

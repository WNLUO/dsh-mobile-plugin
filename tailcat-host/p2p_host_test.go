// IPC 空状态字段完整，按公钥停止只回执并收回对应 peer。
// 助手这一层对 P2P 命令的应答：真跑一次 `Run`，看它认不认这一组命令。
//
// 为什么需要这一条：电脑侧那个助手是**另外编出来的二进制**，装到机器上的那份未必跟着
// 源码一起更新。P2P 曾经在源码里齐了、编译也过了，机器上跑的那份却根本没编进这一块，
// 于是插件发过去的 `p2pStart` 只换来一句「不认识这个命令」，而所有守卫都是绿的 ——
// 它们钉的都是插件怎么说话，没有一条钉「对方听不听得懂」。
//
// 这一组钉三件事：命令认不认得；一台电脑能不能同时接多台手机（两条隧道并存、同一把
// 公钥重来是替换而不是新增、旧句柄真的被 Stop）；以及事件里那个让插件做路由的 `peerKey`
// 是不是精确长在插件白名单允许的位置上。真打洞要两台设备、真 NAT，那是真机的事。

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	"dshmobile.local/tailcat-host/p2p"
)

// runHost 把一份助手跑起来，回一个「发命令 / 收事件」的小控制器。
type hostDriver struct {
	feed   io.WriteCloser
	events chan map[string]any
	done   chan error
	closed bool
}

func startHost(t *testing.T) *hostDriver {
	t.Helper()
	stdin, feed := io.Pipe()
	read, stdout := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- Run(stdin, stdout, Option{}) }()

	events := make(chan map[string]any, 32)
	go func() {
		scanner := bufio.NewScanner(read)
		scanner.Buffer(make([]byte, 4096), lineLimit)
		for scanner.Scan() {
			var event map[string]any
			if json.Unmarshal(scanner.Bytes(), &event) == nil {
				events <- event
			}
		}
		close(events)
	}()

	driver := &hostDriver{feed: feed, events: events, done: done}
	t.Cleanup(func() {
		driver.shutdown(t)
	})
	// 第一行是配置：没有它助手什么都不接。
	driver.send(t, map[string]any{
		"version": protoVersion, "localPort": 19446, "name": "p2p-test", "state": nil, "allowedClients": []any{},
	})
	driver.waitFor(t, "ready", 60*time.Second)
	return driver
}

// shutdown 关掉 stdin 并等助手真的收完尾。重复调用是空操作（cleanup 还会再来一次）。
func (d *hostDriver) shutdown(t *testing.T) {
	t.Helper()
	if d.closed {
		return
	}
	d.closed = true
	_ = d.feed.Close()
	select {
	case <-d.done:
	case <-time.After(10 * time.Second):
		t.Error("助手没能在十秒内收尾")
	}
}

func (d *hostDriver) send(t *testing.T, value any) {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("编码命令失败：%v", err)
	}
	if _, err := d.feed.Write(append(body, '\n')); err != nil {
		t.Fatalf("写命令失败：%v", err)
	}
}

// waitFor 等到某一种事件；中途来的 error 一律当失败（那正是「命令不认识」的样子）。
func (d *hostDriver) waitFor(t *testing.T, kind string, timeout time.Duration) map[string]any {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case event, ok := <-d.events:
			if !ok {
				t.Fatalf("还没等到 %s，助手就结束了", kind)
			}
			if event["event"] == kind {
				return event
			}
			if event["event"] == "error" && kind != "error" {
				t.Fatalf("助手报错 %v（等的是 %s）", event["code"], kind)
			}
		case <-deadline:
			t.Fatalf("等不到 %s", kind)
		}
	}
}

// collect 收满 n 条某种事件；中途来的 error 一律当失败。
func (d *hostDriver) collect(t *testing.T, kind string, n int, timeout time.Duration) []map[string]any {
	t.Helper()
	got := make([]map[string]any, 0, n)
	deadline := time.After(timeout)
	for len(got) < n {
		select {
		case event, ok := <-d.events:
			if !ok {
				t.Fatalf("只等到 %d 条 %s，助手就结束了", len(got), kind)
			}
			if event["event"] == "error" {
				t.Fatalf("助手报错 %v（等的是 %s）", event["code"], kind)
			}
			if event["event"] == kind {
				got = append(got, event)
			}
		case <-deadline:
			t.Fatalf("只等到 %d 条 %s", len(got), kind)
		}
	}
	return got
}

// quiet 在一小段时间里确认没有多余事件：状态一问一台手机一条，多出来就是把同一台报了两次。
func (d *hostDriver) quiet(t *testing.T, window time.Duration) {
	t.Helper()
	select {
	case event := <-d.events:
		t.Fatalf("不该再多一条事件，却收到：%+v", event)
	case <-time.After(window):
	}
}

// startPhone 让一台「手机」会合一次，回它报出来的事件。
func (d *hostDriver) startPhone(t *testing.T, private, peerKey string) map[string]any {
	t.Helper()
	d.send(t, map[string]any{
		"command":       "p2pStart",
		"p2pPrivateKey": private,
		"p2pPeerKey":    peerKey,
		"p2pPeerPublic": []string{},
		"p2pPeerLocal":  []string{},
		"p2pListenPort": p2pPort,
		"p2pTargetPort": 19446,
	})
	return d.waitFor(t, "p2pReady", 60*time.Second)
}

// assertEventShape 钉事件里**恰好**有哪些键。
//
// 为什么要在 Go 这边钉插件的白名单：插件那条 IPC 是严格白名单，多一个键整条事件会被当
// 脏数据**静默丢掉**。给 `p2pReady` / `p2pStatus` 加 `peerKey` 时这一点最容易踩 —— 加对
// 了没人夸，加错一格就是「助手明明发了、插件就是等不到」，而且两边各自的测试都是绿的。
func assertEventShape(t *testing.T, event map[string]any, allowed ...string) {
	t.Helper()
	want := map[string]bool{"event": true}
	for _, key := range allowed {
		want[key] = true
	}
	for key := range event {
		if !want[key] {
			t.Fatalf("事件里多了一个插件不认的键 %q（整条会被当脏数据丢掉）：%+v", key, event)
		}
	}
	for key := range want {
		if _, ok := event[key]; !ok {
			t.Fatalf("事件里少了键 %q（插件会当脏数据丢掉）：%+v", key, event)
		}
	}
}

// 一台手机的两个事件各自该有的键（与插件 `host-process.cjs` 的 EVENT_KEYS 一致）。
var (
	p2pReadyKeys  = []string{"url", "candidates", "peerKey"}
	p2pStatusKeys = []string{"running", "url", "path", "active", "detail", "candidates", "peerKey"}
)

// TestHostUnderstandsP2PCommands 钉「命令认不认得」。
func TestHostUnderstandsP2PCommands(t *testing.T) {
	host := startHost(t)

	// 1. 生成密钥对：这是二维码里那一段身份的来源。
	host.send(t, map[string]any{"command": "p2pKeys"})
	keys := host.waitFor(t, "p2pKeys", 30*time.Second)
	if keys["private"] == "" || keys["public"] == "" {
		t.Fatalf("密钥对不完整：%+v", keys)
	}
	if int(keys["port"].(float64)) != p2pPort {
		t.Fatalf("报出来的隧道端口不对：%v", keys["port"])
	}

	// 2. 起电脑那一半：没有候选也要能起来（「只听不打」），并把本机地址报出来。
	host.send(t, map[string]any{
		"command":       "p2pStart",
		"p2pPrivateKey": keys["private"],
		// 对端公钥是配出来的：随便造一个 32 字节的 base64 即可，这里只验「这条命令认得、能起」。
		"p2pPeerKey":    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
		"p2pPeerPublic": []string{},
		"p2pPeerLocal":  []string{},
		"p2pListenPort": p2pPort,
		"p2pTargetPort": 19446,
	})
	ready := host.waitFor(t, "p2pReady", 60*time.Second)
	if ready["url"] == "" {
		t.Fatalf("起来了却没给本机地址：%+v", ready)
	}
	// 候选这一格必须在：手机靠它知道往哪打。没有它，两端永远打不到一起。
	if _, ok := ready["candidates"]; !ok {
		t.Fatalf("p2pReady 必须带 candidates：%+v", ready)
	}
	// 插件靠这一格把事件路由到对应手机：没有它，第二台手机一来就分不清是谁的。
	assertEventShape(t, ready, p2pReadyKeys...)

	// 3. 问一次现状：跑着的隧道要如实报，而且带着我自己的候选。
	host.send(t, map[string]any{"command": "p2pStatus"})
	status := host.waitFor(t, "p2pStatus", 30*time.Second)
	if status["running"] != true {
		t.Fatalf("隧道在跑，状态却说没跑：%+v", status)
	}
	if _, ok := status["candidates"]; !ok {
		t.Fatalf("p2pStatus 必须带 candidates：%+v", status)
	}
	assertEventShape(t, status, p2pStatusKeys...)

	// 4. 收尾：回一句「停了」，而且之后状态回到没在跑。
	host.send(t, map[string]any{"command": "p2pStop"})
	host.waitFor(t, "p2pStopped", 30*time.Second)
	host.send(t, map[string]any{"command": "p2pStatus"})
	stopped := host.waitFor(t, "p2pStatus", 30*time.Second)
	assertEventShape(t, stopped, "running", "url", "path", "active", "detail", "candidates")
	if stopped["running"] == true { t.Fatalf("停掉之后还说在跑：%+v", stopped) }
}

// 一条命令的形状：起一条隧道、问一次现状。
func (d *hostDriver) ask(t *testing.T, kind string) map[string]any {
	t.Helper()
	d.send(t, map[string]any{"command": kind})
	return d.waitFor(t, kind, 30*time.Second)
}

// TestHostServesSeveralPhones 钉「一台电脑同时接多台手机」：
//
//   - 两台不同公钥的手机先后会合，两条隧道**都在**，谁也不覆盖谁；
//   - 问一次现状要**一台一条**（两条事件、两条 peerKey），不是只报最后一条；
//   - 同一把公钥再来一次是**替换**自己那条：换到新句柄，旧句柄真的被 Stop 掉
//     （不留孤儿），别人那条一动不动。
func TestHostServesSeveralPhones(t *testing.T) {
	host := startHost(t)
	keys := host.ask(t, "p2pKeys")
	private, _ := keys["private"].(string)
	if private == "" {
		t.Fatalf("没拿到私钥：%+v", keys)
	}

	first, err := p2p.GenerateKeyPair()
	if err != nil {
		t.Fatalf("造第一台手机的公钥失败：%v", err)
	}
	second, err := p2p.GenerateKeyPair()
	if err != nil {
		t.Fatalf("造第二台手机的公钥失败：%v", err)
	}

	// 1. 两台手机先后会合。
	if ready := host.startPhone(t, private, first.Public); ready["peerKey"] != first.Public {
		t.Fatalf("第一台的事件没带自己的公钥：%+v", ready)
	}
	if ready := host.startPhone(t, private, second.Public); ready["peerKey"] != second.Public {
		t.Fatalf("第二台的事件没带自己的公钥：%+v", ready)
	}

	// 2. 问现状：两台都在，而且各自一条事件。**这一条就是「第二台把第一台踢了」的
	//    变异验证** —— 退回单变量实现时这里只会收到一条，超时红掉。
	host.send(t, map[string]any{"command": "p2pStatus"})
	reports := host.collect(t, "p2pStatus", 2, 30*time.Second)
	seen := map[string]bool{}
	for _, report := range reports {
		key, _ := report["peerKey"].(string)
		if key != first.Public && key != second.Public {
			t.Fatalf("状态里出现了不认识的公钥：%+v", report)
		}
		if report["running"] != true {
			t.Fatalf("两条隧道都在跑，状态却说没跑：%+v", report)
		}
		seen[key] = true
	}
	if !seen[first.Public] || !seen[second.Public] {
		t.Fatalf("两台手机没有都报到：%+v", reports)
	}
	host.quiet(t, 300*time.Millisecond)

	// 3. 第二台换个网络再来一次：还是两条，不是三条。
	host.startPhone(t, private, second.Public)
	host.send(t, map[string]any{"command": "p2pStatus"})
	reports = host.collect(t, "p2pStatus", 2, 30*time.Second)
	host.quiet(t, 300*time.Millisecond)
	if len(reports) != 2 {
		t.Fatalf("同一把公钥再来一次变成了三条隧道：%+v", reports)
	}

	// 4. 只停一台：另一台必须还在（按手机停，不是全停）。
	//
	//    停止回执携带 peerKey，插件不得把单台停止当作全停。
	host.send(t, map[string]any{"command": "p2pStop", "p2pPeerKey": first.Public})
	stopped := host.waitFor(t, "p2pStopped", 30*time.Second)
	assertEventShape(t, stopped, "peerKey")
	if stopped["peerKey"] != first.Public { t.Fatal("停止回执丢了 peerKey") }
	host.send(t, map[string]any{"command": "p2pStatus"})
	remaining := host.waitFor(t, "p2pStatus", 30*time.Second)
	if remaining["peerKey"] != second.Public || remaining["running"] != true {
		t.Fatalf("停了第一台，第二台也跟着没了：%+v", remaining)
	}
	host.quiet(t, 300*time.Millisecond)

	// 5. 最后全停（老形状、不带公钥）在收尾里：状态回到没在跑。
	host.send(t, map[string]any{"command": "p2pStop"})
	host.waitFor(t, "p2pStopped", 30*time.Second)
	host.send(t, map[string]any{"command": "p2pStatus"})
	if all := host.waitFor(t, "p2pStatus", 30*time.Second); all["running"] == true {
		t.Fatalf("全停之后还有隧道在跑：%+v", all)
	}
}

// TestHostShutdownStopsEveryTunnel 钉收尾那条路：助手退出时必须**把表里所有**隧道一起
// 收掉。加了「按手机停」之后最容易漏的就是这里 —— 只收了第一台，剩下的在进程退出前
// 一直挂着（进程没了句柄就跟着没了，但收尾顺序不对会让 device.Close 空转到超时）。
func TestHostShutdownStopsEveryTunnel(t *testing.T) {
	host := startHost(t)
	keys := host.ask(t, "p2pKeys")
	private, _ := keys["private"].(string)

	first, err := p2p.GenerateKeyPair()
	if err != nil {
		t.Fatalf("造手机公钥失败：%v", err)
	}
	second, err := p2p.GenerateKeyPair()
	if err != nil {
		t.Fatalf("造手机公钥失败：%v", err)
	}
	host.startPhone(t, private, first.Public)
	host.startPhone(t, private, second.Public)
	host.send(t, map[string]any{"command": "p2pStatus"})
	if reports := host.collect(t, "p2pStatus", 2, 30*time.Second); len(reports) != 2 {
		t.Fatalf("两条隧道该都在，实际报到 %d 条", len(reports))
	}

	// 关掉 stdin：这就是插件退出时助手看到的景象。等它真的收完尾再看表 —— 收尾是那条
	// 协程干的，提前去读是数据竞争（-race 会红，读到的多半还是没清完的中间状态）。
	host.shutdown(t)
	if len(p2pTunnels) != 0 {
		t.Fatalf("助手收尾了，隧道表里还剩 %d 条", len(p2pTunnels))
	}
}

// TestP2PUpsertStopsOldHandle 钉 upsert 的凭据：同一把公钥重来一次，**旧句柄必须真的
// 被 Stop 掉**，不能只把表里那一格换掉、把旧的留在 p2p 包的分发表里（那就是每换一次
// 网络漏一块 socket，两天下来几百个用户态栈）。
//
// 这一条直接调 startP2P（不经 Run），因为它要看句柄本身；走 IPC 只看得见事件。
func TestP2PUpsertStopsOldHandle(t *testing.T) {
	keys, err := p2p.GenerateKeyPair()
	if err != nil {
		t.Fatalf("造电脑自己的密钥失败：%v", err)
	}
	phone, err := p2p.GenerateKeyPair()
	if err != nil {
		t.Fatalf("造手机公钥失败：%v", err)
	}
	var out strings.Builder
	r := &runtime{ctx: context.Background(), out: &out}

	start := func() {
		t.Helper()
		if err := r.startP2P(command{
			P2PPrivateKey: keys.Private,
			P2PPeerKey:    phone.Public,
			P2PListenPort: p2pPort,
			P2PTargetPort: 19446,
		}); err != nil {
			t.Fatalf("起隧道失败：%v", err)
		}
	}
	t.Cleanup(stopP2P)

	start()
	key := p2pPeerID(phone.Public)
	oldHandle := p2pTunnels[key].handle
	if oldHandle == 0 {
		t.Fatalf("起来了却没登记句柄")
	}

	start()
	newHandle := p2pTunnels[key].handle
	if newHandle == oldHandle {
		t.Fatalf("同一把公钥重来一次还是旧句柄 %d：没有替换", newHandle)
	}
	if len(p2pTunnels) != 1 {
		t.Fatalf("同一把公钥重来一次应该只有一条，实际 %d 条", len(p2pTunnels))
	}
	// 旧句柄在 p2p 的分发表里必须已经没了 —— 这一格就是「有没有留下孤儿」。
	if old := p2p.Diagnose(oldHandle); !strings.Contains(old, p2p.ErrNoPeer) {
		t.Fatalf("旧句柄 %d 没被停掉，还留在分发表里：%s", oldHandle, old)
	}
	if now := p2p.Diagnose(newHandle); strings.Contains(now, p2p.ErrNoPeer) {
		t.Fatalf("新句柄 %d 没登记上：%s", newHandle, now)
	}
}

// 桌面出站 IPC 的真实生命周期：请求关联、密钥错误不回显、设备句柄互不影响。
package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	mobile "dshmobile.local/tailcat-host/mobile"
	"dshmobile.local/tailcat-host/p2p"
	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
)

func remoteRequest(t *testing.T, host *hostDriver, id, device, name string, fields map[string]any) map[string]any {
	t.Helper()
	if fields == nil {
		fields = map[string]any{}
	}
	fields["command"], fields["requestId"], fields["deviceId"] = name, id, device
	host.send(t, fields)
	event := host.waitFor(t, "remoteResult", 30*time.Second)
	if event["requestId"] != id {
		t.Fatalf("请求编号不对应：%v", event)
	}
	return event
}

func TestDesktopCommandsKeepRequestAndHideBadKey(t *testing.T) {
	host := startHost(t)
	capabilities := remoteRequest(t, host, "caps", "", "remoteCapabilities", nil)
	if capabilities["ok"] != true || capabilities["result"].(map[string]any)["p2p"] != true {
		t.Fatalf("缺少桌面能力：%v", capabilities)
	}
	keys := remoteRequest(t, host, "keys", "a", "remoteTailcatKey", nil)
	result := keys["result"].(map[string]any)
	if mobile.PublicKey(result["privateKey"].(string)) != result["publicKey"] {
		t.Fatal("Tailcat 公私钥不匹配")
	}
	secret := "private-secret-must-stay-local"
	bad := remoteRequest(t, host, "bad", "a", "remoteTailcatKey", map[string]any{"privateKey": secret})
	encoded, _ := json.Marshal(bad)
	if bad["ok"] != false || strings.Contains(string(encoded), secret) {
		t.Fatalf("错误响应泄露输入：%s", encoded)
	}
}

func TestDesktopP2PClientsCloseOnlyTheirOwnDevice(t *testing.T) {
	before := p2p.STUNServers
	p2p.STUNServers = []string{}
	defer func() { p2p.STUNServers = before }()
	host := startHost(t)
	ports := map[string]string{}
	for _, device := range []string{"a", "b"} {
		keys := remoteRequest(t, host, device+"-keys", device, "remoteP2PKeys", nil)["result"].(map[string]any)
		peer, err := p2p.GenerateKeyPair()
		if err != nil {
			t.Fatal(err)
		}
		started := remoteRequest(t, host, device+"-start", device, "remoteP2PStart", map[string]any{
			"p2pPrivateKey": keys["private"], "p2pPeerKey": peer.Public, "p2pListenPort": p2pPort,
		})
		if started["ok"] != true {
			t.Fatalf("客户端起不来：%v", started)
		}
		url := started["result"].(map[string]any)["url"].(string)
		ports[device] = strings.TrimPrefix(url, "http://")
		conn, err := net.DialTimeout("tcp", ports[device], time.Second)
		if err != nil {
			t.Fatalf("回环端口不可用：%v", err)
		}
		_ = conn.Close()
	}
	remoteRequest(t, host, "close-a", "a", "remoteClose", nil)
	if conn, err := net.DialTimeout("tcp", ports["a"], time.Second); err == nil {
		conn.Close()
		t.Fatal("关闭后 a 仍接受连接")
	}
	conn, err := net.DialTimeout("tcp", ports["b"], time.Second)
	if err != nil {
		t.Fatalf("关闭 a 误伤了 b：%v", err)
	}
	conn.Close()
	host.shutdown(t)
	if conn, err := net.DialTimeout("tcp", ports["b"], time.Second); err == nil {
		conn.Close()
		t.Fatal("助手退出后 b 仍接受连接")
	}
}

func TestDesktopTailcatClientsKeepSeparateListeners(t *testing.T) {
	host := startHost(t)
	serverKey := key.NewNode()
	address := (&tailcat.ConnInfo{
		ServerPublic: tailcat.NodePublic{NodePublic: serverKey.Public()}, ServerDiscoPublic: tailcat.DiscoPublicForNode(serverKey),
		Region: []*tailcfg.DERPRegion{{RegionID: 999, RegionCode: "local", Nodes: []*tailcfg.DERPNode{{Name: "local", RegionID: 999, HostName: "127.0.0.1", IPv4: "127.0.0.1", DERPPort: 9}}}},
	}).Addr()
	ports := map[string]string{}
	for _, device := range []string{"a", "b"} {
		started := remoteRequest(t, host, device+"-start", device, "remoteTailcatStart", map[string]any{
			"address": string(address), "privateKey": mobile.NewClientKey(), "remotePort": 48941,
		})
		if started["ok"] != true {
			t.Fatalf("Tailcat 客户端起不来：%v", started)
		}
		ports[device] = "127.0.0.1:" + strconv.Itoa(int(started["result"].(map[string]any)["port"].(float64)))
	}
	remoteRequest(t, host, "close-a", "a", "remoteTailcatStop", nil)
	if conn, err := net.DialTimeout("tcp", ports["a"], time.Second); err == nil {
		conn.Close()
		t.Fatal("Tailcat 停止后仍在监听")
	}
	conn, err := net.DialTimeout("tcp", ports["b"], time.Second)
	if err != nil {
		t.Fatalf("关闭 a 误伤了 Tailcat b：%v", err)
	}
	conn.Close()
	host.shutdown(t)
	if conn, err := net.DialTimeout("tcp", ports["b"], time.Second); err == nil {
		conn.Close()
		t.Fatal("助手退出后 Tailcat b 仍在监听")
	}
}

func TestDesktopTailcatClientRejectsInvalidAddress(t *testing.T) {
	host := startHost(t)
	answer := remoteRequest(t, host, "start", "a", "remoteTailcatStart", map[string]any{
		"address": "invalid", "privateKey": mobile.NewClientKey(), "remotePort": 48941,
	})
	if answer["ok"] != false || answer["code"] != "invalid-address" {
		t.Fatalf("应拒绝无效地址：%v", answer)
	}
}

func TestDesktopP2PForwardsRealHTTP(t *testing.T) {
	before := p2p.STUNServers
	p2p.STUNServers = []string{}
	defer func() { p2p.STUNServers = before }()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("desktop-ok")) })}
	go server.Serve(listener)
	defer server.Close()
	host := startHost(t)
	keys := remoteRequest(t, host, "keys", "a", "remoteP2PKeys", nil)["result"].(map[string]any)
	peer, err := p2p.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	accept, code := p2p.Start(p2p.Options{PrivateKey: peer.Private, PeerPublicKey: keys["public"].(string),
		ListenPort: p2pPort, TargetPort: listener.Addr().(*net.TCPAddr).Port, Mode: p2p.ModeAccept, STUN: []string{}})
	if code != "" {
		t.Fatal(code)
	}
	defer func() { p2p.Stop(accept) }()
	started := remoteRequest(t, host, "start", "a", "remoteP2PStart", map[string]any{
		"p2pPrivateKey": keys["private"], "p2pPeerKey": peer.Public, "p2pListenPort": p2pPort,
		"p2pPeerPublic": p2p.Candidates(accept),
	})
	if started["ok"] != true {
		t.Fatalf("客户端起不来：%v", started)
	}
	// A 收到 B 候选后会重建自己的接收 socket；B 保持原句柄，由 A 主动打向它。
	candidates := remoteRequest(t, host, "candidates", "a", "remoteP2PCandidates", nil)["result"].(map[string]any)["candidates"].([]any)
	peerCandidates := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		peerCandidates = append(peerCandidates, candidate.(string))
	}
	p2p.Stop(accept)
	accept, code = p2p.Start(p2p.Options{PrivateKey: peer.Private, PeerPublicKey: keys["public"].(string),
		PeerCandidates: peerCandidates, ListenPort: p2pPort, TargetPort: listener.Addr().(*net.TCPAddr).Port,
		Mode: p2p.ModeAccept, STUN: []string{}})
	if code != "" {
		t.Fatal(code)
	}
	client := &http.Client{Timeout: 15 * time.Second}
	response, err := client.Get(started["result"].(map[string]any)["url"].(string))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != 200 || string(body) != "desktop-ok" {
		t.Fatalf("HTTP 内容不对：status=%d body=%q err=%v", response.StatusCode, body, err)
	}
}

package dshmobile

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
	"tailscale.com/wgengine/filter"
)

const testPort = 49731

// 端到端：起一个 tailcat 服务端（就是电脑端助手做的事），再用这一包里的 Start 接上去，
// 从回环端口发一个真实的 HTTP 请求。它覆盖的是「手机那一半能不能用」这件事本身。
func TestStartServesHTTPThroughTunnel(t *testing.T) {
	serverKey := key.NewNode()
	server := &tailcat.Server{
		Key:            serverKey,
		PresharedKey:   tailcat.NewPresharedKey(),
		AllowedClients: []key.NodePublic{},
		ServedTCPPorts: []filter.PortRange{{First: testPort, Last: testPort}},
		OnTCP: func(port uint16) func(net.Conn) {
			if port != testPort {
				return nil
			}
			return func(conn net.Conn) {
				defer conn.Close()
				_, _ = conn.Write([]byte("HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok"))
			}
		},
		Logf: func(string, ...any) {},
	}
	clientKey := NewClientKey()
	clientPub := PublicKey(clientKey)
	var pub key.NodePublic
	if err := pub.UnmarshalText([]byte(clientPub)); err != nil || pub.IsZero() {
		t.Fatalf("公钥形状不对：%q", clientPub)
	}
	server.AllowedClients = []key.NodePublic{pub}
	if err := server.Start(); err != nil {
		t.Fatalf("服务端起不来：%v", err)
	}
	defer server.Close()

	answer := Start(string(server.TailcatAddr()), clientKey, testPort)
	var started struct {
		Handle int64  `json:"handle"`
		Port   int    `json:"port"`
		Error  string `json:"error"`
	}
	if err := json.Unmarshal([]byte(answer), &started); err != nil || started.Error != "" || started.Port == 0 {
		t.Fatalf("Start 回了个不能用的东西：%s", answer)
	}
	defer Stop(started.Handle)

	client := &http.Client{Timeout: 60 * time.Second}
	res, err := client.Get("http://127.0.0.1:" + itoa(started.Port) + "/")
	if err != nil {
		t.Fatalf("经回环端口请求失败：%v", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if strings.TrimSpace(string(body)) != "ok" {
		t.Fatalf("隧道里回来的内容不对：%q", string(body))
	}
}

func TestStartRejectsBadInput(t *testing.T) {
	cases := map[string]string{
		"空地址": Start("", NewClientKey(), 1),
		"坏地址": Start("tcnope", NewClientKey(), 1),
		"坏私钥": Start("tcnope", "privkey:zz", 1),
	}
	for name, answer := range cases {
		if !strings.Contains(answer, `"error"`) {
			t.Fatalf("%s：该拒绝却回了 %s", name, answer)
		}
	}
	if PublicKey("not-a-key") != "" {
		t.Fatal("坏私钥不该算出公钥")
	}
	if NewClientKey() == "" {
		t.Fatal("该生成一把私钥")
	}
}

func itoa(value int) string {
	digits := []byte{}
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

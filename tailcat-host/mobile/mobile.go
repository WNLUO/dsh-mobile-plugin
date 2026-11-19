// 手机侧的直连隧道客户端，编成安卓与苹果都能直接调的原生库（gomobile / xcframework）。
//
// 形状与电脑端相反：那边是「我听你的」，这边是「我去找一个地址」。手机拿到的是电脑给的
// tailcat 地址 + 一把长期私钥，这里把它变成一个**本机回环端口**——App 里那些请求代码一行
// 都不用改，还是照原样往 `http://127.0.0.1:<port>` 发，隧道负责把它们送到电脑上的插件。
//
// 为什么不用 TLS：隧道本身是 WireGuard，密文到电脑那一侧才落地；这中间唯一的明文段是
// 本进程内的回环。少一层 TLS 就少一套证书分发，与「扫码即用」直接相关。
//
// 跨语言边界只有字符串与整数，任何失败都回一个固定错误码，不回显输入、不带密钥材料。

package dshmobile

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"sync"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
)

var errInvalid = errors.New("invalid")

/** 一次拨号的预算：手机切网时这一发会卡住，给足但别无限等。 */
const dialTimeout = 10 * time.Second

/** 路径查询的预算：它要等电脑回一个 disco ping。 */
const pathTimeout = 3 * time.Second

/** 诊断的预算：中继通不通 + 电脑答不答，两件事并行，最多这么久。 */
const diagnoseTimeout = 8 * time.Second

/** NewClientKey 生成一把新的长期私钥（`privkey:…`），配对时用一次，之后存在设备凭据里。 */
func NewClientKey() string {
	text, err := key.NewNode().MarshalText()
	if err != nil {
		return ""
	}
	return string(text)
}

/** PublicKey 由私钥算出公钥（`nodekey:…`），配对时上报给电脑。 */
func PublicKey(private string) string {
	parsed, err := parseClientKey(private)
	if err != nil {
		return ""
	}
	text, err := parsed.Public().MarshalText()
	if err != nil {
		return ""
	}
	return string(text)
}

type session struct {
	client  *tailcat.Client
	forward *forward
	dial    func(context.Context) (net.Conn, error)
	once    sync.Once
}

var (
	registryMu sync.Mutex
	nextHandle int64 = 1
	sessions         = map[int64]*session{}
)

// Start 开一个本机回环端口，接到 address 这个 tailcat 节点上的 remotePort。
// 回 {"handle":n,"port":p} 或 {"error":"<码>"}。
func Start(address, clientKey string, remotePort int) string {
	if !validAddress(address) {
		return `{"error":"invalid-address"}`
	}
	private, err := parseClientKey(clientKey)
	if err != nil {
		return `{"error":"invalid-client-key"}`
	}
	if remotePort < 1 || remotePort > 65535 {
		return `{"error":"invalid-port"}`
	}
	client := &tailcat.Client{Server: tailcat.Addr(address), Key: private, Logf: func(string, ...any) {}}
	port := uint16(remotePort)
	opened, err := startForward(func(ctx context.Context) (net.Conn, error) {
		return client.DialTCPPort(ctx, port)
	})
	if err != nil {
		_ = client.Close()
		return `{"error":"bind-failed"}`
	}
	handle := register(&session{client: client, forward: opened})
	body, err := json.Marshal(struct {
		Handle int64 `json:"handle"`
		Port   int   `json:"port"`
	}{handle, opened.port()})
	if err != nil {
		Stop(handle)
		return `{"error":"start-failed"}`
	}
	return string(body)
}

// Stop 关掉这条隧道与它名下所有连接；重复调用是空操作。
func Stop(handle int64) int {
	registryMu.Lock()
	current := sessions[handle]
	delete(sessions, handle)
	registryMu.Unlock()
	if current != nil {
		current.close()
	}
	return 0
}

// Path 回 {"route":"direct"} / {"route":"relay","relay":"sfo"} / {"error":"…"}。
// 它只是给人看的一句话，失败不影响隧道本身。
func Path(handle int64) string {
	registryMu.Lock()
	current := sessions[handle]
	registryMu.Unlock()
	if current == nil {
		return `{"error":"unknown-handle"}`
	}
	ctx, cancel := context.WithTimeout(context.Background(), pathTimeout)
	defer cancel()
	result, err := current.client.DiscoPing(ctx)
	if err != nil || result.Err != "" {
		return `{"error":"unreachable"}`
	}
	if result.Endpoint != "" {
		return `{"route":"direct"}`
	}
	body, err := json.Marshal(struct {
		Route string `json:"route"`
		Relay string `json:"relay,omitempty"`
	}{"relay", result.DERPRegionCode})
	if err != nil {
		return `{"error":"unreachable"}`
	}
	return string(body)
}

// Diagnose 回答「哪一段不通」：中继能不能连、电脑答不答、延迟多少。手机侧说人话要用它。
func Diagnose(handle int64) string {
	registryMu.Lock()
	current := sessions[handle]
	registryMu.Unlock()
	if current == nil {
		return `{"error":"unknown-handle"}`
	}
	ctx, cancel := context.WithTimeout(context.Background(), diagnoseTimeout)
	defer cancel()
	type answer struct {
		latency time.Duration
		err     error
	}
	pinged := make(chan answer, 1)
	go func() {
		result, err := current.client.Ping(ctx)
		pinged <- answer{result.Latency, err}
	}()
	out := struct {
		Relay     string `json:"relay"`
		Computer  string `json:"computer"`
		LatencyMs *int64 `json:"latencyMs,omitempty"`
	}{"unreachable", "unreachable", nil}
	if result := <-pinged; result.err == nil {
		ms := result.latency.Milliseconds()
		out.Relay, out.Computer, out.LatencyMs = "reachable", "reachable", &ms
	}
	body, err := json.Marshal(out)
	if err != nil {
		return `{"error":"unreachable"}`
	}
	return string(body)
}

func validAddress(address string) bool {
	if address == "" || len(address) > 8192 {
		return false
	}
	info, err := tailcat.ParseAddr(tailcat.Addr(address))
	if err != nil {
		return false
	}
	return !info.ServerPublic.IsZero()
}

func parseClientKey(text string) (key.NodePrivate, error) {
	var private key.NodePrivate
	if err := private.UnmarshalText([]byte(text)); err != nil {
		return key.NodePrivate{}, err
	}
	if private.IsZero() {
		return key.NodePrivate{}, errInvalid
	}
	return private, nil
}

func register(current *session) int64 {
	registryMu.Lock()
	defer registryMu.Unlock()
	handle := nextHandle
	nextHandle++
	sessions[handle] = current
	return handle
}

func (s *session) close() {
	s.once.Do(func() {
		if s.forward != nil {
			s.forward.close()
		}
		if s.client != nil {
			_ = s.client.Close()
		}
	})
}

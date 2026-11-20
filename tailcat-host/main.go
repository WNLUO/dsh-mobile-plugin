// 手机入站与远程电脑出站隧道共用的助手，停止回执按设备隔离。
//
// 由移动端插件作为子进程拉起：stdin 第一行给配置，之后是命令；stdout 只写事件。
// 两条流都是 JSON 行，不混日志（日志走 stderr）。隧道里只开一个固定端口，进来
// 的连接一律转到本机回环的插件端口，所以插件不用为它改任何路由或鉴权。
//
// 鉴权只有一条：手机节点的公钥白名单。空名单时绝不起节点——tailcat 对空名单
// 是「放行所有人」，那等于把电脑上的 DSH 交给整个互联网。
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"

	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
)

const (
	protoVersion = 1
	lineLimit    = 64 * 1024
	maxAllowed   = 256
)

// 固定错误码：事件里只出现这些词，不回显输入、不带密钥材料。
const (
	errRequest   = "invalid-request"
	errVersion   = "invalid-version"
	errPort      = "invalid-port"
	errState     = "invalid-state"
	errAllowlist = "invalid-allowlist"
	errClientKey = "invalid-client-key"
	errCommand   = "invalid-command"
	errBusy      = "busy"
	errStart     = "start-failed"
)

type config struct {
	Version        int             `json:"version"`
	LocalPort      int             `json:"localPort"`
	Name           string          `json:"name"`
	State          json.RawMessage `json:"state"`
	AllowedClients []string        `json:"allowedClients"`
}

type command struct {
	Command        string   `json:"command"`
	ID             string   `json:"id"`
	OK             bool     `json:"ok"`
	AllowedClients []string `json:"allowedClients"`
	TTL            int      `json:"ttl"`

	RequestID  string `json:"requestId"`
	DeviceID   string `json:"deviceId"`
	PrivateKey string `json:"privateKey"`
	Address    string `json:"address"`
	RemotePort int    `json:"remotePort"`

	// 点对点隧道（P2P）那一组：电脑侧只负责在隧道里听，私钥与对端公钥都由插件给。
	P2PPrivateKey string   `json:"p2pPrivateKey"`
	P2PPeerKey    string   `json:"p2pPeerKey"`
	P2PPeerLocal  []string `json:"p2pPeerLocal"`
	P2PPeerPublic []string `json:"p2pPeerPublic"`
	// P2PListenPort 是对端在隧道里要拨的那个口（电脑在虚拟网卡上听它）；
	// P2PTargetPort 是本机插件真正在听的那个口（进来的连接转给它）。两件事，别混成一个。
	P2PListenPort int `json:"p2pListenPort"`
	P2PTargetPort int `json:"p2pTargetPort"`
}

// Option 给测试留缝：Start 为 nil 时用真的 tailcat 服务端。
type Option struct {
	Start   Starter
	Signals <-chan os.Signal
}

type runtime struct {
	ctx      context.Context
	cfg      config
	start    Starter
	out      io.Writer
	writeMu  sync.Mutex
	opMu     sync.Mutex
	serial   uint64
	pending  map[string]chan bool
	pendingM sync.Mutex
	jobs     chan func() error

	private key.NodePrivate
	psk     tailcat.PresharedKey
	region  *tailcfg.DERPRegion
	allowed []string
	normal  Running
	conns   *liveConns
	pairing *pairingWindow
	clients map[string]*desktopClient
}

func main() {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	if err := Run(os.Stdin, os.Stdout, Option{Signals: signals}); err != nil {
		fmt.Fprintln(os.Stderr, "tailcat-host:", err)
		os.Exit(1)
	}
}

// Run 读一行配置、再读命令，直到 stdin 关闭或收到信号。
func Run(in io.Reader, out io.Writer, opt Option) error {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 4096), lineLimit)
	fail := func(code string) error {
		_, _ = io.WriteString(out, `{"event":"error","code":"`+code+"\"}\n")
		return errors.New(code)
	}
	if !scanner.Scan() {
		return fail(errRequest)
	}
	var cfg config
	if json.Unmarshal(scanner.Bytes(), &cfg) != nil {
		return fail(errRequest)
	}
	if cfg.Version != protoVersion {
		return fail(errVersion)
	}
	if cfg.LocalPort < 1024 || cfg.LocalPort > 65534 {
		return fail(errPort)
	}
	if len(cfg.AllowedClients) > maxAllowed {
		return fail(errAllowlist)
	}
	if _, code := parseAllowlist(cfg.AllowedClients); code != "" {
		return fail(code)
	}
	state, code := parseState(cfg.State)
	if code != "" {
		return fail(code)
	}
	if state.private.IsZero() {
		state = freshState()
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	start := opt.Start
	if start == nil {
		start = realStart
	}
	r := &runtime{ctx: ctx, cfg: cfg, start: start, out: out, pending: map[string]chan bool{},
		jobs:    make(chan func() error, 64),
		private: state.private, psk: state.psk, region: state.region,
		allowed: append([]string(nil), cfg.AllowedClients...)}

	signals := opt.Signals
	if signals == nil {
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, syscall.SIGTERM, syscall.SIGINT)
		defer signal.Stop(ch)
		signals = ch
	}
	commands := make(chan command)
	go func() {
		defer close(commands)
		for scanner.Scan() {
			var cmd command
			if json.Unmarshal(scanner.Bytes(), &cmd) != nil {
				cancel()
				return
			}
			select {
			case commands <- cmd:
			case <-ctx.Done():
				return
			}
		}
	}()
	// 干活的那一条 goroutine：会动节点的活都排在它上面跑（见 launch 的注释）。
	jobsDone := make(chan struct{})
	go func() {
		defer close(jobsDone)
		for fn := range r.jobs {
			r.run(fn)
		}
	}()
	defer func() {
		cancel()
		close(r.jobs)
		<-jobsDone
		r.opMu.Lock()
		defer r.opMu.Unlock()
		if r.pairing != nil {
			r.pairing.close()
			r.pairing = nil
		}
		r.stopNormal()
		stopP2P()
		r.closeDesktopClients()
	}()

	// 已有白名单就先把正式节点拉起来；空名单只报一条 ready，不起节点。
	r.launch(func() error {
		if len(r.allowed) > 0 {
			if err := r.replaceNormal(r.allowed); err != nil {
				return err
			}
		}
		return r.emitReady()
	})

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-signals:
			return nil
		case cmd, ok := <-commands:
			if !ok {
				return nil
			}
			switch cmd.Command {
			case "ack":
				r.pendingM.Lock()
				ch := r.pending[cmd.ID]
				r.pendingM.Unlock()
				if ch != nil {
					select {
					case ch <- cmd.OK:
					default:
					}
				}
			case "pair":
				ttl := cmd.TTL
				r.launch(func() error { return r.beginPairing(ttl) })
			case "cancelPairing":
				r.launch(func() error {
					if r.pairing != nil {
						r.pairing.close()
						r.pairing = nil
					}
					return r.emit(map[string]any{"event": "pairingClosed"})
				})
			case "setAllowed":
				keys := append([]string{}, cmd.AllowedClients...)
				if len(keys) > maxAllowed {
					_ = r.emit(map[string]any{"event": "error", "code": errAllowlist})
					continue
				}
				if _, code := parseAllowlist(keys); code != "" {
					_ = r.emit(map[string]any{"event": "error", "code": code})
					continue
				}
				r.launch(func() error {
					if err := r.replaceNormal(keys); err != nil {
						return err
					}
					return r.emitReady()
				})
			case "p2pStart":
				cmd := cmd
				r.launch(func() error { return r.startP2P(cmd) })
			case "p2pStop":
				// 给了手机公钥就只停那一台；没给（老插件）就全停 —— 一台电脑可能同时
				// 接着好几台手机，为其中一台收尾不该把别人一起停掉。
				//
				// 按 peer 的回执带原公钥；无公钥保持全停形状。
				peer := strings.TrimSpace(cmd.P2PPeerKey)
				key := p2pPeerID(peer)
				r.launch(func() error {
					if key == "" {
						stopP2P()
					} else {
						stopP2PFor(key)
					}
					event := map[string]any{"event": "p2pStopped"}
					if peer != "" {
						event["peerKey"] = peer
					}
					return r.emit(event)
				})
			case "p2pStatus":
				r.launch(func() error { return r.emitP2PStatus() })
			case "p2pKeys":
				r.launch(func() error { return r.emitP2PKeys() })
			case "remoteCapabilities", "remoteTailcatKey", "remoteTailcatStart", "remoteTailcatStop", "remoteTailcatPath",
				"remoteP2PKeys", "remoteP2PStart", "remoteP2PStop", "remoteP2PCandidates", "remoteP2PPath", "remoteClose":
				cmd := cmd
				r.launch(func() error { return r.desktopCommand(cmd) })
			case "stop":
				return nil
			default:
				_ = r.emit(map[string]any{"event": "error", "code": errCommand})
			}
		}
	}
}

// launch 把一次会动网络的活排到工作队列上，由那条专用 goroutine 串行执行。
//
// **必须在队列上跑，不能在命令循环里跑**：白名单一变就要等插件那份 `persist` 的回执，
// 而回执是先由命令循环收下、再投给等待方的。循环里同步等，等于在等一条只有自己才能送进来
// 的回执 —— 每台手机第一次报名都会卡满 persistTimeout，然后报 persistence-timeout，地址
// 永远回不去（配对窗口那条路之所以没事，是因为它在 HTTP 的 goroutine 上，命令循环空着）。
func (r *runtime) launch(fn func() error) {
	select {
	case r.jobs <- fn:
	case <-r.ctx.Done():
	}
}

// run 是队列上真正干活的那一步：opMu 挡住「队列里的活」与「配对请求」同时改节点。
func (r *runtime) run(fn func() error) {
	r.opMu.Lock()
	defer r.opMu.Unlock()
	if r.ctx.Err() != nil {
		return
	}
	if err := fn(); err != nil {
		_ = r.emit(map[string]any{"event": "error", "code": err.Error()})
	}
}

func (r *runtime) emit(v any) error {
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	return json.NewEncoder(r.out).Encode(v)
}

func (r *runtime) emitReady() error {
	address := ""
	if r.normal != nil {
		address = r.normal.Address()
	}
	return r.emit(map[string]any{"event": "ready", "address": address})
}

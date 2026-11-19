// 配对窗口：两分钟的一次性小节点，只放行一把当场生成的钥匙。
//
// 手机扫码拿到的就是这个小节点：地址、那把一次性私钥、一个证明串。连上去只做一件事——
// 报上自己长期使用的公钥，换回正式节点的地址。换完窗口立刻作废，二维码从此没用。这样
// 即便码被人拍到，他能拿到的也只是一次性的、已经过期的门。
//
// 走的是 HTTP：手机那一侧只会发 `fetch`（React Native 里没有裸 TCP 客户端），而隧道
// 本身已经加密，回环这一跳再套 TLS 只是白加一套证书。一个 POST，一个 JSON 回来。

package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
)

const (
	pairingWindowDefault = 120 * time.Second
	pairingBodyLimit     = 4096
	pairingReadTimeout   = 5 * time.Second
)

const (
	pairExpired      = "expired"
	pairUnauthorized = "unauthorized"
	pairConflict     = "conflict"
	pairUnavailable  = "unavailable"
	pairInvalid      = "invalid"
)

type pairingWindow struct {
	node     Running
	listener *connListener
	server   *http.Server
	cancel   context.CancelFunc
	once     sync.Once
}

func (p *pairingWindow) close() {
	p.once.Do(func() {
		p.cancel()
		if p.server != nil {
			_ = p.server.Close()
		}
		p.listener.close()
		if p.node != nil {
			_ = p.node.Close()
		}
	})
}

// connListener 把 OnTCP 进来的连接变成一条可以直接 accept 的队列。
type connListener struct {
	conns chan net.Conn
	done  chan struct{}
	once  sync.Once
}

func newConnListener() *connListener {
	return &connListener{conns: make(chan net.Conn), done: make(chan struct{})}
}

func (l *connListener) offer(c net.Conn) {
	select {
	case l.conns <- c:
	case <-l.done:
		_ = c.Close()
	}
}

func (l *connListener) accept() (net.Conn, error) {
	select {
	case c := <-l.conns:
		return c, nil
	case <-l.done:
		return nil, errors.New("closed")
	}
}

func (l *connListener) close() { l.once.Do(func() { close(l.done) }) }

// tunnelListener 让 http.Server 能从一条条隧道连接上收请求。
type tunnelListener struct{ inner *connListener }

func (l tunnelListener) Accept() (net.Conn, error) { return l.inner.accept() }
func (l tunnelListener) Close() error              { l.inner.close(); return nil }
func (l tunnelListener) Addr() net.Addr            { return tunnelAddr{} }

type tunnelAddr struct{}

func (tunnelAddr) Network() string { return "tailcat" }
func (tunnelAddr) String() string  { return "tailcat" }

type pairingReply struct {
	V       int    `json:"v"`
	Address string `json:"address,omitempty"`
	Port    int    `json:"port,omitempty"`
	Name    string `json:"name,omitempty"`
	Error   string `json:"error,omitempty"`
}

// beginPairing 开一个配对窗口。调用方持有 opMu，本函数返回得快（节点起来就回）。
func (r *runtime) beginPairing(ttlSeconds int) error {
	ttl := pairingWindowDefault
	if ttlSeconds > 0 && ttlSeconds <= int(pairingWindowDefault/time.Second) {
		ttl = time.Duration(ttlSeconds) * time.Second
	}
	if r.pairing != nil {
		r.pairing.close()
		r.pairing = nil
	}
	client := key.NewNode()
	serverKey := key.NewNode()
	psk := tailcat.NewPresharedKey()
	proofBytes := make([]byte, 32)
	if _, err := rand.Read(proofBytes); err != nil {
		return errors.New(errStart)
	}
	proof := base64.RawURLEncoding.EncodeToString(proofBytes)
	expires := time.Now().Add(ttl)
	ctx, cancel := context.WithDeadline(r.ctx, expires)
	listener := newConnListener()
	window := &pairingWindow{listener: listener, cancel: cancel}

	node, err := r.start(ctx, Spec{
		Port: pairingPort, Key: serverKey, PSK: psk,
		Allowed: []key.NodePublic{client.Public()},
		OnTCP: func(port uint16) func(net.Conn) {
			if port != pairingPort {
				return nil
			}
			return func(conn net.Conn) { listener.offer(conn) }
		},
	})
	if err != nil {
		cancel()
		listener.close()
		return err
	}
	if node.Address() == "" {
		_ = node.Close()
		cancel()
		listener.close()
		return errors.New(errStart)
	}
	window.node = node
	server := &http.Server{Handler: r.pairingHandler(proof, expires, window), ReadHeaderTimeout: pairingReadTimeout}
	window.server = server
	r.pairing = window

	go func() { <-ctx.Done(); window.close() }()
	go func() { _ = server.Serve(tunnelListener{inner: listener}) }()

	clientText, err := client.MarshalText()
	if err != nil {
		return err
	}
	return r.emit(map[string]any{
		"event": "pairing", "address": node.Address(), "port": pairingPort,
		"key": string(clientText), "proof": proof, "expiresAt": expires.Unix(),
	})
}

// pairingHandler 只认一个 POST /pair：证明串在 Authorization 里，手机公钥在 body 里。
func (r *runtime) pairingHandler(proof string, expires time.Time, window *pairingWindow) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if req.URL.EscapedPath() != "/pair" || req.URL.RawQuery != "" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if req.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if subtle.ConstantTimeCompare([]byte(req.Header.Get("Authorization")), []byte("Bearer "+proof)) != 1 {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		body, err := io.ReadAll(io.LimitReader(req.Body, pairingBodyLimit+1))
		if err != nil || len(body) > pairingBodyLimit {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var request struct {
			PhoneKey string `json:"phoneKey"`
		}
		if json.Unmarshal(body, &request) != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		reply := r.authorizePairing(req.Context(), request.PhoneKey, expires, window)
		status := http.StatusOK
		switch reply.Error {
		case "":
			status = http.StatusOK
		case pairExpired:
			status = http.StatusGone
		case pairUnauthorized:
			status = http.StatusUnauthorized
		case pairConflict:
			status = http.StatusConflict
		case pairInvalid:
			status = http.StatusBadRequest
		default:
			status = http.StatusServiceUnavailable
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(reply)
	})
}

// authorizePairing 把手机公钥加进白名单（必要时重启正式节点），回正式节点地址。
func (r *runtime) authorizePairing(ctx context.Context, phoneKey string, expires time.Time, window *pairingWindow) pairingReply {
	fail := func(code string) pairingReply { return pairingReply{V: 1, Error: code} }
	var pub key.NodePublic
	if pub.UnmarshalText([]byte(phoneKey)) != nil || pub.IsZero() {
		return fail(pairInvalid)
	}
	phone := pub.String()

	r.opMu.Lock()
	defer r.opMu.Unlock()
	if r.pairing != window || ctx.Err() != nil || !time.Now().Before(expires) {
		return fail(pairExpired)
	}
	keys := append([]string(nil), r.allowed...)
	found := false
	for _, existing := range keys {
		if existing == phone {
			found = true
			break
		}
	}
	if !found {
		if len(keys) >= maxAllowed {
			return fail(pairUnavailable)
		}
		keys = append(keys, phone)
	}
	if r.normal == nil || !found {
		if err := r.replaceNormal(keys); err != nil {
			return fail(pairUnavailable)
		}
	}
	if r.normal == nil {
		return fail(pairUnavailable)
	}
	if err := r.emit(map[string]any{"event": "paired", "address": r.normalAddress(), "client": phone}); err != nil {
		return fail(pairUnavailable)
	}
	return pairingReply{V: 1, Address: r.normalAddress(), Port: virtualPort, Name: r.cfg.Name}
}

func (r *runtime) normalAddress() string {
	if r.normal == nil {
		return ""
	}
	return r.normal.Address()
}

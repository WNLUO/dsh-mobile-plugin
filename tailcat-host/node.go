// 节点：把 tailcat 服务端拉起来、只开一个虚拟端口、把进来的连接转给本机插件。
//
// 两件事必须一直成立：
//   1. 白名单为空绝不起节点（tailcat 对空名单放行所有人）；
//   2. 节点重启之后地址对外不变——私钥、预共享密钥、区域都从插件存的那份恢复。
//
// 白名单变了就整体重启节点：tailcat v0.7 没有「踢掉某一把钥匙」的接口，重启是
// 唯一能让吊销立刻生效的做法（已建立的连接一并断掉）。

package main

import (
	"context"
	"errors"
	"io"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
	"tailscale.com/wgengine/filter"
)

const (
	// virtualPort 是隧道里唯一开放的端口：手机拨它，等于拨插件。
	virtualPort = 48941
	// pairingPort 是配对窗口用的临时端口，只在开窗口的那两分钟存在。
	pairingPort = 48942
	// persistTimeout：插件要把状态写进自己的存储，等它的回执。
	persistTimeout = 10 * time.Second
)

// Spec 是要拉起来的那个 tailcat 服务端。Region 为 nil 表示让 tailcat 自己选。
type Spec struct {
	Port    uint16
	Key     key.NodePrivate
	PSK     tailcat.PresharedKey
	Region  *tailcfg.DERPRegion
	Allowed []key.NodePublic
	OnTCP   func(uint16) func(net.Conn)
}

// Running 是一个已经起来的节点。
type Running interface {
	Address() string
	Region() *tailcfg.DERPRegion
	Close() error
}

// Starter 负责把节点拉起来；测试替换它。
type Starter func(context.Context, Spec) (Running, error)

type tailServer struct {
	server *tailcat.Server
	region *tailcfg.DERPRegion
	addr   string
}

func (s *tailServer) Address() string             { return s.addr }
func (s *tailServer) Region() *tailcfg.DERPRegion { return s.region }
func (s *tailServer) Close() error                { return s.server.Close() }

func realStart(ctx context.Context, spec Spec) (Running, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if len(spec.Allowed) == 0 {
		return nil, errors.New(errAllowlist)
	}
	port := spec.Port
	if port == 0 {
		port = virtualPort
	}
	server := &tailcat.Server{
		Key:            spec.Key,
		PresharedKey:   spec.PSK,
		Region:         spec.Region,
		AllowedClients: spec.Allowed,
		OnTCP:          spec.OnTCP,
		ServedTCPPorts: []filter.PortRange{{First: port, Last: port}},
		Logf:           func(string, ...any) {},
	}
	errs := make(chan error, 1)
	go func() { errs <- server.Start() }()
	select {
	case <-ctx.Done():
		go func() {
			if err := <-errs; err == nil {
				_ = server.Close()
			}
		}()
		return nil, ctx.Err()
	case err := <-errs:
		if err != nil {
			return nil, err
		}
		if ctx.Err() != nil {
			_ = server.Close()
			return nil, ctx.Err()
		}
		info, err := tailcat.ParseAddr(server.TailcatAddr())
		if err != nil || len(info.Region) != 1 || info.Region[0] == nil || info.Region[0].RegionID == 0 {
			_ = server.Close()
			return nil, errors.New(errStart)
		}
		return &tailServer{server: server, region: info.Region[0], addr: string(server.TailcatAddr())}, nil
	}
}

// serveTunnel 只认那一个端口，其余一律不接（回了 nil 就是 RST）。
func serveTunnel(localPort int, conns *liveConns) func(uint16) func(net.Conn) {
	return func(port uint16) func(net.Conn) {
		if port != virtualPort {
			return nil
		}
		return func(client net.Conn) { proxyLoopback(client, localPort, conns) }
	}
}

func proxyLoopback(client net.Conn, localPort int, conns *liveConns) {
	defer client.Close()
	remote, err := conns.dial(localPort)
	if err != nil {
		return
	}
	defer conns.done(remote)
	var wg sync.WaitGroup
	wg.Add(2)
	pipe := func(dst, src net.Conn) {
		defer wg.Done()
		_, _ = io.Copy(dst, src)
		_ = dst.Close()
	}
	go pipe(remote, client)
	go pipe(client, remote)
	wg.Wait()
}

// liveConns 记住这个节点转出去的每一条回环连接，关节点时一起切断。
type liveConns struct {
	ctx    context.Context
	cancel context.CancelFunc
	mu     sync.Mutex
	items  map[net.Conn]struct{}
	once   sync.Once
}

func newLiveConns(parent context.Context) (*liveConns, context.Context) {
	ctx, cancel := context.WithCancel(parent)
	return &liveConns{ctx: ctx, cancel: cancel, items: map[net.Conn]struct{}{}}, ctx
}

func (l *liveConns) dial(port int) (net.Conn, error) {
	conn, err := (&net.Dialer{}).DialContext(l.ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.ctx.Err() != nil {
		_ = conn.Close()
		return nil, l.ctx.Err()
	}
	l.items[conn] = struct{}{}
	return conn, nil
}

func (l *liveConns) done(conn net.Conn) {
	_ = conn.Close()
	l.mu.Lock()
	delete(l.items, conn)
	l.mu.Unlock()
}

func (l *liveConns) close() {
	l.once.Do(func() {
		l.cancel()
		l.mu.Lock()
		defer l.mu.Unlock()
		for conn := range l.items {
			_ = conn.Close()
		}
	})
}

// stopNormal 关掉正式节点与它名下所有回环连接。
func (r *runtime) stopNormal() {
	if r.conns != nil {
		r.conns.close()
		r.conns = nil
	}
	if r.normal != nil {
		_ = r.normal.Close()
		r.normal = nil
	}
}

func (r *runtime) startNormal(keys []string) error {
	allowed, code := parseAllowlist(keys)
	if code != "" {
		return errors.New(code)
	}
	conns, ctx := newLiveConns(r.ctx)
	node, err := r.start(ctx, Spec{
		Key: r.private, PSK: r.psk, Region: r.region, Allowed: allowed,
		OnTCP: serveTunnel(r.cfg.LocalPort, conns),
	})
	if err != nil {
		conns.close()
		return err
	}
	if node.Region() == nil || node.Region().RegionID == 0 || node.Address() == "" {
		_ = node.Close()
		conns.close()
		return errors.New(errStart)
	}
	r.normal, r.conns, r.region = node, conns, node.Region()
	return nil
}

// replaceNormal 用新的白名单重启节点（空名单就是停掉），然后把这笔改动交给插件存。
// 调用方必须已经持有 opMu。
func (r *runtime) replaceNormal(keys []string) error {
	previous := append([]string(nil), r.allowed...)
	had := r.normal != nil
	r.stopNormal()
	var err error
	if len(keys) > 0 {
		err = r.startNormal(keys)
	}
	if err == nil {
		err = r.persist(keys)
	}
	if err != nil {
		r.stopNormal()
		if had && len(previous) > 0 {
			_ = r.startNormal(previous)
		}
		return err
	}
	r.allowed = append([]string(nil), keys...)
	return nil
}

// persist 请插件把这份状态存下来，等它回执。回执到之前不算生效。
func (r *runtime) persist(keys []string) error {
	var text any
	if r.region != nil {
		marshaled, err := marshalState(r.private, r.psk, r.region)
		if err != nil {
			return err
		}
		text = marshaled
	}
	r.serial++
	id := strconv.FormatUint(r.serial, 10)
	waiter := make(chan bool, 1)
	r.pendingM.Lock()
	r.pending[id] = waiter
	r.pendingM.Unlock()
	defer func() {
		r.pendingM.Lock()
		delete(r.pending, id)
		r.pendingM.Unlock()
	}()
	if keys == nil {
		keys = []string{}
	}
	if err := r.emit(map[string]any{"event": "persist", "id": id, "state": text, "allowedClients": keys}); err != nil {
		return err
	}
	timer := time.NewTimer(persistTimeout)
	defer timer.Stop()
	select {
	case ok := <-waiter:
		if ok {
			return nil
		}
		return errors.New("persistence-rejected")
	case <-r.ctx.Done():
		return r.ctx.Err()
	case <-timer.C:
		return errors.New("persistence-timeout")
	}
}

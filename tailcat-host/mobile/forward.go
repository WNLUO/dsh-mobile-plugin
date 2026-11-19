// 本机回环转发：给 App 一个固定的 `http://127.0.0.1:<port>`，每条连接再穿隧道。
//
// 手机侧的请求代码不知道隧道存在——它只会往这个回环端口发，和走局域网时一模一样。拨号是
// 按需的：没有任何连接时不碰网络，所以把隧道常驻着也不费流量。

package dshmobile

import (
	"context"
	"io"
	"net"
	"sync"
)

type forward struct {
	listener net.Listener
	ctx      context.Context
	cancel   context.CancelFunc
	mu       sync.Mutex
	closed   bool
	active   map[net.Conn]bool
	wg       sync.WaitGroup
	once     sync.Once
}

func startForward(dial func(context.Context) (net.Conn, error)) (*forward, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	f := &forward{listener: listener, ctx: ctx, cancel: cancel, active: make(map[net.Conn]bool)}
	f.wg.Add(1)
	go func() {
		defer f.wg.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			if !f.track(conn) {
				_ = conn.Close()
				return
			}
			f.wg.Add(1)
			go f.serve(conn, dial)
		}
	}()
	return f, nil
}

func (f *forward) port() int {
	if address, ok := f.listener.Addr().(*net.TCPAddr); ok {
		return address.Port
	}
	return 0
}

func (f *forward) track(conn net.Conn) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return false
	}
	f.active[conn] = true
	return true
}

func (f *forward) untrack(conn net.Conn) {
	_ = conn.Close()
	f.mu.Lock()
	delete(f.active, conn)
	f.mu.Unlock()
}

func (f *forward) serve(local net.Conn, dial func(context.Context) (net.Conn, error)) {
	defer f.wg.Done()
	defer f.untrack(local)
	ctx, cancel := context.WithTimeout(f.ctx, dialTimeout)
	defer cancel()
	remote, err := dial(ctx)
	if err != nil {
		return
	}
	if !f.track(remote) {
		_ = remote.Close()
		return
	}
	defer f.untrack(remote)
	var copying sync.WaitGroup
	copying.Add(2)
	pipe := func(dst, src net.Conn) {
		defer copying.Done()
		_, _ = io.Copy(dst, src)
		if half, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = half.CloseWrite()
		} else {
			_ = dst.Close()
		}
	}
	go pipe(remote, local)
	go pipe(local, remote)
	copying.Wait()
}

func (f *forward) close() {
	f.once.Do(func() {
		f.cancel()
		_ = f.listener.Close()
		f.mu.Lock()
		f.closed = true
		for conn := range f.active {
			_ = conn.Close()
		}
		f.mu.Unlock()
		f.wg.Wait()
	})
}

// 电脑侧的点对点隧道（P2P）：在隧道里听，进来什么就转给本机插件。
//
// 这一半刻意做得很薄：私钥、对端公钥、候选、端口全都由插件通过 IPC 交进来，助手自己
// 不生成任何身份、也不决定「该不该开」——白名单与配对窗口那套判断留在插件里，和
// tailcat 那条一模一样。
//
// 它按**手机公钥**持有一张隧道表：一台电脑可以同时接多台手机。键是公钥，所以「同一台
// 手机再来会合」是替换自己那条（换网络、候选变了都会重来一次），「另一台手机来会合」
// 只新增自己那一条，谁都不踢谁。每条隧道各自一块 socket、各自一个用户态栈，所以隧道里
// 那个固定端口（p2pPort）在各自栈里互不冲突，不需要动态分配。
//
// 事件都带 `peerKey`：插件靠它把 `p2pReady` / `p2pStatus` 路由到对应那台手机。
package main

import (
	"encoding/base64"
	"encoding/hex"
	"strings"

	"dshmobile.local/tailcat-host/p2p"
)

// p2pTunnel 是表里的一条：句柄，以及插件交进来的**原样**公钥。
//
// 原样存一份是因为事件要把它原样带回去做路由 —— 插件盘上存的是它自己交进来的那个写法，
// 归一化只用于查表。
type p2pTunnel struct {
	handle int64
	peer   string
}

// p2pTunnels 是当前活着的隧道表，键 = 归一化后的手机公钥。
//
// 用包级变量而不是放进 runtime：这张表就是助手全部的 P2P 状态。读写都在 jobs 队列上
// （`launch` → `opMu` 串行），所以不另加锁。
var p2pTunnels = map[string]p2pTunnel{}

// p2pPort 是电脑在隧道里听的那个端口。与手机侧 `p2p-tunnel` 记的 `port` 同一个数，
// 也是插件 `lib/p2p/session.cjs` 里 `P2P_PORT` 的同一个值。多台手机共用这个数：每条
// 隧道有自己的用户态栈，同一个端口号在各自栈里是各自的一个口。
const p2pPort = 48950

// p2pPeerID 把公钥折成同一个写法再做键。
//
// p2p 包的 `parseKey` 同时认 base64 与 hex 两种写法；同一台手机若以另一种写法再来一次，
// 不归一化就会变成第二条隧道（两块 socket 抢同一个对端，谁都打不通）。
func p2pPeerID(key string) string {
	text := strings.TrimSpace(key)
	if len(text) == 44 {
		if raw, err := base64.StdEncoding.DecodeString(text); err == nil && len(raw) == 32 {
			return base64.StdEncoding.EncodeToString(raw)
		}
	}
	if len(text) == 64 {
		if raw, err := hex.DecodeString(text); err == nil && len(raw) == 32 {
			return base64.StdEncoding.EncodeToString(raw)
		}
	}
	return text
}

// startP2P 按插件给的信息拉起电脑侧那一半，按手机公钥 upsert。
//
// 两个端口是**两件事**，别混：`cmd.P2PListenPort` 是对端（手机）在隧道里要拨的那个口，
// 由这里在虚拟网卡上监听；`cmd.P2PTargetPort` 是本机插件真正在听的那个口，进来的连接
// 转给它。早先只传了一个数、两个用途共用，于是电脑在一个端口上听、却指望手机拨另一个。
func (r *runtime) startP2P(cmd command) error {
	key := p2pPeerID(cmd.P2PPeerKey)
	peer := strings.TrimSpace(cmd.P2PPeerKey)
	// **只收掉自己那条**：早先这里是无条件全停，第二台手机来会合就把第一台踢掉。
	// 同一台手机重来一次仍要换一条 —— 手机每轮起来的 socket 端口都是新的，旧那条的
	// 候选已经作废，留着只会两个洞互相让路。
	stopP2PFor(key)
	handle, code := p2p.Start(p2p.Options{
		PrivateKey:          cmd.P2PPrivateKey,
		PeerPublicKey:       peer,
		PeerCandidates:      cmd.P2PPeerPublic,
		PeerLocalCandidates: cmd.P2PPeerLocal,
		ListenPort:          cmd.P2PListenPort,
		TargetPort:          cmd.P2PTargetPort,
		Mode:                p2p.ModeAccept,
	})
	if code != "" {
		return r.emit(map[string]any{"event": "error", "code": code})
	}
	p2pTunnels[key] = p2pTunnel{handle: handle, peer: peer}
	// 报「本机这半边起来了」，**并带上我自己的候选**：对端拿到这份才会知道往哪打。
	// 不给候选，对端只能空等 —— 这条通道永远通不了。`peerKey` 让插件知道这是给哪台手机的。
	return r.emit(map[string]any{
		"event":      "p2pReady",
		"peerKey":    peer,
		"url":        p2p.LocalURL(handle),
		"candidates": p2p.Candidates(handle),
	})
}

// stopP2PFor 收掉某一台手机那条；没有也是正常情况。
func stopP2PFor(key string) bool {
	item, ok := p2pTunnels[key]
	if !ok {
		return false
	}
	delete(p2pTunnels, key)
	p2p.Stop(item.handle)
	return true
}

// stopP2P 收掉表里**全部**隧道。进程收尾走这一条。
func stopP2P() {
	for key, item := range p2pTunnels {
		delete(p2pTunnels, key)
		p2p.Stop(item.handle)
	}
}

// emitP2PKeys 生成一对新密钥并报出去（插件存住，之后一直用同一对）。
//
// 密钥的生成留在 Go 这一侧：它是唯一一处懂 WireGuard 密钥格式的地方，插件与 App 都只管
// 存与转发。两端各生成一半，谁都不需要第三方替它保管。
func (r *runtime) emitP2PKeys() error {
	pair, err := p2p.GenerateKeyPair()
	if err != nil {
		return r.emit(map[string]any{"event": "error", "code": "invalid-key"})
	}
	return r.emit(map[string]any{
		"event":   "p2pKeys",
		"private": pair.Private,
		"public":  pair.Public,
		"port":    p2pPort,
	})
}

// emitP2PStatus 如实报每条隧道此刻的现场，**一台手机一条事件**。
//
// 一台都没有时回一条老形状的 `running: false`（没有对端可写进 peerKey）。有多条时一条
// 事件只说得清一条，硬塞成一格数组会改掉插件与 App 认的形状。
func (r *runtime) emitP2PStatus() error {
	if len(p2pTunnels) == 0 {
		return r.emit(map[string]any{"event": "p2pStatus", "running": false})
	}
	for _, item := range p2pTunnels {
		path := p2p.Path(item.handle)
		if err := r.emit(map[string]any{
			"event":   "p2pStatus",
			"peerKey": item.peer,
			"running": true,
			"url":     p2p.LocalURL(item.handle),
			"path":    path,
			// 只有真打通了才算「可用」：打洞没成功时这条通道不该被当成一条能走的路。
			"active":     path == "direct",
			"detail":     strings.TrimSpace(p2p.Diagnose(item.handle)),
			"candidates": p2p.Candidates(item.handle),
		}); err != nil {
			return err
		}
	}
	return nil
}

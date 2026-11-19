// 手机侧的点对点隧道（P2P）：给安卓与苹果各一套可以直接调的入口。
//
// 形状与 tailcat 那半边一致：进去字符串、出来字符串，跨语言边界上只有基本类型，
// 任何失败都回一个固定错误码，不回显输入、不带密钥材料。
//
// 与 tailcat 的区别只有一处：那边是「我去找一个地址，对面是中继 + 电脑」，这边是
// 「我直接往对方的公网地址打洞」。所以这里的参数多了一份对端候选清单 —— 那份是手机
// 从电脑那儿通过**已经通着的那条通道**拿到的，不是我们架的服务给的。
//
// 2026-11：`P2PPath` 的 `direct` 收紧了 —— 它现在要 WireGuard 握手真的写下过一笔
// （`latest_handshake_time`）才算，不再把「收到探测包」当成数据面通。对外仍然只有
// `direct / failed / punching / waiting` 四个词，插件与 App 的读法不用动。

package dshmobile

import (
	"encoding/json"

	"dshmobile.local/tailcat-host/p2p"
)

// P2PStart 拉起一条点对点隧道，回 `{"handle":n,"url":"http://127.0.0.1:p"}` 或 `{"error":"<码>"}`。
//
// privateKey 是本端的 WireGuard 私钥，配对时生成、跟设备凭据一起存在手机上；
// peerKey 是电脑的公钥；peerCandidate* 是电脑给的候选（逗号分隔），一律当不可信数据。
func P2PStart(privateKey, peerKey, peerCandidates, peerLocalCandidates string, listenPort int) string {
	handle, code := p2p.Start(p2p.Options{
		PrivateKey:          privateKey,
		PeerPublicKey:       peerKey,
		PeerCandidates:      splitList(peerCandidates),
		PeerLocalCandidates: splitList(peerLocalCandidates),
		ListenPort:          listenPort,
		Mode:                p2p.ModeDial,
	})
	if code != "" {
		return `{"error":"` + code + `"}`
	}
	// 回 `candidates`：手机要把这份报给电脑，电脑才知道往哪打洞。没有它，只能单向等。
	raw, err := json.Marshal(map[string]any{
		"handle":     handle,
		"url":        p2p.LocalURL(handle),
		"candidates": p2p.Candidates(handle),
	})
	if err != nil {
		p2p.Stop(handle)
		return `{"error":"` + p2p.ErrStart + `"}`
	}
	return string(raw)
}

// P2PStop 收掉一条隧道；回 1 表示确实停了一条。
func P2PStop(handle int64) int {
	return p2p.Stop(handle)
}

// P2PPath 报打通了没有：`direct` / `failed` / `punching` / `waiting` / `unknown`。
//
// 这条是纯本地查询（读字段、必要时读一次 WireGuard 回执），毫秒级返回，不必异步 ——
// 与 tailcat 的 path 不同，那个要等电脑回一个 ping。
//
// **`direct` 的含义是「数据面真的通了」**：只有 WireGuard 握过手才置上。打洞的洞开着
// 但握手没落定时报 `punching`；打不通报 `failed`（不伪装成通）。
func P2PPath(handle int64) string {
	return p2p.Path(handle)
}

// P2PDiagnose 报一条隧道的现场，形状是 JSON 字符串。
func P2PDiagnose(handle int64) string {
	return p2p.Diagnose(handle)
}

// P2PKeyPair 生成一对新密钥，回 `{"private":"…","public":"…"}`。
//
// 配对时手机生成一对、把公钥报给电脑、私钥自己留着。电脑那头也生成一对、把公钥还给
// 手机。两端各持一半，谁都不需要第三方替它们保管密钥。
func P2PKeyPair() string {
	pair, err := p2p.GenerateKeyPair()
	if err != nil {
		return `{"error":"` + p2p.ErrKey + `"}`
	}
	raw, err := json.Marshal(pair)
	if err != nil {
		return `{"error":"` + p2p.ErrKey + `"}`
	}
	return string(raw)
}

// P2PPublicKey 由私钥推公钥，回 `{"public":"…"}` 或 `{"error":"<码>"}`。
//
// 给**已经配过对、但没存下公钥**的那批设备补一把：公钥本来就在私钥里，重新算一次即可，
// 不必让用户重新扫码。只传公钥出去，私钥不出这个函数。
func P2PPublicKey(privateKey string) string {
	public, err := p2p.PublicFromPrivate(privateKey)
	if err != nil {
		return `{"error":"` + p2p.ErrKey + `"}`
	}
	raw, err := json.Marshal(map[string]any{"public": public})
	if err != nil {
		return `{"error":"` + p2p.ErrKey + `"}`
	}
	return string(raw)
}

// splitList 把逗号分隔的候选拆开，顺手丢掉空项。
//
// 空项必须丢：`"a,,b"` 拆出来中间那个空串会一路传到解地址那一步，虽然那边也会跳过，
// 但让无效数据多走一层没有好处。
func splitList(text string) []string {
	if text == "" {
		return nil
	}
	out := make([]string, 0, 4)
	start := 0
	for i := 0; i <= len(text); i++ {
		if i == len(text) || text[i] == ',' {
			if item := text[start:i]; item != "" {
				out = append(out, item)
			}
			start = i + 1
		}
	}
	return out
}

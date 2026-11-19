// 安卓 App 里补一份网络接口信息，让 tailscale 的网络监视（netmon）能建起来。
//
// 安卓普通应用拿不到路由表：内核拒绝 App UID 的 NETLINK_ROUTE 请求，Go 的 net.Interfaces
// 直接报 permission denied，netmon 一创建就失败，隧道拨号 0 毫秒就挂——这就是「未连通」的根。
// 官方安卓 App 是从 Java 侧把接口列表喂进去的；我们这份库没有那层 Java，所以在这里自己造：
// 拨一个 UDP 套接字（不发任何包）让内核挑出本机出口的 v4/v6 源地址，合成一条接口当兜底。
// 只有在 net.Interfaces 失败、且确实跑在安卓上时才生效，其它平台原样不动。
//
// 依据 tailscale 自带的 androidbin 兜底（同样思路），这里为 cgo 的安卓 App 构建复用。
package dshmobile

import (
	"errors"
	"net"
	"net/netip"
	"runtime"
	"time"

	"tailscale.com/feature"
	"tailscale.com/net/netmon"
)

func init() {
	if runtime.GOOS != "android" {
		return
	}
	if !feature.Register("dshandroidnet") {
		return
	}
	netmon.HookInterfacesFallback.Set(androidFallbackInterfaces)
}

// androidFallbackInterfaces 只在 net.Interfaces 已经失败后被调用。
func androidFallbackInterfaces() ([]netmon.Interface, error) {
	var addrs []net.Addr
	if ip, ok := outboundIP("udp4", "8.8.8.8:53"); ok {
		addrs = append(addrs, &net.IPNet{IP: ip.AsSlice(), Mask: net.CIDRMask(32, 32)})
	}
	if ip, ok := outboundIP("udp6", "[2001:4860:4860::8888]:53"); ok {
		addrs = append(addrs, &net.IPNet{IP: ip.AsSlice(), Mask: net.CIDRMask(128, 128)})
	}
	if len(addrs) == 0 {
		return nil, errors.New("dshmobile: android 兜底找不到出口路由")
	}
	return []netmon.Interface{{
		Interface: &net.Interface{
			MTU:   1500,
			Name:  "android",
			Flags: net.FlagUp | net.FlagRunning,
		},
		AltAddrs: addrs,
	}}, nil
}

// outboundIP 拨一个 UDP 套接字，取内核为本机挑的源地址；不做任何 I/O，安卓沙箱里也能用。
func outboundIP(network, addr string) (netip.Addr, bool) {
	d := net.Dialer{Timeout: 2 * time.Second}
	c, err := d.Dial(network, addr)
	if err != nil {
		return netip.Addr{}, false
	}
	defer c.Close()
	ua, ok := c.LocalAddr().(*net.UDPAddr)
	if !ok {
		return netip.Addr{}, false
	}
	ip, ok := netip.AddrFromSlice(ua.IP)
	if !ok {
		return netip.Addr{}, false
	}
	ip = ip.Unmap()
	if ip.IsLoopback() || ip.IsUnspecified() {
		return netip.Addr{}, false
	}
	return ip, true
}

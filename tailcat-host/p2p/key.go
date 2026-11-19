// 钥匙：WireGuard 那一对密钥的生成与公钥推导，外加 base64 / hex 两种写法的互转。
//
// 为什么这里自己算而不依赖 ctrl 客户端库：那套库会把整个 `wgctrl` 拉进来（带平台相关的
// 路由控制），对「我们只想要一对密钥」来说太重，而且它是给真网卡用的，不适合手机。
// curve25519 的标量乘就三行，x/crypto 已经在依赖里。

package p2p

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"

	"golang.org/x/crypto/curve25519"
)

// KeyPair 是一对 WireGuard 密钥。私钥只落本机，公钥可以明着给出去。
type KeyPair struct {
	Private string `json:"private"`
	Public  string `json:"public"`
}

// GenerateKeyPair 生成一对新的密钥（两段都是 base64，WireGuard 的通用写法）。
func GenerateKeyPair() (KeyPair, error) {
	var private [32]byte
	if _, err := rand.Read(private[:]); err != nil {
		return KeyPair{}, err
	}
	// clamp：WireGuard 与 curve25519 都要求这几个位固定，不 clamp 的话不同实现算出的
	// 公钥会不一致 —— 表现为「手机和电脑各算一个公钥、永远握不上手」。
	private[0] &= 248
	private[31] &= 127
	private[31] |= 64
	public, err := curve25519.X25519(private[:], curve25519.Basepoint)
	if err != nil {
		return KeyPair{}, err
	}
	return KeyPair{
		Private: base64.StdEncoding.EncodeToString(private[:]),
		Public:  base64.StdEncoding.EncodeToString(public),
	}, nil
}

// PublicFromPrivate 由私钥推公钥；私钥形状不对时回错误。
func PublicFromPrivate(private string) (string, error) {
	raw, err := parseKey(private)
	if err != nil {
		return "", err
	}
	var key [32]byte
	copy(key[:], raw)
	public, err := curve25519.X25519(key[:], curve25519.Basepoint)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(public), nil
}

// parseKey 认两种写法：44 字符的 base64（正常形态）与 64 字符的 hex（面板 / 守卫好读）。
//
// 不在这里「猜」别的编码：密钥只从设备凭据里来，形状不对就是那条记录坏了，猜下去只会
// 把坏数据带进加密层。
func parseKey(text string) ([]byte, error) {
	if len(text) == 44 {
		if raw, err := base64.StdEncoding.DecodeString(text); err == nil && len(raw) == 32 {
			return raw, nil
		}
	}
	if len(text) == 64 {
		if raw, err := hex.DecodeString(text); err == nil && len(raw) == 32 {
			return raw, nil
		}
	}
	return nil, errors.New(ErrKey)
}

// decodeBase64 是 parseKey 的兼容入口，保留给测试与旧调用点。
func decodeBase64(text string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(text)
}

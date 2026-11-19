// 助手的持久身份：节点私钥、WireGuard 预共享密钥、中继区域。
//
// 这三样决定「电脑重启之后手机还能不能直接连回来」：私钥变了地址就变了，
// 区域变了双方会约在别处见面。所以它们必须由插件存下来（插件有正式的存储和
// 重置入口），助手自己不留状态文件——它只是个被拉起的进程。

package main

import (
	"encoding/json"
	"errors"

	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
)

const stateVersion = 1

type state struct {
	Version    int             `json:"version"`
	PrivateKey string          `json:"privateKey"`
	Preshared  string          `json:"presharedKey"`
	Region     json.RawMessage `json:"region"`
}

type persisted struct {
	private key.NodePrivate
	psk     tailcat.PresharedKey
	region  *tailcfg.DERPRegion
}

func freshState() persisted {
	return persisted{private: key.NewNode(), psk: tailcat.NewPresharedKey()}
}

// parseState 读插件存的那段不透明字符串。null 或空串表示这台电脑第一次跑。
func parseState(raw json.RawMessage) (persisted, string) {
	if len(raw) == 0 || string(raw) == "null" {
		return persisted{}, ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil || text == "" {
		return persisted{}, errState
	}
	var doc state
	if json.Unmarshal([]byte(text), &doc) != nil || doc.Version != stateVersion {
		return persisted{}, errState
	}
	var private key.NodePrivate
	if private.UnmarshalText([]byte(doc.PrivateKey)) != nil || private.IsZero() {
		return persisted{}, errState
	}
	var psk tailcat.PresharedKey
	if psk.UnmarshalText([]byte(doc.Preshared)) != nil || psk.IsZero() {
		return persisted{}, errState
	}
	var region tailcfg.DERPRegion
	if len(doc.Region) == 0 || string(doc.Region) == "null" || json.Unmarshal(doc.Region, &region) != nil || region.RegionID == 0 {
		return persisted{}, errState
	}
	return persisted{private: private, psk: psk, region: &region}, ""
}

// marshalState 把身份写成插件要存的那一行。区域还没选出来时（第一次启动失败过）
// 返回空串，插件照「还没有可存的东西」处理。
func marshalState(private key.NodePrivate, psk tailcat.PresharedKey, region *tailcfg.DERPRegion) (string, error) {
	if region == nil {
		return "", errors.New(errState)
	}
	privText, err := private.MarshalText()
	if err != nil {
		return "", err
	}
	pskText, err := psk.MarshalText()
	if err != nil {
		return "", err
	}
	regionText, err := json.Marshal(region)
	if err != nil {
		return "", err
	}
	body, err := json.Marshal(state{
		Version: stateVersion, PrivateKey: string(privText), Preshared: string(pskText), Region: regionText,
	})
	if err != nil {
		return "", err
	}
	return string(body), nil
}

// parseAllowlist 把手机公钥列表变成节点公钥；重复或形状不对都算配置错误。
func parseAllowlist(texts []string) ([]key.NodePublic, string) {
	out := make([]key.NodePublic, 0, len(texts))
	seen := make(map[string]struct{}, len(texts))
	for _, text := range texts {
		var pub key.NodePublic
		if err := pub.UnmarshalText([]byte(text)); err != nil || pub.IsZero() {
			return nil, errClientKey
		}
		if _, exists := seen[pub.String()]; exists {
			return nil, errAllowlist
		}
		seen[pub.String()] = struct{}{}
		out = append(out, pub)
	}
	return out, ""
}

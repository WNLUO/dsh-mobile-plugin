// 远程电脑的出站客户端：复用原生隧道库，以设备为单位持有句柄并关联 IPC 请求。
package main

import (
	"encoding/json"
	"strings"

	mobile "dshmobile.local/tailcat-host/mobile"
	"dshmobile.local/tailcat-host/p2p"
)

type desktopClient struct {
	tailcat int64
	p2p     int64
}

func desktopResult(text string) (map[string]any, string) {
	var result map[string]any
	if json.Unmarshal([]byte(text), &result) != nil || result == nil {
		return nil, errStart
	}
	if code, ok := result["error"].(string); ok {
		return nil, code
	}
	return result, ""
}

func (r *runtime) desktopReply(cmd command, result any, code string) error {
	event := map[string]any{"event": "remoteResult", "requestId": cmd.RequestID, "ok": code == ""}
	if code != "" {
		event["code"] = code
	} else {
		event["result"] = result
	}
	return r.emit(event)
}

func (r *runtime) desktopCommand(cmd command) error {
	if cmd.RequestID == "" || len(cmd.RequestID) > 128 {
		return r.desktopReply(cmd, nil, errRequest)
	}
	if cmd.Command == "remoteCapabilities" {
		return r.desktopReply(cmd, map[string]any{"version": 1, "tailcat": true, "p2p": true}, "")
	}
	if cmd.DeviceID == "" || len(cmd.DeviceID) > 128 {
		return r.desktopReply(cmd, nil, errRequest)
	}
	if r.clients == nil {
		r.clients = map[string]*desktopClient{}
	}
	current := r.clients[cmd.DeviceID]
	if current == nil {
		current = &desktopClient{}
		r.clients[cmd.DeviceID] = current
	}
	var result any = map[string]any{}
	code := ""
	switch cmd.Command {
	case "remoteTailcatKey":
		private := cmd.PrivateKey
		if private == "" {
			private = mobile.NewClientKey()
		}
		public := mobile.PublicKey(private)
		if public == "" {
			code = errClientKey
		} else {
			result = map[string]any{"privateKey": private, "publicKey": public}
		}
	case "remoteTailcatStart":
		if current.tailcat != 0 {
			mobile.Stop(current.tailcat)
			current.tailcat = 0
		}
		var answer map[string]any
		answer, code = desktopResult(mobile.Start(cmd.Address, cmd.PrivateKey, cmd.RemotePort))
		if code == "" {
			current.tailcat = int64(answer["handle"].(float64))
			result = answer
		}
	case "remoteTailcatStop":
		mobile.Stop(current.tailcat)
		current.tailcat = 0
	case "remoteTailcatPath":
		result, code = desktopResult(mobile.Path(current.tailcat))
	case "remoteP2PKeys":
		if cmd.P2PPrivateKey == "" {
			result, code = desktopResult(mobile.P2PKeyPair())
		} else {
			var answer map[string]any
			answer, code = desktopResult(mobile.P2PPublicKey(cmd.P2PPrivateKey))
			if code == "" {
				result = map[string]any{"private": cmd.P2PPrivateKey, "public": answer["public"]}
			}
		}
	case "remoteP2PStart":
		mobile.P2PStop(current.p2p)
		current.p2p = 0
		var answer map[string]any
		answer, code = desktopResult(mobile.P2PStart(cmd.P2PPrivateKey, cmd.P2PPeerKey,
			strings.Join(cmd.P2PPeerPublic, ","), strings.Join(cmd.P2PPeerLocal, ","), cmd.P2PListenPort))
		if code == "" {
			current.p2p = int64(answer["handle"].(float64))
			result = answer
		}
	case "remoteP2PStop":
		mobile.P2PStop(current.p2p)
		current.p2p = 0
	case "remoteP2PCandidates":
		result = map[string]any{"candidates": p2p.Candidates(current.p2p), "localCandidates": []string{}}
	case "remoteP2PPath":
		result = map[string]any{"path": mobile.P2PPath(current.p2p)}
	case "remoteClose":
		r.closeDesktopClient(cmd.DeviceID)
	default:
		code = errCommand
	}
	return r.desktopReply(cmd, result, code)
}

func (r *runtime) closeDesktopClient(id string) {
	current := r.clients[id]
	delete(r.clients, id)
	if current == nil {
		return
	}
	mobile.Stop(current.tailcat)
	mobile.P2PStop(current.p2p)
}

func (r *runtime) closeDesktopClients() {
	for id := range r.clients {
		r.closeDesktopClient(id)
	}
}

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	dshmobile "dshmobile.local/tailcat-host/mobile"
)

// 端到端：一次真实的配对。
//
// 被测的是「手机扫码之后那一下」的完整链路——临时节点起来 → 手机拿二维码里那把一次性
// 私钥连上去 → HTTP 报上自己的长期公钥 → 换回正式节点地址。三个东西各自在三个包里
// （助手的配对窗口、手机侧客户端库、HTTP 协议），只有真跑一遍才能确认它们对得上。
//
// 驱动方式是直接喂 stdin/stdout：助手没有别的入口，测试也就照它的真实用法来。
func TestPairingWindowExchangesBootstrapForNormalAddress(t *testing.T) {
	stdin, feed := io.Pipe()
	read, stdout := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- Run(stdin, stdout, Option{}) }()

	events := make(chan map[string]any, 32)
	go func() {
		scanner := bufio.NewScanner(read)
		scanner.Buffer(make([]byte, 4096), lineLimit)
		for scanner.Scan() {
			var event map[string]any
			if json.Unmarshal(scanner.Bytes(), &event) == nil {
				events <- event
			}
		}
		close(events)
	}()
	// 多条 goroutine 都往同一根管道写，必须串起来：io.Pipe 不接受并发写。
	var writeMu sync.Mutex
	writeLine := func(value any) {
		body, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("编码命令失败：%v", err)
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		if _, err := feed.Write(append(body, '\n')); err != nil {
			t.Fatalf("写命令失败：%v", err)
		}
	}

	writeLine(map[string]any{"version": protoVersion, "localPort": 19445, "name": "test-mac", "state": nil, "allowedClients": []any{}})

	var pairing map[string]any
	deadline := time.After(90 * time.Second)
	pairAsked := false
	for pairing == nil {
		select {
		case event, ok := <-events:
			if !ok {
				t.Fatal("助手提前结束了")
			}
			switch event["event"] {
			case "ready":
				if !pairAsked {
					pairAsked = true
					writeLine(map[string]any{"command": "pair", "ttl": 60})
				}
			case "pairing":
				pairing = event
			case "error":
				t.Fatalf("助手报错：%v", event["code"])
			}
		case <-deadline:
			t.Fatal("等不到配对窗口")
		}
	}

	address, _ := pairing["address"].(string)
	key, _ := pairing["key"].(string)
	proof, _ := pairing["proof"].(string)
	if address == "" || !strings.HasPrefix(key, "privkey:") || len(proof) != 43 {
		t.Fatalf("配对窗口给的东西不能用：%+v", pairing)
	}

	// 手机那一侧：用它自己那把长期私钥，先在临时节点上换地址。
	phoneKey := dshmobile.NewClientKey()
	phonePublic := dshmobile.PublicKey(phoneKey)
	if phonePublic == "" {
		t.Fatal("手机侧算不出公钥")
	}
	var started struct {
		Handle int64  `json:"handle"`
		Port   int    `json:"port"`
		Error  string `json:"error"`
	}
	if err := json.Unmarshal([]byte(dshmobile.Start(address, key, pairingPort)), &started); err != nil || started.Error != "" || started.Port == 0 {
		t.Fatalf("连不上临时节点：%v / %+v", err, started)
	}
	defer dshmobile.Stop(started.Handle)

	body, _ := json.Marshal(map[string]string{"phoneKey": phonePublic})
	request, err := http.NewRequest(http.MethodPost, "http://127.0.0.1:"+itoa(started.Port)+"/pair", strings.NewReader(string(body)))
	if err != nil {
		t.Fatalf("拼请求失败：%v", err)
	}
	request.Header.Set("Authorization", "Bearer "+proof)
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 60 * time.Second}
	type answer struct {
		status int
		body   []byte
		err    error
	}
	answered := make(chan answer, 1)
	go func() {
		res, err := client.Do(request)
		if err != nil {
			answered <- answer{err: err}
			return
		}
		defer res.Body.Close()
		payload, _ := io.ReadAll(res.Body)
		answered <- answer{status: res.StatusCode, body: payload}
	}()
	// 配对期间助手会先把白名单落盘再回来，这一步必须有人回执；测试就在这儿一边等结果一边回。
	// 回执过的那几份 persist 顺手记下来：白名单断言要用，事件循环里已经消费掉了。
	var allowedSeen []string
	var result answer
waitAnswer:
	for {
		select {
		case event := <-events:
			if event["event"] == "persist" {
				if allowed, ok := event["allowedClients"].([]any); ok {
					allowedSeen = nil
					for _, entry := range allowed {
						if text, ok := entry.(string); ok {
							allowedSeen = append(allowedSeen, text)
						}
					}
				}
				writeLine(map[string]any{"command": "ack", "id": event["id"], "ok": true})
			}
		case result = <-answered:
			break waitAnswer
		case <-time.After(60 * time.Second):
			t.Fatal("配对请求没有回音")
		}
	}
	if result.err != nil {
		t.Fatalf("配对请求发不出去：%v", result.err)
	}
	res := &http.Response{StatusCode: result.status, Body: io.NopCloser(bytes.NewReader(result.body))}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		// 把助手吐出来的事件一起带出去，否则只看到一个 503 没法判是哪一步坏的。
		drained := []string{}
		for len(events) > 0 {
			event := <-events
			body, _ := json.Marshal(event)
			drained = append(drained, string(body))
		}
		t.Fatalf("配对被拒：HTTP %d；事件：%v", res.StatusCode, drained)
	}
	var reply struct {
		Address string `json:"address"`
		Port    int    `json:"port"`
		Error   string `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&reply); err != nil || reply.Error != "" {
		t.Fatalf("配对回包解不开：%v / %+v", err, reply)
	}
	if !strings.HasPrefix(reply.Address, "tc") || reply.Port != virtualPort {
		t.Fatalf("回的不是正式节点：%+v", reply)
	}

	// 白名单里必须真的有这台手机——界面上写着「已配对」而它其实没被记住，是最坏的一种错。
	found := false
	for _, entry := range allowedSeen {
		if entry == phonePublic {
			found = true
		}
	}
	if !found {
		t.Fatalf("手机没有被写进白名单：%v", allowedSeen)
	}
	_ = feed.Close()
	<-done
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	out := []byte{}
	for value > 0 {
		out = append([]byte{byte('0' + value%10)}, out...)
		value /= 10
	}
	return string(out)
}

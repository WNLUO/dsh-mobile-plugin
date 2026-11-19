package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"tailscale.com/tailcfg"
)

// 换白名单之后必须能拿到地址，而且不能把命令循环自己等死。
//
// 这是手机「免扫码自动接入」那一步的唯一入口：手机把公钥发上来，插件转成一条 `setAllowed`。
// 换名单要整体重启节点，重启完再把新状态交给插件存、等它回执；回执是从命令循环进来的。
// 所以这条测试盯的是一件很容易写错、错了又只在真机上表现成「一直未配置」的事：
// **`setAllowed` 不能跑在命令循环上**。
//
// 回执由测试自己立刻回（插件就是这么做的），于是「等不到回执」只可能因为它没被送进来。
func TestSetAllowedAnswersAddressWithoutWaitingOnItself(t *testing.T) {
	stdin, feed := io.Pipe()
	read, stdout := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- Run(stdin, stdout, Option{Start: fakeStart}) }()

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

	// 两处都会写 stdin：io.Pipe 不接受并发写。
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

	phone := "nodekey:" + strings.Repeat("7a", 32)
	writeLine(map[string]any{"version": protoVersion, "localPort": 19445, "name": "test-mac", "state": nil, "allowedClients": []any{}})

	asked := false
	deadline := time.After(30 * time.Second)
	for {
		select {
		case event, ok := <-events:
			if !ok {
				t.Fatal("助手提前结束了")
			}
			switch event["event"] {
			case "ready":
				address, _ := event["address"].(string)
				if address == "" {
					// 空名单不起节点：第一声 ready 的地址就是空的，这时候才轮到换名单。
					if !asked {
						asked = true
						writeLine(map[string]any{"command": "setAllowed", "allowedClients": []any{phone}})
					}
					continue
				}
				if address != fakeAddress {
					t.Fatalf("回来的地址不对：%q", address)
				}
				if !asked {
					t.Fatal("还没换名单就已经有地址了")
				}
				_ = feed.Close()
				<-done
				return
			case "persist":
				// 插件那一侧就是这么回执的：看见 persist 立刻回，不等别的事。
				writeLine(map[string]any{"command": "ack", "id": event["id"], "ok": true})
			case "error":
				// 走到这儿就是「换名单把自己等死了」：persistence-timeout。
				t.Fatalf("换白名单失败：%v", event["code"])
			}
		case <-deadline:
			t.Fatal("换白名单之后等不到地址")
		}
	}
}

const fakeAddress = "tcAAfakeaddress"

// fakeNode 是桩节点：不碰网络，只答地址 / 区域 / 关闭这三件事。
type fakeNode struct{}

func (fakeNode) Address() string             { return fakeAddress }
func (fakeNode) Region() *tailcfg.DERPRegion { return &tailcfg.DERPRegion{RegionID: 999} }
func (fakeNode) Close() error                { return nil }

func fakeStart(context.Context, Spec) (Running, error) { return fakeNode{}, nil }

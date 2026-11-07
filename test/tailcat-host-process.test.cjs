'use strict';

/**
 * 助手进程这条 IPC 的守卫：只盯「报上来的失败原因会不会被丢掉」这一条。
 *
 * 背景：助手起节点失败时会把底层原因（比如取 DERP 地图时 x509 证书校验失败）当 `error`
 * 事件的 code 报上来，这类串很长。插件早先按「code 超过 64 字当脏数据丢掉」，于是真实原因
 * 被吞、界面永远停在「正在启动」。这条把「长原因必须原样传到 onEvent」钉死。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createTailcatHost } = require('../lib/tailcat/host-process.cjs');

/** 造一个假的助手可执行文件：吐一行给定 JSON、然后假装还在跑。 */
function fakeHelper(jsonLine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tailcat-hp-'));
  const file = path.join(dir, 'helper.sh');
  fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(jsonLine)}'\nsleep 2\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

test('助手报的失败原因是长串（x509 证书校验）时也要如实抛出来，不能因为超过 64 字被丢掉', async () => {
  const code = 'fetching DERPMap for region -1: Get "https://tailcat.dev/derpmap.json": tls: failed to verify certificate: x509: certificate signed by unknown authority';
  assert.ok(code.length > 64, '前提：这条原因本来就超过 64 字');
  const helper = fakeHelper({ event: 'error', code });
  const events = [];
  const host = createTailcatHost({
    localPort: 12345,
    allowedClients: [`nodekey:${'a'.repeat(64)}`],
    onEvent: (event) => events.push(event),
    resolve: () => helper,
  });
  host.start();
  try {
    for (let i = 0; i < 60 && !events.some((event) => event.event === 'error'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const err = events.find((event) => event.event === 'error');
    assert.ok(err, '必须收到 error 事件，且不是空的');
    assert.equal(err.code, code, '长错误串要原样传上来（不被 64 字上限吞掉）');
    assert.equal(host.status().ready, false);
  } finally {
    await host.close();
  }
});

/** 起一个假助手，等一类事件出现（最多 3 秒），返回收到的那条。 */
async function firstEvent(jsonLine, kind) {
  const helper = fakeHelper(jsonLine);
  const events = [];
  const host = createTailcatHost({
    localPort: 12345,
    allowedClients: [],
    onEvent: (event) => events.push(event),
    resolve: () => helper,
  });
  host.start();
  try {
    for (let i = 0; i < 60 && !events.some((event) => event.event === kind); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await host.close();
  }
  return events.find((event) => event.event === kind);
}

test('一台电脑接多台手机之后，事件里的 peerKey 要能穿过来（否则插件分不清是哪台）', async () => {
  // 这一层的白名单是**严格**的：多一个键就整条当脏数据丢掉。多台手机之后助手会在
  // `p2pReady` / `p2pStatus` 里多带一个 `peerKey`（手机公钥），插件据此把状态路由到
  // 对应那台。白名单不认这一格的话，事件在**进程这一层**就被丢了 —— 会话永远收不到，
  // 表现是「手机来会合了、电脑也起来了，面板却一直是空的」。
  const ready = await firstEvent({ event: 'p2pReady', url: 'http://x', candidates: [], peerKey: 'phone-a' }, 'p2pReady');
  assert.ok(ready, '带 peerKey 的 p2pReady 必须穿过来');
  assert.equal(ready.peerKey, 'phone-a');

  const state = await firstEvent({
    event: 'p2pStatus', running: true, url: 'http://x', path: 'direct', active: true, detail: '', candidates: [], peerKey: 'phone-a',
  }, 'p2pStatus');
  assert.ok(state, '带 peerKey 的 p2pStatus 必须穿过来');
  assert.equal(state.peerKey, 'phone-a');
});

test('peerKey 是**可选**的：老助手两种事件都不带，照旧要能穿过来', async () => {
  // 助手是可选依赖、版本也会落后。为了多台而把 `peerKey` 做成必填，等于把老助手整条
  // IPC 当场变成哑的；所以这两种形状都得认。
  const ready = await firstEvent({ event: 'p2pReady', url: 'http://x', candidates: [] }, 'p2pReady');
  assert.ok(ready, '不带 peerKey 的老形状也要穿过来');
  assert.equal(ready.peerKey, undefined);

  const state = await firstEvent({
    event: 'p2pStatus', running: true, url: 'http://x', path: 'waiting', active: false, detail: '', candidates: [],
  }, 'p2pStatus');
  assert.ok(state, '不带 peerKey 的老形状也要穿过来');
});

test('给这两个事件开的口子不能变成「什么都收」（别的键照旧算脏数据）', async () => {
  // 放宽成「随便多一个键」的话，这一层用来挡脏数据的作用就没了：stdout 是私有 IPC，
  // 一个多出来的键意味着要么助手的版本与插件对不上、要么有东西在往里写。
  const polluted = await firstEvent({
    event: 'p2pStatus', running: true, url: 'http://x', path: 'direct', active: true, detail: '', candidates: [], peerKey: 'phone-a', extra: 'nope',
  }, 'p2pStatus');
  assert.equal(polluted, undefined, '多出 peerKey 之外的键必须整条丢掉');
});

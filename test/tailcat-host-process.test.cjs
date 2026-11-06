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

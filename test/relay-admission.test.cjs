'use strict';

/**
 * 中转注册准入：把「隧道关闭: 1008 …」翻译成「下一步该做什么」。
 *
 * 背景：隧道连不上时状态里只有一句「隧道关闭: 1008 bad registration secret」。注册密钥
 * 是中转 systemd unit 里的部署参数，客户端无处可查 —— 那句话不指向任何动作。
 *
 * 两处各钉各的：
 *   1. 插件 describeTunnel()：状态里带上机器可读的判定 + 提示键
 *   2. 「宿主产出线索 → 网页版翻成人话」这条消费链
 *
 * 判据直接从真模块取，不复述逻辑 —— 照着真代码另写一遍的测试在真代码坏掉时照样绿灯。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const LIB = path.join(__dirname, '..', 'lib');
const ROOT = path.join(__dirname, '..', '..');

// ── 抠真源码 ────────────────────────────────────────────────────────────────

function slice(source, from, to) {
  const start = source.indexOf(from)
  if (start < 0) throw new Error(`抠源码失败：找不到 ${from}`)
  const end = to ? source.indexOf(to, start) : source.length
  if (end < 0) throw new Error(`抠源码失败：找不到 ${to}`)
  return source.slice(start, end)
}

const statusSrc = fs.readFileSync(path.join(LIB, 'relay', 'status.js'), 'utf8')
// 判定与隧道翻译现在住在 lib/relay/status.js 且真的导出，直接 require 真模块——
// 不再从 index.js 里抠源码再 new Function 跑一遍。以前抠是因为它嵌在 apply() 闭包里
// 抠不到；现在抠的写法本身就是「照着真代码另跑一遍」，哪天真代码改了这里还在绿。
const classify = require('../lib/relay/status.js')

// `probeAdmission` / `reportAdmission` 那套安装器准入探测随安装器一起删掉了（插件改走 npm
// 分发）。准入线索这半条链仍在，钉法见下面「宿主产出 + 网页版消费」那条。

// ── 插件侧：describeTunnel ───────────────────────────────────────────────────

test('describeTunnel：认得中转的两种拼法，都归到「需要注册密钥」', () => {
  // 两种拼法都真实存在：中转 server.js 关连接时拼 'bad registration secret'，
  // 而中转侧 `lib/tunnel-registration.js` 内部的 reason 拼 'bad register secret'。
  for (const error of [
    '隧道关闭: 1008 bad registration secret',
    '隧道关闭: 1008 bad register secret',
  ]) {
    const out = classify.describeTunnel({ state: 'error', error })
    assert.equal(out.registerSecretRequired, true, `应当认出「要密钥」：${error}`)
    assert.equal(out.admissionHint, 'register-secret')
  }
})

test('describeTunnel：白名单准入归到另一个键，不和密钥混为一谈', () => {
  const out = classify.describeTunnel({ state: 'error', error: '隧道关闭: 1008 unknown instance' })
  assert.equal(out.instanceNotAllowed, true)
  assert.equal(out.admissionHint, 'instance-allowlist')
  assert.equal(out.registerSecretRequired, undefined, '两种准入原因的修复动作不同，不能混')
})

test('describeTunnel：跟准入无关的故障保持原样，不乱贴标签', () => {
  for (const error of ['连接断开', 'ETIMEDOUT', 'socket hang up']) {
    const base = { state: 'error', error }
    assert.deepEqual(classify.describeTunnel(base), base, `不该判成准入问题：${error}`)
  }
})

test('describeTunnel：非错误状态原样返回，空快照兜底成 off', () => {
  const connected = { state: 'connected', error: null }
  assert.deepEqual(classify.describeTunnel(connected), connected)
  assert.deepEqual(classify.describeTunnel(undefined), { state: 'off', error: null })
})

test('status() 用的是 describeTunnel 而不是裸快照', () => {
  assert.ok(
    /tunnel: describeTunnel\(sidecarSnapshot\.tunnel\)/.test(statusSrc),
    'status() 里的 tunnel 段必须过判定，否则上面这些全是白写'
  )
})

test('命中准入时给出可执行提示：宿主产出线索，网页版把它翻成人话', () => {
  // 线索的**单一产地**在宿主：它从中转的拒绝文案里认出两种，各挂一个机器可读的键，
  // 随 /api/relay/status 发出去。画界面的是网页版（React/），设置页那一半（lib/client.js）
  // 不画，所以这里钉的是「宿主产出 + 网页版消费」这条链。
  const status = fs.readFileSync(path.join(LIB, 'relay', 'status.js'), 'utf8')
  for (const hint of ['register-secret', 'instance-allowlist']) {
    assert.ok(status.includes(`'${hint}'`), `宿主应产出线索 ${hint}`)
  }
  assert.match(status, /admissionHint: hit\.hint/, '线索要跟着状态发出去')

  const card = fs.readFileSync(
    path.join(__dirname, '..', 'React', 'src', 'components', 'ConnectionCard.tsx'),
    'utf8',
  )
  assert.ok(card.includes('status.tunnel.admissionHint'), '连接状态卡必须读 admissionHint')
  // 文案进字典之后断键（五门语言各一份，原话在 React/src/lib/i18n/messages/panel.ts）。
  for (const key of ['panel.connection.relayNeedsSecret', 'panel.connection.relayRejected']) {
    assert.ok(card.includes(key), `网页版缺这条提示：${key}`)
  }
})

// 准入这件事只剩「宿主从中转的拒绝文案里认出来 → 状态里带机器可读的线索 → 网页版翻成人话」，
// 也就是上面那条用例钉住的链路。

'use strict'

/**
 * 跨包共享小工具的防漂移测试。
 *
 * 插件包与中转服务器是两个独立部署单元，不能跨目录 require（插件会被拷到
 * `~/.dsh/plugins/`，中转是独立进程），所以 `HOP_BY_HOP` 各有一份手工同步的拷贝。
 * 插件独立发布，因此本测试钉住完整的逐跳头集合；本地存在独立中转仓库检出时
 * 再与 Rust 实现逐项比对。
 *
 * 曾经这里还钉着 `safeEqual`（权威 `dsh-mobile-server/lib/pair.js`）与 `isFreshRequest`
 * （权威 `dsh-mobile-server/lib/fresh-request.js`）。2026-10-16 自建版精简成纯转发后，
 * 中转不再配对、不再缓存，那两份权威文件随之删除；插件侧自己的实现仍在，只是不再有
 * 「两侧必须一致」这回事（插件的 `lib/shared/dshtoken.js`、`lib/shared/fresh-request.js`
 * 仍由各自的守卫覆盖）。
 *
 * 与 `protocol-parity.test.cjs` 同一思路：不强行抽公共包（会改变两侧的部署形状），
 * 而是用测试保证「改了必须两边一起改」。
 *
 * 运行：node --test test/shared-helpers-parity.test.cjs
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const ROOT = path.join(__dirname, '..', '..')

// 权威实现现在在 Rust 版中转里（Node 版 2026-10-22 已删）。它是一份 `&[&str]` 数组，
// 提取方式与下面那个 Set 字面量不同，见 extractHopByHopRust。
const SERVER_HOP_BY_HOP = path.join(ROOT, 'server', 'dsh-mobile-server', 'server', 'relay', 'rust', 'src', 'headers.rs')
const EXPECTED = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
]
const PLUGIN_HOP_BY_HOP = path.join(__dirname, '..', 'lib', 'relay', 'lan-proxy.js')

/** 从 Rust 版取出 `const HOP_BY_HOP: &[&str] = &[...]` 里的字符串数组。 */
function extractHopByHopRust(source, file) {
  const match = source.match(/const HOP_BY_HOP: &\[&str\] = &\[([\s\S]*?)\]/)
  assert.ok(match, `${file} 里找不到 HOP_BY_HOP 的数组字面量`)
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
}

/** 取出 `const HOP_BY_HOP = new Set([...])` 里的字符串数组。 */
function extractHopByHop(source, file) {
  const match = source.match(/const HOP_BY_HOP = new Set\(\[([\s\S]*?)\]\)/)
  assert.ok(match, `${file} 里找不到 HOP_BY_HOP 的 Set 字面量`)
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

test('插件 HOP_BY_HOP 保持完整线格式契约', () => {
  const copy = extractHopByHop(fs.readFileSync(PLUGIN_HOP_BY_HOP, 'utf8'), PLUGIN_HOP_BY_HOP)
  assert.deepEqual(copy, EXPECTED)
})

test('本地中转检出存在时，HOP_BY_HOP 两份拷贝完全一致', { skip: !fs.existsSync(SERVER_HOP_BY_HOP) }, () => {
  const authority = extractHopByHopRust(fs.readFileSync(SERVER_HOP_BY_HOP, 'utf8'), SERVER_HOP_BY_HOP)
  assert.deepEqual(authority, EXPECTED, '中转与插件的逐跳头集合不一致')
})

test('HOP_BY_HOP 覆盖全部逐跳头（漏一个就会把连接语义转发给对端）', () => {
  const set = extractHopByHop(fs.readFileSync(PLUGIN_HOP_BY_HOP, 'utf8'), PLUGIN_HOP_BY_HOP)
  for (const header of [
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
  ]) {
    assert.ok(set.includes(header), `HOP_BY_HOP 缺少 ${header}`)
  }
  // 端到端头不得被误杀：Content-Type / Authorization / Cookie 必须能转发。
  for (const header of ['content-type', 'authorization', 'cookie', 'accept']) {
    assert.ok(!set.includes(header), `HOP_BY_HOP 不该包含端到端头 ${header}`)
  }
})

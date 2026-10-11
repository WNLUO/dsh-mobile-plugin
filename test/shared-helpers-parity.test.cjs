'use strict'

/**
 * 跨包共享小工具的防漂移测试。
 *
 * 插件包与中转服务器是两个独立部署单元，不能跨目录 require（插件会被拷到
 * `~/.dsh/plugins/`，中转是独立进程），所以 `safeEqual` 与 `HOP_BY_HOP` 各有
 * 一份手工同步的拷贝。这份测试把它们钉在一起：源码逐字节等价 + 行为等价。
 *
 * 权威实现取服务器侧（`dsh-mobile-server/lib/`），副本取插件侧：
 *   - `safeEqual`：`dsh-mobile-server/lib/pair.js` ↔ `dsh-mobile-plugin/lib/shared/dshtoken.js`
 *   - `HOP_BY_HOP`：`dsh-mobile-server/lib/proxy-http.js` ↔ `dsh-mobile-plugin/lib/relay/lan-proxy.js`
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

const SERVER_SAFE_EQUAL = path.join(ROOT, 'dsh-mobile-server', 'lib', 'pair.js')
const PLUGIN_SAFE_EQUAL = path.join(ROOT, 'dsh-mobile-plugin', 'lib', 'shared', 'dshtoken.js')
const SERVER_HOP_BY_HOP = path.join(ROOT, 'dsh-mobile-server', 'lib', 'proxy-http.js')
const PLUGIN_HOP_BY_HOP = path.join(ROOT, 'dsh-mobile-plugin', 'lib', 'relay', 'lan-proxy.js')
const SERVER_FRESH_REQUEST = path.join(ROOT, 'dsh-mobile-server', 'lib', 'fresh-request.js')
const PLUGIN_FRESH_REQUEST = path.join(ROOT, 'dsh-mobile-plugin', 'lib', 'shared', 'fresh-request.js')

/** 按花括号配对取出 `function <name>(...) { ... }` 的完整源码。 */
function extractFunction(source, name, file) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${file} 里找不到 function ${name}`)
  let depth = 0
  let i = source.indexOf('{', start)
  const from = i
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) break
    }
  }
  assert.ok(i > from, `${file} 的 function ${name} 花括号未闭合`)
  return source.slice(start, i + 1)
}

/** 折叠空白，消除缩进差异。 */
const normalize = (text) => text.replace(/\s+/g, ' ').trim()

/** 取出 `const HOP_BY_HOP = new Set([...])` 里的字符串数组。 */
function extractHopByHop(source, file) {
  const match = source.match(/const HOP_BY_HOP = new Set\(\[([\s\S]*?)\]\)/)
  assert.ok(match, `${file} 里找不到 HOP_BY_HOP 的 Set 字面量`)
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

const serverSafeEqualSrc = fs.readFileSync(SERVER_SAFE_EQUAL, 'utf8')
const pluginSafeEqualSrc = fs.readFileSync(PLUGIN_SAFE_EQUAL, 'utf8')

test('safeEqual 两份拷贝的源码逐字节等价（折叠空白后）', () => {
  const authority = extractFunction(serverSafeEqualSrc, 'safeEqual', SERVER_SAFE_EQUAL)
  const copy = extractFunction(pluginSafeEqualSrc, 'safeEqual', PLUGIN_SAFE_EQUAL)
  assert.equal(normalize(copy), normalize(authority), 'safeEqual 已漂移：两侧必须一起改')
})

test('safeEqual 两份拷贝的行为一致', () => {
  const evaluate = (source, file) => {
    const body = extractFunction(source, 'safeEqual', file)
    const crypto = require('node:crypto')
    // eslint-disable-next-line no-new-func
    return new Function('crypto', `${body}\nreturn safeEqual;`)(crypto)
  }
  const authority = evaluate(serverSafeEqualSrc, SERVER_SAFE_EQUAL)
  const copy = evaluate(pluginSafeEqualSrc, PLUGIN_SAFE_EQUAL)

  const cases = [
    ['same', 'same'],
    ['same', 'diff'],
    ['', ''],
    ['', 'x'],
    ['abcdef', 'abcdeg'],
    ['短', '短'],
    ['短', '长一点'],
    [123, '123'],
    ['123', 123],
    ['\u0000\u00ff', '\u0000\u00ff'],
  ]
  for (const [a, b] of cases) {
    const expected = authority(a, b)
    assert.equal(typeof expected, 'boolean', `safeEqual(${String(a)}, ${String(b)}) 必须返回布尔`)
    assert.equal(copy(a, b), expected, `safeEqual(${String(a)}, ${String(b)}) 两侧结果不同`)
  }
  // 逐字符差异（长度相同）不得提前返回 true —— timingSafeEqual 的语义底线。
  assert.equal(authority('token-a', 'token-b'), false)
  assert.equal(copy('token-a', 'token-b'), false)
})

test('HOP_BY_HOP 两份拷贝的集合完全一致（含顺序）', () => {
  const authority = extractHopByHop(fs.readFileSync(SERVER_HOP_BY_HOP, 'utf8'), SERVER_HOP_BY_HOP)
  const copy = extractHopByHop(fs.readFileSync(PLUGIN_HOP_BY_HOP, 'utf8'), PLUGIN_HOP_BY_HOP)
  assert.deepEqual(copy, authority, 'HOP_BY_HOP 已漂移：两侧必须一起改')
})

test('HOP_BY_HOP 覆盖全部逐跳头（漏一个就会把连接语义转发给对端）', () => {
  const set = extractHopByHop(fs.readFileSync(SERVER_HOP_BY_HOP, 'utf8'), SERVER_HOP_BY_HOP)
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

// 中转也必须认 `?fresh=1`：它是移动端从被冻结/被污染的代读副本里脱身的唯一手段
// （真机症状：侧边栏空了只有下拉刷新能救）。中转曾经把带 fresh 的读也交给镜像分支，
// 于是空镜像连下拉刷新一起顶掉。两份副本必须一致，否则「绕过」这件事会静默失效。
test('isFreshRequest 两份拷贝的行为一致', () => {
  const { isFreshRequest: serverCopy } = require(SERVER_FRESH_REQUEST)
  const { isFreshRequest: pluginCopy } = require(PLUGIN_FRESH_REQUEST)
  for (const target of [
    '/api/mobile/v1/sessions?fresh=1',
    '/api/mobile/v1/sessions?a=1&fresh=1',
    '?fresh=1',
    '/api/mobile/v1/sessions',
    '/api/mobile/v1/sessions?fresh=0',
    '/api/mobile/v1/sessions?afresh=1',
    undefined,
  ]) {
    assert.equal(pluginCopy(target), serverCopy(target), `isFreshRequest(${String(target)}) 两侧结果不同`)
  }
  assert.equal(serverCopy('/api/mobile/v1/sessions?fresh=1'), true, '中转侧必须认 fresh 标记')
})

test('中转确实在 fresh 读上绕过了镜像与响应缓存', () => {
  const src = fs.readFileSync(path.join(ROOT, 'dsh-mobile-server', 'server.js'), 'utf8')
  assert.match(src, /const fresh = isFreshRequest\(req\.url\)/, '中转未识别 fresh 标记')
  assert.match(
    src,
    /mayServeCache = Boolean\(options && options\.credential\) && !fresh/,
    '带 fresh 的读不得命中镜像或响应缓存',
  )
  assert.match(src, /parsed\.ok === true && !fresh\) cacheResponse/, 'fresh 读不得写响应缓存')
})

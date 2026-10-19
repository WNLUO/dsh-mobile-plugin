/**
 * 插件副本的 close 帧载荷编解码守卫。
 *
 * 这组用例只跑插件副本：`decodeClosePayload` 的 `raw` / `validCode` 两个诊断字段
 * 是**插件副本自己的形状**，实际消费方（手机 WS 的关闭帧）只用 `code` 与 `reason`。
 * 所以不「同一套断言跑两份实现」（那会把两边的返回形状硬绑在一起），
 * 跨实现的字节一致性由 protocol-parity.test.cjs 与 relay-core 的 Rust 对撞测试负责。
 */
'use strict'
const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const COPY = path.join(__dirname, '..', 'lib', 'relay', 'protocol.js')

for (const [label, file] of [['插件副本', COPY]]) {
  const { encodeClosePayload, decodeClosePayload, truncateUtf8, MAX_CLOSE_REASON_BYTES } = require(file)

  test(`${label}：Buffer 形式的 reason 必须按 UTF-8 解码`, () => {
    // ws 的 'close' 事件把 reason 作为 Buffer 传入（ws v8）。这里守的是「Buffer
    // 与 string 走同一条解码路径」，而不是某个具体实现写法。
    const payload = encodeClosePayload(1000, Buffer.from('再见'))
    assert.deepEqual(decodeClosePayload(payload), { code: 1000, raw: 1000, validCode: true, reason: '再见' })
  })

  test(`${label}：String(Buffer) 本身就是 UTF-8 解码（不是 util.inspect 的显示形式）`, () => {
    // 这条锁定 encodeClosePayload 不写 Buffer.isBuffer 分支的依据：String(buf) 走
    // Buffer.prototype.toString()。若哪天这个语义变了，这里先红，再决定是否加回分支。
    assert.equal(String(Buffer.from('再见')), '再见')
    assert.notEqual(String(Buffer.from('再见')), '<Buffer e5 86 8d e8 a7 81>')
  })

  test(`${label}：string 与 Buffer 两种 reason 编码结果一致`, () => {
    assert.equal(Buffer.compare(encodeClosePayload(1000, '再见'), encodeClosePayload(1000, Buffer.from('再见'))), 0)
  })

  test(`${label}：非法 close code 在编码时回落 1000`, () => {
    for (const bad of [NaN, 999, 1004, 1005, 1006, 1015, 5000, undefined, null, '1000']) {
      assert.equal(encodeClosePayload(bad, 'x').readUInt16BE(0), 1000, `code ${String(bad)} 应回落 1000`)
    }
  })

  test(`${label}：合法 close code 原样保留`, () => {
    for (const good of [1000, 1001, 3000, 4999]) {
      assert.equal(encodeClosePayload(good, '').readUInt16BE(0), good)
    }
  })

  test(`${label}：解码线上的非法 close code 时给安全值并把 validCode 置 false`, () => {
    for (const bad of [999, 1004, 1005, 1006, 1015, 5000]) {
      const wire = Buffer.concat([Buffer.from([(bad >> 8) & 255, bad & 255]), Buffer.from('x', 'utf8')])
      const decoded = decodeClosePayload(wire)
      assert.equal(decoded.raw, bad, 'raw 应保留线上原值（供日志）')
      assert.equal(decoded.validCode, false)
      assert.equal(decoded.code, 1000, 'code 必须始终可直接交给 ws.close()')
      assert.equal(decoded.reason, 'x')
    }
  })

  test(`${label}：缺失/过短的 payload 回落默认值`, () => {
    assert.deepEqual(decodeClosePayload(Buffer.alloc(0)), { code: 1000, raw: 1000, validCode: true, reason: '' })
    assert.deepEqual(decodeClosePayload(Buffer.from([3])), { code: 1000, raw: 1000, validCode: true, reason: '' })
    assert.deepEqual(decodeClosePayload(undefined), { code: 1000, raw: 1000, validCode: true, reason: '' })
  })

  test(`${label}：reason 按字节截断且不切断 UTF-8 码点`, () => {
    assert.equal(truncateUtf8('abc', 2).toString('utf8'), 'ab')
    assert.equal(truncateUtf8('你好', 4).toString('utf8'), '你', '2 字节切进「好」时应整字丢弃')
    assert.equal(truncateUtf8('你好', 0).toString('utf8'), '')
    // 编码侧必须自己截断：只断言解码结果会被解码侧的截断掩盖掉。
    const payload = encodeClosePayload(1000, '你'.repeat(200))
    assert.equal(payload.length, 2 + MAX_CLOSE_REASON_BYTES, '线上 payload 应只有 2B code + 123B reason')
    const decoded = decodeClosePayload(payload)
    assert.equal(Buffer.byteLength(decoded.reason, 'utf8'), MAX_CLOSE_REASON_BYTES, '应截到上限 123 字节')
    assert.equal(decoded.reason, '你'.repeat(41))
    assert.ok(!decoded.reason.includes('\ufffd'), '截断不得产生替换字符')
  })
}

// Regression guards for the relay protocol wire format and its synchronized copies.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

// 隧道协议的插件副本（`lib/relay/protocol.js`）必须与权威实现逐字节一致。
//
// 权威实现有两份：
//  - **Rust**（`server/relay-core/rust`）：中转跑的，`parity.rs` 拿 node 调本文件
//    逐字节对撞，那是真正跨语言的那道验证；
//  - **共用类型表**（`server/relay-core/protocol-types.js`）：类型编号、header 长度、
//    close code 规则、reason 上限都从这里来。
//
// 这里曾经 `require` 一份已经删掉的 JS 实现（`dsh-mobile-server/src/index.mjs`），
// 它一消失这组就整组报错。现在改为**对着共用类型表算期望值**，不再依赖任何已删文件。
const SHARED_TYPES = path.join(__dirname, '..', '..', 'server', 'relay-core', 'protocol-types.js')
const COPY = path.join(__dirname, '..', 'lib', 'relay', 'protocol.js')
const SHARED = require(SHARED_TYPES)

const stripHeader = (source) => source.replace(/^'use strict';\n\n\/\*\*[\s\S]*?\*\/\n/, "'use strict';\n")

function legacyEncodeFrame(type, id, payload) {
  let body;
  if (Buffer.isBuffer(payload)) body = payload;
  else if (typeof payload === 'string') body = Buffer.from(payload, 'utf8');
  else if (payload === undefined || payload === null) body = Buffer.alloc(0);
  else body = Buffer.from(JSON.stringify(payload), 'utf8');
  const buf = Buffer.allocUnsafe(9 + body.length);
  buf.writeUInt8(type, 0);
  buf.writeUInt32BE(id >>> 0, 1);
  buf.writeUInt32BE(body.length, 5);
  body.copy(buf, 9);
  return buf;
}

test('副本内联的类型表与共用类型表一致', () => {
  const shared = require(SHARED_TYPES)
  const copy = require(COPY)
  assert.deepEqual(copy.T, shared.T, '插件副本的 T 表与 relay-core 共用表不一致')
  assert.deepEqual(copy.TYPE_NAME, shared.TYPE_NAME, '插件副本的 TYPE_NAME 与共用表不一致')
  assert.equal(copy.HEADER_LEN, shared.HEADER_LEN)
  assert.equal(copy.MAX_CLOSE_REASON_BYTES, shared.MAX_CLOSE_REASON_BYTES)
})

test('副本的 close 编解码对得上共用表的规则（含保留码与超长 reason）', () => {
  const copy = require(COPY)
  const cases = [[1000, 'normal'], [1006, 'reserved'], [999, 'below'], [5000, 'above'], [1001, '超长的中文原因'.repeat(20)]]
  for (const [code, reason] of cases) {
    const payload = copy.encodeClosePayload(code, reason)
    // 期望值按共用表的规则算：不合法（含保留码）一律降级成 1000；reason 按字节截断。
    const expectedCode = SHARED.validCloseCode(code) ? code : 1000
    assert.equal(payload.readUInt16BE(0), expectedCode, `close(${code}) 的 code 位不对`)

    const reasonBytes = Buffer.from(reason, 'utf8')
    const limit = SHARED.MAX_CLOSE_REASON_BYTES
    // 按字节截断，且**不能把一个多字节字符劈成两半**：截断点落在续字节上时往回退到
    // 那个字符的起始位置。中文一个字 3 字节，123 正好可能切在中间，所以这条是实的。
    let end = Math.min(limit, reasonBytes.length)
    while (end > 0 && end < reasonBytes.length && (reasonBytes[end] & 0xc0) === 0x80) end -= 1
    assert.equal(
      Buffer.compare(payload.subarray(2), reasonBytes.subarray(0, end)), 0,
      `close(${code}) 的 reason 不该是别的字节`,
    )

    // 解回来要是同一对值（不合法的线上值解出来是 1000，但原值要能读到）。
    const decoded = copy.decodeClosePayload(payload)
    assert.equal(decoded.code, expectedCode, `close(${code}) 解回来的 code 不对`)
    assert.equal(decoded.reason, reasonBytes.subarray(0, end).toString('utf8'), `close(${code}) 解回来的 reason 不对`)
  }
})

test('副本的类型表与共用类型表一致', () => {
  // 权威的类型表在 relay-core（三份实现共用）；中转移交到 Workers 版之后，
  // Workers 版把类型表与编解码拆成了两个文件，所以这里比的是那份共用表。
  const authority = require(SHARED_TYPES)
  const copy = require(COPY)
  assert.deepEqual(copy.T, authority.T, 'T 类型表不一致')
  assert.deepEqual(copy.TYPE_NAME, authority.TYPE_NAME, 'TYPE_NAME 反查表不一致')
  assert.equal(copy.HEADER_LEN, authority.HEADER_LEN)
})

test('两侧对同一消息编码出的字节完全一致', () => {
  const types = require(SHARED_TYPES)
  const copy = require(COPY)
  const payload = Buffer.from('protocol-parity')
  // 帧头形状：1 字节类型 + 4 字节大端 id + 4 字节大端长度 + 载荷，头长取自共用表。
  for (const name of Object.keys(types.T)) {
    const frame = copy.encodeFrame(types.T[name], 7, payload)
    assert.equal(frame.length, types.HEADER_LEN + payload.length, `${name} 的帧长不对`)
    assert.equal(frame[0], types.T[name], `${name} 的类型字节不对`)
    assert.equal(frame.readUInt32BE(1), 7, `${name} 的 id 位不对`)
    assert.equal(frame.readUInt32BE(5), payload.length, `${name} 的长度位不对`)
    assert.equal(Buffer.compare(frame.subarray(types.HEADER_LEN), payload), 0, `${name} 的载荷不对`)
  }
})

test('字符串与 JSON 直写最终帧后保持旧 wire 字节', () => {
  const protocol = require(COPY)
  const payloads = [
    'ASCII text',
    '中文和 emoji 🙂',
    '',
    null,
    undefined,
    { ok: true, nested: ['x', '中'], value: 42 },
    Buffer.from([0, 0xff, 0x7f]),
  ]
  for (const payload of payloads) {
    assert.deepEqual(
      protocol.encodeFrame(protocol.T.sync, 0x1_0000_0007, payload),
      legacyEncodeFrame(protocol.T.sync, 0x1_0000_0007, payload),
    )
  }
  const json = { ok: true, message: '直写' }
  assert.deepEqual(
    protocol.jsonFrame(protocol.T.sync, 7, json),
    legacyEncodeFrame(protocol.T.sync, 7, JSON.stringify(json)),
  )
})

test('解码器能把编码出的多帧字节流原样解回来', () => {
  // 半包与粘包都靠这个解码器处理：几帧拼成一条流送进去，要按顺序原样解出。
  const types = require(SHARED_TYPES)
  const copy = require(COPY)
  const parts = [
    [types.T.httpHead, 3, JSON.stringify({ status: 200 })],
    [types.T.httpChunk, 3, 'chunk'],
    [types.T.httpEnd, 3, ''],
  ]
  const stream = Buffer.concat(parts.map(([type, id, text]) => copy.encodeFrame(type, id, Buffer.from(text))))

  const frames = []
  copy.createFrameDecoder((f) => frames.push({ type: f.type, id: f.id, payload: f.payload.toString('utf8') }))(stream)

  assert.deepEqual(
    frames,
    parts.map(([type, id, text]) => ({ type, id, payload: text })),
    '解出来的三帧要和编进去的一模一样',
  )
})

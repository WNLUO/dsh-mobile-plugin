// Regression guards for the relay protocol wire format and its synchronized copies.
'use strict'
const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

// 插件是独立发布的包，协议测试不依赖中转仓库的检出。帧编号与线格式在这里
// 以固定期望值覆盖；中转仓库另有 Rust 与 JS 测试实现的逐字节对撞。
const COPY = path.join(__dirname, '..', 'lib', 'relay', 'protocol.js')
const EXPECTED_TYPES = {
  register: 0x01, registered: 0x02, updatePairing: 0x03,
  httpRequest: 0x04, httpBody: 0x05, httpHead: 0x06, httpChunk: 0x07,
  httpEnd: 0x08, httpError: 0x09, wsUpgrade: 0x0a, wsOpen: 0x0b,
  wsError: 0x0c, wsText: 0x0d, wsBinary: 0x0e, wsClose: 0x0f,
  ping: 0x10, pong: 0x11, pairRequest: 0x12, pairConfirm: 0x13,
  httpCancel: 0x14, httpPause: 0x15, httpResume: 0x16, sync: 0x17,
  revokeAll: 0x18, revokeAllAck: 0x19,
}
const SHARED = {
  T: EXPECTED_TYPES,
  TYPE_NAME: Object.fromEntries(Object.entries(EXPECTED_TYPES).map(([name, code]) => [code, name])),
  HEADER_LEN: 9,
  MAX_CLOSE_REASON_BYTES: 123,
  validCloseCode: (code) => Number.isInteger(code) && code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code),
}

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

test('插件内联帧类型与线格式常量符合协议编号', () => {
  const copy = require(COPY)
  assert.deepEqual(copy.T, SHARED.T)
  assert.deepEqual(copy.TYPE_NAME, SHARED.TYPE_NAME)
  assert.equal(copy.HEADER_LEN, SHARED.HEADER_LEN)
  assert.equal(copy.MAX_CLOSE_REASON_BYTES, SHARED.MAX_CLOSE_REASON_BYTES)
})

test('副本的 close 编解码对得上共用表的规则（含保留码与超长 reason）', () => {
  const copy = require(COPY)
  const cases = [[1000, 'normal'], [1006, 'reserved'], [999, 'below'], [5000, 'above'], [1001, '超长的中文原因'.repeat(20)]]
  for (const [code, reason] of cases) {
    const payload = copy.encodeClosePayload(code, reason)
    // 非法（含保留码）close code 降级为 1000；reason 按字节截断。
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

test('每种帧类型都使用相同帧头格式和原始载荷', () => {
  const types = SHARED
  const copy = require(COPY)
  const payload = Buffer.from('protocol-parity')
  // 帧头是 1 字节类型 + 4 字节大端 id + 4 字节大端长度，之后是载荷。
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
  const types = SHARED
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

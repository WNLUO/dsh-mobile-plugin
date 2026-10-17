// Regression guards for the relay protocol wire format and its synchronized copies.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

// 隧道协议是手工同步的两份拷贝：插件包不能跨目录引用中转仓库的文件，所以插件
// 必须自带一份完整实现（类型表 + 编解码）。权威的编解码实现是
// server/dsh-mobile-server/lib/protocol.js，权威的类型表是共用的
// server/relay-core/protocol-types.js；副本是 lib/relay/protocol.js。
//
// 这里钉的是「行为一致」而不是「源码文本一致」：两份文件的结构本来就可以不同
// （权威那份把类型表 require 进来，插件这份必须内联），真正要保证的是同样的输入
// 编出同样的字节、同样的类型编号。文本比对会让一次纯重构假红，行为比对不会。
const AUTHORITY = path.join(__dirname, '..', '..', 'server', 'dsh-mobile-server', 'src', 'index.mjs')
const SHARED_TYPES = path.join(__dirname, '..', '..', 'server', 'relay-core', 'protocol-types.js')
const COPY = path.join(__dirname, '..', 'lib', 'relay', 'protocol.js')

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

test('副本的 close 编解码逐字节对上（含保留码与超长 reason）', () => {
  const authority = require(AUTHORITY)
  const copy = require(COPY)
  const cases = [[1000, 'normal'], [1006, 'reserved'], [999, 'below'], [5000, 'above'], [1001, '超长的中文原因'.repeat(20)]]
  for (const [code, reason] of cases) {
    assert.equal(
      Buffer.compare(copy.encodeClosePayload(code, reason), authority.encodeClosePayload(code, reason)), 0,
      `close(${code}) 编码不一致`,
    )
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
  const authority = require(AUTHORITY)
  const types = require(SHARED_TYPES)
  const copy = require(COPY)
  const payload = Buffer.from('protocol-parity')
  // 类型编号取自共用表，编解码取自 Workers 版那份实现。
  for (const name of Object.keys(types.T)) {
    const fromAuthority = authority.encodeFrame(types.T[name], 7, payload)
    const fromCopy = copy.encodeFrame(copy.T[name], 7, payload)
    assert.equal(Buffer.compare(fromAuthority, fromCopy), 0, `${name} 的编码结果不一致`)
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

test('两侧解码器对同一字节流解出相同结果', () => {
  // Workers 版把解码器做成 `FrameDecoder` 类，插件副本是 `createFrameDecoder` 工厂。
  // 两边形状不同是必然的（一个跑在边缘运行时、一个是宿主侧脚本），这里比**解出来的结果**。
  const authority = require(AUTHORITY)
  const types = require(SHARED_TYPES)
  const copy = require(COPY)
  const frame = (type, id, text) => authority.encodeFrame(type, id, Buffer.from(text))
  const stream = Buffer.concat([
    frame(types.T.httpHead, 3, JSON.stringify({ status: 200 })),
    frame(types.T.httpChunk, 3, 'chunk'),
    frame(types.T.httpEnd, 3, ''),
  ])

  const copyFrames = []
  copy.createFrameDecoder((f) => copyFrames.push({ type: f.type, id: f.id, payload: f.payload.toString('utf8') }))(stream)

  const authorityFrames = []
  new authority.FrameDecoder((f) => authorityFrames.push({ type: f.type, id: f.id, payload: new TextDecoder().decode(f.payload) })).push(new Uint8Array(stream))

  assert.deepEqual(copyFrames, authorityFrames)
})

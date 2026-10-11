// Regression guards for the relay protocol wire format and its synchronized copies.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

// 隧道协议是手工同步的两份拷贝：插件包不能跨目录引用中转仓库的文件。
// 权威实现是 dsh-mobile-server/lib/protocol.js，副本是 lib/relay/protocol.js。
// 唯一允许的差异是文件顶部的 JSDoc 头注释（路径指向不同）。
const AUTHORITY = path.join(__dirname, '..', '..', 'dsh-mobile-server', 'lib', 'protocol.js')
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

test('副本与权威实现的代码部分逐字节一致', () => {
  const authority = stripHeader(fs.readFileSync(AUTHORITY, 'utf8')).split('\n')
  const copy = stripHeader(fs.readFileSync(COPY, 'utf8')).split('\n')
  assert.equal(copy.length, authority.length, '两侧行数不一致，协议实现已漂移')
  for (let i = 0; i < authority.length; i += 1) {
    assert.equal(copy[i], authority[i], `第 ${i + 1} 行与权威实现不一致`)
  }
})

test('副本导出的类型表与常量与权威实现一致', () => {
  const authority = require(AUTHORITY)
  const copy = require(COPY)
  assert.deepEqual(Object.keys(copy).sort(), Object.keys(authority).sort(), '导出名集合不一致')
  assert.deepEqual(copy.T, authority.T, 'T 类型表不一致')
  assert.deepEqual(copy.TYPE_NAME, authority.TYPE_NAME, 'TYPE_NAME 反查表不一致')
  assert.equal(copy.HEADER_LEN, authority.HEADER_LEN)
})

test('两侧对同一消息编码出的字节完全一致', () => {
  const authority = require(AUTHORITY)
  const copy = require(COPY)
  const payload = Buffer.from('protocol-parity')
  for (const name of Object.keys(authority.T)) {
    const fromAuthority = authority.encodeFrame(authority.T[name], 7, payload)
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
  const authority = require(AUTHORITY)
  const copy = require(COPY)
  const frame = (type, id, text) => authority.encodeFrame(type, id, Buffer.from(text))
  const stream = Buffer.concat([
    frame(authority.T.httpHead, 3, JSON.stringify({ status: 200 })),
    frame(authority.T.httpChunk, 3, 'chunk'),
    frame(authority.T.httpEnd, 3, ''),
  ])
  const decodeAll = (mod) => {
    const frames = []
    const push = mod.createFrameDecoder((f) => frames.push({ type: f.type, id: f.id, payload: f.payload.toString('utf8') }))
    push(stream)
    return frames
  }
  assert.deepEqual(decodeAll(copy), decodeAll(authority))
})

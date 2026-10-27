'use strict';

/**
 * dsh-mobile-server 隧道协议 v2 编解码（取代 v1 的 JSON/base64 文本帧）。
 *
 * 每条隧道消息 = 一个 WS binary 帧：`[type: 1B][id: 4B 大端][length: 4B 大端][payload]`。
 * 数据通道的 payload 是原始字节（不再 base64），控制消息是 UTF-8 JSON，ping/pong 为应用层
 * 心跳（经代理/负载均衡时比 WS 原生 ping 可靠）。
 *
 * 控制帧 `migrate`（0x1C）是「这台搬家了」的登记：宿主在**旧隧道**上发出，中转据此把还
 * 握着旧地址的设备导向新地址，`to` 空串表示撤销。发送与撤销的时序见 relay/migrate.js。
 *
 * 本文件是自包含副本（插件包不能跨目录引用中转仓库）：完整内联了共用类型表与编解码实现。
 * 事实源在中转仓库的 relay-core，本仓的 protocol-parity 测试钉住线格式；改动帧编号后必须
 * 同步修改本文件。
 */

const T = {
  register: 0x01,      // id=0  JSON {instanceId, name, lanUrls?, lanCandidates?, secret?}
  registered: 0x02,    // id=0  JSON {}
  updatePairing: 0x03, // id=0  JSON {}（保留编号，宿主已不再发；中转从不读）
  httpRequest: 0x04,   // id=N  JSON {method, path, headers}；body 随后以 httpBody 流式发送
  httpBody: 0x05,      // id=N  raw bytes（空 payload = body 结束）
  httpHead: 0x06,      // id=N  JSON {status, headers}
  httpChunk: 0x07,     // id=N  raw bytes
  httpEnd: 0x08,       // id=N  空
  httpError: 0x09,     // id=N  JSON {message}
  wsUpgrade: 0x0A,     // id=N  JSON {path, headers}
  wsOpen: 0x0B,        // id=N  空
  wsError: 0x0C,       // id=N  JSON {message}
  wsText: 0x0D,        // id=N  raw bytes（上游 WS 文本帧数据）
  wsBinary: 0x0E,      // id=N  raw bytes（上游 WS 二进制帧数据）
  wsClose: 0x0F,       // id=N  2B 大端 close code
  ping: 0x10,          // id=0  空
  pong: 0x11,          // id=0  空
  pairRequest: 0x12,   // id=0  JSON {requestId, device:{id?, deviceId?, name?, platform?, osVersion?, appVersion?, ip?}}（手机配对 → 请求桌面授权；ip 由中转注入）
  pairConfirm: 0x13,   // id=0  JSON {requestId, approved, token?}（桌面授权结果 → 中转 → 手机）
  httpCancel: 0x14,     // id=N  空；取消上游 HTTP 请求/响应
  httpPause: 0x15,      // id=N  空；暂停向中转发送响应数据
  httpResume: 0x16,     // id=N  空；恢复向中转发送响应数据
  sync: 0x17,          // id=0  JSON {kind, ...}；桌面→中转主动推送（移动端镜像缓存）
  revokeAll: 0x18,     // id=0  JSON {at}；桌面请求中转清空本实例全部设备授权
  revokeAllAck: 0x19,  // id=0  JSON {ok, revoked}；中转确认已清空
  pushRegister: 0x1A,  // id=0  JSON {deviceId, platform, token}；宿主代 App 上报 iOS 推送令牌（本实例）
  pushSend: 0x1B,      // id=0  JSON {deviceId, title, body, sessionId?, kind}；宿主请求中转发一条 APNs 推送
  migrate: 0x1C,       // id=0  JSON {to, at}；宿主在旧隧道上登记「这台搬去哪个中转」，to 空串 = 撤销
};

const TYPE_NAME = {};
for (const [name, code] of Object.entries(T)) TYPE_NAME[code] = name;

const HEADER_LEN = 9;

/** 编码一帧；字符串/JSON 直接写入最终帧，避免中间 Buffer 与整段复制。 */
function encodeFrame(type, id, payload) {
  let body = null;
  let text = null;
  if (Buffer.isBuffer(payload)) {
    body = payload;
  } else if (typeof payload === 'string') {
    text = payload;
  } else if (payload !== undefined && payload !== null) {
    text = JSON.stringify(payload);
  }
  const bodyLength = body ? body.length : (text === null ? 0 : Buffer.byteLength(text, 'utf8'));
  const buf = Buffer.allocUnsafe(HEADER_LEN + bodyLength);
  buf.writeUInt8(type, 0);
  buf.writeUInt32BE(id >>> 0, 1);
  buf.writeUInt32BE(bodyLength, 5);
  if (body) body.copy(buf, HEADER_LEN);
  else if (bodyLength) buf.write(text, HEADER_LEN, bodyLength, 'utf8');
  return buf;
}

/** JSON 帧编码助手。 */
function jsonFrame(type, id, obj) {
  return encodeFrame(type, id, JSON.stringify(obj));
}

/**
 * 创建流式帧解码器：WS 消息可能包含多帧或半帧（send 大 buffer 时 TCP 层
 * 分片，ws 库会重组为一个 message；此处仍做拼接防御）。
 * 用法：const push = createFrameDecoder(onFrame); push(chunk);
 */
function createFrameDecoder(onFrame, options = {}) {
  const maxFrameBytes = options.maxFrameBytes == null ? 64 * 1024 * 1024 : options.maxFrameBytes;
  const onError = options.onError || (() => {});
  let buf = Buffer.alloc(0);
  return function push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    if (chunk.length > maxFrameBytes + HEADER_LEN || buf.length + chunk.length > maxFrameBytes + HEADER_LEN) {
      onError(new Error('frame too large'));
      buf = Buffer.alloc(0);
      return false;
    }
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= HEADER_LEN) {
      const type = buf.readUInt8(0);
      const id = buf.readUInt32BE(1);
      const len = buf.readUInt32BE(5);
      if (len > maxFrameBytes) {
        onError(new Error('frame too large'));
        buf = Buffer.alloc(0);
        return false;
      }
      if (buf.length < HEADER_LEN + len) break;
      const payload = buf.subarray(HEADER_LEN, HEADER_LEN + len);
      buf = buf.subarray(HEADER_LEN + len);
      onFrame({ type, id, payload });
    }
  };
}

/** 解析控制帧 payload 为对象（失败返回空对象）。 */
function parseJson(buf) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return {};
  }
}

/** 按字节截断字符串，且不切断 UTF-8 码点（ws 会拒绝非法 reason）。 */
function truncateUtf8(text, maxBytes) {
  const bytes = Buffer.from(text, 'utf8');
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0) {
    const last = bytes[end - 1];
    if ((last & 0x80) === 0) return bytes.subarray(0, end);
    let start = end - 1;
    while (start > 0 && (bytes[start] & 0xc0) === 0x80) start -= 1;
    const lead = bytes[start];
    const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if ((lead & 0xc0) !== 0x80 && start + width <= end) return bytes.subarray(0, end);
    end = start;
  }
  return Buffer.alloc(0);
}

// WS 关闭帧：reason 上限 123 字节（RFC 6455 控制帧 125 字节减去 2 字节 code）。
const MAX_CLOSE_REASON_BYTES = 123;
// 1005/1006/1015 是保留值，不得出现在线上；1004 语义不明，ws 同样拒绝。
const RESERVED_CLOSE_CODES = [1004, 1005, 1006, 1015];
/** close code 是否可出现在线上（ws 对保留值/越界值会直接抛错）。 */
function validCloseCode(code) {
  return Number.isInteger(code) && code >= 1000 && code <= 4999 && !RESERVED_CLOSE_CODES.includes(code);
}
/** 编码 wsClose payload：2B 大端 close code + 不切断码点的 UTF-8 reason。
 *  reason 可能是 string，也可能是 ws 'close' 事件给的 Buffer。Buffer 不需要单独
 *  分支：String(buf) 走的是 Buffer.prototype.toString()，本身就按 UTF-8 解码
 *  （'<Buffer e5 86 8d …>' 只是 util.inspect / console.log 的显示形式，不是
 *  String() 的结果）。 */
function encodeClosePayload(code, reason) {
  const c = validCloseCode(code) ? code : 1000;
  return Buffer.concat([Buffer.from([(c >> 8) & 255, c & 255]), truncateUtf8(String(reason || ''), MAX_CLOSE_REASON_BYTES)]);
}
/** 解码 wsClose payload。code 可直接交给 ws.close()；raw 是线上原值（供日志）。 */
function decodeClosePayload(payload) {
  const raw = payload && payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
  const ok = validCloseCode(raw);
  const reason = payload && payload.length > 2 ? truncateUtf8(payload.subarray(2), MAX_CLOSE_REASON_BYTES).toString('utf8') : '';
  return { code: ok ? raw : 1000, raw, validCode: ok, reason };
}

module.exports = {
  T,
  TYPE_NAME,
  HEADER_LEN,
  encodeFrame,
  jsonFrame,
  createFrameDecoder,
  parseJson,
  truncateUtf8,
  encodeClosePayload,
  decodeClosePayload,
  MAX_CLOSE_REASON_BYTES,
};

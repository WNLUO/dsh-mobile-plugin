'use strict';

/**
 * 插件侧 HTTP 小工具共享实现（sendJson / 读取 body / JSON 压缩）。
 *
 * 中转服务器（dsh-mobile-server）独立部署，保留自身实现，仅作参考。
 */

const zlib = require('node:zlib');

/**
 * 小于这个字节数不压：gzip 的头与 CPU 换不回那点字节，小响应明文更划算。
 *
 * 手机侧的列表 / 工作区 / 消息 / 统计都是几十到几百 KB 的 JSON，压缩后一般掉到原来的
 * 一到二成；而这些请求各条腿（宿主→中转隧道、中转→手机）都是按字节算的。
 */
const JSON_GZIP_MIN_BYTES = 1024;

/**
 * 对方是否声明支持 gzip。
 *
 * 安卓的 OkHttp 与 iOS 的 NSURLSession 自己就会带上这个头、收到后自己解压，所以插件
 * 这边只要如实标 `content-encoding: gzip`，App 一行代码都不用改。没声明的绝不压 ——
 * 赌客户端会解压，赌输就是整页 JSON 变成乱码。
 */
function wantsGzip(acceptEncoding) {
  return typeof acceptEncoding === 'string' && /\bgzip\b/i.test(acceptEncoding);
}

/**
 * 把一段 JSON 文本按需压成 gzip，返回要写出去的字节与「压没压」。
 *
 * @param {string|Buffer} text
 * @param {string|undefined} acceptEncoding 请求里的 accept-encoding 原值
 * @returns {{ body: Buffer, gzip: boolean }}
 */
function encodeJsonBody(text, acceptEncoding) {
  const raw = Buffer.isBuffer(text) ? text : Buffer.from(text == null ? '' : String(text));
  if (raw.length >= JSON_GZIP_MIN_BYTES && wantsGzip(acceptEncoding)) {
    try { return { body: zlib.gzipSync(raw), gzip: true }; } catch { /* 压不了就发明文，别让一次压缩失败把响应吞掉 */ }
  }
  return { body: raw, gzip: false };
}

/**
 * 写 JSON 响应（UTF-8）。连接已关闭时静默忽略。
 *
 * 大响应在客户端声明 gzip 时压缩。`vary` 无论压没压都带上：中转前面通常还有一层 CDN，
 * 缓存按它区分表示形态，缺了它会把压缩版回给不认 gzip 的客户端。
 *
 * @param {object} res    node:http ServerResponse
 * @param {number} status HTTP 状态码
 * @param {object} body   响应体（JSON.stringify）
 */
function sendJson(res, status, body) {
  try {
    const text = JSON.stringify(body);
    const headers = { 'content-type': 'application/json; charset=utf-8', vary: 'accept-encoding' };
    const acceptEncoding = res && res.req && res.req.headers ? res.req.headers['accept-encoding'] : undefined;
    const encoded = encodeJsonBody(text == null ? '' : text, acceptEncoding);
    if (encoded.gzip) headers['content-encoding'] = 'gzip';
    res.writeHead(status, headers);
    res.end(encoded.body);
  } catch { /* 连接已关闭 */ }
}

/**
 * 写 HTML 响应（UTF-8）。连接已关闭时静默忽略。
 *
 * 面板页是整页吐给浏览器的，所以必须显式声明 charset：少了它浏览器会按本地编码猜，
 * 中文标题直接变乱码。`no-store` 是刻意的——这份 HTML 就是「改完刷新即生效」的那一份，
 * 缓存住反而会把刚发布的版式藏起来。
 *
 * @param {object} res    node:http ServerResponse
 * @param {number} status HTTP 状态码
 * @param {string} html   响应体
 */
function sendHtml(res, status, html) {
  try {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(html);
  } catch { /* 连接已关闭 */ }
}

/**
 * 读取请求体并 JSON.parse；超限/非法 JSON/IO 错误 → null。
 *
 * @param {object} req         node:http IncomingMessage
 * @param {number} [maxBytes]  请求体上限（字节），缺省 256KB
 * @returns {Promise<object|null>}
 */
function readJsonBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) {
        req.destroy();
        resolve(null);
        return;
      }
    });
    req.on('end', () => {
      try {
        resolve(raw.length > 0 ? JSON.parse(raw) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

module.exports = { sendJson, sendHtml, readJsonBody, encodeJsonBody, wantsGzip, JSON_GZIP_MIN_BYTES };

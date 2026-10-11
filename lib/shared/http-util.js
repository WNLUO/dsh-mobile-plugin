'use strict';

/**
 * 插件侧 HTTP 小工具共享实现（sendJson / 读取 body）。
 *
 * 中转服务器（dsh-mobile-server）独立部署，保留自身实现，仅作参考。
 */

/**
 * 写 JSON 响应（UTF-8）。连接已关闭时静默忽略。
 * @param {object} res    node:http ServerResponse
 * @param {number} status HTTP 状态码
 * @param {object} body   响应体（JSON.stringify）
 */
function sendJson(res, status, body) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
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

module.exports = { sendJson, sendHtml, readJsonBody };

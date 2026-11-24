// 远程电脑本机入口端口：按绑定固定，浏览器才能跨窗口攒下网页静态资源缓存。
'use strict';

const crypto = require('node:crypto');

// 固定端口落在临时端口段；被占时顺延几号，再不行才随机。
const CACHE_PORT_MIN = 49152;
const CACHE_PORT_SPAN = 16384;
const PORT_STEPS = 8;

/** 同一绑定每次打开都从同一个端口开始试；只取高位两段，避开知名端口。 */
function preferredPortOf(id) {
  const digest = crypto.createHash('sha256').update(String(id)).digest();
  return CACHE_PORT_MIN + digest.readUInt16BE(0) % CACHE_PORT_SPAN;
}

function nextPort(port) {
  return port >= CACHE_PORT_MIN + CACHE_PORT_SPAN - 1 ? CACHE_PORT_MIN : port + 1;
}

module.exports = { preferredPortOf, nextPort, CACHE_PORT_MIN, CACHE_PORT_SPAN, PORT_STEPS };

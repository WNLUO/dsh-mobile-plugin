'use strict';

/**
 * 插件侧 HTTP 小工具共享实现（sendJson / 读取 body / JSON 压缩）。
 *
 * 中转服务器（dsh-mobile-server）独立部署，保留自身实现，仅作参考。
 *
 * 压缩走异步：手机侧的列表 / 工作区 / 消息 / 统计动辄几十到几百 KB，同步 gzip 会把插件
 * 的单线程整段占住，期间所有移动 API 请求都得排在后面。`encodeJsonBody` 因此改成返回
 * Promise（`node:zlib` 的回调版，不新增依赖），小响应与不声明 gzip 的请求仍然同步写完
 * —— 那两条路上一个字节都不压，形状与改造前逐字节相同。
 */

const zlib = require('node:zlib');
const { promisify } = require('node:util');

/** `zlib.gzip` 的 Promise 版：压缩在线程池里跑，插件主线程不陪着等。 */
const gzipAsync = promisify(zlib.gzip);

/**
 * 小于这个字节数不压：gzip 的头与 CPU 换不回那点字节，小响应明文更划算。
 *
 * 手机侧的列表 / 工作区 / 消息 / 统计都是几十到几百 KB 的 JSON，压缩后一般掉到原来的
 * 一到二成；而这些请求各条腿（宿主→中转隧道、中转→手机）都是按字节算的。
 */
const JSON_GZIP_MIN_BYTES = 1024;

/**
 * 普通 JSON 请求体的默认上限（**明文**字节数）。
 *
 * 原来是 256KB。协议 v2 的信封让线上字节变成 4/3，若仍按 256KB 卡线上长度，等于悄悄
 * 砍掉用户四分之一的可用额度，而错误信息只会是「太大」。所以按 §8.3(9) 抬到 344KB，
 * 并且判定一律按**解封之后的明文**算 —— 线上那一侧另有一道（`MAX_SEALED_BODY`）。
 */
const JSON_MAX_BODY = Math.ceil(256 * 1024 * 4 / 3);

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

/** 「这一份要不要压」的判据：够大且对方声明了 gzip。压不压能在这里同步判完。 */
function shouldGzipJson(raw, acceptEncoding) {
  return raw.length >= JSON_GZIP_MIN_BYTES && wantsGzip(acceptEncoding);
}

/**
 * 把一段 JSON 文本按需压成 gzip，返回要写出去的字节与「压没压」。
 *
 * 压缩异步做（`zlib.gzip` 的回调版）：几百 KB 的列表 / 消息 / 统计同步压一次就把插件
 * 的单线程整段占住，这段时间里所有移动 API 请求都排在它后面。压缩失败照旧退回明文 ——
 * 一次压缩失败不该把整条响应吞掉。
 *
 * @param {string|Buffer} text
 * @param {string|undefined} acceptEncoding 请求里的 accept-encoding 原值
 * @returns {Promise<{ body: Buffer, gzip: boolean }>}
 */
async function encodeJsonBody(text, acceptEncoding) {
  const raw = Buffer.isBuffer(text) ? text : Buffer.from(text == null ? '' : String(text));
  if (!shouldGzipJson(raw, acceptEncoding)) return { body: raw, gzip: false };
  try {
    return { body: await gzipAsync(raw), gzip: true };
  } catch {
    return { body: raw, gzip: false };
  }
}

/**
 * 写 JSON 响应（UTF-8）。连接已关闭时静默忽略。
 *
 * **分档**：不压的那一类（小响应、客户端没声明 gzip、协议 v2 信封）走同步写完，形状与
 * 改造前逐字节相同；只有真要压的那一类才 `await` 线程池里的 gzip。所以这个函数是异步的，
 * 但常见的小响应在第一个 await 之前就已经 end 掉了。
 *
 * 大响应在客户端声明 gzip 时压缩。`vary` 无论压没压都带上：中转前面通常还有一层 CDN，
 * 缓存按它区分表示形态，缺了它会把压缩版回给不认 gzip 的客户端。
 *
 * `res` 每一条路都只 end 一次：压缩失败退回明文时也只在 `end` 那里发一次。
 *
 * @param {object} res    node:http ServerResponse
 * @param {number} status HTTP 状态码
 * @param {object} body   响应体（JSON.stringify）
 */
async function sendJson(res, status, body) {
  let text;
  try {
    text = JSON.stringify(body);
  } catch { /* 序列化不了就当连接已关闭，一个字节都不写 */ return; }
  const headers = { 'content-type': 'application/json; charset=utf-8', vary: 'accept-encoding' };
  const acceptEncoding = res && res.req && res.req.headers ? res.req.headers['accept-encoding'] : undefined;
  // **协议 v2 的响应不在这里压**：守卫是在 `res.end` 上把 JSON 解出来再封成信封的，
  // 先压成 gzip 的话那一层只能看到二进制，`JSON.parse` 失败就退化成「原样写出、没封」——
  // 结果是最大的那批响应（列表 / 消息 / 统计）反而不加密。压缩改由信封写出去之前做，
  // 那一层拿到的仍是 JSON 文本（见 `lib/http/routing.js` 的 `res.end` 钩子与
  // `shared/e2ee-request.js` 的 `sealResponse`）。
  const sealed = !!(res && res.req && res.req.__dshE2ee);
  const raw = Buffer.from(text == null ? '' : text);
  if (!sealed && shouldGzipJson(raw, acceptEncoding)) {
    const encoded = await encodeJsonBody(raw, acceptEncoding);
    try {
      if (encoded.gzip) headers['content-encoding'] = 'gzip';
      res.writeHead(status, headers);
      res.end(encoded.body);
    } catch { /* 连接已关闭 */ }
    return;
  }
  try {
    res.writeHead(status, headers);
    res.end(raw);
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
 * 读取请求体并 JSON.parse；超限 / 非法 JSON / IO 错误 → null。
 *
 * 协议 v2 的请求体已经被守卫解开了（`req.body`），这里直接返回它：那条请求的字节流早被读走
 * 拿去验签与解封，再读只会拿到空串。上限按明文判（线上字节按 4/3 放大，两边分开算）。
 *
 * @param {object} req         node:http IncomingMessage
 * @param {number} [maxBytes]  请求体上限（字节，按明文），缺省 344KB
 * @returns {Promise<object|null>}
 */
function readJsonBody(req, maxBytes = JSON_MAX_BODY) {
  if (req && req.body !== undefined && req.body !== null) {
    const body = req.body;
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > maxBytes) return Promise.resolve(null);
    return Promise.resolve(body);
  }
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

/**
 * 读原始请求体，回 Buffer；超限 / 连接出错 → null。
 *
 * 与 `readJsonBody` 的分工：那条路交出去的是**解析好的 JSON**，这条路交出去的是**字节**。
 * v3 的二进制分片（`X-Dsh-Wire: bin`）加密后就是裸字节，中间没有 JSON 这一层；handler 拿
 * 到的明文片（守卫解封之后）同样是字节，所以两边都用这一条。
 *
 * `req.rawBody` 优先：信封守卫（`shared/e2ee-request.js`）已经把密文读走、解封完放在那里，
 * 请求流早就见底了，再 `on('data')` 只会等来一个空 body —— 那会表现为「每片都解出 0 字节」，
 * 而错误信息只会是「分片是空的」。
 *
 * @param {object} req         node:http IncomingMessage
 * @param {number} [maxBytes]  请求体上限（字节），缺省按普通 JSON 那一档
 * @returns {Promise<Buffer|null>}
 */
function readRawBody(req, maxBytes = JSON_MAX_BODY) {
  const handed = req && req.rawBody;
  if (Buffer.isBuffer(handed)) return Promise.resolve(handed.length > maxBytes ? null : handed);
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', () => {
      if (settled) return;
      settled = true;
      resolve(null);
    });
  });
}

module.exports = {
  sendJson,
  sendHtml,
  readJsonBody,
  readRawBody,
  encodeJsonBody,
  wantsGzip,
  JSON_GZIP_MIN_BYTES,
  JSON_MAX_BODY,
};

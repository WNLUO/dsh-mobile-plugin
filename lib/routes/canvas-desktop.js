'use strict';

/**
 * 桌面端画布的库读写（`/api/relay/canvas/*`）：本机信任、明文。
 *
 * 手机那条走的是 `/api/mobile/v1/canvas/*`，字节过设备加密信封；桌面端这一页由插件在同一个
 * 源上吐出，同机回环直接用明文 HTTP 就够了，不必也不该把设备凭据搬到桌面。两条路由读写的
 * 是**同一份库**（`mobile/canvas-store.js`）：清单复用它的两个 handler，字节直接落
 * `objects/`（盘上本来就是明文）。
 *
 * 能力边界：客户端只给域、哈希、字节，给不了任意路径；`file-put` 只按内容哈希落库（去重），
 * 与手机那条同一口径。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const { sendJson, readJsonBody } = require('../shared/http-util');
const store = require('../mobile/canvas-store');

const MAX_UPLOAD_BYTES = store.MAX_OBJECT_BYTES;

/** POST /api/relay/canvas/file {hash,mimeType} → 原始字节（明文）。 */
async function handleFileGet(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const hash = body && typeof body.hash === 'string' ? body.hash : '';
  const target = store.objectPathOf(hash);
  if (!target) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'hash 形状不对' } });
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    return sendJson(res, 404, { ok: false, error: { code: 'missing', message: '这份字节不在电脑上了' } });
  }
  if (!stat.isFile()) return sendJson(res, 404, { ok: false, error: { code: 'missing', message: '这份字节不在电脑上了' } });
  const mime = body && typeof body.mimeType === 'string' && body.mimeType ? body.mimeType.slice(0, 120) : 'application/octet-stream';
  res.writeHead(200, { 'content-type': mime, 'content-length': String(stat.size) });
  try {
    await pipeline(fs.createReadStream(target), res);
  } catch {
    // 头已经发出去了，只能断开让对端按截断处理（与会话文件那条一致）。
    try { res.destroy(); } catch { /* 连接已关闭 */ }
  }
}

/** POST /api/relay/canvas/file-put?name=… 请求体是原始字节 → { hash, bytes }。 */
async function handleFilePut(req, res) {
  const temp = path.join(store.rootDir(), `tmp-upload-${crypto.randomBytes(8).toString('hex')}`);
  await fsp.mkdir(path.dirname(temp), { recursive: true });
  let total = 0;
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(temp);
      let aborted = false;
      req.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_UPLOAD_BYTES && !aborted) {
          aborted = true;
          const error = Object.assign(new Error('这份文件太大，画布库装不下'), { status: 413 });
          req.unpipe(out);
          out.destroy();
          reject(error);
        }
      });
      req.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      req.pipe(out);
    });
    if (total === 0) {
      try { await fsp.unlink(temp); } catch { /* 已经不在了 */ }
      return sendJson(res, 400, { ok: false, error: { code: 'empty', message: '请求体里没有字节' } });
    }
    const result = await store.storeUploadedFile(temp);
    return sendJson(res, 200, { ok: true, hash: result.hash, bytes: result.bytes });
  } catch (error) {
    try { await fsp.unlink(temp); } catch { /* 已经不在了 */ }
    if (error && error.status === 413) {
      return sendJson(res, 413, { ok: false, error: { code: 'too-large', message: error.message } });
    }
    return sendJson(res, 500, { ok: false, error: { code: 'upload-failed', message: String((error && error.message) || error) } });
  }
}

/** 转发请求体的上限（模型接口带 base64 图的 POST 也不小；给足但别让整份进内存失控）。 */
const MAX_PROXY_BODY_BYTES = 128 * 1024 * 1024;
/** 转发时不该带给上游的请求头：跳数头、压缩协商（交给 fetch 自己解压）。 */
const STRIP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'accept-encoding', 'content-length', 'transfer-encoding',
  'origin', 'referer', 'upgrade', 'keep-alive',
]);
/** 回给页面时不该带回来的响应头：长度与压缩由这一层重新决定（body 已解压）。 */
const STRIP_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_PROXY_BODY_BYTES) {
        reject(Object.assign(new Error('请求体太大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * GET/POST /api/relay/canvas/net?u=<上游地址> —— 桌面端画布的本地转发。
 *
 * 和手机上那只原生环回服务同一件事：页面以为自己在请求同源地址，插件用 Node 的 fetch 去取
 * 上游，响应边收边写回。同源请求没有预检；`accept-encoding` 剥掉让 fetch 自己解压，回写时
 * 再把长度 / 压缩头去掉，body 交给页面按流读（SSE 那条才有用）。
 */
async function handleNet(req, res) {
  let upstreamUrl;
  try {
    upstreamUrl = new URL(new URL(req.url, 'http://x').searchParams.get('u') || '');
  } catch {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少或非法的上游地址' } });
  }
  if (upstreamUrl.protocol !== 'http:' && upstreamUrl.protocol !== 'https:') {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '只支持 http / https' } });
  }
  const method = (req.method || 'GET').toUpperCase();
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (STRIP_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    if (value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      body = await readRawBody(req);
    } catch (error) {
      return sendJson(res, error && error.status === 413 ? 413 : 400, { ok: false, error: { code: 'bad-request', message: String((error && error.message) || error) } });
    }
  }
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, { method, headers, body, redirect: 'follow' });
  } catch (error) {
    // 上游根本没连上：回一个带标记的 502，页面据此还原成网络错误（与手机那条一致）。
    res.writeHead(502, { 'content-type': 'application/json', 'x-dsh-net-error': '1' });
    return res.end(JSON.stringify({ ok: false, error: { code: 'network', message: String((error && error.message) || error) } }));
  }
  const outHeaders = {};
  for (const [name, value] of upstream.headers.entries()) {
    if (STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    outHeaders[name] = value;
  }
  res.writeHead(upstream.status, outHeaders);
  if (!upstream.body) return res.end();
  try {
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
    res.end();
  } catch {
    try { res.destroy(); } catch { /* 连接已关闭 */ }
  }
}

/**
 * 挂四条桌面端画布数据路由。`ctx` 原样转给 canvas-store 的 handler（它们目前不用它）。
 *
 * @param {{ registerRoute: Function, localOnly: Function, ctx?: object }} deps
 */
function registerCanvasDesktopRoutes({ registerRoute, localOnly, ctx = null }) {
  const manifestGet = localOnly('GET', (req, res) => store.handleCanvasManifestGet(ctx, req, res));
  const manifestSave = localOnly('POST', (req, res) => store.handleCanvasManifestSave(ctx, req, res));
  const fileGet = localOnly('POST', (req, res) => handleFileGet(req, res));
  const filePut = localOnly('POST', (req, res) => handleFilePut(req, res));
  const net = localOnly(['GET', 'POST'], (req, res) => handleNet(req, res));
  registerRoute({ kind: 'exact', path: '/api/relay/canvas/manifest', handler: manifestGet });
  registerRoute({ kind: 'exact', path: '/api/relay/canvas/manifest/save', handler: manifestSave });
  registerRoute({ kind: 'exact', path: '/api/relay/canvas/file', handler: fileGet });
  registerRoute({ kind: 'exact', path: '/api/relay/canvas/file-put', handler: filePut });
  registerRoute({ kind: 'exact', path: '/api/relay/canvas/net', handler: net });
}

module.exports = { registerCanvasDesktopRoutes };

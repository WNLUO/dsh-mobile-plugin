// 图片与视频从文件或 HTTP 流式收存，原字节保留，带签名地址不拼重试参数。
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { MAX_MEDIA_BYTES, mediaInfo, fileNameOf } = require('./contract.js');
function sourceOf(input) {
  if (typeof input?.path === 'string' && input.path.trim()) return { path: input.path };
  if (typeof input?.url !== 'string' || !input.url.trim()) throw new Error('需要媒体文件路径或下载地址');
  const url = new URL(input.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('请导出媒体文件或提供 HTTP 下载直链');
  const headers = {};
  for (const [key, value] of Object.entries(input.headers || {})) if (typeof value === 'string') headers[key] = value;
  return { url: input.url, headers };
}
async function openSource(source, options) {
  if (source.path) {
    const target = path.resolve(options.cwd || '', source.path);
    const info = await fsp.stat(target);
    if (!info.isFile()) throw new Error('媒体来源不是普通文件');
    return { stream: fs.createReadStream(target), total: info.size, name: path.basename(target) };
  }
  let url = source.url;
  let headers = { ...source.headers };
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const target = new URL(url);
    const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::'].includes(host)
      && options.protectedPorts?.has(Number(target.port || (target.protocol === 'https:' ? 443 : 80)))) {
      throw new Error('媒体地址指向 DSH 控制端口，请由生成插件导出文件');
    }
    const response = await (options.fetch || fetch)(url, { headers, redirect: 'manual', signal: options.signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 5) throw new Error('媒体下载地址跳转失败');
      const next = new URL(location, url);
      if (!['http:', 'https:'].includes(next.protocol)) throw new Error('媒体下载跳转不是 HTTP 地址');
      if (next.origin !== target.origin) headers = {};
      url = next.href; continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw Object.assign(new Error(response.status === 401 || response.status === 403
        ? '下载链接已失效或需要权限，请刷新链接或直接交付文件' : `媒体下载失败（HTTP ${response.status}）`), { code: `http-${response.status}` });
    }
    const declared = response.headers.get('content-length');
    return { stream: Readable.fromWeb(response.body), total: declared === null ? undefined : Number(declared),
      name: path.basename(new URL(url).pathname) || 'media', declared: response.headers.get('content-type') };
  }
}
async function acquireMedia(source, destination, options = {}) {
  await fsp.mkdir(destination, { recursive: true });
  const temporary = path.join(destination, 'incoming.part');
  let input;
  try {
    input = await openSource(source, options);
    if (input.total > MAX_MEDIA_BYTES) throw new Error('媒体超过单份 512 MiB 接收上限');
    let bytes = 0;
    let head = Buffer.alloc(0);
    let lastReported = 0;
    const meter = new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > MAX_MEDIA_BYTES) { done(new Error('媒体超过单份 512 MiB 接收上限')); return; }
      if (head.length < 65536) head = Buffer.concat([head, chunk.subarray(0, 65536 - head.length)]);
      if (Date.now() - lastReported > 500) { lastReported = Date.now(); options.onProgress?.(bytes, input.total); }
      done(null, chunk);
    } });
    await pipeline(input.stream, meter, fs.createWriteStream(temporary, { mode: 0o600 }), { signal: options.signal });
    if (!bytes || (Number.isFinite(input.total) && bytes !== input.total)) throw new Error('媒体内容没有接收完整');
    const info = mediaInfo(head, input.name, input.declared);
    if (options.kind && info.kind !== options.kind) throw new Error('收到的媒体类型与生成任务不一致');
    const name = fileNameOf(options.name || input.name, info.mediaType);
    const target = path.join(destination, name);
    await fsp.rename(temporary, target);
    options.onProgress?.(bytes, bytes);
    return { ...info, name, bytes, filePath: target };
  } catch (error) {
    input?.stream?.destroy();
    await fsp.unlink(temporary).catch(() => {});
    throw error;
  }
}
module.exports = { sourceOf, acquireMedia };

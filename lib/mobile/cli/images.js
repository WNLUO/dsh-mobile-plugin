'use strict';

/**
 * CLI 会话里的图片：发出去的那几张，以及手机上回头按 id 来取字节。
 *
 * 为什么不能沿用宿主那套附件：宿主的 `attachments/v1` 是会话日志的东西，CLI 会话根本没有
 * 那份日志。所以图片在插件这边自己存一份 —— 手机发上来时字节已经在盘上（分片上传落在收件箱），
 * 这里按**内容哈希**把它认下来（同一张图发两次只有一份），历史和实时帧里只下发一个
 * `attachmentId`，字节等手机真的要看时再取。
 *
 * 两条形状与宿主那套逐字对齐（App 的 `useAttachmentUri` / 原生通道只认这两种）：
 *
 *   - `{ type:'image', attachment:{ attachmentId, mediaType, name?, width?, height? } }`
 *     —— 历史和实时帧里的引用；
 *   - `/session/attachment` 上的三种回法：默认整份 base64、`raw:true` 走分块信封、
 *     `dims:true` 只要宽高。
 *
 * 宽高在存的时候就量好（`imageSizeOf` 读文件头）：不带它的话 App 只能先按 240 方盒占位、
 * 等解码完再变高，贴底的列表里那一跳就是「内容先停对了又被顶回去」。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const paths = require('../../shared/paths');
const { imageSizeOf } = require('../local-images.js');

/** 单张上限：与宿主那侧的附件限制同一个量级（10MB），超了就在发送时回绝。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 只认这四种：App 的图片块本来就只有这几种，别的一律当不支持。 */
const MEDIA_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function imageRoot() {
  return path.join(paths.dshHome(), 'storages', 'mobile-plugin', 'cli-images');
}

/** 内容哈希当 id（与宿主那套同一个口径：64 位小写十六进制）。 */
function idOf(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function objectPath(attachmentId) {
  if (typeof attachmentId !== 'string' || !/^[0-9a-f]{64}$/.test(attachmentId)) return null;
  return path.join(imageRoot(), attachmentId);
}

/** 存一份字节 + 一份元数据（媒体类型与名字），回引用块用的那几格。 */
async function saveImage({ bytes, mediaType, name }) {
  const type = typeof mediaType === 'string' && MEDIA_EXT[mediaType] ? mediaType : 'image/png';
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return null;
  if (bytes.length > MAX_IMAGE_BYTES) return null;
  const attachmentId = idOf(bytes);
  const target = objectPath(attachmentId);
  const root = imageRoot();
  await fsp.mkdir(root, { recursive: true });
  // 同一张图第二次发过来：文件已经在，元数据也够用，别再写一遍。
  if (!fs.existsSync(target)) await fsp.writeFile(target, bytes);
  const size = imageSizeOf(bytes);
  const meta = { mediaType: type, ...(typeof name === 'string' && name ? { name } : {}), ...(size || {}) };
  try {
    await fsp.writeFile(`${target}.json`, JSON.stringify(meta), 'utf8');
  } catch {
    // 元数据写不进去也不该让这一发失败：媒体类型还能从文件头猜。
  }
  return { attachmentId, ...meta };
}

/** 按 id 取回元数据（不认识 / 不在了回 null）。 */
function metaOf(attachmentId) {
  const target = objectPath(attachmentId);
  if (!target) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(`${target}.json`, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return {
      attachmentId,
      mediaType: typeof raw.mediaType === 'string' && MEDIA_EXT[raw.mediaType] ? raw.mediaType : 'image/png',
      ...(typeof raw.name === 'string' && raw.name ? { name: raw.name } : {}),
      ...(Number.isFinite(raw.width) && Number.isFinite(raw.height) ? { width: raw.width, height: raw.height } : {}),
    };
  } catch {
    return null;
  }
}

/** 按 id 打开字节（返回 `{ path, size }`；不在了回 null）。 */
function openImage(attachmentId) {
  const target = objectPath(attachmentId);
  if (!target) return null;
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size <= 0) return null;
    return { path: target, size: stat.size, ...(metaOf(attachmentId) || {}) };
  } catch {
    return null;
  }
}

/** 历史 / 实时帧里的引用块（App 的 `extractImages` 认这一种）。 */
function imageBlockOf(meta) {
  if (!meta || typeof meta.attachmentId !== 'string') return null;
  return {
    type: 'image',
    attachment: {
      attachmentId: meta.attachmentId,
      mediaType: meta.mediaType,
      ...(meta.name ? { name: meta.name } : {}),
      ...(meta.width && meta.height ? { width: meta.width, height: meta.height } : {}),
    },
    mediaType: meta.mediaType,
    ...(meta.name ? { name: meta.name } : {}),
    ...(meta.width && meta.height ? { width: meta.width, height: meta.height } : {}),
  };
}

module.exports = {
  MAX_IMAGE_BYTES,
  MEDIA_EXT,
  imageRoot,
  saveImage,
  metaOf,
  openImage,
  imageBlockOf,
};

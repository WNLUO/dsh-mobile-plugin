// 媒体任务对外只暴露稳定身份、展示比例和结果读数，不下发来源凭据。
'use strict';
const path = require('node:path');
const { sniffMediaType, imageSizeOf } = require('../local-images.js');
const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const PHASES = new Set(['generating', 'receiving', 'ready', 'failed', 'cancelled', 'interrupted']);
const ACTIVE = new Set(['generating', 'receiving']);
function ratioOf(value, kind) {
  const pair = typeof value === 'string' ? /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(value.trim()) : null;
  const ratio = pair ? Number(pair[1]) / Number(pair[2]) : Number(value);
  return Number.isFinite(ratio) && ratio > 0 ? Math.min(4, Math.max(0.25, ratio)) : kind === 'video' ? 16 / 9 : 1;
}
function mediaInfo(head, name, declared) {
  const image = sniffMediaType(head);
  if (image) return { kind: 'image', mediaType: image, ...imageSizeOf(head) };
  if (head.length > 12 && head.toString('ascii', 4, 8) === 'ftyp') return { kind: 'video', mediaType: 'video/mp4' };
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return { kind: 'video', mediaType: 'video/webm' };
  if (/^\s*<svg[\s>]|^\s*<\?xml[\s\S]*<svg[\s>]/i.test(head.toString('utf8'))) return { kind: 'image', mediaType: 'image/svg+xml' };
  throw Object.assign(new Error('来源没有返回可识别的图片或视频，请提供原文件或媒体下载直链'), { code: 'media-type' });
}
function extensionOf(mediaType) {
  return ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'video/mp4': '.mp4', 'video/webm': '.webm' })[mediaType] || '';
}
function fileNameOf(name, type) {
  const clean = path.basename(String(name || 'media')).replace(/[\x00-\x1f\\/:*?"<>|]/g, '_').slice(0, 160) || 'media';
  return path.extname(clean) ? clean : `${clean}${extensionOf(type)}`;
}
function publicTask(task) {
  const { id, sessionId, turn, anchorSeq, kind, title, frameRatio, phase, revision, createdAt, updatedAt, detail, error, loaded, total, original, preview, width, height, bytes, mediaType, name, sourceAlias, attachmentId } = task;
  return { id, sessionId, turn, anchorSeq, kind, title, frameRatio, phase, revision, createdAt, updatedAt,
    ...(detail ? { detail } : {}), ...(error ? { error } : {}), ...(loaded === undefined ? {} : { loaded }), ...(total === undefined ? {} : { total }),
    ...(original ? { hasOriginal: true } : {}), ...(preview ? { hasPreview: true } : {}),
    ...(width > 0 && height > 0 ? { width, height } : {}), ...(bytes === undefined ? {} : { bytes }), ...(mediaType ? { mediaType } : {}), ...(name ? { name } : {}),
    ...(sourceAlias ? { sourceAlias } : {}), ...(attachmentId ? { attachmentId } : {}) };
}
module.exports = { MAX_MEDIA_BYTES, PHASES, ACTIVE, ratioOf, mediaInfo, fileNameOf, publicTask };

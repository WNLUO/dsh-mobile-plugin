'use strict';

/**
 * 操作记录回传：手机把「调试面板 → 操作记录」导出的一段正文交给宿主，宿主原样落到本机磁盘。
 *
 * **数据只落在用户自己这台电脑上，不出网。** 这条路由不转发给中转、不落任何远端存储：
 * 收到什么就写进 `$DSH_HOME/mobile-traces/` 里的一个 JSON 文件，仅此而已。检查「手机上滑得
 * 顺不顺」要的是那条设备自己记的时间线，留在本机就够了；把它送上云反而多一份没人要的副本。
 *
 * 正文（`text`）按原样存，不压成一行：这份文件是给人直接打开看的，转义过的 `\n` 一整片
 * 读不出任何东西。
 *
 * 同目录的 `index.jsonl` 是一份轻量目录（每条一行：文件名 / 收到时刻 / 字节数 / 设备），
 * 方便按时间翻；它写不进去不影响这次回传本身 —— 正文已经落盘了。
 */

const fs = require('node:fs');
const path = require('node:path');

const { dshHome } = require('../shared/paths');
const { sendJson, readJsonBody } = require('../shared/http-util');

/** 正文上限：4MB（按 UTF-8 字节数算）。一次操作记录是文本时间线，到这个量已经是"记太久"。 */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
/**
 * 请求体上限：比正文宽一档。JSON 里换行 / 引号都要转义，4MB 正文的请求体可能大出几成；
 * 留到 12MB 是为了「正文合法但转义撑大了」不被误判成超限，真正的判据仍是 `text` 的字节数。
 */
const MAX_BODY_BYTES = 12 * 1024 * 1024;
/** label 进文件名的最长长度。 */
const MAX_LABEL = 40;
/** deviceId 短码取前几位。 */
const DEVICE_SHORT = 8;

/** 操作记录目录：`$DSH_HOME/mobile-traces`。 */
function tracesDir() {
  return path.join(dshHome(), 'mobile-traces');
}

/** 文件名安全化：只留 `[a-zA-Z0-9_-]`，其它一律变 `_`。 */
function safeSegment(value, fallback) {
  const raw = typeof value === 'string' ? value : '';
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned || fallback;
}

/** 本地时间戳，冒号换掉（`:` 在文件名里不该出现）：`2026-11-08T23-47-45-123`。 */
function localStamp(date) {
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`,
  ].join('T');
}

/**
 * 这次回传要落的文件名：`<本地时间戳>-<设备短码>-<label>.json`。
 *
 * @param {{ receivedAt: Date, deviceId?: string, label?: string }} input
 */
function traceFileName({ receivedAt, deviceId, label }) {
  const device = safeSegment(deviceId, 'unknown').slice(0, DEVICE_SHORT);
  const tag = safeSegment(label, 'trace').slice(0, MAX_LABEL);
  return `${localStamp(receivedAt)}-${device || 'unknown'}-${tag}.json`;
}

/**
 * 处理 `POST /api/mobile/v1/perf-trace`。
 *
 * 请求体：`{ deviceId?, label?, startedAt: number, text: string, meta? }`。
 * 成功回 `{ ok: true, file, path }`。
 *
 * @param {object} _ctx 插件 ctx（这条路由用不到）
 * @param {object} req  node:http IncomingMessage（信封请求的明文已在 `req.body`）
 * @param {object} res  node:http ServerResponse
 */
async function handlePerfTrace(_ctx, req, res) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON（或超过 12MB 上限）' });
  }

  const text = body.text;
  if (typeof text !== 'string' || text.length === 0) {
    return sendJson(res, 400, { ok: false, error: 'text 必须是非空字符串' });
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_TEXT_BYTES) {
    return sendJson(res, 413, { ok: false, error: `text 太大：${bytes} 字节，上限 ${MAX_TEXT_BYTES} 字节（4MB）` });
  }

  const startedAt = body.startedAt;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
    return sendJson(res, 400, { ok: false, error: 'startedAt 必须是有限数字（毫秒时间戳）' });
  }

  const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
  const label = typeof body.label === 'string' ? body.label : '';
  const meta = body.meta && typeof body.meta === 'object' ? body.meta : null;

  const receivedAt = new Date();
  const dir = tracesDir();
  const fileName = traceFileName({ receivedAt, deviceId, label });
  const filePath = path.join(dir, fileName);

  // 收到的原文 + 几格来源信息。2 空格缩进：这份文件是给人直接翻的。
  const payload = {
    receivedAt: receivedAt.toISOString(),
    deviceId,
    label,
    startedAt,
    meta,
    text,
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, serialized, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    return sendJson(res, 500, { ok: false, error: `写盘失败: ${reason}` });
  }

  // 目录索引：一条一行。它只是方便翻，写不进去不影响上面已经落好的正文。
  try {
    const entry = { file: fileName, receivedAt: receivedAt.toISOString(), bytes: Buffer.byteLength(serialized, 'utf8'), deviceId };
    fs.appendFileSync(path.join(dir, 'index.jsonl'), `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* 索引可选，不影响主请求 */ }

  return sendJson(res, 200, { ok: true, file: fileName, path: filePath });
}

module.exports = {
  handlePerfTrace,
  tracesDir,
  traceFileName,
  safeSegment,
  MAX_TEXT_BYTES,
  MAX_LABEL,
  DEVICE_SHORT,
};

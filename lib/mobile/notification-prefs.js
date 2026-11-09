'use strict';

/**
 * 通知按事件类型分级：每类可设「响铃 / 静默 / 关闭」。
 *
 * ## 为什么落在宿主侧、还按设备分桶
 *
 * 这张表决定的是「这台手机上，哪一类通知该响、哪一类只挂通知栏、哪一类干脆不发」。
 * 声音与通知栏是手机的机身行为，跟会话无关，也跟电脑无关；同一枚 token 可能配过不止一台
 * 手机（换机、平板 + 手机），各人手里的偏好不该互相覆盖，所以按 `deviceId` 各存一份。
 *
 * 桶键取**可信凭据记录**里的 `deviceId`（`req.__dshRecord.deviceId`），不认请求头：
 * 请求头谁都能写，凭据记录是这一条请求已经查库验过的那一份（见 `lib/http/routing.js`
 * 里 `createGuarded` 把记录挂到 `req` 的写法）。
 *
 * ## 两条边界
 *
 * - **读坏不 404**：文件缺失、读一半、结构不对、缺键，一律逐键并到默认表，绝不 404。
 *   这张表的缺省就是「能用」，把它读成故障等于让通知系统凭空瘫掉。
 * - **写整表替换**：PUT 收的是完整 `events`，逐键 clamp 到三档枚举、未知键丢弃，再原子
 *   落盘（照 `task-ledger.js` 的 mkdir + 临时文件 + rename + 0o600）。写不进去如实回失败。
 */

const fs = require('node:fs');
const path = require('node:path');

const { dshHome } = require('../shared/paths');
const { sendJson, readJsonBody } = require('../shared/http-util');

/** 存储格式版本：将来改形状时据此决定丢弃还是迁移。 */
const VERSION = 1;

/** 五类事件（三端逐字一致，见共享契约）。 */
const EVENT_TYPES = Object.freeze(['done', 'failed', 'approval', 'question', 'planReview']);

/** 三档级别：响铃（通知 + 声音）/ 静默（通知栏不响）/ 关闭（不通知）。 */
const LEVELS = Object.freeze(['ring', 'silent', 'off']);

/** 缺省档：等你动手才响、完成类静默。 */
const DEFAULT_EVENT_LEVELS = Object.freeze({
  done: 'silent',
  failed: 'ring',
  approval: 'ring',
  question: 'ring',
  planReview: 'ring',
});

/** 拿不到凭据记录时的兜底桶键：正常请求永远带 `deviceId`，这条只防裸调（测试 / 老调用方）。 */
const FALLBACK_DEVICE_ID = 'unknown-device';

/** 通知偏好文件。路径每次调用时按 `DSH_HOME` 解析，测试可注入。 */
function prefsFile() {
  return path.join(dshHome(), 'storages', 'mobile-plugin', 'notification-prefs.json');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 请求的桶键：优先可信凭据记录里的 `deviceId`。 */
function deviceIdOf(req) {
  const record = req && req.__dshRecord;
  if (record && typeof record.deviceId === 'string' && record.deviceId.trim()) {
    return record.deviceId.trim();
  }
  return FALLBACK_DEVICE_ID;
}

/** 一份干净的默认表（每次新对象，调用方改了也不污染常量）。 */
function defaultEvents() {
  return { ...DEFAULT_EVENT_LEVELS };
}

/** 单键 clamp：枚举内的原样返回，否则 null（调用方据此回退默认）。 */
function clampLevel(value) {
  return typeof value === 'string' && LEVELS.includes(value) ? value : null;
}

/**
 * 归一化一张 events 表：**以默认表打底，逐键覆盖**。合法的用值、非法/缺失的用默认、
 * 未知键直接丢。这是「读」与「写」共用的同一套收窄口径。
 */
function normalizeEvents(input) {
  const out = defaultEvents();
  if (!isRecord(input)) return out;
  for (const key of EVENT_TYPES) {
    const level = clampLevel(input[key]);
    if (level) out[key] = level;
  }
  return out;
}

/** 读整个文件；缺失 / 坏 / 结构不对 → 空的 devices（读坏就当还没有任何偏好）。 */
function loadStore() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(prefsFile(), 'utf8'));
  } catch {
    return { version: VERSION, updatedAt: 0, devices: {} };
  }
  if (!isRecord(raw)) return { version: VERSION, updatedAt: 0, devices: {} };
  const devices = isRecord(raw.devices) ? raw.devices : {};
  return {
    version: VERSION,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    devices,
  };
}

/**
 * 读这台设备的偏好。缺文件 / 坏文件 / 缺键都逐键并到默认，不 404。
 * @returns {{ version:number, updatedAt:number, events:object }}
 */
function readEvents(deviceId) {
  const store = loadStore();
  const entry = isRecord(store.devices[deviceId]) ? store.devices[deviceId] : null;
  return {
    version: store.version,
    updatedAt: entry && typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
    events: normalizeEvents(entry ? entry.events : null),
  };
}

/**
 * 原子写整份文件（照 task-ledger：mkdir + 临时文件 + rename + 0o600）。
 * 写失败安静返回 false，让调用方如实回 500，不抛。
 */
function saveStore(store) {
  const file = prefsFile();
  const next = { ...store, version: VERSION, updatedAt: Date.now() };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 写这台设备的偏好：整表替换，逐键 clamp、未知键丢弃。
 * @returns {{ ok:boolean, updatedAt:number, events:object }}
 */
function writeEvents(deviceId, inputEvents) {
  const events = normalizeEvents(inputEvents);
  const store = loadStore();
  const updatedAt = Date.now();
  const devices = isRecord(store.devices) ? { ...store.devices } : {};
  devices[deviceId] = { updatedAt, events };
  const ok = saveStore({ version: VERSION, updatedAt, devices });
  return { ok, updatedAt, events };
}

/**
 * GET  /api/mobile/v1/notification-prefs —— 回 `{ ok, version, updatedAt, events }`。
 * PUT  /api/mobile/v1/notification-prefs —— body `{ events }`，整表替换，回 `{ ok, updatedAt, events }`。
 *
 * 两条收在同一路径上由 `req.method` 分派（宿主注册器不按方法分派，与 `/narration` 同一条路）。
 */
async function handleNotificationPrefs(_ctx, req, res) {
  const deviceId = deviceIdOf(req);

  if (req && req.method === 'PUT') {
    const body = await readJsonBody(req);
    if (!body || !isRecord(body.events)) {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'events 必须是对象' } });
      return;
    }
    const result = writeEvents(deviceId, body.events);
    if (!result.ok) {
      sendJson(res, 500, {
        ok: false,
        error: { code: 'write-failed', message: '通知偏好没写进去' },
      });
      return;
    }
    sendJson(res, 200, { ok: true, updatedAt: result.updatedAt, events: result.events });
    return;
  }

  const current = readEvents(deviceId);
  sendJson(res, 200, {
    ok: true,
    version: current.version,
    updatedAt: current.updatedAt,
    events: current.events,
  });
}

module.exports = {
  VERSION,
  EVENT_TYPES,
  LEVELS,
  DEFAULT_EVENT_LEVELS,
  defaultEvents,
  clampLevel,
  normalizeEvents,
  deviceIdOf,
  prefsFile,
  readEvents,
  writeEvents,
  handleNotificationPrefs,
};

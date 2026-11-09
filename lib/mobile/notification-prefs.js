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
 * 桶键优先取**可信凭据记录**里的 `deviceId`（`req.__dshRecord.deviceId`），不认
 * `x-dsh-device` 这种自报头：凭据记录是这一条请求已经查库验过的那一份（见
 * `lib/http/routing.js` 里 `createGuarded` 把记录挂到 `req` 的写法）。
 *
 * 没有记录时（升级前的无状态 HMAC 通行证，`verifyMobileToken` 只回 `{ ok: true }`）
 * 退到**凭据原文的哈希**：`x-dsh-device-credential` / Bearer 里那枚 token 的 sha256 前缀。
 * 它跟着鉴权一起验过，同一台手机在 token 有效期内稳定、不同手机不同，所以不会像固定兜底键
 * 那样让所有老 App 共用一个桶、互相覆盖。两处已知取舍：旧 HMAC token 只由
 * `(instanceId, exp)` 决定，同一秒签出来的两枚会撞桶；重新配对换了 token 时这台手机的
 * 偏好会回到默认表（旧桶留在文件里，不被读也不再增长）。两样都比「一起覆盖」轻。
 * 真的一枚凭据都拿不到（裸调 / 假 req）才用固定兜底键，那种请求本来也分不出设备。
 *
 * ## 三条边界
 *
 * - **读坏不 404**：文件缺失、读一半、结构不对、缺键，读路径一律逐键并到默认表，绝不 404。
 *   这张表的缺省就是「能用」，把它读成故障等于让通知系统凭空瘫掉。
 * - **读坏不许写**：文件**在**但读不出 / 解析不了，和文件不存在是两回事。前者要是也当空表，
 *   下一次 PUT 就只补当前这个桶再整表落盘，别的设备的偏好静默全丢。所以读坏时 PUT 回
 *   500（`prefs-unreadable`）拒绝写：宁可这一次保存失败，也不替别人清偏好。GET 照旧回默认表。
 * - **写整表替换**：PUT 收的是完整 `events`，逐键 clamp 到三档枚举、未知键丢弃，再原子
 *   落盘（照 `task-ledger.js` 的 mkdir + 临时文件 + rename + 0o600）。写不进去如实回失败。
 */

const crypto = require('node:crypto');
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

/** 连凭据原文都拿不到时的兜底桶键：只防裸调（测试 / 老调用方），真实设备走不到这里。 */
const FALLBACK_DEVICE_ID = 'unknown-device';

/** 通知偏好文件。路径每次调用时按 `DSH_HOME` 解析，测试可注入。 */
function prefsFile() {
  return path.join(dshHome(), 'storages', 'mobile-plugin', 'notification-prefs.json');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 请求出示的凭据原文（与 `mobile/auth.js` 的 `presentedCredential` 同一顺序）。 */
function presentedCredential(req) {
  const headers = req && req.headers;
  if (!headers || typeof headers !== 'object') return null;
  const raw = headers['x-dsh-device-credential'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header === 'string' && header.trim()) return header.trim();
  const m = /^Bearer\s+([^\s]+)$/.exec(headers.authorization || '');
  return m ? m[1] : null;
}

/** 由凭据原文派生桶键：`tok-<sha256 前 16 位>`。不落原文，桶键也不泄露 token。 */
function deviceIdFromCredential(req) {
  const presented = presentedCredential(req);
  if (!presented) return '';
  return `tok-${crypto.createHash('sha256').update(presented).digest('hex').slice(0, 16)}`;
}

/**
 * 请求的桶键：优先可信凭据记录里的 `deviceId`，没有记录时按凭据原文派生，
 * 连凭据都没有才退回固定键（见文件头的取舍）。
 */
function deviceIdOf(req) {
  const record = req && req.__dshRecord;
  if (record && typeof record.deviceId === 'string' && record.deviceId.trim()) {
    return record.deviceId.trim();
  }
  return deviceIdFromCredential(req) || FALLBACK_DEVICE_ID;
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

/**
 * 读整个文件，**把「文件不在」和「文件在但读不懂」分开报**（写路径要靠这个区别决定能不能写）。
 * @returns {{ ok:true, version:number, updatedAt:number, devices:object }
 *          | { ok:false, missing:boolean }}
 */
function loadStore() {
  let text;
  try {
    text = fs.readFileSync(prefsFile(), 'utf8');
  } catch (error) {
    return { ok: false, missing: Boolean(error && error.code === 'ENOENT') };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, missing: false };
  }
  if (!isRecord(raw)) return { ok: false, missing: false };
  // `devices` 缺席算空表（文件还没写进去过）；但它若在场却不是对象，说明这不是我们认识的那份
  // 文件——那种情况也算读坏，不拿它当空表去覆盖。
  if (raw.devices !== undefined && !isRecord(raw.devices)) return { ok: false, missing: false };
  return {
    ok: true,
    version: VERSION,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    devices: isRecord(raw.devices) ? raw.devices : {},
  };
}

/**
 * 读这台设备的偏好。缺文件 / 坏文件 / 缺键都逐键并到默认，不 404。
 * @returns {{ version:number, updatedAt:number, events:object }}
 */
function readEvents(deviceId) {
  const store = loadStore();
  const devices = store.ok ? store.devices : {};
  const entry = isRecord(devices[deviceId]) ? devices[deviceId] : null;
  return {
    version: store.ok ? store.version : VERSION,
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
 *
 * 文件在场却读不懂时**拒绝写**（`error: 'prefs-unreadable'`）：这份文件里可能还有别的设备的
 * 偏好，凭一份空表整表落盘会把它们全抹掉。失败一次，用户可以重试或手删坏文件；静默丢别人
 * 的偏好没法回头。
 *
 * @returns {{ ok:true, updatedAt:number, events:object }
 *          | { ok:false, error:'prefs-unreadable' }
 *          | { ok:false, error:'write-failed', updatedAt:number, events:object }}
 */
function writeEvents(deviceId, inputEvents) {
  const events = normalizeEvents(inputEvents);
  const store = loadStore();
  if (!store.ok && !store.missing) return { ok: false, error: 'prefs-unreadable' };
  const updatedAt = Date.now();
  const devices = store.ok && isRecord(store.devices) ? { ...store.devices } : {};
  devices[deviceId] = { updatedAt, events };
  const ok = saveStore({ version: VERSION, updatedAt, devices });
  return ok ? { ok: true, updatedAt, events } : { ok: false, error: 'write-failed', updatedAt, events };
}

/**
 * GET  /api/mobile/v1/notification-prefs —— 回 `{ ok, version, updatedAt, events }`。
 * PUT  /api/mobile/v1/notification-prefs —— body `{ events }`，整表替换，回 `{ ok, updatedAt, events }`。
 *
 * 两条收在同一路径上由 `req.method` 显式分派（宿主注册器不按方法分派，与 `/narration` 同一条路）。
 * 只认这两个方法：以前「不是 PUT 就当 GET」，POST / DELETE 会拿到 200 + 当前偏好，调用方会
 * 误以为写成功了。
 */
async function handleNotificationPrefs(_ctx, req, res) {
  const method = String((req && req.method) || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'PUT') {
    sendJson(res, 405, {
      ok: false,
      error: { code: 'method-not-allowed', message: '仅支持 GET / PUT' },
    });
    return;
  }

  const deviceId = deviceIdOf(req);

  if (method === 'PUT') {
    const body = await readJsonBody(req);
    if (!body || !isRecord(body.events)) {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'events 必须是对象' } });
      return;
    }
    const result = writeEvents(deviceId, body.events);
    if (!result.ok) {
      if (result.error === 'prefs-unreadable') {
        sendJson(res, 500, {
          ok: false,
          error: {
            code: 'prefs-unreadable',
            message: '宿主上的通知偏好文件读不出来，这一份没写进去（写下去会清掉其它设备的设置）',
          },
        });
        return;
      }
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
  loadStore,
  readEvents,
  writeEvents,
  handleNotificationPrefs,
};

'use strict';

/**
 * 每设备凭据库：签发、校验、吊销手机端的持久化凭据。
 *
 * **凭据本身就是 Bearer**（讨论记录 §3.2 的 T1 口径）。配对签发一枚
 * `<instanceId>.<exp>.<random>`，同一枚同时充当 `Authorization: Bearer`、`dsh_lan` cookie
 * 与 `X-Dsh-Device-Credential`。三段形状只为兼容老 App「实例号缺失时从第一段补」那条逻辑；
 * 服务端**只按整串的 sha256 查库**，不看前缀、不解析三段、也不信里面的 `exp`
 * （以记录的 `expiresAt` 为准）。
 *
 * 落盘只存整串的 sha256。**唯一的例外是 `deviceKey`**：协议 v2 的逐请求签名要拿它重算，
 * 验签必须持有密钥本身，所以它按 base64url 原文落盘 —— 「整库只有哈希」这句话在它身上不成立。
 * `hostToken` 只为旧的 HMAC 记录保留：新记录一律留空，代理直接转发请求里出示的那一枚。
 *
 * 写入只有一个方向（§3.7）：宿主主进程是唯一写方；旁路子进程拿的是只读副本，靠文件
 * mtime/size 变了就重载来跟住变化，签发与吊销走 IPC 交给主进程（`lib/impl.js`）。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const FILE = process.env.DEVICE_CREDENTIALS_FILE || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'relay-device-credentials.json');
/** 默认有效期一年。`issue(..., ttlMs)` 可覆盖；`ttlMs <= 0` 表示不过期。 */
const DEFAULT_TTL_MS = 365 * 24 * 3600 * 1000;
/** 已吊销或过期超过这么久的记录，下次写入时整条删掉（§3.9）：别让每条请求扫一整年的账。 */
const PRUNE_GRACE_MS = 30 * 24 * 3600 * 1000;
/** 剩余有效期超过这个比例就不续期：滑动续期只在过掉一半之后发生。 */
const RENEW_BELOW_RATIO = 0.5;
/** 设备元信息的落盘截断长度。名字 64 够放「某某的 iPhone 15 Pro Max」；其余是系统版本、 */
/** App 版本这类短标识，来源是手机自填，长度不可信。 */
const NAME_MAX = 64;
const FIELD_MAX = 32;
/** 一份镜像最多带这么多条摘要：长期反复配对不该把推送清单撑成累赘。 */
const MAX_ACTIVE_DIGESTS = 200;
/** `lastSeenAt` 落盘的全局节流。 */
const TOUCH_FLUSH_MS = 60 * 1000;

let loaded = false;
let records = [];
/** `hash -> record`：每次整体替换，跟着 `records` 一起重建。 */
let byHash = new Map();
/** 上次读到的文件指纹（mtime:size）。 */
let stamp = null;
/** 只读副本：不写盘、不续期，改动只活在内存里直到下一次重载。 */
let readOnly = false;
let lastTouchFlushAt = 0;

function digest(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

/** 恒时比较两份摘要。两边都是 64 字符 hex，长度一致，能用 timingSafeEqual。 */
function hashEquals(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** 文件指纹。读不到就是 null（还不存在 / 刚被删）。 */
function statOf() {
  try {
    const stat = fs.statSync(FILE);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function rebuildIndex() {
  byHash = new Map();
  for (const record of records) byHash.set(record.hash, record);
}

function readFromDisk() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    records = Array.isArray(data)
      ? data.filter((record) => record && typeof record === 'object' && typeof record.hash === 'string' && record.hash)
      : [];
  } catch {
    records = [];
  }
  stamp = statOf();
  rebuildIndex();
}

/** 第一次用到时读一次盘。之后是否重读由 `refresh()` 按文件指纹决定。 */
function load() {
  if (loaded) return;
  loaded = true;
  readFromDisk();
}

function save() {
  if (readOnly) return;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  stamp = statOf();
}

/**
 * 只读副本按文件指纹重载。
 *
 * 这是**缓存失效而不是防御**：它替代的是「每条请求都跨进程问一次主进程」，而鉴权是热路径
 * （每台手机每秒好几个请求），跨进程问比一次 stat 贵得多。指纹没变就一个系统调用都不做。
 * 主进程（唯一写方）调它也没坏处：自己刚写完指纹就是新的，立刻返回。
 */
function refresh() {
  load();
  const now = statOf();
  if (now === stamp) return false;
  readFromDisk();
  return true;
}

/** 切只读副本。只影响写盘与续期，读路径不变。 */
function setReadOnly(flag) { readOnly = flag !== false; }

function isReadOnly() { return readOnly; }

function truncate(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text ? text.slice(0, max) : '';
}

/** 设备自填的元信息：只留这几个，各自截断。空值不写，面板据此显示「未知设备」。 */
function deviceMeta(device) {
  const meta = {};
  const name = truncate(device?.name, NAME_MAX);
  if (name) meta.name = name;
  const platform = truncate(device?.platform, FIELD_MAX);
  if (platform) meta.platform = platform;
  const osVersion = truncate(device?.osVersion ?? device?.version, FIELD_MAX);
  if (osVersion) meta.osVersion = osVersion;
  const appVersion = truncate(device?.appVersion, FIELD_MAX);
  if (appVersion) meta.appVersion = appVersion;
  return meta;
}

/**
 * 已吊销、或过期超过宽限期的整条删掉（§3.9）。
 *
 * 旧库只追加、吊销只打标记，今天不疼是因为「查不到就回退验 HMAC」把问题掩盖成了可用；
 * 查库优先之后，每条请求都要扫整张表，一年下来几千条就是每条请求扫几千次。
 */
function prune(now = Date.now()) {
  const before = records.length;
  records = records.filter((record) => {
    if (record.revokedAt && now - record.revokedAt > PRUNE_GRACE_MS) return false;
    if (record.expiresAt && record.expiresAt + PRUNE_GRACE_MS < now) return false;
    return true;
  });
  if (records.length !== before) rebuildIndex();
  return before - records.length;
}

/**
 * 签发一条记录。
 *
 * `extra` 带协议 v2 的密钥材料（`deviceKey` / `keyId`）。老形状（只带 6 位码）没有密钥材料，
 * 那种记录不带 `deviceKey`，设备列表按「旧式」显示、撤销文案也不同。
 *
 * 返回的 `credential` 是**整串 Bearer**：同一枚同时进 `token` / `cookie` / `deviceCredential`。
 * `hostToken` 形参只为兼容旧调用方保留，新记录一律不存。
 */
function issue(instanceId, device, hostToken, ttlMs = DEFAULT_TTL_MS, extra = {}) {
  load();
  // 只读副本不许签发：它写在内存里的那条既不会落盘、也会被下一次重载抹掉，于是
  // 「配上了但立刻查不到」这种半截状态只会在真机联调时以随机 401 的形式出现。
  // 旁路子进程要签发走 IPC 交给主进程（`lib/impl.js` 的 `/internal/issue-credential`）。
  if (readOnly) {
    const error = new Error('凭据库的只读副本不能签发；旁路子进程请经 IPC 交给主进程');
    error.code = 'READ_ONLY';
    throw error;
  }
  const deviceId = String(device?.deviceId || device?.id || crypto.randomUUID()).slice(0, 128);
  const random = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = Number.isFinite(ttlMs) && ttlMs > 0 ? now + ttlMs : null;
  const credential = `${instanceId}.${expiresAt === null ? 0 : Math.floor(expiresAt / 1000)}.${random}`;
  const record = {
    instanceId,
    deviceId,
    hash: digest(credential),
    hostToken: typeof hostToken === 'string' ? hostToken : '',
    createdAt: now,
    ...(expiresAt !== null ? { expiresAt } : {}),
    format: 't1',
    ...deviceMeta(device),
  };
  const deviceKey = typeof extra?.deviceKey === 'string' ? extra.deviceKey : '';
  const keyId = typeof extra?.keyId === 'string' ? extra.keyId : '';
  if (deviceKey) record.deviceKey = deviceKey;
  if (keyId) record.keyId = keyId;
  prune(now);
  records.push(record);
  rebuildIndex();
  save();
  // 刚写过盘，所以接下来一分钟内的 `touch` 不必再写一次（节流基准跟着这次写走）。
  lastTouchFlushAt = now;
  return { credential, deviceId, expiresAt, ...(keyId ? { keyId } : {}) };
}

/**
 * 查记录（不看是否有效）。
 *
 * `find()` 回答「能不能放行」，这个回答「我们是不是签发过」。区别是承重的：桌面宿主与中转
 * 各有自己的库，公网配对时凭据由中转签、宿主没见过，那枚必须回退到无状态令牌；而宿主
 * **确实签发过**的凭据必须以记录为准，否则吊销永远不生效。
 */
function lookup(credential, instanceId) {
  // **必须 refresh，不能只 load**：旁路子进程持的是只读副本，`load()` 一生只读一次盘，
  // 于是「子进程起来之后才配对的设备」在这条路上永远查不到 —— 表现是局域网口一律 401
  // （普通请求与 Metro 的预览通道都过不去），App 只能退回公网中转。文件指纹变了才重读，
  // 稳态下只多一次 stat。
  refresh();
  if (typeof credential !== 'string' || !credential) return null;
  const record = byHash.get(digest(credential));
  if (!record) return null;
  if (instanceId && record.instanceId !== instanceId) return null;
  return record;
}

/** 查一条仍然有效的记录。 */
function find(credential, instanceId) {
  const record = lookup(credential, instanceId);
  return record && isLive(record) ? record : null;
}

/** 记录是否既没被吊销也没过期。 */
function isLive(record, now = Date.now()) {
  return Boolean(record) && !record.revokedAt && (!record.expiresAt || record.expiresAt > now);
}

/**
 * 按密钥标识找设备密钥（协议 v2 的验签入口）。
 *
 * **必须按 keyId，不能按 deviceId**：deviceId 是手机自填的，克隆/迁移后会撞，撞了就是
 * 「两台手机能用同一把密钥验签」。keyId 是配对时宿主生成的 8 字节随机，不会撞。
 */
function findByKeyId(instanceId, keyId) {
  refresh();
  if (typeof keyId !== 'string' || !keyId) return null;
  const now = Date.now();
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record.instanceId !== instanceId || record.keyId !== keyId) continue;
    // 同一 keyId 只可能有一条（当场生成的随机），命中即终局：不 live 就按不认识处理，
    // 别继续往上翻旧记录 —— 那等于让吊销过的 keyId 靠更老的一条复活。
    return isLive(record, now) ? record : null;
  }
  return null;
}

/**
 * 记一次「这台设备刚连上过」（§3.4）。
 *
 * 内存里每次都更新（面板 3 秒轮询要的是当下的值），落盘按全局 1 分钟节流：每条请求都写一次
 * 盘，是拿磁盘换一个只用来显示「几分钟前」的字段。`issue` / `revoke` 立刻写，不受它影响。
 */
function touch(record, info = {}) {
  load();
  if (!record || typeof record !== 'object') return false;
  const now = Date.now();
  record.lastSeenAt = now;
  const channel = typeof info.channel === 'string' ? info.channel : '';
  if (channel) record.lastChannel = channel.slice(0, FIELD_MAX);
  // 身份那几格（2026-10-26）：名字 / 平台 / 系统版本 / App 版本由**每一次请求**带上来，
  // 顺手刷新。它们以前只在配对那一刻写一次，于是「手机升到新版了、面板还报配对时的旧版本」，
  // 而旧会话升级写进来的记录干脆什么身份都没有（面板只能画「未知设备」）。
  // **只写这次真带了值的格子**：老版本 App 不带头，绝不能把已经有的名字冲成空。
  const meta = deviceMeta(info.meta);
  let metaChanged = false;
  for (const key of Object.keys(meta)) {
    if (record[key] !== meta[key]) {
      record[key] = meta[key];
      metaChanged = true;
    }
  }
  if (readOnly) return true;
  // 身份变了必须落盘（那是面板唯一能看到的来源）；只刷新「刚连上过」才走老的一分钟节流。
  if (!metaChanged && now - lastTouchFlushAt < TOUCH_FLUSH_MS) return true;
  lastTouchFlushAt = now;
  save();
  return true;
}

/**
 * 滑动续期（§3.9）：剩余不到一半就把 `expiresAt` 后推一个新 TTL。
 *
 * 不需要新协议 —— 服务端本来就以记录为准、不验 token 里的 `exp`，所以续期就是改这条记录。
 * **不能改 token 本身**：库按整串哈希查，改一个字节手机上那枚就对不上了。
 * 只读副本不续期：写盘是主进程的事，旁路续了会被主进程那份覆写掉。
 */
function renew(record, ttlMs = DEFAULT_TTL_MS) {
  load();
  if (readOnly || !record || typeof record !== 'object' || !record.expiresAt) return false;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false;
  const now = Date.now();
  if (record.expiresAt - now > ttlMs * RENEW_BELOW_RATIO) return false;
  record.expiresAt = now + ttlMs;
  prune(now);
  save();
  return true;
}

function revoke(credential, instanceId) {
  load();
  // 只读副本吊销了也不落盘，下一次重载就「复活」—— 这种「看起来成功、其实没生效」
  // 正是吊销最不能有的失败形态。旁路的吊销同样走 IPC 交给主进程。
  if (readOnly) {
    const error = new Error('凭据库的只读副本不能吊销；旁路子进程请经 IPC 交给主进程');
    error.code = 'READ_ONLY';
    throw error;
  }
  const record = lookup(credential, instanceId);
  if (!record || record.revokedAt) return false;
  record.revokedAt = Date.now();
  prune();
  save();
  return true;
}

/** 吊销一台设备名下**所有**仍有效的记录：同一台手机重配几次就是几条。 */
function revokeDevice(instanceId, deviceId) {
  load();
  const now = Date.now();
  let count = 0;
  for (const record of records) {
    if (record.instanceId !== instanceId || record.deviceId !== deviceId || record.revokedAt) continue;
    record.revokedAt = now;
    count += 1;
  }
  if (count && !readOnly) { prune(now); save(); }
  return count;
}

/** 吊销本实例的全部记录。轮换 `lanSecret` 另算，那一刀专杀旧 HMAC。 */
function revokeAllByInstance(instanceId) {
  load();
  const now = Date.now();
  let count = 0;
  for (const record of records) {
    if (record.instanceId !== instanceId || record.revokedAt) continue;
    record.revokedAt = now;
    count += 1;
  }
  if (count && !readOnly) { prune(now); save(); }
  return count;
}

function listActive() {
  load();
  const now = Date.now();
  return records
    .filter((record) => isLive(record, now))
    .map(({ instanceId, deviceId, createdAt, expiresAt }) => ({ instanceId, deviceId, createdAt, ...(expiresAt ? { expiresAt } : {}) }));
}

/**
 * 面板要的那份设备清单（§3.4）。
 *
 * 按 `deviceId` 聚成一行：同一台手机重配几次不该在列表里重复出现。名字与平台取最新一条
 * **有值的**记录（老记录这些字段是空的，空的不能覆盖有值的），绑定时间取最早，最近连接取
 * 最大，走哪条路取最近那条的。
 *
 * `legacy` 标的是「这个 deviceId 下还有不带设备密钥的活记录」：那种凭据的吊销杀不掉旧
 * Bearer，界面上的撤销文案必须区别对待，不能写「立即失效」。
 *
 * **不回 hash / hostToken / deviceKey**：那些是凭据与密钥材料，面板只是显示谁连着。
 */
function listDevices(instanceId) {
  load();
  const now = Date.now();
  const rows = new Map();
  for (const record of records) {
    if (record.instanceId !== instanceId || !isLive(record, now)) continue;
    const key = String(record.deviceId || '');
    const createdAt = Number(record.createdAt) || 0;
    let row = rows.get(key);
    if (!row) {
      row = {
        deviceId: key,
        name: '',
        platform: '',
        osVersion: '',
        appVersion: '',
        boundAt: createdAt,
        lastSeenAt: 0,
        lastChannel: '',
        lastSeenFrom: 0,
        legacy: false,
        encrypted: false,
        expiresAt: 0,
      };
      rows.set(key, row);
    }
    if (createdAt && (!row.boundAt || createdAt < row.boundAt)) row.boundAt = createdAt;
    // 名字与平台取最新一条有值的：老记录没有这些字段，空不能覆盖有值。
    if (record.name && createdAt >= (row.nameAt || 0)) { row.name = record.name; row.nameAt = createdAt; }
    if (record.platform && createdAt >= (row.platformAt || 0)) { row.platform = record.platform; row.platformAt = createdAt; }
    if (record.osVersion && createdAt >= (row.osVersionAt || 0)) { row.osVersion = record.osVersion; row.osVersionAt = createdAt; }
    if (record.appVersion && createdAt >= (row.appVersionAt || 0)) { row.appVersion = record.appVersion; row.appVersionAt = createdAt; }
    const seenAt = Number(record.lastSeenAt) || 0;
    if (seenAt >= row.lastSeenFrom) {
      row.lastSeenFrom = seenAt;
      row.lastSeenAt = seenAt;
      if (record.lastChannel) row.lastChannel = record.lastChannel;
    }
    if (record.expiresAt) row.expiresAt = Math.max(row.expiresAt, Number(record.expiresAt) || 0);
    if (!record.deviceKey) row.legacy = true;
    // 带设备密钥的记录才走逐请求签名；只带 6 位码配对的那个版本永远是明文。
    if (record.deviceKey) row.encrypted = true;
  }
  const out = [];
  const labelCount = new Map();
  for (const row of rows.values()) {
    const label = `${row.name}\u0000${row.platform}`;
    labelCount.set(label, (labelCount.get(label) || 0) + 1);
  }
  for (const row of rows.values()) {
    const { nameAt, platformAt, osVersionAt, appVersionAt, lastSeenFrom, ...rest } = row;
    // 同名同平台的两台手机在列表里长得一样，加 deviceId 后 4 位才分得清；名字本来就不重复的
    // 不加，别让每行都挂一串十六进制。
    const duplicated = Boolean(row.name) && (labelCount.get(`${row.name}\u0000${row.platform}`) || 0) > 1;
    out.push({
      ...rest,
      name: duplicated ? `${row.name} · ${String(row.deviceId).slice(-4)}` : row.name,
    });
  }
  // 最近连着的排前面；从没连过的按绑定时间倒序垫后。
  out.sort((a, b) => (b.lastSeenAt - a.lastSeenAt) || (b.boundAt - a.boundAt));
  return out;
}

/**
 * 本实例签发过、仍然有效的凭据摘要，按签发时间从新到旧。
 *
 * 中转的离线镜像要在桌面宿主上线之前判断「来读缓存的人是不是配对过的手机」，而它手上只有
 * 手机发来的整串凭据 —— 这里给出同一口径的 sha256（落盘存的本来就是这个摘要），它自己算
 * 一遍就能比对。吊销与过期在这里现读现滤。
 */
function activeDigests(instanceId) {
  load();
  const now = Date.now();
  const live = [];
  // 记录只在新签发时追加，倒着走就是 createdAt 倒序：超出上限时被截掉的是最老的。
  for (let i = records.length - 1; i >= 0 && live.length < MAX_ACTIVE_DIGESTS; i -= 1) {
    const record = records[i];
    if (record.instanceId !== instanceId || !isLive(record, now)) continue;
    live.push({ hash: record.hash, ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}) });
  }
  return live;
}

/** 测试用：重置内存态（不动盘）。 */
function resetForTest() {
  loaded = false;
  records = [];
  byHash = new Map();
  stamp = null;
  readOnly = false;
  lastTouchFlushAt = 0;
}

module.exports = {
  FILE,
  DEFAULT_TTL_MS,
  MAX_ACTIVE_DIGESTS,
  prune,
  issue,
  find,
  lookup,
  isLive,
  findByKeyId,
  touch,
  renew,
  refresh,
  setReadOnly,
  isReadOnly,
  listActive,
  listDevices,
  activeDigests,
  revoke,
  revokeDevice,
  revokeAllByInstance,
  resetForTest,
};

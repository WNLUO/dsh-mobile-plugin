'use strict';

/**
 * 桌面端工作区视图快照（侧边栏展开/折叠）的宿主侧存储。
 *
 * 桌面端把「哪些工作区分组是展开的」只记在**浏览器 localStorage**
 * （`dsh.workspace.view.v5`，见 @deepseek-ai/dsh-client-ui-workspace 的
 * createWorkspaceViewStore → dsh-client-store 的 localStorage 持久化），
 * 宿主进程、中转和手机都读不到它。插件因此带了一个客户端半边（lib/client.js）：
 * 桌面页面里每 2 秒读一次这份状态，变了就 POST `/api/relay/desktop-view`，
 * 由本模块落到 `$DSH_HOME/desktop-view.json`，再由 `/api/mobile/v1/desktop-view`
 * 下发给 App。
 *
 * 语义与桌面端严格一致：`groupExpansion` 以 **workspaceId** 为键（未分组分组固定为
 * 空串 `''`），只有**显式 true** 表示展开，缺省＝折叠；桌面端在「当前会话所属分组
 * 还没有记录」时会自动展开它并落盘，所以「当前会话所在工作区」通常也在里面。
 */

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./shared/paths');
const { desktopViewSignal } = require('./shared/desktop-view-signal.js');

/** 单个键（workspaceId）长度上限；超长的一律丢弃（真实 id 只有十几字节）。 */
const MAX_KEY_LENGTH = 200;
/** 键数量上限：桌面端可能的分组数远小于它，这里只用于防灌爆。 */
const MAX_KEYS = 512;
/** 上报来源标识（桌面端的 localStorage 键名）长度上限。 */
const MAX_SOURCE_LENGTH = 64;

/** 快照文件：$DSH_HOME/desktop-view.json（DSH_HOME 在调用时解析，便于测试注入）。 */
function stateFile() {
  return path.join(paths.dshHome(), 'desktop-view.json');
}

/** null = 还没有可用快照；否则 { groupExpansion, receivedAt, source }。 */
let cached = null;
let loaded = false;

/**
 * 折叠态内容指纹（键排序后序列化）。
 *
 * 只用来回答「这次上报真的改了折叠态吗」：两次 JSON.stringify 的键序不保证一致，
 * 直接比会让同一份状态被认成两次变更。内容没变就既不重写文件、也不给手机推帧。
 */
function expansionFingerprint(groupExpansion) {
  const keys = Object.keys(groupExpansion).sort();
  return JSON.stringify(keys.map((key) => [key, groupExpansion[key]]));
}

/** 归一化上报的 groupExpansion：只保留布尔值、限长限量；形状不对返回 null。 */
function normalizeGroupExpansion(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  let count = 0;
  for (const rawKey of Object.keys(input)) {
    const value = input[rawKey];
    if (typeof value !== 'boolean') continue;
    const key = rawKey.trim();
    if (key.length > MAX_KEY_LENGTH) continue;
    out[key] = value;
    count += 1;
    if (count >= MAX_KEYS) break;
  }
  return out;
}

function load() {
  if (loaded) return cached;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const groupExpansion = normalizeGroupExpansion(raw && raw.groupExpansion);
    if (!groupExpansion) {
      cached = null;
      return cached;
    }
    cached = {
      groupExpansion,
      receivedAt: Number.isFinite(raw && raw.receivedAt) ? raw.receivedAt : 0,
      source: typeof (raw && raw.source) === 'string' ? raw.source : '',
    };
  } catch {
    // 文件不存在 / 损坏都按「桌面端还没上报过」处理：App 侧退回折叠缺省。
    cached = null;
  }
  return cached;
}

/** 当前快照的副本；从未收到过上报时返回 null。 */
function snapshot() {
  const value = load();
  if (!value) return null;
  return {
    groupExpansion: { ...value.groupExpansion },
    updatedAt: value.receivedAt,
    source: value.source,
  };
}

/** 记录一次桌面页面上报；非法形状抛错（调用方回 400）。返回落盘后的快照。 */
function update(input, now = Date.now()) {
  const groupExpansion = normalizeGroupExpansion(input && input.groupExpansion);
  if (!groupExpansion) throw new Error('groupExpansion 必须是对象');
  const rawSource = input && (typeof input.source === 'string' ? input.source : input.storageKey);
  const previous = load();
  const next = {
    groupExpansion,
    receivedAt: now,
    source: typeof rawSource === 'string' ? rawSource.slice(0, MAX_SOURCE_LENGTH) : '',
  };
  // 折叠态没变就不落盘、不广播：客户端半边在页面重载 / 切窗口时会重发同一份。
  // 什么都没变却写一次文件、给每台手机推一帧，等于把白问的轮询换成白推的帧。
  const changed = !previous || expansionFingerprint(previous.groupExpansion) !== expansionFingerprint(groupExpansion);
  if (!changed) return snapshot();
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  cached = next;
  loaded = true;
  // 落盘之后再广播：订阅方收到帧会立刻回来读这条路（GET /desktop-view 读的是这份
  // cached），先通知后落盘会把它引到上一份内容上。
  desktopViewSignal.bump(next.receivedAt);
  return snapshot();
}

module.exports = { stateFile, snapshot, update };

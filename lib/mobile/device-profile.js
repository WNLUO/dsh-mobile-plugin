// 2026-11-27：归纳请求不再带 Authorization，插件不读 Key。
// 2026-11-26：设备画像核心模块，采集宿主会话/工作区信号、归纳用途、开关与变化检测（插件侧每实例一份）。
'use strict';

/**
 * 设备画像的源头在电脑插件：一台电脑一份画像，手机只读同步过去的副本。
 *
 * 这个模块只做四件事：把宿主已有的会话/工作区清单折成少量信号（不碰模型），把信号交给
 * 电脑上那把 Key 归纳成一句话，管两个开关，以及在信号真变了时才更新画像。所有磁盘读写
 * 都吞掉失败——画像只是锦上添花的上下文，不该让路由或事件因为它挂掉。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { dshHome } = require('../shared/paths.js');
const { stableRevision } = require('../shared/list-revision.js');
const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');
const { listTitle } = require('./history-derive.js');
const { customChannelById, PI_AI_NS, chatCompletionUrlOf } = require('./channels.js');
const { deviceProfileRefreshStateOf } = require('./session-cache.js');

/** 画像与开关都落在 dshHome 下，固定文件名；与移动端其它插件状态互不干扰。 */
const PROFILE_FILE = 'mobile-device-profile.json';
const SWITCHES_FILE = 'mobile-learning-switches.json';

/** 工作区与最近会话各留几条：够模型认出这台电脑在干什么，不把整份清单塞进提示词。 */
const MAX_TITLES = 8;
/** 事件帧来得很密：最短间隔内只算一次，在途的那一次多方共用。 */
const REFRESH_MIN_INTERVAL_MS = 60 * 1000;
/** 归纳请求的上限；归纳卡住不该一直占着请求。 */
const UPSTREAM_TIMEOUT_MS = 30 * 1000;
/** 一句话用途的长度兜底。 */
const NOTE_MAX_CHARS = 400;

/** system 提示只许一到两句中文，不解释、不列表——这段文案直接决定画像有没有噪声。 */
const SYSTEM_PROMPT = '只输出一到两句中文，概括这台电脑的主要用途。不要解释，不要列表，不要引号。';

function profileFile() {
  return path.join(dshHome(), PROFILE_FILE);
}

function switchesFile() {
  return path.join(dshHome(), SWITCHES_FILE);
}

function emptyProfile() {
  return { workspaces: [], recentTitles: [], updatedAt: 0, revision: '' };
}

function defaultSwitches() {
  return { passiveEnabled: true, modelEnabled: false };
}

/** 去掉 revision 之后的本体算指纹；键序排一遍，落盘再读回来不会因插入顺序不同而误判成变化。 */
function makeRevision(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return '';
  const body = { ...profile };
  delete body.revision;
  const canonical = {};
  for (const key of Object.keys(body).sort()) canonical[key] = body[key];
  return stableRevision(canonical);
}

/**
 * 读画像：文件不在、读不动、坏了都当没有（null），不把异常交给调用方。
 * 数组字段逐项筛一遍，坏条目不该让整份画像在后面拼接时炸掉。
 */
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(profileFile(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (!Array.isArray(raw.workspaces) || !Array.isArray(raw.recentTitles)) return null;
    return {
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
      ...(typeof raw.platform === 'string' ? { platform: raw.platform } : {}),
      workspaces: raw.workspaces.filter((title) => typeof title === 'string'),
      recentTitles: raw.recentTitles.filter((title) => typeof title === 'string'),
      ...(typeof raw.note === 'string' ? { note: raw.note } : {}),
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
      revision: typeof raw.revision === 'string' ? raw.revision : '',
    };
  } catch {
    return null;
  }
}

/** 原子写：同目录临时文件 + rename，写一半断电也不会留下半份 JSON。写不进去就吞掉。 */
async function save(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return;
  try {
    const file = profileFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(profile)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    /* 画像写不进去不影响这次请求 */
  }
}

/**
 * 采集宿主信号，一步一 try：哪扇门不可用就少那一项，其余照常返回。
 * 只用宿主已有的 sessions.list / workspace.list，不查模型、不发额度请求。
 */
async function collect(ctx) {
  const out = {};

  try {
    const name = typeof os.hostname === 'function' ? os.hostname() : '';
    if (typeof name === 'string' && name.trim()) out.name = name.trim();
  } catch { /* 设备名拿不到就少这一项 */ }

  try {
    if (typeof process.platform === 'string' && process.platform) out.platform = process.platform;
  } catch { /* 系统标识拿不到就少这一项 */ }

  try {
    const { value, error } = unwrap(await ctx.apiProxy.workspace.list({
      rpcId: 'mobile', method: 'workspace.list', payload: {},
    }));
    if (!error) {
      const items = Array.isArray(value) ? value : (value && Array.isArray(value.items) ? value.items : []);
      out.workspaces = items
        .map((item) => (item && typeof item.title === 'string' ? item.title.trim() : ''))
        .filter(Boolean)
        .slice(0, MAX_TITLES);
    }
  } catch { /* 工作区清单失败只少这一项 */ }

  try {
    const { value, error } = unwrap(await callSessions(ctx, 'list', {}));
    if (!error) {
      const items = Array.isArray(value) ? value : (value && Array.isArray(value.items) ? value.items : []);
      out.recentTitles = items
        .map((item) => listTitle(item))
        .filter((title) => typeof title === 'string' && title.trim())
        .slice(0, MAX_TITLES)
        .map((title) => title.trim());
    }
  } catch { /* 会话清单失败只少这一项 */ }

  return out;
}

/**
 * 读开关。被动采集默认开、花额度的归纳默认关；读坏一律回默认值，不抛。
 */
function getSwitches() {
  const defaults = defaultSwitches();
  try {
    const raw = JSON.parse(fs.readFileSync(switchesFile(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
    return {
      passiveEnabled: typeof raw.passiveEnabled === 'boolean' ? raw.passiveEnabled : defaults.passiveEnabled,
      modelEnabled: typeof raw.modelEnabled === 'boolean' ? raw.modelEnabled : defaults.modelEnabled,
    };
  } catch {
    return defaults;
  }
}

/** 写开关：只认两个布尔，其余键不落盘；读坏或写不动都不抛给调用方。 */
function setSwitches(next) {
  const current = getSwitches();
  const merged = {
    passiveEnabled: next && typeof next.passiveEnabled === 'boolean' ? next.passiveEnabled : current.passiveEnabled,
    modelEnabled: next && typeof next.modelEnabled === 'boolean' ? next.modelEnabled : current.modelEnabled,
  };
  try {
    const file = switchesFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    /* 开关写不进去不抛；下一次读仍是磁盘上的真值 */
  }
  return merged;
}

/**
 * 电脑上第一条可用的自建渠道。只认 llm-pi-ai 的 providers —— customChannelById 也只认
 * 这一处，挑别的 id 只会换来 channel-not-found。这里有地址就算可用，模型由调用方指定或
 * 取这条渠道的第一个。
 */
async function firstCustomChannelId(ctx) {
  const described = unwrap(await ctx.apiProxy.settings.describe({
    rpcId: 'mobile', method: 'settings.describe', payload: {},
  }));
  if (described.error) return '';
  const namespaces = Array.isArray(described.value && described.value.namespaces) ? described.value.namespaces : [];
  const piAi = namespaces.find((entry) => entry && entry.ns === PI_AI_NS);
  const value = piAi && piAi.value;
  const providers = value && typeof value === 'object' && value.providers
    && typeof value.providers === 'object' && !Array.isArray(value.providers) ? value.providers : {};
  for (const id of Object.keys(providers)) {
    const row = providers[id];
    if (row && typeof row === 'object' && typeof row.baseURL === 'string' && row.baseURL.trim()) return id;
  }
  return '';
}

function titlesLine(values, fallback) {
  const source = Array.isArray(values) ? values : fallback;
  return source.filter((title) => typeof title === 'string' && title.trim()).slice(0, MAX_TITLES).join('、') || '无';
}

/**
 * 归纳一句话用途。额度闸在最前面：关着时连宿主都不问，更不发请求。
 * 渠道取自电脑自己那一份（customChannelById）；插件不读 Key，请求头里不带鉴权。
 * 任何失败都只用契约里的三个错误码。
 */
async function summarize(ctx, options = {}) {
  if (getSwitches().modelEnabled !== true) return { ok: false, errorCode: 'learning-disabled' };

  let found = null;
  try {
    const requested = typeof options.channelId === 'string' ? options.channelId.trim() : '';
    const id = requested || await firstCustomChannelId(ctx);
    if (!id) return { ok: false, errorCode: 'no-channel' };
    found = await customChannelById(ctx, id);
  } catch {
    return { ok: false, errorCode: 'no-channel' };
  }
  if (!found || found.error || !found.channel || !chatCompletionUrlOf(found.channel.baseUrl)) {
    return { ok: false, errorCode: 'no-channel' };
  }

  const supplied = typeof options.model === 'string' ? options.model : '';
  const first = Array.isArray(found.channel.models) && found.channel.models[0]
    ? found.channel.models[0].id : '';
  const model = (typeof supplied === 'string' && supplied.trim()) || (typeof first === 'string' ? first.trim() : '');
  if (!model) return { ok: false, errorCode: 'summary-failed' };

  const profile = load() || emptyProfile();
  let signals = {};
  try {
    signals = await collect(ctx);
  } catch {
    signals = {};
  }
  const userContent = [
    '以下是这台电脑的已知信号，请据此归纳它的一到两句用途。',
    `设备名：${signals.name || profile.name || '未知'}`,
    `系统：${signals.platform || profile.platform || '未知'}`,
    `工作区：${titlesLine(signals.workspaces || profile.workspaces, [])}`,
    `最近会话：${titlesLine(signals.recentTitles || profile.recentTitles, [])}`,
    ...(profile.note ? [`上一版用途：${profile.note}`] : []),
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(chatCompletionUrlOf(found.channel.baseUrl), {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        max_tokens: 120,
      }),
    });
    if (!response || !response.ok) return { ok: false, errorCode: 'summary-failed' };
    const data = await response.json();
    const choices = data && Array.isArray(data.choices) ? data.choices : [];
    const message = choices[0] && choices[0].message;
    let content = message ? message.content : '';
    if (Array.isArray(content)) {
      content = content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('');
    }
    if (typeof content !== 'string') return { ok: false, errorCode: 'summary-failed' };
    const note = content.trim().replace(/\s+/g, ' ').slice(0, NOTE_MAX_CHARS);
    if (!note) return { ok: false, errorCode: 'summary-failed' };
    return { ok: true, note };
  } catch {
    return { ok: false, errorCode: 'summary-failed' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 变化检测：每 60 秒最多问一次宿主，在途的那一次多方合并。
 * 用「保留旧 updatedAt 的候选」算指纹再比，空转时指纹不变就不写盘、不回 true；
 * 真变了才改 updatedAt 并重算指纹，配合 makeRevision 的口径（指纹只盖本体）。
 */
const fallbackRefreshState = { lastAt: 0, inFlight: null };

function refreshStateOf(ctx) {
  if (!ctx || (typeof ctx !== 'object' && typeof ctx !== 'function')) return fallbackRefreshState;
  return deviceProfileRefreshStateOf(ctx);
}

async function refreshIfChanged(ctx) {
  const state = refreshStateOf(ctx);
  if (state.inFlight) return state.inFlight;

  const now = Date.now();
  if (now - state.lastAt < REFRESH_MIN_INTERVAL_MS) return false;
  state.lastAt = now;

  const task = (async () => {
    const existing = load();
    const base = existing || emptyProfile();
    let signals = {};
    try {
      signals = await collect(ctx);
    } catch {
      signals = {};
    }
    const candidate = {
      ...base,
      ...signals,
      workspaces: Array.isArray(signals.workspaces) ? signals.workspaces : base.workspaces,
      recentTitles: Array.isArray(signals.recentTitles) ? signals.recentTitles : base.recentTitles,
      updatedAt: base.updatedAt,
    };
    const seen = makeRevision(candidate);
    if (seen && seen === base.revision) return false;

    const next = { ...candidate, updatedAt: Date.now() };
    next.revision = makeRevision(next);
    await save(next);
    return true;
  })();

  state.inFlight = task;
  try {
    return await task;
  } finally {
    if (state.inFlight === task) state.inFlight = null;
  }
}

module.exports = {
  load,
  save,
  collect,
  makeRevision,
  summarize,
  getSwitches,
  setSwitches,
  refreshIfChanged,
};

'use strict';

/**
 * 扩展卡的宿主侧：卡状态账本、扩展动作登记表，以及给模型用的 `extension_present` 工具。
 *
 * 为什么卡状态要落在宿主家里：一张卡「现在长什么样」不能只靠声明它的那一次工具调用。
 * 扩展页回写标题与说明之后，手机上重进会话、刷新列表都会从历史重新拼卡 —— 没有这份账本，
 * 卡会一直停在声明那一刻的样子（讨论记录 3.3 第三条：卡的状态得由宿主认账）。账本与会话
 * 日志无关，清理会话不连带它，与统计账本同口径。
 *
 * 为什么动作名是一张硬编码白名单：扩展是网页，它能让宿主做的事必须由宿主预先枚举，而不是
 * 由扩展在消息里现拼一个动作名交给宿主执行。这条边界和移动 API 的能力面是同一条 —— 移动
 * API 不暴露 shell、系统设置、任意文件读写，这里也一个都不开。**登记表现在是空的**：宿主动作
 * 这一档还没有对任何扩展放开，所以任何动作名都必须被拒。
 */

const fs = require('node:fs');
const path = require('node:path');

const { sendJson, readJsonBody } = require('../shared/http-util');
const { dshHome } = require('../shared/paths');

/** 账本文件名。跟会话日志分开，清理会话时不动它。 */
const CARDS_FILE = 'mobile-extension-cards.json';
/** 一条卡状态的标题 / 说明上限：App 那张卡只画一行，长正文只会把它撑坏。 */
const MAX_TEXT = 200;
/** 整张表的上限：会话越积越多，不封顶的话这份 JSON 会一直长下去。 */
const MAX_CARDS = 500;

function cardsFile() {
  return path.join(dshHome(), CARDS_FILE);
}

/**
 * 读整张表。文件不在、读坏、形状不对都当空表 —— 账本是锦上添花，读不出来不该让请求失败
 * （卡按声明的样子画，下一次回写会把它补回来）。
 */
function readLedger() {
  let text;
  try { text = fs.readFileSync(cardsFile(), 'utf8'); } catch { return {}; }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed;
}

/**
 * 整份覆写。**写失败不抛**：回写卡状态是扩展页的一次旁路动作，写不进去最多是下次进会话
 * 看到旧状态，不该把这次请求变成失败。仍然是先写临时文件再改名，宿主随时可能被杀。
 */
function writeLedger(table) {
  const file = cardsFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(table, null, 2)}\n`);
    fs.renameSync(temp, file);
  } catch { /* 旁路：写不进去就算了 */ }
}

function cardKey(sessionId, cardId) {
  return `${sessionId}:${cardId}`;
}

function textOf(value) {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : '';
}

/** 一条记录至少要有身份：会话、卡、扩展三者缺一就没有可认的卡。 */
function validCard(input) {
  if (!input || typeof input !== 'object') return null;
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  const cardId = typeof input.cardId === 'string' ? input.cardId.trim() : '';
  const extension = typeof input.extension === 'string' ? input.extension.trim() : '';
  const title = textOf(input.title);
  const detail = textOf(input.detail);
  // title 与 detail 都空等于「这张卡什么都没变」，收下来只会把声明时那句话擦掉。
  if (!sessionId || !cardId || !extension) return null;
  if (!title && !detail) return null;
  return { sessionId, cardId, extension, title, detail };
}

/** 丢掉最旧的那几条，直到表回到上限以内。 */
function trimLedger(table) {
  const entries = Object.entries(table);
  if (entries.length <= MAX_CARDS) return;
  entries.sort((left, right) => (Number(left[1].updatedAt) || 0) - (Number(right[1].updatedAt) || 0));
  for (const [key] of entries.slice(0, entries.length - MAX_CARDS)) delete table[key];
}

/**
 * 写一条卡状态。参数不合法回 null（调用方据此回 400），合法则回完整记录。
 *
 * 同一张卡重复回写是覆盖，不追加：`sessionId:cardId` 就是这张卡的身份，与 App 侧
 * 卡上的 id（那次工具调用的 id）是同一个东西。
 */
function writeCard(input) {
  const card = validCard(input);
  if (!card) return null;
  const table = readLedger();
  const record = { ...card, updatedAt: Date.now() };
  table[cardKey(card.sessionId, card.cardId)] = record;
  trimLedger(table);
  writeLedger(table);
  return record;
}

/** 这条会话里被回写过的卡状态。坏行丢掉，别的会话的一律不带上。 */
function readCards(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return [];
  const table = readLedger();
  const cards = [];
  for (const value of Object.values(table)) {
    if (!value || typeof value !== 'object') continue;
    if (value.sessionId !== sessionId) continue;
    if (typeof value.cardId !== 'string' || !value.cardId) continue;
    if (typeof value.extension !== 'string' || !value.extension) continue;
    cards.push({
      cardId: value.cardId,
      extension: value.extension,
      title: typeof value.title === 'string' ? value.title : '',
      detail: typeof value.detail === 'string' ? value.detail : '',
      updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    });
  }
  return cards;
}

/**
 * 已登记的宿主动作：扩展 slug → { 动作名: 处理函数 }。
 *
 * **现在是空的**：宿主动作这一档还没有对任何扩展放开，所以 `actionsFor` 恒回空数组、
 * `runAction` 恒回 `extension-action-unknown`。要放开第三方来源时，在这里逐个扩展、
 * 逐个动作名登记 —— 只认这张表里的字面名字，不接受通配，也不接受调用方现拼的动作名。
 * 处理函数拿到的是扩展带来的 params，返回值放进 `result` 原样交回。
 */
const HOST_ACTIONS = Object.freeze({
  // '某个扩展的 slug': {
  //   '某个动作名': async (params) => ({ /* 交回给扩展的结果 */ }),
  // },
});

/** 这个扩展被宿主预先枚举过的动作名；没登记过就是空数组。 */
function actionsFor(extensionSlug) {
  if (typeof extensionSlug !== 'string' || !extensionSlug) return [];
  const table = HOST_ACTIONS[extensionSlug];
  return table ? Object.keys(table) : [];
}

/**
 * 让宿主替扩展办一件事。
 *
 * 动作名不在 `actionsFor` 里一律拒 —— 包括 `*` 这类看起来像通配的写法。有登记时按登记表
 * 里的处理函数执行；登记表现在是空的，所以这条分支只剩形状（放开时在下面接处理函数）。
 *
 * **不抛异常**：被拒是预期结果，不是故障，调用方要拿它回 403 而不是 500。
 */
async function runAction(input) {
  const extension = input && typeof input.extension === 'string' ? input.extension : '';
  const action = input && typeof input.action === 'string' ? input.action : '';
  if (!extension || !action || !actionsFor(extension).includes(action)) {
    return { ok: false, code: 'extension-action-unknown', message: '该扩展没有登记这个动作' };
  }
  const handler = HOST_ACTIONS[extension][action];
  return { ok: true, result: await handler(input.params) };
}

/**
 * 模型声明一张扩展卡的工具。
 *
 * 卡本身不是这里存的：工具只把「哪个扩展、哪张卡、写了什么」说清楚，App 从历史里那次调用
 * 的参数画出卡，之后的状态回写落在上面那张账本里。所以这里不写账本 —— 声明与回写是两件事
 * （卡可以声明之后再也没人动过）。
 */
function registerExtensionTool(ctx) {
  const { defineTool } = require('@deepseek-ai/dsh-tools');
  ctx.tools.register(defineTool({
    name: 'extension_present',
    description: 'Declare a card that an installed extension takes over (for example a draft or a form flow). The card is drawn from this call; the extension page can later write back its title and detail.',
    parameters: {
      extension: { type: 'string', required: true, description: 'Slug of the installed extension that takes over this content.' },
      title: { type: 'string', required: true, description: 'One-line title shown on the card.' },
      detail: { type: 'string', description: 'Optional secondary line; keep it short, the card shows one line.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        extension: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' },
      } },
      render: (_args, value) => [{ type: 'text', text: `已为扩展 ${value.extension} 声明卡片：${value.title}` }],
    },
    execute: (args) => ({
      extension: args.extension,
      title: args.title,
      detail: typeof args.detail === 'string' ? args.detail : '',
    }),
  }));
}

/**
 * 装配层的入口：挂 `extension_present` 工具。
 *
 * 账本与三条路由不依赖这个工具，所以没有 tools 注入的 profile 照样能回写卡状态；缺注入
 * 时只静默跳过（cordis 抛的是 "cannot get property … without inject"，与 session-cleanup
 * 同一口径）。其余错误照抛 —— 不能把真的注册失败也当成「这个 profile 没注入」。
 */
function installExtensions(ctx) {
  try {
    registerExtensionTool(ctx);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (!message.includes('without inject')) throw error;
  }
}

/**
 * GET /api/mobile/v1/extension/cards?sessionId=…（token）
 *
 * 这条会话里被回写过的卡状态；没有会话 id 就回 400，不拿空数组冒充「没有卡」。
 */
async function handleExtensionCards(_ctx, req, res) {
  const url = new URL(req.url || '/', 'http://x');
  const sessionId = (url.searchParams.get('sessionId') || '').trim();
  if (!sessionId) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 sessionId' } });
  }
  sendJson(res, 200, { ok: true, cards: readCards(sessionId) });
}

/**
 * POST /api/mobile/v1/extension/card-state（token）
 * body: { sessionId, cardId, extension, title?, detail? }
 *
 * `sessionId` / `cardId` / `extension` 由 App 按卡本身填，不由扩展页提供 —— 页面能指定
 * 别人的卡就等于能回写别人的卡。写失败不回错误，理由在 writeLedger 上。
 */
async function handleExtensionCardState(_ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const card = body ? writeCard(body) : null;
  if (!card) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'bad-request', message: '需要 { sessionId, cardId, extension }，且 title 与 detail 不能都为空' },
    });
  }
  sendJson(res, 200, { ok: true, card });
}

/**
 * POST /api/mobile/v1/extension/action（token）
 * body: { extension, action, params? }
 *
 * 没登记的动作回 **403**：这不是请求坏了，是预期内的拒绝，App 侧据此让扩展页自己解释
 * 「这个动作宿主没开放」，而不是当成请求失败。`code` / `message` 放在顶层，与 App 那边
 * 读 `body.code` 的口径一致（见 `app/src/api/domains/extensions.ts`）。
 */
async function handleExtensionAction(_ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  if (!body || typeof body.extension !== 'string' || !body.extension
    || typeof body.action !== 'string' || !body.action) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { extension, action }' } });
  }
  const outcome = await runAction({ extension: body.extension, action: body.action, params: body.params });
  if (!outcome.ok) return sendJson(res, 403, { ok: false, code: outcome.code, message: outcome.message });
  sendJson(res, 200, { ok: true, result: outcome.result });
}

module.exports = {
  actionsFor,
  runAction,
  readCards,
  writeCard,
  registerExtensionTool,
  installExtensions,
  handleExtensionCards,
  handleExtensionCardState,
  handleExtensionAction,
  MAX_TEXT,
  MAX_CARDS,
};

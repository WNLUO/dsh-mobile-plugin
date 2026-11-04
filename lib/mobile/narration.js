'use strict';

/**
 * 过程播报：让模型在一轮跑久了之后，用一两句话说明它此刻在做什么、卡在哪里。
 *
 * 默认关。用户看到的现场是「问完之后 AI 闷头干到底，中途一句话都没有」——模型在工具循环里
 * 本来没有任何开口的理由（中间没有新的用户消息），而进度条只是一行机器计数。开关打开后，
 * 插件在模型动手之前往这一步的上下文里递一句提醒，它就会顺带讲一句。
 *
 * 递话走 `agent/pre-step` 的 waterfall（与开发地图那套「你卡住了」的补报同一条通道）：
 * 追加一条 **非 user 来源**的 user 消息，模型下一步就带着它思考。来源不是 `user` 这一条
 * 不能省：App 直播与历史推导都把非 user 来源当上下文注入丢掉，所以这句话本身不会冒充成
 * 用户自己发的气泡 —— 用户看到的只有模型因此说出的那几句正文。
 *
 * 代价照实说：这些话是真进对话正文的，会留在这一轮的历史里、也花 token。所以缺省关、
 * 每台电脑各存一份（`<DSH_HOME>/storages/mobile-plugin/process-narration.json`）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { dshHome } = require('../shared/paths');
const { sendJson, readJsonBody } = require('../shared/http-util');

/** 第一句的门槛：一轮至少跑这么久才值得开口（短任务说一句话是纯噪声）。 */
const NARRATION_FIRST_MS = Number(process.env.DSH_MOBILE_NARRATION_FIRST_MS) || 90 * 1000;
/** 之后每隔这么久最多再说一句。 */
const NARRATION_INTERVAL_MS = Number(process.env.DSH_MOBILE_NARRATION_INTERVAL_MS) || 90 * 1000;
/** 一轮最多说几句：再多就是把工具循环变成播报台。 */
const NARRATION_MAX_PER_TURN = 3;
/**
 * 来源标记。**必须不是 `user`**：App 的 `userMessageOrigin` 与 `history-derive` 都按
 * `source.kind !== 'user'` 把注入丢掉，改这两处的口径就等于让提醒变成用户气泡。
 */
const NARRATION_SOURCE_KIND = 'mobile-narration';
/** 记「这一轮跑多久了」的表：会话数有限，封顶防慢泄漏。 */
const TRACKED_SESSIONS = 64;

function settingsFile() {
  return path.join(dshHome(), 'storages', 'mobile-plugin', 'process-narration.json');
}

/**
 * 读开关。读不到 / 读坏都当「关」—— 会往用户对话里塞消息、花 token 的事，缺省必须在关的
 * 那一侧（与收件目录自动清理同一个口径，与自动更新的缺省相反）。
 */
function narrationEnabled() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return raw?.enabled === true;
  } catch {
    return false;
  }
}

/** 写开关。写不进去就抛，让调用方如实回失败（回「开好了」却没落盘是最坏的一种）。 */
function setNarration(enabled) {
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ enabled: enabled === true }, null, 2)}\n`);
  return narrationEnabled();
}

/** 造消息的工厂：宿主给的 `createUserMessage` 会品牌化 id 并 deepFreeze，取不到时退回等价对象。 */
let createUserMessagePromise = null;
function resolveCreateUserMessage() {
  if (!createUserMessagePromise) {
    createUserMessagePromise = import('@deepseek-ai/dsh-llm')
      .then((llm) => llm?.createUserMessage ?? null)
      .catch(() => null);
  }
  return createUserMessagePromise;
}

/**
 * 那一句提醒的正文。
 *
 * 写法的三条规矩（与开发地图那套补报同一口径）：
 *  1. **说清这不是用户说的话**：它长得像系统提示，不说明白模型会当成用户在催它；
 *  2. **给动作，不给问题**：模型没有「我该不该汇报」这个自我认知，直接说「用一两句话说」；
 *  3. **允许它说「没什么可说的」**：没有卡点还要硬编一句，读起来比不说更糟。
 */
function narrationText() {
  return [
    '<system-reminder>',
    '这是一条进度提醒，**不是用户说的话**。',
    '请在这一轮继续之前，先用一两句自然的话（就是正常对用户说话的口气，不要写成报告或条目）说清：现在做到哪一步、有没有卡住或绕路。',
    '没有什么值得说的就继续干活，不用勉强编一句。',
    '说的时候不要提这条提醒本身。',
    '</system-reminder>',
  ].join('\n');
}

async function buildHint() {
  const input = {
    content: [{ type: 'text', text: narrationText() }],
    source: { kind: NARRATION_SOURCE_KIND },
  };
  const create = await resolveCreateUserMessage();
  if (create) return create(input);
  return Object.freeze({ ...input, role: 'user', id: randomUUID() });
}

/** sessionId → { turn, startedAt, lastAt, count }。 */
const sessions = new Map();

function trackOf(sessionId, turn, now) {
  const current = sessions.get(sessionId);
  if (current && current.turn === turn) return current;
  // 换轮就重开一份：门槛按轮算，不跟上一条消息的水位混在一起。
  const fresh = { turn, startedAt: now, lastAt: 0, count: 0 };
  sessions.delete(sessionId);
  sessions.set(sessionId, fresh);
  while (sessions.size > TRACKED_SESSIONS) sessions.delete(sessions.keys().next().value);
  return fresh;
}

/**
 * 这一步该不该递话。
 *
 * 纯判断，输入是「这一轮跑了多久、已经说过几句、上次说是什么时候」，方便守卫直接真跑。
 */
function narrationDecision({ elapsedMs, said, sinceLastMs }) {
  if (elapsedMs < NARRATION_FIRST_MS) return false;
  if (said >= NARRATION_MAX_PER_TURN) return false;
  if (said > 0 && sinceLastMs < NARRATION_INTERVAL_MS) return false;
  return true;
}

/**
 * `agent/pre-step` 的监听：跑得够久就追加一句提醒。
 *
 * 任何失败都吞掉 —— 播报是锦上添花，读盘失败或消息造不出来不该让用户这一轮发不出去。
 * 子代理会话直接跳过：它的上下文更紧，而且那不是用户在等的那个对话。
 */
async function onPreStep(payload, next) {
  const decision = await next();
  try {
    // 拒收的那一档没有 messages 可追加（`decision.kind === 'reject'`），原样放行。
    if (!decision || !Array.isArray(decision.messages)) return decision;
    if (!narrationEnabled()) return decision;
    const header = payload?.agent?.session?.header;
    if (!header?.id || header.origin === 'subagent') return decision;
    const now = Date.now();
    const track = trackOf(header.id, payload.turn, now);
    const wanted = narrationDecision({
      elapsedMs: now - track.startedAt,
      said: track.count,
      sinceLastMs: track.lastAt ? now - track.lastAt : Number.POSITIVE_INFINITY,
    });
    if (!wanted) return decision;
    const hint = await buildHint();
    track.count += 1;
    track.lastAt = now;
    return { ...decision, messages: [...decision.messages, hint] };
  } catch {
    return decision;
  }
}

/** 挂上钩子。返回清理函数（`ctx.effect` 要的那个）。 */
function installNarration(ctx) {
  return ctx.on('agent/pre-step', onPreStep);
}

/**
 * GET  /api/mobile/v1/narration —— 当前开关（手机打开菜单时读一次）。
 * POST /api/mobile/v1/narration —— `{ enabled: boolean }` 拨开关。
 *
 * 两条收在同一路径上由 `req.method` 分派（宿主的注册器不按方法分派，与 `/relay/config` 同一条路）。
 */
async function handleNarration(_ctx, req, res) {
  if (req && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body || typeof body.enabled !== 'boolean') {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'enabled 必须是布尔值' } });
      return;
    }
    try {
      sendJson(res, 200, { ok: true, enabled: setNarration(body.enabled) });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: { code: 'write-failed', message: `开关没写进去：${error && error.message ? error.message : error}` },
      });
    }
    return;
  }
  sendJson(res, 200, { ok: true, enabled: narrationEnabled() });
}

module.exports = {
  installNarration,
  narrationEnabled,
  setNarration,
  narrationDecision,
  narrationText,
  handleNarration,
  settingsFile,
  NARRATION_FIRST_MS,
  NARRATION_INTERVAL_MS,
  NARRATION_MAX_PER_TURN,
  NARRATION_SOURCE_KIND,
};

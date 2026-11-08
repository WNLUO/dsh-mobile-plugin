'use strict';

/**
 * 每次总管开口前，把它手上那本任务账递进这一轮的上下文。
 *
 * 场景：用户在电话里说「在吗」「怎么样了」，总管得先知道自己手上挂着什么，才可能先报活；
 * 而这条会话每开一轮都是新的上下文，账本在盘上、模型看不到。所以插件在它动手之前往这一步
 * 的 messages 里追加一段 —— 走宿主 `agent/pre-step` 的 waterfall，与过程播报、开发地图的
 * 补报是同一条通道（见 dev-map A3-81）。
 *
 * ## 三条边界
 *
 *  · **只对总管那条会话**（`session.header.agentPreset === 'supervisor'`）：普通对话不该
 *    每轮都被塞一段别人的任务账；
 *  · **来源不是 `user`**：App 的直播与历史推导按 `source.kind !== 'user'` 把注入丢掉，改口径
 *    就等于让这段账冒充成用户自己说的话；
 *  · **没活就不注入**：闲聊时一句「你手上有什么」都没有，模型自然陪聊，也就没有翻旧账的
 *    由头。这正是「没活别翻旧账」这条口径的落点。
 *
 * 失败一律吞：账本是旁路，读不到、消息造不出来都不该让用户这一轮发不出去。
 * 一轮只注入一次（换轮重开）：每步都塞一遍等于把上下文喂成一锅账本。
 */

const { randomUUID } = require('node:crypto');

const { judgeWork, sessionLine } = require('./judgment.js');
const { callMemory } = require('../supervisor-memory/index.js');

/** 总管那档 Agent 预设的 id（`config/agent-presets/supervisor/`，App 建会话时按这个名字指定）。 */
const SUPERVISOR_PRESET_ID = 'supervisor';

/** 注入用的来源标记。**必须不是 `user`**，理由见文件头。 */
const SUPERVISOR_SOURCE_KIND = 'mobile-supervisor-ledger';

/** 递给模型的那段账最多多长（字符）：账本自己有行数上限，这里只是防呆。 */
const NOTICE_MAX_CHARS = 4000;

/**
 * 这一段递话的来源标记。导出是给守卫用的：改它就得同时改 App 那两个口径。
 */
function noticeSourceKind() {
  return SUPERVISOR_SOURCE_KIND;
}

/**
 * 这条会话是不是总管那条。
 *
 * 认两样：不是子代理（`origin`），且创建时指定的预设是总管。预设读了 `header.agentPreset`
 * 这一格 —— 它是创建事实、不会中途改；中途换档的会记 `agent-preset/selected` 事件，但
 * 「这条会话由总管开出来」这件事没变，所以不追事件。
 *
 * @returns {string} 是总管就回会话 id，否则空串
 */
function supervisorSessionOf(agent) {
  const header = agent && agent.session && agent.session.header;
  if (!header || typeof header !== 'object') return '';
  if (typeof header.id !== 'string' || !header.id) return '';
  if (header.origin === 'subagent') return '';
  return header.agentPreset === SUPERVISOR_PRESET_ID ? header.id : '';
}

/** 一段消息正文里的纯文本（内容块数组与裸字符串两种形状都收）。 */
function textOfMessage(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * 这一步之前那条真用户消息的正文（`callMemory` 拿它去知识库里找回忆）。
 *
 * 只认 `source.kind === 'user'`：插件自己注入的那些提醒也长得像 user 消息，拿它们当线索
 * 会越搜越偏。
 */
function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'user') continue;
    const kind = message.source && message.source.kind;
    if (kind && kind !== 'user') continue;
    const text = textOfMessage(message).trim();
    if (text) return text.slice(0, 200);
  }
  return '';
}

/**
 * 这一轮该注入的那段正文。空串表示「什么都没有，什么都不说」。
 *
 * 写法的三条规矩（与过程播报同一口径）：
 *  1. 说清这不是用户说的话；
 *  2. 有活就先报活、给动作而不是给问题；
 *  3. 没活时明确说「陪聊、别翻旧账」，而不是留下一段账让模型自己发挥。
 */
function supervisorNoticeText({ verdict, memory }) {
  if (!verdict || verdict.busy !== true) return '';
  const lines = [];
  const head = verdict.waiting > 0
    ? `你手上挂着 ${verdict.tasks.length} 件事，其中 ${verdict.waiting} 件在等人答`
    : `你手上挂着 ${verdict.tasks.length} 件事`;
  const running = verdict.sessions.filter((row) => row.running === true).length;
  const waitingSessions = verdict.sessions.length - running;
  const sessionBits = [];
  if (running > 0) sessionBits.push(`${running} 条对话正在跑`);
  if (waitingSessions > 0) sessionBits.push(`${waitingSessions} 条在等人答`);
  lines.push('<system-reminder>');
  lines.push('这是一段任务账，**不是用户说的话**。');
  lines.push('你这一通电话接起来之前，手上还挂着这些：');
  lines.push(head + (sessionBits.length > 0 ? `；另外还有${sessionBits.join('、')}` : '') + '。');
  const detail = typeof memory === 'string' ? memory.trim() : '';
  if (detail) lines.push(detail);
  for (const row of verdict.sessions) lines.push(sessionLine(row));
  lines.push('先用自己的话简短交代一下手上有什么、哪件最要紧，再接着聊用户这次说的；不要提这段账本身。');
  lines.push('</system-reminder>');
  const text = lines.join('\n');
  return text.length > NOTICE_MAX_CHARS ? `${text.slice(0, NOTICE_MAX_CHARS)}\n</system-reminder>` : text;
}

/** 造消息的工厂：与过程播报同一套取法，取不到就退回等价对象。 */
let createUserMessagePromise = null;
function resolveCreateUserMessage() {
  if (!createUserMessagePromise) {
    createUserMessagePromise = import('@deepseek-ai/dsh-llm')
      .then((llm) => llm?.createUserMessage ?? null)
      .catch(() => null);
  }
  return createUserMessagePromise;
}

async function buildNotice(text) {
  const input = {
    content: [{ type: 'text', text }],
    source: { kind: SUPERVISOR_SOURCE_KIND },
  };
  const create = await resolveCreateUserMessage();
  if (create) return create(input);
  return Object.freeze({ ...input, role: 'user', id: randomUUID() });
}

/** sessionId → 已经注入过的那一轮号。换轮才再注入一次。 */
const injectedTurns = new Map();
const TRACKED_SESSIONS = 32;

/** 这一轮是不是已经注入过了（顺手做容量封顶，会话数有限但仍防慢泄漏）。 */
function alreadyInjected(sessionId, turn) {
  if (injectedTurns.get(sessionId) === turn) return true;
  injectedTurns.delete(sessionId);
  injectedTurns.set(sessionId, turn);
  while (injectedTurns.size > TRACKED_SESSIONS) injectedTurns.delete(injectedTurns.keys().next().value);
  return false;
}

/**
 * 造这一段要追加的消息。守卫可以单独调它（不碰宿主）。
 *
 * @param {{ctx: object, agent: object, messages?: Array, deps?: object}} input
 * @returns {Promise<object|null>} 没有可说的就回 null
 */
async function buildSupervisorMessage(input) {
  const { ctx, agent, messages, deps } = input || {};
  if (!supervisorSessionOf(agent)) return null;
  const verdict = await judgeWork(ctx, deps);
  if (verdict.busy !== true) return null;
  let memory = '';
  try {
    memory = callMemory({ query: lastUserText(messages) });
  } catch {
    memory = '';
  }
  const text = supervisorNoticeText({ verdict, memory });
  if (!text) return null;
  return buildNotice(text);
}

/**
 * 造 `agent/pre-step` 的监听：总管每一轮的第一步把账递进去。
 *
 * 判据是 `Array.isArray(decision.messages)`，不能只看 `kind === 'enter'` —— 拒收那一档
 * （`decision.kind === 'reject'`）没有 `messages`，写成后者会在拒收路径上把用户这一轮删掉。
 *
 * `ctx` 由装配时闭包带进来（宿主递给钩子的 payload 里没有 ctx），`deps` 只在守卫里给。
 */
function createPreStepHook(ctx, deps) {
  return async function onSupervisorPreStep(payload, next) {
    const decision = await next();
    try {
      if (!decision || !Array.isArray(decision.messages)) return decision;
      const agent = payload && payload.agent;
      const sessionId = supervisorSessionOf(agent);
      if (!sessionId) return decision;
      const turn = payload && payload.turn !== undefined ? payload.turn : null;
      if (alreadyInjected(sessionId, turn)) return decision;
      const hint = await buildSupervisorMessage({ ctx, agent, messages: decision.messages, deps });
      if (!hint) return decision;
      return { ...decision, messages: [...decision.messages, hint] };
    } catch {
      return decision;
    }
  };
}

module.exports = {
  supervisorSessionOf,
  supervisorNoticeText,
  buildSupervisorMessage,
  createPreStepHook,
  lastUserText,
  noticeSourceKind,
  SUPERVISOR_PRESET_ID,
  SUPERVISOR_SOURCE_KIND,
  NOTICE_MAX_CHARS,
};

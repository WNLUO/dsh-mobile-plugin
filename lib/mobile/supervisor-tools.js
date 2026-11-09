'use strict';

/**
 * 总管那一组工具：它自己不干活，干活的是各项目里的对话。
 *
 * 这里给模型两条线：
 *   - 读：列所有会话（谁在跑 / 谁完成 / 谁报错 / 谁在等人答）、看某条会话现在到哪一步、
 *     读某条会话的正文；
 *   - 写：往某条会话发一句话、按 Agent 预设新开一条会话、中断某条会话。
 *
 * ## 能力面的边界
 *
 * 参数全是结构化字段，没有任何一格能拼出一段 shell。**目标会话**由 `sessionId` 指定 ——
 * 那正是「总管管的是别的对话」这件事本身；模型不能指定的是**身份**与**设备**：谁是发起人
 * 一律从 `exec.agent.id` 取（就是总管这条会话自己的 id），不接受参数覆盖；也没有任何
 * `deviceId` 之类的口子让它去动别的机器。会话 id 拿不到就整条不执行，绝不默默用空串。
 *
 * ## 为什么注册必须走 `ctx.inject(['tools'], …)`
 *
 * 宿主里 `tools` 是子代理作用域提供的服务，插件这一层直接读 `ctx.tools` 拿到的是
 * undefined，`register` 一抛就被容错吞掉 —— 现象是这组工具**一条都没进过模型的工具清单**。
 * 同树的 `phone/tools.js` 也是这个写法（见 dev-map A3-79 的坑）。
 *
 * ## 复用现成的读法，而不是自己挨个盯
 *
 * 「谁在跑、谁完成、谁报错、谁在等人答」直接吃 `/monitor` 那套投影（`buildMonitorState`）
 * 与 `lastTurn` 的上一轮事实；正文走消息快照（`buildMessagesSnapshot`）。这两条都是宿主
 * 已经维护好的账，重造一份只会与它们走偏。
 *
 * ## 结果里不许留 undefined
 *
 * 宿主会把带 `undefined` 字段的整条结果判成非法 JSON（见 A3-79）。所以每个工具的返回值
 * 最后都过一遍 `clean()`（JSON 往返），`undefined` 的键当场消失，宁可不出字段也不占位。
 */

const path = require('node:path');

const { buildMonitorState } = require('./monitor.js');
const { buildMessagesSnapshot } = require('./session-snapshot.js');
const { callSessions } = require('./rpc.js');
const { unwrap } = require('./envelope.js');
const { promptErrorObject } = require('./history-derive.js');
const { invalidateSessionList } = require('./session-cache.js');
const { workspaceRoots, isWithin } = require('./allowed-zone.js');

/**
 * 总管这份监控视图用的设备键。
 *
 * `/monitor` 的完成态是按设备算的（`clearedAt` 挡掉「这台已经读过的」）。总管不是某台
 * 手机，它要的是「这条会话到底跑成没有」这个客观事实，所以给它一个专用的设备键 —— 这个
 * 键从没读过任何会话，`completed` 就永远按事实走，也不会去污染真手机那份提醒账。
 */
const SUPERVISOR_DEVICE_KEY = 'supervisor-tools';

/** 一条消息的最大长度（字符）。给个上限只是防呆，正常对话远用不到。 */
const MAX_TEXT = 100000;
/** 会话 / 工作区 / 预设这类标识的长度上限。 */
const MAX_ID = 200;

/** 把值里值为 `undefined` 的键清掉：宿主只认干净的 JSON。 */
function clean(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 从执行上下文里认出发起人（总管自己这条会话）。**只看 `exec.agent.id`**。 */
function sessionOf(exec) {
  const id = exec && exec.agent && exec.agent.id;
  return typeof id === 'string' ? id : '';
}

/** 必填 id：去空白、非空、不超长。 */
function requiredId(value, label) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw new Error(`${label} 不能为空。`);
  if (s.length > MAX_ID) throw new Error(`${label} 太长。`);
  return s;
}

/** 可选 id：没有就是空串；有就按必填的规矩校验。 */
function optionalId(value, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串。`);
  const s = value.trim();
  if (!s) return '';
  if (s.length > MAX_ID) throw new Error(`${label} 太长。`);
  return s;
}

/** 消息正文：去首尾空白、非空、不超长。 */
function cleanText(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw new Error('消息内容不能为空。');
  if (s.length > MAX_TEXT) throw new Error('消息太长了。');
  return s;
}

/** 把一条 `/monitor` 条目翻成一句人话里的状态。 */
function deriveState(row) {
  if (row.running) return 'running';
  if (row.pendingInteraction) return 'waiting';
  if (row.lastTurnError) return 'error';
  if (row.completed) return 'completed';
  if (row.lastTurn && row.lastTurn.status === 'failed') return 'error';
  if (row.lastTurn && row.lastTurn.status === 'completed') return 'completed';
  return 'idle';
}

/** 把 `/monitor` 条目 + 清单摘要里的项目信息拼成一行给模型看的账。 */
function buildRow(item, meta) {
  const row = {
    sessionId: item.sessionId,
    title: item.title,
    running: item.running === true,
    completed: item.completed === true,
  };
  if (item.pendingInteraction) row.pendingInteraction = item.pendingInteraction;
  if (item.lastTurnError) {
    row.lastTurnError = {
      code: item.lastTurnError.code ?? null,
      message: item.lastTurnError.message ?? null,
    };
  }
  if (item.lastTurn) row.lastTurn = item.lastTurn;
  if (item.lastMessage && typeof item.lastMessage.text === 'string') {
    row.lastMessage = { role: item.lastMessage.role, text: item.lastMessage.text };
  }
  // 项目目录与 Agent 预设来自会话清单摘要（`/monitor` 那条只投影状态位，不带这两格）：
  // 总管要回答「这条属于哪个项目」、也要知道新开一条会话该落在哪儿。
  if (meta) {
    if (typeof meta.cwd === 'string' && meta.cwd) row.cwd = meta.cwd;
    if (typeof meta.agentPreset === 'string' && meta.agentPreset) row.agentPreset = meta.agentPreset;
  }
  row.state = deriveState(row);
  return row;
}

/** 取原始会话清单（不折预览），只用来补项目信息与校验目标存在。 */
async function rawSessions(ctx) {
  const { value } = unwrap(await callSessions(ctx, 'list', {}, 'mobile'));
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.items)) return value.items;
  return [];
}

/**
 * 整份家底：状态位吃 `/monitor` 的投影，项目信息吃原始清单。
 *
 * 两次 list 并发发出去：`rpc.js` 会把同一时刻在飞的那次 list 合流掉，所以宿主那边实际
 * 只扫一遍日志，不是两遍。
 */
async function readOverview(ctx) {
  const [built, rawEnvelope] = await Promise.all([
    buildMonitorState(ctx, SUPERVISOR_DEVICE_KEY),
    callSessions(ctx, 'list', {}, 'mobile'),
  ]);
  if (built && built.error) {
    const message = (built.error && built.error.message) || (built.error && built.error.code) || '宿主报错';
    throw new Error(`读会话清单失败：${message}`);
  }
  if (built && built.degraded) throw new Error('宿主会话列表形状异常，这一拍没读到。');
  const items = Array.isArray(built && built.items) ? built.items : [];

  const metaById = new Map();
  const { value } = unwrap(rawEnvelope);
  const summaries = Array.isArray(value) ? value : (value && Array.isArray(value.items) ? value.items : []);
  for (const s of summaries) {
    if (s && typeof s.sessionId === 'string') metaById.set(s.sessionId, s);
  }

  const rows = items.map((item) => buildRow(item, metaById.get(item.sessionId))).filter((row) => row.sessionId);
  return { rows, metaById };
}

/** 校验目标会话存在且是一条普通会话（子代理不归总管直接使唤）。 */
async function requireSession(ctx, id) {
  const rows = await rawSessions(ctx);
  const found = rows.find((s) => s && s.sessionId === id) || null;
  if (!found) throw new Error(`找不到会话 ${id}，先用 supervisor_list_sessions 看有哪些。`);
  if (found.origin === 'subagent') throw new Error(`会话 ${id} 是一条子代理，总管不直接操作它。`);
  return found;
}

/** 每行怎么念给模型听。 */
function rowLine(row) {
  const bits = [`${row.sessionId}`, `《${row.title || '未命名'}》`];
  const label = {
    running: '正在跑', completed: '上一轮已完成', error: '上一轮报错',
    waiting: '在等人答', idle: '空闲',
  }[row.state] || row.state;
  bits.push(label);
  if (row.cwd) bits.push(`项目 ${row.cwd}`);
  if (row.lastTurnError && row.lastTurnError.message) bits.push(`错误：${row.lastTurnError.message}`);
  if (row.pendingInteraction) bits.push(`待处理：${row.pendingInteraction}`);
  if (row.lastMessage && row.lastMessage.text) bits.push(`最后一句：${row.lastMessage.text.slice(0, 80)}`);
  return `· ${bits.join('，')}`;
}

const OUTPUT_FREE = { type: 'object', additionalProperties: true };

/**
 * 挂载总管工具组。缺 `tools` 注入的 profile（纯手机端宿主 / 没装这一层插件）静默跳过，
 * 别把整块装配掀掉；注册本身抛错照旧往上抛 —— 那是真的坏了，不该当成「没有这个 profile」。
 */
function mountSupervisorTools(ctx) {
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['tools'], (scoped) => {
    if (!scoped || !scoped.tools || typeof scoped.tools.register !== 'function') return;
    let defineTool;
    try {
      ({ defineTool } = require('@deepseek-ai/dsh-tools'));
    } catch {
      return;
    }

    // ── 读：列所有会话 ────────────────────────────────────────────────────
    scoped.tools.register(defineTool({
      name: 'supervisor_list_sessions',
      description: 'List every conversation on this computer with its current state: whether it is running, finished its last turn, ended in an error, or is waiting for the user to answer something. Use this first to see what is going on and to get the sessionId of the conversation you want to inspect or act on.',
      parameters: {},
      output: {
        schema: OUTPUT_FREE,
        render: (_args, value) => {
          const rows = Array.isArray(value && value.sessions) ? value.sessions : [];
          if (rows.length === 0) return [{ type: 'text', text: '这台电脑上现在没有会话。' }];
          return [{ type: 'text', text: `${rows.length} 条会话：\n${rows.map(rowLine).join('\n')}` }];
        },
      },
      execute: async () => {
        const { rows } = await readOverview(ctx);
        return clean({ sessions: rows });
      },
    }));

    // ── 读：某条会话跑到哪一步 ────────────────────────────────────────────
    scoped.tools.register(defineTool({
      name: 'supervisor_session_status',
      description: 'Read where one conversation is right now: running / finished / errored / waiting for an answer, plus the fact of its last turn (when it ended and how). Give the sessionId from supervisor_list_sessions.',
      parameters: {
        sessionId: { type: 'string', description: 'The conversation to inspect.' },
      },
      output: {
        schema: OUTPUT_FREE,
        render: (_args, value) => [{ type: 'text', text: rowLine(value || {}) }],
      },
      execute: async (args) => {
        const id = requiredId(args.sessionId, 'sessionId');
        const { rows, metaById } = await readOverview(ctx);
        const found = rows.find((row) => row.sessionId === id);
        if (found) return clean(found);
        if (metaById.has(id)) throw new Error(`会话 ${id} 现在不在可监控清单里（可能已归档）。`);
        throw new Error(`找不到会话 ${id}，先用 supervisor_list_sessions 看有哪些。`);
      },
    }));

    // ── 读：某条会话的正文 ────────────────────────────────────────────────
    scoped.tools.register(defineTool({
      name: 'supervisor_read_session',
      description: 'Read the actual messages of one conversation (who said what), newest window first. Use it when you need the content, not just the status.',
      parameters: {
        sessionId: { type: 'string', description: 'The conversation to read.' },
        limit: { type: 'integer', description: 'How many recent messages to read. Default 30, max 200.' },
      },
      output: {
        schema: OUTPUT_FREE,
        render: (_args, value) => {
          const messages = Array.isArray(value && value.messages) ? value.messages : [];
          if (messages.length === 0) return [{ type: 'text', text: '这条会话还没有正文。' }];
          const text = messages.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.text}`).join('\n');
          return [{ type: 'text', text }];
        },
      },
      execute: async (args) => {
        const id = requiredId(args.sessionId, 'sessionId');
        const rawLimit = Number(args.limit);
        const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 30;
        let snapshot;
        try {
          snapshot = await buildMessagesSnapshot(ctx, id, limit);
        } catch (error) {
          const message = (error && error.message) || '读取会话内容失败';
          throw new Error(message);
        }
        if (!snapshot || snapshot.ok === false) {
          const error = snapshot && snapshot.error;
          throw new Error((error && error.message) || '读取会话内容失败');
        }
        const messages = (snapshot.items || [])
          .filter((m) => m && typeof m === 'object' && typeof m.role === 'string')
          .map((m) => ({ role: m.role, text: typeof m.text === 'string' ? m.text : '' }));
        return clean({ sessionId: id, messages });
      },
    }));

    // ── 写：往某条会话发消息 ──────────────────────────────────────────────
    scoped.tools.register(defineTool({
      name: 'supervisor_send_message',
      description: 'Send a message into another conversation, as if the user typed it there. The target keeps running with its own agent and preset. Give the sessionId from supervisor_list_sessions and the text to send.',
      parameters: {
        sessionId: { type: 'string', description: 'The conversation to send into.' },
        text: { type: 'string', description: 'The message text to send.' },
      },
      output: {
        schema: OUTPUT_FREE,
        render: (_args, value) => [{ type: 'text', text: `已发给 ${value && value.sessionId}：${(value && value.text) || ''}` }],
      },
      execute: async (args, exec) => {
        // 发起人只认 exec.agent.id，参数里没有、也不许有「谁发的」这一格。
        const callerId = sessionOf(exec);
        if (!callerId) throw new Error('拿不到当前会话 id（exec.agent.id），这条消息不发送。');
        const target = requiredId(args.sessionId, 'sessionId');
        const text = cleanText(args.text);
        if (target === callerId) throw new Error('不能给总管自己发消息。');
        await requireSession(ctx, target);
        let response;
        try {
          response = await callSessions(ctx, 'prompt', { sessionId: target, content: [{ type: 'text', text }] }, 'supervisor');
        } catch (error) {
          const normalized = promptErrorObject(error);
          throw new Error(normalized.message || '发送失败');
        }
        const { error } = unwrap(response);
        if (error) {
          const normalized = promptErrorObject(error);
          throw new Error(normalized.message || '发送失败');
        }
        return clean({ sessionId: target, text, sent: true });
      },
    }));

    // ── 写：新建会话（可带 agentPreset） ──────────────────────────────────
    scoped.tools.register(defineTool({
      name: 'supervisor_create_session',
      description: 'Create a new blank conversation. Give either workspaceId (a project on this computer) or cwd (an absolute path inside a registered workspace) to place it, and optionally an agentPreset id to start it with a specific preset. Returns the new sessionId, which you can then send a message into.',
      parameters: {
        workspaceId: { type: 'string', description: 'The project (workspace) to create the conversation in. Give this or cwd, not both.' },
        cwd: { type: 'string', description: 'An absolute directory inside a registered workspace. Give this or workspaceId, not both.' },
        agentPreset: { type: 'string', description: 'Optional Agent preset id to start the conversation with.' },
      },
      output: {
        schema: OUTPUT_FREE,
        render: (_args, value) => [{ type: 'text', text: `已新建会话 ${value && value.sessionId}` }],
      },
      execute: async (args, exec) => {
        const callerId = sessionOf(exec);
        if (!callerId) throw new Error('拿不到当前会话 id（exec.agent.id），不能新建会话。');
        const workspaceId = optionalId(args.workspaceId, 'workspaceId');
        const cwdRaw = typeof args.cwd === 'string' ? args.cwd.trim() : '';
        const agentPreset = optionalId(args.agentPreset, 'agentPreset');
        if (workspaceId && cwdRaw) throw new Error('workspaceId 和 cwd 只能给一个。');

        const payload = {};
        if (workspaceId) payload.workspaceId = workspaceId;
        if (agentPreset) payload.agentPreset = agentPreset;
        if (cwdRaw) {
          if (!path.isAbsolute(cwdRaw)) throw new Error('cwd 必须是绝对路径。');
          const cwd = path.resolve(cwdRaw);
          let roots;
          try {
            roots = await workspaceRoots(ctx);
          } catch (error) {
            throw new Error((error && error.message) || '读工作区清单失败');
          }
          if (!roots.some((root) => isWithin(root, cwd))) {
            throw new Error('这个目录不在能建会话的范围里（只能落在已登记的工作区）。');
          }
          payload.cwd = cwd;
        }

        let response;
        try {
          response = await callSessions(ctx, 'create', payload);
        } catch (error) {
          throw new Error((error && error.message) || '新建会话失败');
        }
        const { value, error } = unwrap(response);
        if (error) throw new Error(error.message || '新建会话失败');
        const sessionId = value && typeof value.sessionId === 'string' ? value.sessionId : '';
        if (!sessionId) throw new Error('宿主新建会话没返回 sessionId。');
        // 新会话要立刻出现在列表里，否则手机上最长 10 秒看不到它（与 handleNew 同口径）。
        try { invalidateSessionList(ctx); } catch { /* 缓存层不在也不挡这一发 */ }
        const out = { sessionId };
        if (payload.cwd) out.cwd = payload.cwd;
        if (workspaceId) out.workspaceId = workspaceId;
        if (value && typeof value.agentPreset === 'string' && value.agentPreset) out.agentPreset = value.agentPreset;
        return clean(out);
      },
    }));

    // ── 写：中断某条会话 ──────────────────────────────────────────────────
    scoped.tools.register(defineTool({
      name: 'supervisor_interrupt_session',
      description: 'Stop what a conversation is currently doing. Give the sessionId of the running conversation.',
      parameters: {
        sessionId: { type: 'string', description: 'The running conversation to interrupt.' },
      },
      output: {
        schema: OUTPUT_FREE,
        render: (_args, value) => [{ type: 'text', text: `已中断 ${value && value.sessionId}` }],
      },
      execute: async (args, exec) => {
        const callerId = sessionOf(exec);
        if (!callerId) throw new Error('拿不到当前会话 id（exec.agent.id），不能中断。');
        const target = requiredId(args.sessionId, 'sessionId');
        await requireSession(ctx, target);
        let response;
        try {
          response = await callSessions(ctx, 'cancel', { sessionId: target });
        } catch (error) {
          throw new Error((error && error.message) || '中断失败');
        }
        const { error } = unwrap(response);
        if (error) throw new Error(error.message || '中断失败');
        return clean({ sessionId: target, interrupted: true });
      },
    }));
  });
}

module.exports = { mountSupervisorTools };

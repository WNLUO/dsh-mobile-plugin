'use strict';

/**
 * 给模型用的「这台电脑上有什么」，以及 App 能做的那些整理动作。
 *
 * 这些能力此前只挂在移动 API 上，只有手机 App 能用；模型想看一眼自己的工作区与对话，
 * 只能绕开（读日志、猜目录）。这里把它们包成一个工具，走的是与路由**同一份**底层调用：
 * 工作区清单 `buildWorkspacesBody`、会话清单 `buildSessionsResponse`、正文
 * `buildMessagesSnapshot`、发送 `promptOnce`、停止 `cancel`、新建 / 分叉 / 改名
 * `session.*`、归档与置顶 `workspace.*`。插件里本来就有自己调宿主的那套
 * （`session_cleanup` 就是），这是同一个形状。
 *
 * ## 能力面
 *
 * **与手机 App 一致**：App 界面上做得到的，这里都开放 —— 列、读、发、停、新建、改名、
 * 分叉、归档 / 取消归档、置顶 / 取消置顶、换工作区，外加工作区的添加 / 改名 / 删除。
 * 依据是用户 2026-11-13 那句「APP 能实现的能力，插件这边也应该开放」：两边本来就跑在
 * 同一台机器、同一个宿主上，插件这边另设一道门槛只是让模型多绕一步，不是多一层安全。
 *
 * 不开放的仍是**进程级**那几样，它们不是「App 能做而这里不给」：shell、系统设置、
 * 任意文件读写（那几样的界面入口在桌面端，不在 App）。
 *
 * 发送走 `promptOnce`（与手机输入框同一条），**不**替调用方决定排队还是插话 ——
 * `mode` 原样透传给宿主，省略就按宿主的默认。
 *
 * ## 范围
 *
 * 列出来的是**这台电脑上的全部**工作区与会话，不是「当前这条会话所在的项目」。这正是
 * 这个工具的意义（问一句「你能看到哪些对话」就能真去列），所以不做按会话过滤。
 */

const path = require('node:path');

const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');
const { buildWorkspacesBody } = require('./workspaces.js');
const { buildSessionsResponse } = require('./sessions.js');
const { buildMessagesSnapshot } = require('./session-snapshot.js');
const { promptOnce } = require('./session-send.js');
const { invalidateSessionList } = require('./session-cache.js');
const { workspaceRoots, isWithin } = require('./allowed-zone.js');

/** 一次最多回多少条，避免把整个列表塞进模型上下文。 */
const LIST_LIMIT = 200;
/** 读会话时最多回多少条消息（宿主历史接口的窗口）。 */
const READ_LIMIT = 50;
/** 一条消息正文截到多少字符：长会话整段塞回去只会挤掉别的上下文。 */
const MESSAGE_TEXT_LIMIT = 4000;

/** 工作区行：只留「是什么、在哪、叫什么」三样。 */
function workspaceRow(item) {
  if (!item || typeof item !== 'object') return null;
  const path = typeof item.path === 'string' ? item.path : '';
  if (!path) return null;
  return {
    workspaceId: typeof item.workspaceId === 'string' ? item.workspaceId : '',
    title: typeof item.title === 'string' ? item.title : '',
    path,
  };
}

/** 会话行：ID、标题、工作区、是否在跑、最后活动时间。 */
function sessionRow(item) {
  if (!item || typeof item.sessionId !== 'string') return null;
  return {
    sessionId: item.sessionId,
    title: typeof item.title === 'string' ? item.title : '',
    cwd: typeof item.cwd === 'string' ? item.cwd : '',
    running: item.running === true,
    updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
    ...(item.pinned ? { pinned: true } : {}),
    ...(item.origin ? { origin: item.origin } : {}),
  };
}

/**
 * 一条消息压成「谁说了什么」；正文过长就截断，标明截了。
 *
 * `deriveMessages` 的结果里混着压缩行、重试行、轮次错误这些**结构化行**（带 `kind`、没有
 * 正文），它们是给界面画卡片用的，对模型没有意义 —— 没有正文的一律丢掉，别在结果里留一堆
 * 空行让模型以为那里说过什么。
 */
function messageRow(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.kind === 'string') return null;
  const text = typeof item.text === 'string' ? item.text : '';
  if (!text.trim()) return null;
  const truncated = text.length > MESSAGE_TEXT_LIMIT;
  return {
    role: typeof item.role === 'string' ? item.role : '',
    text: truncated ? text.slice(0, MESSAGE_TEXT_LIMIT) : text,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * 列工作区。`buildWorkspacesBody` 失败时把宿主的错误原样抛出去 —— 静默回空清单会让
 * 模型以为这台电脑一个项目都没有。
 */
async function listWorkspaces(ctx) {
  const body = await buildWorkspacesBody(ctx, {});
  if (!body || body.ok !== true) {
    const failure = (body && body.error) || {};
    throw new Error(failure.message || '读工作区清单失败');
  }
  const items = Array.isArray(body.items) ? body.items.map(workspaceRow).filter(Boolean) : [];
  return { workspaces: items.slice(0, LIST_LIMIT), total: items.length };
}

/**
 * 列会话。可选按工作区路径筛。
 *
 * 走 `buildSessionsResponse`：归档会话照手机端同一口径剔除，`running` 已经是「子代理也
 * 在跑」顶过的值 —— 别在这里另写一套判据。
 *
 * **子代理会话不列**：它们是某条对话派出去的活，不是一个能打开、能往里说话的对话；手机
 * 侧栏同样直接跳过它们（`app/src/drawerGroups.ts` 的 `origin === 'subagent'`）。列出来
 * 只会给模型一个点开就失败的入口 —— 读子代理要另带父会话地址，发消息要走 subagent 投递，
 * 那是另一条路，这一版不做。
 */
async function listSessions(ctx, options = {}) {
  const built = await buildSessionsResponse(ctx, 'legacy');
  if (!built || built.body.ok !== true) {
    const failure = (built && built.body && built.body.error) || {};
    throw new Error(failure.message || '读会话清单失败');
  }
  // 完整列表走全量那条分支：`buildSessionsResponse` 不传分页参数时 items 就是全部。
  const all = Array.isArray(built.body.items) ? built.body.items : [];
  const cwd = typeof options.cwd === 'string' ? options.cwd.trim() : '';
  const scoped = all.filter((item) => item && item.origin !== 'subagent'
    && (!cwd || item.cwd === cwd));
  const rows = scoped.map(sessionRow).filter(Boolean);
  return { sessions: rows.slice(0, LIST_LIMIT), total: rows.length };
}

/** 读一条会话的最近若干条消息。 */
async function readSession(ctx, sessionId, limit) {
  const snapshot = await buildMessagesSnapshot(ctx, sessionId, limit);
  if (!snapshot || snapshot.ok !== true) {
    const failure = (snapshot && snapshot.error) || {};
    throw new Error(failure.message || '读会话正文失败');
  }
  const items = Array.isArray(snapshot.items) ? snapshot.items.map(messageRow).filter(Boolean) : [];
  return { sessionId, messages: items };
}

/**
 * 往一条会话里发一句话。
 *
 * 与手机 `POST /session/send` 共用 `promptOnce`（幂等、slash 命令那条派发不在这一版里：
 * 这里只发普通消息）。`mode` 不替调用方定 —— 给队列就走队列，给插话就插话，不给就交给
 * 宿主默认。
 */
async function sendToSession(ctx, sessionId, text, mode) {
  const payload = { sessionId, content: [{ type: 'text', text }] };
  if (mode) payload.mode = mode;
  const response = await promptOnce(ctx, '', payload);
  const { error } = unwrap(response);
  if (error) throw new Error(error.message || '发送失败');
  return { sessionId, sent: true };
}

/** 停掉一条会话正在跑的那一轮（与手机那颗停止按钮同一条 `session.cancel`）。 */
async function stopSession(ctx, sessionId) {
  const { error } = unwrap(await callSessions(ctx, 'cancel', { sessionId }));
  if (error) throw new Error(error.message || '停止失败');
  return { sessionId, stopped: true };
}

/**
 * 新建一条会话。
 *
 * 只接受已登记的工作区（`workspaceId`）或它的路径（`cwd`）—— 与手机上「新对话」同一个
 * 入口，宿主自己会把新会话挂到那个项目的账上。这里不做隔离工作树那一条：它是手机侧的
 * 一种特殊用法，不是「新建对话」的默认语义。
 *
 * **cwd 必须落在已登记的工作区里**，与 `POST /session/new` 同一条边界（`session-new.js`
 * 那句「随手塞一个 / 进来等于把整台机器变成允许读写区」）：会话的 cwd 就是手机侧按路径
 * 读写文件的第二个根，这条口子放开等于绕过 AGENTS.md §2 的能力面。工作区清单读不到时
 * 照实抛，不按「没有工作区」处理。
 */
async function createSession(ctx, options = {}) {
  const payload = {};
  const workspaceId = typeof options.workspaceId === 'string' ? options.workspaceId.trim() : '';
  const declaredCwd = typeof options.cwd === 'string' ? options.cwd.trim() : '';
  if (workspaceId) {
    payload.workspaceId = workspaceId;
  } else if (declaredCwd) {
    if (!path.isAbsolute(declaredCwd)) throw new Error('cwd 必须是绝对路径');
    const target = path.resolve(declaredCwd);
    const roots = await workspaceRoots(ctx);
    if (!roots.some((root) => isWithin(root, target))) {
      throw new Error('这个目录不在已登记的工作区里，不能用来新建会话');
    }
    payload.cwd = target;
  }
  if (typeof options.agentPreset === 'string' && options.agentPreset.trim()) {
    payload.agentPreset = options.agentPreset.trim();
  }
  const { value, error } = unwrap(await callSessions(ctx, 'create', payload));
  if (error) throw new Error(error.message || '新建会话失败');
  const sessionId = value && typeof value.sessionId === 'string' ? value.sessionId : '';
  if (!sessionId) throw new Error('新建会话没有返回会话 ID');
  // 与路由同一个口径：新会话必须马上出现在下一次列表里。
  invalidateSessionList(ctx);
  return { sessionId, cwd: (value && typeof value.cwd === 'string' && value.cwd) || '' };
}

/**
 * 会话改名（`session.rename`，与手机会话菜单里那一项同一条）。
 *
 * 改完立刻作废列表缓存：否则下一次列表拿到的还是 10 秒窗口内的旧标题，看着像没生效。
 */
async function renameSession(ctx, sessionId, title) {
  const { error } = unwrap(await callSessions(ctx, 'rename', { sessionId, title }));
  if (error) throw new Error(error.message || '改名失败');
  invalidateSessionList(ctx);
  return { sessionId, title };
}

/**
 * 分叉一条会话（`session.fork`，与 App 会话菜单里的「Fork」同一条）。
 *
 * `atSeq` 给到就只分叉到那一步，不给就整条复制。分叉是**非幂等**写 —— 重投一次会多一个
 * 子会话；这里没有 requestId，所以调用方必须自己知道它在新建东西。
 */
async function forkSession(ctx, sessionId, options = {}) {
  const payload = { sessionId };
  if (Number.isSafeInteger(options.atSeq) && options.atSeq >= 0) {
    payload.atSeq = options.atSeq;
    payload.increaseTitle = options.increaseTitle !== false;
  }
  const { value, error } = unwrap(await callSessions(ctx, 'fork', payload));
  if (error) throw new Error(error.message || '分叉失败');
  const forkedId = value && typeof value.sessionId === 'string' ? value.sessionId : '';
  if (!forkedId) throw new Error('分叉没有返回新会话 ID');
  invalidateSessionList(ctx);
  return { sessionId: forkedId, from: sessionId };
}

/**
 * 把一条会话移进 / 移出归档集合，以及置顶。
 *
 * 三个动作共用 `workspace.<method>`（`archiveSession` / `unarchiveSession` / `pinSession` /
 * `unpinSession`），与手机侧栏行尾那几颗按钮同一套动词。归档在移动端就是「删除」语义，
 * 日志留着；取消归档与置顶都是幂等的。
 */
async function setSessionFlag(ctx, method, sessionId, extra = {}) {
  const { value, error } = unwrap(await callWorkspace(ctx, method, { sessionId, ...extra }));
  if (error) throw new Error(error.message || `${method} 失败`);
  invalidateSessionList(ctx);
  return { sessionId, ...(value && typeof value === 'object' ? value : {}) };
}

/** 会话换到另一个工作区（`workspace.insertSessionBefore`，与侧栏拖动排序同一个动词）。 */
async function moveSession(ctx, workspaceId, sessionId, beforeSessionId) {
  const payload = { workspaceId, sessionId };
  if (typeof beforeSessionId === 'string' && beforeSessionId.trim()) {
    payload.beforeSessionId = beforeSessionId.trim();
  }
  const { value, error } = unwrap(await callWorkspace(ctx, 'insertSessionBefore', payload));
  if (error) throw new Error(error.message || '移动会话失败');
  invalidateSessionList(ctx);
  return { sessionId, workspaceId, workspace: value && value.workspace };
}

/**
 * 把一个目录采纳成工作区（`workspace.create`）。
 *
 * 与手机上「添加工作区」同一个动词：已经登记过的返回现有那一项，`created` 说这次是不是
 * 真新建。路径不做「必须在某个允许区里」的检查 —— 这条**就是**在扩大允许区本身，它和
 * 手机上点「添加工作区」选一个目录是同一件事。
 */
async function createWorkspace(ctx, dirPath) {
  const { value, error } = unwrap(await callWorkspace(ctx, 'create', { path: dirPath }));
  if (error) throw new Error(error.message || '添加工作区失败');
  invalidateSessionList(ctx);
  const workspace = value && value.workspace ? value.workspace : null;
  return {
    workspaceId: workspace && typeof workspace.workspaceId === 'string' ? workspace.workspaceId : '',
    title: workspace && typeof workspace.title === 'string' ? workspace.title : '',
    path: workspace && typeof workspace.path === 'string' ? workspace.path : dirPath,
    created: !!(value && value.created),
  };
}

/**
 * 删除工作区登记（`workspace.delete`）。
 *
 * 与手机上那一项同一口径：**只删登记，目录与里面的会话日志一概不动**。名字取 `remove*`
 * 而不是 `delete*`，免得读的人以为它会删目录。
 */
async function removeWorkspace(ctx, workspaceId) {
  const { error } = unwrap(await callWorkspace(ctx, 'delete', { workspaceId }));
  if (error) throw new Error(error.message || '删除工作区失败');
  invalidateSessionList(ctx);
  return { workspaceId, removed: true };
}

/** 改工作区显示名（`workspace.rename`，重名时宿主回 `workspace/name-conflict`）。 */
async function renameWorkspace(ctx, workspaceId, title) {
  const { value, error } = unwrap(await callWorkspace(ctx, 'rename', { workspaceId, title }));
  if (error) throw new Error(error.message || '重命名工作区失败');
  invalidateSessionList(ctx);
  return { workspaceId, title, workspace: value && value.workspace };
}

/** 只读把一条已经拆出去的活儿接回来：这里只是把 `callWorkspace` 暴露给上面几个动作。 */
function callWorkspace(ctx, method, payload) {
  return ctx.apiProxy.workspace[method]({ rpcId: 'mobile', method: `workspace.${method}`, payload });
}

/**
 * 工具定义。一个工具、五个动作：能力是同一件事（这台电脑上的工作区与对话），拆成五个只会
 * 让工具列表变长。
 */
function registerWorkspaceTool(ctx, log) {
  const { defineTool } = require('@deepseek-ai/dsh-tools');
  ctx.tools.register(defineTool({
    name: 'dsh_workspace',
    description: 'Inspect and act on the DSH workspaces and conversations on this computer: list registered workspaces, list conversations, read a conversation, send a message into one, stop the turn that is running, or start a new conversation. Covers every workspace on this machine, not only the current one.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [
          'list_workspaces', 'list_sessions', 'read_session',
          'send_message', 'stop_session', 'new_session',
          'rename_session', 'fork_session',
          'archive_session', 'unarchive_session', 'pin_session', 'unpin_session',
          'move_session',
          'create_workspace', 'rename_workspace', 'remove_workspace',
        ],
        description: 'Which operation to run.',
      },
      sessionId: { type: 'string', description: 'Target conversation; used by most session actions.' },
      text: { type: 'string', description: 'Message body for send_message.' },
      title: { type: 'string', description: 'New title for rename_session and rename_workspace.' },
      mode: { type: 'string', enum: ['queue', 'steer'], description: 'Optional delivery mode for send_message: queue waits for the current turn, steer interjects. Omit to keep the host default.' },
      cwd: { type: 'string', description: 'Workspace path: filters list_sessions, and picks the project for new_session. For new_session it must be an absolute path inside a registered workspace.' },
      path: { type: 'string', description: 'Absolute directory to adopt as a workspace, for create_workspace.' },
      workspaceId: { type: 'string', description: 'Registered workspace id, for new_session / move_session / rename_workspace / remove_workspace.' },
      beforeSessionId: { type: 'string', description: 'Optional ordering anchor for move_session: place the session right before this one.' },
      atSeq: { type: 'integer', description: 'Optional point to fork at for fork_session; omit to copy the whole conversation.' },
      agentPreset: { type: 'string', description: 'Optional agent preset for new_session.' },
      limit: { type: 'integer', description: 'Maximum messages returned by read_session (default 50).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          workspaces: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                workspaceId: { type: 'string' },
                title: { type: 'string' },
                path: { type: 'string' },
              },
            },
          },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                title: { type: 'string' },
                cwd: { type: 'string' },
                running: { type: 'boolean' },
                updatedAt: { type: 'number' },
                pinned: { type: 'boolean' },
                origin: { type: 'string' },
              },
            },
          },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                role: { type: 'string' },
                text: { type: 'string' },
                truncated: { type: 'boolean' },
              },
            },
          },
          sessions_total: { type: 'integer' },
          workspaces_total: { type: 'integer' },
          sessionId: { type: 'string' },
          workspaceId: { type: 'string' },
          title: { type: 'string' },
          cwd: { type: 'string' },
          sent: { type: 'boolean' },
          stopped: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSummary(value) }],
    },
    execute: async (args) => {
      switch (args.action) {
        case 'list_workspaces': {
          const listed = await listWorkspaces(ctx);
          return { action: args.action, workspaces: listed.workspaces, workspaces_total: listed.total };
        }
        case 'list_sessions': {
          const listed = await listSessions(ctx, { cwd: args.cwd });
          return { action: args.action, sessions: listed.sessions, sessions_total: listed.total };
        }
        case 'read_session': {
          const sessionId = requiredSessionId(args);
          const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, READ_LIMIT) : READ_LIMIT;
          const read = await readSession(ctx, sessionId, limit);
          return { action: args.action, sessionId, messages: read.messages };
        }
        case 'send_message': {
          const sessionId = requiredSessionId(args);
          const text = typeof args.text === 'string' ? args.text.trim() : '';
          if (!text) throw new Error('send_message 需要 text');
          const sent = await sendToSession(ctx, sessionId, text, args.mode);
          return { action: args.action, sessionId: sent.sessionId, sent: true };
        }
        case 'stop_session': {
          const sessionId = requiredSessionId(args);
          const stopped = await stopSession(ctx, sessionId);
          return { action: args.action, sessionId: stopped.sessionId, stopped: true };
        }
        case 'new_session': {
          const created = await createSession(ctx, args);
          return { action: args.action, sessionId: created.sessionId, cwd: created.cwd };
        }
        case 'rename_session': {
          const sessionId = requiredSessionId(args);
          const title = requiredText(args, 'title');
          const renamed = await renameSession(ctx, sessionId, title);
          return { action: args.action, sessionId: renamed.sessionId, title: renamed.title };
        }
        case 'fork_session': {
          const sessionId = requiredSessionId(args);
          const forked = await forkSession(ctx, sessionId, { atSeq: args.atSeq });
          return { action: args.action, sessionId: forked.sessionId };
        }
        case 'archive_session':
        case 'unarchive_session':
        case 'pin_session':
        case 'unpin_session': {
          const sessionId = requiredSessionId(args);
          const method = ACTION_TO_FLAG[args.action];
          await setSessionFlag(ctx, method, sessionId, args.action === 'archive_session' ? {} : {});
          return { action: args.action, sessionId };
        }
        case 'move_session': {
          const sessionId = requiredSessionId(args);
          const workspaceId = requiredText(args, 'workspaceId');
          await moveSession(ctx, workspaceId, sessionId, args.beforeSessionId);
          return { action: args.action, sessionId, workspaceId };
        }
        case 'create_workspace': {
          const created = await createWorkspace(ctx, requiredText(args, 'path'));
          return {
            action: args.action,
            workspaceId: created.workspaceId,
            title: created.title,
            cwd: created.path,
          };
        }
        case 'rename_workspace': {
          const workspaceId = requiredText(args, 'workspaceId');
          const title = requiredText(args, 'title');
          await renameWorkspace(ctx, workspaceId, title);
          return { action: args.action, workspaceId, title };
        }
        case 'remove_workspace': {
          const workspaceId = requiredText(args, 'workspaceId');
          await removeWorkspace(ctx, workspaceId);
          return { action: args.action, workspaceId };
        }
        default:
          throw new Error(`未知的 action：${args.action}`);
      }
    },
  }));
  log?.('dsh_workspace 工具已注册');
}

function requiredSessionId(args) {
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  if (!sessionId) throw new Error('这个动作需要 sessionId');
  return sessionId;
}

/** 取一个必填的文本参数（标题、工作区 id、目录路径都走它）。 */
function requiredText(args, key) {
  const value = typeof args[key] === 'string' ? args[key].trim() : '';
  if (!value) throw new Error(`这个动作需要 ${key}`);
  return value;
}

/** 四个会话标记动作 → 宿主动词。 */
const ACTION_TO_FLAG = {
  archive_session: 'archiveSession',
  unarchive_session: 'unarchiveSession',
  pin_session: 'pinSession',
  unpin_session: 'unpinSession',
};

/** 结果压成一句话，给模型看的那份正文。 */
function renderSummary(value) {
  switch (value.action) {
    case 'list_workspaces': {
      const names = (value.workspaces || []).map((w) => w.title || w.path).slice(0, 20);
      return `工作区 ${value.workspaces_total || 0} 个：${names.join('、') || '（空）'}`;
    }
    case 'list_sessions': {
      const names = (value.sessions || []).map((s) => s.title || s.sessionId).slice(0, 20);
      return `会话 ${value.sessions_total || 0} 条：${names.join('、') || '（空）'}`;
    }
    case 'read_session':
      return `读了会话 ${value.sessionId} 的最近 ${(value.messages || []).length} 条消息。`;
    case 'send_message':
      return `已把消息发给会话 ${value.sessionId}。`;
    case 'stop_session':
      return `已停止会话 ${value.sessionId} 正在跑的这一轮。`;
    case 'new_session':
      return `已新建会话 ${value.sessionId}${value.cwd ? `（${value.cwd}）` : ''}。`;
    case 'rename_session':
      return `会话 ${value.sessionId} 已改名为「${value.title}」。`;
    case 'fork_session':
      return `已从 ${value.sessionId ? '原会话' : '会话'}分叉出新会话 ${value.sessionId}。`;
    case 'archive_session':
      return `已归档会话 ${value.sessionId}（对话日志保留，可从归档里找回来）。`;
    case 'unarchive_session':
      return `已把会话 ${value.sessionId} 移出归档。`;
    case 'pin_session':
      return `已置顶会话 ${value.sessionId}。`;
    case 'unpin_session':
      return `已取消置顶会话 ${value.sessionId}。`;
    case 'move_session':
      return `已把会话 ${value.sessionId} 移到工作区 ${value.workspaceId}。`;
    case 'create_workspace':
      return `工作区「${value.title || value.cwd}」已在 ${value.cwd}。`;
    case 'rename_workspace':
      return `工作区 ${value.workspaceId} 已改名为「${value.title}」。`;
    case 'remove_workspace':
      return `已删除工作区登记 ${value.workspaceId}（目录与对话都还在）。`;
    default:
      return '完成。';
  }
}

/**
 * 装配层的入口：挂 `dsh_workspace` 工具。
 *
 * 与 `installExtensions` 同一个口径：没有 tools 注入的 profile 只少这个工具，插件其余部分
 * 照常装 —— 缺注入时 cordis 抛的是 "without inject"。别的错误照抛，不能把真的注册失败
 * 也当成「这个 profile 没注入」。
 */
function installWorkspaceTools(ctx) {
  try {
    registerWorkspaceTool(ctx, (message) => {
      try { ctx.logger?.info?.(message); } catch { /* 日志失败不影响注册 */ }
    });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (!message.includes('without inject')) throw error;
  }
}

module.exports = {
  registerWorkspaceTool,
  installWorkspaceTools,
  listWorkspaces,
  listSessions,
  readSession,
  sendToSession,
  stopSession,
  createSession,
  renameSession,
  forkSession,
  setSessionFlag,
  moveSession,
  createWorkspace,
  removeWorkspace,
  renameWorkspace,
  workspaceRow,
  sessionRow,
  messageRow,
};

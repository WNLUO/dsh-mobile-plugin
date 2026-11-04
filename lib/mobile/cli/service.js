'use strict';

/**
 * 移动端「CLI 对话」：`/api/mobile/v1/cli/*` 的 handler、会话表与 WebSocket 流。
 *
 * 与远程终端（`mobile/terminal.js`）是同一个能力的两种呈现，边界也同一条：可执行文件只能
 * 是 `agents.js` 那张表里的名字，工作目录只能来自这台设备已注册的工作区，没有「执行任意命令」
 * 的路由。区别是终端把 TUI 字节原样搬给手机，这里让 CLI 以 ACP 的方式跑、把结构化事件
 * 交给对话页 —— 手机因此能像正常对话一样看正文、看工具调用、点审批。
 *
 * 三个设计点：
 *
 *   1. **建会话立刻返回**。适配器第一次要 `npx` 下载桥包、之后还要握手，几十秒都可能；把它
 *      压在一次 HTTP 里，App 那边的请求会先超时。所以 create 只建记录、回 `starting`，真正的
 *      启动在后台跑，进度与失败都从 WS 帧上报（`notice` / `status` / `exit`）。
 *   2. **块要攒批发**。流式正文每秒几十段，一段一帧等于把「出字节奏」换成「网络往返次数」。
 *      攒 60ms 一轮，同一块的多次改动只发最后那一份。
 *   3. **会话托管在宿主**。手机锁屏、切后台、换 Wi-Fi 都不该把 CLI 掐掉；重连时 `hello` 帧
 *      带全量块重放，页面回到原样。
 */

const { WebSocketServer } = require('ws');

const { readJsonBody, sendJson } = require('../../shared/http-util');
const { unwrap } = require('../envelope.js');
const { AGENTS, findAgent, resolveAgent, childEnv } = require('./agents.js');
const { createBlockLog } = require('./blocks.js');
const { startAgent } = require('./acp.js');
const { createCliMobile } = require('./mobile.js');

/** 错误码 → HTTP 状态；与终端那一组同口径。 */
const STATUS_BY_CODE = {
  BAD_REQUEST: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  UNSUPPORTED: 400,
  AGENT_UNAVAILABLE: 404,
  WORKSPACE_UNAVAILABLE: 502,
  TOO_MANY_SESSIONS: 429,
  SPAWN_FAILED: 500,
};

/** 同时活着的 CLI 会话上限：每一条都挂着一个真进程（有的还带一个 app-server）。 */
const MAX_SESSIONS = 4;

/** 流式块的攒批窗口。 */
const FLUSH_MS = 60;

/** 标题兜底截断长度（宿主没给 `session_info_update.title` 时用首条提问）。 */
const TITLE_MAX = 40;

class CliRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CliRequestError';
    this.code = code;
  }
}

function fail(code, message) {
  return new CliRequestError(code, message);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function query(req) {
  return new URL(req.url || '/', 'http://x').searchParams;
}

async function bodyJson(req) {
  const body = await readJsonBody(req, 64 * 1024);
  if (!body || typeof body !== 'object') throw fail('BAD_REQUEST', '需要 JSON 请求体');
  return body;
}

/** 会话表与它的所有出口。一个宿主进程一份（装配层建、装配层关）。 */
function createCliService({ authorized, onLog } = {}) {
  /** sessionId → 会话。 */
  const sessions = new Map();
  let seq = 0;
  let permSeq = 0;
  let closed = false;

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 256 * 1024,
  });

  const log = (message) => { try { onLog?.(message); } catch { /* 日志失败不该影响搬运 */ } };

  function send(ws, frame) {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify(frame)); } catch { /* 已经断了 */ }
  }

  function broadcast(session, frame) {
    for (const ws of session.sockets) send(ws, frame);
    // 普通会话那套移动端接口（`cli/mobile.js`）挂在同一条广播上：它同样需要「块变了 /
    // 状态变了 / 卡来了」这几件事，但出口是 SSE 而不是 WebSocket。失败不能影响搬运。
    for (const sink of session.sinks) { try { sink(frame); } catch { /* 单个观众写失败不影响别人 */ } }
  }

  /**
   * 挂一个非 WebSocket 的观众（`cli/mobile.js` 的 SSE）。
   *
   * 返回解绑函数。会话被收掉时 sinks 跟着会话对象一起没，不需要额外清理。
   */
  function watch(session, sink) {
    session.sinks.add(sink);
    return () => { session.sinks.delete(sink); };
  }

  /** 攒批：同一块的多次改动只发最后那一份。 */
  function markBlock(session, block) {
    session.dirty.set(block.id, block);
    if (session.timer) return;
    session.timer = setTimeout(() => {
      session.timer = null;
      const pending = [...session.dirty.values()];
      session.dirty.clear();
      for (const item of pending) broadcast(session, { t: 'block', block: item });
    }, FLUSH_MS);
    session.timer.unref?.();
  }

  function flushNow(session) {
    if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    const pending = [...session.dirty.values()];
    session.dirty.clear();
    for (const item of pending) broadcast(session, { t: 'block', block: item });
  }

  function detailOf(session) {
    return {
      sessionId: session.id,
      agent: session.agentId,
      label: session.label,
      workspaceId: session.workspaceId,
      title: session.title,
      cwd: session.cwd,
      status: session.status,
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
      // 会话的可配置项 / 模式 / 斜杠命令：手机照着这两张表画「选模型」与「模式」，
      // 不必为每家 CLI 各写一套（见 acp.js 的 configOptions）。
      configOptions: session.configOptions,
      modes: session.modes,
      commands: session.commands,
      // 挂着的审批也要进这一份：审批原本只靠 WS 那一帧送达，帧进不来时卡片永远不出现，
      // 而适配器那头正等着这个回答。放进详情里，轮询那条路也能把它画出来。
      permissions: [...session.permissionFrames.values()],
      blocks: session.blocks.list(),
    };
  }

  /** 只发「配置 / 命令变了」，不重发整份块（那是 `hello` 的活）。 */
  function pushConfig(session) {
    broadcast(session, {
      t: 'config',
      configOptions: session.configOptions,
      modes: session.modes,
      commands: session.commands,
    });
  }

  function setStatus(session, status) {
    if (session.status === status) return;
    session.status = status;
    session.updatedAt = Date.now();
    broadcast(session, { t: 'status', status });
  }

  function setTitle(session, title) {
    const clean = text(title);
    if (!clean || clean === session.title) return;
    session.title = clean;
    session.updatedAt = Date.now();
    broadcast(session, { t: 'title', title: clean });
  }

  function say(session, level, message) {
    const block = session.blocks.notice(level, message, Date.now());
    flushNow(session);
    markBlock(session, block);
    flushNow(session);
  }

  /** 进程没了（正常退出 / 崩溃 / 握不上手）：收口块、拒掉挂着的审批、告诉每一部手机。 */
  function finish(session, reason) {
    if (session.finished || session.closed) return;
    session.finished = true;
    session.handle = null;
    for (const [, pending] of session.permissions) {
      try { pending({ outcome: { outcome: 'cancelled' } }); } catch { /* 已经没了 */ }
    }
    session.permissions.clear();
    session.permissionFrames.clear();
    for (const block of session.blocks.settle(Date.now())) markBlock(session, block);
    session.status = 'error';
    session.updatedAt = Date.now();
    broadcast(session, { t: 'status', status: 'error' });
    broadcast(session, { t: 'exit', reason: text(reason) || 'CLI 退出了' });
    flushNow(session);
    log(`cli ${session.id}: 退出（${text(reason) || '未说明'}）`);
  }

  function onUpdate(session, update) {
    const at = Date.now();
    const kind = update && update.sessionUpdate;
    // 配置类事件不进块表：它们是「这一页能做哪些设置」，画在输入条上。
    if (kind === 'available_commands_update') {
      const list = Array.isArray(update.availableCommands) ? update.availableCommands : [];
      session.commands = list.map((entry) => ({
        name: text(entry.name),
        description: text(entry.description),
        ...(entry.input ? { hint: text(entry.input.hint) } : {}),
      })).filter((entry) => entry.name);
      pushConfig(session);
      return;
    }
    if (kind === 'config_option_update') {
      if (Array.isArray(update.configOptions)) session.configOptions = update.configOptions;
      pushConfig(session);
      return;
    }
    if (kind === 'current_mode_update') {
      if (session.modes && text(update.currentModeId)) session.modes = { ...session.modes, currentModeId: text(update.currentModeId) };
      pushConfig(session);
      return;
    }
    const result = session.blocks.apply(update, at);
    if (!result) return;
    session.updatedAt = at;
    if (result.title) setTitle(session, result.title);
    if (result.block) markBlock(session, result.block);
  }

  /** 适配器要放行：做成一条挂着的 promise，等手机上点。 */
  function onPermission(session, params) {
    permSeq += 1;
    const id = `p${permSeq}`;
    const toolCall = (params && params.toolCall) || {};
    const options = Array.isArray(params && params.options) ? params.options : [];
    const request = {
      id,
      title: text(toolCall.title) || '需要你的许可',
      detail: toolCall.rawInput === undefined ? '' : JSON.stringify(toolCall.rawInput).slice(0, 400),
      options: options.map((option) => ({
        optionId: option.optionId,
        name: text(option.name) || option.optionId,
        kind: text(option.kind) || 'allow_once',
      })),
    };
    session.permissionFrames.set(id, request);
    broadcast(session, { t: 'permission', request });
    return new Promise((resolve) => {
      session.permissions.set(id, (outcome) => {
        session.permissions.delete(id);
        session.permissionFrames.delete(id);
        broadcast(session, { t: 'permission-resolved', id });
        resolve(outcome);
      });
    });
  }

  async function boot(session, spec) {
    try {
      const handle = await startAgent({
        spec,
        cwd: session.cwd,
        env: childEnv(spec.command),
        onUpdate: (update) => onUpdate(session, update),
        onPermission: (params) => onPermission(session, params),
        onExit: (reason) => finish(session, reason),
      });
      if (session.closed) { handle.close(); return; }
      session.handle = handle;
      session.finished = false;
      session.configOptions = handle.configOptions || [];
      session.modes = handle.modes || null;
      pushConfig(session);
      setStatus(session, 'idle');
      log(`cli ${session.id}: ${session.label} 起来了`);
    } catch (error) {
      if (session.closed) return;
      // 适配器的报错是英文原文（`Invalid params` / `Authentication required` 之类），单看一眼
      // 不知道是谁出了问题，所以前面补一句「哪个 CLI 起不来」。
      const raw = error && error.message ? error.message : '不知道什么原因';
      const message = `${session.label} 起不来：${raw}`;
      say(session, 'error', message);
      finish(session, message);
    }
  }

  /**
   * 发一轮。
   *
   * WS 与 HTTP 两个入口都走这一份：WS 是快的那条路，HTTP 是「隧道上帧进不来」时的兜底
   * （手机上实测过这条，见 A1-259 的坑）。所以两边都不能各写一份，不然行为会分叉。
   */
  function runPrompt(session, message) {
    if (!message) return { ok: false, error: '空消息' };
    if (session.finished || !session.handle) {
      say(session, 'error', 'CLI 还没起来，先等一下');
      return { ok: false, error: 'CLI 还没起来' };
    }
    if (session.status === 'running') {
      say(session, 'info', '上一轮还没结束，先停一下再发');
      return { ok: false, error: '上一轮还没结束' };
    }
    markBlock(session, session.blocks.pushUser(message, Date.now()));
    flushNow(session);
    // 宿主还没给过标题就用首条提问兜一个 —— 侧栏那一行不能一直写着 CLI 的名字。
    if (session.title === session.label) {
      setTitle(session, message.length > TITLE_MAX ? `${message.slice(0, TITLE_MAX)}…` : message);
    }
    setStatus(session, 'running');
    const handle = session.handle;
    handle.prompt(message).then(
      () => {
        for (const block of session.blocks.settle(Date.now())) markBlock(session, block);
        if (!session.finished) setStatus(session, 'idle');
        flushNow(session);
      },
      (error) => {
        const reason = error && error.message ? error.message : '这一轮失败了';
        for (const block of session.blocks.settle(Date.now())) markBlock(session, block);
        flushNow(session);
        say(session, 'error', reason);
        setStatus(session, handle.alive ? 'idle' : 'error');
      },
    );
    return { ok: true };
  }

  function answerPermission(session, id, optionId) {
    const pending = session.permissions.get(id);
    if (!pending || !optionId) return false;
    pending({ outcome: { outcome: 'selected', optionId } });
    return true;
  }

  function cancelTurn(session) {
    try { session.handle?.cancel(); } catch { /* 已经没了 */ }
  }

  function forget(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    session.closed = true;
    sessions.delete(sessionId);
    if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    for (const [, pending] of session.permissions) {
      try { pending({ outcome: { outcome: 'cancelled' } }); } catch { /* 已经没了 */ }
    }
    session.permissions.clear();
    try { session.handle?.close(); } catch { /* 可能已经退出 */ }
    for (const ws of session.sockets) {
      try { ws.close(); } catch { /* 已经关了 */ }
    }
    session.sockets.clear();
    return true;
  }

  /** GET cli/agents：这台电脑上哪几个能起。 */
  function handleAgents(_ctx, _req, res) {
    const agents = AGENTS.map((agent) => {
      const spec = resolveAgent(agent);
      return spec.ok
        ? { id: agent.id, label: agent.label, available: true }
        : { id: agent.id, label: agent.label, available: false, reason: spec.reason };
    });
    sendJson(res, 200, { ok: true, agents });
  }

  /**
   * POST cli/session { workspaceId, agent }
   *
   * 工作目录从工作区清单里取：手机只给 `workspaceId`，路径由宿主自己填 —— 与终端、Git
   * 同一个口径，没有一条能让调用方指定任意路径的路。
   */
  async function handleCreate(ctx, req, res) {
    const body = await bodyJson(req);
    if (closed) throw fail('UNSUPPORTED', '宿主正在关闭，稍后再试');

    const workspaceId = text(body.workspaceId);
    if (!workspaceId) throw fail('BAD_REQUEST', '需要 workspaceId');

    const agent = findAgent(text(body.agent));
    if (!agent) throw fail('BAD_REQUEST', '不认识这个 CLI');
    const spec = resolveAgent(agent);
    if (!spec.ok) throw fail('AGENT_UNAVAILABLE', spec.reason);

    if (sessions.size >= MAX_SESSIONS) {
      throw fail('TOO_MANY_SESSIONS', '同时开着的 CLI 太多了，先关掉几个');
    }

    const listed = await ctx.apiProxy.workspace.list({ rpcId: 'mobile', method: 'workspace.list', payload: {} });
    const { value, error } = unwrap(listed);
    if (error) throw fail('WORKSPACE_UNAVAILABLE', '取不到工作区清单，稍后再试');
    const items = Array.isArray(value) ? value : (value && Array.isArray(value.items) ? value.items : []);
    const item = items.find((entry) => entry && entry.workspaceId === workspaceId);
    if (!item) throw fail('FORBIDDEN', '这个工作区不在这台机器上');
    const cwd = text(item.path);
    if (!cwd) throw fail('FORBIDDEN', '这个工作区没有对应目录');

    seq += 1;
    const id = `cli-${Date.now().toString(36)}-${seq.toString(36)}`;
    const session = {
      id,
      workspaceId,
      agentId: agent.id,
      label: agent.label,
      cwd,
      title: agent.label,
      status: 'starting',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      blocks: createBlockLog(),
      configOptions: [],
      modes: null,
      commands: [],
      sockets: new Set(),
      dirty: new Map(),
      timer: null,
      handle: null,
      finished: false,
      closed: false,
      permissions: new Map(),
      permissionFrames: new Map(),
      sinks: new Set(),
    };
    sessions.set(id, session);

    // 不 await：见文件头第 1 点。
    void boot(session, spec);

    sendJson(res, 200, { ok: true, session: detailOf(session) });
  }

  /** GET cli/sessions：宿主上还活着的会话（侧栏与页面重进都读它）。 */
  function handleSessions(_ctx, _req, res) {
    const list = [...sessions.values()].map((session) => {
      const detail = detailOf(session);
      delete detail.blocks;
      return detail;
    });
    sendJson(res, 200, { ok: true, sessions: list });
  }

  /** 按 sessionId 取一条会话，取不到就 404。 */
  function mustSession(id) {
    const session = sessions.get(text(id));
    if (!session) throw fail('NOT_FOUND', '这条会话已经不在了');
    return session;
  }

  /**
   * GET cli/session?sessionId=：一条会话的全貌（块、配置、命令、状态）。
   *
   * 页面靠它做兜底轮询：隧道上偶尔会出现「WS 握手成了、帧一个都没进来」的形状，只靠推送
   * 的话界面就一直是空的、发出去的消息也看不到结果。
   */
  function handleDetail(_ctx, req, res) {
    const session = mustSession(query(req).get('sessionId'));
    sendJson(res, 200, { ok: true, session: detailOf(session) });
  }

  /** POST cli/prompt { sessionId, text }：发一轮（WS 那条的 HTTP 版本）。 */
  async function handlePrompt(_ctx, req, res) {
    const body = await bodyJson(req);
    const session = mustSession(body.sessionId);
    const result = runPrompt(session, text(body.text));
    if (!result.ok) throw fail('BAD_REQUEST', result.error);
    sendJson(res, 200, { ok: true });
  }

  /** POST cli/permission { sessionId, id, optionId }：回答一条挂着的审批。 */
  async function handlePermission(_ctx, req, res) {
    const body = await bodyJson(req);
    const session = mustSession(body.sessionId);
    if (!answerPermission(session, text(body.id), text(body.optionId))) {
      throw fail('NOT_FOUND', '这条审批已经不在了');
    }
    sendJson(res, 200, { ok: true });
  }

  /** POST cli/cancel { sessionId }：停掉这一轮（会话不杀）。 */
  async function handleCancel(_ctx, req, res) {
    const body = await bodyJson(req);
    const session = mustSession(body.sessionId);
    cancelTurn(session);
    sendJson(res, 200, { ok: true });
  }

  /**
   * POST cli/config { sessionId, configId?, value?, modeId? }
   *
   * 选模型 / 换思考档走 `configId + value`，换模式走 `modeId` —— 两者在 ACP 里是两条方法
   * （`session/set_config_option` 与 `session/set_mode`），这里按传了哪个分派。
   */
  async function handleConfig(_ctx, req, res) {
    const body = await bodyJson(req);
    const session = mustSession(body.sessionId);
    if (!session.handle) throw fail('BAD_REQUEST', 'CLI 还没起来');
    const modeId = text(body.modeId);
    const configId = text(body.configId);
    try {
      if (modeId) await session.handle.setMode(modeId);
      else if (configId) await session.handle.setConfigOption(configId, body.value);
      else throw fail('BAD_REQUEST', '需要 configId 或 modeId');
    } catch (error) {
      if (error && error.code && STATUS_BY_CODE[error.code]) throw error;
      throw fail('SPAWN_FAILED', error && error.message ? error.message : '改不了这一项');
    }
    sendJson(res, 200, { ok: true, session: detailOf(session) });
  }

  /** POST cli/close { sessionId }：主动收掉一个会话（用户点「结束」）。 */
  async function handleClose(_ctx, req, res) {
    const body = await bodyJson(req);
    const id = text(body.sessionId);
    if (!id) throw fail('BAD_REQUEST', '需要 sessionId');
    forget(id);
    sendJson(res, 200, { ok: true });
  }

  /**
   * WebSocket 升级：`?session=<id>`。
   *
   * 与终端那条同一套：凭据优先看**请求头**（连接建在 RN 侧，中转靠这些头决定转给哪台电脑），
   * 头没有再把查询串 `cred`/`token` 折成一次普通鉴权判定。拒绝要发生在 `handleUpgrade`
   * 之前 —— 那时 socket 还是普通 HTTP 连接。
   */
  function handleUpgrade(req, socket, head) {
    if (closed) return refuseUpgrade(socket, 503, 'Service Unavailable', 'CLI 服务已关闭');

    const params = query(req);
    const id = text(params.get('session'));
    if (!id) return refuseUpgrade(socket, 400, 'Bad Request', '缺少 session 参数');
    const token = text(params.get('cred')) || text(params.get('token'));

    let allowed = false;
    try {
      allowed = Boolean(authorized && (authorized(req) || (token && authorized({
        headers: { 'x-dsh-device-credential': token, authorization: `Bearer ${token}` },
      }))));
    } catch {
      allowed = false;
    }
    if (!allowed) {
      log(`cli ${id}: 凭据无效，拒绝升级`);
      return refuseUpgrade(socket, 401, 'Unauthorized', '移动端凭据无效');
    }

    const session = sessions.get(id);
    if (!session) {
      log(`cli ${id}: 会话不在表里，拒绝升级`);
      return refuseUpgrade(socket, 404, 'Not Found', '这条会话已经不在了');
    }

    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, session));
  }

  function attach(ws, session) {
    session.sockets.add(ws);
    log(`cli ${session.id}: 手机接上了（第 ${session.sockets.size} 条连接）`);

    // 先补全貌：页面重进 / 断线重连回来看到的仍是原来那一屏。
    send(ws, { t: 'hello', session: detailOf(session) });
    // 挂着的审批错过一次就再也点不到了，接上时重发一遍。
    for (const request of session.permissionFrames.values()) send(ws, { t: 'permission', request });
    if (session.finished) send(ws, { t: 'exit', reason: 'CLI 已经退出' });

    ws.on('message', (raw) => {
      let frame = null;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (!frame || typeof frame !== 'object') return;
      if (frame.t === 'prompt') { runPrompt(session, text(frame.text)); return; }
      if (frame.t === 'permission') { answerPermission(session, text(frame.id), text(frame.optionId)); return; }
      if (frame.t === 'cancel') { cancelTurn(session); }
    });

    ws.on('close', () => {
      session.sockets.delete(ws);
      log(`cli ${session.id}: 手机断开了（剩 ${session.sockets.size} 条连接）`);
    });
    ws.on('error', () => { session.sockets.delete(ws); });
  }

  function close() {
    closed = true;
    for (const id of [...sessions.keys()]) forget(id);
    try { wss.close(); } catch { /* 已经关了 */ }
  }

  /** 路由包装：把领域错误翻成 HTTP 状态，与终端那一份同口径。 */
  function wrap(handler) {
    return async (ctx, req, res) => {
      try {
        await handler(ctx, req, res);
      } catch (error) {
        const code = error && typeof error.code === 'string' && STATUS_BY_CODE[error.code]
          ? error.code
          : 'SPAWN_FAILED';
        const status = STATUS_BY_CODE[code] || 500;
        const message = error && typeof error.message === 'string' && error.message
          ? error.message
          : 'CLI 操作失败';
        log(`cli: ${code} ${message}`);
        sendJson(res, status, { ok: false, error: { code, message } });
      }
    };
  }

  /**
   * 让 `cli-*` 会话走宿主普通会话那一整套移动端接口的适配层（见 `cli/mobile.js`）。
   *
   * 构造在这里而不是装配层：它要读的会话表、发一轮、答审批、改标题全在这个闭包里。装配层
   * 只负责把端点接上（`mobile-api.js` 按 sessionId 前缀分派）。
   */
  const mobile = createCliMobile({
    sessions,
    runPrompt,
    answerPermission,
    cancelTurn,
    setTitle,
    watch,
    // 「清空已归档」要把 CLI 这边的归档会话当场收掉（没有磁盘日志可清）。
    forget,
  });

  return {
    mobile,
    handleAgents: wrap(handleAgents),
    handleCreate: wrap(handleCreate),
    handleSessions: wrap(handleSessions),
    handleDetail: wrap(handleDetail),
    handlePrompt: wrap(handlePrompt),
    handlePermission: wrap(handlePermission),
    handleCancel: wrap(handleCancel),
    handleConfig: wrap(handleConfig),
    handleClose: wrap(handleClose),
    handleUpgrade,
    close,
  };
}

/** 拒绝升级：这时 socket 还是一条普通 HTTP 连接，老实回一个状态码就行。 */
function refuseUpgrade(socket, status, reason, text_) {
  if (!socket || socket.destroyed) return;
  const body = Buffer.from(text_, 'utf8');
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n`
    + 'Connection: close\r\n'
    + 'Content-Type: text/plain; charset=utf-8\r\n'
    + `Content-Length: ${body.length}\r\n\r\n`,
  );
  socket.write(body);
  socket.end();
}

/**
 * 装配层只调这一个（`impl.js` 有行数上限，装配代码不许长回来）：建服务 + 挂清理。
 *
 * 清理必须挂 `ctx.effect`：插件热替换之后旧实例没人能关，适配器子进程会一直挂到宿主退出。
 */
function mountCli(ctx, { authorized, name } = {}) {
  const service = createCliService({
    authorized,
    onLog: (message) => ctx.logger?.info?.(`${name}: %s`, message),
  });
  ctx.effect(() => () => service.close(), `${name}: cli sessions`);
  return service;
}

module.exports = {
  mountCli,
  createCliService,
  MAX_SESSIONS,
};

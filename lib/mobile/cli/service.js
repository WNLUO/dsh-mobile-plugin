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
const { AGENTS, resolveAgent, childEnv, installedPackages, isInstalled } = require('./agents.js');
const { loadIcons } = require('./icons.js');
const { createUsage, applyUsageUpdate, applyPromptUsage } = require('./usage.js');
const { listRegistryAgents } = require('./registry.js');
const { preferredModel, rememberModel } = require('./model-prefs.js');
const { prefsOf, setValue, rememberOptions, describe } = require('./config-prefs.js');
const images = require('./images.js');
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

/**
 * 「这条新会话还差哪几项没套上」—— 记着的偏好 ∩ 新会话真有的选项。
 *
 * 抽成纯函数是为了能脱离进程直接钉（`test/cli-config-prefs.test.cjs` 跑的就是这一份，不是
 * 照抄一份等价实现）：三条同时成立才写 —— ① 用户记过这一项 ② 新会话里有这一项 ③ 这个值还在
 * 它的候选里。少了任何一条都跳过：CLI 升级换了档位名、或者这一版少了某个选项，硬塞过去只会
 * 让整条会话卡在一个它不认识的值上。
 *
 * 模型那一项不在这里（它记在 `model-prefs` 那本账里，由 `applyPreferredModel` 负责），
 * 免得两边各写一次、后写的那次盖掉前一次。
 */
function pendingPrefsOf(session) {
  const recorded = prefsOf(session.agentId).values;
  const options = Array.isArray(session.configOptions) ? session.configOptions : [];
  const skip = new Set(['model']);
  for (const option of options) {
    if (option && option.category === 'model') skip.add(option.id);
  }
  const out = [];
  for (const [configId, value] of Object.entries(recorded)) {
    if (skip.has(configId)) continue;
    const option = options.find((item) => item && item.id === configId);
    if (!option) continue;
    if (String(option.currentValue) === value) continue;
    const choices = Array.isArray(option.options) ? option.options : [];
    if (!choices.some((item) => item && String(item.value) === value)) continue;
    out.push([configId, value]);
  }
  return out;
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

  /**
   * 这一次的适配器清单：注册表（带缓存与兜底）那份，`agents.js` 内置四家垫底。
   *
   * 建会话与列清单都走它，所以「列出来的」和「点得下去的」永远是同一批 —— 两份各自算的话，
   * 注册表刚更新那一下会出现「列表里有、点了说不认识」。
   */
  let agentsPromise = null;
  function listAgents() {
    if (!agentsPromise) {
      agentsPromise = listRegistryAgents(AGENTS).catch(() => AGENTS);
    }
    return agentsPromise;
  }

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
    // 同上：块先出去，再播「退出了」，否则最后一段正文会跟在收口帧后面。
    flushNow(session);
    session.status = 'error';
    session.updatedAt = Date.now();
    broadcast(session, { t: 'status', status: 'error' });
    broadcast(session, { t: 'exit', reason: text(reason) || 'CLI 退出了' });
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
    // 用量不进块表：它是一条指标，不是对话内容（见 `cli/usage.js`）。
    if (kind === 'usage_update') {
      if (applyUsageUpdate(session.usage, update)) session.updatedAt = at;
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
      // 选项表先记一份：配置页在没开这条会话时要能画出「权限档有哪几个」。
      rememberOptions(session.agentId, session.configOptions);
      await applyRecordedPrefs(session, handle);
      // 套完之后再记一次：CLI 升级换了档位名时，这一步会把过期的选项表刷成新的。
      rememberOptions(session.agentId, session.configOptions);
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
   *
   * `images` 是这一发带的图（已经存好的元数据，见 `cli/images.js`）：块表记一份、交给适配器
   * 一份。**只有正文没有图**也照常走这里，与之前完全一样。
   */
  function runPrompt(session, message, images) {
    const pictures = Array.isArray(images) ? images.filter(Boolean) : [];
    if (!message && pictures.length === 0) return { ok: false, error: '空消息' };
    if (session.finished || !session.handle) {
      say(session, 'error', 'CLI 还没起来，先等一下');
      return { ok: false, error: 'CLI 还没起来' };
    }
    if (session.status === 'running') {
      say(session, 'info', '上一轮还没结束，先停一下再发');
      return { ok: false, error: '上一轮还没结束' };
    }
    if (pictures.length > 0 && session.handle.supportsImages === false) {
      say(session, 'error', `${session.label} 不接受图片输入，这一发没带图`);
      return { ok: false, error: '这个 CLI 不接受图片' };
    }
    markBlock(session, session.blocks.pushUser(message, Date.now(), pictures));
    flushNow(session);
    // 宿主还没给过标题就用首条提问兜一个 —— 侧栏那一行不能一直写着 CLI 的名字。
    // 只发了图没写字的：标题留给适配器自己（它多半会按上下文生成一个）。
    if (message && session.title === session.label) {
      setTitle(session, message.length > TITLE_MAX ? `${message.slice(0, TITLE_MAX)}…` : message);
    }
    setStatus(session, 'running');
    const handle = session.handle;
    const startedAt = Date.now();
    handle.prompt(message, pictures).then(
      (result) => {
        // 用量先记：`/session/stats` 就在这一轮之后被 App 拉一次，记晚了那一发读到的是上一轮。
        applyPromptUsage(session.usage, result, Date.now() - startedAt);
        // 顺序：先让落定的块出去，再播 idle。反过来的话最后那一段正文会落在 `turn/end`
        // 之后，App 收到它会把已经收尾的这一轮重新认成「在跑」（见 cli/mobile.js 的 onBlock）。
        for (const block of session.blocks.settle(Date.now())) markBlock(session, block);
        flushNow(session);
        if (!session.finished) setStatus(session, 'idle');
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

  /**
   * 把「这个 CLI 上次选的模型」套到刚起来的这条会话上。
   *
   * ACP 的模型是会话级配置，不套的话每次新会话都回到 CLI 自己的默认，用户每一轮都要重选一次
   * —— 普通会话里没有这种事（宿主那边的默认模型是设备级的）。值在新会话的目录里已经不存在
   * （CLI 升级换了名字）时不设，留在默认上，别硬塞一个它不认识的。
   */
  /**
   * 把用户在配置页定下的那一套套到这条新会话上（见 `cli/config-prefs.js`）。
   *
   * 顺序：先模型（`model-prefs` 那本老账），再其余各项（档位 / 权限模式 / 快速档）。逐项都是
   * 「新会话里有这一项、且这个值还在它的选项里」才写，写不动就跳过 —— 一条过期的偏好不该让
   * 会话建不起来，也不该把用户静默留在 CLI 的默认上还以为是自己的设置。
   *
   * 每一项的回包都带完整的新 `configOptions`，直接用它：手机随后那次目录请求读到的就是最终值。
   */
  async function applyRecordedPrefs(session, handle) {
    await applyPreferredModel(session, handle);
    for (const [configId, value] of pendingPrefsOf(session)) {
      try {
        const updated = await handle.setConfigOption(configId, value);
        if (updated && Array.isArray(updated.configOptions)) session.configOptions = updated.configOptions;
      } catch {
        // 这一项写不进去：停在 CLI 自己的默认，别连累其余几项。
      }
    }
  }

  async function applyPreferredModel(session, handle) {
    const preferred = preferredModel(session.agentId);
    if (!preferred) return;
    const options = Array.isArray(session.configOptions) ? session.configOptions : [];
    const option = options.find((item) => item && item.id === preferred.configId);
    const values = option && Array.isArray(option.options) ? option.options : [];
    if (!option || !values.some((item) => item && String(item.value) === preferred.value)) return;
    if (String(option.currentValue) === preferred.value) return;
    try {
      const updated = await handle.setConfigOption(preferred.configId, preferred.value);
      // 回包带着新的一整份配置项：直接用它，手机上那次目录请求就能看见已选中。
      if (updated && Array.isArray(updated.configOptions)) session.configOptions = updated.configOptions;
      log(`cli ${session.id}: 套上了上次选的模型（${preferred.value}）`);
    } catch {
      // 设不动就维持 CLI 的默认：这不是失败，界面上照旧能选。
    }
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

  /**
   * GET cli/agents：这台电脑上**装了、现在能聊**的 CLI。
   *
   * 清单来自官方 ACP 注册表（见 `cli/registry.js`），拉不到就退回内置的四家。建会话时按同一
   * 份清单回头查，所以「列出来的」与「点得下去的」永远是同一批。
   *
   * 两条口径：
   *
   *   1. **注册表补进来的那些要求本机真的装了**（`isInstalled`）。注册表是「npx 能拉哪些」，
   *      不是「这台电脑上有哪些」；照单全列，手机上就是一屏从没装过、图标还认不出来的
   *      条目 —— 用户会以为是我们编的（2026-11-04 用户报的就是这个）。内置那四条不受此限：
   *      它们是本仓维护的那一档，桥包由 npx 按需拉。
   *   2. **图标跟着走**：每家一枚官方 SVG（`cli/icons.js` 本地缓存），认不出的那几家退成
   *      首字母方块 —— 由 App 兜，插件这边只给能给的。
   */
  async function handleAgents(_ctx, _req, res) {
    const listed = await listAgents();
    const builtin = new Set(AGENTS.map((agent) => agent.id));
    const installed = installedPackages();
    const kept = listed.filter((agent) => builtin.has(agent.id) || isInstalled(agent, installed));
    const icons = await loadIcons(listed, kept.map((agent) => agent.id)).catch(() => ({}));
    const agents = kept.map((agent) => {
      const spec = resolveAgent(agent);
      return {
        id: agent.id,
        label: agent.label,
        available: spec.ok,
        ...(spec.ok ? {} : { reason: spec.reason }),
        ...(agent.description ? { description: agent.description } : {}),
        ...(icons[agent.id] ? { icon: icons[agent.id] } : {}),
      };
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

    const agent = (await listAgents()).find((item) => item && item.id === text(body.agent)) || null;
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
      /** 用量账（上下文 / token / 耗时），见 `cli/usage.js`。 */
      usage: createUsage(),
    };
    sessions.set(id, session);
    // 新行要立刻出现在侧栏上：不然手机得等下一拍兜底轮询（推送活着时是 3 分钟）。
    mobile.bumpList();

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
      else if (configId) {
        const updated = await session.handle.setConfigOption(configId, body.value);
        if (updated && Array.isArray(updated.configOptions)) session.configOptions = updated.configOptions;
        // 选过的模型要记住：下一次在这个 CLI 上开新会话时自动套上（见 applyPreferredModel）。
        // 只记模型那一项 —— 思考档 / 权限模式跟着模型走，单独记会把两边记岔。
        const option = (session.configOptions || []).find((item) => item && item.id === configId);
        if (option && option.category === 'model') rememberModel(session.agentId, configId, body.value);
        // 每一项都记：这是「下次开局自动套上」的唯一来源（见 `cli/config-prefs.js`）。
        if (option) setValue(session.agentId, configId, text(body.value));
      } else throw fail('BAD_REQUEST', '需要 configId 或 modeId');
    } catch (error) {
      if (error && error.code && STATUS_BY_CODE[error.code]) throw error;
      throw fail('SPAWN_FAILED', error && error.message ? error.message : '改不了这一项');
    }
    sendJson(res, 200, { ok: true, session: detailOf(session) });
  }

  /**
   * GET /cli/prefs?agent=：一个 CLI 的配置全貌（配置页读它）。
   *
   * 配置页在**没有开会话**的时候就要能画：所以这里回的是「上次记下的选项表 + 记着的值」，
   * 一个进程都不用起。`live` 说的是这份表是从正在跑的那条会话读的（更新），还是缓存（CLI 那之后
   * 可能升级过）。
   */
  function handlePrefs(_ctx, req, res) {
    const agentId = text(query(req).get('agent'));
    if (!agentId) throw fail('BAD_REQUEST', '需要 agent');
    const recorded = prefsOf(agentId);
    // 正开着这个 CLI 的会话：拿它手上的选项表，比缓存新。
    let options = recorded.options;
    let live = false;
    for (const session of sessions.values()) {
      if (session.agentId !== agentId) continue;
      if (session.status === 'starting') continue;
      const described = describe(session.configOptions);
      if (described.length === 0) continue;
      options = described;
      live = true;
      break;
    }
    sendJson(res, 200, {
      ok: true,
      agent: agentId,
      options,
      values: recorded.values,
      live,
    });
  }

  /**
   * 读写同一条 `/cli/prefs`（与过程播报那条同一个做法）：GET 读，POST 写。
   */
  async function handlePrefsRoute(ctx, req, res) {
    if (req && String(req.method || 'GET').toUpperCase() === 'POST') return handleSetPref(ctx, req, res);
    return handlePrefs(ctx, req, res);
  }

  /**
   * POST /cli/prefs { agent, configId, value }：单独改一项默认配置。
   *
   * 与 `cli/config` 的区别：那条**改的是一条正在跑的会话**（顺带记下来），这条只改「以后新开的
   * 那几条」。配置页在没有会话时用它，所以它也不启动任何进程。
   *
   * `value` 空 = 撤掉这一项，回到 CLI 自己的默认。
   */
  async function handleSetPref(_ctx, req, res) {
    const body = await bodyJson(req);
    const agentId = text(body.agent);
    const configId = text(body.configId);
    if (!agentId || !configId) throw fail('BAD_REQUEST', '需要 agent 与 configId');
    setValue(agentId, configId, text(body.value));
    sendJson(res, 200, { ok: true, agent: agentId, values: prefsOf(agentId).values });
  }

  /** POST cli/close { sessionId }：主动收掉一个会话（用户点「结束」）。 */
  async function handleClose(_ctx, req, res) {
    const body = await bodyJson(req);
    const id = text(body.sessionId);
    if (!id) throw fail('BAD_REQUEST', '需要 sessionId');
    if (forget(id)) mobile.bumpList();
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
    handlePrefs: wrap(handlePrefsRoute),
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
  pendingPrefsOf,
  MAX_SESSIONS,
};

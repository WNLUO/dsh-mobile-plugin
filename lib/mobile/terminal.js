'use strict';

/**
 * 移动端远程终端：`/api/mobile/v1/terminal/*` 的 handler 与 WebSocket 流。
 *
 * 手机侧的新对话页（`app/src/components/TerminalScreen.tsx`）要在这台电脑的某个项目目录里
 * 起一个本机已安装的 CLI（Codex / Claude Code 之类），并把它的 TUI 原样呈现在手机上。
 * 那条链的两端就是这里与 App 里那个 xterm 页面：宿主起伪终端、把字节搬进搬出，App 只画。
 *
 * 与 Git 那组（`mobile/git.js`）同一条边界，但**边界本身换了一档**：Git 只收固定动词，
 * 命令一个字都不透传；终端天然要透传键盘，等于把 shell 交出去。所以把它收在白名单上 ——
 *
 *   1. **可执行文件只能是 `AGENTS` 里那几个名字**，调用方给的是 id，不是命令、不是参数；
 *   2. **工作目录只能来自这台设备已注册的工作区**（按 `workspaceId` 复核，不接受任意路径）；
 *   3. **没有「执行任意命令」这条路由**，也没有可以拼进 shell 的参数。
 *
 * 就这样，能跑的东西仍然是「用户自己装的那几个 CLI，在他自己的项目里」。手机能敲进去的
 * 那些字属于 CLI 自身的交互，不是这条 API 给的命令口子。
 *
 * 伪终端用系统自带的 `python3` 开（`pty.fork`）：插件不引 node-pty（原生模块，装的时候
 * 要编译，跨平台出问题的概率远高于它带来的收益）。**不能用 `script`**：BSD 的 `script`
 * 打开伪终端时要对它的 stdin 做 `tcgetattr`，而宿主进程的 stdin 是 socketpair，它会直接
 * `Operation not supported on socket` 退出（宿主是 GUI 起的，压根没有终端）。
 *
 * 代价是**不能改窗口大小** —— 尺寸只在 fork 那一刻设一次，xterm 报上来的 resize 一律忽略。
 * 所以页面上按起进程时定下的列数排版、靠调字号适配屏幕，CLI 的 TUI 布局才是稳的。
 *
 * 会话托管在宿主进程里：手机锁屏、切后台、换 Wi-Fi 都不该把 CLI 掐掉，重连时把最近
 * 256KB 输出重放一遍。进程退出后会话留在表里一小会儿（页面要能读到退出码），
 * 随后随宿主启动时的清理一起被扫掉。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');

const { readJsonBody, sendJson } = require('../shared/http-util');
const { unwrap } = require('./envelope.js');

/** 错误码 → HTTP 状态；前端只认 code，message 只用于排障与兜底文案。 */
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

/**
 * 认得的 CLI（白名单）。
 *
 * `bin` 是 PATH 上的可执行名；`label` 只在界面上用，认不出来的机器上不显示。这份表是这条
 * API 能起什么进程的**全部**依据 —— 往里加一项就是扩一次能力面，别在别处开第二份。
 */
const AGENTS = [
  { id: 'codex', label: 'Codex CLI', bin: 'codex' },
  { id: 'claude', label: 'Claude Code', bin: 'claude' },
  { id: 'gemini', label: 'Gemini CLI', bin: 'gemini' },
  { id: 'opencode', label: 'OpenCode', bin: 'opencode' },
  { id: 'cursor-agent', label: 'Cursor Agent', bin: 'cursor-agent' },
  { id: 'aider', label: 'Aider', bin: 'aider' },
];

/** 同时在跑的会话上限：每一条都挂着一个真进程，手机上点多了不该把宿主的 fd 吃光。 */
const MAX_SESSIONS = 6;

/** 每个会话保留的重放缓冲（超出丢最旧的）。 */
const MAX_BUFFER_BYTES = 256 * 1024;

/** 帧首字节：数据与控件的区分。 */
const FRAME_DATA = 0;
const FRAME_CONTROL = 1;

/** 默认终端尺寸；App 页面按同一组数字排版（见文件头「不能改窗口大小」）。 */
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;

class TerminalRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TerminalRequestError';
    this.code = code;
  }
}

function fail(code, message) {
  return new TerminalRequestError(code, message);
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

/**
 * 沿 PATH 找可执行文件。
 *
 * 不 spawn 探测（`--version` 之类）：那是拿「装没装」去换一次进程启动，而这个判断只要
 * 文件在不在。Windows 的 PATH 上落的是 `.cmd` / `.exe`，按 PATHEXT 挨个试。
 */
function findExecutable(bin, env = process.env) {
  const rawPath = env.PATH || env.Path || '';
  const exts = process.platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of rawPath.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, bin + ext);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        if (process.platform !== 'win32') fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        // 这一档没有，接着找。
      }
    }
  }
  return null;
}

/**
 * 开伪终端的那一小段 Python（`pty.fork` + 双向搬运）。
 *
 * 为什么借 Python 而不是自己写：Node 没有开 pty 的 API，`script` 又要一个真终端（见文件头），
 * 而 `pty.fork` 是最正统的那条路。这段代码只在子进程里跑，取的是「一个能开 pty 的现成工具」，
 * 不引 brew / pip 的任何包。
 *
 * 干的事：fork 出 pty → 孩子设窗口尺寸后 `execvp` 目标 → 父进程在 master 与自己的
 * stdin/stdout 之间来回搬字节 → 退出码原样交回去。stdin 关掉之后只搬输出（CLI 可能还要
 * 收尾几行），不跟着退出。
 */
const PY_PTY_SCRIPT = `
import os, pty, select, struct, sys, fcntl, termios

def main():
    a = sys.argv[1:]
    cols = int(a[0]); rows = int(a[1]); argv = a[2:]
    pid, master = pty.fork()
    if pid == 0:
        try:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        except OSError:
            pass
        try:
            os.execvp(argv[0], argv)
        except OSError:
            os._exit(127)
        os._exit(127)
    fin = sys.stdin.fileno()
    fout = sys.stdout.fileno()
    watching = [master, fin]
    while True:
        try:
            ready, _, _ = select.select(watching, [], [])
        except InterruptedError:
            continue
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b''
            if data:
                try:
                    os.write(fout, data)
                except OSError:
                    pass
            else:
                break
        if fin in ready:
            try:
                data = os.read(fin, 65536)
            except OSError:
                data = b''
            if data:
                try:
                    os.write(master, data)
                except OSError:
                    pass
            else:
                watching = [master]
    _, status = os.waitpid(pid, 0)
    try:
        code = os.waitstatus_to_exitcode(status)
    except ValueError:
        code = 1
    sys.exit(0 if code == 0 else 1)

main()
`;

/**
 * 起一个带伪终端的子进程。
 *
 * 真正的 CLI 是 Python 那个进程的**孩子**（坐在 pty 从端上），所以我们这边的 stdin/stdout
 * 是普通管道 —— 只要 Python 在，就不需要宿主自己有终端。
 *
 * Windows 没有 `pty` 模块、也没有同名解释器，所以这一档明确回 UNSUPPORTED。宁可说
 * 「这台电脑暂时不支持」，也好过起一个没有终端语义的管道让 CLI 退化成一堆乱码。
 */
function spawnPty({ bin, cwd, cols, rows, env }) {
  if (process.platform === 'win32') {
    throw fail('UNSUPPORTED', 'Windows 上暂时还不支持远程终端');
  }
  const python = findExecutable('python3');
  if (!python) {
    throw fail('UNSUPPORTED', '这台电脑上没有 python3：远程终端要靠它开伪终端');
  }
  const child = spawn(python, ['-c', PY_PTY_SCRIPT, String(cols), String(rows), bin], {
    cwd,
    env: {
      ...env,
      // CLI 读得到这两个就不用去问 ioctl；有的 TUI 只认它们。
      COLUMNS: String(cols),
      LINES: String(rows),
      TERM: env.TERM || 'xterm-256color',
      // 让它别为了「交互式登录」去读用户 shell 的 profile：那会把提示符和欢迎语混进 TUI。
      SHELL: '/bin/sh',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return child;
}

/** 会话表与它的所有出口。一个宿主进程一份（装配层建、装配层关）。 */
function createTerminalService({ authorized, onLog } = {}) {
  /** sessionId → 会话。 */
  const sessions = new Map();
  let seq = 0;
  let closed = false;

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 1024 * 1024,
  });

  const log = (message) => { try { onLog?.(message); } catch { /* 日志失败不该影响搬运 */ } };

  function notify(session, frame) {
    for (const ws of session.sockets) {
      if (ws.readyState !== ws.OPEN) continue;
      try { ws.send(frame, { binary: true }); } catch { /* 已经断了 */ }
    }
  }

  function controlFrame(payload) {
    return Buffer.concat([Buffer.from([FRAME_CONTROL]), Buffer.from(JSON.stringify(payload), 'utf8')]);
  }

  /** 输出按字节攒，超预算就把最旧的整段丢掉（重放窗口本来就是「最近这些」）。 */
  function appendOutput(session, chunk) {
    session.buffer.push(chunk);
    session.buffered += chunk.length;
    while (session.buffered > MAX_BUFFER_BYTES && session.buffer.length > 1) {
      session.buffered -= session.buffer.shift().length;
    }
  }

  function forget(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    for (const ws of session.sockets) {
      try { ws.close(); } catch { /* 已经关了 */ }
    }
    session.sockets.clear();
    try { session.child.kill('SIGHUP'); } catch { /* 可能已经退出 */ }
  }

  /** GET terminal/agents：这台电脑上装了哪几个。 */
  function handleAgents(_ctx, _req, res) {
    const agents = AGENTS.map((agent) => {
      const binPath = findExecutable(agent.bin);
      return { id: agent.id, label: agent.label, available: Boolean(binPath) };
    });
    sendJson(res, 200, { ok: true, agents });
  }

  /**
   * POST terminal/session { workspaceId, agentId, cols?, rows? }
   *
   * 工作目录从工作区清单里取：手机只给 `workspaceId`，路径由宿主自己填。于是「在哪个目录
   * 起进程」这件事没有一条能让调用方指定任意路径的路，与 Git 那一组同一个口径。
   */
  async function handleCreate(ctx, req, res) {
    const body = await bodyJson(req);
    if (closed) throw fail('UNSUPPORTED', '宿主正在关闭，稍后再试');

    const workspaceId = text(body.workspaceId);
    if (!workspaceId) throw fail('BAD_REQUEST', '需要 workspaceId');

    const agentId = text(body.agentId);
    const agent = AGENTS.find((entry) => entry.id === agentId);
    if (!agent) throw fail('BAD_REQUEST', '不认识这个 CLI');
    const binPath = findExecutable(agent.bin);
    if (!binPath) throw fail('AGENT_UNAVAILABLE', `这台电脑上没有装 ${agent.label}`);

    const listed = await ctx.apiProxy.workspace.list({ rpcId: 'mobile', method: 'workspace.list', payload: {} });
    const { value, error } = unwrap(listed);
    if (error) throw fail('WORKSPACE_UNAVAILABLE', '取不到工作区清单，稍后再试');
    const items = Array.isArray(value) ? value : (value && Array.isArray(value.items) ? value.items : []);
    const item = items.find((entry) => entry && entry.workspaceId === workspaceId);
    if (!item) throw fail('FORBIDDEN', '这个工作区不在这台机器上');
    const cwd = text(item.path);
    if (!cwd) throw fail('FORBIDDEN', '这个工作区没有对应目录');

    if (sessions.size >= MAX_SESSIONS) {
      throw fail('TOO_MANY_SESSIONS', '同时在跑的终端太多了，先关掉几个');
    }

    const cols = Number.isInteger(body.cols) && body.cols > 0 && body.cols <= 400 ? body.cols : DEFAULT_COLS;
    const rows = Number.isInteger(body.rows) && body.rows > 0 && body.rows <= 200 ? body.rows : DEFAULT_ROWS;

    const id = `term-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;
    let child;
    try {
      child = spawnPty({ bin: binPath, cwd, cols, rows, env: process.env });
    } catch (spawnError) {
      if (spawnError && typeof spawnError.code === 'string' && STATUS_BY_CODE[spawnError.code]) throw spawnError;
      throw fail('SPAWN_FAILED', '起不来这个 CLI');
    }

    const session = {
      id,
      workspaceId,
      agentId: agent.id,
      label: agent.label,
      cwd,
      cols,
      rows,
      child,
      sockets: new Set(),
      buffer: [],
      buffered: 0,
      exitCode: null,
      startedAt: Date.now(),
    };
    sessions.set(id, session);

    const pump = (chunk) => {
      if (!chunk || chunk.length === 0) return;
      appendOutput(session, chunk);
      notify(session, Buffer.concat([Buffer.from([FRAME_DATA]), chunk]));
    };
    child.stdout.on('data', pump);
    child.stderr.on('data', pump);
    child.on('error', (error) => {
      log(`terminal ${id}: ${error && error.message}`);
      session.exitCode = session.exitCode === null ? 1 : session.exitCode;
      notify(session, controlFrame({ t: 'exit', code: session.exitCode }));
    });
    child.on('exit', (code) => {
      session.exitCode = typeof code === 'number' ? code : 0;
      // 退出后台留 30 秒：页面要能读到退出码、把最后一屏留住，之后连表一起清掉。
      setTimeout(() => { sessions.delete(id); }, 30000).unref?.();
      notify(session, controlFrame({ t: 'exit', code: session.exitCode }));
    });

    sendJson(res, 200, {
      ok: true,
      session: { id, workspaceId, agentId: agent.id, label: agent.label, cwd, cols, rows },
    });
  }

  /** POST terminal/close { sessionId }：主动收掉一个会话（页面返回、用户点「结束」）。 */
  async function handleClose(_ctx, req, res) {
    const body = await bodyJson(req);
    const id = text(body.sessionId);
    if (!id) throw fail('BAD_REQUEST', '需要 sessionId');
    forget(id);
    sendJson(res, 200, { ok: true });
  }

  /** GET terminal/sessions：宿主上还活着的会话（页面重进时用来接回上一条）。 */
  function handleSessions(_ctx, _req, res) {
    const list = [...sessions.values()].map((session) => ({
      id: session.id,
      workspaceId: session.workspaceId,
      agentId: session.agentId,
      label: session.label,
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
      running: session.exitCode === null,
      startedAt: session.startedAt,
    }));
    sendJson(res, 200, { ok: true, sessions: list });
  }

  /**
   * WebSocket 升级：`?session=<id>&token=<设备凭据>`。
   *
   * 凭据走查询串而不是头，只有一个原因：WebView 里的 `WebSocket` 构造函数带不了自定义头，
   * 而这一页正是跑在 WebView 里的。中转与局域网代理都是纯字节/升级转发，不加查询串白名单，
   * 所以这条与普通请求走同一条路。
   *
   * 和预览管道一样，拒绝要发生在 `handleUpgrade` 之前 —— 那时 socket 还是普通 HTTP。
   */
  function handleUpgrade(req, socket, head) {
    if (closed) return refuseUpgrade(socket, 503, 'Service Unavailable', '终端服务已关闭');

    const params = query(req);
    const id = text(params.get('session'));
    if (!id) return refuseUpgrade(socket, 400, 'Bad Request', '缺少 session 参数');
    // `cred` 是现在那一版 App 用的名字；`token` 留给还没升级的客户端。
    const token = text(params.get('cred')) || text(params.get('token'));

    let allowed = false;
    try {
      // 现在这一版 App 把凭据放在**请求头**里（RN 的 `WebSocket` 支持第三个参数，连接建在
      // RN 侧、不在 WebView 里，见 App 的 `TerminalScreen`），所以先按真实请求判一次 ——
      // 走中转时「转给哪台电脑」也靠这些头。查询串那一支留给没有头可用的情况（老客户端）：
      // 折成一次普通的鉴权判定，不动 `auth.js` 的口径。
      allowed = Boolean(authorized && (authorized(req) || (token && authorized({
        headers: { 'x-dsh-device-credential': token, authorization: `Bearer ${token}` },
      }))));
    } catch {
      allowed = false;
    }
    if (!allowed) {
      log(`terminal ${id}: 凭据无效，拒绝升级`);
      return refuseUpgrade(socket, 401, 'Unauthorized', '移动端凭据无效');
    }

    const session = sessions.get(id);
    if (!session) {
      log(`terminal ${id}: 会话不在表里，拒绝升级`);
      return refuseUpgrade(socket, 404, 'Not Found', '这条终端已经不在了');
    }

    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, session));
  }

  function attach(ws, session) {
    session.sockets.add(ws);
    log(`terminal ${session.id}: 手机接上了（第 ${session.sockets.size} 条连接）`);

    // 先补一帧「现在长什么样」，再把攒下来的输出整段重放：断线重连回来看到的仍是那一屏。
    ws.send(controlFrame({
      t: 'ready',
      cols: session.cols,
      rows: session.rows,
      label: session.label,
      cwd: session.cwd,
      running: session.exitCode === null,
    }), { binary: true });
    if (session.buffered > 0) {
      const replay = Buffer.concat(session.buffer);
      try { ws.send(Buffer.concat([Buffer.from([FRAME_DATA]), replay]), { binary: true }); } catch { /* 已断 */ }
    }
    if (session.exitCode !== null) {
      try { ws.send(controlFrame({ t: 'exit', code: session.exitCode }), { binary: true }); } catch { /* 已断 */ }
    }

    ws.on('message', (raw, isBinary) => {
      let frame;
      if (Buffer.isBuffer(raw)) frame = raw;
      else if (Array.isArray(raw)) frame = Buffer.concat(raw);
      else frame = Buffer.from(raw);
      if (frame.length === 0) return;
      const kind = frame[0];
      const payload = frame.subarray(1);
      if (kind === FRAME_DATA) {
        if (session.exitCode !== null) return;
        try { session.child.stdin.write(payload); } catch { /* 进程没了 */ }
        return;
      }
      if (kind === FRAME_CONTROL) {
        let message = null;
        try { message = JSON.parse(payload.toString('utf8')); } catch { message = null; }
        // 目前只有一条控件，且是**不做**：script 起的伪终端改不了窗口大小，见文件头。
        if (message && message.t === 'resize') return;
        return;
      }
      // 没打标签的帧（早先的客户端、或被别的东西写进来的）：按原始输入处理，宁可多打字
      // 也别让一次键盘输入石沉大海。
      if (session.exitCode === null) {
        try { session.child.stdin.write(frame); } catch { /* 进程没了 */ }
      }
    });

    const detach = () => { session.sockets.delete(ws); };
    ws.on('close', detach);
    ws.on('error', detach);
  }

  /** 插件重载 / 宿主退出：会话一条都不留（它们的父进程这时也没了）。 */
  function close() {
    if (closed) return;
    closed = true;
    for (const id of [...sessions.keys()]) forget(id);
    try { wss.close(); } catch { /* 已经关了 */ }
  }

  return {
    handleAgents: wrap(handleAgents),
    handleCreate: wrap(handleCreate),
    handleClose: wrap(handleClose),
    handleSessions: wrap(handleSessions),
    handleUpgrade,
    close,
    // 守卫用：会话表只读快照（测试里核对「close 之后真的空了」）。
    debugSessions: () => [...sessions.values()],
  };
}

/** 与 Git 那组同一个形状：错误码是契约，HTTP 状态只是顺带。 */
function wrap(fn) {
  return async (ctx, req, res) => {
    try {
      await fn(ctx, req, res);
    } catch (error) {
      const code = error && typeof error.code === 'string' ? error.code : 'SPAWN_FAILED';
      const status = STATUS_BY_CODE[code] || 500;
      const message = error && typeof error.message === 'string' && error.message
        ? error.message
        : '终端操作失败';
      sendJson(res, status, { ok: false, error: { code, message } });
    }
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
 * 清理必须挂在 `ctx.effect` 上而不是模块级：插件热替换之后旧实例没人能关，伪终端进程会
 * 挂在那儿直到宿主退出。
 */
function mountTerminal(ctx, { authorized, name } = {}) {
  const service = createTerminalService({
    authorized,
    onLog: (message) => ctx.logger?.info?.(`${name}: %s`, message),
  })
  ctx.effect(() => () => service.close(), `${name}: terminal sessions`)
  return service
}

module.exports = {
  mountTerminal,
  createTerminalService,
  findExecutable,
  AGENTS,
  DEFAULT_COLS,
  DEFAULT_ROWS,
};

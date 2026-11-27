// 2026-11-27：外部把隧道重建到新端口时，先用 endpoints 的落点刷新本次比对值，第一次 connect 就认下新端口。
// 2026-11-26：体检发现旧隧道落点端口没人监听就判失效（只改本机状态，不删不建云端隧道），交接线层清地址让兜底顶上。
// 2026-11-25：CLI status 的 connected 也认作在跑，兼容新版客户端字段，别把活线路抖成掉线重连。
// 2026-11-25：端口失配带上可识别的 reason，让接线层清掉旧地址（配对码不再带失效线路）。
// 2026-11-25：running 认守护进程而非早退出的启动进程；连上后可由接线层定时体检判活。
// 2026-11-25：复用隧道前比对 local_port，旧端口隧道不再静默复用。
// ZeroNews 客户端运行器：ensure→login→start→建隧道→读域名，进程生命周期与状态。
'use strict';

/**
 * 把官方客户端从「没有」带到「有一个指向本机端口、拿到公网域名的隧道」。顺序照厂商现行流程：
 *   ① ensureZeroNews 拿到可执行文件（用户不装）；
 *   ② 认证：优先用面板里粘贴的 AuthToken 跑 `authtoken`；没给 token 时读 `status --json` 的三个字段
 *      —— login（已登录）/ login_pending（正在等确认）/ login_error（配额满、被拒、过期等明确失败）。
 *      pending 就继续轮询让它兑换授权；明确失败立刻按原因报错；两者都没有说明还没发起登录，此时
 *      **绝不静默拉起 login**（用户看不到确认页只会干等），而是回一个「待登录」状态，交给面板走
 *      会打开浏览器的接入流程；
 *   ③ `start` 起本地客户端 + HTTP API（幂等，已登录已运行就跳过）；
 *   ④ 本地 API 建一条 HTTPS 隧道指向本机端口（已有则复用，免费档一条额度，绝不重复建）；
 *   ⑤ 读 endpoints 拿公网域名 → 交调用方写进线路清单。
 *
 * 所有进程 / 网络 / 时钟都可注入，守卫用假体走完整条链，不连真网、不起真进程。
 */

const { spawn, execFile } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const { loginErrorHint, friendlyAuthError } = require('./login-error.cjs');

const DEFAULT_BASE = 'http://127.0.0.1:37271';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 浏览器确认最长等 5 分钟，别一直挂在「登录中」。
const START_TIMEOUT_MS = 40_000;
// 轮询也按次数封顶：光看 wall-clock 的话，时钟源被替换或定时器被加速时会无限空转。
const LOGIN_POLL_MAX = 300;
const START_POLL_MAX = 40;

function endpointUrl(text) {
  const raw = String(text || '').trim();
  if (!/^https:\/\/[^\s/]+/i.test(raw)) return '';
  try { return new URL(raw).hostname ? raw.replace(/\/+$/, '') : ''; } catch { return ''; }
}

/** 默认的一次性命令执行器：execFile 拿到 stdout/stderr/退出码，不经过 shell。 */
function defaultRun(binary, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(binary, args, { timeout: opts.timeoutMs || 8000, cwd: path.dirname(binary), maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      let code = 0;
      if (err) code = typeof err.code === 'number' ? err.code : 1;
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/**
 * 落点探活：连一下隧道指向的本机端口，连得上才算有人监听。只判「有没有监听」，不认协议——
 * 端口上跑着别的服务也当作还通，不在这里替用户判断那是不是他的服务。
 */
function defaultProbePort(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => { if (!done) { done = true; socket.destroy(); resolve(ok); } };
    socket.setTimeout(1200);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try { socket.connect(port, '127.0.0.1'); } catch { finish(false); }
  });
}

/**
 * 一条隧道条目指向的本机端口：本地 API 常平铺 `local_port`，账号侧那份是
 * `route_rules[].forward_rules[].load_balance_policy.backend_endpoints[].local_port`（见 account.cjs）。
 * 没有 / 读不出就返回 0，按老数据处理，不因此判失配。
 */
function localPortOf(item) {
  const direct = Number(item && item.local_port);
  if (Number.isInteger(direct) && direct > 0) return direct;
  const rules = item && Array.isArray(item.route_rules) ? item.route_rules : [];
  for (const rule of rules) {
    const forwards = rule && Array.isArray(rule.forward_rules) ? rule.forward_rules : [];
    for (const fwd of forwards) {
      const policy = fwd && fwd.load_balance_policy;
      const endpoints = policy && Array.isArray(policy.backend_endpoints) ? policy.backend_endpoints : [];
      for (const ep of endpoints) {
        const port = Number(ep && ep.local_port);
        if (Number.isInteger(port) && port > 0) return port;
      }
    }
  }
  return 0;
}

/** 从 endpoints 响应里取第一条 active 的 HTTPS 隧道：{ url, localPort }，没有就 null。 */
function pickEndpointDetail(payload) {
  const data = payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
  const items = Array.isArray(data) ? data
    : (data && Array.isArray(data.items)) ? data.items
      : (data && Array.isArray(data.endpoints)) ? data.endpoints : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const status = String(item.status || '').toLowerCase();
    if (status && status !== 'active') continue;
    const type = String(item.type || '').toUpperCase();
    if (type && type !== 'HTTPS') continue;
    const domain = typeof item.domain === 'string' && item.domain ? item.domain
      : typeof item.public_url === 'string' ? item.public_url : '';
    const url = endpointUrl(domain.includes('://') ? domain : `https://${domain}`);
    if (url) return { url, localPort: localPortOf(item) };
  }
  return null;
}

/**
 * 从 endpoints 响应里取第一条 active 的 HTTPS 域名（兼容 data.items / 裸数组 / endpoints）。
 * 传了 expectedPort 时，条目明确指向别的本机端口就不算可用：那是旧端口的隧道，复用它新端口
 * 永远连不上。字段缺失按老数据复用，不能因为旧接口没这个字段就误报失配。
 */
function pickEndpoint(payload, expectedPort) {
  const found = pickEndpointDetail(payload);
  if (!found) return '';
  if (Number.isInteger(expectedPort) && expectedPort > 0 && found.localPort > 0 && found.localPort !== expectedPort) return '';
  return found.url;
}

/**
 * 把 `zeronews status --json` 的返回归一成我们真正要判断的四件事：
 *   · login          —— 已完成登录（官方唯一的「绑好了」判据）；
 *   · login_pending  —— 已经发起登录、正在等浏览器/控制台确认（此时不能当失败，也不能重新拉登录）；
 *   · login_error    —— 明确的失败原因（denied / expired / quota_exceeded / failed）；
 *   · running        —— 本地客户端是否已在跑。
 * 只看 login 会漏掉「等待中」与「失败原因」，表现成一直空转到超时。
 */
function parseStatusPayload(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const truthy = (value) => value === true || value === 'true';
  return {
    login: truthy(obj.login),
    loginPending: truthy(obj.login_pending),
    loginError: typeof obj.login_error === 'string' ? obj.login_error.trim() : '',
    running: truthy(obj.running) || truthy(obj.connected),
    configured: truthy(obj.configured),
    clientEnabled: obj.client_enabled !== false,
  };
}

/** 确定性错误：重试也没用，标成 terminal，让接线层别再无限退避重连。reason 让接线层认出「端口失配」这种要清旧地址的场景。 */
function terminalError(message, reason) {
  const error = new Error(message);
  error.code = 'terminal';
  error.reason = reason || '';
  return error;
}

/**
 * @param {object} options
 * @param {() => Promise<{ok:boolean,path:string,code?:string}>} options.ensure 取二进制（provision）
 * @param {() => number} options.portOf 本机要映射的 LAN 端口
 * @param {object} [options.spawnImpl] spawn 注入
 * @param {(url:string, init:object)=>Promise<any>} [options.fetchImpl] 本地 API fetch 注入
 * @param {(bin:string,args:string[],opts:object)=>Promise<{code:number,stdout:string,stderr:string}>} [options.runImpl] 一次性命令注入
 * @param {(port:number)=>Promise<boolean>} [options.probePort] 隧道落点端口有没有人监听（体检用，测试注入）
 * @param {string} [options.base] 本地 API 根
 */
function createZeroNewsRunner(options = {}) {
  const ensure = options.ensure;
  const portOf = typeof options.portOf === 'function' ? options.portOf : () => 0;
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn;
  const doFetch = typeof options.fetchImpl === 'function' ? options.fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  const runImpl = typeof options.runImpl === 'function' ? options.runImpl : defaultRun;
  const probePort = typeof options.probePort === 'function' ? options.probePort : defaultProbePort;
  const base = String(options.base || DEFAULT_BASE).replace(/\/+$/, '');
  const sleep = typeof options.sleepImpl === 'function' ? options.sleepImpl : (ms) => new Promise((r) => setTimeout(r, ms));

  // 客户端退出（非我们主动 stop）时的回调：交接线层去安排自动重连，别让线路卡死在错误上。
  const onUnexpectedExit = typeof options.onUnexpectedExit === 'function' ? options.onUnexpectedExit : null;

  let child = null;
  /** 本机已有一个不是我这次拉起的客户端在跑（插件重载 / 自动更新后常见）：复用，不再重复起一个。 */
  let attached = false;
  /** 面板递进来、还没写进客户端配置的 AuthToken；只在本进程内存里停一下，不落盘、不记日志。 */
  let pendingToken = '';
  /** 这台机器的客户端有没有账户身份（token 写成功 / CLI 报已登录都算）。面板据此收起粘贴框。 */
  let configured = false;
  /** 同一次 start 只跑一份：自动重连、点「连接」、watch 触发撞在一起时，别并发拉起两个客户端。 */
  let startPromise = null;
  let binary = '';
  let error = '';
  let errorReason = '';
  let url = '';
  let phase = 'off'; // off | installing | login | starting | connecting | connected | error
  let retryable = true;
  let generation = 0;
  /**
   * 真正的守护进程在不在跑。`start` 命令后台化自己后会退出，它不是客户端句柄；
   * 连上之后的存活只能认 CLI status 报的 running，不能认那个早退出的启动进程。
   */
  let daemonRunning = false;
  let aliveCheckPromise = null;
  // 已有隧道正指向的本机端口（0 = 还没有隧道）。下次启动原样复用它，别把已经在用
  // 的隧道改到新端口 —— 那会判成端口失配，而官方 CLI 的删除参数没公开，重建有风险。
  let tunnelLocalPort = 0;

  function status() {
    return {
      available: Boolean(binary) || phase !== 'off',
      running: Boolean(child) || attached || (phase === 'connected' && daemonRunning),
      phase,
      url: phase === 'connected' ? url : '',
      error,
      // 错误的可识别子类：端口失配时接线层据此清掉状态里那条已经连不上的旧域名。
      errorReason,
      // 这个错还值不值得自动重试：配额满 / 被拒 / token 冲突这类确定性错误重试也没用，
      // 交给接线层别再无限退避重连，直接把原因留给用户处理。
      retryable,
      // 只反映这一进程里见过的身份；落盘的那份由接线层并进来（见 wiring.cjs 的 statusOf）。
      configured,
      // 已有隧道指向的本机端口：接线层据此沿用同一端口，避免把在用的隧道判成失配。
      tunnelLocalPort,
    };
  }

  /** 一次性跑一条命令，汇总 stdout/stderr/退出码（login 起浏览器那条用 spawn 不 wait）。 */
  async function run(args) {
    const result = await runImpl(binary, args, { timeoutMs: 8000 });
    if (result && result.code !== 0) {
      const msg = String(result.stderr || result.stdout || '').trim();
      throw new Error(msg || `zeronews ${args[0]} 退出码 ${result.code}`);
    }
    return result;
  }

  /**
   * 登录状态只信 CLI `status --json`，不信本地 HTTP API：
   * 实测同一台已登录机器，CLI 报 `login:true`，而 `/api/v1/status` 报 `login:false`，两者不一致。
   * 厂商 AI 指引的完成判据也是「`status --json` 为 `login:true` 且 running」。
   */
  async function cliStatus() {
    let result;
    try {
      // pending 期间 status 会去控制面轮询兑换授权，可能比平时慢；给足时间，别把它当成没响应。
      result = await runImpl(binary, ['status', '--json'], { timeoutMs: 15_000 });
    } catch { return null; }
    const text = String((result && result.stdout) || '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const parsed = parseStatusPayload(JSON.parse(text.slice(start, end + 1)));
        parsed.exitCode = result && typeof result.code === 'number' ? result.code : 0;
        return parsed;
      } catch { /* 落到下面按报错原文兜底 */ }
    }
    // 有些失败只把原因打在 stderr（比如 `auth client failed: client count limit ...`），没有 JSON。
    // 认得出就把原文挂到 loginError，走上层统一翻译，别当成「没登录」去空等。
    const raw = `${(result && result.stderr) || ''}\n${(result && result.stdout) || ''}`.trim();
    if (raw && friendlyAuthError(raw)) {
      return { login: false, loginPending: false, loginError: raw, running: false, configured: false, clientEnabled: true, exitCode: result && result.code };
    }
    return null;
  }

  async function api(pathname, init) {
    if (!doFetch) return null;
    let res;
    try {
      res = await doFetch(`${base}${pathname}`, { headers: { accept: 'application/json' }, ...(init || {}) });
    } catch {
      // 客户端刚起、端口还没监听时连不上是常态：返回 null 让上层继续轮询，不要当场抛。
      return null;
    }
    if (!res || res.ok !== true) return null;
    try { return await res.json(); } catch { return null; }
  }

  /** 轮询 status.login，等浏览器确认完成（或超时 / 出现明确失败原因）。 */
  async function waitLogin(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (let i = 0; i < LOGIN_POLL_MAX && Date.now() < deadline; i += 1) {
      const s = await cliStatus();
      if (s && (s.login === true || s.login === 'true')) return true;
      // 明确失败（配额 / 拒绝 / 过期）就别再空等，交给上面按原因报错。
      if (s && s.loginError) return false;
      await sleep(1000);
    }
    return false;
  }

  /** 轮询 endpoints 拿到隧道域名，最多等到 START_TIMEOUT_MS。 */
  async function waitEndpoint(timeoutMs, port) {
    const deadline = Date.now() + timeoutMs;
    for (let i = 0; i < START_POLL_MAX && Date.now() < deadline; i += 1) {
      const payload = await api('/api/v1/endpoints');
      const found = pickEndpoint(payload, port);
      if (found) return found;
      await sleep(1500);
    }
    return '';
  }

  /**
   * 确保有一条指向本机端口的 HTTPS 隧道：已有一条就复用（免费档只有一条额度）。
   * 建隧道走 CLI `add https --port N --json`（官方稳定接口；本地 /api/v1/tunnels 的字段口径会变，
   * 直接用裸 API 会因未知字段被拒）。`add` 的 JSON 里带 public_url 就直接用，没有就回读 endpoints。
   */
  async function ensureTunnel(port) {
    const found = pickEndpointDetail(await api('/api/v1/endpoints'));
    const requested = Number.isInteger(port) && port > 0 ? port : 0;
    if (found) {
      // portOf() 优先返回上一轮记下的隧道端口；本次传入值与缓存相同就说明它来自缓存。
      // 用户在外部删了旧隧道、把新隧道指向另一个落点时，endpoints 才是当前值：先按它刷新
      // current 再比对，第一次 connect 就认下新端口，不必等第二次读缓存才成功。
      const fromCache = requested > 0 && requested === tunnelLocalPort;
      let current = requested;
      if (fromCache && Number.isInteger(found.localPort) && found.localPort > 0) current = found.localPort;
      tunnelLocalPort = Number.isInteger(found.localPort) && found.localPort > 0 ? found.localPort : 0;
      // 只有字段明确在、且指向另一个端口才算失配：老接口的 endpoints 没有 local_port，
      // 那种照旧复用。失配不自动删云端隧道（仓里没有删除入口），标红并让用户自己删旧的。
      // 走到这里的 found.localPort 是旧隧道落点、current 是插件当前端口，文案按这个顺序标注。
      if (current > 0 && found.localPort > 0 && found.localPort !== current) {
        throw terminalError(`旧隧道指向旧端口，请删除后重试（旧端口 ${found.localPort}，当前本机端口 ${current}）`, 'port-mismatch');
      }
      return found.url;
    }
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error('本机没有可用的映射端口，没法建 ZeroNews 隧道');
    }
    let added = '';
    let addError = '';
    try {
      const result = await runImpl(binary, ['add', 'https', `--port=${port}`, '--json'], { timeoutMs: 20000 });
      const text = String((result && result.stdout) || '').trim();
      if (result && result.code !== 0) {
        addError = String(result.stderr || result.stdout || '').trim() || `建隧道退出码 ${result.code}`;
      }
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        const parsed = JSON.parse(text.slice(start, end + 1));
        added = endpointUrl(parsed.public_url || parsed.domain || '');
      }
    } catch (error) {
      addError = error && error.message ? error.message : String(error);
    }
    // 新建成功：记住它落在哪个端口上，下次启动沿用，不再判成「旧隧道指向旧端口」。
    if (added) { tunnelLocalPort = port; return added; }
    const waited = await waitEndpoint(START_TIMEOUT_MS, port);
    if (waited) { tunnelLocalPort = port; return waited; }
    // 免费档只有 1 条 1Mbps 隧道；额度被旧隧道占住、或账号侧拒绝时，原文要透出来，
    // 别让用户只看到「连上了但拿不到地址」这种猜不出原因的提示。
    if (addError) {
      throw new Error(`建隧道失败：${addError}。免费套餐只有 1 条 1Mbps 隧道，额度若已被旧隧道占用，请先在控制台删除或启用旧隧道再试`);
    }
    return '';
  }

  async function runStart() {
    const gen = ++generation;
    error = '';
    errorReason = '';
    url = '';
    retryable = true;
    try {
      phase = 'installing';
      const got = await ensure();
      if (!got || !got.ok) throw new Error(got && got.code === 'unsupported-platform' ? '这台系统不支持自动安装 ZeroNews 客户端' : '下载 ZeroNews 客户端失败，请稍后重试');
      binary = got.path;

      phase = 'login';
      const st = await cliStatus();
      // 先看明确失败：配额满了 / 被拒 / 过期，都属于「别再等、直接告诉用户怎么办」。
      if (st && st.loginError) throw terminalError(loginErrorHint(st.loginError));
      // 客户端被禁用（免费套餐在控制台启用了另一台）：继续 start 只会被拒，直接说清怎么恢复。
      if (st && st.clientEnabled === false) {
        throw terminalError('这台 ZeroNews 客户端已被禁用。请到控制台「关联客户端」启用它（免费套餐同时只能启用一台），再重试。');
      }
      // 有 token 就先写进客户端配置：之后照常起客户端、建隧道，不再拉浏览器。
      // 写完就把内存里那份清掉 —— 失败也一样，避免自动重连拿同一串无效 token 反复试。
      const token = pendingToken;
      pendingToken = '';
      if (token) {
        const applied = await runImpl(binary, ['authtoken', token], { timeoutMs: 15000 });
        const detail = String((applied && (applied.stderr || applied.stdout)) || '').trim();
        // 官方有一条明确的坑：本机已有 config.yml 时 token 会被忽略并保留旧配置（退出码可能仍是 0）。
        // 不认这条就会「以为写成功了」，接着起客户端、建隧道，最后卡在拿不到地址，报错对不上真因。
        if (/already exists|token update ignored|already been set/i.test(detail)) {
          throw terminalError('本机已有 ZeroNews 配置，这个 AuthToken 没有被写入。请先重置本机客户端配置，或在控制台确认设备后再试。');
        }
        // 官方常见原文：`auth client failed: client count limit reached for this plan`
        // ——免费套餐名额已满，第二台认证不上。翻成可选流程，别把英文原文甩给用户。
        const friendly = friendlyAuthError(detail);
        if (friendly) throw terminalError(friendly);
        if (!applied || applied.code !== 0) {
          throw new Error(detail || 'AuthToken 写入失败，请确认从「快速开始」页复制完整');
        }
        configured = true;
      } else if (st && st.login) {
        // 这台机器早就有身份（以前登录过 / 以前粘过 token）：记下来，面板不用再要一次。
        configured = true;
      } else if (st && st.loginPending) {
        // 已经发起登录、正在等确认：不重新拉起 login（会顶掉设备码），只轮询 status 让它兑换授权。
        const loggedIn = await waitLogin(LOGIN_TIMEOUT_MS);
        if (gen !== generation) return status();
        if (!loggedIn) {
          const after = await cliStatus();
          if (after && after.loginError) throw terminalError(loginErrorHint(after.loginError));
          if (after && after.loginPending) throw new Error('还在浏览器里等确认登录；确认完成后点「我已登录，重试」即可继续。');
          throw new Error('还没有完成登录，请先点「开始接入」在浏览器里确认登录。');
        }
        configured = true;
      } else {
        // 本机没身份、也没在等待：绝不能在后台静默拉起 login —— 用户看不到确认页，只会干等到超时。
        // 抛给接线层/面板，让它走「开始接入」那条会打开浏览器确认页的路。
        const need = new Error('这台机器还没登录 ZeroNews，请先点「开始接入」在浏览器里确认登录。');
        need.code = 'needs-login';
        throw need;
      }

      phase = 'starting';
      // 本机已经有一个客户端在跑（插件重载 / 自动更新后没被这次拉起、上一条还活着）：直接复用它，
      // 绝不再 spawn 第二个 —— 免费档只认一台设备，重复拉起会让第二个自己退出，表现成「客户端意外退出」。
      const externalRunning = Boolean(st && st.running);
      // start 常驻：后台拉起，不 wait；已运行时官方命令自身幂等。
      if (!child && !externalRunning) {
        child = spawnImpl(binary, ['start'], { stdio: 'ignore', detached: true, cwd: path.dirname(binary) });
        if (child && typeof child.on === 'function') {
          child.on('error', () => {});
          child.on('exit', () => {
            if (gen !== generation) return;
            child = null;
            // 只在「已经连上之后」退出才算意外；连接过程中的退出交给后面 healthz / 建隧道去判失败，
            // 免得把「start 命令自己后台化后正常退出」误报成崩溃。
            if (phase === 'connected') {
              url = '';
              phase = 'error';
              error = 'ZeroNews 客户端意外退出';
              if (onUnexpectedExit) { try { onUnexpectedExit(error); } catch { /* 回调失败不影响状态 */ } }
            }
          });
          if (typeof child.unref === 'function') child.unref();
        }
      } else if (externalRunning) {
        attached = true;
      }
      phase = 'connecting';
      const healthDeadline = Date.now() + START_TIMEOUT_MS;
      for (let i = 0; i < START_POLL_MAX && Date.now() < healthDeadline; i += 1) {
        if (await api('/healthz')) break;
        await sleep(1000);
      }
      url = await ensureTunnel(portOf());
      if (gen !== generation) return status();
      if (!url) throw new Error('客户端已连上，但还没拿到隧道公网地址，请稍后刷新');
      phase = 'connected';
      // 隧道地址是从守护进程的本地 API 读到的：能读到就说明它活着，running 认这一格。
      daemonRunning = true;
    } catch (err) {
      if (gen !== generation) return status();
      // 「还没登录」不是错误，是缺一步：停在 login 阶段，交给面板去打开确认页。
      if (err && err.code === 'needs-login') {
        phase = 'login';
        error = err.message;
        return status();
      }
      phase = 'error';
      error = err && err.message ? err.message : String(err);
      errorReason = err && err.reason ? err.reason : '';
      // 配额 / 被拒 / token 冲突 / 无可用带宽这类重试也白搭，别让接线层无限退避重连。
      retryable = !(err && err.code === 'terminal') && !/quota|bandwidth|额度|带宽|名额|already exists|token update ignored/i.test(error);
    }
    return status();
  }

  /**
   * 同一时刻只跑一次 start：并发调用共享同一个在飞 Promise，避免自动重连 + 点连接 + watch 撞车各起一个客户端。
   * `options.token` 是面板里粘贴的 AuthToken；不给就走「已登录」或浏览器登录那条老路。
   */
  function start(options = {}) {
    if (options && typeof options.token === 'string' && options.token.trim()) pendingToken = options.token.trim();
    if (startPromise) return startPromise;
    startPromise = runStart().finally(() => { startPromise = null; });
    return startPromise;
  }

  /**
   * 连上之后定时问一次 CLI：守护进程是不是还在跑。launcher 早退出，手里没有它的退出事件，
   * 只能靠这里发现「状态说连着、进程其实没了」，再交接线层安排自愈重连。
   * CLI 读不到（命令报错）时当「不知道」，不动状态——别因为一次抖动把还能用的线路抖掉。
   */
  async function checkAlive() {
    if (phase !== 'connected' || aliveCheckPromise) return status();
    const gen = generation;
    aliveCheckPromise = (async () => {
      const st = await cliStatus();
      if (gen !== generation || phase !== 'connected' || !st) return;
      daemonRunning = st.running === true;
      if (daemonRunning) {
        // CLI 说守护进程在跑、云端也还留着这条隧道，但它指向的本机端口可能已经没人监听
        // （老隧道落在旧端口上）：手机拨过去照样连不上。探一下落点，没监听就判失效。
        // 只改本机这份状态：不删云端隧道、不重建（官方 CLI 没公开删除参数，删错不可回滚）。
        const port = tunnelLocalPort;
        if (port > 0) {
          let listening = true;
          try { listening = await probePort(port); } catch { /* 探活本身失败当不知道，别抖掉还能用的线路 */ }
          if (gen !== generation || phase !== 'connected') return;
          if (!listening) {
            attached = false;
            url = '';
            phase = 'error';
            error = `旧隧道指向的本机端口 ${port} 没有服务监听，请在控制台删除旧隧道后重新接入`;
            errorReason = 'port-dead';
            retryable = false;
          }
        }
        return;
      }
      attached = false;
      url = '';
      phase = 'error';
      error = 'ZeroNews 客户端意外退出';
      retryable = true;
      errorReason = '';
      if (onUnexpectedExit) { try { onUnexpectedExit(error); } catch { /* 回调失败不影响状态 */ } }
    })();
    try { await aliveCheckPromise; } finally { aliveCheckPromise = null; }
    return status();
  }

  function stop() {
    generation += 1;
    if (child && typeof child.kill === 'function') { try { child.kill(); } catch {} }
    child = null;
    attached = false;
    daemonRunning = false;
    url = '';
    error = '';
    errorReason = '';
    phase = 'off';
    return status();
  }

  return { start, stop, status, checkAlive, pickEndpoint, endpointUrl };
}

module.exports = { DEFAULT_BASE, LOGIN_TIMEOUT_MS, START_TIMEOUT_MS, endpointUrl, pickEndpoint, createZeroNewsRunner };

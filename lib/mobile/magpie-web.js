'use strict';

/**
 * magpie 网页版：把这台电脑上 magpie 自带的那个网页界面端给手机，需要时替它起来。
 *
 * **为什么走网页版而不是自己画一页**：magpie 的网页版就是它自己的界面（Agents / Providers /
 * Routing / Usage / Settings 全在里面），而且它本来就是给手机做的 —— 页面源码里写着
 * 「加到手机主屏后，作为独立 App 打开」，还有 manifest 与 apple-touch-icon。照着它的
 * `/api/state` 再画一套，等于把人家已经做好的东西重做一遍，而且每加一个设置项我们就得跟一次。
 * 所以手机那边直接嵌这个页面：一份实现、永远跟 magpie 同步。
 *
 * **为什么要在这里起进程**：网关那个端口（3425）只答 API，不端页面 —— 页面是 `magpie web`
 * 这个独立进程端出来的，默认 `127.0.0.1:3430`，而且它起来之后要**换一个 key**（每次运行
 * 随机，除非设了 `MAGPIE_WEB_KEY`）。用户点开那一页时网页版没在跑，这里就替他把进程拉起来，
 * 拿到地址与 key 再交出去；已经跑着就直接用现成的。
 *
 * **key 是凭据**：它只出现在这一条端点与那一次 URL 里，不进日志、不回给别的端点。设了
 * `MAGPIE_WEB_KEY` 就用它（每次运行同一个，手机那边刷新不用重新要地址）；没有就给这个进程
 * 临时定一个，随进程走。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { sendJson } = require('../shared/http-util');

/** 网页版默认端口（magpie 自己的缺省）。 */
const DEFAULT_WEB_PORT = 3430;
/** 起来之后最多等这么久让它把页面端出来。冷启动实测 3~6 秒（要读各家配置与订阅）。 */
const START_TIMEOUT_MS = 25000;
/** 探测间隔。 */
const POLL_MS = 250;
/** 上面等不到时的退避：同一个端口短时间内不反复起进程。 */
const START_COOLDOWN_MS = 5000;

/** key 只要够长、能进查询串；magpie 自己要求 16 位以上字母数字与 `-._~`。 */
const KEY_RE = /^[A-Za-z0-9._~-]{16,}$/;

/** 正在起来的那个：同一时刻只许一个（连点两下不该起两个进程）。 */
let starting = null;
/**
 * 我们自己起的那个进程用的 key（端口 → key）。
 *
 * **必须记住**：没设 `MAGPIE_WEB_KEY` 时 key 是这里现造的，而那一次运行之内它一直有效 ——
 * 第二次点开时进程已经在跑，如果不记得当初用了哪把，就只能回「拿不到凭据」，用户看到的是
 * 「第一次能开、第二次打不开」。进程随插件重载消失，这份记录跟着进程走，所以重启后重新起
 * 一个新进程、配一把新 key，也是一致的。
 */
const startedKeys = new Map();
/**
 * 上次起失败的时刻与原因（按端口记）：失败之后短时间内不再对**同一个端口**反复试。
 *
 * 按端口而不是全局：一个端口被别的东西占着起不来，不该把另一个能用的端口也一起封住。
 */
const failures = new Map();

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** magpie 的配置目录（与 `magpie.js` 同一口径）。 */
function configDir(env = process.env) {
  const xdg = text(env.XDG_CONFIG_HOME);
  const base = xdg || path.join(os.homedir(), '.config');
  return path.join(base, 'magpie');
}

/**
 * 网页版该占哪个端口。
 *
 * magpie 自己的默认是 3430；`settings.json` 里没有单独的「网页版端口」这一项（那是命令行
 * 参数），所以这里只认 `$MAGPIE_WEB_PORT` 与默认值。端口被别的东西占着时往上找几个。
 */
function preferredPort(env = process.env) {
  const raw = Number(text(env.MAGPIE_WEB_PORT));
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_WEB_PORT;
}

/**
 * 这个端口上是不是已经有一个 magpie 网页版在答。
 *
 * 判据是它回 303/302（`/?k=` 换 cookie 那一跳）或 401（认得出是它、只是没带 key）——
 * 别的程序占着这个端口时不会这么答。不带 key 请求，所以这条探测不会泄漏任何东西。
 */
function probeWeb(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* 已经断了 */ }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.on('error', () => finish(false));
    socket.on('connect', () => {
      socket.write(
        'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n'
        + 'User-Agent: dsh-mobile-plugin\r\n\r\n',
      );
    });
    let raw = '';
    socket.on('data', (chunk) => {
      raw += chunk.toString('latin1');
      if (raw.length > 2048) raw = raw.slice(0, 2048);
      const status = raw.match(/^HTTP\/1\.[01] (\d{3})/);
      if (!status) return;
      const code = Number(status[1]);
      // 303/302 = 有 key 就换 cookie 的那一跳；401 = 是它、但这次没给 key。
      finish(code === 303 || code === 302 || code === 401);
    });
    socket.on('close', () => finish(false));
  });
}

/** 端口空着没有（起进程前先看一眼，别去撞一个不认识的程序）。 */
function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let done = false;
    const finish = (free) => {
      if (done) return;
      done = true;
      try { server.close(); } catch { /* 没起来 */ }
      resolve(free);
    };
    server.once('error', () => finish(false));
    server.listen(port, '127.0.0.1', () => finish(true));
    server.unref();
  });
}

/** 找一个能用的端口：优先默认，被占了就往上找几个。 */
async function pickPort(env = process.env) {
  const base = preferredPort(env);
  for (let offset = 0; offset < 10; offset += 1) {
    const port = base + offset;
    if (await probeWeb(port, 600)) return { port, running: true };
    if (await portFree(port)) return { port, running: false };
  }
  return null;
}

/**
 * 找 magpie 可执行文件。
 *
 * magpie 三个桌面系统都有（菜单栏 / 窗口 / TUI / 网页 / CLI 是同一个程序的不同入口），
 * 装法也各不相同，所以按「先 PATH、再各系统的常规落点」找，别只认 macOS 那一个 .app 包：
 *   - PATH：`install.sh` 与 `go install` 都往某个 bin 目录里放一个 `magpie`（Windows 是
 *     `magpie.exe`），只要那个目录在 PATH 上就能直接命中。
 *   - macOS：官方 .app 包里的可执行文件，外加 Homebrew 的两个前缀。
 *   - Windows：安装器放在 `%LOCALAPPDATA%\Programs\magpie`、`%ProgramFiles%\magpie`；
 *     `go install` 落在 `%USERPROFILE%\go\bin`。
 *   - Linux：`~/.local/bin`、`/usr/local/bin`、`/usr/bin`、`/opt/magpie`，以及 `go install`
 *     的 `~/go/bin`。
 *
 * `MAGPIE_BIN` 给了就只认它：用户明确指了一条路径，指错时如实回「找不到」，而不是悄悄去
 * PATH 里找另一个 —— 那样排查起来是「我明明改了变量，它却还在跑旧的那个」。
 */
function findBinary(env = process.env) {
  const explicit = text(env.MAGPIE_BIN);
  if (explicit) return isExecutable(explicit) ? explicit : null;
  const home = os.homedir();
  const names = process.platform === 'win32' ? ['magpie.exe', 'magpie'] : ['magpie'];
  const candidates = [];
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) candidates.push(path.join(dir, name));
  }
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Magpie.app/Contents/MacOS/magpie');
    candidates.push(path.join(home, 'Applications', 'Magpie.app', 'Contents', 'MacOS', 'magpie'));
    candidates.push('/opt/homebrew/bin/magpie');
    candidates.push('/usr/local/bin/magpie');
  } else if (process.platform === 'win32') {
    const local = text(env.LOCALAPPDATA);
    if (local) candidates.push(path.join(local, 'Programs', 'magpie', 'magpie.exe'));
    for (const key of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)']) {
      const base = text(env[key]);
      if (base) candidates.push(path.join(base, 'magpie', 'magpie.exe'));
    }
    candidates.push(path.join(home, 'go', 'bin', 'magpie.exe'));
  } else {
    candidates.push(path.join(home, '.local', 'bin', 'magpie'));
    candidates.push('/usr/local/bin/magpie');
    candidates.push('/usr/bin/magpie');
    candidates.push('/opt/magpie/magpie');
    candidates.push(path.join(home, 'go', 'bin', 'magpie'));
  }
  for (const file of candidates) {
    if (isExecutable(file)) return file;
  }
  return null;
}

/** 这个路径上是不是一个能执行的文件。 */
function isExecutable(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 网页版这次用的 key。
 *
 * 干净的「只按环境变量或现造」判定（纯函数，方便单测）。`ensureWeb` 实际用的是
 * `resolveKey`：多一层「上次留下的那份」。
 */
function webKey(env = process.env) {
  const given = text(env.MAGPIE_WEB_KEY);
  if (KEY_RE.test(given)) return given;
  // 32 位十六进制，够长且只含字母数字。
  return require('node:crypto').randomBytes(16).toString('hex');
}

/** 本地存 key 的文件：默认 `~/.dsh/magpie-web-key`，`MAGPIE_WEB_KEY_FILE` 可改（测试用）。 */
function keyFilePath(env = process.env) {
  const override = text(env.MAGPIE_WEB_KEY_FILE);
  if (override) return override;
  return path.join(os.homedir(), '.dsh', 'magpie-web-key');
}

/** 读上次留下的 key；没有/不合规就回空串。 */
function readStoredKey(env = process.env) {
  try {
    const value = fs.readFileSync(keyFilePath(env), 'utf8').trim();
    return KEY_RE.test(value) ? value : '';
  } catch {
    return '';
  }
}

/** 留一份 key 给下次用（0600，只有当前用户能读）。写不进去就算了，退回「本次进程记住」，不阻断打开。 */
function writeStoredKey(env, key) {
  try {
    const file = keyFilePath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, key, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch { /* 落盘失败不致命：startedKeys 在本次进程内仍然记得 */ }
}

/**
 * 这次网页版用的 key，按优先级：用户设的 `MAGPIE_WEB_KEY` → 上次留下那份 → 现造并存下。
 *
 * **为什么要「上次留下那份」**：插件热重载 / 宿主重启后，内存里那份 `startedKeys` 就没了，
 * 而网页版进程是 detached 的、还活着。若这时现造一把新 key，就跟那个已经在跑的进程对不上，
 * 只能回「拿不到登录凭据」——用户被要求自己去设环境变量，这不是我们要的。留一份稳定的 key，
 * 同一个进程永远对得上，用户什么都不用配（与 magpie 自己把 key 放进 service file 一个路数）。
 */
function resolveKey(env = process.env) {
  const given = text(env.MAGPIE_WEB_KEY);
  if (KEY_RE.test(given)) return given;
  const stored = readStoredKey(env);
  if (stored) return stored;
  const key = webKey(env);
  writeStoredKey(env, key);
  return key;
}

/**
 * 带 key 请求一下，看这个端口上跑着的 magpie 认不认这把 key。
 *
 * 认（登录那一跳 3xx）就说明正是我们自己起的那一个；401 / 别的都算不认。用来在起进程之前
 * 先「认领」一个还活着的旧进程，而不是又起一个新的。
 */
function probeKey(port, key, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { req.destroy(); } catch { /* 已经断了 */ }
      resolve(ok);
    };
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: `/?k=${encodeURIComponent(key)}`,
      method: 'GET',
      timeout: timeoutMs,
    }, (res) => {
      const code = res.statusCode;
      res.resume();
      // 302/303 是换 cookie 的那一跳；3xx 都算「key 被接受」。
      finish(typeof code === 'number' && code >= 300 && code < 400);
    });
    req.on('timeout', () => finish(false));
    req.on('error', () => finish(false));
    req.end();
  });
}

/** 等网页版在这个端口上答起来。 */
async function waitForWeb(port, deadline, probe = probeWeb) {
  for (;;) {
    if (await probe(port, 800)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * 把这台电脑上的 magpie 网页版拿给手机。
 *
 * 三种结局：已经有一个我们对得上 key 的在跑（认领它）、没有就起一个新的、起不来（如实说为什么）。
 * **失败不抛**：这是一次能力探测，抛出去只会变成一条看不出哪一格缺了的 500。
 *
 * 认领优先于新起：网页版进程是 detached 的，插件热重载 / 宿主重启之后它常常还活着，而内存里
 * 的 `startedKeys` 已经没了 —— 这时用稳定 key 探一下就能把它认回来，不必再起第二个，也不必
 * 让用户去设环境变量。
 */
async function ensureWeb({
  env = process.env,
  spawnImpl = spawn,
  probe = probeWeb,
  probeKeyFn = probeKey,
  portFreeFn = portFree,
  startTimeoutMs = START_TIMEOUT_MS,
} = {}) {
  const base = preferredPort(env);
  const key = resolveKey(env);

  // 一、先看有没有「认得出来是我们的」在跑：本进程记得的、或稳定 key 探得通的，都认领。
  for (let offset = 0; offset < 10; offset += 1) {
    const port = base + offset;
    if (startedKeys.get(port) === key) {
      return { available: true, port, key };
    }
    if (!(await probe(port, 500))) continue;
    if (await probeKeyFn(port, key, 800)) {
      startedKeys.set(port, key);
      return { available: true, port, key };
    }
  }

  // 正在起的那一个：搭它的车，别再起第二个。
  if (starting) {
    const shared = await starting;
    return shared;
  }

  // 二、挑一个空端口起我们自己的。
  let port = null;
  for (let offset = 0; offset < 10; offset += 1) {
    const candidate = base + offset;
    if (await portFreeFn(candidate)) { port = candidate; break; }
  }
  if (port == null) return { available: false, reason: 'no-free-port' };

  const lastFailure = failures.get(port);
  if (lastFailure && Date.now() - lastFailure.at < START_COOLDOWN_MS) {
    return { available: false, reason: lastFailure.reason, port };
  }

  const bin = findBinary(env);
  if (!bin) return { available: false, reason: 'no-magpie' };

  starting = (async () => {
    let child;
    try {
      child = spawnImpl(bin, ['web', '--addr', `127.0.0.1:${port}`, '--no-open'], {
        env: { ...env, MAGPIE_WEB_KEY: key },
        // 脱离父进程：插件重载 / 宿主重启不该把它带走，用户下次点开还能直接连上。
        // stdout/stderr 丢掉：那是 magpie 自己的日志，插件不替它收（收着不读会堵住管道）。
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    } catch (error) {
      failures.set(port, { at: Date.now(), reason: 'spawn-failed' });
      return { available: false, reason: 'spawn-failed', port };
    }
    const ok = await waitForWeb(port, Date.now() + startTimeoutMs, probe);
    if (!ok) {
      failures.set(port, { at: Date.now(), reason: 'start-timeout' });
      return { available: false, reason: 'start-timeout', port };
    }
    failures.delete(port);
    startedKeys.set(port, key);
    return { available: true, port, key };
  })().finally(() => { starting = null; });
  return starting;
}

/**
 * GET /api/mobile/v1/magpie/web — 手机要打开 magpie 网页版时问这一条。
 *
 * 回 `{ ok: true, available, port, key, reason }`。**key 只在这里出现一次**，App 拿它拼
 * `http://127.0.0.1:3430/?k=…` 交给预览管道 —— 之后那一跳 magpie 会换成 cookie，
 * 地址栏里的 key 不会跟着页面里的链接到处跑。
 */
async function handleMagpieWeb(ctx, _req, res) {
  try {
    const entry = await ensureWeb({});
    sendJson(res, 200, { ok: true, ...entry });
  } catch {
    sendJson(res, 200, { ok: true, available: false, reason: 'unexpected' });
  }
}

module.exports = {
  handleMagpieWeb,
  ensureWeb,
  probeWeb,
  probeKey,
  portFree,
  pickPort,
  findBinary,
  webKey,
  resolveKey,
  readStoredKey,
  keyFilePath,
  preferredPort,
};

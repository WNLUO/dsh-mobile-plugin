'use strict';

/**
 * 本机防火墙只读探测：这台电脑有没有把「手机连进来」这条路挡住。
 *
 * 只读、不提权、不改规则。查不到的实话是 `null`，「不知道」不许写成「正常」。
 *
 * ## 为什么只查「放不放行这个程序」，不查端口
 *
 * macOS 与 Windows 的入站规则都是按**程序**（可执行文件路径）挂的，不是按端口挂的：
 * 用户装完之后第一次被系统问到「是否允许接受传入连接」，点一次「拒绝」就永久挡着，
 * 面板上什么都看不出来。所以查的对象是 `process.execPath` —— 宿主进程自己的那个
 * 可执行文件，不是写死的 `node`（DSH 自带的运行时、nvm 切的版本，路径都不一样）。
 *
 * ## 三个平台能查到什么，差很远
 *
 * - **macOS**：`socketfilterfw` 两条查询就够，都不用 root —— `--getglobalstate` 回答
 *   防火墙开没开，`--getappblocked <path>` 回答这个程序允不允许接连接。
 * - **Windows**：默认入站全拒，所以「有允许规则」才算放行，没有就是被挡；还要看那条
 *   规则管的是哪个网络类别 —— 笔记本换个 WiFi、系统把那个网判成「公用」时，只放行
 *   「专用」的老规则就不再生效。这就是「出去一趟就连不上、看一眼防火墙又好了」的
 *   真身，所以当前接入的网络类别必须一起查。
 * - **Linux**：只能读到「防火墙开着没」（`firewall-cmd --state` 不要 root），
 *   「放行了没」要 root 才读得到 —— 那条我们不碰，一律回 `null`。
 *
 * ## 缓存
 *
 * 每条查询都要 fork 一个进程（Windows 那边还得起 PowerShell），所以结果按
 * `CACHE_TTL_MS` 记着：面板弹窗点开、以及手机上久没来过时的那一次后台查询，
 * 都走同一份。并发的调用共用同一个在飞的 Promise，不叠着开进程。
 */

const { execFile } = require('node:child_process');

/** 单条查询的上限。Windows 起 PowerShell 冷启动就要一两秒，给得比另两个宽。 */
const PROBE_TIMEOUT_MS = { darwin: 3000, win32: 8000, linux: 3000 };
const CACHE_TTL_MS = 30 * 1000;

/** 查不到时的如实形状。`reason` 说明是哪一种查不到，界面据此决定要不要说「查不到」。 */
function unknownFirewall(appPath, reason) {
  return { supported: false, enabled: null, allowsApp: null, appPath: appPath || '', reason };
}

/**
 * macOS 的 `--getglobalstate`：`Firewall is disabled. (State = 0)`。
 *
 * 状态 1 是开、2 是「拦全部非必要入站连接」—— 2 也是开，只是更狠。按数字判，别按
 * 那半句英文：文案会随系统版本变，`State = N` 不会。
 */
function parseDarwinState(text) {
  const hit = /State\s*=\s*(\d+)/.exec(String(text || ''));
  if (!hit) return null;
  return Number(hit[1]) !== 0;
}

/**
 * macOS 的 `--getappblocked <path>`：
 * `Incoming connection to /path is permitted.` / `... is blocked.`
 *
 * 认不出就回 `null`：这句话以外的东西（帮助文本、本地化的译文）都不算答案。
 */
function parseDarwinAppAllowed(text) {
  const value = String(text || '');
  if (/is permitted/i.test(value)) return true;
  if (/is (?:blocked|not allowed)/i.test(value)) return false;
  return null;
}

/** PowerShell 的 JSON 里数组只有一条时会退化成对象，两种都收。 */
function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
}

/**
 * 解析 Windows 那份报告（脚本见 `WINDOWS_SCRIPT`）。
 *
 * 字段全 ASCII：规则里的程序路径、`Allow` / `Block`、`Domain` / `Private` / `Public`、
 * 以及当前接入的网络类别。**不读 DisplayName**：它是用户语言下的可读文案，中文
 * Windows 上根本没有能匹配的稳定值。
 */
function parseWindowsReport(text) {
  const data = JSON.parse(String(text || '').trim());
  const profileObject = data && typeof data === 'object' ? data : {};
  return {
    profiles: asArray(profileObject.profiles).map((item) => ({
      name: String(item && item.name ? item.name : ''),
      enabled: item && item.enabled === true,
    })),
    apps: asArray(profileObject.apps).map((item) => ({
      program: String(item && item.program ? item.program : ''),
      action: String(item && item.action ? item.action : ''),
      enabled: item ? item.enabled !== false : false,
      profile: String(item && item.profile ? item.profile : ''),
    })),
    activeProfiles: asArray(profileObject.activeProfiles).map((item) => String(item)),
  };
}

/** Windows 路径比较不分大小写、允许带引号。 */
function sameWindowsPath(a, b) {
  const left = String(a || '').replace(/^"|"$/g, '').trim().toLowerCase();
  const right = String(b || '').replace(/^"|"$/g, '').trim().toLowerCase();
  return left !== '' && left === right;
}

/**
 * 规则管的是不是当下这条网络。
 *
 * `Profile` 是 `Any`、或者与当前接入的类别有交集，才算生效 —— `Domain,Private` 这种
 * 逗号串是真实存在的写法（用户在「允许在专用网络」那个勾里选的）。读不到当前类别
 * 时按「管」算：宁可漏报一次「被挡」，也不要凭空说人家被挡。
 */
function windowsRuleApplies(profileField, activeProfiles) {
  const field = String(profileField || '').trim();
  if (field === '' || /^any$/i.test(field)) return true;
  if (!Array.isArray(activeProfiles) || activeProfiles.length === 0) return true;
  const scopes = field.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  return scopes.some((scope) => activeProfiles.some((active) => String(active).trim().toLowerCase() === scope));
}

/**
 * Windows 上的「放行」是个模型判断，不是一条规则。
 *
 * 顺序：显式 Block 优先 → 有生效中的 Allow → 防火墙开着却没有规则 = 默认拒绝（这是
 * 第一次弹框点了取消之后的样子）→ 防火墙关着 = 不挡。
 */
function decideWindowsAllows(report) {
  if (!report || !Array.isArray(report.apps)) return null;
  const enabled = report.profiles.some((item) => item.enabled === true);
  if (!enabled) return true;
  const hits = report.apps.filter((item) => item.program && sameWindowsPath(item.program, report.appPath));
  const live = hits.filter((item) => item.enabled !== false && windowsRuleApplies(item.profile, report.activeProfiles));
  if (live.some((item) => /block/i.test(item.action))) return false;
  if (live.some((item) => /allow/i.test(item.action))) return true;
  return false;
}

/**
 * Windows 那份 PowerShell。
 *
 * 两个要点：
 * 1. `Get-NetFirewallApplicationFilter -Program <path>` 是**服务端过滤**，只回这个程序
 *    的过滤条件；换成枚举全部规则再逐条 join 会有几百次 CIM 查询，第一次跑要好几秒。
 * 2. 输出必须是 JSON 且全 ASCII —— `netsh` 的文字输出会跟着系统语言变，中文 Windows
 *    上没有办法稳定匹配。
 */
const WINDOWS_SCRIPT = [
  '$path = $env:DSH_FIREWALL_PROGRAM;',
  '$profiles = @(Get-NetFirewallProfile | ForEach-Object { @{ name = "$($_.Name)"; enabled = [bool]$_.Enabled } });',
  '$active = @(Get-NetConnectionProfile | ForEach-Object { $c = "$($_.NetworkCategory)"; if ($c -eq "DomainAuthenticated") { "Domain" } else { $c } });',
  '$apps = @();',
  'foreach ($f in @(Get-NetFirewallApplicationFilter -Program $path)) {',
  '  $r = Get-NetFirewallRule -Name $f.Name;',
  '  if ($r) { $apps += @{ program = "$($f.Program)"; action = "$($r.Action)"; enabled = ("$($r.Enabled)" -eq "True"); profile = "$($r.Profile)" } }',
  '}',
  '@{ profiles = $profiles; apps = $apps; activeProfiles = $active } | ConvertTo-Json -Depth 6 -Compress',
].join(' ');

/** 默认执行器：只跑写死的可执行文件与参数，超时杀进程，输出按 UTF-8 收。 */
function defaultExec(command, args, options) {
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: options.timeoutMs,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      windowsHide: true,
      env: options.env,
    }, (error, stdout, stderr) => {
      const failed = Boolean(error);
      resolve({
        code: failed ? (typeof error.code === 'number' ? error.code : -1) : 0,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
        error: failed ? (error.killed ? 'TIMEOUT' : (error.code === 'ENOENT' ? 'NO_COMMAND' : 'FAILED')) : null,
      });
    });
  });
}

/**
 * 查一次防火墙。`exec` 与 `platform` 可注入，守卫才不用真去 fork 进程。
 *
 * @param {{platform?: string, execPath?: string, exec?: Function}} [options]
 * @returns {Promise<{supported: boolean, enabled: boolean|null, allowsApp: boolean|null,
 *   appPath: string, reason: string|null}>}
 */
async function probeFirewall(options = {}) {
  const platform = options.platform || process.platform;
  const execPath = options.execPath || process.execPath || '';
  const exec = options.exec || defaultExec;
  const timeoutMs = PROBE_TIMEOUT_MS[platform] || 3000;

  if (platform === 'darwin') {
    const socketfilter = '/usr/libexec/ApplicationFirewall/socketfilterfw';
    // getappblocked 要的是这个程序本身；拿不到就退成查全局，别把一个空参数递过去。
    const blockedArgs = execPath ? [socketfilter, ['--getappblocked', execPath]] : null;
    const [state, app] = await Promise.all([
      exec(socketfilter, ['--getglobalstate'], { timeoutMs }),
      blockedArgs ? exec(blockedArgs[0], blockedArgs[1], { timeoutMs }) : Promise.resolve(null),
    ]);
    if (state.error === 'NO_COMMAND') return unknownFirewall(execPath, 'no-command');
    if (state.error === 'TIMEOUT') return unknownFirewall(execPath, 'timeout');
    const enabled = parseDarwinState(state.stdout);
    const allowsApp = app && !app.error ? parseDarwinAppAllowed(app.stdout) : null;
    if (enabled === null && allowsApp === null) return unknownFirewall(execPath, 'parse-failed');
    return { supported: true, enabled, allowsApp, appPath: execPath, reason: null };
  }

  if (platform === 'win32') {
    const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT], {
      timeoutMs,
      env: { ...process.env, DSH_FIREWALL_PROGRAM: execPath },
    });
    if (result.error === 'NO_COMMAND') return unknownFirewall(execPath, 'no-command');
    if (result.error === 'TIMEOUT') return unknownFirewall(execPath, 'timeout');
    let report = null;
    try {
      report = parseWindowsReport(result.stdout);
    } catch {
      return unknownFirewall(execPath, 'parse-failed');
    }
    if (report.profiles.length === 0) return unknownFirewall(execPath, 'parse-failed');
    const enabled = report.profiles.some((item) => item.enabled === true);
    return {
      supported: true,
      enabled,
      allowsApp: decideWindowsAllows({ ...report, appPath: execPath }),
      appPath: execPath,
      reason: null,
    };
  }

  if (platform === 'linux') {
    // 只能读「开着没」：firewalld 的状态查询不要 root，规则读取要 root。
    const firewalld = await exec('firewall-cmd', ['--state'], { timeoutMs });
    if (!firewalld.error) {
      // 只认整句 `running`：它另一句回答是 `not running`，用 /running/ 去配会把两句认成一句。
      const running = String(firewalld.stdout || '').trim().toLowerCase() === 'running';
      return { supported: true, enabled: running, allowsApp: null, appPath: execPath, reason: null };
    }
    if (firewalld.error === 'TIMEOUT') return unknownFirewall(execPath, 'timeout');
    const unit = await exec('systemctl', ['is-active', 'firewalld'], { timeoutMs });
    if (unit.error === 'NO_COMMAND') return unknownFirewall(execPath, 'no-command');
    if (!unit.error) {
      const active = String(unit.stdout || '').trim() === 'active';
      return { supported: true, enabled: active, allowsApp: null, appPath: execPath, reason: null };
    }
    return unknownFirewall(execPath, 'parse-failed');
  }

  return unknownFirewall(execPath, 'unsupported');
}

/** 缓存：同一份结果给面板弹窗与后台那一次共用。`pending` 让并发调用不叠着开进程。 */
let cache = null;
let pending = null;

/**
 * 带缓存的取法。`force` 只由「重新自检」那颗按钮用。
 *
 * @param {{force?: boolean, platform?: string, execPath?: string, exec?: Function}} [options]
 */
async function readFirewall(options = {}) {
  const now = Date.now();
  if (!options.force && cache && now - cache.at < CACHE_TTL_MS && cache.key === (options.platform || process.platform)) {
    return cache.value;
  }
  if (pending) return pending;
  const key = options.platform || process.platform;
  pending = probeFirewall(options)
    .catch(() => unknownFirewall(options.execPath || process.execPath || '', 'parse-failed'))
    .then((value) => {
      cache = { at: Date.now(), key, value };
      pending = null;
      return value;
    });
  return pending;
}

/** 守卫用：清掉缓存，别让上一条用例的结果漏到下一条。 */
function resetFirewallCache() {
  cache = null;
  pending = null;
}

module.exports = {
  PROBE_TIMEOUT_MS,
  CACHE_TTL_MS,
  WINDOWS_SCRIPT,
  parseDarwinState,
  parseDarwinAppAllowed,
  parseWindowsReport,
  windowsRuleApplies,
  decideWindowsAllows,
  probeFirewall,
  readFirewall,
  resetFirewallCache,
  unknownFirewall,
};

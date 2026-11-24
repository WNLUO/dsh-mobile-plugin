// 节点小宝设备端的安装与启动：下载官方设备端 / 安装脚本、按平台装成系统服务、确保它在跑。
'use strict';

/**
 * 这一步跟 ZeroNews / cloudflared 最大的不同：那两个在自己目录里放个二进制就能跑，节点小宝要
 * 装成**系统服务**——它的设备身份写在系统目录里，只有以 root 跑才存得住，否则每次重启都当新
 * 设备（实测：普通用户跑，重启后 peerid 变空、线路全掉）。
 *
 * 所以这里绕不开一次管理员授权。插件能做的是把整件事自动化：macOS 自己下载二进制、写服务定义；
 * Windows 与 Linux 跑官方的一键安装脚本；用户只在系统弹出的授权框里确认一次（Touch ID / 密码、
 * UAC、polkit）。这是操作系统对「装系统服务」的规矩，不是我们多要一步。
 *
 * 三个平台的本地管理口与绑定链接都由 probe.cjs 只读探测；面板的「装没装」以探测为准，不靠
 * 各平台的文件标记。无图形授权的 Linux 服务器弹不出 polkit 框，会如实报错，不猜着装成功。
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VERSION = '4.3.5';
const INSTALL_DIR = '/usr/local/nblink';
const BINARY = path.join(INSTALL_DIR, 'NodeBabyLinkService');
const PLIST = '/Library/LaunchDaemons/com.iepose.NodeBabyLinkService.plist';
const LOG_DIR = path.join(INSTALL_DIR, 'logs');
const CDN = 'https://cdn.ionewu.com/upgrade/jdxb';
const WINDOWS_INSTALLER = 'https://iepose.com/install.ps1';
const LINUX_INSTALLER = 'https://iepose.com/install.sh';
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** 授权框等人点：给足三分钟，但别无限挂着。 */
const ELEVATE_TIMEOUT_MS = 180_000;
/** 装完等它把本地管理口听上。 */
const START_WAIT_MS = 15_000;

function platformKey(platform, arch) {
  const p = String(platform || process.platform);
  const a = String(arch || process.arch);
  if (p === 'darwin') {
    if (a === 'arm64') return 'darwin-arm64';
    if (a === 'x64') return 'darwin-x64';
    return '';
  }
  // 官方 Windows 精简版明确不支持 32 位；Linux 的安装脚本按架构自己下载。
  if (p === 'win32') return a === 'x64' ? 'win32-x64' : '';
  if (p === 'linux') return a === 'x64' || a === 'arm64' ? `linux-${a}` : '';
  return '';
}

function downloadUrl(key) {
  if (key === 'win32-x64') return WINDOWS_INSTALLER;
  if (key === 'linux-x64' || key === 'linux-arm64') return LINUX_INSTALLER;
  const arch = key === 'darwin-arm64' ? 'arm64' : 'amd64';
  return `${CDN}/NodeBabyLinkService.darwin.${arch}.${VERSION}`;
}

/**
 * 一个 Mach-O 可执行文件的开头；下载坏了/被挡成网页时当场认出来，别把垃圾装进系统目录。
 * 小端与大端、32/64 位、以及 fat 包都算 —— 官方给的是小端 64 位（首字节 CF FA ED FE），
 * 只按大端认会把真文件拒掉。
 */
const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);
function looksLikeMachO(buffer) {
  if (!buffer || buffer.length < 4) return false;
  return MACHO_MAGICS.has(buffer.readUInt32BE(0));
}

/** 官方安装脚本是纯文本；被强制门户换成网页时当场认出来，别把 HTML 拿去提权执行。 */
function looksLikeScript(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8', 0, Math.min(buffer.length, 4096)) : String(buffer || '');
  if (!text.trim()) return false;
  return !/^\s*<(?:!doctype|html|script|title)\b/i.test(text);
}

/** `launchctl list <label>`：加载了就有输出，没加载退出码非 0。 */
function serviceLoaded(options = {}) {
  const run = typeof options.run === 'function' ? options.run : defaultRun;
  return run('launchctl', ['list', 'com.iepose.NodeBabyLinkService'], { timeoutMs: 5000 })
    .then((result) => result.code === 0 && /\bcom\.iepose\.NodeBabyLinkService\b/.test(result.stdout))
    .catch(() => false);
}

function defaultRun(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: opts.timeoutMs || 10_000, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** macOS 的文件标记：服务定义与二进制都在，才算装过（只装了一半的照实报没装）。
 *  其它平台的真实状态由本地管理口探测给出，不用这份文件标记。 */
function installedSync() {
  try {
    return fs.existsSync(PLIST) && fs.existsSync(BINARY);
  } catch {
    return false;
  }
}

function plistBody() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.iepose.NodeBabyLinkService</string>
    <key>ProgramArguments</key>
    <array>
        <string>${BINARY}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${path.join(LOG_DIR, 'stdout.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(LOG_DIR, 'stderr.log')}</string>
</dict>
</plist>
`;
}

/**
 * 以管理员权限跑一段 shell（macOS）。系统自带的授权框（do shell script ... with
 * administrator privileges）会弹 Touch ID / 密码，用户点一下确认，脚本才以 root 跑。
 *
 * 脚本先写到用户自己的临时目录（0700）：同一个人能改的只有这一份，跨不过权限边界；写死命令
 * 串反而要跟一堆引号打架，出错时也看不出哪一步断的。
 */
function runElevated(script, options = {}) {
  const run = typeof options.run === 'function' ? options.run : defaultRun;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-jdxb-'));
  const file = path.join(dir, 'install.sh');
  fs.writeFileSync(file, script, { mode: 0o700 });
  // AppleScript 字符串里只需处理反斜杠与双引号；路径是我们自己造的，没有空格与怪字符。
  const escaped = file.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return run('osascript', ['-e', `do shell script "sh ${escaped}" with administrator privileges`], {
    timeoutMs: options.timeoutMs || ELEVATE_TIMEOUT_MS,
  }).finally(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
}

/** Windows：Start-Process -Verb RunAs 弹 UAC，等官方安装脚本跑完把退出码透传回来。 */
function runWindowsScript(file, options = {}) {
  const run = typeof options.run === 'function' ? options.run : defaultRun;
  const args = `-NoProfile -ExecutionPolicy Bypass -File '${String(file).replace(/'/g, "''")}'`;
  const quotedArgs = `'${args.replace(/'/g, "''")}'`;
  const script = `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList ${quotedArgs} -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
  return run('powershell.exe', ['-NoProfile', '-Command', script], {
    timeoutMs: options.timeoutMs || ELEVATE_TIMEOUT_MS,
    windowsHide: true,
  });
}

/** Linux：pkexec 弹 polkit 授权框，脚本路径作为独立参数传，不经 shell。 */
function runLinuxScript(file, options = {}) {
  const run = typeof options.run === 'function' ? options.run : defaultRun;
  return run('pkexec', ['bash', file], { timeoutMs: options.timeoutMs || ELEVATE_TIMEOUT_MS });
}

/**
 * 装好并拉起来。
 *
 * @returns {Promise<{ ok: boolean, installed: boolean, started: boolean, error: string }>}
 *   `ok=false` 时 `error` 是人能看懂的原因（下载失败 / 用户取消授权 / 服务没起来）。
 */
async function install(options = {}) {
  const key = options.platformKey || platformKey(options.platform, options.arch);
  const isMac = key.startsWith('darwin');
  if (!key) {
    return {
      ok: false, installed: installedSync(), started: false,
      error: '这一版只接了 macOS、Windows x64 与 Linux x64/arm64 的自动安装',
    };
  }

  let alreadyInstalled = false;
  if (isMac) {
    if (installedSync() && await serviceLoaded(options)) {
      return { ok: true, installed: true, started: true, error: '' };
    }
  } else {
    // Windows / Linux 以本地管理口为准：装过就不再跑官方脚本（它会进入卸载 / 升级菜单）。
    try {
      const probeStatus = typeof options.probeStatus === 'function'
        ? options.probeStatus
        : () => require('./probe.cjs').readStatus(options);
      const snapshot = await probeStatus();
      alreadyInstalled = Boolean(snapshot && snapshot.installed);
      if (alreadyInstalled) return { ok: true, installed: true, started: true, error: '' };
    } catch {
      // 探测失败当作没装，继续走安装；装完还要再探一次才算成功。
    }
  }

  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { ok: false, installed: alreadyInstalled, started: false, error: '当前环境没有可用的 fetch' };
  }

  let temp = '';
  try {
    const response = await fetchImpl(downloadUrl(key), { redirect: 'follow' });
    if (!response || response.ok !== true) {
      return {
        ok: false, installed: alreadyInstalled, started: false,
        error: `下载设备端失败（HTTP ${response && response.status ? response.status : '?'}）`,
      };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!(isMac ? looksLikeMachO(buffer) : looksLikeScript(buffer))) {
      return {
        ok: false, installed: alreadyInstalled, started: false,
        error: isMac ? '下载到的不是可执行文件，可能被网络拦截了' : '下载到的不是安装脚本，可能被网络拦截了',
      };
    }
    const name = isMac ? 'NodeBabyLinkService' : (key.startsWith('win32') ? 'install.ps1' : 'install.sh');
    temp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-jdxb-')), name);
    fs.writeFileSync(temp, buffer, { mode: 0o700 });
  } catch (error) {
    return {
      ok: false, installed: alreadyInstalled, started: false,
      error: `下载设备端失败：${error && error.message ? error.message : String(error)}`,
    };
  }

  let elevated;
  try {
    if (isMac) {
      const script = [
        'set -e',
        `mkdir -p '${INSTALL_DIR}' '${LOG_DIR}'`,
        `cp '${temp}' '${BINARY}'`,
        `chmod 755 '${BINARY}'`,
        `cat > '${PLIST}' <<'PLIST_EOF'`,
        plistBody(),
        'PLIST_EOF',
        `chmod 644 '${PLIST}'`,
        `launchctl unload '${PLIST}' 2>/dev/null || true`,
        `launchctl load -w '${PLIST}'`,
      ].join('\n');
      elevated = await runElevated(script, options);
    } else if (key.startsWith('win32')) {
      elevated = await runWindowsScript(temp, options);
    } else {
      elevated = await runLinuxScript(temp, options);
    }
  } catch (error) {
    elevated = { code: 1, stdout: '', stderr: String(error && error.message ? error.message : error) };
  }
  try { fs.rmSync(path.dirname(temp), { recursive: true, force: true }); } catch {}

  if (elevated.code !== 0) {
    const detail = String(elevated.stderr || '').trim().split('\n').filter(Boolean).slice(-1)[0] || '';
    // 取消 / 拒绝授权各平台措辞不同：osascript 回 -128，UAC 是 "canceled by the user"，
    // polkit 是 "Not authorized" / "dismissed"。统一说清是没通过授权，不是安装本身坏了。
    const cancelled = /-128|user cancel|canceled by the user|not authorized|dismissed/i.test(`${elevated.stderr || ''}${elevated.stdout || ''}`);
    return {
      ok: false,
      installed: alreadyInstalled || installedSync(),
      started: false,
      error: cancelled ? '授权被取消，设备端没有安装' : `安装没成功${detail ? `：${detail}` : ''}`,
    };
  }

  // 脚本以管理员权限跑完了就当装上了：真要用得起来看的是下面这条管理口应答。
  const started = await waitForPort(options);
  return { ok: started, installed: true, started, error: started ? '' : '设备端装好了，但本地管理口没起来，请查看系统服务状态' };
}

/** 装完等管理口应答：`launchctl load` / 安装脚本返回不代表进程已经监听。 */
async function waitForPort(options = {}) {
  const probeModule = require('./probe.cjs');
  const probe = typeof options.probePort === 'function' ? options.probePort : probeModule.probePort;
  const platform = String(options.platform || process.platform);
  const endpoints = Array.isArray(options.endpoints) ? options.endpoints : probeModule.endpointsFor(platform);
  const candidates = endpoints.length ? endpoints : [{ host: '127.0.0.1', port: Number(options.port) > 0 ? Number(options.port) : 2080 }];
  const deadline = Date.now() + (Number(options.waitMs) > 0 ? Number(options.waitMs) : START_WAIT_MS);
  while (Date.now() < deadline) {
    for (const { host, port } of candidates) {
      const result = await probe(port, { host, timeoutMs: 1500 });
      if (result && result.ok) return true;
    }
    if (typeof options.sleep === 'function') await options.sleep(500);
    else await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

module.exports = {
  VERSION,
  INSTALL_DIR,
  BINARY,
  PLIST,
  platformKey,
  downloadUrl,
  looksLikeMachO,
  looksLikeScript,
  installedSync,
  serviceLoaded,
  runElevated,
  runWindowsScript,
  runLinuxScript,
  install,
  waitForPort,
};

// 节点小宝设备端的安装与启动：下载官方二进制、按平台装成系统服务、确保它在跑。
'use strict';

/**
 * 这一步跟 ZeroNews / cloudflared 最大的不同：那两个在自己目录里放个二进制就能跑，节点小宝要
 * 装成**系统服务**——它的设备身份写在系统目录里，只有以 root 跑才存得住，否则每次重启都当新
 * 设备（实测：普通用户跑，重启后 peerid 变空、线路全掉）。
 *
 * 所以这里绕不开一次管理员授权。插件能做的是把整件事自动化：自己下载、自己装、自己拉起，
 * 用户只在系统弹出的授权框里确认一次（Touch ID / 输密码）。这是操作系统对「装系统服务」的
 * 规矩，不是我们多要一步。
 *
 * 只做 macOS：它的 launchd 服务定义简单、我们也在这套上实测过。Linux 的 systemd 与 Windows
 * 的服务注册各自还有一套没验过的细节，先如实报「这一版没接」，不猜着写。
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
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** 授权框等人点：给足三分钟，但别无限挂着。 */
const ELEVATE_TIMEOUT_MS = 180_000;
/** 装完等它把本地管理口听上。 */
const START_WAIT_MS = 15_000;

function platformKey(platform, arch) {
  const p = String(platform || process.platform);
  const a = String(arch || process.arch);
  if (p !== 'darwin') return '';
  if (a === 'arm64') return 'darwin-arm64';
  if (a === 'x64') return 'darwin-x64';
  return '';
}

function downloadUrl(key) {
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

/** `launchctl list <label>`：加载了就有输出，没加载退出码非 0。 */
function serviceLoaded(options = {}) {
  const run = typeof options.run === 'function' ? options.run : defaultRun;
  return run('launchctl', ['list', 'com.iepose.NodeBabyLinkService'], { timeoutMs: 5000 })
    .then((result) => result.code === 0 && /\bcom\.iepose\.NodeBabyLinkService\b/.test(result.stdout))
    .catch(() => false);
}

function defaultRun(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: opts.timeoutMs || 10_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** 本机装没装：服务定义与二进制都在，才算装过（只装了一半的照实报没装）。 */
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
 * 以管理员权限跑一段 shell。macOS 上就是系统自带的授权框（`do shell script ... with
 * administrator privileges`）；它会弹出 Touch ID / 密码，用户点一下确认，脚本才以 root 跑。
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

/**
 * 装好并拉起来。
 *
 * @returns {Promise<{ ok: boolean, installed: boolean, started: boolean, error: string }>}
 *   `ok=false` 时 `error` 是人能看懂的原因（下载失败 / 用户取消授权 / 服务没起来）。
 */
async function install(options = {}) {
  const key = options.platformKey || platformKey(options.platform, options.arch);
  if (!key) return { ok: false, installed: installedSync(), started: false, error: '这一版只接了 macOS 的自动安装' };
  if (installedSync() && await serviceLoaded(options)) {
    return { ok: true, installed: true, started: true, error: '' };
  }
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, installed: installedSync(), started: false, error: '当前环境没有可用的 fetch' };

  let temp = '';
  try {
    const response = await fetchImpl(downloadUrl(key), { redirect: 'follow' });
    if (!response || response.ok !== true) {
      return { ok: false, installed: installedSync(), started: false, error: `下载设备端失败（HTTP ${response && response.status ? response.status : '?'}）` };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!looksLikeMachO(buffer)) {
      return { ok: false, installed: installedSync(), started: false, error: '下载到的不是可执行文件，可能被网络拦截了' };
    }
    temp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-jdxb-bin-')), 'NodeBabyLinkService');
    fs.writeFileSync(temp, buffer, { mode: 0o700 });
  } catch (error) {
    return { ok: false, installed: installedSync(), started: false, error: `下载设备端失败：${error && error.message ? error.message : String(error)}` };
  }

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

  const elevated = await runElevated(script, options);
  try { fs.rmSync(path.dirname(temp), { recursive: true, force: true }); } catch {}
  if (elevated.code !== 0) {
    const detail = String(elevated.stderr || '').trim().split('\n').filter(Boolean).slice(-1)[0] || '';
    // 用户点了取消时 osascript 会回 -128；这时别报「安装失败」，说清是他取消了。
    const cancelled = /-128|User canceled/i.test(`${elevated.stderr || ''}${elevated.stdout || ''}`);
    return {
      ok: false,
      installed: installedSync(),
      started: false,
      error: cancelled ? '授权被取消，设备端没有安装' : `安装没成功${detail ? `：${detail}` : ''}`,
    };
  }

  // 脚本以 root 跑完了就当装上了：文件在不在不该由这个进程猜二遍（它也无权读 root 区）。
  // 真要用得起来看的是下面这条端口应答。
  const started = await waitForPort(options);
  return { ok: started, installed: true, started, error: started ? '' : '设备端装好了，但本地管理口没起来，请查看系统服务状态' };
}

/** 装完等管理口应答：`launchctl load` 返回不代表进程已经监听，别装完立刻报没起来。 */
async function waitForPort(options = {}) {
  const probe = typeof options.probePort === 'function' ? options.probePort : require('./probe.cjs').probePort;
  const port = Number(options.port) > 0 ? Number(options.port) : 2080;
  const deadline = Date.now() + (Number(options.waitMs) > 0 ? Number(options.waitMs) : START_WAIT_MS);
  while (Date.now() < deadline) {
    const result = await probe(port, { timeoutMs: 1500 });
    if (result && result.ok) return true;
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
  installedSync,
  serviceLoaded,
  install,
  waitForPort,
};
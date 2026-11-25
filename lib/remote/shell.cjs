// 远程电脑桌面端显示壳：按平台包找到随插件分发的可执行文件，用一次性入口拉起独立窗口。
// 2026-11-19：spawn 的失败是异步通知（ENOENT/EACCES 不会同步抛），记下 error、暴露「壳根本没起来」
// 的判据，让路由按 shellOpened:false 退回浏览器，和 900ms 内闪退同等处理。
// 2026-11-25：宽限之后才退出的进程另按退出原因分流——正常关窗（0 退出、无信号）不弹浏览器，
// 异常退出留一次性标记让前端补开；判据集中在本文件，不给各调用方各写一份。
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** 五个分发平台，与平台包 dsh-mobile-shell-<id> 一一对应。 */
const PLATFORM_IDS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'];

/** 平台包不可用时的统一错误码。 */
const SHELL_UNAVAILABLE = 'SHELL_UNAVAILABLE';

const DEV_ROOT = path.resolve(__dirname, '..', '..', '..');

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** 这台机器对应哪个平台包；没有对应包就返回 undefined。 */
function platformId(platform = process.platform, arch = process.arch) {
  const os = platform === 'win32' ? 'win32' : platform;
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch;
  const id = `${os}-${cpu}`;
  return PLATFORM_IDS.includes(id) ? id : undefined;
}

/** 平台包内可执行文件的相对路径（macOS 是 .app 包里的那个二进制）。 */
function binaryPath(platform) {
  if (platform === 'win32-x64') return 'dsh-mobile-shell.exe';
  if (platform.startsWith('darwin-')) return 'dsh-mobile-shell.app/Contents/MacOS/dsh-mobile-shell';
  return 'dsh-mobile-shell';
}

/** 只认本机代理给出的一次性入口：带端口的 http://127.0.0.1，不带账号密码。 */
function validRemoteUrl(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f]/.test(value)) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port)
    && !url.username && !url.password;
}

/**
 * 找桌面端可执行文件：先按本模块所在位置解析可选依赖（npm / pnpm 的嵌套与 hoisted 布局都
 * 命中），再退回调用方指定路径 / 当前工作目录，然后是开发产物与环境变量覆盖。找不到一律
 * 回 null，把这条通道标成不可用，不抛错、不影响插件其余功能。
 */
function resolveShell(options = {}) {
  const exists = options.exists || fs.existsSync;
  const platform = options.platformId || platformId(options.platform, options.arch);
  if (!platform) return null;
  const relative = binaryPath(platform);
  const pkg = `dsh-mobile-shell-${platform}`;
  for (const paths of [undefined, options.paths || [process.cwd()]]) {
    try {
      const manifest = require.resolve(`${pkg}/package.json`, paths ? { paths } : undefined);
      const candidate = path.join(path.dirname(manifest), relative);
      if (exists(candidate)) return candidate;
    } catch {
      /* 这一路没有：试下一路 */
    }
  }
  const override = (options.env || process.env).DSHM_MOBILE_SHELL;
  if (typeof override === 'string' && override && exists(override)) return override;
  // 随包分发的本机原生产物（开发机由 reload-dev 从 build/desktop-shell 拷进来）。
  const nativeRoot = options.nativeRoot || path.join(__dirname, '..', '..', 'native', 'desktop-shell');
  const native = path.join(nativeRoot, platform, relative);
  if (exists(native)) return native;
  const dev = path.join(options.devRoot || DEV_ROOT, 'build', 'desktop-shell', platform, relative);
  if (exists(dev)) return dev;
  return null;
}

/** 命令行参数固定两项：一次性地址与设备名，不经 shell、不拼命令。 */
function buildArgs({ url, deviceName } = {}) {
  return [`--remote-url=${url}`, `--device-name=${String(deviceName || '')}`];
}

/**
 * 一次点击拉起一个窗口：进程 detached、stdio 丢弃、unref，插件退出不拖着窗口。
 * 地址只来自 controller.open，校验过后交给参数数组，不写日志、不落盘。
 */
function launchShell({ url, deviceName } = {}, options = {}) {
  if (!validRemoteUrl(url)) throw failure('REMOTE_OPEN_URL');
  const binary = (options.resolve || resolveShell)(options);
  if (!binary) throw failure(SHELL_UNAVAILABLE);
  const launch = options.spawn || spawn;
  let child;
  try {
    child = launch(binary, buildArgs({ url, deviceName }), { detached: true, stdio: 'ignore', windowsHide: true });
  } catch {
    throw failure(SHELL_UNAVAILABLE);
  }
  // spawn 的失败要等下一拍才以 error 事件送到：这里记下来，判存活时按「根本没起来」处理；
  // 同时必须挂监听，否则未处理的 error 事件会让宿主崩掉。
  child?.on?.('error', (error) => { child.shellSpawnError = error; });
  child?.unref?.();
  return child;
}

/** 壳进程到底起没起来：没有 pid 或已收到 error，都说明可执行文件没能跑起来。 */
function spawnFailed(child) {
  return !child || child.pid === undefined || child.pid === null || Boolean(child.shellSpawnError);
}

/**
 * 宽限之后退出的进程算不算崩：正常关窗是自行以 0 退出、没有信号；非 0 退出码（Windows 的
 * 0xC0000409 / 0xC0000005 等 NTSTATUS、Rust panic 的 101 都在这里）和致命信号算异常。
 * 用户主动结束进程的 SIGTERM / SIGINT 不算崩，别把正常关窗变成弹浏览器。
 */
const FATAL_SIGNALS = new Set(['SIGSEGV', 'SIGABRT', 'SIGILL', 'SIGFPE', 'SIGBUS', 'SIGSYS']);
function shellCrashed(code, signal) {
  if (signal) return FATAL_SIGNALS.has(signal);
  return typeof code === 'number' && code !== 0;
}

module.exports = { PLATFORM_IDS, SHELL_UNAVAILABLE, platformId, binaryPath, resolveShell, buildArgs, launchShell, spawnFailed, shellCrashed };

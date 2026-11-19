'use strict';

// 2026-11-19：启动失败时把「系统拒绝执行」的具体原因和排查方向讲清楚，不再只甩一句 spawn UNKNOWN。

/**
 * 在本机跑一个 frpc 进程，让面板导入的 FRP 配置真正生效。
 *
 * 为什么单独一层：`provision.cjs` 只负责「弄到可执行文件」，这里负责「用一份配置把它跑起来
 * 并管住进程」。两件事分开，测试也能各测各的（这里注入假 spawn / 假 ensure，不真起进程）。
 *
 * 关键一步是**本地端口对齐**：面板导入的是服务商生成的配置，里面的 `localPort` 未必等于插件
 * 此刻真正监听的端口（端口被占用会退让、用户改过也另说）。照抄会让公网请求转到一个没人的端口。
 * 所以每次启动前都把配置里的 `localPort` 改成当前实际端口，再写盘、再起 frpc。
 *
 * 进程退出/起不来一律记进 `error`，不抛给调用方；`status()` 回一份可渲染的事实。frpc 自己会
 * 对 frps 重试，进程不会因为连不上服务器就退出，所以这里不做进程级自动重启。退出原因取自
 * 两路输出的尾部（frpc 把致命原因写在 stdout），且等 `close` 收全流再拼，别让人只看到退出码。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { dshHome } = require('../shared/paths.js');
const { ensureFrpc } = require('./provision.cjs');

/** 本机 frpc 管理接口的默认端口：只监听回环，用来读它实际分到的公网地址（remote_addr）。 */
const DEFAULT_ADMIN_PORT = 17401;

/** 把配置里每一处 `localPort / local_port` 改成实际端口，其余原样。 */
function alignLocalPort(text, port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value <= 0) return String(text || '');
  return String(text || '').replace(/^(\s*local(?:Port|_port)\s*[=:]\s*)["']?\d+["']?/gim, `$1${value}`);
}

/**
 * 给配置补一个本机管理接口（`webServer`），好让插件能读到 frpc 实际分到的公网地址。
 *
 * 服务商配置常常不写 `remotePort`（由服务端分配），地址只能从 frpc 的管理接口读。用户配置里
 * 已经有 `webServer` 就不动它，免得把人家自己的设置覆盖掉。只对带 `[[proxies]]` 的 TOML 生效
 * （INI 没这类顶层写法，跳过）。
 */
function withAdminPort(text, port) {
  const source = String(text || '');
  if (/(?:^|\n)\s*webServer\s*[.=]/i.test(source)) return source;
  if (!/\[\[\s*proxies\s*\]\]/i.test(source)) return source;
  const block = `webServer.addr = "127.0.0.1"\nwebServer.port = ${port}\n\n`;
  return source.replace(/(\[\[\s*proxies\s*\]\])/i, `${block}$1`);
}

/**
 * 把「进程起不来」的底层报错翻成用户能照着排查的话。
 *
 * 最常见的两种：Windows 上安全软件不让跑刚下载的 exe（Node 报 `spawn UNKNOWN`），以及文件
 * 根本不是这台机器能执行的东西（`ENOEXEC`、架构不符）。这两种在 Node 里都只是一句干巴巴的
 * `spawn UNKNOWN`，直接甩给用户等于什么也没说——所以带上文件位置，并指明该往哪查。
 */
function describeSpawnFailure(err, binary) {
  const code = err && err.code ? String(err.code) : '';
  const raw = err && err.message ? err.message : String(err || '未知错误');
  const where = binary ? `（${binary}）` : '';
  if (code === 'UNKNOWN') {
    return `系统拒绝运行 frpc${where}：多半是安全软件（如 Windows Defender）拦了这个程序，或下载到的版本与本机芯片不符。请把它加入杀毒/安全软件的信任名单，或换成与本机匹配的 frpc 版本。`;
  }
  if (code === 'ENOEXEC') {
    return `frpc${where} 不是这台机器能执行的程序：文件可能已损坏，或版本/架构不对。请重新获取一份与本机匹配的 frpc。`;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `系统不允许运行 frpc${where}：权限被拒。请检查这个文件是否被禁止执行或被安全策略拦截。`;
  }
  if (code === 'ENOENT') {
    return `找不到 frpc 可执行文件${where}：它可能已被删除或路径失效，请重新获取。`;
  }
  return `启动 frpc 失败：${raw}`;
}

function frpcPaths(root) {
  // 配置与「启用」标记放在**单独目录**：`provision` 的缓存根是 `<DSH 数据目录>/frpc`，它在
  // 装好新二进制后会清掉那里除版本号外的条目——放一起会把正在用的 frpc.toml 一起删掉。
  const dir = root || path.join(dshHome(), 'frpc-run');
  return { dir, config: path.join(dir, 'frpc.toml'), enabled: path.join(dir, 'frpc.enabled') };
}

/**
 * 造一个 frpc 运行器。
 *
 * options（都可注入，测试用）：
 *   root     缓存/配置目录（缺省 `<DSH 数据目录>/frpc`）
 *   portOf   `() => number`：当前插件实际监听端口（启动前用它改 localPort）
 *   ensure   `(opts) => Promise<{ok,path,message}>`：拿 frpc 可执行文件（缺省 provision.ensureFrpc）
 *   spawnImpl 子进程工厂（缺省 node:child_process.spawn）
 *   fsImpl   文件系统（缺省 node:fs，测试可造假）
 */
function createFrpcRunner(options = {}) {
  const paths = frpcPaths(options.root);
  const ensure = typeof options.ensure === 'function' ? options.ensure : ensureFrpc;
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn;
  const portOf = typeof options.portOf === 'function' ? options.portOf : () => null;
  const fsImpl = options.fsImpl || fs;
  const fetchImpl = options.fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  const adminPort = Number.isInteger(options.adminPort) ? options.adminPort : DEFAULT_ADMIN_PORT;

  let child = null;
  let binary = '';
  let error = '';
  let startedAt = 0;
  /** frpc 连上后服务端分给这条隧道的公网地址（`remote_addr`）；没读到就是空串。 */
  let remoteAddress = '';

  const exists = (p) => { try { return fsImpl.existsSync(p); } catch { return false; } };
  const readConfig = () => { try { return fsImpl.readFileSync(paths.config, 'utf8'); } catch { return null; } };

  function status() {
    const running = Boolean(child);
    return {
      available: Boolean(binary),
      running,
      pid: running && child.pid ? child.pid : null,
      error,
      startedAt,
      configPresent: exists(paths.config),
      remoteAddress: running ? remoteAddress : '',
    };
  }

  /** 把配置按「实际端口 + 本机管理接口」写好（localPort 对齐、补 webServer 好读公网地址）。 */
  function writeRunConfig(text) {
    const prepared = withAdminPort(alignLocalPort(text, Number(portOf())), adminPort);
    fsImpl.mkdirSync(paths.dir, { recursive: true });
    fsImpl.writeFileSync(paths.config, prepared);
    return prepared;
  }

  /** 保存导入的配置（localPort 对齐、补管理接口）并记下「启用」，重启宿主后自动再拉起。 */
  function saveConfig(text) {
    writeRunConfig(text);
    try { fsImpl.writeFileSync(paths.enabled, '1'); } catch { /* 标记落不下去下次手动起 */ }
    return paths.config;
  }

  /** 从管理接口的 `/api/status` 里挑出第一条代理的 `remote_addr`。 */
  function pickRemote(payload) {
    if (!payload || typeof payload !== 'object') return '';
    for (const group of Object.values(payload)) {
      if (!Array.isArray(group)) continue;
      for (const entry of group) {
        const addr = entry && typeof entry.remote_addr === 'string' ? entry.remote_addr.trim() : '';
        if (addr && addr.includes(':')) return addr;
      }
    }
    return '';
  }

  /**
   * 轮询 frpc 管理接口，拿到服务端实际分配的公网地址（`host:port`）。服务商配置不写 remotePort
   * 时，这是唯一能知道「手机该连哪」的地方。读不到返回空串，不抛。
   */
  async function discoverRemoteAddress(timeoutMs = 8000) {
    if (!fetchImpl) return '';
    const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 8000);
    const url = `http://127.0.0.1:${adminPort}/api/status`;
    while (Date.now() < deadline) {
      if (!child) return ''; // 进程都退了，别等了
      try {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), 1500) : null;
        let response;
        try {
          response = await fetchImpl(url, controller ? { signal: controller.signal } : {});
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (response && response.ok) {
          const addr = pickRemote(await response.json());
          if (addr) { remoteAddress = addr; return addr; }
        }
      } catch { /* 还没起来，接着轮 */ }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    return '';
  }

  async function start() {
    if (child) return status();
    const raw = readConfig();
    if (!raw) { error = '还没有导入 frpc 配置'; return status(); }
    try {
      writeRunConfig(raw);
    } catch (err) {
      error = `写 frpc 配置失败：${err && err.message ? err.message : err}`;
      return status();
    }
    const got = await ensure({});
    if (!got || got.ok !== true) {
      error = got && got.message ? got.message : '没拿到 frpc 可执行文件';
      return status();
    }
    binary = got.path;
    let proc;
    try {
      proc = spawnImpl(binary, ['-c', paths.config], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (err) {
      error = describeSpawnFailure(err, binary);
      child = null;
      return status();
    }
    child = proc;
    error = '';
    remoteAddress = '';
    startedAt = Date.now();
    let tail = '';
    // 两路输出都要收：frpc 把致命原因（token 错、配置解析失败、端口占用、登录失败退出）
    // 写在 stdout 上，只收 stderr 时用户只会看到「frpc 已退出（code=1）」这么一句。
    for (const stream of [proc.stdout, proc.stderr]) {
      if (!stream || typeof stream.on !== 'function') continue;
      if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8');
      stream.on('data', (chunk) => { tail = (tail + String(chunk)).slice(-1500); });
    }
    if (typeof proc.on === 'function') {
      proc.on('error', (err) => { error = describeSpawnFailure(err, binary); });
      // 用 close 而不是 exit：exit 触发时 stdio 里可能还有没读完的输出，太早拼文案会把
      // 刚写出来的原因丢掉；close 保证流都关了、tail 收全。
      proc.on('close', (code, signal) => {
        if (!child || child !== proc) return;
        child = null;
        remoteAddress = '';
        const lastLine = tail.trim() ? tail.trim().split('\n').pop() : '';
        error = `frpc 已退出（code=${code}${signal ? `, ${signal}` : ''}）${lastLine ? `：${lastLine}` : ''}`;
      });
    }
    return status();
  }

  async function stop() {
    if (!child) return status();
    const proc = child;
    child = null;
    try { proc.kill('SIGTERM'); } catch { /* 已经没了 */ }
    error = '';
    return status();
  }

  return {
    status,
    start,
    stop,
    async restart() { await stop(); return start(); },
    saveConfig,
    discoverRemoteAddress,
    /** 停掉进程并清掉「启用」标记（用户主动断开时用）。 */
    async clear() {
      try { fsImpl.rmSync(paths.enabled, { force: true }); } catch { /* 没有就算了 */ }
      return stop();
    },
    /** 宿主重启后要不要自动再拉起：上次是启用状态且配置还在。 */
    shouldAutoStart() { return exists(paths.enabled) && exists(paths.config); },
    dispose() { return stop(); },
    _paths: paths,
  };
}

module.exports = { createFrpcRunner, alignLocalPort, withAdminPort, frpcPaths };

'use strict';

/**
 * 手机直连隧道的电脑端助手进程：找得到就拉起、挂了重拉、退出收掉。
 *
 * 这个文件只管「进程」：助手在哪、怎么起、stdout 上那几行事件是什么意思。业务判断
 * （白名单该是谁、配对窗口什么时候开、状态存到哪）留给调用方——它通过 onEvent 收事件，
 * 通过 `persist` 事件里的 id 回执告诉助手「这笔改动存住了没有」。助手自己不留状态，
 * 所以插件永远只有一份真相。
 *
 * 二进制从按平台的 npm 包装出来（`dsh-mobile-tailcat-<平台>`），装不上就没有这条通道，
 * 其余功能一点不受影响——这也是不做运行时下载的理由：走的还是插件自己那条包管理器链路，
 * 国内镜像、完整性校验、断点重试都是包管理器现成的。
 *
 * 助手是 Go 编的原生程序，Windows 上是 .exe；它只监听回环（由插件告诉它本机端口），
 * 隧道里也只开一个固定端口。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 助手 IPC 版本，跟 tailcat-host/main.go 的 protoVersion 一起改。 */
const IPC_VERSION = 1;

/** 隧道里那个固定端口，与 tailcat-host/node.go 的 virtualPort 一致。 */
const TUNNEL_PORT = 48941;

/** 配对窗口那个端口，与 pairingPort 一致（手机侧知道它，但只需拨它一次）。 */
const PAIRING_PORT = 48942;

/** 一行 IPC 的上限，与助手的 lineLimit 一致。 */
const MAX_LINE = 64 * 1024;

/** 重启退避：起不来时别把机器打满。 */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** 事件里允许出现的键，多一个少一个都当脏数据丢掉（stdout 是私有 IPC）。 */
const EVENT_KEYS = {
  ready: ['address'],
  p2pReady: ['url', 'candidates'],
  p2pStopped: [],
  p2pStatus: ['running', 'url', 'path', 'active', 'detail', 'candidates'],
  p2pKeys: ['private', 'public', 'port'],
  pairing: ['address', 'port', 'key', 'proof', 'expiresAt'],
  paired: ['address', 'client'],
  pairingClosed: [],
  persist: ['id', 'state', 'allowedClients'],
  error: ['code'],
};

const ADDRESS = /^tc[\x21-\x7e]{0,4095}$/;
const PRIVATE_KEY = /^privkey:[0-9a-f]{64}$/;
const CLIENT_KEY = /^nodekey:[0-9a-f]{64}$/;
const PROOF = /^[A-Za-z0-9_-]{43}$/;

/** 这台机器对应哪个平台包（与 tools/build-tailcat-helper.mjs 的 id 一致）。 */
function platformId(platform = process.platform, arch = process.arch) {
  const os = platform === 'win32' ? 'win32' : platform;
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch;
  const id = `${os}-${cpu}`;
  return ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'].includes(id) ? id : undefined;
}

/**
 * 找助手二进制：先按平台包解析（npm 装出来的正常形态），找不到就回 null——
 * 调用方据此把这条通道标成「不可用」，不要抛错、不要影响插件启动。
 */
function resolveBinary(options = {}) {
  const platform = options.platformId || platformId(options.platform, options.arch);
  if (!platform) return null;
  const name = platform === 'win32-x64' ? 'dsh-tailcat-host.exe' : 'dsh-tailcat-host';
  const pkg = `dsh-mobile-tailcat-${platform}`;

  // 1. 平台包（可选依赖装出来的那份）。npm / pnpm 把可选依赖装在「插件自己这份 node_modules」里，
  //    所以先按本模块自身所在位置解析（从本文件往上找，嵌套与 hoisted 布局都命中）——运行时的工作
  //    目录（宿主可能是别处）跟安装目录不是一回事，只按工作目录找会在真实部署里找不到；再退回调用方
  //    指定路径 / 当前工作目录（老行为，部署方把包放在工作目录时仍可用）。
  for (const paths of [undefined, options.paths || [process.cwd()]]) {
    try {
      const manifest = require.resolve(`${pkg}/package.json`, paths ? { paths } : undefined);
      const candidate = path.join(path.dirname(manifest), name);
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* 这一路没有：试下一路 */
    }
  }

  // 2. 指定的路径（开发机、或者部署方自己放好的那一份）。
  const override = process.env.DSHM_TAILCAT_HELPER;
  if (typeof override === 'string' && override && fs.existsSync(override)) return override;

  // 3. 本仓交叉编译的产物（开发与自测用）。
  const dev = path.join(__dirname, '..', '..', '..', 'build', 'tailcat-runtime', platform, name);
  if (fs.existsSync(dev)) return dev;
  return null;
}

/**
 * 拉起一个助手进程。
 *
 * options:
 *   localPort        插件本机 HTTP 端口（隧道里唯一的去处）
 *   name             这台电脑的名字（手机配对时显示）
 *   state            上次存下来的身份（字符串）或 null
 *   allowedClients   已经配过对的手机公钥
 *   onEvent(event)   事件回调，event 已去掉 event 字段之外的脏数据
 *   resolve          覆盖二进制查找（测试用）
 */
function createTailcatHost(options) {
  const binary = (options.resolve || resolveBinary)(options);
  let child;
  let buffer = '';
  let closed = false;
  let restarts = 0;
  let backoffIndex = 0;
  let restartTimer;
  let ready = false;
  let address = '';

  const status = () => ({ available: Boolean(binary), running: Boolean(child), ready, address, restarts });

  function write(value) {
    if (!child || !child.stdin || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  function handleLine(line) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return; // 脏行直接丢，从不回显
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const kind = value.event;
    if (typeof kind !== 'string' || !EVENT_KEYS[kind]) return;
    const keys = Object.keys(value);
    const fields = EVENT_KEYS[kind];
    if (keys.length !== fields.length + 1 || fields.some(field => !(field in value))) return;

    if (kind === 'ready' && typeof value.address === 'string' && (value.address === '' || ADDRESS.test(value.address))) {
      ready = true;
      address = value.address;
      backoffIndex = 0;
    } else if (kind === 'pairing') {
      if (!ADDRESS.test(String(value.address)) || value.port !== PAIRING_PORT) return;
      if (!PRIVATE_KEY.test(String(value.key)) || !PROOF.test(String(value.proof))) return;
      if (!Number.isSafeInteger(value.expiresAt)) return;
    } else if (kind === 'paired') {
      if (!CLIENT_KEY.test(String(value.client)) || !ADDRESS.test(String(value.address))) return;
      address = value.address;
    } else if (kind === 'persist') {
      if (typeof value.id !== 'string' || value.id.length > 32) return;
      if (!Array.isArray(value.allowedClients)) return;
    } else if (kind === 'error') {
      if (typeof value.code !== 'string') return;
      // 助手的失败原因可能是底层网络 / 证书报错这类长串（例如取 DERP 地图时 x509 证书校验失败，
      // 见 A3-87 的坑）。早先按「超过 64 字就丢」直接吞掉，界面于是永远停在「正在启动」、
      // 看不到真正原因。这里只去掉控制字符、截断到上限，然后如实交给上层展示。
      value.code = value.code.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 512) || 'error';
      ready = false;
    }
    options.onEvent({ ...value });
  }

  function scheduleRestart() {
    if (closed || restartTimer) return;
    const delay = BACKOFF_MS[Math.min(backoffIndex, BACKOFF_MS.length - 1)];
    backoffIndex += 1;
    restarts += 1;
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      launch();
    }, delay);
    restartTimer.unref?.();
  }

  function launch() {
    if (closed || !binary) return;
    let proc;
    try {
      proc = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      scheduleRestart();
      return;
    }
    child = proc;
    buffer = '';
    ready = false;
    proc.on('error', () => {});
    proc.stdin?.on('error', () => {});
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', chunk => {
      if (child !== proc) return;
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        handleLine(line);
      }
      if (buffer.length > MAX_LINE) proc.kill();
    });
    proc.on('exit', () => {
      if (child !== proc) return;
      child = undefined;
      ready = false;
      address = '';
      if (!closed) scheduleRestart();
    });
    write({
      version: IPC_VERSION,
      localPort: options.localPort,
      name: String(options.name || os.hostname()).slice(0, 64),
      state: options.state === undefined ? null : options.state,
      allowedClients: Array.isArray(options.allowedClients) ? options.allowedClients : [],
    });
  }

  return {
    status,
    start() {
      if (closed || child) return;
      launch();
    },
    /** 开一个配对窗口（助手自己管两分钟过期）。 */
    pair(ttlSeconds) {
      write({ command: 'pair', ttl: ttlSeconds });
    },
    cancelPairing() {
      write({ command: 'cancelPairing' });
    },
    /** 换白名单（吊销手机就走这条）。 */
    setAllowed(allowedClients) {
      write({ command: 'setAllowed', allowedClients: allowedClients || [] });
    },
    /** 回执：state 存住了没有。 */
    ack(id, ok) {
      write({ command: 'ack', id, ok: Boolean(ok) });
    },
    /**
     * 拉起电脑侧的点对点隧道（P2P）。
     *
     * 与 `pair()` 那类「开会合窗口」不同：这条不需要窗口、也不要临时钥匙 —— 电脑的公钥
     * 与手机的公钥在配对时就换过了，之后每次起来都用同一对。所以它只有「起来 / 停下 / 问现状」
     * 三个动作。
     */
    startP2P(options) {
      const list = (value) => (Array.isArray(value) ? value.filter(item => typeof item === 'string') : []);
      write({
        command: 'p2pStart',
        p2pPrivateKey: String(options.privateKey || ''),
        p2pPeerKey: String(options.peerKey || ''),
        p2pPeerLocal: list(options.peerLocal),
        p2pPeerPublic: list(options.peerPublic),
        p2pListenPort: Number(options.listenPort) || 0,
        p2pTargetPort: Number(options.targetPort) || 0,
      });
    },
    stopP2P() {
      write({ command: 'p2pStop' });
    },
    statusP2P() {
      write({ command: 'p2pStatus' });
    },
    /** 生成一对新密钥（助手负责算，它才懂 WireGuard 的密钥格式）。 */
    newKeysP2P() {
      write({ command: 'p2pKeys' });
    },
    /** 测试缝：原样写一条命令。 */
    writeCommand(value) {
      write(value);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = undefined;
      const proc = child;
      child = undefined;
      if (!proc || proc.exitCode !== null) return;
      // 收起 stdin 就是助手的停止信号；它无视才强杀。
      await new Promise(done => {
        const timer = setTimeout(() => {
          proc.kill();
          done();
        }, 3_000);
        timer.unref?.();
        proc.once('exit', () => {
          clearTimeout(timer);
          done();
        });
        proc.stdin?.end();
      });
    },
  };
}

module.exports = {
  IPC_VERSION,
  TUNNEL_PORT,
  PAIRING_PORT,
  platformId,
  resolveBinary,
  createTailcatHost,
};

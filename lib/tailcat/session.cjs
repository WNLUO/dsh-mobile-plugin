'use strict';

/**
 * 直连隧道这一整套东西的宿主侧会话：拉起助手进程、把它的身份存进 relay.json、
 * 开配对窗口、同步白名单、给面板一份状态；每次取码等待独立结束并回收定时器。
 *
 * 只做「把助手和插件的存储接起来」，不掺 HTTP、不认识路由：路由那边拿 `status()` 和
 * `openPairingWindow()` 就行，面板那边同理。这样它能被单测直接驱动（假助手进程即可）。
 *
 * 三件必须一直成立：
 *   1. 存的是**助手自己的身份**（节点私钥 / 预共享密钥 / 区域），助手不落盘 —— 插件永远是
 *      唯一真相，用户重置插件不会留下一把孤儿钥匙。
 *   2. 配对窗口是一次性的：每次开窗口都换一把临时钥匙，换完（或过期）就作废。
 *   3. 手机被吊销时白名单立刻变，助手那边整体重启节点；失败就把白名单退回原样，不能出现
 *      「界面上已吊销、实际上还能连」。
 *
 * 助手是随插件装的可选依赖，插件加载时可能还没有（镜像跳过 optionalDependencies、装晚了、
 * 平台包没装）。所以「没找到」不能判死：开配对窗口 / 报名这些入口每次被调用时重探一次，
 * 装上了就正常拉起 —— 用户不用重开 DSH。平时不扫描，只在入口上探。
 */

const { createTailcatHost, resolveBinary, TUNNEL_PORT, PAIRING_PORT } = require('./host-process.cjs');

/** 开一个配对窗口最多等多久（拉起一个节点要 1~3 秒，弱网更久一点）。 */
const PAIRING_WINDOW_TIMEOUT_MS = 20_000;

/**
 * 让一台老设备进来时最多等多久（节点要整体重启一次）。
 *
 * 必须留在手机那一发的总预算之内（App 侧一次逻辑请求是 8 秒）：等满 15 秒的话手机先超时，
 * 界面上就变成「请求没送到电脑」，而电脑其实正在起节点。宁可早点认输 —— 手机 60 秒后会
 * 自己再问一次，那时候节点已经起来了，第一发就能拿到地址。
 */
const ENROLL_TIMEOUT_MS = 6_000;

/** 状态里放白名单与服务端身份的那几格（键名）。 */
const STATE = {
  enabled: 'tailcatEnabled',
  identity: 'tailcatState',
  allowed: 'tailcatAllowedClients',
};

/**
 * @param {object} options
 * @param {() => {enabled: boolean, identity: string|null, allowed: string[]}} options.readState 读盘上的隧道配置
 * @param {(patch: object) => void} options.writeState 写回（只写这三个键）
 * @param {number} options.localPort 插件本机端口，隧道里唯一的去处
 * @param {() => string} [options.hostName] 电脑名（手机配对时显示）
 * @param {(message: string) => void} [options.log] 诊断日志
 * @param {object} [options.host] 测试注入的助手句柄
 * @param {() => (string|null)} [options.resolveBinary] 测试注入的助手查找函数
 */
function createTailcatSession(options) {
  const log = options.log || (() => {});
  const findBinary = typeof options.resolveBinary === 'function' ? options.resolveBinary : resolveBinary;
  /**
   * 助手的二进制路径。找不到时留着 null —— 入口每次被调用时重探一次（`locate()`），
   * 而不是把这台机器永久判成「没有助手」。
   *
   * 注入了假助手句柄时不必真去磁盘上找（单测不该依赖本机有没有编译产物）；但给了
   * `resolveBinary` 就以它为准。
   */
  let binary = options.host && !options.resolveBinary ? 'injected' : findBinary();
  let host = null;
  let lastError = '';
  /** 正在等窗口的那次请求（一次只开一个窗口）。 */
  let pendingWindow = null;

  function snapshot() {
    try {
      const state = options.readState() || {};
      return {
        enabled: state[STATE.enabled] !== false,
        identity: typeof state[STATE.identity] === 'string' ? state[STATE.identity] : null,
        allowed: Array.isArray(state[STATE.allowed]) ? state[STATE.allowed] : [],
      };
    } catch {
      return { enabled: true, identity: null, allowed: [] };
    }
  }

  function persist(patch) {
    try {
      options.writeState(patch);
      return true;
    } catch (error) {
      log(`直连隧道：写配置失败 ${error && error.message ? error.message : error}`);
      return false;
    }
  }

  function settlePairingWindow(value) {
    const current = pendingWindow;
    if (!current) return;
    pendingWindow = null;
    clearTimeout(current.timer);
    current.resolve(value);
  }

  function handleEvent(event) {
    switch (event.event) {
      case 'ready':
        lastError = '';
        break;
      case 'pairing':
        settlePairingWindow({
          address: event.address,
          port: PAIRING_PORT,
          key: event.key,
          proof: event.proof,
          expiresAt: event.expiresAt,
        });
        break;
      case 'paired': {
        // 助手已经把手机加进白名单；存下来，并让二维码作废（码里那把钥匙只服务这一次）。
        const state = snapshot();
        const allowed = state.allowed.includes(event.client) ? state.allowed : [...state.allowed, event.client];
        persist({ [STATE.allowed]: allowed });
        settlePairingWindow(null);
        break;
      }
      case 'persist': {
        // 助手的身份（私钥 / 预共享密钥 / 区域）与白名单都落在这里；存住了才回执。
        const patch = { [STATE.allowed]: event.allowedClients };
        if (typeof event.state === 'string' && event.state) patch[STATE.identity] = event.state;
        const ok = persist(patch);
        host && host.ack(event.id, ok);
        break;
      }
      case 'pairingClosed':
        settlePairingWindow(null);
        break;
      case 'error':
        lastError = event.code;
        settlePairingWindow(null);
        break;
      default:
        break;
    }
  }

  /**
   * 找一次助手。已经找到就沿用（一次成功之后不会再变），没找到就趁入口这次机会再探一遍。
   *
   * 只在入口上调：助手是可选依赖，插件加载那一刻没有不代表这台机器装不上，等装上了下次
   * 开码 / 报名就能自己起来；反过来，没有人来用这条通道时也不值得每分钟去磁盘上找一次。
   */
  function locate() {
    if (binary) return binary;
    binary = findBinary();
    if (binary) log(`直连隧道：找到助手 ${binary}`);
    return binary;
  }

  function start() {
    if (host) return;
    if (!locate()) {
      lastError = 'helper-missing';
      return;
    }
    // 上一次没找到时留下的那条结论已经过时了：界面会把它当成「助手起不来」报错。
    if (lastError === 'helper-missing') lastError = '';
    const state = snapshot();
    if (!state.enabled) return;
    host = options.host || createTailcatHost({
      localPort: options.localPort,
      name: typeof options.hostName === 'function' ? options.hostName() : undefined,
      state: state.identity,
      allowedClients: state.allowed,
      onEvent: handleEvent,
    });
    host.start();
  }

  function stop() {
    settlePairingWindow(null);
    const current = host;
    host = null;
    if (current) return current.close();
    return Promise.resolve();
  }

  /**
   * 面板与路由看到的现状。
   *
   * 这里**不重探**：面板是每秒轮询这张状态的，探磁盘会把「找不到」变成一种常态开销。
   * `available: false` 只说明「这个会话到目前为止没找到助手」，下次有人开码 / 报名时
   * `locate()` 会再找一遍；找到了 `available` 跟着变真。
   */
  function status() {
    const state = snapshot();
    if (!binary) return { available: false, enabled: state.enabled, ready: false, address: '', paired: state.allowed.length, error: 'helper-missing' };
    const live = host && typeof host.status === 'function' ? host.status() : { running: false, ready: false, address: '' };
    return {
      available: true,
      enabled: state.enabled,
      running: Boolean(live.running),
      ready: Boolean(live.ready),
      address: live.address || '',
      paired: state.allowed.length,
      error: lastError,
    };
  }

  /**
   * 开一个配对窗口。成功给出发给手机的那三样（地址 / 一次性私钥 / 证明串）；
   * 拉不起节点或超时就给 null，调用方照「这次只能走原来的路子」处理。
   *
   * 入口这里就是那个「再找一次」的机会：助手装晚了也能从这一发开始用上。
   */
  function openPairingWindow(ttlSeconds) {
    start();
    if (!host) return Promise.resolve(null);
    if (pendingWindow) return pendingWindow.promise;
    let resolveFn;
    const promise = new Promise(resolve => {
      resolveFn = resolve;
    });
    const current = { promise, resolve: resolveFn, timer: null };
    pendingWindow = current;
    current.timer = setTimeout(() => {
      if (pendingWindow === current) settlePairingWindow(null);
    }, PAIRING_WINDOW_TIMEOUT_MS);
    current.timer.unref?.();
    try {
      host.pair(ttlSeconds);
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
      settlePairingWindow(null);
    }
    return promise;
  }

  /**
   * 让一台**已经配过对**的手机进来，并等回它的入口地址。
   *
   * 这是「插件更新之后手机不用重新扫码」的那条路：手机手上已经有这台电脑的凭据，只是
   * 还不知道有隧道这回事。它把自己的公钥发上来，我们加进白名单、把节点拉起来，再把它该拨
   * 的地址回给它 —— 与当初「宿主改了中转地址、手机跟着换」是同一套机制。
   *
   * 白名单变了节点要整体重启（v0.7 没有单独加人的接口），所以这里要等一小段。
   *
   * 与开码那一处同理：入口上再找一次助手，装晚了的那台手机不用等插件重载。
   */
  async function enroll(publicKey) {
    if (typeof publicKey !== 'string' || !publicKey.startsWith('nodekey:')) return null;
    start();
    if (!host) return null;
    const state = snapshot();
    if (!state.allowed.includes(publicKey)) {
      if (!setAllowed([...state.allowed, publicKey])) return null;
    }
    const deadline = Date.now() + ENROLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const live = status();
      if (live.address) return { address: live.address, port: TUNNEL_PORT };
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return null;
  }

  /** 换白名单（吊销手机、或者用户手动清空）。助手会整体重启节点。 */
  function setAllowed(allowedClients) {
    const allowed = Array.isArray(allowedClients) ? allowedClients : [];
    if (!persist({ [STATE.allowed]: allowed })) return false;
    host && host.setAllowed(allowed);
    return true;
  }

  /** 面板上的总开关。关掉就是停进程、白名单留着（再打开不用重新配对）。 */
  function setEnabled(enabled) {
    const next = Boolean(enabled);
    if (!persist({ [STATE.enabled]: next })) return false;
    if (next) start();
    else stop();
    return true;
  }

  return {
    start,
    stop,
    status,
    enroll,
    /** 测试缝：直接喂一条助手事件（真实路径是子进程 stdout）。 */
    _event: handleEvent,
    openPairingWindow,
    setAllowed,
    setEnabled,
    /** 供测试与诊断：当前配置里的白名单。 */
    allowedClients: () => snapshot().allowed,
    constants: { TUNNEL_PORT, PAIRING_PORT },
    stateKeys: STATE,
  };
}

module.exports = { createTailcatSession, STATE, TUNNEL_PORT, PAIRING_PORT };

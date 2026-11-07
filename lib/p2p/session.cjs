'use strict';

/**
 * 点对点隧道（P2P）的宿主侧会话：电脑这一半的身份、配对时换公钥、以及把它拉起来。
 *
 * 与直连隧道（`session.cjs`）刻意分成两个模块：那条要开会合窗口、要白名单、要区分
 * 「中继会合 / 直连」两种路径；这条**没有中继、也没有窗口** —— 两端的公钥在配对时换一次，
 * 之后就固定了，需要知道的只有「对方通到哪」（打洞候选）。混进同一个模块会让两边各有一半
 * 用不上的字段，也容易把「打不通报 nat-blocked」和「中继没会合」说成同一件事。
 *
 * 三件必须一直成立：
 *   1. 私钥落在插件自己的存储里（`relay.json`），助手不落盘 —— 插件永远是唯一真相。
 *   2. 公钥可以明着给出去：配对二维码里那份、以及 `/connection-info` 报的都是公钥。
 *   3. 打洞失败如实报，绝不改口成「已连通」：这条通道没有中继兜底，装不出来。
 *
 * 助手是可选依赖，插件加载时可能还没有。所以与直连隧道一样，只在入口上重探一次，
 * 不做定时扫描。
 */

const { createTailcatHost, resolveBinary } = require('../tailcat/host-process.cjs');

/** 存进 relay.json 的三个键（与直连隧道那一组并列，互不影响）。 */
const STATE = {
  enabled: 'p2pEnabled',
  privateKey: 'p2pPrivateKey',
  publicKey: 'p2pPublicKey',
};

/**
 * 电脑在**隧道里**听的那个端口（手机拨它）。与手机侧 `p2p.port` 同一个数。
 *
 * 它与「本机插件端口」是两件事：那个口是本机的，隧道里根本看不见。
 */
const P2P_PORT = 48950;

/** 把助手报上来的候选收成字符串数组（对端给的任何东西都当不可信数据）。 */
function candidateList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.length > 0 && item.length <= 64).slice(0, 16);
}

/** 等助手把隧道起来 / 报一次状态的上限。 */
const P2P_TIMEOUT_MS = 10_000;

/**
 * @param {object} options
 * @param {() => object} options.readState 读盘上的配置
 * @param {(patch: object) => void} options.writeState 写回
 * @param {number} options.localPort 插件本机端口（隧道里唯一的去处）
 * @param {(message: string) => void} [options.log]
 * @param {object} [options.host] 测试注入的助手句柄
 * @param {() => (string|null)} [options.resolveBinary] 测试注入的查找函数
 */
function createP2PSession(options) {
  const log = options.log || (() => {});
  const findBinary = typeof options.resolveBinary === 'function' ? options.resolveBinary : resolveBinary;
  let binary = options.host && !options.resolveBinary ? 'injected' : findBinary();
  let host = null;
  let lastError = '';
  /** 最近一次报上来的隧道现状（打洞是异步的，这个随时可能变）。 */
  let tunnel = { running: false, url: '', path: 'unknown', active: false, detail: '', candidates: [] };
  /** 正在等回执的那一次。 */
  let waiting = null;
  /** 最近一次配对换进来的手机公钥。 */
  let currentPeer = '';
  /** 上一次会合用的那份（peerKey + 候选），用来判「这次要不要重开」。 */
  let lastSignature = '';

  function snapshot() {
    try {
      const state = options.readState() || {};
      return {
        enabled: state[STATE.enabled] !== false,
        privateKey: typeof state[STATE.privateKey] === 'string' ? state[STATE.privateKey] : '',
        publicKey: typeof state[STATE.publicKey] === 'string' ? state[STATE.publicKey] : '',
      };
    } catch {
      return { enabled: true, privateKey: '', publicKey: '' };
    }
  }

  function persist(patch) {
    try {
      options.writeState(patch);
      return true;
    } catch (error) {
      log(`P2P 隧道：写配置失败 ${error && error.message ? error.message : error}`);
      return false;
    }
  }

  function settle(value) {
    if (!waiting) return;
    const done = waiting;
    waiting = null;
    clearTimeout(done.timer);
    done.resolve(value);
  }

  function handleEvent(event) {
    switch (event.event) {
      case 'p2pReady':
        lastError = '';
        tunnel = {
          ...tunnel,
          running: true,
          url: typeof event.url === 'string' ? event.url : '',
          candidates: candidateList(event.candidates),
        };
        // 候选必须带出去：会合那一发要把它还给手机，否则手机不知道往哪打洞。
        settle({ ok: true, url: tunnel.url, candidates: candidateList(event.candidates) });
        break;
      case 'p2pStatus':
        tunnel = {
          running: Boolean(event.running),
          url: typeof event.url === 'string' ? event.url : '',
          path: event.path === 'direct' || event.path === 'failed' ? event.path : 'unknown',
          active: event.active === true,
          detail: typeof event.detail === 'string' ? event.detail : '',
          candidates: candidateList(event.candidates),
        };
        settle({ ok: true, ...tunnel, candidates: candidateList(event.candidates) });
        break;
      case 'p2pKeys':
        // 助手生成了密钥对：私钥存插件、公钥留给配对与状态用（公钥可以明着给出去）。
        if (typeof event.private === 'string' && typeof event.public === 'string') {
          persist({ [STATE.privateKey]: event.private, [STATE.publicKey]: event.public });
        }
        settle({ ok: true, publicKey: typeof event.public === 'string' ? event.public : '' });
        break;
      case 'p2pStopped':
        tunnel = { running: false, url: '', path: 'unknown', active: false, detail: '', candidates: [] };
    lastSignature = '';
        settle({ ok: true, running: false });
        break;
      case 'error':
        lastError = event.code;
        settle({ ok: false, code: event.code });
        break;
      default:
        break;
    }
  }

  /** 只在入口上重探一次（与直连隧道同一条规矩：不做定时扫描）。 */
  function locate() {
    if (binary) return binary;
    binary = findBinary();
    if (binary) log(`P2P 隧道：找到助手 ${binary}`);
    return binary;
  }

  function start() {
    if (host) return host;
    if (!locate()) {
      lastError = 'helper-missing';
      return null;
    }
    if (lastError === 'helper-missing') lastError = '';
    const state = snapshot();
    if (!state.enabled) return null;
    host = options.host || createTailcatHost({
      localPort: options.localPort,
      state: null,
      // P2P 没有白名单：能连上的前提是握手时用的那把私钥对得上，比白名单更直接。
      allowedClients: [],
      onEvent: handleEvent,
    });
    host.start();
    return host;
  }

  function stop() {
    const current = host;
    host = null;
    tunnel = { running: false, url: '', path: 'unknown', active: false, detail: '', candidates: [] };
    lastSignature = '';
    if (current) return current.close();
    return Promise.resolve();
  }

  /**
   * 配对时换一次公钥：手机把自己的公钥报上来，同时拿走电脑这把。
   *
   * 电脑的密钥对在第一次被问到时生成一次，之后一直用同一对 —— 换一对等于所有已配对
   * 手机都得重新配，那没有理由。
   */
  function exchange(peerPublicKey) {
    const state = snapshot();
    if (!state.privateKey || !state.publicKey) {
      // 还没生成过密钥对：这一步要等助手（Go 那边生成，它才懂 WireGuard 的密钥格式）。
      // 入口上先**把助手拉起来**再催一次 —— 只 `if (host)` 的话，助手还没起来时这一催就是空的，
      // 于是下次开码还是拿不到身份，用户看到的是「扫了码但没有这条通道」。
      const live = start();
      if (live && typeof live.newKeysP2P === 'function') live.newKeysP2P();
      return { ok: false, error: 'no-identity', port: P2P_PORT };
    }
    if (typeof peerPublicKey === 'string' && peerPublicKey) {
      persist({ [STATE.peerKey]: peerPublicKey });
      currentPeer = peerPublicKey;
    }
    return { ok: true, publicKey: state.publicKey, port: P2P_PORT, peerKey: peerPublicKey };
  }

  /** 面板与路由看到的现状。这里不重探，理由同直连隧道那条。 */
  function status() {
    const state = snapshot();
    if (!binary) {
      return {
        available: false,
        enabled: state.enabled,
        ready: false,
        url: '',
        path: 'unknown',
        active: false,
        error: 'helper-missing',
      };
    }
    return {
      available: true,
      enabled: state.enabled,
      ready: tunnel.running,
      url: tunnel.url,
      path: tunnel.path,
      active: tunnel.active,
      detail: tunnel.detail,
      error: lastError,
    };
  }

  /**
   * 按手机给的公钥与候选把电脑侧那一半拉起来。
   *
   * 每次都先问一次现状：手机可能已经打通了（进程刚重启过、助手还在跑），那就直接复用，
   * 不要重新起一条 —— 同一条通道起两条会让两边都拿不到稳定路径。
   */
  /**
   * 按手机给的候选把电脑侧那一半拉起来，并回手机要的那份（我自己这边的候选）。
   *
   * **幂等**：会合是手机每 60 秒会再来一次的心跳。候选没变、隧道又在跑，就直接把现状
   * 回过去，**绝不重开** —— 重开等于把已经打通的洞每分钟踢掉一次，用户感受到的就是
   * 「网一会儿通一会儿断」。
   */
  function open(options = {}) {
    const current = start();
    if (!current) return Promise.resolve(null);
    const state = snapshot();
    if (!state.privateKey || !state.publicKey) return Promise.resolve(null);

    const peerKey = String(options.peerKey || currentPeer || '');
    const candidates = Array.isArray(options.candidates) ? options.candidates : [];
    const localCandidates = Array.isArray(options.localCandidates) ? options.localCandidates : [];
    const signature = JSON.stringify([peerKey, [...candidates].sort(), [...localCandidates].sort()]);

    // 同一次会合又来一遍：直接把现状给回去，不重开。
    if (tunnel.running && signature === lastSignature) {
      return Promise.resolve({
        ok: true,
        running: true,
        url: tunnel.url,
        path: tunnel.path,
        active: tunnel.active,
        candidates: tunnel.candidates || [],
      });
    }
    lastSignature = signature;

    return new Promise((resolve) => {
      waiting = {
        resolve,
        timer: setTimeout(() => settle(null), P2P_TIMEOUT_MS),
      };
      waiting.timer.unref?.();
      current.startP2P({
        privateKey: state.privateKey,
        peerKey,
        peerPublic: candidates,
        peerLocal: localCandidates,
        // 两个端口各司其职：listen 是手机在隧道里拨的，target 是本机插件在听的那个。
        listenPort: P2P_PORT,
        targetPort: Number(options.targetPort) || 0,
      });
    });
  }

  /** 问一次「打通了没有」。打洞是异步的，界面轮询这条。 */
  function refresh() {
    if (!host) return Promise.resolve(null);
    return new Promise((resolve) => {
      waiting = {
        resolve,
        timer: setTimeout(() => settle(null), P2P_TIMEOUT_MS),
      };
      waiting.timer.unref?.();
      host.statusP2P();
    });
  }

  return {
    start,
    stop,
    status,
    open,
    refresh,
    exchange,
    /** 测试缝：直接喂一条助手事件（真实路径是子进程 stdout）。 */
    _event: handleEvent,
    constants: { P2P_PORT },
    stateKeys: STATE,
  };
}

module.exports = { createP2PSession, STATE, P2P_PORT };

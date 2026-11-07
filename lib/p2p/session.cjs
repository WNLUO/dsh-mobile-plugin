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

/** 存进 relay.json 的四个键（与直连隧道那一组并列，互不影响）。 */
const STATE = {
  enabled: 'p2pEnabled',
  privateKey: 'p2pPrivateKey',
  publicKey: 'p2pPublicKey',
  /** 对端（手机）那把公钥：配对或会合时换进来的，拉起隧道时要拿它对握手。 */
  peerKey: 'p2pPeerKey',
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
  /** 最近一次配对 / 会合换进来的手机公钥。空串时会从盘上那份读回来。 */
  let currentPeer = '';
  /** 上一次会合用的那份（peerKey + 候选），用来判「这次要不要重开」。 */
  let lastSignature = '';
  /** 状态轮询定时器与开关（见 `watch`）。 */
  let timer = null;
  let polling = false;
  /** 这一进程里有没有真的被会合拉起过一条隧道（用来区分「还没人接」与「正在起」）。 */
  let everOpened = false;

  function snapshot() {
    try {
      const state = options.readState() || {};
      return {
        enabled: state[STATE.enabled] !== false,
        privateKey: typeof state[STATE.privateKey] === 'string' ? state[STATE.privateKey] : '',
        publicKey: typeof state[STATE.publicKey] === 'string' ? state[STATE.publicKey] : '',
        // 对端公钥：进程重启之后 `currentPeer` 是空的，得从盘上那份接回来 —— 否则电脑会用
        // 空的对端公钥去配设备，起不来，表现成「这条通道一直在启动中」。
        peerKey: typeof state[STATE.peerKey] === 'string' ? state[STATE.peerKey] : '',
      };
    } catch {
      return { enabled: true, privateKey: '', publicKey: '', peerKey: '' };
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
          // 助手报的 path 有四种：direct / failed / punching（在打）/ waiting（等人来打）。
          // 后两种都不是终态，但对界面来说「在打」与「在等」必须分得开。
          path: event.path === 'direct' || event.path === 'failed'
            || event.path === 'punching' || event.path === 'waiting'
            ? event.path
            : 'unknown',
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
    // 还没生成过密钥对就先催一次。
    //
    // **不能只在配对那一刻催**：面板要显示「我这边的公钥」，手机要拿它配对端，而这两件事
    // 都不该等到有人点开二维码才发生。更关键的是——不催就不会有 `p2pKeys` 事件，
    // 也就没有公钥；面板上那格永远是空、状态永远是「正在启动」。早先只有 `exchange()`
    // 里那一处催法，于是没开过码的机器上这条通道一直是死的。
    if (!state.privateKey || !state.publicKey) {
      if (typeof host.newKeysP2P === 'function') host.newKeysP2P();
    }
    return host;
  }

  function stop() {
    unwatch();
    everOpened = false;
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
    // 候选也要带出去：二维码里那一段是手机打洞的起点，空着就只能靠「只听不打」等握手。
    return {
      ok: true,
      publicKey: state.publicKey,
      port: P2P_PORT,
      peerKey: peerPublicKey,
      candidates: tunnel.candidates || [],
      localCandidates: [],
    };
  }

  /** 面板与路由看到的现状。这里不重探，理由同直连隧道那条。 */
  function status() {
    const state = snapshot();
    if (!binary) {
      return {
        available: false,
        enabled: state.enabled,
        ready: false,
        started: false,
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
      // 有没有被手机叫起来过。`ready:false` + `started:false` 说的不是「正在启动」，
      // 而是「还没有手机来会合」—— 电脑这半边本来就是等人来打（「只听不打」）。
      started: everOpened,
      url: tunnel.url,
      path: tunnel.path,
      active: tunnel.active,
      detail: tunnel.detail,
      // 我自己的打洞候选也要给出去：手机那半边靠它知道往哪打。
      candidates: tunnel.candidates || [],
      publicKey: state.publicKey,
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
    everOpened = true;
    const current = start();
    if (!current) return Promise.resolve(null);
    const state = snapshot();
    if (!state.privateKey || !state.publicKey) return Promise.resolve(null);

    // 手机把自己的公钥带过来了：存下来、当场用上。只有两端公钥互相对得上，WireGuard 才肯
    // 完成握手 —— 拿不到手机那把，电脑配给设备的对端公钥要么是空的（起不来）、要么是上一台
    // 手机的（握手永远失败，看着像「打洞打不通」）。
    const phonePublicKey = typeof options.phonePublicKey === 'string' ? options.phonePublicKey.trim() : '';
    if (phonePublicKey) {
      if (phonePublicKey !== currentPeer) persist({ [STATE.peerKey]: phonePublicKey });
      currentPeer = phonePublicKey;
    }
    const peerKey = String(options.peerKey || currentPeer || snapshot().peerKey || '');
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
        // 我这一把公钥：会合回包要把它带给手机（手机拿它配对端）。
        publicKey: state.publicKey,
      });
    }
    lastSignature = signature;

    return new Promise((resolve) => {
      waiting = {
        // 助手回的那几格（url / path / candidates）里没有公钥，在这里补上 —— 会合回包要用。
        //
        // **回调里顺手开轮询**：会合这一发只等到「本机这半边起来了」（`p2pReady`），
        // 打洞结果要再问几次才有。不定时问的话，`path` 会一直停在这一刻的值上 ——
        // 界面就永远显示「正在打洞」或者干脆「未知」。
        resolve: reply => {
          watch();
          resolve(reply && reply.ok ? { ...reply, publicKey: state.publicKey } : reply);
        },
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

  /**
   * 定时问一次现状。
   *
   * **面板与 `/api/relay/p2p` 读的都是 `tunnel` 那一格，而它只会被助手的事件更新** ——
   * 没人问，助手就不报；没人报，面板就永远停在「正在启动」。早先 `refresh()` 写好了却
   * 没有任何调用点（路由与面板都没接），于是这条通道在界面上永远是「正在启动」，
   * 哪怕它其实起得挺好。
   *
   * 只在**已经拉起过隧道**之后才问：没起过时不发，免得给一个必然超时的空转。
   * `unref` 掉，别让这个定时器把进程钉住。
   */
  function watch(intervalMs = 2000) {
    if (polling) return;
    polling = true;
    const tick = () => {
      if (!host) return;
      void refresh();
    };
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  }

  function unwatch() {
    polling = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    status,
    open,
    refresh,
    watch,
    unwatch,
    exchange,
    /** 测试缝：直接喂一条助手事件（真实路径是子进程 stdout）。 */
    _event: handleEvent,
    constants: { P2P_PORT },
    stateKeys: STATE,
  };
}

module.exports = { createP2PSession, STATE, P2P_PORT };

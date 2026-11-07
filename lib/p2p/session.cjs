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

/**
 * 一份候选的**规范化集合**：去重、排序。
 *
 * 用集合而不是列表比：手机每次报上来的顺序本来就不稳定（STUN 各家回的先后、网卡枚举的
 * 先后都会变），按顺序比会把「一模一样的一份地址」判成变了，于是每轮会合都重开一次 ——
 * 那等于每分钟把已经打通的洞踢掉一次。
 *
 * 公网与私网两格分开比、不合成一坨：助手拿它们做的不是一件事（公网那份是打洞目标，
 * 私网那份是同一张网里的一跳），把「同一个地址从私网那格挪到公网那格」当成没变是错的。
 */
function candidateSet(value) {
  return [...new Set(candidateList(value))].sort();
}

function sameCandidates(left, right) {
  return left.public.length === right.public.length
    && left.public.every((item, index) => item === right.public[index])
    && left.local.length === right.local.length
    && left.local.every((item, index) => item === right.local[index]);
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
  /**
   * 正在等助手回执的那些请求（**一组，不是一个**）。
   *
   * 早先这里只放得下「一个」，而会话起好之后状态轮询每 2 秒就要问一次现状、它也会占这个位。
   * 后果很致命：手机的会合请求刚把等待位放进去，下一拍轮询就把它顶掉，于是助手回的那条
   * `p2pReady` 交给了轮询、会合这一发永远等不到回执 —— 表现是「会合必超时、这条路永远接不上」，
   * 而电脑那头一切正常。轮询与会合本来就会同时等着，两个都得能收到同一条事件。
   */
  const waiters = new Set();
  /** 最近一次配对 / 会合换进来的手机公钥。空串时会从盘上那份读回来。 */
  let currentPeer = '';
  /**
   * 正在跑的那条隧道**配的是哪把手机公钥**（空串＝还没起来）。
   *
   * 单独记一格而不是从 `currentPeer` 推：`currentPeer` 在会合一开始就被新来那台手机改写了，
   * 而此刻隧道里跑的仍是上一台。拿它当判据就等于「已经换成新的了」，于是换设备时永不重开 ——
   * 隧道里对端还是旧的，新手机发多少包都进不来。
   */
  let runningPeer = '';
  /**
   * 正在跑的那条隧道是**按哪份候选**起来的（规范化后的集合，排序过的）。
   *
   * 单独记一格的理由与 `runningPeer` 同源：「隧道在跑」不等于「跑的就是你现在这份候选」。
   * 电脑第一次往往是在手机还没报出候选时以「只听不打」起来的；之后手机把真实候选报上来，
   * 若只判公钥，电脑就一直复用一个没有任何对端地址的隧道 —— 永远不往手机打，公网永远不通
   * （局域网还能通，只因为手机摸得到电脑的内网地址、先打过来了）。
   */
  let runningCandidates = { public: [], local: [] };
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
    for (const done of [...waiters]) {
      waiters.delete(done);
      clearTimeout(done.timer);
      done.resolve(value);
    }
  }

  /** 排一个等待者，超时自己摘掉（助手没答就回 null，别把内存漏下去）。 */
  function await_(resolve) {
    const done = {
      resolve,
      timer: setTimeout(() => {
        waiters.delete(done);
        resolve(null);
      }, P2P_TIMEOUT_MS),
    };
    done.timer.unref?.();
    waiters.add(done);
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
        runningPeer = '';
        runningCandidates = { public: [], local: [] };
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
    runningPeer = '';
    runningCandidates = { public: [], local: [] };
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
   * 按手机给的公钥与候选把电脑侧那一半拉起来，并回手机要的那份（我自己这边的候选）。
   *
   * **幂等**：会合是手机每 60 秒会再来一次的心跳。同一把手机公钥、同一份候选、隧道又在跑，
   * 就直接把现状回过去，**绝不重开** —— 重开等于把已经打通的洞每分钟踢掉一次，用户感受到
   * 的就是「网一会儿通一会儿断」。候选**真的变了**才按新的重开（见下面判据那一段）。
   *
   * 同一条通道不并存两条：每次进来先看现状，能复用就复用。
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
    //
    // **对端只认这一格**。手机发来的 `peerKey` 里装的是**电脑自己的公钥**（它拿它确认「对面
    // 是那台电脑」），早先这里 `options.peerKey || currentPeer` 直接取前者，于是把电脑自己的
    // 公钥配成了 WireGuard 对端 —— 电脑在跟自己握手。洞照样能开（UDP 打洞与密钥无关，所以
    // `path` 会报 `direct`、面板一片绿），但数据面一个包也过不去，手机那条回环端口连上去
    // 永远没有响应。这一格的名字与语义错位了一年，别再把它当对端用。
    const phonePublicKey = typeof options.phonePublicKey === 'string' ? options.phonePublicKey.trim() : '';
    // 先只**算**出这次该用哪把对端公钥，**不落盘**：是不是「同一台手机」的判据要用到它，
    // 而被 busy 拒掉的那一台绝不能把盘上那份改掉 —— 否则下一轮原来那台来会合时，
    // `peerKey === runningPeer` 不成立，反被当成另一台，谁也用不了。
    const peerKey = String(phonePublicKey || currentPeer || snapshot().peerKey || '');
    // 打一行现场：两端公钥对不对得上，是这条通道唯一真正致命的判据 ——
    // 错了洞照样开、`path` 照样报 `direct`，但数据面一个包都过不去，从现象上看不出区别。
    log(`P2P 隧道：会合 phonePublicKey=${phonePublicKey ? `${phonePublicKey.slice(0, 6)}…` : '(空)'}`
      + ` 采用的对端=${peerKey ? `${peerKey.slice(0, 6)}…` : '(空)'}`
      + ` 自己=${state.publicKey.slice(0, 6)}… 在跑=${tunnel.running} 在跑的对端=${runningPeer ? `${runningPeer.slice(0, 6)}…` : '(无)'}`);
    const candidates = Array.isArray(options.candidates) ? options.candidates : [];
    const localCandidates = Array.isArray(options.localCandidates) ? options.localCandidates : [];

    // **同一把手机公钥 + 同一份候选，才复用。**
    //
    // 早先写的是「隧道只要在跑就复用」，理由是候选变化不该踢掉已经打通的洞 —— 那一条仍然
    // 成立（候选变化由分流器从来包自己学）。但「在跑」不足以说明「跑的是你」：这条通道一次
    // 只服务一个对端，多台手机同时来会合时，谁先来隧道就归谁，后来那台每次会合都只拿到别人的
    // 现状 —— 它自己的握手一个包都进不来，而电脑面板显示得好好地在跑。
    // 所以判据收窄成「正在跑 + 跑的就是你这把公钥 + 你这把是真有」。
    //
    // **候选也得一起判**（2026-11-07 补，公网打不通的头号原因）：电脑第一次往往是在手机还没
    // 报出候选时以「只听不打」起来的，之后手机把真实候选报上来；只判公钥就一直复用那个没有
    // 对端地址的隧道，电脑永远不往手机打。局域网还好（手机摸得到内网地址、从那边打过来了），
    // 一到公网就只剩下「等待」。
    //
    // 两份都齐了才复用：候选**集合相等**（不是顺序相等，见 `candidateSet`）。候选真的变了才
    // 重开 —— 重开等于把已经打通的洞踢掉一次，每轮（60 秒）都重开就是「网一分钟断一次」。
    const wantedCandidates = { public: candidateSet(candidates), local: candidateSet(localCandidates) };
    if (tunnel.running && peerKey && peerKey === runningPeer
      && sameCandidates(wantedCandidates, runningCandidates)) {
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
    // **另一台手机正在用，就如实说「被占用」，绝不去抢。**
    //
    // 这条通道一次只服务一个对端。早先这里是「换设备就重开」，本意是别让后来者永远排在旧
    // 的后头 —— 但那条判据在多设备同时在线时变成互相抢：A 起来 → B 起来把 A 踢掉 → 下一轮
    // A 又把 B 踢掉。每抢一次 socket 端口都换一个，两端手里的候选永远对不上，打洞永远打不穿，
    // 面板上却老老实实报 `punching` / `failed`，看起来像 NAT 太严。真机上一台平板、一台手机
    // 同时开着就是这个场面。
    //
    // 所以退回「谁先来归谁」，后来者拿到一句明确的不可用 + 原因，过一会儿再问（它那条定时
    // 会合本来就在跑）。换手机的正确入口是让原来那台停下来（关 App / 换设备），不是抢。
    if (tunnel.running && peerKey && peerKey !== runningPeer) {
      log(`P2P 隧道：已有另一台手机在用（在跑的对端=${runningPeer.slice(0, 6)}…），这次不抢`);
      return Promise.resolve({
        ok: false,
        code: 'busy',
        publicKey: state.publicKey,
      });
    }

    // 过了 busy 与复用的两道门，才把对端公钥落盘 —— 顺序反过来的话，被 busy 拒掉的那台
    // 会改掉盘上的对端，下一轮原来那台就被判成「另一台」。
    if (peerKey && peerKey !== currentPeer) persist({ [STATE.peerKey]: peerKey });
    if (peerKey) currentPeer = peerKey;

    return new Promise((resolve) => {
      // 助手回的那几格（url / path / candidates）里没有公钥，在这里补上 —— 会合回包要用。
      // **回调里顺手开轮询**：会合只等到「本机这半边起来了」，打洞结果要再问几次才有。
      await_((reply) => {
        watch();
        resolve(reply && reply.ok ? { ...reply, publicKey: state.publicKey } : reply);
      });
      // 记下「这条隧道是按谁的公钥、按哪份候选起来的」：下一次会合据此判要不要重开。
      // 在这里记而不是等 `p2pReady`：请求已经发给助手了，这中间再来一发会合必须认同一份，
      // 否则会连发两条 `p2pStart`，两条各自开一次 socket、洞白开。
      runningPeer = peerKey;
      runningCandidates = wantedCandidates;
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
      await_(resolve);
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

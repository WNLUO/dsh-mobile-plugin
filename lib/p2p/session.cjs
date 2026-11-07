'use strict';

/**
 * 点对点隧道（P2P）的宿主侧会话：电脑这一半的身份、配对时换公钥、以及把它拉起来。
 *
 * 与直连隧道（`session.cjs`）刻意分成两个模块：那条要开会合窗口、要白名单、要区分
 * 「中继会合 / 直连」两种路径；这条**没有中继、也没有窗口** —— 两端的公钥在配对时换一次，
 * 之后就固定了，需要知道的只有「对方通到哪」（打洞候选）。混进同一个模块会让两边各有一半
 * 用不上的字段，也容易把「打不通报 nat-blocked」和「中继没会合」说成同一件事。
 *
 * **一台电脑同时服务多台手机**：每把手机公钥各有一套状态（`peers` 那张表），助手那边每条
 * 隧道也各是独立的 netstack，同一个隧道内端口在各自栈里互不冲突。所以这里不再有「谁先来
 * 归谁、后来者回 busy」—— 那种退让是单条隧道时的权宜，多台共存之后它只会把第二台永远挡在
 * 外面。
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
 * 它与「本机插件端口」是两件事：那个口是本机的，隧道里根本看不见。多台手机也是同一个
 * 数 —— 每条隧道各有独立的用户态网络栈，同一个端口号在各自栈里互不冲突。
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

/** 助手报的 path 有四种：direct / failed / punching（在打）/ waiting（等人来打）。 */
function normalizePath(value) {
  return value === 'direct' || value === 'failed' || value === 'punching' || value === 'waiting'
    ? value
    : 'unknown';
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

  /** 一套「某台手机那条隧道」的状态。字段与 `status()` 的对外字段同名，别改。 */
  function emptyTunnel() {
    return {
      running: false,
      url: '',
      path: 'unknown',
      active: false,
      detail: '',
      candidates: [],
    };
  }

  /**
   * 按手机公钥的那张表：每把公钥一套 `{ ...tunnel, runningCandidates, dialing, stamp }`。
   *
   * `runningCandidates` 单独记一格的理由与单条时代一样：「隧道在跑」不等于「跑的就是你现在
   * 这份候选」。电脑第一次往往是在手机还没报出候选时以「只听不打」起来的；之后手机把真实
   * 候选报上来，若只判公钥，就永远复用一个没有对端地址的隧道 —— 永远不往手机打，公网永远
   * 不通（局域网能通只因为手机摸得到电脑的内网地址、先打过来了）。
   *
   * `dialing`：命令已经发给助手、还没收到回执。这中间再来一发会合必须认同一份，否则会连发
   * 两条 `p2pStart`，两条各自开一次 socket、洞白开。
   *
   * `stamp`：最近一次被动到的顺序。`status()` 那几格老字段取「最近活跃的那条」，靠它排。
   *
   * 空串那把是**匿名槽**：老助手的事件里没有 `peerKey`、而这次会话又还没收到过任何手机
   * 公钥时，事件落在它上面。它不进 `status().peers` 的详单。
   */
  const peers = new Map();
  let stampSeq = 0;

  function ensurePeer(key) {
    let entry = peers.get(key);
    if (!entry) {
      entry = { ...emptyTunnel(), runningCandidates: { public: [], local: [] }, dialing: false, stamp: 0 };
      peers.set(key, entry);
    }
    entry.stamp = ++stampSeq;
    return entry;
  }

  /** 最近活跃的那一条（没有就是 null）。 */
  function recentPeer() {
    let best = null;
    for (const entry of peers.values()) {
      if (!best || entry.stamp > best.stamp) best = entry;
    }
    return best;
  }

  /**
   * 助手发来的事件属于哪一台手机。
   *
   * 新助手会带 `peerKey`（手机公钥），按它路由。**老助手不带**：退回「最近会合的那一台」；
   * 连那一台都还没有、而表里恰好只有一把公钥时就用它；什么都没有就落进匿名槽。任何一条
   * 退路都不抛错 —— 老助手配新插件必须照常能用。
   */
  function routeKey(event) {
    const announced = typeof event.peerKey === 'string' ? event.peerKey.trim() : '';
    if (announced) {
      lastPeer = announced;
      return announced;
    }
    if (lastPeer) return lastPeer;
    const named = [...peers.keys()].filter(key => key);
    return named.length === 1 ? named[0] : '';
  }

  /**
   * 正在等助手回执的那些请求（**一组，不是一个**）。
   *
   * 早先这里只放得下「一个」，而会话起好之后状态轮询每 2 秒就要问一次现状、它也会占这个位。
   * 后果很致命：手机的会合请求刚把等待位放进去，下一拍轮询就把它顶掉，于是助手回的那条
   * `p2pReady` 交给了轮询、会合这一发永远等不到回执 —— 表现是「会合必超时、这条路永远接不上」，
   * 而电脑那头一切正常。轮询与会合本来就会同时等着，两个都得能收到同一条事件。
   */
  const waiters = new Set();
  /** 最近一次配对 / 会合换进来的手机公钥（老助手事件没有 peerKey 时靠它兜底路由）。 */
  let lastPeer = '';
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
        // 对端公钥：进程重启之后内存表是空的，得从盘上那份接回来 —— 否则电脑会用空的对端
        // 公钥去配设备，起不来，表现成「这条通道一直在启动中」。盘上只存得下**最后一台**
        // 会合过的手机，其余那几台等它们下一轮会合（60 秒）自然会补齐。
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

  /**
   * 唤醒等待者。
   *
   * 多台手机之后这里要按公钥分道：两台同时会合时，A 那条 `p2pReady` 绝不能拿去回 B ——
   * 拿着别人的地址当自己的，B 会往一个自己够不到的 URL 上走。所以等待者按公钥认领，
   * 只唤醒「等这一台的」与「不挑的」（轮询）。
   *
   * `key` 为空串是**认不出是哪台**的情况（老助手的事件里没有公钥）：这时一律广播 ——
   * 老助手一条进程只有一条隧道，它报的就是「有隧道起来了」，分道反而会把等着的那台饿死。
   */
  function settle(value, key = '') {
    for (const done of [...waiters]) {
      if (key && done.key && done.key !== key) continue;
      waiters.delete(done);
      clearTimeout(done.timer);
      done.resolve(value);
    }
  }

  /**
   * 排一个等待者，超时自己摘掉（助手没答就回 null，别把内存漏下去）。
   *
   * `key` 是这台手机的公钥（不挑就留空）。超时那一支还要顺手把这一格的「正在发起」清掉 ——
   * 不清的话，那一格永远是 dialing，下一轮同候选的会合会被判成「已经在起，复用」，
   * 于是这台就再也不会重新发起（看起来像「隧道卡住了、怎么等都不动」）。
   */
  function await_(resolve, key = '') {
    const done = {
      key,
      resolve,
      timer: setTimeout(() => {
        waiters.delete(done);
        const entry = key ? peers.get(key) : null;
        if (entry) entry.dialing = false;
        resolve(null);
      }, P2P_TIMEOUT_MS),
    };
    done.timer.unref?.();
    waiters.add(done);
  }

  function handleEvent(event) {
    switch (event.event) {
      case 'p2pReady': {
        lastError = '';
        const key = routeKey(event);
        const entry = ensurePeer(key);
        entry.running = true;
        entry.dialing = false;
        entry.url = typeof event.url === 'string' ? event.url : '';
        entry.candidates = candidateList(event.candidates);
        // 候选必须带出去：会合那一发要把它还给手机，否则手机不知道往哪打洞。
        settle({ ok: true, url: entry.url, candidates: entry.candidates }, key);
        break;
      }
      case 'p2pStatus': {
        const key = routeKey(event);
        const entry = ensurePeer(key);
        entry.running = Boolean(event.running);
        entry.dialing = false;
        entry.url = typeof event.url === 'string' ? event.url : '';
        entry.path = normalizePath(event.path);
        entry.active = event.active === true;
        entry.detail = typeof event.detail === 'string' ? event.detail : '';
        entry.candidates = candidateList(event.candidates);
        settle({ ok: true, ...pick(entry), candidates: entry.candidates }, key);
        break;
      }
      case 'p2pKeys':
        // 助手生成了密钥对：私钥存插件、公钥留给配对与状态用（公钥可以明着给出去）。
        if (typeof event.private === 'string' && typeof event.public === 'string') {
          persist({ [STATE.privateKey]: event.private, [STATE.publicKey]: event.public });
        }
        settle({ ok: true, publicKey: typeof event.public === 'string' ? event.public : '' });
        break;
      case 'p2pStopped': {
        const announced = typeof event.peerKey === 'string' ? event.peerKey.trim() : '';
        if (announced) {
          // 新助手：只收掉这一台那条，别人的照跑。
          peers.delete(announced);
        } else {
          // 老助手：它一条进程只有一条隧道，回的就是「全停了」。
          peers.clear();
        }
        settle({ ok: true, running: false });
        break;
      }
      case 'error':
        lastError = event.code;
        // 助手报错意味着这一轮「正在发起」已经落空：不清这一位的话，那一格永远是 dialing，
        // 下一轮同候选的会合会被判成「已经在起，复用」，这台就再也重新发不起来了。
        for (const entry of peers.values()) entry.dialing = false;
        settle({ ok: false, code: event.code });
        break;
      default:
        break;
    }
  }

  /** 一条隧道里属于 `status()` 老字段的那几格（不带头里的记账字段）。 */
  function pick(entry) {
    return {
      running: entry.running,
      url: entry.url,
      path: entry.path,
      active: entry.active,
      detail: entry.detail,
      candidates: entry.candidates,
    };
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
    lastPeer = '';
    peers.clear();
    const current = host;
    host = null;
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
      lastPeer = peerPublicKey;
    }
    // 候选也要带出去：二维码里那一段是手机打洞的起点，空着就只能靠「只听不打」等握手。
    const entry = (lastPeer && peers.get(lastPeer)) || recentPeer();
    return {
      ok: true,
      publicKey: state.publicKey,
      port: P2P_PORT,
      peerKey: peerPublicKey,
      candidates: entry ? entry.candidates || [] : [],
      localCandidates: [],
    };
  }

  /**
   * 面板与路由看到的现状。这里不重探，理由同直连隧道那条。
   *
   * **字段名一个都没动**（手机 `/status` 心跳读的就是它们）。多台手机之后语义是：
   * 老字段取「最近活跃的那一条」，另外追加一份 `peers` 按手机公钥的详单给面板用。
   */
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
        peers: [],
      };
    }
    const entry = recentPeer();
    const current = entry ? pick(entry) : emptyTunnel();
    // 详单：最近活跃的排前面。匿名槽（空串）不进这份 —— 它只是老助手事件的落点。
    const roster = [...peers.entries()]
      .filter(([key]) => key)
      .sort((left, right) => right[1].stamp - left[1].stamp)
      .map(([key, item]) => ({ peerKey: key, ...pick(item) }));
    return {
      available: true,
      enabled: state.enabled,
      ready: current.running,
      // 有没有被手机叫起来过。`ready:false` + `started:false` 说的不是「正在启动」，
      // 而是「还没有手机来会合」—— 电脑这半边本来就是等人来打（「只听不打」）。
      started: everOpened,
      url: current.url,
      path: current.path,
      active: current.active,
      detail: current.detail,
      // 我自己的打洞候选也要给出去：手机那半边靠它知道往哪打。
      candidates: current.candidates || [],
      publicKey: state.publicKey,
      error: lastError,
      // 追加字段（不是老字段的改名）：每台手机那条隧道各是什么样，面板要能分开看。
      peers: roster,
    };
  }

  /**
   * 按手机给的公钥与候选把电脑侧那一半拉起来，并回手机要的那份（我自己这边的候选）。
   *
   * **幂等**：会合是手机每 60 秒会再来一次的心跳。同一把手机公钥、同一份候选、**它那条**
   * 隧道又在跑，就直接把现状回过去，**绝不重开** —— 重开等于把已经打通的洞每分钟踢掉一次，
   * 用户感受到的就是「网一会儿通一会儿断」。候选**真的变了**才按新的重开。
   *
   * 判据从「全局唯一那个对端」变成「**这台手机自己那一份**」：多台共存之后，两台手机各判
   * 各的，一台候选变了不会连累另一台。
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
    // 先只**算**出这次该用哪把对端公钥，**不落盘**：落盘要在复用判定之后 —— 顺序反过来的话，
    // 一次会被判成复用的会合也会去改写盘上那份，而盘上只有一格（最后一台会合的手机）。
    const peerKey = String(phonePublicKey || lastPeer || snapshot().peerKey || '');
    // 打一行现场：两端公钥对不对得上，是这条通道唯一真正致命的判据 ——
    // 错了洞照样开、`path` 照样报 `direct`，但数据面一个包都过不去，从现象上看不出区别。
    const seen = peers.get(peerKey);
    log(`P2P 隧道：会合 phonePublicKey=${phonePublicKey ? `${phonePublicKey.slice(0, 6)}…` : '(空)'}`
      + ` 采用的对端=${peerKey ? `${peerKey.slice(0, 6)}…` : '(空)'}`
      + ` 自己=${state.publicKey.slice(0, 6)}… 在跑=${seen ? seen.running : false}`);
    const candidates = Array.isArray(options.candidates) ? options.candidates : [];
    const localCandidates = Array.isArray(options.localCandidates) ? options.localCandidates : [];
    const wantedCandidates = { public: candidateSet(candidates), local: candidateSet(localCandidates) };

    // **同一把手机公钥 + 同一份候选，才复用该手机自己那条。**
    //
    // 「在跑」不足以说明「跑的是你」：这条通道早先一次只服务一个对端，多台手机同时来会合
    // 时，谁先来隧道就归谁 —— 后来那台每次会合都只拿到别人的现状。现在每把公钥各一套状态，
    // 判据天然落在「它自己那份」上。
    //
    // **候选也得一起判**：电脑第一次往往是在手机还没报出候选时以「只听不打」起来的，之后
    // 手机把真实候选报上来；只判公钥就一直复用那个没有对端地址的隧道，电脑永远不往手机打。
    // 局域网还好（手机摸得到内网地址、从那边打过来了），一到公网就只剩下「等待」。
    if (peerKey && seen && (seen.running || seen.dialing)
      && sameCandidates(wantedCandidates, seen.runningCandidates)) {
      return Promise.resolve({
        ok: true,
        running: true,
        url: seen.url,
        path: seen.path,
        active: seen.active,
        candidates: seen.candidates || [],
        // 我这一把公钥：会合回包要把它带给手机（手机拿它配对端）。
        publicKey: state.publicKey,
      });
    }

    // 复用的门过了，才把对端公钥落盘。
    if (peerKey && peerKey !== lastPeer) persist({ [STATE.peerKey]: peerKey });
    if (peerKey) lastPeer = peerKey;
    const entry = ensurePeer(peerKey);

    return new Promise((resolve) => {
      // 助手回的那几格（url / path / candidates）里没有公钥，在这里补上 —— 会合回包要用。
      // **回调里顺手开轮询**：会合只等到「本机这半边起来了」，打洞结果要再问几次才有。
      await_((reply) => {
        watch();
        resolve(reply && reply.ok ? { ...reply, publicKey: state.publicKey } : reply);
      }, peerKey);
      // 记下「这条隧道是按哪份候选起来的」：下一次会合据此判要不要重开。在这里记而不是等
      // `p2pReady`：请求已经发给助手了，这中间再来一发会合必须认同一份，否则会连发两条
      // `p2pStart`，两条各自开一次 socket、洞白开。
      entry.dialing = true;
      entry.runningCandidates = wantedCandidates;
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
   * **面板与 `/api/relay/p2p` 读的都是事件更新出来的那张表，而它只会被助手的事件更新** ——
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

'use strict';

/**
 * 把点对点隧道挂进装配层：只要一条助手会话，不要回环入口。
 *
 * 与直连隧道（`tailcat/wiring.cjs`）的差别就在这：那条要在本机开一个回环门、再把连接转给
 * 局域网端口；这条的连接是**从隧道里进来的**（WireGuard 的虚拟网卡），助手自己转给
 * `127.0.0.1:<插件端口>`，所以插件这边不需要任何监听。
 *
 * 隧道里进来的连接最终转给谁由 `chooseP2PTarget` 决定（局域网开着转局域网端口、关着转宿主
 * web 端口），与会合那一发拿到的 `targetPort` 是同一个答案。
 *
 * 任何一步起不来都只意味着「这台机器没有这条通道」：`mount` 兜住异常并留一行日志，别的
 * 通道一行不受影响。
 */

const { createP2PSession, P2P_PORT } = require('./session.cjs');

/**
 * 隧道里进来的连接该转到哪个端口。
 *
 * 与直连隧道（`tailcat/wiring.cjs` 的 `chooseTailcatTarget`）同一个形状、同一个理由：
 * 局域网开着就照旧转给「当前的局域网端口」，和一台 LAN 手机走完全同一条路；局域网关着
 * 那个端口根本没人监听（`resolveLanPort` 直接早返回、sidecar 也不起），隧道会握手成功、
 * 数据一到就断 —— 手机那边看到的是「连上了却毫无反应」。此时改转宿主自己的 web 端口，
 * 手机 API 就在那里，局域网 sidecar 平时也只是把连接原样转给它。
 *
 * 端口是取值器而不是一个数：局域网开关与端口都会漂，隧道却未必每次会合都重建。
 */
function chooseP2PTarget({ lanEnabled, lanPort, webPort }) {
  return () => (lanEnabled() ? lanPort() : webPort());
}

/**
 * @param {object} options
 * @param {(label: string, fn: Function) => any} options.mount 装配层的兜底挂载
 * @param {(message: string) => void} options.warn 告警出口
 * @param {object} options.state relay.json 那份内存状态（唯一真值）
 * @param {(state: object) => void} options.saveState 落盘
 * @param {() => number} options.localPort 插件本机端口（隧道里唯一的去处）
 * @param {() => number} [options.targetPort] 隧道里进来的连接该转给谁；给了就用它，否则退回
 *   localPort（见 chooseP2PTarget）
 * @param {object} options.ctx 插件 ctx（只为 `ctx.effect`）
 * @param {string} options.name 插件名，用于 effect 标签
 * @param {() => (string|null)} [options.resolveBinary] 测试缝：钉住「本机有没有助手」，
 *   不让用例的结果取决于开发机上刚好有没有编译好的助手。
 * @returns {object|undefined} 会话；起不来就是 undefined（路由与面板按「不可用」处理）
 */
function mountP2P({ mount, warn, state, saveState, localPort, targetPort, ctx, name, resolveBinary }) {
  const resolvedTargetPort = typeof targetPort === 'function' ? targetPort : localPort;
  /**
   * 端口是异步拿到的（`lanPortInUse()` 依赖 sidebar 起来），所以会话也是异步建好的。
   * 与直连隧道同一个做法：对外交**门面**，里面那格可能还是空，调用方问到的就是
   * 「暂不可用」，等挂上自然就通。
   */
  let session = null;
  const door = {
    status: () => (session
      ? session.status()
      : { available: false, enabled: true, ready: false, url: '', path: 'unknown', active: false, error: 'starting' }),
    exchange: peer => (session ? session.exchange(peer) : { ok: false, error: 'starting', port: 0 }),
    open: options => (session ? session.open(options) : Promise.resolve(null)),
    refresh: () => (session ? session.refresh() : Promise.resolve(null)),
    // 起来之后开始定时问现状：不问，面板那一格永远是「正在启动」（见 session 的 watch）。
    watch: () => (session ? session.watch() : undefined),
    start: () => (session ? session.start() : null),
    stop: () => (session ? session.stop() : Promise.resolve()),
    // 会合那一发要的「本机落点端口」：**每次现取**，不缓存。局域网开关与端口都会漂，
    // 缓存一个数就会在关掉局域网之后继续往一个没人听的口转。
    targetPort: () => Number(resolvedTargetPort()) || 0,
    // 会合回包要报「手机在隧道里拨哪个口」。会话还没建好时也得给得出来 —— 它是固定常量，
    // 与会话在不在跑无关；漏了这一格，手机拿到空端口就判「这次没有这条通道」。
    constants: { P2P_PORT },
  };

  // 启停单独一条命：跟 sidecar 不是一件事，谁挂了都不该带走对方。
  mount('点对点隧道生命周期', () =>
    ctx.effect(() => {
      let closed = false;
      Promise.resolve()
        .then(() => {
          if (closed) return;
          const port = Number(localPort());
          if (!Number.isInteger(port) || port <= 0) return;
          session = createP2PSession({
            readState: () => state,
            writeState: patch => {
              Object.assign(state, patch);
              saveState(state);
            },
            localPort: port,
            log: message => warn(message),
            ...(typeof resolveBinary === 'function' ? { resolveBinary } : {}),
          });
          session.start();
          // 立刻开始问现状：面板读的是「助手报回来的那一格」，不问它就一直是空的。
          session.watch();
        })
        .catch(error => warn(`点对点隧道没有起来：${error && error.message ? error.message : error}`));
      return () => {
        closed = true;
        try {
          if (session) {
            session.unwatch();
            void session.stop();
          }
          session = null;
        } catch {
          /* 已经在停 */
        }
      };
    }, `${name}: p2p`),
  );
  return door;
}

module.exports = { mountP2P, chooseP2PTarget };

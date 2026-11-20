// 装配点对点隧道，固定经带 P2P 来源标记的既有落点代理。
'use strict';
// 隧道始终走独立的带来源标记入口，不依赖局域网监听。
// 落点代理转给宿主时跟随宿主实际绑定地址（见 relay/tunnel-forwarder.cjs）。

/**
 * 把点对点隧道挂进装配层：一条助手会话，外加一个局域网关着时用的落点代理。
 *
 * 与直连隧道（`tailcat/wiring.cjs`）的差别就在这：那条要开一个回环入口把连接转给落点；
 * 这条的连接是**从隧道里进来的**（WireGuard 的虚拟网卡），助手自己转给
 * `127.0.0.1:<落点端口>`，所以插件这边不需要入口那一层，只需要落点代理本身。
 *
 * 隧道里进来的连接最终转给谁由 `chooseP2PTarget` 决定（局域网开着转局域网端口、关着转本文件
 * 起的落点代理），与会合那一发拿到的 `targetPort` 是同一个答案。
 *
 * 任何一步起不来都只意味着「这台机器没有这条通道」：`mount` 兜住异常并留一行日志，别的
 * 通道一行不受影响。
 */

const { createP2PSession, P2P_PORT } = require('./session.cjs');
const { createTunnelForwarder } = require('../relay/tunnel-forwarder.cjs');

/** 隧道落点独立于局域网开关和端口，保留远程来源边界。 */
function chooseP2PTarget({ tunnelPort }) {
  return () => tunnelPort();
}

/**
 * @param {object} options
 * @param {(label: string, fn: Function) => any} options.mount 装配层的兜底挂载
 * @param {(message: string) => void} options.warn 告警出口
 * @param {object} options.state relay.json 那份内存状态（唯一真值）
 * @param {(state: object) => void} options.saveState 落盘
 * @param {() => number} options.localPort 插件本机端口（隧道里唯一的去处）
 * @param {() => boolean} options.lanEnabled 局域网直连开着没有
 * @param {() => number} options.lanPort 当前局域网端口（会漂）
 * @param {() => number} options.webPort 宿主 web 端口（落点代理最终转给它）
 * @param {() => string} [options.webHost] 宿主 web 绑定地址（落点代理转给它；缺省回环）
 * @param {object} options.ctx 插件 ctx（只为 `ctx.effect`）
 * @param {string} options.name 插件名，用于 effect 标签
 * @param {() => (string|null)} [options.resolveBinary] 测试缝：钉住「本机有没有助手」，
 *   不让用例的结果取决于开发机上刚好有没有编译好的助手。
 * @returns {object|undefined} 会话；起不来就是 undefined（路由与面板按「不可用」处理）
 */
function mountP2P(options) {
  const { mount, warn, saveState, localPort, lanEnabled, lanPort, webPort, webHost, ctx, name, resolveBinary } = options;
  // 状态来源可由调用方在运行期提供（归外壳持有时，换代换的就是这一格）：老的直接传 `state`
  // 的用法保留为兜底，测试与旧调用方行为不变。
  const readState = typeof options.getState === 'function' ? options.getState : () => options.state;
  const persistState = typeof saveState === 'function' ? saveState : () => {};
  // 局域网那几格没给就是老形状（只有 `localPort`）：不建落点代理，判据退回 `localPort`，
  // 行为一字不变。给了才建 —— 它是在「局域网关着」时唯一能用的落点。
  //
  // 必须在会合之前就把端口开出来：会合回包要报一个当下拨得通的端口，等手机打过来了才去
  // listen 已经晚了一步。
  const forwarder = typeof lanEnabled === 'function'
    ? mount('点对点隧道落点代理', () =>
      createTunnelForwarder({ upstreamPort: webPort, upstreamHost: webHost, via: 'p2p', log: message => warn(message) }),
    )
    : null;
  if (forwarder) void forwarder.start();
  const resolvedTargetPort = typeof lanEnabled === 'function'
    ? chooseP2PTarget({ lanEnabled: () => false, lanPort, tunnelPort: () => (forwarder ? forwarder.port() : 0) })
    : localPort;
  /**
   * 端口是异步拿到的（`localPort()` 依赖 sidebar 起来），所以会话也是异步建好的。
   * 与直连隧道同一个做法：对外交**门面**，里面那格可能还是空，调用方问到的就是
   * 「暂不可用」，等挂上自然就通。
   */
  let session = null;
  const door = {
    status: () => (session
      ? session.status()
      : { available: false, enabled: false, ready: false, url: '', path: 'unknown', active: false, error: 'starting' }),
    exchange: peer => (session ? session.exchange(peer) : { ok: false, error: 'starting', port: 0 }),
    open: options => (session ? session.open(options) : Promise.resolve(null)),
    refresh: () => (session ? session.refresh() : Promise.resolve(null)),
    // 起来之后开始定时问现状：不问，面板那一格永远是「正在启动」（见 session 的 watch）。
    watch: () => (session ? session.watch() : undefined),
    setEnabled: enabled => (session ? session.setEnabled(enabled) : false),
    start: () => (session ? session.start() : null),
    stop: () => (session ? session.stop() : Promise.resolve()),
    stopPeer: key => (session ? session.stopPeer(key) : Promise.resolve(null)),
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
        .then(() => (forwarder ? forwarder.start() : 0))
        .then(() => {
          if (closed) return;
          const port = Number(localPort());
          if (!Number.isInteger(port) || port <= 0) return;
          session = createP2PSession({
            readState: () => readState(),
            writeState: patch => {
              const current = readState();
              Object.assign(current, patch);
              persistState(current);
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
        try {
          if (forwarder) forwarder.close();
        } catch {
          /* 已经关了 */
        }
      };
    }, `${name}: p2p`),
  );
  return door;
}

module.exports = { mountP2P, chooseP2PTarget };

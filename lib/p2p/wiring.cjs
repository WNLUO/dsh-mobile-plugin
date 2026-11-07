'use strict';

/**
 * 把点对点隧道挂进装配层：只要一条助手会话，不要回环入口。
 *
 * 与直连隧道（`tailcat/wiring.cjs`）的差别就在这：那条要在本机开一个回环门、再把连接转给
 * 局域网端口；这条的连接是**从隧道里进来的**（WireGuard 的虚拟网卡），助手自己转给
 * `127.0.0.1:<插件端口>`，所以插件这边不需要任何监听。
 *
 * 任何一步起不来都只意味着「这台机器没有这条通道」：`mount` 兜住异常并留一行日志，别的
 * 通道一行不受影响。
 */

const { createP2PSession } = require('./session.cjs');

/**
 * @param {object} options
 * @param {(label: string, fn: Function) => any} options.mount 装配层的兜底挂载
 * @param {(message: string) => void} options.warn 告警出口
 * @param {object} options.state relay.json 那份内存状态（唯一真值）
 * @param {(state: object) => void} options.saveState 落盘
 * @param {() => number} options.localPort 插件本机端口（隧道里唯一的去处）
 * @param {object} options.ctx 插件 ctx（只为 `ctx.effect`）
 * @param {string} options.name 插件名，用于 effect 标签
 * @returns {object|undefined} 会话；起不来就是 undefined（路由与面板按「不可用」处理）
 */
function mountP2P({ mount, warn, state, saveState, localPort, ctx, name }) {
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
    start: () => (session ? session.start() : null),
    stop: () => (session ? session.stop() : Promise.resolve()),
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
          });
          session.start();
        })
        .catch(error => warn(`点对点隧道没有起来：${error && error.message ? error.message : error}`));
      return () => {
        closed = true;
        try {
          if (session) void session.stop();
          session = null;
        } catch {
          /* 已经在停 */
        }
      };
    }, `${name}: p2p`),
  );
  return door;
}

module.exports = { mountP2P };

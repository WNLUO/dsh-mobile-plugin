'use strict';

/**
 * 把直连隧道挂进装配层：回环入口 + 落点代理 + 助手会话 + 一条自己的启停 effect。
 *
 * 单独一个文件是因为装配层有行数上限（`test/assembly-layer.test.cjs` 钉着）——那些上限不是
 * 「装配层恰好该多长」，而是「实现不许搬回装配层」。这里的几样东西都是装配动作，实现分别
 * 在 `ingress.cjs`、`session.cjs` 与 `relay/tunnel-forwarder.cjs`。
 *
 * 任何一步起不来都只意味着「这台机器没有这条通道」：`mount` 兜住异常并留一行日志，中转与
 * 局域网一行不受影响。
 */

const { createLoopbackIngress } = require('./ingress.cjs');
const { createTailcatSession } = require('./session.cjs');
const { createTunnelForwarder } = require('../relay/tunnel-forwarder.cjs');

/**
 * @param {object} options
 * @param {(label: string, fn: Function) => any} options.mount 装配层的兜底挂载
 * @param {(message: string) => void} options.warn 告警出口（拿不到 logger 时为空实现）
 * @param {object} options.state relay.json 那份内存状态（唯一真值）
 * @param {(state: object) => void} options.saveState 落盘
 * @param {() => boolean} options.lanEnabled 局域网直连开着没有
 * @param {() => number} options.lanPort 当前局域网端口（会漂）
 * @param {() => number} options.webPort 宿主 web 端口（落点代理最终转给它）
 * @param {() => string} options.hostName 电脑名
 * @param {object} options.ctx 插件 ctx（只为 `ctx.effect`）
 * @param {string} options.name 插件名，用于 effect 标签
 * @returns {object|undefined} 会话；起不来就是 undefined（路由与面板按「不可用」处理）
 */
/**
 * 直连隧道把连接转到哪个端口。
 *
 * 局域网开着：照旧转给「当前的局域网端口」，和一台 LAN 手机走完全同一条路。
 * 局域网关着：那个端口根本没人监听（`resolveLanPort` 在关闭时直接早返回、sidecar 也不起），
 * 所以得换个落点 —— 但**不能裸转宿主 web 端口**：那是一条纯 TCP 透传，请求上不带任何
 * 「我是被转发进来的」记认，控制面（`localOnly`）见到它就当成本机设置页（实测经隧道打
 * `/api/relay/revoke-all` 会照单执行）。现在转给 `relay/tunnel-forwarder.cjs`：它给每条
 * 请求打上转发标记再转 web 端口，同时把移动 API 原样放过（那条路只认 token）。
 *
 * 端口是取值器而不是一个数：局域网开关、端口与落点代理的端口都会漂。
 */
function chooseTailcatTarget({ lanEnabled, lanPort, tunnelPort }) {
  return () => (lanEnabled() ? lanPort() : tunnelPort());
}

function mountTailcat(options) {
  const { mount, warn, state, saveState, lanEnabled, lanPort, webPort, hostName, ctx, name } = options;
  // 落点代理与入口各是一条回环监听，都得活着；任何一个起不来就只是这块不可用（`mount` 兜住）。
  const forwarder = mount('隧道落点代理', () =>
    createTunnelForwarder({ upstreamPort: webPort, log: message => warn(message) }),
  );
  // 与入口一起先把端口开出来：第一条连接进来时（可能比 effect 跑得还早）落点就得有值。
  if (forwarder) void forwarder.start();
  const resolvedTargetPort = chooseTailcatTarget({
    lanEnabled,
    lanPort,
    tunnelPort: () => (forwarder ? forwarder.port() : 0),
  });
  const ingress = mount('直连隧道入口', () =>
    createLoopbackIngress({ targetPort: resolvedTargetPort, log: message => warn(message) }),
  );

  /**
   * 端口是异步拿到的（`listen(0)` 要等 `listening`），所以会话也是异步建好的。
   * 路由和面板在装配阶段就要拿到一个对象，于是对外交的是**门面**：里面那格可能还是空，
   * 调用方问到的就是「暂不可用」，等挂上了自然就通了 —— 不需要谁去等一次 Promise。
   */
  let session = null;
  const door = {
    // 除了助手进程那一格，再把「这条链当前该转到的下游端口」一并报出去：连接自检要拿它
    // 真去拨一下，才能分辨「助手 ready」与「下游其实没人听」。
    status: () => {
      const base = session
        ? session.status()
        : { available: Boolean(ingress), enabled: true, ready: false, address: '', paired: 0, error: 'starting' };
      return { ...base, targetPort: resolvedTargetPort() };
    },
    openPairingWindow: ttl => (session ? session.openPairingWindow(ttl) : Promise.resolve(null)),
    setAllowed: keys => (session ? session.setAllowed(keys) : false),
    setEnabled: enabled => (session ? session.setEnabled(enabled) : false),
    enroll: publicKey => (session ? session.enroll(publicKey) : Promise.resolve(null)),
    allowedClients: () => (session ? session.allowedClients() : []),
    start: () => (session ? session.start() : undefined),
    stop: () => (session ? session.stop() : Promise.resolve()),
  };

  // 启停单独一条命：跟 sidecar 不是一件事，谁挂了都不该带走对方。
  // 关的时候先停助手再关回环门——门是助手唯一的去处，反过来会让最后几条连接瞬间断在门上。
  mount('直连隧道生命周期', () =>
    ctx.effect(() => {
      let closed = false;
      const wiring = ingress
        ? Promise.all([ingress.start(), forwarder ? forwarder.start() : Promise.resolve(0)])
            .then(([port]) => {
              if (closed || !port) return;
              session = createTailcatSession({
                readState: () => state,
                writeState: patch => {
                  Object.assign(state, patch);
                  saveState(state);
                },
                localPort: port,
                hostName,
                log: message => warn(message),
              });
              session.start();
            })
            .catch(error => warn(`直连隧道没有起来：${error && error.message ? error.message : error}`))
        : Promise.resolve();
      return () => {
        closed = true;
        void wiring.then(() => {
          try {
            if (session) session.stop();
            session = null;
          } catch {
            /* 已经在停 */
          }
          try {
            if (ingress) ingress.close();
          } catch {
            /* 已经关了 */
          }
          try {
            if (forwarder) forwarder.close();
          } catch {
            /* 已经关了 */
          }
        });
      };
    }, `${name}: tailcat`),
  );
  return door;
}

module.exports = { mountTailcat, chooseTailcatTarget };

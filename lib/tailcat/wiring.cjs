// 装配门面保留真实启动错误，正常等待与默认关闭不产生故障。
'use strict';
// 隧道始终走独立的带来源标记入口，不依赖局域网监听。
// 落点代理转给宿主时跟随宿主实际绑定地址（见 relay/tunnel-forwarder.cjs）。

/**
 * 把直连隧道挂进装配层：回环入口 + 落点代理 + 助手会话 + 一条自己的启停 effect。
 *
 * 单独一个文件是因为装配层有行数上限（`test/assembly-layer.test.cjs` 钉着）——那些上限不是
 * 「装配层恰好该多长」，而是「实现不许搬回装配层」。这里的几样东西都是装配动作，实现分别
 * 在 `ingress.cjs`、`session.cjs` 与 `relay/tunnel-forwarder.cjs`。
 *
 * 任何一步起不来都只意味着「这台机器没有这条通道」：`mount` 兜住异常并留一行日志，中转与
 * 局域网一行不受影响。
 *
 * 门面也交给外壳一份：自更新装包前要让助手先松开平台包目录，装完再拉起来。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLoopbackIngress } = require('./ingress.cjs');
const { createTailcatSession } = require('./session.cjs');
const { createTunnelForwarder } = require('../relay/tunnel-forwarder.cjs');

/**
 * 这条直连隧道「实现指纹」：外壳按它决定换代时沿用还是重建 door。指纹不变就沿用正在跑的
 * 会话与监听（换代不断直连），变了才重建（只有这条线路短暂重连，DSH 不重启）。
 */
function tailcatFingerprint() {
  const hash = crypto.createHash('sha256');
  for (const rel of ['wiring.cjs', 'ingress.cjs', 'session.cjs', 'host-process.cjs', '../relay/tunnel-forwarder.cjs']) {
    try { hash.update(fs.readFileSync(path.join(__dirname, rel))); } catch { hash.update(rel); }
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * @param {object} options
 * @param {(label: string, fn: Function) => any} options.mount 装配层的兜底挂载
 * @param {(message: string) => void} options.warn 告警出口（拿不到 logger 时为空实现）
 * @param {object} options.state relay.json 那份内存状态（唯一真值）
 * @param {(state: object) => void} options.saveState 落盘
 * @param {() => boolean} options.lanEnabled 局域网直连开着没有
 * @param {() => number} options.lanPort 当前局域网端口（会漂）
 * @param {() => number} options.webPort 宿主 web 端口（落点代理最终转给它）
 * @param {() => string} [options.webHost] 宿主 web 绑定地址（落点代理转给它；缺省回环）
 * @param {() => string} options.hostName 电脑名
 * @param {object} options.ctx 插件 ctx（只为 `ctx.effect`）
 * @param {string} options.name 插件名，用于 effect 标签
 * @returns {object|undefined} 会话；起不来就是 undefined（路由与面板按「不可用」处理）
 */
/** 隧道落点独立于局域网开关和端口，保留远程来源边界。 */
function chooseTailcatTarget({ tunnelPort }) {
  return () => tunnelPort();
}

function mountTailcat(options) {
  const { mount, warn, saveState, lanEnabled, lanPort, webPort, webHost, hostName, ctx, name } = options;
  // 状态来源可由调用方在运行期提供（归外壳持有时，换代换的就是这一格）：老的直接传 `state`
  // 的用法保留为兜底，测试与旧调用方行为不变。
  const readState = typeof options.getState === 'function' ? options.getState : () => options.state;
  const persistState = typeof saveState === 'function' ? saveState : () => {};
  let session = null;
  let startupError = '';
  const failed = error => {
    if (!startupError) startupError = error && error.message ? error.message : String(error);
    warn(`直连隧道没有起来：${startupError}`);
  };
  const startupLog = message => {
    if (!session && !startupError) startupError = String(message);
    warn(message);
  };
  // 落点代理与入口各是一条回环监听，都得活着；任何一个起不来就只是这块不可用（`mount` 兜住）。
  const forwarder = mount('隧道落点代理', () => {
    try {
      return createTunnelForwarder({ upstreamPort: webPort, upstreamHost: webHost, log: startupLog });
    } catch (error) { failed(error); throw error; }
  });
  // 前置监听与生命周期共用一份结果；effect 还没运行时也立即接住启动拒绝。
  const forwarding = (async () => {
    if (!forwarder) throw new Error('forwarder-unavailable');
    const targetPort = Number(await forwarder.start());
    if (!Number.isInteger(targetPort) || targetPort <= 0) throw new Error('forwarder-port-unavailable');
    return targetPort;
  })().catch(error => { failed(error); return 0; });
  const resolvedTargetPort = chooseTailcatTarget({
    lanEnabled,
    lanPort,
    tunnelPort: () => (forwarder ? forwarder.port() : 0),
  });
  const ingress = mount('直连隧道入口', () => {
    try {
      return createLoopbackIngress({ targetPort: resolvedTargetPort, log: startupLog });
    } catch (error) { failed(error); throw error; }
  });

  /**
   * 端口是异步拿到的（`listen(0)` 要等 `listening`），所以会话也是异步建好的。
   * 路由和面板在装配阶段就要拿到一个对象，于是对外交的是**门面**：里面那格可能还是空，
   * 调用方问到的就是「暂不可用」，等挂上了自然就通了 —— 不需要谁去等一次 Promise。
   */
  const door = {
    // 除了助手进程那一格，再把「这条链当前该转到的下游端口」一并报出去：连接自检要拿它
    // 真去拨一下，才能分辨「助手 ready」与「下游其实没人听」。
    status: () => {
      const base = session && !startupError
        ? session.status()
        : { available: Boolean(ingress && forwarder && !startupError), enabled: (readState() || {}).tailcatEnabled === true,
          ready: false, address: '', paired: 0, error: startupError };
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
      const wiring = Promise.resolve()
        .then(() => {
          if (!ingress) throw new Error('ingress-unavailable');
          return Promise.all([ingress.start(), forwarding]);
        })
        .then(([port, targetPort]) => {
          if (closed || !targetPort) return;
          if (!Number.isInteger(port) || port <= 0) throw new Error('ingress-port-unavailable');
          if (startupError) return;
          session = createTailcatSession({
            readState: () => readState(),
            writeState: patch => {
              const current = readState();
              Object.assign(current, patch);
              persistState(current);
            },
            localPort: port,
            hostName,
            log: message => warn(message),
          });
          session.start();
        })
        .catch(failed);
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
  // 更新要替换平台包目录（Windows 上助手进程占着 exe 时 pnpm 会 EPERM）。把停/起口交给外壳，
  // 装包前停、装完拉起；只给门面，不把助手会话本身交出去。
  mount('隧道更新暂停口', () => ctx.reflect.provide('dshMobileTailcatCtl', door));
  return door;
}

module.exports = { mountTailcat, chooseTailcatTarget, tailcatFingerprint };

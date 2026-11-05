'use strict';

/**
 * 隧道和插件之间的那道小门：在回环上占一个固定的端口，进来的每条连接都转给「当前」的
 * 局域网端口。
 *
 * 为什么中间要隔这一层：局域网端口是会变的（首选 18787 被占就让内核另分一个，重启后还
 * 可能再变），而隧道那边把它当固定地址写死。直接告诉助手那个会变的端口，端口一变隧道
 * 就整段指向一个没人听的地方，而手机侧只会看到「连上就断」。隔一层之后助手只认这个
 * 回环端口，端口怎么变都由这里在每次连接时临时决定。
 *
 * 只监听 127.0.0.1，不接受任何外部来源；隧道进来的是本进程内的连接。
 */

const net = require('node:net');

/**
 * @param {object} options
 * @param {() => number} options.targetPort 当前局域网端口（每次连接现读，允许变化）
 * @param {(message: string) => void} [options.log]
 */
function createLoopbackIngress(options) {
  const log = options.log || (() => {});
  let server = null;
  let port = 0;
  const live = new Set();

  function pipe(socket) {
    const target = Number(options.targetPort());
    if (!Number.isInteger(target) || target <= 0) {
      socket.destroy();
      return;
    }
    const upstream = net.connect({ host: '127.0.0.1', port: target });
    live.add(socket);
    live.add(upstream);
    const drop = () => {
      live.delete(socket);
      live.delete(upstream);
      socket.destroy();
      upstream.destroy();
    };
    socket.on('error', drop);
    upstream.on('error', drop);
    socket.on('close', drop);
    upstream.on('close', drop);
    socket.pipe(upstream);
    upstream.pipe(socket);
  }

  let starting = null;

  return {
    /**
     * 把回环端口开起来，拿到端口之后才算成；失败回 0。
     *
     * **必须是异步的**：`listen(0)` 之后 `address()` 要等 `listening` 事件才有值，同步读回来
     * 恒是 null，端口就成了 0——隧道那边于是拿到一个「没有地址」的配置，整条通道静默不可用。
     */
    start() {
      if (starting) return starting;
      server = net.createServer(pipe);
      server.on('error', error => {
        log(`隧道入口没有开起来：${error && error.message ? error.message : error}`);
      });
      starting = new Promise(resolve => {
        try {
          server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            port = address && typeof address === 'object' ? address.port : 0;
            resolve(port);
          });
        } catch (error) {
          log(`隧道入口监听失败：${error && error.message ? error.message : error}`);
          resolve(0);
        }
      });
      return starting;
    },
    port: () => port,
    close() {
      for (const socket of live) socket.destroy();
      live.clear();
      if (server) {
        try {
          server.close();
        } catch {
          /* already closed */
        }
      }
      server = null;
      port = 0;
      starting = null;
    },
  };
}

module.exports = { createLoopbackIngress };

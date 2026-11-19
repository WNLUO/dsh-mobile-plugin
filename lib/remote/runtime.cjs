'use strict';
// 电脑间远程网页的装配与生命周期；入口只在可信本机界面签发。
// 落点代理转给宿主 web 服务时跟随宿主实际绑定地址（见 relay/tunnel-forwarder.cjs）。
const os = require('node:os');
const { createRemoteStore } = require('./store.cjs');
const { createRemoteHost } = require('./host.cjs');
const transport = require('./transport.cjs');
const { createRemoteController } = require('./controller.cjs');
const { createRemoteRoutes } = require('./routes.cjs');
const { createHostControl } = require('./host-control.cjs');
const { createTunnelForwarder } = require('../relay/tunnel-forwarder.cjs');

function mountRemoteComputers({ ctx, state, credentials, registerRoute, lanPortInUse, tailcat, p2p, lanAvailable, onBindingsChanged, onInvite, log = () => {} }) {
  const store = createRemoteStore({ credentials: () => ctx.get('credentials') });
  const forwarder = createTunnelForwarder({ upstreamPort: () => ctx.webServer.port, upstreamHost: () => ctx.webServer.host, log });
  const control = createHostControl({ state, tailcat, p2p, lanPortInUse, lanAvailable });
  const host = createRemoteHost({
    state, credentials, routesOf: control.routesOf,
    getUpstreamPort: async () => { await forwarder.start(); return forwarder.port(); },
    getWebPort: () => ctx.webServer.port,
    getLaunchToken: () => ctx.get('connection')?.browserAuth?.launchToken || '',
    getConnectionInfo: control.connectionInfo,
    onControl: control.onControl, onInvite, log,
  });
  const { createRemoteTunnels } = require('./tunnels.cjs');
  const tunnels = createRemoteTunnels({ store, transport });
  const controller = createRemoteController({ store, transport, tunnels, name: state.name || os.hostname(), onBindingsChanged });
  createRemoteRoutes({ controller, host, credentials, instanceId: state.instanceId }).register(registerRoute);
  ctx.effect(() => () => {
    const stopping = controller.close();
    host.close();
    forwarder.close();
    return Promise.resolve(stopping).catch(() => {}).then(() => tunnels.closeAll());
  }, 'dsh-mobile-plugin: remote computers');
  return host;
}
module.exports = { mountRemoteComputers };

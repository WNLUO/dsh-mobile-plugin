// 短暂占用先重试原端口；发现重发等待退订结束，失败保留底层原因。
'use strict';
// 只发布已监听入口；发布失败时停止换号，现有固定入口仍可使用。
const { canChangeLanPort } = require('./lan-port-policy.cjs');

const SERVICE_TYPE = 'dsh-mobile';

function createLanDiscovery({ instanceId, onChange = () => {}, makeBonjour = onError => {
  const { Bonjour } = require('bonjour-service');
  return new Bonjour(undefined, onError);
}, timeoutMs = 5000 } = {}) {
  let client = null;
  let service = null;
  let generation = 0;
  let cancelPending = null;
  let detachErrors = null;
  let stopping = null;
  let view = { state: 'off', error: null };
  const set = (state, error = null) => { view = { state, error }; onChange(); };
  const stop = () => {
    generation += 1;
    cancelPending?.();
    cancelPending = null;
    const oldService = service;
    const oldClient = client;
    const oldDetachErrors = detachErrors;
    service = null;
    client = null;
    detachErrors = null;
    set('off');
    if (stopping) return stopping;
    if (!oldClient && !oldService) return Promise.resolve();
    const closing = new Promise(resolve => {
      let settled = false;
      const timer = setTimeout(finish, 300);
      function finish() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { oldClient?.destroy(); } catch { /* 已退出 */ }
        oldDetachErrors?.();
        resolve();
      }
      try {
        if (oldService) oldService.stop(finish);
        else finish();
      } catch { finish(); }
    });
    stopping = closing.finally(() => { stopping = null; });
    return stopping;
  };
  const publish = async port => {
    const stopped = stop();
    const own = generation;
    await stopped;
    if (own !== generation) return false;
    set('starting');
    return new Promise(resolve => {
      let settled = false;
      let timer;
      const finish = (ok, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (own === generation) cancelPending = null;
        if (own === generation) set(ok ? 'ready' : 'error', error || null);
        resolve(ok && own === generation);
      };
      cancelPending = () => finish(false);
      const fail = error => {
        const message = String(error?.message || error);
        if (own !== generation) return finish(false, message);
        if (settled) set('error', message);
        else finish(false, message);
      };
      timer = setTimeout(() => fail(new Error('局域网发现发布超时')), timeoutMs);
      try {
        client = makeBonjour(fail);
        const mdns = client.server?.mdns;
        if (mdns) {
          mdns.on('error', fail);
          detachErrors = () => mdns.removeListener('error', fail);
        }
        service = client.publish({ name: `DSH-${instanceId}`, type: SERVICE_TYPE, protocol: 'tcp', host: `dsh-${instanceId}.local`, port,
          txt: { id: instanceId, v: '1' } });
        service.once('up', () => finish(true));
        service.on('error', fail);
      } catch (error) { fail(error); }
    });
  };
  return { publish, stop, snapshot: () => ({ ...view }) };
}

/** 短暂占用先重试原入口；固定穿透与旧手机始终保留原端口。 */
async function bindLanEndpoint({ requestedPort, createProxy, discovery, store, instanceId, lockReason = '', isCurrent = () => true,
  retryDelays = [250, 750], wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let proxy;
  let changed = false;
  for (let attempt = 0; ; attempt += 1) {
    if (!isCurrent()) throw new Error('局域网配置已更新');
    proxy = createProxy(requestedPort);
    try { await proxy.start(); break; }
    catch (error) {
      await proxy.stop();
      if (error?.code !== 'EADDRINUSE') throw error;
      if (attempt < retryDelays.length) { await wait(retryDelays[attempt]); continue; }
      if (lockReason) throw new Error(`端口 ${requestedPort} 已被占用；${lockReason === 'fixed' ? '已开启固定端口' : '穿透或固定地址依赖此端口'}，未自动换端口。请释放占用后重试。`);
      if (!canChangeLanPort(store, instanceId)) {
        throw new Error(`端口 ${requestedPort} 已被占用；为保留旧版或未知能力手机的连接地址，未自动换端口。请释放占用后重试。`);
      }
      if (!isCurrent()) throw new Error('局域网配置已更新');
      proxy = createProxy(0);
      try { await proxy.start(); } catch (retryError) { await proxy.stop(); throw retryError; }
      changed = true;
      break;
    }
  }
  if (!isCurrent()) { await proxy.stop(); throw new Error('局域网配置已更新'); }
  const port = proxy.port();
  const published = await discovery.publish(port);
  if (!isCurrent() || (changed && !published)) {
    const discoveryError = discovery.snapshot?.().error;
    await proxy.stop();
    await discovery.stop();
    throw new Error(changed ? `新端口已释放：局域网发现不可用${discoveryError ? `（${discoveryError}）` : ''}，保留原端口配置，请释放占用后重试。` : '局域网配置已更新');
  }
  return { proxy, port, changed };
}

module.exports = { SERVICE_TYPE, createLanDiscovery, bindLanEndpoint };

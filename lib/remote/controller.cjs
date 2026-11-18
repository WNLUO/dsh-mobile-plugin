// 远程电脑绑定、浏览器访问租期与每设备线路状态。
'use strict';

const { createLocalGateway, LEASE_MS } = require('./local.cjs');
const { createRemoteRouter } = require('./router.cjs');
const { createNetworkMonitor } = require('./network.cjs');
const { safeRoutes } = require('./local-headers.cjs');

function createRemoteController({ store, transport, name, tunnels, onBindingsChanged }) {
  const devices = new Map();
  let closed = false;
  let heartbeatAt = 0;

  function expiredError() { return Object.assign(new Error('本次访问已到期，请重新打开'), { code: 'REMOTE_EXPIRED' }); }
  function safeError(error) {
    const messages = {
      REMOTE_REVOKED: '这台电脑已解除本机的绑定，请重新绑定。',
      REMOTE_EXPIRED: '远程授权已到期，请重新绑定。',
      REMOTE_AUTH: '远程电脑身份验证失败。',
      REMOTE_VERSION: '对方插件版本不兼容，请升级到支持远程电脑的版本。',
      REMOTE_TIMEOUT: '远程连接超时。',
      REMOTE_CONNECT: '远程电脑暂时离线。',
    };
    return messages[error?.code] || '远程连接暂时不可用。';
  }

  // 绑定增减后通知装配层：有远程电脑时要用局域网候选，联动失败不能反过来让管理动作失败。
  async function bindingsChanged() { try { await onBindingsChanged?.(); } catch { /* ignore */ } }

  function routerFor(item) {
    const router = createRemoteRouter({ binding: item.binding, transport, tunnels,
      onError: (error) => { if (!closed && item.router === router) fault(item, error); },
      async onRoutes(routes) {
        if (closed || item.router !== router) return;
        if (store.update) await store.update(item.binding.id, () => ({ routes }));
        else await store.put({ ...await store.get(item.binding.id), routes });
        if (!closed && item.router === router) item.binding.routes = routes;
      },
    });
    return router;
  }

  function fault(item, error) {
    item.lastError = safeError(error); item.lastErrorCode = error?.code || 'REMOTE_CONNECT';
    if (error?.code === 'REMOTE_REVOKED') {
      item.state = 'revoked'; item.gateway?.close(); item.gateway = null; item.router.close();
    } else if (error?.code === 'REMOTE_EXPIRED') {
      item.state = 'expired'; item.gateway?.close(); item.gateway = null; item.router.close();
    } else if (item.state !== 'expired' && item.state !== 'revoked') item.state = 'offline';
  }

  function ensure(binding) {
    const id = String(binding.id || binding.instanceId);
    let item = devices.get(id);
    if (item) return item;
    item = { binding: { ...binding, id }, mode: binding.mode || 'auto', state: 'idle', expiresAt: null, lastError: '', gateway: null, opening: null, windowChild: null, windowClosed: false };
    item.router = routerFor(item);
    devices.set(id, item);
    return item;
  }

  async function find(id) {
    if (closed) throw new Error('远程电脑管理已关闭');
    const binding = await store.get(String(id));
    if (closed) throw new Error('远程电脑管理已关闭');
    if (!binding) throw Object.assign(new Error('找不到这台远程电脑'), { code: 'REMOTE_NOT_FOUND' });
    return ensure(binding);
  }

  function expire(item) {
    item.gateway?.close(); item.gateway = null;
    item.state = 'expired'; item.lastError = ''; item.lastErrorCode = ''; item.router.close();
    void Promise.resolve(tunnels?.close?.(item.binding.id)).catch(() => {});
  }

  function check(item) {
    if (item.gateway && Date.now() >= item.expiresAt) { expire(item); return false; }
    return Boolean(item.gateway);
  }

  function row(item) {
    check(item);
    const snapshot = item.router.snapshot();
    const selected = safeRoutes(snapshot.route ? [snapshot.route] : [])[0];
    // 桌面窗口是否还连着：进程没退出、网关也还连着才算「已打开」；关掉窗口后回到未打开（租期仍按既有规则自然到期）。
    const attached = !item.windowClosed && Boolean(item.gateway && typeof item.gateway.attached === 'function' && item.gateway.attached());
    const state = !attached && ['connected', 'connecting', 'offline'].includes(item.state) ? 'idle' : item.state;
    return {
      id: item.binding.id, name: String(item.binding.name || item.binding.instanceId), instanceId: item.binding.instanceId,
      mode: item.mode, channel: selected?.channel || null, url: selected?.url || null,
      latencyMs: snapshot.latencyMs, state, expiresAt: item.expiresAt,
      ...(item.lastError ? { lastError: item.lastError, lastErrorCode: item.lastErrorCode || 'REMOTE_CONNECT' } : {}), routes: safeRoutes(snapshot.routes),
      attached,
    };
  }

  async function stopItem(item) {
    item.gateway?.close(); item.gateway = null;
    item.router.close();
    item.state = 'idle'; item.expiresAt = null; item.lastError = ''; item.lastErrorCode = '';
    item.windowClosed = false; item.windowChild = null;
    await tunnels?.close?.(item.binding.id);
    item.router = routerFor(item);
  }

  const network = createNetworkMonitor({
    async onTick(time) {
      const active = [...devices.values()].filter((item) => check(item));
      if (time - heartbeatAt < 30000) return;
      heartbeatAt = time;
      void Promise.all(active.map(async (item) => {
        try { await item.router.probe(); if (check(item)) { item.state = 'connected'; item.lastError = ''; item.lastErrorCode = ''; } } catch (error) { fault(item, error); }
      })).catch(() => {});
    },
    async onChange() {
      await Promise.all([...devices.values()].filter((item) => check(item)).map(async (item) => {
        item.gateway.disconnect();
        try { await item.router.networkChanged(); if (check(item)) { item.state = 'connected'; item.lastError = ''; item.lastErrorCode = ''; } } catch (error) { fault(item, error); }
      }));
    },
  });

  async function open(id) {
    const item = await find(id);
    // 每次打开都算重新拉起：清掉上一轮窗口的关闭标记，等新进程接手。
    item.windowClosed = false; item.windowChild = null;
    if (item.opening) return item.opening;
    if (check(item)) return item.gateway.openLink();
    item.router.close(); item.router = routerFor(item);
    const router = item.router;
    let gateway;
    const current = () => !closed && item.router === router && item.gateway === gateway;
    item.opening = (async () => {
      item.state = 'connecting'; item.lastError = ''; item.lastErrorCode = '';
      item.expiresAt = Date.now() + LEASE_MS;
      gateway = createLocalGateway({
        expiresAt: item.expiresAt,
        connect: async () => {
          if (!current() || !check(item)) throw expiredError();
          try {
            const connection = await router.open({ expiresAt: item.expiresAt });
            if (!current() || !check(item)) { connection.stream.destroy(); throw expiredError(); }
            item.state = 'connected'; item.lastError = ''; item.lastErrorCode = '';
            return connection;
          } catch (error) { if (current()) fault(item, error); throw error; }
        },
        onExpire: () => { if (current()) expire(item); },
        // 网关按「窗口还在用」自动续期时，同步控制器认的到期时刻，避免 check() 拿旧期限误判到期。
        onRenew: (deadline) => { if (current()) item.expiresAt = deadline; },
        onError: (error) => { if (current()) { router.failure(error); fault(item, error); } },
      });
      item.gateway = gateway;
      try {
        const result = await gateway.start();
        if (!current()) { gateway.close(); throw expiredError(); }
        item.state = 'connecting';
        void router.probe().then(() => { if (current() && check(item)) item.state = 'connected'; }).catch((error) => { if (current()) fault(item, error); });
        return result;
      } catch (error) {
        gateway.close(); if (current()) { item.gateway = null; fault(item, error); } throw error;
      }
    })();
    try { return await item.opening; } finally { item.opening = null; }
  }

  return {
    async list() { return (await store.list()).map(ensure).map(row); },
    async add(invite) {
      if (closed) throw new Error('远程电脑管理已关闭');
      const binding = await transport.pairComputer(invite, { name });
      if (closed) throw new Error('远程电脑管理已关闭');
      binding.id = binding.id || binding.instanceId;
      binding.mode = 'auto';
      const existing = devices.get(binding.id);
      if (existing) { await stopItem(existing); devices.delete(binding.id); }
      await store.put(binding);
      await bindingsChanged();
      return row(ensure(binding));
    },
    open,
    /** 记下这台设备当前拉起的桌面进程：进程一退出就当作窗口关掉，面板据此回到未打开。 */
    watchWindow(id, child) {
      const item = devices.get(String(id));
      if (!item || !child) return;
      item.windowChild = child;
      item.windowClosed = false;
      if (child.exitCode !== null && child.exitCode !== undefined) { item.windowClosed = true; return; }
      child.on?.('exit', () => { if (item.windowChild === child) item.windowClosed = true; });
    },
    async renew(id) {
      const item = await find(id);
      if (!check(item)) throw expiredError();
      const result = await item.gateway.renew(Date.now() + LEASE_MS);
      item.expiresAt = result.expiresAt;
      return result;
    },
    async stop(id) { await stopItem(await find(id)); },
    async remove(id) {
      const item = await find(id);
      await stopItem(item); item.router.close();
      await store.delete(item.binding.id); devices.delete(item.binding.id);
      await bindingsChanged();
    },
    async setMode(id, mode) {
      const item = await find(id);
      if (['auto', 'tunnel', 'p2p'].includes(mode)) await item.router.refresh();
      item.router.setMode(mode);
      if (store.update) await store.update(item.binding.id, () => ({ mode }));
      else {
        const latest = await store.get(item.binding.id);
        await store.put({ ...latest, mode });
      }
      Object.assign(item.binding, await store.get(item.binding.id), { mode });
      item.mode = mode;
      return row(item);
    },
    async probe(id) {
      const item = await find(id);
      if (item.state === 'expired' || item.state === 'revoked') return row(item);
      try { await item.router.probe(); item.lastError = ''; item.lastErrorCode = ''; if (check(item)) item.state = 'connected'; }
      catch (error) { fault(item, error); }
      return row(item);
    },
    /** 逐线路探活：只读诊断，不改已选线路与状态。 */
    async diagnose(id) {
      const item = await find(id);
      return item.router.diagnose();
    },
    async close() {
      if (closed) return;
      closed = true; network.close();
      await Promise.all([...devices.values()].map(async (item) => {
        item.gateway?.close(); item.gateway = null; item.router.close();
        await tunnels?.close?.(item.binding.id);
      }));
      devices.clear();
    },
  };
}

module.exports = { createRemoteController };

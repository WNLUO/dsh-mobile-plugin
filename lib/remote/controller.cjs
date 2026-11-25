// 远端终止授权同步回收设备隧道，助手换代保持有效访问恢复。
// 2026-11-19：桌面窗口改成多窗口集合（只有最后一个窗口退出才回到未打开），进程还在就显示正在打开 /
// 已打开；换网按 lost 与非 lost 分流，lost 只断开已打开设备的连接、不改状态也不探活，非 lost 让所有
// 绑定（含没打开过的）都重选线路；connect 回调记下 connection.route 作为「实际在用线路」供面板展示；
// 错误码到文案的唯一一份定义放在本文件，HTTP 响应与列表行共用。
// 2026-11-24：打开入口时按绑定给出固定本机端口，浏览器才有机会跨窗口命中网页资源缓存。
// 2026-11-25：桌面壳熬过宽限后才崩时留一次性标记，面板经已有清单轮询补开浏览器；正常关窗不标记。
'use strict';

const { createLocalGateway, LEASE_MS } = require('./local.cjs');
const { preferredPortOf } = require('./local-port.cjs');
const { createRemoteRouter } = require('./router.cjs');
const { createNetworkMonitor } = require('./network.cjs');
const { safeRoutes } = require('./local-headers.cjs');
const { shellCrashed } = require('./shell.cjs');

// 远程操作错误码到可行动文案的唯一一份定义：HTTP 响应与设备列表行都从这里取，避免同一个码
// 在两处写成两种说法，也避免新码没词条时一律落到「操作失败」。
const REMOTE_ERROR_TEXT = {
  'credentials-unavailable': '宿主凭据存储暂不可用，请稍后重试',
  REMOTE_AUTH: '远程电脑认证失败，请重新绑定',
  REMOTE_REVOKED: '这台电脑的授权已被撤销，请重新绑定',
  REMOTE_VERSION: '对方插件版本不兼容，请升级到支持远程电脑的版本',
  REMOTE_EXPIRED: '授权已到期，请重新打开',
  REMOTE_TIMEOUT: '连接远程电脑超时，请检查对方在线状态；受限网络也可能需要代理或先完成网络登录',
  REMOTE_PROXY: '网络返回代理认证要求，请完成代理配置或更换网络后重试',
  REMOTE_PROXY_CONFIGURED: '本机配置了出站代理，当前远程连接使用直连；请确认网络允许直连或更换网络',
  REMOTE_INTERCEPTED: '连接收到了网页而非远程协议，请检查网络登录页或线路地址',
  REMOTE_HELPER_RESTARTING: '本机隧道助手正在恢复，请稍后重试',
  REMOTE_CONNECT: '暂时无法连接远程电脑，请检查网络和对方是否在线',
  REMOTE_UNAVAILABLE: '对方电脑暂时不可用，请确认它已打开 DSH 后重试',
  REMOTE_NOT_FOUND: '找不到这台远程电脑，它可能已被删除，请刷新后重试',
  REMOTE_INVITATION: '绑定信息无效、已使用或已到期，请重新生成',
  'bad-invite': '绑定信息格式不正确，请核对后重新粘贴或重新生成',
  'bad-id': '设备标识不正确，请刷新面板后重试',
  'bad-mode': '线路挡位不正确，请重新选择',
  REMOTE_OPEN_URL: '打开地址不是有效的本机入口，请在本机面板重新打开',
  SHELL_UNAVAILABLE: '本机未安装远程电脑桌面端，请改用默认方式打开',
};
const REMOTE_ERROR_FALLBACK = '远程电脑操作未完成，请确认绑定信息、网络和访问期限后重试';

function createRemoteController({ store, transport, name, tunnels, onBindingsChanged }) {
  const devices = new Map();
  let closed = false;
  let heartbeatAt = 0;

  function expiredError() { return Object.assign(new Error('本次访问已到期，请重新打开'), { code: 'REMOTE_EXPIRED' }); }
  function safeError(error) {
    return REMOTE_ERROR_TEXT[error?.code] || REMOTE_ERROR_FALLBACK;
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
    if (item.state === 'revoked' || item.state === 'expired') return;
    item.lastError = safeError(error); item.lastErrorCode = error?.code || 'REMOTE_CONNECT';
    if (error?.code === 'REMOTE_REVOKED') {
      item.state = 'revoked'; item.gateway?.close(); item.gateway = null; item.activeRoute = null; item.router.close();
      void Promise.resolve(tunnels?.close?.(item.binding.id)).catch(() => {});
    } else if (error?.code === 'REMOTE_EXPIRED') {
      item.state = 'expired'; item.gateway?.close(); item.gateway = null; item.activeRoute = null; item.router.close();
      void Promise.resolve(tunnels?.close?.(item.binding.id)).catch(() => {});
    } else if (item.state !== 'expired' && item.state !== 'revoked') item.state = 'offline';
  }

  function ensure(binding) {
    const id = String(binding.id || binding.instanceId);
    let item = devices.get(id);
    if (item) return item;
    item = { binding: { ...binding, id }, mode: binding.mode || 'auto', state: 'idle', expiresAt: null, lastError: '', gateway: null, opening: null, windows: new Set(), windowClosed: false, activeRoute: null };
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
    item.state = 'expired'; item.lastError = ''; item.lastErrorCode = ''; item.activeRoute = null; item.router.close();
    void Promise.resolve(tunnels?.close?.(item.binding.id)).catch(() => {});
  }

  function check(item) {
    if (item.gateway && Date.now() >= item.expiresAt) { expire(item); return false; }
    return Boolean(item.gateway);
  }

  function row(item) {
    check(item);
    const snapshot = item.router.snapshot();
    // 桌面窗口是否还开着：窗口进程还在就跑着（正在打开 / 已打开），不只看浏览器 socket 有没有连上；
    // 窗口从未拉起或已全部退出时，才退回网关的连接状态。
    const gatewayAttached = Boolean(item.gateway && typeof item.gateway.attached === 'function' && item.gateway.attached());
    const attached = !item.windowClosed && (item.windows.size > 0 || gatewayAttached);
    // 展示优先用「实际在用线路」：数据走的那条常常不是探测最快的那条；没有连接时退回路由当前选中的线路。
    const active = attached && item.activeRoute ? safeRoutes([item.activeRoute])[0] : null;
    const selected = active || safeRoutes(snapshot.route ? [snapshot.route] : [])[0];
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
    item.windows.clear(); item.windowClosed = false; item.activeRoute = null; item.shellCrashEvent = null;
    await tunnels?.close?.(item.binding.id);
    item.router = routerFor(item);
  }

  const unsubscribeTunnels = tunnels?.onChange?.(state => {
    if (closed) return;
    for (const item of devices.values()) {
      const hadTunnel = ['tunnel', 'p2p'].includes(item.activeRoute?.channel || item.router.snapshot().route?.channel);
      if (!state.ready) {
        item.helperRecovery = Boolean(item.helperRecovery || check(item)
          && item.router.snapshot().routes.some(route => ['tunnel', 'p2p'].includes(route.channel)));
        item.router.invalidateTunnels();
        if (hadTunnel) {
          item.gateway?.disconnect?.(); item.activeRoute = null;
          item.lastErrorCode = 'REMOTE_HELPER_RESTARTING';
          item.lastError = REMOTE_ERROR_TEXT.REMOTE_HELPER_RESTARTING;
          if (check(item)) item.state = 'connecting';
        }
      } else if (item.helperRecovery && check(item) && !['expired', 'revoked'].includes(item.state)) {
        item.helperRecovery = false;
        const router = item.router;
        void router.refresh(true).then(() => router.probe()).then(() => {
          if (!closed && item.router === router && check(item)) {
            item.state = 'connected'; item.lastError = ''; item.lastErrorCode = '';
          }
        }).catch(error => { if (!closed && item.router === router && check(item)) fault(item, error); });
      }
    }
  });

  const network = createNetworkMonitor({
    async onTick(time) {
      const active = [...devices.values()].filter((item) => check(item));
      if (time - heartbeatAt < 30000) return;
      heartbeatAt = time;
      void Promise.all(active.map(async (item) => {
        try { await item.router.probe(); if (check(item)) { item.state = 'connected'; item.lastError = ''; item.lastErrorCode = ''; } } catch (error) { fault(item, error); }
      })).catch(() => {});
    },
    async onChange(change) {
      // 丢网（上一轮有外网卡、这一轮全空）：只断开已打开设备的连接，不改状态、也不对着空网探活，
      // 等网络回来自会触发非 lost 的那一轮重选。
      if (change?.lost) {
        for (const item of devices.values()) item.gateway?.disconnect?.();
        return;
      }
      // 换网 / 唤醒：所有绑定都参与重选（更新候选、清掉旧线路证据），没打开过的设备也要跟上，
      // 否则下次打开还撞旧地址。已打开的设备先断开旧连接，新连接由控制器按新候选重拨。
      await Promise.all([...devices.values()].map(async (item) => {
        item.gateway?.disconnect?.();
        try {
          await item.router.networkChanged();
          if (check(item)) { item.state = 'connected'; item.lastError = ''; item.lastErrorCode = ''; }
        } catch (error) { if (check(item)) fault(item, error); }
      }));
    },
  });

  async function open(id) {
    const item = await find(id);
    // 每次打开都算重新拉起：清掉上一轮「全部窗口已退出」的标记，等新进程接手；已经在跑的窗口
    // 仍留在集合里，只有它们全部退出才重新置回未打开。
    item.windowClosed = false;
    if (item.opening) return item.opening;
    if (check(item)) return item.gateway.openLink();
    // 上一轮的「实际在用线路」随新网关一起清掉，避免新连接建立前还显示旧线路。
    item.activeRoute = null;
    item.router.close(); item.router = routerFor(item);
    const router = item.router;
    let gateway;
    const current = () => !closed && item.router === router && item.gateway === gateway;
    item.opening = (async () => {
      item.state = 'connecting'; item.lastError = ''; item.lastErrorCode = '';
      item.expiresAt = Date.now() + LEASE_MS;
      gateway = createLocalGateway({
        expiresAt: item.expiresAt,
        // 同一台电脑重复打开复用同一端口，浏览器按地址加端口分的缓存才留得住。
        preferredPort: preferredPortOf(item.binding.id),
        connect: async () => {
          if (!current() || !check(item)) throw expiredError();
          try {
            const connection = await router.open({ expiresAt: item.expiresAt });
            if (!current() || !check(item)) { connection.stream.destroy(); throw expiredError(); }
            // 记下数据实际走的线路：面板显示它，而不是探测最快的那条。
            item.activeRoute = connection?.route || null;
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
    async list() {
      const rows = (await store.list()).map(ensure).map(row);
      // 面板本来就在轮询清单，晚崩靠这一帧带过去；取走即清，后续轮询不会重复弹浏览器。
      for (const item of rows) {
        const entry = devices.get(item.id);
        item.shellCrashed = Boolean(entry?.shellCrashEvent);
        if (entry) entry.shellCrashEvent = null;
      }
      return rows;
    },
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
    /**
     * 记下这台设备拉起的桌面进程：支持同一设备多个窗口，只有最后一个进程退出才当作窗口全关、面板回到
     * 未打开。页面还没连上的那一小段里进程已经算「正在打开」，不会因为浏览器 socket 没连上就翻回未打开。
     */
    watchWindow(id, child) {
      const item = devices.get(String(id));
      if (!item || !child) return;
      item.windowClosed = false;
      item.windows.add(child);
      const leave = (code, signal) => {
        if (!item.windows.delete(child)) return;
        if (item.windows.size) return;
        item.windowClosed = true;
        // 只有最后一个窗口退出且是异常退出才算崩；还有窗口开着就当用户仍能看见桌面。
        if (shellCrashed(code, signal)) item.shellCrashEvent = { code, signal };
      };
      if (child.exitCode !== null && child.exitCode !== undefined) { leave(child.exitCode, child.signalCode); return; }
      child.on?.('exit', leave);
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
      closed = true; network.close(); unsubscribeTunnels?.();
      await Promise.all([...devices.values()].map(async (item) => {
        item.gateway?.close(); item.gateway = null; item.router.close();
        await tunnels?.close?.(item.binding.id);
      }));
      devices.clear();
    },
  };
}

module.exports = { createRemoteController, REMOTE_ERROR_TEXT, REMOTE_ERROR_FALLBACK };

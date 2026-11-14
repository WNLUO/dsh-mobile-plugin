// 每台电脑独立选路：实测排序、失败退避与身份验证。
'use strict';

const { createRoutePolicy } = require('../shared/route-order.cjs');
const { safeRoutes } = require('./local-headers.cjs');

const PRIORITY = ['lan', 'direct', 'ipv6', 'relay', 'tunnel', 'p2p'];
const keyOf = (route) => `${route.channel}|${route.url}`;
const terminal = (error) => ['REMOTE_REVOKED', 'REMOTE_EXPIRED'].includes(error?.code);

function createRemoteRouter({ binding, transport, tunnels, now = Date.now, onError = () => {}, onRoutes = async () => {} }) {
  const policy = createRoutePolicy();
  const accounts = new Map();
  let routes = safeRoutes(binding.routes);
  let selected = null;
  let mode = binding.mode || 'auto';
  let probing = null;
  let refreshing = null;
  let generation = 0;
  let closed = false;
  let probeCursor = 0;
  const pending = new Set();

  async function connectionInfo(info) {
    if (closed || !Array.isArray(info?.routes)) return;
    const next = safeRoutes(info.routes);
    if (!next.length || JSON.stringify(next) === JSON.stringify(safeRoutes(binding.routes))) return;
    await onRoutes(next);
    if (closed) return;
    binding.routes = next;
    routes = safeRoutes([...next, ...routes.filter((route) => ['tunnel', 'p2p'].includes(route.channel))]);
  }

  function account(route) {
    const key = keyOf(route);
    if (!accounts.has(key)) accounts.set(key, { failures: 0, until: 0, proven: false });
    return accounts.get(key);
  }

  function failure(route, error, penalize = true) {
    if (!route) return;
    const item = account(route);
    item.failures = Math.min(64, item.failures + 1);
    const threshold = ['tunnel', 'p2p'].includes(route.channel) ? 1 : 2;
    if (item.failures >= threshold) item.until = now() + Math.min(30000, 1000 * 2 ** Math.min(5, item.failures - threshold));
    if (penalize) policy.noteRouteFailure(route.url);
    if (error?.code === 'REMOTE_AUTH') policy.noteRouteForeign(route.url);
  }

  function proven(route) { accounts.set(keyOf(route), { failures: 0, until: 0, proven: true }); }

  function ordered() {
    const candidates = routes.filter((route) => mode === 'auto' || route.channel === mode);
    const suspended = candidates.filter((route) => account(route).until > now()).map((route) => route.url);
    return policy.orderRouteCandidates(candidates, selected?.url || '', suspended);
  }

  function refresh(networkChanged = false) {
    if (!['auto', 'tunnel', 'p2p'].includes(mode)) {
      routes = safeRoutes(binding.routes).sort((a, b) => PRIORITY.indexOf(a.channel) - PRIORITY.indexOf(b.channel));
      return Promise.resolve(routes);
    }
    if (refreshing && !networkChanged) return refreshing;
    const ticket = generation;
    const work = (async () => {
      let extra = [];
      try {
        const read = networkChanged && tunnels?.refresh ? tunnels.refresh(binding) : tunnels?.routesFor?.(binding);
        extra = await read || [];
      } catch (error) { if (terminal(error)) { onError(error); throw error; } }
      if (closed || ticket !== generation) return routes;
      routes = safeRoutes([...(binding.routes || []), ...extra]).sort((a, b) => PRIORITY.indexOf(a.channel) - PRIORITY.indexOf(b.channel));
      return routes;
    })();
    refreshing = work;
    work.finally(() => { if (refreshing === work) refreshing = null; }).catch(() => {});
    return work;
  }

  async function timed(operation, timeoutMs, late) {
    let timer;
    let elapsed = false;
    const abort = new AbortController();
    pending.add(abort);
    const result = Promise.resolve().then(() => operation(abort.signal));
    result.then((value) => { if (elapsed) late?.(value); }, () => {});
    try {
      return await Promise.race([result, new Promise((_resolve, reject) => {
        const cancel = () => { elapsed = true; reject(Object.assign(new Error('远程连接已取消'), { code: 'REMOTE_CONNECT' })); };
        abort.signal.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(() => { elapsed = true; reject(Object.assign(new Error('远程连接超时'), { code: 'REMOTE_TIMEOUT' })); abort.abort(); }, timeoutMs);
        timer.unref?.();
      })]);
    } finally { clearTimeout(timer); pending.delete(abort); }
  }

  function budget(route) {
    const item = account(route);
    if (['tunnel', 'p2p'].includes(route.channel)) return item.failures ? 4000 : 10000;
    return (!item.proven && route.channel !== 'relay') || item.failures ? 2500 : 7000;
  }

  async function open({ expiresAt } = {}) {
    if (closed) throw new Error('远程连接已停止');
    const refreshing = refresh();
    if (!routes.length) await refreshing;
    else void refreshing.catch(() => {});
    let last;
    for (const route of ordered()) {
      if (closed) throw Object.assign(new Error('远程连接已停止'), { code: 'REMOTE_CONNECT' });
      if (expiresAt && now() >= expiresAt) throw Object.assign(new Error('访问已到期'), { code: 'REMOTE_EXPIRED' });
      const timeoutMs = Math.max(1, Math.min(budget(route), expiresAt ? expiresAt - now() : Infinity));
      try {
        const result = await timed((signal) => transport.openRemoteStream(binding, route, { timeoutMs, expiresAt, signal, onConnectionInfo: connectionInfo }), timeoutMs, (value) => value?.stream?.destroy());
        if (closed || (expiresAt && now() >= expiresAt)) { result.stream.destroy(); throw Object.assign(new Error('访问已到期'), { code: 'REMOTE_EXPIRED' }); }
        selected = route; proven(route);
        await connectionInfo(result.host?.connectionInfo).catch(() => {});
        return result;
      } catch (error) {
        failure(route, error); last = error;
        if (terminal(error)) { onError(error); throw error; }
      }
    }
    throw last || Object.assign(new Error('没有可用的远程线路'), { code: 'REMOTE_CONNECT' });
  }

  function probe() {
    if (probing) return probing;
    const ticket = generation;
    probing = (async () => {
      const warming = refresh();
      if (!routes.length) await warming;
      else void warming.catch(() => {});
      const candidates = ordered();
      const current = candidates.find((route) => route.url === selected?.url);
      const challengers = candidates.filter((route) => route !== current);
      const rotated = challengers.length ? [...challengers.slice(probeCursor % challengers.length), ...challengers.slice(0, probeCursor % challengers.length)] : [];
      const queue = [...(current ? [current] : []), ...rotated.slice(0, 3)];
      probeCursor += Math.min(3, challengers.length);
      let index = 0;
      let fatal;
      let lastError;
      let successes = 0;
      const worker = async () => {
        while (!closed && ticket === generation && index < queue.length && !fatal) {
          const route = queue[index++];
          const timeoutMs = budget(route);
          try {
            const ms = await timed((signal) => transport.probeRemote(binding, route, { timeoutMs, signal, onConnectionInfo: connectionInfo }), timeoutMs);
            if (closed || ticket !== generation) return;
            if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new Error('远程探测没有返回延迟');
            policy.noteRouteLatency(route.url, ms); proven(route); successes += 1;
          } catch (error) {
            if (ticket !== generation || closed) return;
            policy.noteRouteLatency(route.url, null); failure(route, error, false); lastError = error;
            if (terminal(error)) { fatal = error; onError(error); }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, queue.length) }, worker));
      if (fatal) throw fatal;
      if (!successes && ticket === generation && !closed) throw lastError || Object.assign(new Error('没有可用的远程线路'), { code: 'REMOTE_CONNECT' });
      if (ticket === generation && !closed) selected = ordered()[0] || selected;
      return snapshot();
    })();
    probing.finally(() => { probing = null; }).catch(() => {});
    return probing;
  }

  function snapshot() {
    return { route: selected, routes: [...routes], latencyMs: selected ? policy.routeLatencyOf(selected.url) : null };
  }

  return {
    open, probe, refresh, snapshot,
    setMode(value) {
      if (value !== 'auto' && !routes.some((route) => route.channel === value)) throw new Error('这条线路当前不可用');
      mode = value; selected = ordered()[0] || null;
    },
    failure(error) { failure(selected, error); },
    async networkChanged() {
      generation += 1; policy.forgetRouteFacts(); accounts.clear(); selected = null;
      for (const abort of pending) abort.abort();
      const previous = probing;
      void refresh(true).catch((error) => onError(error));
      if (previous) await previous.catch(() => {});
      if (!closed) return probe();
      return snapshot();
    },
    close() { closed = true; generation += 1; for (const abort of pending) abort.abort(); policy.forgetRouteFacts(); accounts.clear(); },
  };
}

module.exports = { createRemoteRouter };

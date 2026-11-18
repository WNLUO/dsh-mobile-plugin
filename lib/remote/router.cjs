// 每台电脑独立选路：实测排序、失败退避与身份验证。
// 连接预算不写死：升级阶段按该线路的实测耗时（没有就用宽松默认）给上限，握手期间只要还在
// 收到消息就继续等；失败只影响先试谁，不缩短愿意等的时间。
'use strict';

const { createRoutePolicy } = require('../shared/route-order.cjs');
const { safeRoutes } = require('./local-headers.cjs');

const PRIORITY = ['lan', 'ipv6', 'relay', 'tunnel', 'p2p'];
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

  // 只负责取消，不再自己卡一个总时限：超时交给 transport 的两段式判定（升级上限 + 握手沉默窗口）。
  // 取消（关停 / 换网）时也要把自定义 transport 里挂住的 Promise 一并拒掉，晚到的结果回收掉。
  async function timed(operation) {
    const abort = new AbortController();
    pending.add(abort);
    let settled = false;
    const result = Promise.resolve().then(() => operation(abort.signal));
    result.then((value) => { if (abort.signal.aborted) value?.stream?.destroy(); }, () => {});
    const cancelled = new Promise((_resolve, reject) => {
      abort.signal.addEventListener('abort', () => {
        if (!settled) reject(Object.assign(new Error('远程连接已取消'), { code: 'REMOTE_CONNECT' }));
      }, { once: true });
    });
    try {
      return await Promise.race([result, cancelled]);
    } finally {
      settled = true;
      pending.delete(abort);
    }
  }

  const DEFAULT_CONNECT_MS = 10_000;
  const MIN_CONNECT_MS = 4_000;
  const MAX_CONNECT_MS = 30_000;
  const DEFAULT_IDLE_MS = 10_000;
  const MIN_IDLE_MS = 6_000;
  const MAX_IDLE_MS = 45_000;

  /** 升级阶段的上限：有实测握手耗时就在它上面加余量；没有就按线路类型给宽松默认。 */
  function connectBudget(route) {
    const measured = policy.routeLatencyOf(route.url);
    if (typeof measured === 'number' && Number.isFinite(measured) && measured >= 0) {
      return Math.min(MAX_CONNECT_MS, Math.max(MIN_CONNECT_MS, Math.round(measured + 5_000)));
    }
    return ['tunnel', 'p2p'].includes(route.channel) ? 15_000 : DEFAULT_CONNECT_MS;
  }

  /** 握手期间允许的沉默时长：有实测就跟着放大，没有给一个宽松默认。 */
  function idleBudget(route) {
    const measured = policy.routeLatencyOf(route.url);
    if (typeof measured === 'number' && Number.isFinite(measured) && measured >= 0) {
      return Math.min(MAX_IDLE_MS, Math.max(MIN_IDLE_MS, Math.round(measured + 5_000)));
    }
    return DEFAULT_IDLE_MS;
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
      const remaining = expiresAt ? Math.max(1, expiresAt - now()) : Infinity;
      const connectTimeoutMs = Math.min(connectBudget(route), remaining);
      const idleTimeoutMs = Math.min(idleBudget(route), remaining);
      try {
        const result = await timed((signal) => transport.openRemoteStream(binding, route, { connectTimeoutMs, idleTimeoutMs, expiresAt, signal, onConnectionInfo: connectionInfo }));
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
          const connectTimeoutMs = connectBudget(route);
          const idleTimeoutMs = idleBudget(route);
          try {
            const ms = await timed((signal) => transport.probeRemote(binding, route, { connectTimeoutMs, idleTimeoutMs, signal, onConnectionInfo: connectionInfo }));
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

  // 逐条探活当前所有安全候选：只读探测，既不选中也不改 state，单条失败不影响其它。
  // 不传 onConnectionInfo，避免探测顺手把地址写回绑定。
  async function diagnose() {
    const probeOne = async (route) => {
      const connectTimeoutMs = Math.min(8_000, connectBudget(route));
      const idleTimeoutMs = Math.min(8_000, idleBudget(route));
      let timer;
      try {
        const ms = await timed((signal) => {
          const probe = transport.probeRemote(binding, route, { connectTimeoutMs, idleTimeoutMs, signal });
          const cap = new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('探测超时'), { code: 'REMOTE_TIMEOUT' })), connectTimeoutMs);
            timer.unref?.();
          });
          return Promise.race([probe, cap]);
        });
        const latencyMs = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null;
        return { channel: route.channel, url: route.url, ok: latencyMs !== null, latencyMs, errorCode: null };
      } catch (error) {
        return { channel: route.channel, url: route.url, ok: false, latencyMs: null, errorCode: error?.code || 'REMOTE_CONNECT' };
      } finally {
        clearTimeout(timer);
      }
    };
    return Promise.all([...routes].map(probeOne));
  }

  function snapshot() {
    return { route: selected, routes: [...routes], latencyMs: selected ? policy.routeLatencyOf(selected.url) : null };
  }

  return {
    open, probe, refresh, snapshot, diagnose,
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

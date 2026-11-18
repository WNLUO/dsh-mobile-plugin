// 每台电脑独立选路：实测排序、失败退避与身份验证。
// 连接预算不写死：升级阶段按该线路的实测耗时（没有就用宽松默认）给上限，握手期间只要还在
// 收到消息就继续等；失败只影响先试谁，不缩短愿意等的时间。
// 2026-11-19：换网后没有当前线路时按通道各取一条候选（中转必进）、候选并发各探一发先答者用；
// 单轮没探全只留证据、不判整台离线；固定挡位没有候选时按 auto 兜底；open 返回值带上实际选中
// 的 route 字段（controller 据此记录在用的线路）。
// 2026-11-19：通道顺序、失败阈值与建连档位改从 App 同步的通道表（shared/route-channels.cjs）派生，
// 表外通道排最后，不再各自写死一份。
'use strict';

const { createRoutePolicy } = require('../shared/route-order.cjs');
const { ROUTE_CHANNELS } = require('../shared/route-channels.cjs');
const { safeRoutes } = require('./local-headers.cjs');

// 通道顺序、失败阈值与建连档位都从生成的通道表派生（表是唯一真源）。
const PRIORITY = ROUTE_CHANNELS.map((row) => row.channel);
/** 排序键：表内按表序，表外排到最后（用表长，避免未知通道排到最前）。 */
const priorityIndex = (channel) => {
  const at = PRIORITY.indexOf(channel);
  return at === -1 ? PRIORITY.length : at;
};
/** 这条通道失败多少次才退避；表外通道按 2（与改造前一致）。 */
const backoffThresholdOf = (channel) => ROUTE_CHANNELS.find((row) => row.channel === channel)?.backoffThreshold ?? 2;
/** 这条通道的建连档；表外通道按非隧道档（与改造前一致）。 */
const budgetOf = (channel) => ROUTE_CHANNELS.find((row) => row.channel === channel)?.budget;
const keyOf = (route) => `${route.channel}|${route.url}`;
const terminal = (error) => ['REMOTE_REVOKED', 'REMOTE_EXPIRED'].includes(error?.code);

// 轮转切一段候选：每一轮从游标往后取，保证别的候选迟早各轮到一次。
function rotated(list, offset) {
  if (!list.length) return [];
  const at = offset % list.length;
  return [...list.slice(at), ...list.slice(0, at)];
}

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
    const threshold = backoffThresholdOf(route.channel);
    if (item.failures >= threshold) item.until = now() + Math.min(30000, 1000 * 2 ** Math.min(5, item.failures - threshold));
    if (penalize) policy.noteRouteFailure(route.url);
    if (error?.code === 'REMOTE_AUTH') policy.noteRouteForeign(route.url);
  }

  function proven(route) { accounts.set(keyOf(route), { failures: 0, until: 0, proven: true }); }

  function ordered() {
    const scoped = mode === 'auto' ? routes : routes.filter((route) => route.channel === mode);
    // 固定挡位一条候选都没有（那条路不存在了）：按 auto 兜底，别让用户卡在「没有可用的远程线路」；
    // 真正全部探测失败才由 open / probe 报错。
    const candidates = scoped.length ? scoped : routes;
    const suspended = candidates.filter((route) => account(route).until > now()).map((route) => route.url);
    return policy.orderRouteCandidates(candidates, selected?.url || '', suspended);
  }

  function refresh(networkChanged = false) {
    if (!['auto', 'tunnel', 'p2p'].includes(mode)) {
      routes = safeRoutes(binding.routes).sort((a, b) => priorityIndex(a.channel) - priorityIndex(b.channel));
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
      routes = safeRoutes([...(binding.routes || []), ...extra]).sort((a, b) => priorityIndex(a.channel) - priorityIndex(b.channel));
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
    return budgetOf(route.channel) === 'tunnel' ? 15_000 : DEFAULT_CONNECT_MS;
  }

  /** 握手期间允许的沉默时长：有实测就跟着放大，没有给一个宽松默认。 */
  function idleBudget(route) {
    const measured = policy.routeLatencyOf(route.url);
    if (typeof measured === 'number' && Number.isFinite(measured) && measured >= 0) {
      return Math.min(MAX_IDLE_MS, Math.max(MIN_IDLE_MS, Math.round(measured + 5_000)));
    }
    return DEFAULT_IDLE_MS;
  }

  // 换网后没有当前线路：候选并发各发一发探测，先成功的那条直接拿去 open；落后者不取消，
  // 结果照旧喂给选路账本。稳态（已有当前线路）不走这条，仍按顺序串行试。
  function raceCandidates(candidates, expiresAt) {
    return new Promise((resolve) => {
      let settled = false;
      let remaining = candidates.length;
      const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
      for (const route of candidates) {
        const left = expiresAt ? Math.max(1, expiresAt - now()) : Infinity;
        const connectTimeoutMs = Math.min(connectBudget(route), left);
        const idleTimeoutMs = Math.min(idleBudget(route), left);
        timed((signal) => transport.probeRemote(binding, route, { connectTimeoutMs, idleTimeoutMs, signal, onConnectionInfo: connectionInfo }))
          .then((ms) => {
            if (closed) return;
            if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new Error('远程探测没有返回延迟');
            policy.noteRouteLatency(route.url, ms); proven(route);
            finish({ route });
          })
          .catch((error) => {
            if (closed) return;
            policy.noteRouteLatency(route.url, null); failure(route, error, false);
            if (terminal(error)) { onError(error); finish({ error }); }
          })
          .finally(() => {
            remaining -= 1;
            if (remaining === 0) finish(null);
          });
      }
      if (!candidates.length) finish(null);
    });
  }

  async function open({ expiresAt } = {}) {
    if (closed) throw new Error('远程连接已停止');
    const refreshing = refresh();
    if (!routes.length) await refreshing;
    else void refreshing.catch(() => {});
    let last;
    let queue = ordered();
    // 换网后没有当前线路：几条一起各试一发，谁先通就先拿它去拨；一条都没通就直接报，
    // 不逐条把每条死地址的预算都等满。
    if (!selected && queue.length > 1) {
      const raced = await raceCandidates(queue, expiresAt);
      if (raced?.error) throw raced.error;
      if (closed) throw Object.assign(new Error('远程连接已停止'), { code: 'REMOTE_CONNECT' });
      if (!raced) throw Object.assign(new Error('没有可用的远程线路'), { code: 'REMOTE_CONNECT' });
      queue = [raced.route, ...ordered().filter((route) => route !== raced.route)];
    }
    for (const route of queue) {
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
        // controller 在 connect 回调里读它记「实际在用线路」，一定带上。
        return { ...result, route };
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
      let queue;
      if (current) {
        const challengers = candidates.filter((route) => route !== current);
        queue = [current, ...rotated(challengers, probeCursor).slice(0, 3)];
        probeCursor += Math.min(3, challengers.length);
      } else {
        // 没有当前线路（刚换网）：每条通道的第一条都要留在队列里（中转必进），再按轮转补到三条 ——
        // 只轮转固定顺序的前三条会把排在后面的通道整个盖掉，明明通着的中转也探不到。
        const picked = [];
        const channels = new Set();
        for (const route of candidates) {
          if (channels.has(route.channel)) continue;
          channels.add(route.channel);
          picked.push(route);
        }
        const rest = candidates.filter((route) => !picked.includes(route));
        queue = [...picked, ...rotated(rest, probeCursor).slice(0, Math.max(0, 3 - picked.length))];
        probeCursor += Math.min(3, rest.length);
      }
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
      const fresh = ticket === generation && !closed;
      // 这一轮只探了一部分候选（还有通道 / 同通道的后备没试）就先不下结论：只留证据，
      // 不抛错，也不把整台电脑判成离线。
      if (!successes) {
        if (queue.length >= candidates.length && fresh) throw lastError || Object.assign(new Error('没有可用的远程线路'), { code: 'REMOTE_CONNECT' });
        return snapshot();
      }
      if (fresh) selected = ordered()[0] || selected;
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
      // 带错误码：静态档位白名单删掉后，这条是唯一的存在性判据，界面要能给出具体提示而不是兜底文案。
      if (value !== 'auto' && !routes.some((route) => route.channel === value)) throw Object.assign(new Error('这条线路当前不可用'), { code: 'bad-mode' });
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

'use strict';
// IPv6 直连候选的本机活性预筛。
//
// 为什么：手机配对/重连时拿到的 IPv6 候选是**静态快照**（二维码、总控上报、connection-info），
// 里面可能混着已经失效的地址（RFC 4941 临时地址轮换、前缀撤销）。手机逐条去拨，每条要吃满
// 自己那一侧的操作系统 TCP 超时。这里在本机对每条候选做一次**短超时 TCP 连**（连的是本机自己的
// 监听端口）：连不上基本就等于这条地址已经不在网卡上/不可用，先降权排尾。
//
// 它只能证伪「本机这条地址此刻还通」，证明不了「手机在外面一定拨得进来」——所以它是旁路预筛，
// 不是保证。结果按 TTL 缓存，供同步的候选生成直接过滤；探测本身失败一律吞掉，不制造新失败点。
const net = require('node:net');

const DEFAULT_TIMEOUT_MS = 1000;
const DEFAULT_TTL_MS = 60_000;
/** 同一地址两次主动探测的最小间隔：避免每次取候选都打一发。 */
const DEFAULT_RETRY_MS = 30_000;

/** 对 host:port 做一次短超时 TCP 连接；连上为 true，超时/报错为 false。 */
function probeTcp(host, port, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (alive) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* 已关闭 */ }
      resolve(alive);
    };
    const socket = net.connect({ host, port });
    socket.setTimeout(Math.max(1, timeoutMs));
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** 从 URL 里取出 host:port（IPv6 会带方括号）；取不到（端口 0 / 缺端口）返回 null。 */
function parseHostPort(url) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]+\]|[^/:]+)(?::(\d+))?/i.exec(String(url || ''));
  if (!match) return null;
  let host = match[1];
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const port = match[2] ? Number(match[2]) : 0;
  if (!host || !Number.isInteger(port) || port <= 0) return null;
  return { host, port };
}

/**
 * 一个按 TTL 记账的活性缓存。
 * @param {{ probe?: (host:string, port:number)=>Promise<boolean>, timeoutMs?: number, ttlMs?: number, retryMs?: number, now?: ()=>number }} [options]
 */
function createLivenessCache(options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS;
  const retryMs = Number(options.retryMs) >= 0 ? Number(options.retryMs) : DEFAULT_RETRY_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const probe = typeof options.probe === 'function' ? options.probe : (host, port) => probeTcp(host, port, timeoutMs);
  /** url → 判定为「死」的截止时刻。 */
  const deadUntil = new Map();
  const probing = new Set();
  const lastProbedAt = new Map();

  function isDead(url) {
    const until = deadUntil.get(url);
    if (until === undefined) return false;
    if (now() >= until) { deadUntil.delete(url); return false; }
    return true;
  }

  /** 起一轮旁路探测；同一地址在 retryMs 内不重复打。 */
  function schedule(urls) {
    const at = now();
    for (const url of urls) {
      if (probing.has(url)) continue;
      const target = parseHostPort(url);
      if (!target) continue;
      const last = lastProbedAt.get(url);
      if (last !== undefined && at - last < retryMs) continue;
      lastProbedAt.set(url, at);
      probing.add(url);
      Promise.resolve()
        .then(() => probe(target.host, target.port))
        .then((alive) => { if (alive) deadUntil.delete(url); else deadUntil.set(url, now() + ttlMs); })
        .catch(() => { /* 探测失败不改结论 */ })
        .finally(() => { probing.delete(url); });
    }
  }

  /** 过滤掉已知死地址，并顺手为整批起一轮探测。返回仍认为活的 urls。 */
  function filter(urls) {
    const list = Array.from(urls);
    schedule(list);
    return list.filter((url) => !isDead(url));
  }

  function reset() { deadUntil.clear(); probing.clear(); lastProbedAt.clear(); }

  return { isDead, schedule, filter, reset, _deadUntil: deadUntil };
}

const defaultCache = createLivenessCache();

module.exports = { createLivenessCache, probeTcp, parseHostPort, defaultCache, DEFAULT_TIMEOUT_MS, DEFAULT_TTL_MS };

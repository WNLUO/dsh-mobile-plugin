'use strict';

/**
 * 内存自检台账：内存出问题之后，用来回答「当时到底堆在哪儿」。
 *
 * 一次性报出两个进程的内存、各路活着的流数，以及插件自己那几个只增不减的容器有多大。
 *
 * 口径：插件住在宿主进程里，没有独立内存可测。`hostProcess` 报的是整个宿主进程的
 * `process.memoryUsage()`，不是「插件占了多少」；侧车是另一个进程，记在 `sidecarProcess`
 * 下，两个数不能相加成「插件内存」。字段名与 `caveat` 按这个口径写死。
 *
 * 数据全走既有通道：本进程 memoryUsage、worker 的 `/status` 快照（没上报就报 null 并记进
 * `unavailable`，不拿 0 顶替）、局域网 `stats()`、镜像推送记账与缓存。
 *
 * 做成 `createSelfCheck(deps)` 而不是单例：镜像缓存按 ctx 隔离，拿不到 ctx 就读不到。
 *
 * `mirror.cachedBytes` 是估算（字符串按 length、数字 8 字节、对象固定开销）；走查有节点
 * 预算，用尽时 `cachedBytesComplete` 为 false，那个数是下限。
 */

const v8 = require('node:v8');

const { mirrorHistoryStateOf } = require('./session-cache.js');

/** 字节估算的节点预算：status 每 3s 被面板拉一次，走查必须是有界的。 */
const MAX_WALK_NODES = 20000;
/** 每个对象/数组的固定开销估计（V8 里一个空对象约这个量级）。 */
const OBJECT_OVERHEAD_BYTES = 24;

/** 只认有限数：NaN/Infinity/字符串一律记 null，「不知道」不能写成 0。 */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `process.memoryUsage()` 的白名单副本 + V8 堆上限（超了这个数就是 heap OOM）。 */
function memoryOf(usage, heapStatistics) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    rss: finiteNumber(usage.rss),
    heapTotal: finiteNumber(usage.heapTotal),
    heapUsed: finiteNumber(usage.heapUsed),
    external: finiteNumber(usage.external),
    arrayBuffers: finiteNumber(usage.arrayBuffers),
    heapSizeLimit: heapStatistics && typeof heapStatistics === 'object'
      ? finiteNumber(heapStatistics.heap_size_limit)
      : null,
  };
}

/**
 * 估算一棵对象树占的字节（口径见文件头）。节点预算用尽时 `complete:false`，`bytes` 是下限。
 */
function estimateBytes(root, budget = MAX_WALK_NODES) {
  const seen = new Set();
  const stack = [root];
  let bytes = 0;
  let nodes = 0;
  while (stack.length) {
    if (nodes >= budget) return { bytes, complete: false };
    const node = stack.pop();
    nodes += 1;
    if (typeof node === 'string') { bytes += node.length; continue; }
    if (typeof node === 'number') { bytes += 8; continue; }
    if (typeof node === 'boolean') { bytes += 4; continue; }
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);
    bytes += OBJECT_OVERHEAD_BYTES;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    for (const key of Object.keys(node)) {
      bytes += key.length;
      stack.push(node[key]);
    }
  }
  return { bytes, complete: true };
}

/**
 * 镜像缓存本体：条目数 / 消息条数 / 估算字节。
 *
 * ⚠️ `mirrorHistoryStateOf(ctx)` 在 ctx 上还没有这张表时会**建一张空的**——这与第一次
 * 镜像推送本来就会做的事完全一样，没有额外状态。ctx 为空（本文件被单独 require 时）
 * 返回 null，不抛。
 */
function mirrorCacheOf(ctx) {
  if (!ctx) return null;
  const cache = mirrorHistoryStateOf(ctx);
  if (!cache || typeof cache.size !== 'number') return null;
  let messages = 0;
  const bodies = [];
  for (const entry of cache.values()) {
    const items = entry && entry.body && Array.isArray(entry.body.items) ? entry.body.items : null;
    if (items) messages += items.length;
    bodies.push(entry ? entry.body : null);
  }
  const estimate = estimateBytes(bodies);
  return { entries: cache.size, messages, bytes: estimate.bytes, complete: estimate.complete };
}

/**
 * 建一份自检台账。所有依赖都是取值器或只读模块，本模块不持有 ctx 之外的可变状态。
 *
 * @param {object} [deps]
 * @param {object} [deps.ctx] 插件 ctx（读镜像缓存需要；缺省时镜像缓存报 null）
 * @param {() => object|null} [deps.getSidecarSnapshot] worker 的 `/status` 快照取值器
 * @param {() => object|null} [deps.getMirrorPush] 镜像推送记账（pusher 提供）
 * @param {() => Array} [deps.getMirrorPushFailures] 待补推会话账（pusher 提供）
 * @param {() => ({upstreamOpen: number, sseOpen: number})|null} [deps.getLanProxyStats]
 *   局域网直连路的活连接数（`lan-proxy.js` 的 `stats()`）
 * @param {object|null} [deps.credentials] 本机设备凭据库
 */
function createSelfCheck(deps = {}) {
  const {
    ctx = null,
    getSidecarSnapshot = () => null,
    getMirrorPush = () => null,
    getMirrorPushFailures = () => null,
    getLanProxyStats = () => null,
    credentials = null,
  } = deps;
  const since = Date.now();

  function hostProcess() {
    const usage = process.memoryUsage();
    return {
      // ⚠️ 口径：整个宿主进程，不是插件自己（见文件头）。
      scope: 'host-process',
      caveat: '插件住在宿主里，没有独立内存；这里是整个 DSH 宿主进程，含宿主自身与其它插件',
      ...memoryOf(usage, v8.getHeapStatistics()),
      startedAt: since,
    };
  }

  function sidecarProcess(snapshot) {
    const reported = snapshot && snapshot.process && snapshot.process.memoryUsage;
    const memory = memoryOf(reported);
    return { memory };
  }

  function streams(snapshot) {
    const lan = getLanProxyStats();
    const relaySseOpen = snapshot && snapshot.streams ? finiteNumber(snapshot.streams.relaySseOpen) : null;
    return {
      // 中转路：worker 里 `relay/tunnel.js` 的 sseClients.size。
      relaySseOpen,
      // 局域网直连路：`lan-proxy.js` 的 stats()。
      lanUpstreamOpen: lan ? finiteNumber(lan.upstreamOpen) : null,
      lanSseOpen: lan ? finiteNumber(lan.sseOpen) : null,
    };
  }

  function mirror() {
    // 拿不到记账时整块报 null 并记进 unavailable：`skippedBodies` 报 0 会被读成
    // 「一次都没跳过」，而那是「不知道」——两者在排查时结论正好相反。
    const push = getMirrorPush();
    const known = Boolean(push) && typeof push === 'object';
    const failures = getMirrorPushFailures();
    const cache = mirrorCacheOf(ctx);
    return {
      pushedAt: known ? (finiteNumber(push.pushedAt) === null ? 0 : finiteNumber(push.pushedAt)) : null,
      ok: known && typeof push.ok === 'boolean' ? push.ok : null,
      error: known && typeof push.error === 'string' ? push.error : null,
      skippedBodies: known ? (finiteNumber(push.skippedBodies) === null ? 0 : finiteNumber(push.skippedBodies)) : null,
      skipReason: known && typeof push.skipReason === 'string' ? push.skipReason : null,
      // 待补推的会话数（pusher 的失败重试账长度）。
      pushFailures: Array.isArray(failures) ? failures.length : null,
      // 清单规模：会话总数 / 其中活跃（在跑或 5 分钟内动过）/ 其中子会话 / 这份读数的时间。
      // 这是插件侧**能诚实报出的**「会话有多少」——手机侧栏读的就是这份清单。
      // ⚠️ 它**不是**「宿主内存里挂着多少会话、正文占多少」：插件住在宿主进程里，看不到那个
      // 口径（见文件头）。正文规模只能由 `cachedBytes` 那一格回答「插件自己握着多少」。
      listSessions: known ? finiteNumber(push.listSessions) : null,
      listActiveSessions: known ? finiteNumber(push.listActiveSessions) : null,
      listSubagents: known ? finiteNumber(push.listSubagents) : null,
      listAt: known ? (finiteNumber(push.listAt) === null ? 0 : finiteNumber(push.listAt)) : null,
      cachedSessions: cache ? cache.entries : null,
      cachedMessages: cache ? cache.messages : null,
      cachedBytes: cache ? cache.bytes : null,
      cachedBytesComplete: cache ? cache.complete : null,
    };
  }

  function credentialsBlock() {
    const list = credentials && typeof credentials.listActive === 'function'
      ? credentials.listActive()
      : null;
    return { active: Array.isArray(list) ? list.length : null };
  }

  /** 当前读数副本：每次调用都是新对象，status 视图读它、改它都不影响下一份。 */
  function snapshot() {
    const sidecarSnapshot = getSidecarSnapshot();
    const sidecar = sidecarProcess(sidecarSnapshot);
    const flow = streams(sidecarSnapshot);
    const mir = mirror();
    const creds = credentialsBlock();
    const unavailable = [];
    if (!sidecar.memory) {
      unavailable.push('sidecarProcess.memory: worker 的 /status 未上报 process.memoryUsage');
    }
    if (flow.relaySseOpen === null) {
      unavailable.push('streams.relaySseOpen: worker 的 /status 未上报 streams.relaySseOpen');
    }
    if (flow.lanUpstreamOpen === null) {
      unavailable.push('streams.lanUpstreamOpen: 拿不到局域网 stats()（见 self-check.cjs 文件头）');
    }
    if (mir.cachedSessions === null) {
      unavailable.push('mirror.cachedSessions: 没有 ctx，读不到镜像缓存');
    }
    if (mir.pushedAt === null) {
      unavailable.push('mirror.pushedAt: 拿不到镜像推送记账（getMirrorPush）');
    }
    if (mir.pushFailures === null) {
      unavailable.push('mirror.pushFailures: 拿不到镜像待补推账（getMirrorPushFailures）');
    }
    if (creds.active === null) {
      unavailable.push('credentials.active: 拿不到凭据库');
    }
    return {
      since,
      hostProcess: hostProcess(),
      sidecarProcess: sidecar,
      streams: flow,
      mirror: mir,
      credentials: creds,
      unavailable,
    };
  }

  return { snapshot };
}

module.exports = { createSelfCheck, estimateBytes, memoryOf, MAX_WALK_NODES };

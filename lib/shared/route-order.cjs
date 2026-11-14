'use strict';
// 由 App 自动选路规则同步；运行 scripts/sync-route-policy.mjs 更新。
function createRoutePolicy() {
  const exports = {};
  "use strict";
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.noteRouteLatency = noteRouteLatency;
  exports.noteRouteFailure = noteRouteFailure;
  exports.noteRouteForeign = noteRouteForeign;
  exports.isRouteForeign = isRouteForeign;
  exports.routeLatencyOf = routeLatencyOf;
  exports.routeCostOf = routeCostOf;
  exports.forgetRouteFacts = forgetRouteFacts;
  exports.orderRouteCandidates = orderRouteCandidates;
  const LOSS_PENALTY_MAX = 4;
  const FAILURE_PENALTY_STEP = 1.5;
  const FAILURE_PENALTY_MAX = 4;
  function penaltyOf(attempts) {
      if (!attempts)
          return null;
      const total = Number(attempts.attempts);
      const ok = Number(attempts.ok);
      if (!Number.isFinite(total) || total <= 0)
          return null;
      if (!Number.isFinite(ok) || ok <= 0)
          return LOSS_PENALTY_MAX;
      return Math.min(LOSS_PENALTY_MAX, total / ok);
  }
  const ROUTE_SWITCH_SHARE = 1 / 3;
  const SWITCH_GAIN_FLOOR_MS = 10;
  const STALE_EVIDENCE_ROUNDS = 12;
  const latency = new Map();
  const samples = new Map();
  const SAMPLE_WINDOW = 5;
  let evidenceRound = 0;
  const evidenceAtRound = new Map();
  const lossPenalty = new Map();
  const failurePenalty = new Map();
  const foreign = new Set();
  function norm(url) {
      return String(url || '').trim().replace(/\/+$/, '');
  }
  function noteRouteLatency(url, ms, attempts) {
      const key = norm(url);
      if (!key)
          return;
      evidenceRound += 1;
      if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) {
          latency.set(key, ms);
          evidenceAtRound.set(key, evidenceRound);
          const window = samples.get(key) ?? [];
          window.push(ms);
          samples.set(key, window.length > SAMPLE_WINDOW ? window.slice(window.length - SAMPLE_WINDOW) : window);
          const penalty = penaltyOf(attempts);
          if (penalty === null)
              lossPenalty.delete(key);
          else
              lossPenalty.set(key, penalty);
          failurePenalty.delete(key);
          return;
      }
      samples.delete(key);
      lossPenalty.delete(key);
      noteRouteFailure(key);
  }
  function settledOf(key) {
      const window = samples.get(key);
      const ms = latency.get(key);
      if (!window || window.length === 0)
          return ms;
      if (window.length === 1)
          return window[0];
      const sorted = [...window].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  const MIN_NOISE_SAMPLES = 2;
  function sampleCountOf(key) {
      return samples.get(key)?.length ?? 0;
  }
  function noiseBandOf(key) {
      const window = samples.get(key);
      if (!window || window.length < 2)
          return 0;
      let min = window[0];
      let max = window[0];
      for (const value of window) {
          if (value < min)
              min = value;
          if (value > max)
              max = value;
      }
      return (max - min) / 2;
  }
  function noteRouteFailure(url) {
      const key = norm(url);
      if (!key)
          return;
      const prev = failurePenalty.get(key) ?? 1;
      failurePenalty.set(key, Math.min(FAILURE_PENALTY_MAX, prev * FAILURE_PENALTY_STEP));
  }
  function isFresh(key, threshold = STALE_EVIDENCE_ROUNDS) {
      const at = evidenceAtRound.get(key);
      return typeof at === 'number' && evidenceRound - at <= threshold;
  }
  function staleThresholdFor(routeCount) {
      const perRound = Math.max(6, routeCount);
      return STALE_EVIDENCE_ROUNDS * Math.max(1, Math.ceil(perRound / 6));
  }
  function settledCostOf(key) {
      const ms = settledOf(key);
      if (ms === undefined)
          return undefined;
      return ms * (lossPenalty.get(key) ?? 1) * (failurePenalty.get(key) ?? 1);
  }
  function noiseCostOf(key) {
      return noiseBandOf(key) * (lossPenalty.get(key) ?? 1) * (failurePenalty.get(key) ?? 1);
  }
  const SETTLE_ROUNDS = 4;
  let lastSwitch = null;
  function costOf(url) {
      const key = norm(url);
      const ms = latency.get(key);
      if (ms === undefined)
          return undefined;
      return ms * (lossPenalty.get(key) ?? 1) * (failurePenalty.get(key) ?? 1);
  }
  function noteRouteForeign(url) {
      const key = norm(url);
      if (key)
          foreign.add(key);
  }
  function isRouteForeign(url) {
      return foreign.has(norm(url));
  }
  function routeLatencyOf(url) {
      const value = latency.get(norm(url));
      return typeof value === 'number' ? value : null;
  }
  function routeCostOf(url) {
      const value = costOf(url);
      return typeof value === 'number' ? value : null;
  }
  function forgetRouteFacts() {
      latency.clear();
      samples.clear();
      lossPenalty.clear();
      failurePenalty.clear();
      evidenceAtRound.clear();
      foreign.clear();
      lastSwitch = null;
  }
  function orderRouteCandidates(routes, currentUrl = '', suspended = []) {
      const current = norm(currentUrl);
      const foreignFree = routes.filter((route) => !foreign.has(norm(route.url)));
      const cooling = new Set((suspended || []).map(norm).filter(Boolean));
      const allCooling = foreignFree.length > 0 && foreignFree.every((route) => cooling.has(norm(route.url)));
      const cool = allCooling ? new Set() : cooling;
      const warm = foreignFree.filter((route) => !cool.has(norm(route.url)));
      const cold = foreignFree.filter((route) => cool.has(norm(route.url)));
      const staleThreshold = staleThresholdFor(warm.length);
      const known = warm
          .filter((route) => latency.has(norm(route.url)) && isFresh(norm(route.url), staleThreshold))
          .sort((a, b) => settledCostOf(norm(a.url)) - settledCostOf(norm(b.url)));
      const unknown = warm.filter((route) => !(latency.has(norm(route.url)) && isFresh(norm(route.url), staleThreshold)));
      const ordered = [...known, ...unknown, ...cold];
      const at = ordered.findIndex((route) => norm(route.url) === current);
      if (at < 0)
          return ordered;
      if (at === 0)
          return ordered;
      if (cool.has(current))
          return ordered;
      const currentCost = isFresh(current, staleThreshold) ? settledCostOf(current) : undefined;
      if (currentCost === undefined)
          return ordered;
      const headUrl = norm(ordered[0].url);
      const headCost = settledCostOf(headUrl);
      const settleRounds = SETTLE_ROUNDS * Math.max(1, Math.ceil(warm.length / 6));
      if (lastSwitch && evidenceRound - lastSwitch.round > settleRounds)
          lastSwitch = null;
      const bouncingBack = Boolean(lastSwitch && lastSwitch.to === current && lastSwitch.from === headUrl);
      const enoughEvidence = sampleCountOf(current) >= MIN_NOISE_SAMPLES
          && sampleCountOf(headUrl) >= MIN_NOISE_SAMPLES;
      const gain = headCost !== undefined ? currentCost - headCost : 0;
      const noise = enoughEvidence ? noiseCostOf(current) + noiseCostOf(headUrl) : 0;
      const required = Math.max(noise, currentCost * ROUTE_SWITCH_SHARE, SWITCH_GAIN_FLOOR_MS);
      const worthwhile = headCost !== undefined && gain > required;
      const decisive = gain > required * 2;
      const settled = !bouncingBack || decisive;
      if (settled && worthwhile) {
          lastSwitch = { from: current, to: headUrl, round: evidenceRound };
          return ordered;
      }
      const [item] = ordered.splice(at, 1);
      ordered.unshift(item);
      return ordered;
  }

  return exports;
}
module.exports = { createRoutePolicy, ...createRoutePolicy() };

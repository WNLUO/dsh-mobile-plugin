'use strict';
// 由 App 自动选路规则同步；运行 scripts/sync-route-policy.mjs 更新。
function createRoutePolicy() {
  const exports = {};
  "use strict";
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.advanceRouteEvidenceRound = advanceRouteEvidenceRound;
  exports.noteRouteLatency = noteRouteLatency;
  exports.noteRouteFailure = noteRouteFailure;
  exports.noteRouteProven = noteRouteProven;
  exports.noteRouteVerified = noteRouteVerified;
  exports.noteRouteForeign = noteRouteForeign;
  exports.isRouteForeign = isRouteForeign;
  exports.routeLatencyOf = routeLatencyOf;
  exports.freshRouteLatencyOf = freshRouteLatencyOf;
  exports.routeCostOf = routeCostOf;
  exports.forgetRouteFacts = forgetRouteFacts;
  exports.orderRouteCandidates = orderRouteCandidates;
  const LOSS_PENALTY_MAX = 4;
  const FAILURE_PENALTY_STEP = 1.5;
  const FAILURE_PENALTY_MAX = 4;
  const SAMPLE_WINDOW = 5;
  const MIN_NOISE_SAMPLES = 2;
  const ROUTE_SWITCH_SHARE = 1 / 3;
  const SWITCH_GAIN_FLOOR_MS = 10;
  const SETTLE_ROUNDS = 4;
  const factsByScope = new Map();
  function factsOf(scope) {
      let facts = factsByScope.get(scope);
      if (!facts) {
          facts = {
              latency: new Map(), samples: new Map(), lossPenalty: new Map(), failurePenalty: new Map(),
              foreign: new Set(), evidenceAtRound: new Map(), evidenceRound: 0, staleRounds: 2, lastSwitch: null,
          };
          factsByScope.set(scope, facts);
      }
      return facts;
  }
  function norm(url) {
      return String(url || '').trim().replace(/\/+$/, '');
  }
  function penaltyOf(attempts) {
      if (!attempts)
          return null;
      const total = Number(attempts.attempts);
      const ok = Number(attempts.ok);
      if (!Number.isFinite(total) || total <= 0)
          return null;
      if (!Number.isFinite(ok) || ok <= 0)
          return LOSS_PENALTY_MAX;
      return Math.max(1, Math.min(LOSS_PENALTY_MAX, total / ok));
  }
  function advanceRouteEvidenceRound(candidateCount, probeLimit, scope = '') {
      const facts = factsOf(scope);
      const count = Number.isFinite(candidateCount) ? Math.max(1, Math.ceil(candidateCount)) : 1;
      const limit = Number.isFinite(probeLimit) ? Math.max(1, Math.floor(probeLimit)) : 1;
      facts.staleRounds = 2 * Math.ceil(count / limit);
      facts.evidenceRound += 1;
      for (const [key, at] of facts.evidenceAtRound) {
          if (facts.evidenceRound - at <= facts.staleRounds)
              continue;
          facts.evidenceAtRound.delete(key);
          facts.samples.delete(key);
      }
      if (facts.lastSwitch && facts.evidenceRound - facts.lastSwitch.round > SETTLE_ROUNDS)
          facts.lastSwitch = null;
  }
  function isFresh(facts, key) {
      const at = facts.evidenceAtRound.get(key);
      return at !== undefined && facts.evidenceRound - at <= facts.staleRounds;
  }
  function noteRouteLatency(url, ms, attempts, scope = '') {
      const key = norm(url);
      if (!key || typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0)
          return;
      const facts = factsOf(scope);
      const window = facts.samples.get(key) ?? [];
      window.push(ms);
      facts.samples.set(key, window.slice(-SAMPLE_WINDOW));
      facts.latency.set(key, ms);
      facts.evidenceAtRound.set(key, facts.evidenceRound);
      const penalty = penaltyOf(attempts);
      if (penalty !== null)
          facts.lossPenalty.set(key, penalty);
  }
  function noteRouteFailure(url, scope = '') {
      const key = norm(url);
      if (!key)
          return;
      const facts = factsOf(scope);
      const prev = facts.failurePenalty.get(key) ?? 1;
      facts.failurePenalty.set(key, Math.min(FAILURE_PENALTY_MAX, prev * FAILURE_PENALTY_STEP));
  }
  function noteRouteProven(url, scope = '') {
      const key = norm(url);
      if (!key)
          return;
      const facts = factsByScope.get(scope);
      facts?.failurePenalty.delete(key);
      facts?.foreign.delete(key);
  }
  function noteRouteVerified(url, scope = '') {
      factsByScope.get(scope)?.foreign.delete(norm(url));
  }
  function noteRouteForeign(url, scope = '') {
      const key = norm(url);
      if (key)
          factsOf(scope).foreign.add(key);
  }
  function isRouteForeign(url, scope = '') {
      return factsByScope.get(scope)?.foreign.has(norm(url)) ?? false;
  }
  function routeLatencyOf(url, scope = '') {
      return factsByScope.get(scope)?.latency.get(norm(url)) ?? null;
  }
  function freshRouteLatencyOf(url, scope = '') {
      const facts = factsByScope.get(scope);
      const key = norm(url);
      return facts && isFresh(facts, key) ? facts.latency.get(key) ?? null : null;
  }
  function penaltyFor(facts, key) {
      return (facts.lossPenalty.get(key) ?? 1) * (facts.failurePenalty.get(key) ?? 1);
  }
  function routeCostOf(url, scope = '') {
      const facts = factsByScope.get(scope);
      const key = norm(url);
      const ms = facts?.latency.get(key);
      return facts && ms !== undefined ? ms * penaltyFor(facts, key) : null;
  }
  function forgetRouteFacts(scope = '') {
      factsByScope.delete(scope);
  }
  function median(values) {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  function settledCostOf(facts, key) {
      const window = facts.samples.get(key);
      const ms = window?.length ? median(window) : facts.latency.get(key);
      return ms === undefined ? undefined : ms * penaltyFor(facts, key);
  }
  function noiseCostOf(facts, key) {
      const sorted = [...(facts.samples.get(key) ?? [])].sort((a, b) => a - b);
      if (sorted.length < MIN_NOISE_SAMPLES)
          return 0;
      const stable = sorted.length >= 4 ? sorted.slice(1, -1) : sorted;
      return (stable[stable.length - 1] - stable[0]) / 2 * penaltyFor(facts, key);
  }
  function orderRouteCandidates(routes, currentUrl = '', suspended = [], scope = '') {
      const facts = factsOf(scope);
      const current = norm(currentUrl);
      const foreignFree = routes.filter((route) => !facts.foreign.has(norm(route.url)));
      const cooling = new Set((suspended || []).map(norm).filter(Boolean));
      const allCooling = foreignFree.length > 0 && foreignFree.every((route) => cooling.has(norm(route.url)));
      const cool = allCooling ? new Set() : cooling;
      const warm = foreignFree.filter((route) => !cool.has(norm(route.url)));
      const cold = foreignFree.filter((route) => cool.has(norm(route.url)));
      const known = warm.filter((route) => isFresh(facts, norm(route.url)))
          .sort((a, b) => settledCostOf(facts, norm(a.url)) - settledCostOf(facts, norm(b.url)));
      const unknown = warm.filter((route) => !isFresh(facts, norm(route.url)));
      const ordered = [...known, ...unknown, ...cold];
      const at = ordered.findIndex((route) => norm(route.url) === current);
      if (at <= 0 || cool.has(current))
          return ordered;
      const currentCost = settledCostOf(facts, current);
      if (currentCost === undefined)
          return ordered;
      const challenger = known.find((route) => norm(route.url) !== current
          && (facts.samples.get(norm(route.url))?.length ?? 0) >= MIN_NOISE_SAMPLES);
      const headUrl = challenger ? norm(challenger.url) : '';
      const headCost = challenger ? settledCostOf(facts, headUrl) : undefined;
      const gain = headCost !== undefined ? currentCost - headCost : 0;
      const noise = noiseCostOf(facts, current) + noiseCostOf(facts, headUrl);
      const clean = penaltyFor(facts, current) === 1 && penaltyFor(facts, headUrl) === 1;
      const required = Math.max(noise, currentCost * ROUTE_SWITCH_SHARE, clean ? SWITCH_GAIN_FLOOR_MS : 0);
      if (!isFresh(facts, current)) {
          if (challenger && gain > 0 && gain <= required) {
              const [item] = ordered.splice(at, 1);
              ordered.unshift(item);
          }
          return ordered;
      }
      const bouncingBack = facts.lastSwitch?.to === current && facts.lastSwitch.from === headUrl;
      const worthwhile = headCost !== undefined && gain > required;
      const settled = !bouncingBack || gain > required * 2;
      if (challenger && settled && worthwhile) {
          facts.lastSwitch = { from: current, to: headUrl, round: facts.evidenceRound };
          const headAt = ordered.indexOf(challenger);
          ordered.splice(headAt, 1);
          ordered.unshift(challenger);
          return ordered;
      }
      const [item] = ordered.splice(at, 1);
      ordered.unshift(item);
      return ordered;
  }

  return exports;
}
module.exports = { createRoutePolicy, ...createRoutePolicy() };

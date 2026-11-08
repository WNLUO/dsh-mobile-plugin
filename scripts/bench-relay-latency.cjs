'use strict';

/**
 * 多中转地址的延迟基准：给一组地址，逐个打 `/healthz`，按延迟升序打印。
 *
 * 用途是「换机器 / 就近择路」之前先看一眼现实：同一个网络里哪台中转真的快、哪台其实已经
 * 挂了（`ms` 为空的那几条）。它跟真实现用同一套判据 —— `/healthz` 回 2xx 且
 * `/api/mobile/v1/health` 报 `service: dsh-mobile-relay`，与
 * `lib/routes/control-plane.js` 的 `probe-relays` 一致；只看 `/healthz` 的话，随便一个
 * 静态站也会被算成「很快的中转」。
 *
 * 手动跑，不进任何守卫：
 *
 *   node scripts/bench-relay-latency.cjs https://a.example https://b.example
 *   RELAY_LATENCY_ROUNDS=10 node scripts/bench-relay-latency.cjs https://a.example
 *   node scripts/bench-relay-latency.cjs            # 不带参数：读 relay.json 里的那组地址
 *
 * 环境变量：RELAY_LATENCY_ROUNDS（每个地址打几轮，默认 5）、RELAY_LATENCY_TIMEOUT_MS
 * （单次超时，默认 4000）、RELAY_LATENCY_HOME（指定 DSH 数据目录，默认同插件）。
 */

// 数据目录要在 require 之前定：core 在模块求值时就锁定了 relay.json 的路径。
if (process.env.RELAY_LATENCY_HOME) process.env.DSH_HOME = process.env.RELAY_LATENCY_HOME;

const fs = require('node:fs');
const { STATE_FILE, loadState, normalizeRelayUrl } = require('../lib/relay/core.js');

const SERVICE = 'dsh-mobile-relay';
const ROUNDS = Math.max(1, Number(process.env.RELAY_LATENCY_ROUNDS) || 5);
const TIMEOUT_MS = Math.max(100, Number(process.env.RELAY_LATENCY_TIMEOUT_MS) || 4000);

/** 一次探测：`/healthz` 2xx 且 `/api/mobile/v1/health` 认自己是中转，才算通。 */
async function probeOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;
  try {
    const health = await fetch(`${url}/healthz`, { signal: controller.signal, redirect: 'follow' });
    await health.text().catch(() => '');
    if (!health.ok) return { ms: null, reason: `healthz ${health.status}` };
    const who = await fetch(`${url}/api/mobile/v1/health`, { signal: controller.signal, redirect: 'follow' })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
    if (!who || who.service !== SERVICE) return { ms: null, reason: '不是 dsh-mobile-relay' };
    return { ms: elapsed(), reason: '' };
  } catch (error) {
    return { ms: null, reason: error.name === 'AbortError' ? `超时 (>${TIMEOUT_MS}ms)` : String(error.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** 一个地址打 ROUNDS 轮：报中位数与最好那一发，失败的记下最后一次原因。 */
async function benchOne(url) {
  const samples = [];
  let reason = '';
  for (let round = 0; round < ROUNDS; round += 1) {
    const result = await probeOnce(url);
    if (result.ms === null) reason = result.reason;
    else samples.push(result.ms);
  }
  return {
    url,
    ok: samples.length > 0,
    successRate: samples.length / ROUNDS,
    medianMs: samples.length ? median(samples) : null,
    bestMs: samples.length ? Math.min(...samples) : null,
    reason,
  };
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  let urls = args.map(normalizeRelayUrl).filter(Boolean);
  if (!urls.length) {
    // 没有 relay.json 就不去碰它：`loadState` 在文件缺失时会顺手写一份默认状态。
    if (!fs.existsSync(STATE_FILE)) {
      console.error(`没有地址可测：命令行给几条，或先让插件写出 ${STATE_FILE}`);
      process.exitCode = 2;
      return;
    }
    const state = loadState();
    // 形状铺开之后 relayUrls 才是完整列表，老状态里只有 relayUrl 一条。
    const list = Array.isArray(state.relayUrls) && state.relayUrls.length ? state.relayUrls : [state.relayUrl];
    urls = list.map(normalizeRelayUrl).filter(Boolean);
    if (!urls.length) {
      console.error('没有地址可测：命令行给几条，或先把中转地址写进 relay.json');
      process.exitCode = 2;
      return;
    }
    console.log(`（未给参数，读 relay.json 里的 ${urls.length} 条）`);
  }
  urls = [...new Set(urls)];

  console.log(`每条 ${ROUNDS} 轮，单次超时 ${TIMEOUT_MS}ms，共 ${urls.length} 条\n`);
  const results = [];
  for (const url of urls) results.push(await benchOne(url));

  // 通了的按延迟升序排前面，挂掉的垫底（挂掉的之间没有快慢可比）。
  results.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    return (a.medianMs ?? Infinity) - (b.medianMs ?? Infinity);
  });

  const width = Math.max(...results.map((row) => row.url.length), 3);
  results.forEach((row, index) => {
    const rank = String(index + 1).padStart(2);
    const latency = row.ok
      ? `${row.medianMs.toFixed(1)}ms（最好 ${row.bestMs.toFixed(1)}ms，${Math.round(row.successRate * 100)}% 成功）`
      : `不可用：${row.reason}`;
    console.log(`${rank}. ${row.url.padEnd(width)}  ${latency}`);
  });

  const healthy = results.filter((row) => row.ok);
  console.log(`\n可用 ${healthy.length}/${results.length} 条${healthy.length ? `；最快：${healthy[0].url}（${healthy[0].medianMs.toFixed(1)}ms）` : ''}`);
  if (!healthy.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

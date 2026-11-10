'use strict';

/**
 * GET /api/mobile/v1/stats/overview?range=today|yesterday|3d|7d|30d|all[&fresh=1]（token）
 *
 * 统计页的唯一接口：先采一轮（水位差记账），再把账本按范围折算成页面要的那份。
 *
 * 采集失败**不**让整页报错：账本里已有的数字照样是真的，宁可让用户看到一份偏旧的统计，
 * 也不要为了「这次没采上」把整页变成错误页。要重新采就用 `fresh=1`（下拉刷新那条）。
 *
 * 范围词是 App 与这里共用的一份词汇表（`app/src/types/stats.ts` 的 `StatsRange`）：
 * 「今天 / 昨天」是单天窗口，`3d` / `7d` / `30d` 是含今天往前数的天窗，`all` 不设下限。
 * 日历口径只有 `stats-ledger.cjs` 的 `startDayOf` / `endDayOf` 一份，App 不自己算。
 * 认不出来的词一律按 `7d`（老 App 照旧发那三档）；**新范围词遇到老插件就会落到这一条**，
 * 所以 App 拿回包里的 `range` 与请求的对不对得上当作「插件较旧」的判据（见 A2-60）。
 */

const { sendJson } = require('../http/routing.js');
const { collectStats, DEFAULT_BUDGET_MS } = require('./stats-collect.cjs');
const ledger = require('./stats-ledger.cjs');

/** 六档范围词，顺序就是从短到长（与 App 那排标签一致）。 */
const RANGE_LIST = ['today', 'yesterday', '3d', '7d', '30d', 'all'];
const RANGES = new Set(RANGE_LIST);

function normalizeRange(value) {
  return typeof value === 'string' && RANGES.has(value) ? value : '7d';
}

/**
 * 一次请求把六档全折算回去。
 *
 * **采集只有一轮**：六档看的是同一本账，只是窗口不同；切标签再去采一遍纯属白采（采集本身
 * 才是这个接口里贵的那一步）。折算本身很便宜，账本没动时 `summarize` 还有缓存。
 *
 * 用户点进统计页发一发，六档就都在手上，之后切标签只是换视图，不再发请求。
 * `ranges` 是新增字段：老 App 只读 `overview`，多出来的这一项它不认识、也不受影响。
 */
async function handleStatsOverview(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const range = normalizeRange(url.searchParams.get('range'));
  const fresh = url.searchParams.get('fresh') === '1';
  try {
    // 带预算采：到点就用已经采到的那部分出数，别让手机等十几秒（见 stats-collect 的同名常量）。
    await collectStats(ctx, { force: fresh, budgetMs: DEFAULT_BUDGET_MS });
  } catch {
    /* 采集是旁路：账本还在，统计页照常出数 */
  }
  const book = ledger.readLedger();
  const now = Date.now();
  const overview = ledger.summarize(book, range, now);
  const ranges = {};
  for (const item of RANGE_LIST) {
    ranges[item] = item === range ? overview : ledger.summarize(book, item, now);
  }
  sendJson(res, 200, { ok: true, overview, ranges });
}

module.exports = { handleStatsOverview, normalizeRange, RANGE_LIST };

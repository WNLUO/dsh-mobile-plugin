'use strict';

/**
 * GET /api/mobile/v1/stats/overview?range=today|yesterday|3d|7d|30d|all[&fresh=1]（token）
 *
 * 统计页的唯一接口：**直接读账本、按范围折算**，采集不在这条路上等。
 *
 * 采集归宿主自己的定时那一轮（`stats-scheduler.cjs`，每 5 分钟、预算 25 秒）。请求路径曾经
 * 顺手采一轮（1.5 秒预算），两个毛病都是结构性的：① 一百多条会话一轮本来就采不完，每次
 * 打开拿到的都是半份，数字于是「隔几天自己变大」；② 采集是全局排队的，电脑那头自己那一轮
 * 25 秒还在跑时，手机这发要排在它后面，而手机总共只肯等几秒 —— 现场就是「先看到数字、
 * 一会儿变成『统计没取到』」。
 *
 * 所以这里只做「读 + 折」：账本是多少就给多少，快而且是完整的一份。`fresh=1`（下拉刷新 /
 * 重试）不改这条口径 —— 它只是**顺手叫醒一轮后台采集**，回包不等它，下一次刷新就能看到。
 * 采集失败不影响出数：账本里已有的数字照样是真的。
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
 * 上一发「叫醒采集」还没落地时不再叫第二次。
 *
 * 统计页打开、下拉刷新、切后台回来都各会发一发，没人去重的话同一时刻会排起好几轮；而
 * `collectStats` 内部本来就有 60 秒最小间隔，重复那几轮全是白等。
 */
let waking = null;

/**
 * 顺手叫醒一轮后台采集：**不等它**，回包已经发出去了。
 *
 * 用请求路径那档短预算（1.5 秒）：定位从「出数前必须先采到」变成「有机会就往前挪一点」，
 * 采多少算多少，剩下的由定时那一轮接着采。`fresh` 只是跳过 60 秒最小间隔（用户手点刷新要
 * 真读一次），回包照样不等它。
 *
 * **它会在回包之后才写盘**，所以守卫必须能等它落地再还原 `DSH_HOME`（`settleWake`）——
 * 否则异步写盘会落到真的 `~/.dsh/mobile-stats.json` 上（账本守卫的文件头记过同一次事故）。
 */
function wakeCollect(ctx, force) {
  if (waking) return waking;
  waking = Promise.resolve()
    .then(() => collectStats(ctx, { force, budgetMs: DEFAULT_BUDGET_MS }))
    .catch(() => undefined)
    .finally(() => { waking = null; });
  return waking;
}

/** 等那一发后台采集落地（守卫用；线上没有任何调用点）。 */
async function settleWake() {
  while (waking) await waking;
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
  const book = ledger.readLedger();
  const now = Date.now();
  const overview = ledger.summarize(book, range, now);
  const ranges = {};
  for (const item of RANGE_LIST) {
    ranges[item] = item === range ? overview : ledger.summarize(book, item, now);
  }
  sendJson(res, 200, { ok: true, overview, ranges });
  // 回包已出，再叫醒后台那一轮：攒着的增量往前挪一点，用户下次打开 / 刷新就看得见。
  wakeCollect(ctx, fresh);
}

module.exports = { handleStatsOverview, normalizeRange, RANGE_LIST, settleWake };

'use strict';

/**
 * 统计账本的宿主侧定时采集：每几分钟自己跑一轮。
 *
 * 以前采集只在「有人打开统计页 / 下拉刷新 / 点清理」时才发生，水位差于是把「上次观测到现在」
 * 的整段用量记在**观测到它的那一天**：连着几天没打开页面，那几天的量就整批压到最后一天，
 * 按天图上是几天空白加一根尖柱。这一轮挪到宿主身上之后，归属误差从「几天」变成「几分钟」，
 * 顺带把「会话在下次采集之前被删掉」那个丢数窗口一起收掉。
 *
 * 一轮只读真有变动的会话（采集器按摘要的 `updatedAt` 跳过一点没动的），空闲时连账本文件
 * 都不重写 —— 平时几乎不花钱，别因为「每几分钟一次」就以为它在扫盘。
 *
 * 定时器归这里，不归装配层（`test/assembly-layer.test.cjs` 钉着）。
 */

const { collectStats, DEFAULT_BUDGET_MS, PERIODIC_INTERVAL_MS } = require('./stats-collect.cjs');

/** 启动后第一轮等一会儿：宿主刚起来时各服务还在就位，不抢那几十毫秒。 */
const FIRST_RUN_DELAY_MS = 30_000;

/**
 * 开始定期采集，返回停表函数（`ctx.effect` 的清理那一半）。
 *
 * 两条定时器都 `unref()`：它们是旁路，不该把进程留住等它们跑完。
 */
function start(ctx) {
  const run = () => {
    void collectStats(ctx, { budgetMs: DEFAULT_BUDGET_MS }).catch(() => undefined);
  };
  const first = setTimeout(run, FIRST_RUN_DELAY_MS);
  const timer = setInterval(run, PERIODIC_INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

module.exports = { start, FIRST_RUN_DELAY_MS, PERIODIC_INTERVAL_MS };

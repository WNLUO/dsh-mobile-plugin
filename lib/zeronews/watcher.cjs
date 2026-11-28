// ZeroNews 线路观察器：插件自己读本机 API，把隧道地址作为第一条通用线路写进状态。
'use strict';

/**
 * 只读本机 ZeroNews 客户端的 endpoints，不建隧道、不碰账号、不问用户要任何东西。
 * 读到 active 的 HTTPS 隧道就写进独立字段 `zeroNewsUrl`，总控据此上报 `kind:'custom'`；
 * 客户端没装 / 没起 / 隧道撤了就把这一格清空，手机那边随之撤销这条线路。
 *
 * 写入用 notify:false（这不是远程控制配置，不该触发 sidecar 重配），写成功再请调用方
 * 把新清单推给总控。读取失败不改现有值——本机客户端偶尔重启，别把一条还能用的线路抖掉。
 */

const { readZeroNewsEndpoints } = require('./probe.cjs');

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * @param {object} options
 * @param {object} options.settings 配置仓（update(patch, { notify: false })）
 * @param {() => object} options.getState 当前状态取值器
 * @param {() => void} [options.onChange] 地址真的变了之后通知总控重推
 * @param {(result: object) => Promise<object>} [options.readEndpoints] 读取层注入（测试用）
 * @param {number} [options.intervalMs] 轮询间隔
 * @param {(msg: string) => void} [options.log]
 */
function createZeroNewsWatcher(options = {}) {
  const { settings, getState, onChange = () => {}, readEndpoints = readZeroNewsEndpoints,
    intervalMs = DEFAULT_INTERVAL_MS, log = () => {} } = options;
  let timer = null;
  let running = false;
  let stopped = false;
  let inFlight = null;

  async function refresh() {
    if (stopped || inFlight || getState().zeroNewsEnabled === false) return;
    inFlight = (async () => {
      const result = await readEndpoints();
      if (stopped || getState().zeroNewsEnabled === false) return;
      // 只有「本机 API 正常回应」才按清单更新；连不上/读失败时保留现有线路，别抖。
      if (!result || result.ok !== true) return;
      const url = Array.isArray(result.urls) && result.urls.length ? result.urls[0] : '';
      const current = typeof getState().zeroNewsUrl === 'string' ? getState().zeroNewsUrl : '';
      if (url === current) return;
      try {
        await settings.update({ zeroNewsUrl: url }, { notify: false });
        onChange();
      } catch (error) {
        log(`[zeronews] 线路地址写回失败：${error && error.message ? error.message : error}`);
      }
    })();
    try { await inFlight; } finally { inFlight = null; }
  }

  function schedule() {
    if (!running || stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void refresh().finally(schedule); }, intervalMs);
    timer.unref?.();
  }

  function start() {
    if (running) return;
    running = true;
    stopped = false;
    void refresh().finally(schedule);
  }

  function stop() {
    running = false;
    stopped = true;
    clearTimeout(timer);
    timer = null;
  }

  return { start, stop, refresh };
}

module.exports = { createZeroNewsWatcher, DEFAULT_INTERVAL_MS };

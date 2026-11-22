// ZeroNews 线路挂载：把本机隧道地址的观察器接到装配层，实现在 watcher.cjs。
'use strict';

/**
 * 单独一个 wiring 是因为 `lib/impl.js` 有代码行数上限（test/assembly-layer.test.cjs 钉着）：
 * 那儿只留一句 require、一句 mount，观察器的启停、定时与写回全在这里和 watcher.cjs。
 * 没有本机 ZeroNews 时这一块就是空转，不影响总控上报与主链路。
 */

const { createZeroNewsWatcher } = require('./watcher.cjs');

/** @param {{mount: Function, settings: object, getState: Function, control: object, warn: Function, ctx: object, name: string}} options */
function mountZeroNews(options) {
  const { mount, settings, getState, control, warn, ctx, name } = options;
  const watcher = createZeroNewsWatcher({
    settings,
    getState,
    onChange: () => { try { control.sync() } catch {} },
    log: warn,
  });
  mount('ZeroNews 线路', () => ctx.effect(() => {
    watcher.start();
    return () => watcher.stop();
  }, `${name}: zeronews route watcher`));
  return watcher;
}

module.exports = { mountZeroNews };

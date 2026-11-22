// ZeroNews 线路挂载：把运行器接进装配层，隧道地址写回独立字段，随 effect 启停。
'use strict';

/**
 * 单独一个 wiring 是因为 `lib/impl.js` 有代码行数上限（test/assembly-layer.test.cjs 钉着）：
 * 那儿只留一句 require、一句 mount，进程生命周期在 runner.cjs，二进制获取在 provision.cjs。
 *
 * 面板点「连接」→ runner 走 ensure→login→start→建隧道→读域名；这里把域名写进独立字段
 * `zeroNewsUrl`（总控按 kind:'custom' 上报），并随配置变化自动重连 / 卸载时停进程。
 */

const { createZeroNewsRunner } = require('./runner.cjs');
const { ensureZeroNews } = require('./provision.cjs');

/** @param {{mount:Function, settings:object, getState:Function, control:object, warn:Function, ctx:object, name:string, runnerFactory?:Function, ensure?:Function}} options */
function mountZeroNews(options) {
  const { mount, settings, getState, control, warn, ctx, name } = options;
  const makeRunner = typeof options.runnerFactory === 'function' ? options.runnerFactory : createZeroNewsRunner;
  const provision = typeof options.ensure === 'function' ? options.ensure : ensureZeroNews;
  const runner = makeRunner({ ensure: provision, portOf: () => Number(options.portOf && options.portOf()) || 0 });

  const start = async () => {
    const result = await runner.start();
    // 拿到域名就写回状态；settings.update 会经 watch → applyServices → control.sync() 报给总控。
    if (result && result.phase === 'connected' && result.url && getState().zeroNewsUrl !== result.url) {
      try { await settings.update({ zeroNewsUrl: result.url }); }
      catch (error) { warn('把 ZeroNews 地址写回状态失败：%s', error && error.message ? error.message : error); }
    }
    return runner.status();
  };
  const stop = async () => {
    const result = runner.stop();
    try { await settings.update({ zeroNewsUrl: '' }); } catch { /* 停的时候写不回也不阻断 */ }
    return result;
  };
  const status = () => runner.status();

  mount('ZeroNews 线路', () => ctx.effect(() => () => { runner.stop(); }, `${name}: zeronews runner`));
  return { start, stop, status };
}

module.exports = { mountZeroNews };

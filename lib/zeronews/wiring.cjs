// ZeroNews 线路挂载：把运行器接进装配层，隧道地址写回独立字段，随 effect 启停。
'use strict';

/**
 * 单独一个 wiring 是因为 `lib/impl.js` 有代码行数上限（test/assembly-layer.test.cjs 钉着）：
 * 那儿只留一句 require、一句 mount，进程生命周期在 runner.cjs，二进制获取在 provision.cjs。
 *
 * 面板点「连接」→ runner 走 ensure→login→start→建隧道→读域名；这里把域名写进独立字段
 * `zeroNewsUrl`（总控按 kind:'custom' 上报），并随配置变化自动重连 / 卸载时停进程。
 *
 * **稳定门面**：就地重载会重新 apply、新建一个 runner，但控制面路由只认第一次挂上去的那个
 * 对象引用。所以对外的 start/stop/status 一律转发到模块级 `current`（最新一次 mount 出来的
 * 那套 runner+写回），重载后路由调到的仍是最新实现。
 */

const { createZeroNewsRunner } = require('./runner.cjs');
const { ensureZeroNews } = require('./provision.cjs');

/** 最新一次 mount 出来的操作集。放 globalThis：就地重载会换掉整个模块作用域，只有全局变量
 *  能跨代存活，保证路由手里那份门面永远转发到最新一份实现。 */
const GLOBAL_KEY = '__dshZeroNewsCurrent';
const readCurrent = () => globalThis[GLOBAL_KEY] || null;
/** 只建一次的门面，路由长期持有；方法都转发到全局 current。 */
const facade = {
  start: () => (readCurrent() ? readCurrent().start() : Promise.resolve({ phase: 'off' })),
  stop: () => (readCurrent() ? readCurrent().stop() : Promise.resolve({ phase: 'off' })),
  status: () => (readCurrent() ? readCurrent().status() : { available: false, running: false, phase: 'off', url: '', error: '' }),
};

/** @param {{mount:Function, settings:object, getState:Function, control:object, warn:Function, ctx:object, name:string, portOf?:Function, runnerFactory?:Function, ensure?:Function}} options */
function mountZeroNews(options) {
  const { mount, settings, getState, control, warn, ctx, name } = options;
  const makeRunner = typeof options.runnerFactory === 'function' ? options.runnerFactory : createZeroNewsRunner;
  const provision = typeof options.ensure === 'function' ? options.ensure : ensureZeroNews;
  const runner = makeRunner({ ensure: provision, portOf: () => Number(options.portOf && options.portOf()) || 0 });

  const start = async () => {
    const result = await runner.start();
    // 拿到域名就写回状态；settings.update 会经 watch → applyServices → control.sync() 报给总控。
    if (result && result.phase === 'connected' && result.url && getState().zeroNewsUrl !== result.url) {
      try { await settings.update({ zeroNewsUrl: result.url, zeroNewsEnabled: true }); }
      catch (error) { warn('把 ZeroNews 地址写回状态失败：%s', error && error.message ? error.message : error); }
    }
    return runner.status();
  };
  const stop = async () => {
    const result = runner.stop();
    try { await settings.update({ zeroNewsUrl: '', zeroNewsEnabled: false }); } catch { /* 停的时候写不回也不阻断 */ }
    return result;
  };

  globalThis[GLOBAL_KEY] = { start, stop, status: () => runner.status() };

  mount('ZeroNews 线路', () => ctx.effect(() => () => { runner.stop(); }, `${name}: zeronews runner`));
  return facade;
}

module.exports = { mountZeroNews };

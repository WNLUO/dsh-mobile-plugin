'use strict';

/**
 * 通话总管的运行期：一头判「有没有活」，一头在它每次开口前把任务账递进去。
 *
 * 两件事其实是一件事：总管得先知道自己手上有什么，才可能先报活；而它每开一轮都是新的
 * 上下文，账本在盘上、模型看不见。所以这里做的是一个 `agent/pre-step` 钩子 —— 落在总管
 * 那条会话上，有活就把账追加进这一步的 messages，没活就什么都不加（闲聊不翻旧账）。
 *
 * 拆成三块：
 *   · `judgment.js` —— 判据本身（账上挂着事 / 某条对话在跑或在等人答），纯函数可单独跑；
 *   · `inject.js`   —— 递话的正文与钩子，来源标记、只认总管、一轮一次、失败一律吞；
 *   · 本文件        —— 挂载入口，装配层只调 `mountSupervisorRuntime(ctx)`。
 *
 * 装配层不在这里改（`impl.js` 由 Lead 统一接线），这里只交出可被 `ctx.effect` 包住的
 * 清理函数。
 */

const judgment = require('./judgment.js');
const inject = require('./inject.js');

/**
 * 把总管运行期挂上。
 *
 * @param {object} ctx 宿主上下文
 * @param {{deps?: object}} [options] 只给守卫用：把读数换成假的
 * @returns {Function} 清理函数（`ctx.effect` 要的那个形状）
 */
function mountSupervisorRuntime(ctx, options) {
  const deps = options && options.deps;
  if (!ctx || typeof ctx.on !== 'function') return () => {};
  let off = null;
  try {
    off = ctx.on('agent/pre-step', inject.createPreStepHook(ctx, deps));
  } catch {
    // 老宿主没有这个事件：只少这一层递话，别的照常。
    off = null;
  }
  return () => {
    if (typeof off === 'function') {
      try {
        off();
      } catch {
        // 清理失败不抛。
      }
    }
  };
}

module.exports = {
  mountSupervisorRuntime,
  ...judgment,
  ...inject,
};

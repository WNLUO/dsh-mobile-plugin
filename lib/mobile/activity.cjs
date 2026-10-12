'use strict'

/**
 * 「手机上最近来过没有」—— 一个时间戳，别的什么都没有。
 *
 * 移动端守卫每放行一个带有效 token 的请求就叫一次 `note()`（见 `../http/routing.js`
 * 的 `createGuarded`，**401 那条不算**），控制面把 `snapshot()` 补进本机状态给面板读：
 * 引导最后一页靠它把「等手机扫码」变成真结论，而不是一个永远转下去的圈。
 *
 * 为什么单独一个文件：装配层 `lib/impl.js` 有行数上限（`test/assembly-layer.test.cjs`
 * 钉着），而这份状态既不属于装配、也不属于路由表。放在模块作用域就够 —— 一个进程就是
 * 一个宿主，插件的代被换掉时这个数跟着重置，换代之后的第一部手机再来一次就会重新记上，
 * 正是我们要的语义。
 */

let lastMobileAt = 0

/** 记一次「手机来过」。守卫里调用；异常一律吞掉——记账坏了也只是面板少一个确认。 */
function note() {
  lastMobileAt = Date.now()
}

/** 面板读的快照。`0` = 从来没来过。 */
function snapshot() {
  return { lastMobileAt }
}

module.exports = { note, snapshot }

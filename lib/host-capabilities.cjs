'use strict'

/**
 * 「这一代运行时少挂了什么」的活体台账。
 *
 * 宿主启动时会把官方那几行（提问工具 / 交付文件工具 / 目录浏览后端 / 预设里的子代理列表）
 * 按**运行时**对齐一遍：解析不到同代的那份就维持原样、交给官方装载预检去禁用，或者整行
 * 从预设副本里拿掉。这条路以前只写一行 stderr —— 现象是宿主照样起来、手机照样连上，用户
 * 进了会话才发现「模型说没有这个工具」，而没有任何界面说过一句话。
 *
 * 所以这里把那份结论记下来，由 `/api/mobile/v1/status` 报给手机，App 才能明说
 * 「这几项现在不可用」，而不是让人自己去撞。
 *
 * **同一进程内的内存传递**：`host.js` 与 `lib/impl.js` 是同一个宿主进程里的两段
 * （后者由 loader 挂进来），所以一份模块级记录就够了，不需要落盘、也没有跨进程时序问题。
 * **不要改成写文件**：那会多出一份能和实际装载结果不一致的状态。
 *
 * 记录只增不减：一次启动最多对齐一次，重载代不该把「这一次启动少了什么」擦掉。
 */

let report = null

/**
 * 记下这一次启动的对齐结论。由 `host.js` 在 `boot()` 之前调用。
 *
 * @param {{ runtimeVersion: string, missing: Array<{ id: string, name: string, reason: string }> }} next
 */
function setCapabilityReport(next) {
  report = {
    runtimeVersion: typeof next?.runtimeVersion === 'string' ? next.runtimeVersion : null,
    missing: Array.isArray(next?.missing)
      ? next.missing
        .filter((item) => item && typeof item.id === 'string')
        .map((item) => ({
          id: item.id,
          name: typeof item.name === 'string' ? item.name : null,
          // 「没解析到同代的一份」与「这一代运行时里入口本身没了」是两件事：
          // 前者可能换一份就回来，后者只能等上游把入口放回来或者我们改预设。
          reason: item.reason === 'entry-removed' ? 'entry-removed' : 'no-compatible-generation',
        }))
      : [],
  }
  return report
}

/**
 * 取这一次启动的对齐结论。
 *
 * 没跑过 `host.js` 的对齐（桌面 profile 走的是官方 `dsh web`，不是我们这个无头宿主）时
 * 返回 `null` —— 「没检查过」和「检查过、什么都没少」是两件事，不能都回一个空数组。
 *
 * @returns {{ runtimeVersion: string | null, missing: Array<object> } | null}
 */
function readCapabilityReport() {
  return report
}

/** 只给测试用：清掉记录，模拟一次全新启动。 */
function resetCapabilityReportForTests() {
  report = null
}

module.exports = {
  setCapabilityReport,
  readCapabilityReport,
  resetCapabilityReportForTests,
}

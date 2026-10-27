'use strict';

/**
 * 「按新配置重建隧道失败」的台账：最近一次失败的错误、时间与当时要切过去的地址。
 *
 * 换地址失败若被吞掉，手机上看是「保存成功」然后永久离线，宿主日志里也一个字都没有 ——
 * 用户唯一的线索是「连不上了」，还得自己猜是不是地址填错了。台账只留最近一条，由
 * `/api/mobile/v1/relay/diagnostics` 原样报给手机（「运行状态」那一页读它）。
 *
 * 只留一条是刻意的：这里回答的是「刚才那次为什么没成」，不是故障统计（故障统计归
 * `host-guard` 的 faults）。成功一次记下 `okAt`（那一次 configure 被 worker 接下了），好让
 * 界面能说清「失败过，后来又好了」；隧道到底连上没有，看同一份诊断里的 `tunnel`。
 */

/** 台账里 message 的上限：与 faults 同一条口径，手机上只看一句话。 */
const MESSAGE_MAX = 300;

let lastFailure = null;
let lastOkAt = 0;

/** 记一次失败。`target` 是当时配置里那份要切过去的中转地址（没有就不带）。 */
function recordFailure(error, target) {
  const raw = error instanceof Error ? error.message : String(error);
  lastFailure = {
    at: Date.now(),
    // 只留第一行：facade 拼出来的错误后面可能跟着整段堆栈首行，手机上没用。
    message: String(raw || '').split('\n')[0].slice(0, MESSAGE_MAX),
    ...(target ? { target: String(target) } : {}),
  };
}

/** 记一次成功下发：失败记录不删（它确实发生过），只补上「之后又通了」的时间。 */
function recordSuccess() {
  lastOkAt = Date.now();
}

/** 只读投影：诊断接口原样回这一份。 */
function view() {
  return {
    lastFailure: lastFailure ? { ...lastFailure } : null,
    okAt: lastOkAt || null,
  };
}

/** 清空（只有测试用得到；生产里失败记录由下一次失败覆盖）。 */
function reset() {
  lastFailure = null;
  lastOkAt = 0;
}

module.exports = { recordFailure, recordSuccess, view, reset, MESSAGE_MAX };

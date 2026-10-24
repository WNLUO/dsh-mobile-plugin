'use strict';

/**
 * 入口窗口的取数参数（`GET /session/messages?thin=1`，只对不带 beforeSeq / afterSeq 的
 * 一次性入口窗口生效；往上翻页与增量补拉保持完整）。
 *
 * 宿主 paginate 认 `turnWindow`：给 `minMessages` / `minTurns` 两个下限，它往回跨过至少
 * 这么多条消息、这么多轮 turn/start 之后，停在**一轮的开头**。入口要的正是这个边界 ——
 * 按条数硬切会切在一轮中间，长回合（每步一条 assistant 消息）里用户自己那句话就被挤出
 * 窗口了，进对话看到的只剩这一轮的后半段。
 *
 * `maxMessages` 是宿主的硬上限，量的是**消息条数**（含过程步）。按轮取整时它必须大于
 * 「一轮最多能有多少步」，否则截断点仍落在一轮中间、边界又回到按条数切。
 *
 * 2000 不是随手取的上限：本机 1420 个真实回合量下来，最长一轮 576 条消息、超过 500 的
 * 有 3 个、超过 200 的有 18 个。它只是**上界**，宿主在跨过 `minTurns` 且遇到 turn/start
 * 时就会停，所以正常情况下读的仍是那几十条；只有碰上超长回合才会真往上读到 2000。
 */
const ENTRY_THIN_MAX_MESSAGES = 2000;
const ENTRY_THIN_MIN_TURNS = 6;

/** 把入口窗口的取数参数写进宿主请求体（就地修改并返回，调用方只关心副作用）。 */
function entryWindowPayload(payload, limit) {
  payload.maxMessages = ENTRY_THIN_MAX_MESSAGES;
  payload.turnWindow = {
    minMessages: Math.min(Math.max(limit, 1), ENTRY_THIN_MAX_MESSAGES),
    minTurns: ENTRY_THIN_MIN_TURNS,
  };
  return payload;
}

module.exports = { entryWindowPayload, ENTRY_THIN_MAX_MESSAGES, ENTRY_THIN_MIN_TURNS };

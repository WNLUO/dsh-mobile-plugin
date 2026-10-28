'use strict';

/**
 * 输出 token 用满之后替用户续一句「继续」。
 *
 * 宿主把 `finish=max-tokens` 折成 `turn/end(reason.kind='max-tokens')` 就收尾这一轮，
 * 客户端只会画一行固定提示（桌面 `message.maxTokens` 那两句，App 侧是 `misc.structural.maxTokens`）
 * ——要不要接着写是人的事。手机上这就等于每次长回答被截断，用户都得亲手打两个字；
 * 而在手机上打字正是最费劲的那种操作。所以这里在宿主侧替他发这一句。
 *
 * 三条边界，缺一条就是替用户乱说话：
 *
 *   - **只续手机发起的轮**：会话里最后一条 user 消息必须带移动端 rpcId 前缀
 *     （`mobile:`，与 `/session/send` 那条路同源，见 history-derive 的
 *     `clientMessageIdFromSource`）。电脑上开的轮一动不动 —— 桌面那边用户本来就在键盘前。
 *   - **一串最多续 {@link AUTO_CONTINUE_MAX_ROUNDS} 次**：真写满额度、或者思考死循环带出一段
 *     可见正文时都会报 max-tokens（循环守卫只有在「思考是唯一产出」时才报 REASONING_LOOP），
 *     无限续就是无限烧额度。续够次数就停手，把那一行提示留给用户。
 *   - **同一轮只续一次**：事件流重连会重放 `turn/end`，不认这一条就是连发好几条「继续」。
 *
 * 续写走的是 `sessions.prompt`（与 App 的 `/session/send` 同一条路），所以它会作为一条
 * 普通的 user 消息落进会话：用户看得见、能接着聊，也能据此判断「刚才那是它替我发的」。
 */

const { callSessions, mobilePromptRpcId } = require('./rpc.js');
const { unwrap } = require('./envelope.js');
const { clientMessageIdFromSource } = require('./history-derive.js');
const { autoContinueTurnsOf } = require('./session-cache.js');

/** 代发的那句话。短、明确、不夹带额外指令 —— 模型看见的就是用户会打的那两个字。 */
const AUTO_CONTINUE_TEXT = '继续';

/**
 * 一串里最多代发几次。
 *
 * 三次是「够写完一篇长答复」与「别在病态输出上无限烧额度」之间的折中：按 8192 输出上限
 * 算，四次加总三万多 token，正常长文到这已经写完了。
 */
const AUTO_CONTINUE_MAX_ROUNDS = 3;

/**
 * 代发消息的 clientMessageId 前缀。
 *
 * 它同时是**认回自己**的唯一凭据：这一串续了几次不另开计数器，而是回读会话里最后几条
 * user 消息数连续的那几条 —— 宿主重启、事件重放、用户中途插话，三种情况都不会数错。
 */
const AUTO_CONTINUE_CLIENT_PREFIX = 'auto-continue-';

/** 回读会话时取的消息条数：只要够看到「上一个人类发言」，不必读全量。 */
const HISTORY_MESSAGE_LIMIT = 40;

/** 这条 user 消息是不是我们自己代发的。 */
function isAutoContinueId(clientMessageId) {
  return typeof clientMessageId === 'string' && clientMessageId.startsWith(AUTO_CONTINUE_CLIENT_PREFIX);
}

/**
 * 数「这一轮是手机发起的吗」「这一串已经代发了几次」。
 *
 * 返回 `{ rounds }` 表示可以续（`rounds` 是已续次数）；`null` 表示这一轮不该续
 * —— 最后一条人类发言不是从手机来的，或者压根读不到会话。
 *
 * 只认**最后一条非代发的 user 消息**：它是这一轮的起点。中点插话（steer）也是 user 消息，
 * 它同样带移动端 rpcId，所以「手机上补一句」不会把宿主判成「这是电脑开的轮」。
 */
async function chainState(ctx, sessionId) {
  const response = await callSessions(ctx, 'history', { sessionId, maxMessages: HISTORY_MESSAGE_LIMIT });
  const result = unwrap(response);
  if (result.error) return null;
  const events = (result.value && Array.isArray(result.value.events)) ? result.value.events : [];

  let rounds = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const entry = events[index];
    const event = entry && entry.event ? entry.event : entry;
    if (!event || event.type !== 'user/message' || !event.data) continue;
    const clientMessageId = clientMessageIdFromSource(event.data.source, event.data);
    if (isAutoContinueId(clientMessageId)) {
      rounds += 1;
      continue;
    }
    // 收起循环：第一条不是我们代发的 user 消息就是这一轮的起点。
    if (clientMessageId === undefined) return null;
    return { rounds };
  }
  return null;
}

/**
 * 发那一句「继续」。
 *
 * `requestId` 必须走 `mobilePromptRpcId`：宿主要把它写进 user 消息的 `source.rpcId`，
 * 上面的 `chainState` 才能在下一轮认出「这条是我们发的」，App 也能把它当成本设备发的消息
 * 认领（否则手机上会同时出现一条乐观行和一条来历不明的消息）。
 */
function sendContinue(ctx, sessionId, turn, round) {
  const clientMessageId = `${AUTO_CONTINUE_CLIENT_PREFIX}${turn}-${round}`;
  const rpcId = mobilePromptRpcId(clientMessageId);
  return callSessions(ctx, 'prompt', {
    sessionId,
    requestId: rpcId,
    content: [{ type: 'text', text: AUTO_CONTINUE_TEXT }],
  }, rpcId);
}

/**
 * 吃一条宿主会话事件；是「手机发起的这一轮被输出上限截断了」就代发一句「继续」。
 *
 * 由镜像推送那条全局事件循环调用（`lib/mirror/pusher.cjs`，与 `observeCompletionEvent` 同一处）。
 * **绝不抛**：它是事件循环里的一步，抛出去会把镜像推送整条流带走；代发失败没有代价
 * ——那一行「已达到输出 token 上限」照旧在界面上，用户还能自己点。
 *
 * @returns {Promise<boolean>} 是否真的代发了一条（给守卫用）。
 */
async function observeAutoContinue(ctx, sessionId, event) {
  if (!sessionId || !event || event.type !== 'turn/end') return false;
  const data = event.data;
  if (!data || typeof data.turn !== 'number') return false;
  if (!data.reason || data.reason.kind !== 'max-tokens') return false;

  const turn = data.turn;
  const map = autoContinueTurnsOf(ctx);
  if (map.get(sessionId) === turn) return false; // 这一轮已经代发过（事件重放）
  // 先占位再 await：同一轮的 turn/end 可能在历史读完之前又到一条。
  map.set(sessionId, turn);
  try {
    const chain = await chainState(ctx, sessionId);
    if (!chain || chain.rounds >= AUTO_CONTINUE_MAX_ROUNDS) return false;
    await sendContinue(ctx, sessionId, turn, chain.rounds);
    return true;
  } catch {
    // 占位撤掉：这一发是网络 / 网关的瞬时失败，下一次同类事件还该再试一次。
    if (map.get(sessionId) === turn) map.delete(sessionId);
    return false;
  }
}

module.exports = {
  AUTO_CONTINUE_TEXT,
  AUTO_CONTINUE_MAX_ROUNDS,
  AUTO_CONTINUE_CLIENT_PREFIX,
  observeAutoContinue,
};

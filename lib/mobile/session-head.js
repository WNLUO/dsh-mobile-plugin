'use strict';

/**
 * 正文水位探针：`GET /api/mobile/v1/session/head?sessionId=…`。
 *
 * 回答一个问题 —— **这条会话的正文在宿主日志里到哪个水位了**。App 进对话前先问一句，跟本机
 * 缓存水位一比就知道要不要重新拉历史：几兆的正文换几十字节的答案。
 *
 * 这个答案的分量全在「一致」那一侧：答「一致」等于告诉手机「你手上那份就是最新，一条正文
 * 请求都别发」，答错了用户就停在一份缺尾巴的正文上。所以它必须来自**日志**，不能来自镜像
 * （2026-11-01 改的就是这一条）：镜像是插件按轮重建的一份副本，它落后于日志（同一会话实测
 * 差过 449 个 seq），而落后时给出的答案与「真的没有新内容」一模一样 —— 手机把本机那份当
 * 最新铺上屏，偏偏那一页上没有第二条路会把尾巴补回来（空闲会话的兜底轮询只同步运行态，
 * 后台那条给未打开会话补正文的路刻意跳过正开着的那条）。
 *
 * 代价照实说：每进一次对话，电脑这侧多读一小段日志尾巴（与列表给 20 个会话补「最后一条
 * 消息」预览是同一条走法、同一个小窗口），换来的是「没变就零正文请求」这条口径仍然成立 ——
 * 它比多传一份正文便宜几个数量级。
 *
 * 子代理没有水位：子会话正文刻意不进镜像，日志也要走 durable 地址才读得到，所以直接回
 * `{seq:0, known:false}`，让 App 照旧整份拉（见 A3-14 与 A3-03 的子代理那一节）。
 */

const { sendJson } = require('../shared/http-util');
const { envelopeValue } = require('./envelope.js');
const { callSessions } = require('./rpc.js');
const { deriveMessages } = require('./history-derive.js');

/**
 * 读日志尾巴时一次要多少事件。
 *
 * 只为认出「最后一条消息的 seq」：一轮里事件不密（turn/start、assistant/message、tool/call、
 * tool/result、step/end、usage 各一条），几十条足够把最后一条正文包进来。取 60 而不像列表
 * 预览那样取 10：预览要的是那一条文字，这里要的是水位，尾巴里一条消息都没折出来就只能答
 * 「不知道」，那样反而让手机白拉一整份历史。
 */
const HEAD_TAIL_EVENTS = 60;

/**
 * 现读一小段日志尾巴，算出**消息** seq（折叠出来的行里最大的那个）。
 *
 * 不能拿事件 seq：`turn/end` / `usage` 也会推高事件水位，拿它当答案会让手机每进一次对话都
 * 判「本机落后」而白拉一发。也不能把答案缓存一小会儿：要看的正是「刚跑完那一拍」。
 *
 * 读失败、尾巴里一条消息都没有时如实回 `known:false`（让 App 退回整份拉取）—— 宁可多拉一次，
 * 也不拿一个猜出来的水位当「本机就是最新」的依据。
 */
async function sessionMessageHead(ctx, sessionId) {
  let resp;
  try {
    resp = await callSessions(ctx, 'history', { sessionId, maxMessages: HEAD_TAIL_EVENTS });
  } catch {
    return { seq: 0, known: false };
  }
  const value = envelopeValue(resp);
  const events = value && Array.isArray(value.events) ? value.events : [];
  if (events.length === 0) return { seq: 0, known: false };
  let seq = 0;
  for (const item of deriveMessages(events, sessionId)) {
    const candidate = item && item.seq;
    if (Number.isSafeInteger(candidate) && candidate > seq) seq = candidate;
  }
  return seq > 0 ? { seq, known: true } : { seq: 0, known: false };
}

async function handleSessionHead(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 sessionId' } });
  const parentSessionId = url.searchParams.get('parentSessionId');
  if (parentSessionId !== null && parentSessionId !== '') {
    return sendJson(res, 200, { ok: true, seq: 0, known: false });
  }
  const head = await sessionMessageHead(ctx, sessionId);
  sendJson(res, 200, { ok: true, seq: head.seq, known: head.known });
}

module.exports = { HEAD_TAIL_EVENTS, sessionMessageHead, handleSessionHead };

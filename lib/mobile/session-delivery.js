'use strict';

/**
 * 「这一发到底进没进」：按 `clientMessageId` 回查会话正文。
 *
 * 为什么要有这一条：手机端有一条**离线发件箱**（见 App 侧 `services/outbox.ts`）——
 * 点发送时没网或者电脑够不着，那条消息先留在手机上、标成「等待网络」，等网回来自动重发。
 * 重发沿用同一个 `clientMessageId`，插件侧本来就会按它去重（`session-cache.js` 的
 * `promptOnceFor`）。但那份去重记录**只在进程内存里**：插件重启过、或者 App 在「宿主
 * 已经收下、还没等到回包」那一刻被杀掉，手机这边就分不清「重发会补上」还是「重发会重复」。
 *
 * 所以这里从**会话日志**里查：日志是持久的，重启也在。查到就是进过了，App 直接把发件箱
 * 那一条划掉；查不到才真的重发。这比让 App 发完再拉一整段历史对账便宜，也比「相信内存里
 * 那份去重表」稳。
 *
 * 只读、只听 token、只看最近这一窗：发件箱里的条目最多躺几天，`maxMessages` 取它够用的
 * 上限；更早的不查 —— 查不到就按「没进」走重发，而重发那一步仍有插件的去重兜着。
 *
 * 不解析附件：这里只认「有没有这条 user 消息」，标题、图片字节都不需要
 * （`deriveMessages` 之外的附件解析是这条端点唯一可能变贵的地方，刻意不走）。
 */

const { sendJson } = require('../shared/http-util');
const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');
const { deriveMessages } = require('./history-derive.js');

/** 一次回查读多少条事件：发件箱的条目只可能出现在最近这几天。 */
const DELIVERY_HISTORY_WINDOW = 200;
/** 两个参数的长度上限（与 `clientMessageId` 的生成形状同一个量级）。 */
const PARAM_MAX = 200;

/**
 * GET /api/mobile/v1/session/delivery?sessionId=…&clientMessageId=…（token）
 * → { ok, delivered, seq? }
 *
 * 宿主没有这条会话（被删 / 换了机器）时回 404：那是「查不到」，不是「没送到」——
 * App 据此把发件箱里那条标成失败，而不是永远重试。
 */
async function handleSessionDelivery(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const sessionId = (url.searchParams.get('sessionId') || '').trim();
  const clientMessageId = (url.searchParams.get('clientMessageId') || '').trim();
  if (!sessionId || !clientMessageId || sessionId.length > PARAM_MAX || clientMessageId.length > PARAM_MAX) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { sessionId, clientMessageId }' } });
  }
  const { value, error } = unwrap(await callSessions(ctx, 'history', { sessionId, maxMessages: DELIVERY_HISTORY_WINDOW }));
  if (error) {
    const missing = error.code === 'session-not-found';
    return sendJson(res, missing ? 404 : 502, {
      ok: false,
      error: {
        code: typeof error.code === 'string' ? error.code : 'host-call-failed',
        message: typeof error.message === 'string' && error.message ? error.message : '读取会话历史失败',
      },
    });
  }
  const events = (value && Array.isArray(value.events)) ? value.events : [];
  const messages = deriveMessages(events);
  const hit = messages.find((message) => message.clientMessageId === clientMessageId);
  sendJson(res, 200, {
    ok: true,
    delivered: Boolean(hit),
    ...(hit && typeof hit.seq === 'number' ? { seq: hit.seq } : {}),
  });
}

module.exports = { handleSessionDelivery, DELIVERY_HISTORY_WINDOW };

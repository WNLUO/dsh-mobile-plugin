'use strict';

/**
 * 「继续失败的回合」这一发请求的形状：识别、内容解析、把宿主拒绝翻成 App 能说人话的码。
 *
 * 为什么单独成文件：`session-send.js` 有 330 行的拆分上限（`test/module-split.test.cjs`），
 * 而这块判据只在「空输入的继续」这一条路上用，搬出来既守住上限、也好单独讲清代价。
 *
 * 协议：App 发 `content: []` 且 `clientMessageId` 带 `mobile-continue-` 前缀（或显式
 * `continuation: true`），宿主按 `content.length === 0` 把这一发的 `source.kind` 推成
 * `'retry'`，不产生可见的 user/message。普通空输入仍然要被挡掉。
 */

/** 这一发是不是「继续上一个失败的回合」。 */
function continuationOf(body) {
  return body.continuation === true
    || (typeof body.clientMessageId === 'string' && body.clientMessageId.startsWith('mobile-continue-'));
}

/**
 * 解析这一发的内容。
 *
 * @returns {{content: unknown[]}} 或 `{error: {code, message}}`（调用方直接 400）。
 */
function resolveSendContent(body, continuation) {
  if (Array.isArray(body.content)) return { content: body.content };
  if (typeof body.text === 'string' && body.text.trim()) return { content: [{ type: 'text', text: body.text }] };
  if (continuation) return { content: [] };
  return { error: { code: 'bad-request', message: '需要 content 数组或 text' } };
}

/**
 * 空输入的「继续」请求被宿主拒绝时，把它翻成 App 能说人话的错误码。
 *
 * 继续这条路要**新版宿主**才认：
 *  - 老宿主的 `session.prompt` 还会校验「非空文本或附件」，回 `gateway/bad-request`；
 *  - 新宿主但这一轮没有可继续的失败（正在跑 / 还有排队输入）回 `session/agent-busy`，
 *    details.reason = NO_CONTINUABLE_FAILURE_OR_PENDING_INPUT。
 * 两种情况 App 要的话不一样（一个该说「版本旧」，一个该说「现在没有可继续的」），所以分成
 * 两个码，而不是笼统的 bad-request。
 */
function continuationError(normalized) {
  const code = normalized && typeof normalized.code === 'string' ? normalized.code : '';
  const details = normalized && normalized.details && typeof normalized.details === 'object' ? normalized.details : null;
  const reason = details && typeof details.reason === 'string' ? details.reason : '';
  if (code === 'session/agent-busy' || reason === 'NO_CONTINUABLE_FAILURE_OR_PENDING_INPUT') {
    return { code: 'continuation-unavailable', message: 'this session has no failed turn to continue right now', ...(details ? { details } : {}) };
  }
  return { code: 'continuation-unsupported', message: 'this host does not support continuing a failed turn with empty input', ...(details ? { details } : {}) };
}

module.exports = { continuationOf, resolveSendContent, continuationError };

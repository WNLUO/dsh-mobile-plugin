'use strict';

/**
 * dsh-mobile 用户问题回答桥接。
 *
 * ask_user_question 通过 apiProxy events mux 以 question/requested 发出，
 * 原生 App 经本端点回传对应 rpcId 的严格回答载荷。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');

function validAnswer(answer) {
  if (!answer || typeof answer.id !== 'string' || !Array.isArray(answer.selected)) return false;
  if (!answer.selected.every((label) => typeof label === 'string')) return false;
  return answer.custom === undefined || typeof answer.custom === 'string';
}

async function handleQuestionRespond(ctx, req, res) {
  const body = await readJsonBody(req);
  if (!body || typeof body.rpcId !== 'string' || !body.rpcId || typeof body.sessionId !== 'string' || !body.sessionId) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { rpcId, sessionId, answer }' } });
  }
  const answers = body.answer && body.answer.answers;
  if (!Array.isArray(answers) || !answers.every(validAnswer)) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'answer.answers 格式无效' } });
  }

  const receipt = await ctx.apiProxy.respond({
    type: 'client-response',
    rpcId: body.rpcId,
    result: {
      ok: true,
      value: {
        sessionId: body.sessionId,
        answer: {
          answers: answers.map((answer) => ({
            id: answer.id,
            selected: answer.selected,
            ...(answer.custom === undefined ? {} : { custom: answer.custom }),
          })),
        },
      },
    },
  });
  if (!receipt || receipt.accepted !== true) {
    return sendJson(res, 409, { ok: false, error: { code: 'not-pending', message: '该问题已完成或不可回答' } });
  }
  sendJson(res, 200, { ok: true, accepted: true });
}

async function handleApprovalRespond(ctx, req, res) {
  const body = await readJsonBody(req);
  const outcomes = new Set(['allowed-once', 'rejected']);
  if (!body || typeof body.rpcId !== 'string' || !body.rpcId
    || typeof body.sessionId !== 'string' || !body.sessionId
    || typeof body.approvalId !== 'string' || !body.approvalId
    || !outcomes.has(body.outcome)) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { rpcId, sessionId, approvalId, outcome }' } });
  }
  const receipt = await ctx.apiProxy.respond({
    type: 'client-response',
    rpcId: body.rpcId,
    result: { ok: true, value: { sessionId: body.sessionId, approvalId: body.approvalId, outcome: body.outcome } },
  });
  if (!receipt || receipt.accepted !== true) {
    return sendJson(res, 409, { ok: false, error: { code: 'not-pending', message: '该审批已完成或不可回答' } });
  }
  sendJson(res, 200, { ok: true, accepted: true });
}

module.exports = { handleQuestionRespond, handleApprovalRespond };

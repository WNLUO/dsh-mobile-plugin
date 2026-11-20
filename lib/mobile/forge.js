// Forge 评审移动后端：固定 Session 绑定、head 校验和宿主 Remote 动作。
'use strict';

const { sendJson, readJsonBody } = require('../shared/http-util');
const { requestSignal } = require('../shared/fresh-request.js');
const { callPanel, readPanelState, capabilitiesOf, sendError } = require('./forge-worktree.js');
const { requiredId, requiredUrl, baseBody, commit, diffCommits, reviewRequest, reviewWrite, reviewers, queryString, text } = require('./forge-contract.js');

function bodyLimit() { return 512 * 1024; }

function sendValidation(res, result) {
  if (!result || !result.error) return false;
  sendJson(res, 400, { ok: false, error: result.error });
  return true;
}

async function readBody(req) {
  if (req.method === 'GET' || !req.method) {
    const params = new URL(req.url, 'http://x').searchParams;
    const body = Object.fromEntries(params.entries());
    if (body.fresh !== undefined) body.fresh = body.fresh === '1' || body.fresh === 'true';
    return body;
  }
  return (await readJsonBody(req, bodyLimit())) || {};
}

function sendValue(res, value, options = {}) {
  if (options.result) return sendJson(res, 200, { ok: true, result: value });
  if (value === undefined) return sendJson(res, 200, { ok: true, applied: true });
  if (value === null) return sendJson(res, 200, { ok: true, supported: false });
  if (Array.isArray(value)) return sendJson(res, 200, { ok: true, reviewers: value });
  sendJson(res, 200, { ok: true, ...value });
}

async function invokeWithBody(ctx, req, res, method, makeArgs) {
  const body = await readBody(req);
  let args;
  try { args = makeArgs(body); }
  catch (error) { sendError(res, error); return; }
  if (args && args.error) { sendJson(res, 400, { ok: false, error: args.error }); return; }
  try {
    const value = await callPanel(ctx, method, args.value, requestSignal(res));
    sendValue(res, value);
  } catch (error) { sendError(res, error); }
}

function stateEntry(state, url) {
  return Array.isArray(state?.changeRequests) ? state.changeRequests.find(item => item && item.url === url) : null;
}

function checkHead(state, url, expected) {
  const entry = stateEntry(state, url);
  if (!entry || !entry.ref) return Object.assign(new Error('变更请求没有绑定到此会话，或提供方未加载'), { code: 'forgePanel/not-bound' });
  const failure = entry.update && entry.update.failure;
  if (failure) return Object.assign(new Error(failure.message || '读取变更请求状态失败'), { code: failure.code });
  const actual = entry.snapshot?.headSha || entry.update?.snapshot?.headSha || null;
  if (!actual) return Object.assign(new Error('变更请求状态尚未读取，请刷新后再试'), { code: 'forgePanel/diff-failed' });
  if (actual !== expected) return Object.assign(new Error(`变更请求 head 已从 ${expected} 变为 ${actual}`), { code: 'forgePanel/stale-head' });
  return null;
}

async function panelRead(ctx, req, res, method, args, options = {}) {
  try {
    if (options.headSha) {
      const state = await readPanelState(ctx, args.sessionId, requestSignal(res), { url: args.url });
      const mismatch = checkHead(state, args.url, options.headSha);
      if (mismatch) throw mismatch;
    }
    const value = await callPanel(ctx, method, args, requestSignal(res));
    if (value === null && options.nullSupported) return sendValue(res, null);
    const expectedResultHead = options.resultHead || options.headSha;
    if (expectedResultHead && value && typeof value === 'object' && 'headSha' in value && value.headSha !== expectedResultHead) {
      throw Object.assign(new Error('变更请求 head 已变化，请刷新后重新读取'), { code: 'forgePanel/stale-head' });
    }
    sendValue(res, value, options);
  } catch (error) { sendError(res, error); }
}

async function handleForgeCapabilities(ctx, req, res) {
  sendJson(res, 200, { ok: true, ...capabilitiesOf(ctx) });
}

async function handleForgeState(ctx, req, res) {
  const session = requiredId(queryString(req, 'sessionId'));
  if (session.error) return sendJson(res, 400, { ok: false, error: session.error });
  try { sendValue(res, await readPanelState(ctx, session.value, requestSignal(res))); }
  catch (error) { sendError(res, error); }
}

async function handleForgeTrack(ctx, req, res) {
  return invokeWithBody(ctx, req, res, 'track', body => {
    const base = baseBody(body); if (base.error) return base;
    return { value: { sessionId: base.value.sessionId, url: base.value.url } };
  });
}

async function handleForgeDismiss(ctx, req, res) {
  return invokeWithBody(ctx, req, res, 'dismiss', body => {
    const base = baseBody(body); if (base.error) return base;
    return { value: { sessionId: base.value.sessionId, url: base.value.url } };
  });
}

async function handleForgeDiff(ctx, req, res) {
  const body = await readBody(req); const base = baseBody(body); if (sendValidation(res, base)) return;
  const head = commit(body.headSha); if (sendValidation(res, head)) return;
  const commits = diffCommits(body.commits ?? (body.from || body.to ? { from: body.from, to: body.to } : null)); if (sendValidation(res, commits)) return;
  return panelRead(ctx, req, res, 'changeRequestDiff', { ...base.value, commits: commits.value }, { headSha: head.value, resultHead: commits.value?.to || head.value });
}

async function handleForgeChecks(ctx, req, res) {
  const body = await readBody(req); const base = baseBody(body); if (sendValidation(res, base)) return;
  const head = commit(body.headSha); if (sendValidation(res, head)) return;
  return panelRead(ctx, req, res, 'changeRequestChecks', { ...base.value, headSha: head.value }, { headSha: head.value });
}

async function handleForgeCommits(ctx, req, res) {
  const body = await readBody(req); const base = baseBody(body); if (sendValidation(res, base)) return;
  const head = commit(body.headSha); if (sendValidation(res, head)) return;
  return panelRead(ctx, req, res, 'changeRequestCommits', base.value, { headSha: head.value, nullSupported: true });
}

async function handleForgeReview(ctx, req, res) {
  const body = await readBody(req); const base = baseBody(body); if (sendValidation(res, base)) return;
  const head = commit(body.headSha); if (sendValidation(res, head)) return;
  return panelRead(ctx, req, res, 'changeRequestReview', { ...base.value, headSha: head.value, fresh: body.fresh === true }, { headSha: head.value });
}

async function handleForgeViewed(ctx, req, res) {
  const body = await readBody(req); const base = baseBody(body); if (sendValidation(res, base)) return;
  const head = commit(body.headSha); if (sendValidation(res, head)) return;
  return panelRead(ctx, req, res, 'changeRequestViewed', { ...base.value, headSha: head.value }, { headSha: head.value, nullSupported: true });
}

async function handleForgeReviewers(ctx, req, res) {
  const session = requiredId(queryString(req, 'sessionId')); if (session.error) return sendJson(res, 400, { ok: false, error: session.error });
  const url = requiredUrl(queryString(req, 'url')); if (url.error) return sendJson(res, 400, { ok: false, error: url.error });
  const query = text(queryString(req, 'query'), 300);
  try { sendValue(res, await callPanel(ctx, 'reviewerCandidates', { sessionId: session.value, url: url.value, query }, requestSignal(res))); }
  catch (error) { sendError(res, error); }
}

async function handleForgeReviewWrite(ctx, req, res) {
  const body = await readBody(req); const parsed = reviewWrite(body); if (sendValidation(res, parsed)) return;
  return panelRead(ctx, req, res, 'changeRequestReviewWrite', parsed.value, { result: true, headSha: parsed.value.write.headSha });
}

async function handleForgeSubmitReview(ctx, req, res) {
  const body = await readBody(req); const parsed = reviewRequest(body); if (sendValidation(res, parsed)) return;
  return panelRead(ctx, req, res, 'submitReview', parsed.value, { result: true, headSha: parsed.value.request.headSha });
}

async function handleForgeViewedWrite(ctx, req, res) {
  const body = await readBody(req); const base = baseBody(body); if (sendValidation(res, base)) return;
  const request = body.request; if (!request || typeof request !== 'object' || Array.isArray(request)) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 viewed request' } });
  const head = commit(request.headSha); if (sendValidation(res, head)) return;
  const path = text(request.path, 2048); if (!path || typeof request.viewed !== 'boolean') return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'viewed request 不合法' } });
  return panelRead(ctx, req, res, 'setFileViewed', { ...base.value, request: { path, viewed: request.viewed, headSha: head.value } }, { headSha: head.value });
}

async function handleForgeRerunChecks(ctx, req, res) {
  const body = await readBody(req); const base = baseBody(body); if (sendValidation(res, base)) return;
  const head = commit(body.headSha); if (sendValidation(res, head)) return;
  return panelRead(ctx, req, res, 'rerunChecks', { ...base.value, request: { headSha: head.value } }, { headSha: head.value });
}

async function handleForgeRequestReviews(ctx, req, res) {
  const body = await readBody(req); const parsed = reviewers(body); if (sendValidation(res, parsed)) return;
  return panelRead(ctx, req, res, 'requestReviews', parsed.value);
}

async function handleForgeUpdateBranch(ctx, req, res) {
  const body = await readBody(req); const base = baseBody(body); if (sendValidation(res, base)) return;
  const head = commit(body.headSha); if (sendValidation(res, head)) return;
  if (body.method !== 'merge' && body.method !== 'rebase') return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'updateBranch method 不合法' } });
  return panelRead(ctx, req, res, 'updateBranch', { ...base.value, method: body.method, headSha: head.value }, { headSha: head.value });
}

async function handleForgeReady(ctx, req, res) {
  const body = await readBody(req); const base = baseBody(body); if (sendValidation(res, base)) return;
  return panelRead(ctx, req, res, 'markReady', base.value);
}

async function handleForgeMerge(ctx, req, res) {
  const body = await readBody(req); const base = baseBody(body); if (sendValidation(res, base)) return;
  const head = commit(body.headSha); if (sendValidation(res, head)) return;
  if (body.method !== 'merge' && body.method !== 'squash' && body.method !== 'rebase') return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'merge method 不合法' } });
  return panelRead(ctx, req, res, 'merge', { ...base.value, method: body.method, headSha: head.value }, { headSha: head.value });
}

module.exports = {
  handleForgeCapabilities, handleForgeState, handleForgeTrack, handleForgeDismiss,
  handleForgeDiff, handleForgeChecks, handleForgeCommits, handleForgeReview, handleForgeViewed,
  handleForgeReviewers, handleForgeReviewWrite, handleForgeSubmitReview, handleForgeViewedWrite,
  handleForgeRerunChecks, handleForgeRequestReviews, handleForgeUpdateBranch, handleForgeReady,
  handleForgeMerge,
};

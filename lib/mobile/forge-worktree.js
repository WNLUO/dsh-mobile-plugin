// 官方 Forge 面板与工作树生命周期；Session 权限、首消息等待和归档回收均由宿主拥有。
'use strict';

const { sendJson, readJsonBody } = require('../shared/http-util');
const { requestSignal } = require('../shared/fresh-request.js');
const { invoke, openStream } = require('./host-bridge/transport.js');
const { requiredId, text, queryString, errorResponse } = require('./forge-contract.js');

const STATE_DEADLINE_MS = 15000;
const WORKTREE_ACTIONS = Object.freeze({
  request: 'requestWorktree', cancel: 'cancelWorktree', stop: 'stopCreation',
  retry: 'retryWorktree', restore: 'restoreWorktree', continue: 'continueInProject',
});

function serviceOf(ctx, name) {
  try { return typeof ctx?.get === 'function' ? ctx.get(name) || null : null; } catch { return null; }
}

function capabilitiesOf(ctx) {
  const panel = serviceOf(ctx, 'forgePanel');
  const gateway = serviceOf(ctx, 'typertGateway');
  const available = !!panel && !!gateway && typeof gateway.invoke === 'function' && typeof gateway.stream === 'function';
  const worktrees = serviceOf(ctx, 'worktrees');
  const worktree = {
    available: available && !!worktrees,
    create: available && typeof panel?.requestWorktree === 'function' && typeof worktrees?.create === 'function',
    restore: available && typeof panel?.restoreWorktree === 'function' && typeof worktrees?.restore === 'function',
    archiveCleanup: available && typeof panel?.worktreeCleanup === 'function' && typeof worktrees?.cleanupOf === 'function',
    owner: available && worktrees ? 'host' : 'unavailable',
  };
  return { available, ...(available ? {} : { reason: '宿主没有挂载 Forge 面板服务' }), worktree };
}

function unavailable(message = '宿主没有挂载 Forge 面板服务') { return Object.assign(new Error(message), { code: 'host-unavailable' }); }

async function callPanel(ctx, method, args, signal) {
  if (!capabilitiesOf(ctx).available) throw unavailable();
  const result = await invoke(ctx, 'forgePanel', method, args, signal);
  if (result.error) throw Object.assign(new Error(result.error.message), result.error);
  return result.value;
}

async function readPanelState(ctx, sessionId, signal, options = {}) {
  if (!capabilitiesOf(ctx).available) throw unavailable();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(Object.assign(new Error('Forge 状态读取超时'), { code: 'forge-timeout' })), STATE_DEADLINE_MS);
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let latest = null;
  try {
    const stream = await openStream(ctx, 'forgePanel', 'follow', { sessionId }, controller.signal);
    for await (const state of stream) {
      if (!state || typeof state !== 'object' || !state.worktree) continue;
      latest = state;
      if (state.checkout?.state === 'pending') continue;
      if (options.url) {
        const entry = Array.isArray(state.changeRequests) ? state.changeRequests.find(item => item?.url === options.url) : null;
        if (!entry) throw Object.assign(new Error('变更请求没有绑定到此会话'), { code: 'forgePanel/not-bound' });
      }
      return state;
    }
    if (latest) return latest;
    throw controller.signal.reason || unavailable('宿主没有返回 Forge 面板状态');
  } finally {
    clearTimeout(timeout); controller.abort(); signal?.removeEventListener('abort', abort);
  }
}

async function requestForNew(ctx, sessionId, options = {}, signal) {
  if (options.keep === true) throw Object.assign(new Error('官方工作树没有逐棵保留策略；请在电脑上设置归档保留后再创建'), { code: 'worktree-keep-unsupported' });
  if (!capabilitiesOf(ctx).worktree.create) throw unavailable('宿主没有挂载官方工作树创建服务');
  const from = options.from == null ? null : text(options.from, 300);
  if (from === '') throw Object.assign(new Error('基准分支不能为空'), { code: 'bad-request' });
  await callPanel(ctx, 'requestWorktree', { sessionId, from }, signal);
  return { worktreeRequested: true, worktreeOwner: 'host' };
}

function sendError(res, error) {
  if (error?.code === 'bad-request' || error?.code === 'worktree-keep-unsupported') return sendJson(res, 400, { ok: false, error: { code: error.code, message: error.message } });
  const result = errorResponse(error); sendJson(res, result.status, { ok: false, error: result.error });
}
function sendValue(res, value) {
  if (value === undefined) return sendJson(res, 200, { ok: true, applied: true });
  if (value === null) return sendJson(res, 200, { ok: true, supported: false });
  sendJson(res, 200, { ok: true, ...value });
}

async function handleForgeCapabilities(ctx, _req, res) { sendJson(res, 200, { ok: true, ...capabilitiesOf(ctx) }); }
async function handleForgeState(ctx, req, res) {
  const session = requiredId(queryString(req, 'sessionId')); if (session.error) return sendJson(res, 400, { ok: false, error: session.error });
  try { sendValue(res, await readPanelState(ctx, session.value, requestSignal(res))); } catch (error) { sendError(res, error); }
}
async function handleWorktreeState(ctx, req, res) {
  const session = requiredId(queryString(req, 'sessionId')); if (session.error) return sendJson(res, 400, { ok: false, error: session.error });
  try { const state = await readPanelState(ctx, session.value, requestSignal(res)); sendJson(res, 200, { ok: true, worktree: state.worktree, capabilities: capabilitiesOf(ctx).worktree }); } catch (error) { sendError(res, error); }
}
async function handleWorktreeCleanup(ctx, req, res) {
  const session = requiredId(queryString(req, 'sessionId')); if (session.error) return sendJson(res, 400, { ok: false, error: session.error });
  const raw = queryString(req, 'revision'); const revision = raw === '' ? null : Number(raw);
  if (revision !== null && (!Number.isSafeInteger(revision) || revision < 0)) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'revision 必须是非负整数' } });
  try { sendJson(res, 200, { ok: true, cleanup: await callPanel(ctx, 'worktreeCleanup', { sessionId: session.value, revision }, requestSignal(res)) }); } catch (error) { sendError(res, error); }
}
async function applyWorktree(ctx, req, res, action) {
  const body = await readJsonBody(req, 16 * 1024) || {}; const session = requiredId(body.sessionId);
  if (session.error) return sendJson(res, 400, { ok: false, error: session.error });
  const args = { sessionId: session.value };
  if (action === 'request') { if (body.keep === true || body.keepWorktree === true) return sendError(res, { code: 'worktree-keep-unsupported', message: '官方工作树没有逐棵保留策略' }); args.from = body.from == null ? null : text(body.from, 300); if (args.from === '') return sendError(res, { code: 'bad-request', message: '基准分支不能为空' }); }
  try { await callPanel(ctx, WORKTREE_ACTIONS[action], args, requestSignal(res)); sendJson(res, 200, { ok: true, applied: true }); } catch (error) { sendError(res, error); }
}
async function handleWorktreeRequest(ctx, req, res) { return applyWorktree(ctx, req, res, 'request'); }
async function handleWorktreeCancel(ctx, req, res) { return applyWorktree(ctx, req, res, 'cancel'); }
async function handleWorktreeStop(ctx, req, res) { return applyWorktree(ctx, req, res, 'stop'); }
async function handleWorktreeRetry(ctx, req, res) { return applyWorktree(ctx, req, res, 'retry'); }
async function handleWorktreeRestore(ctx, req, res) { return applyWorktree(ctx, req, res, 'restore'); }
async function handleWorktreeContinue(ctx, req, res) { return applyWorktree(ctx, req, res, 'continue'); }
module.exports = { capabilitiesOf, callPanel, readPanelState, requestForNew, sendError, handleForgeCapabilities, handleForgeState, handleWorktreeState, handleWorktreeCleanup, handleWorktreeRequest, handleWorktreeCancel, handleWorktreeStop, handleWorktreeRetry, handleWorktreeRestore, handleWorktreeContinue };

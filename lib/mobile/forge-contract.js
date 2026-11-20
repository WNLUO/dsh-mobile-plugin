// Forge 移动 API 的固定参数与错误收敛；只允许宿主公开的 Session 绑定动作。
'use strict';

const COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const MAX_ID = 200;
const MAX_URL = 2048;
const MAX_TEXT = 64 * 1024;
const MAX_PATH = 2048;
const MAX_REVIEWERS = 50;
const MAX_REVIEWER_LOGIN = 300;

function text(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return '';
  const out = value.trim();
  return out && out.length <= max ? out : out.length > max ? out.slice(0, max) : '';
}

function requiredId(value, name = 'sessionId') {
  const out = text(value, MAX_ID);
  return out ? { value: out } : { error: { code: 'bad-request', message: `需要 ${name}` } };
}

function requiredUrl(value) {
  const out = text(value, MAX_URL);
  if (!out) return { error: { code: 'bad-request', message: '需要变更请求 URL' } };
  return { value: out };
}

function commit(value, name = 'headSha') {
  const out = text(value, 80);
  if (!COMMIT_RE.test(out)) return { error: { code: 'bad-request', message: `${name} 必须是完整提交对象名` } };
  return { value: out.toLowerCase() };
}

function queryString(req, key) {
  try { return new URL(req.url, 'http://x').searchParams.get(key) || ''; } catch { return ''; }
}

function baseBody(body) {
  const session = requiredId(body && body.sessionId);
  if (session.error) return session;
  const url = requiredUrl(body && body.url);
  if (url.error) return url;
  return { value: { sessionId: session.value, url: url.value } };
}

function diffCommits(body) {
  if (body == null || body === null) return { value: null };
  if (typeof body !== 'object' || Array.isArray(body)) return { error: { code: 'bad-request', message: 'commits 必须是 null 或 { from, to }' } };
  const from = commit(body.from, 'commits.from');
  const to = commit(body.to, 'commits.to');
  if (from.error) return from;
  if (to.error) return to;
  return { value: { from: from.value, to: to.value } };
}

function lineComment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: { code: 'bad-request', message: '评论格式不合法' } };
  const path = text(value.path, MAX_PATH);
  const side = value.side === 'L' || value.side === 'R' ? value.side : '';
  const startLine = value.startLine;
  const endLine = value.endLine;
  const body = typeof value.body === 'string' ? value.body : '';
  if (!path || !side || !Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(endLine) || endLine < startLine || !body.trim() || body.length > MAX_TEXT) {
    return { error: { code: 'bad-request', message: '行评论需要路径、L/R、正整数行号和正文' } };
  }
  return { value: { path, side, startLine, endLine, body } };
}

function reviewRequest(body) {
  const base = baseBody(body);
  if (base.error) return base;
  const request = body && body.request && typeof body.request === 'object' && !Array.isArray(body.request) ? body.request : null;
  if (!request) return { error: { code: 'bad-request', message: '需要 request' } };
  const head = commit(request.headSha);
  if (head.error) return head;
  const kind = request.kind;
  if (kind === 'comment') {
    const comment = lineComment(request.comment);
    if (comment.error) return comment;
    return { value: { ...base.value, request: { headSha: head.value, kind, comment: comment.value } } };
  }
  if (kind !== 'review') return { error: { code: 'bad-request', message: 'request.kind 只能是 comment 或 review' } };
  const event = request.event === 'comment' || request.event === 'approve' || request.event === 'request-changes' ? request.event : '';
  if (!event) return { error: { code: 'bad-request', message: 'review event 不合法' } };
  const reviewBody = typeof request.body === 'string' ? request.body : '';
  const comments = Array.isArray(request.comments) ? request.comments : [];
  if (comments.length > MAX_REVIEWERS) return { error: { code: 'bad-request', message: '评论数量过多' } };
  const normalized = [];
  for (const item of comments) {
    const comment = lineComment(item);
    if (comment.error) return comment;
    normalized.push(comment.value);
  }
  if (event === 'request-changes' && !reviewBody.trim() && normalized.length === 0) {
    return { error: { code: 'bad-request', message: '请求修改必须有正文或行评论' } };
  }
  return { value: { ...base.value, request: { headSha: head.value, kind, event, body: reviewBody, comments: normalized } } };
}

function reviewWrite(body) {
  const base = baseBody(body);
  if (base.error) return base;
  const raw = body.write;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: { code: 'bad-request', message: '需要 write' } };
  const head = commit(raw.headSha);
  if (head.error) return head;
  const kind = raw.kind;
  const value = { headSha: head.value, kind };
  if (kind === 'reply') {
    const thread = text(raw.thread, MAX_ID); const bodyText = typeof raw.body === 'string' ? raw.body : '';
    if (!thread || !bodyText.trim() || bodyText.length > MAX_TEXT || typeof raw.pending !== 'boolean') return { error: { code: 'bad-request', message: '回复格式不合法' } };
    value.thread = thread; value.body = bodyText; value.pending = raw.pending;
  } else if (kind === 'resolve') {
    const thread = text(raw.thread, MAX_ID);
    if (!thread || typeof raw.resolved !== 'boolean') return { error: { code: 'bad-request', message: '解决讨论格式不合法' } };
    value.thread = thread; value.resolved = raw.resolved;
  } else if (kind === 'edit-comment') {
    const comment = text(raw.comment, MAX_ID); const bodyText = typeof raw.body === 'string' ? raw.body : '';
    if (!comment || !bodyText.trim() || bodyText.length > MAX_TEXT) return { error: { code: 'bad-request', message: '编辑评论格式不合法' } };
    value.comment = comment; value.body = bodyText;
  } else if (kind === 'delete-comment') {
    const comment = text(raw.comment, MAX_ID); if (!comment) return { error: { code: 'bad-request', message: '需要评论 id' } }; value.comment = comment;
  } else if (kind === 'add-pending') {
    const comment = lineComment(raw.comment); if (comment.error) return comment; value.comment = comment.value;
  } else if (kind === 'submit-pending') {
    const review = text(raw.review, MAX_ID); const event = raw.event === 'comment' || raw.event === 'approve' || raw.event === 'request-changes' ? raw.event : '';
    const bodyText = typeof raw.body === 'string' ? raw.body : '';
    if (!review || !event || (event === 'request-changes' && !bodyText.trim())) return { error: { code: 'bad-request', message: '提交待审评审格式不合法' } };
    value.review = review; value.event = event; value.body = bodyText;
  } else if (kind === 'discard-pending') {
    const review = text(raw.review, MAX_ID); if (!review) return { error: { code: 'bad-request', message: '需要待审评审 id' } }; value.review = review;
  } else return { error: { code: 'bad-request', message: '不支持的 review write 类型' } };
  return { value: { ...base.value, write: value } };
}

function reviewers(body) {
  const base = baseBody(body); if (base.error) return base;
  if (!Array.isArray(body.reviewers) || body.reviewers.length === 0 || body.reviewers.length > MAX_REVIEWERS) return { error: { code: 'bad-request', message: '需要非空 reviewers' } };
  const list = [];
  for (const row of body.reviewers) {
    if (!row || (row.kind !== 'user' && row.kind !== 'bot' && row.kind !== 'team')) return { error: { code: 'bad-request', message: 'reviewer kind 不合法' } };
    const login = text(row.login, MAX_REVIEWER_LOGIN); if (!login) return { error: { code: 'bad-request', message: 'reviewer login 不能为空' } };
    list.push({ kind: row.kind, login });
  }
  return { value: { ...base.value, reviewers: list } };
}

function errorResponse(error) {
  const raw = error || {};
  const hostCode = typeof raw.code === 'string' ? raw.code : 'forge-failed';
  const message = typeof raw.message === 'string' && raw.message ? raw.message : String(raw);
  const map = {
    'bad-request': ['bad-request', 400],
    'forge-timeout': ['forge-timeout', 504],
    'unauthenticated': ['forge-unauthenticated', 401],
    'unsupported': ['forge-unsupported', 501],
    'too-large': ['forge-too-large', 413],
    'stale': ['forge-stale', 409],
    'unknown': ['forge-unknown', 409],
    'not-found': ['forge-not-found', 404],
    'unavailable': ['forge-unavailable', 503],
    'host-unavailable': ['forge-unavailable', 503],
    'forgePanel/not-bound': ['forge-not-bound', 404],
    'forgePanel/stale-head': ['forge-stale', 409],
    'forgePanel/action-unknown': ['forge-unknown', 409],
    'forgePanel/action-failed': ['forge-action-failed', 502],
    'forgePanel/diff-too-large': ['forge-too-large', 413],
    'forgePanel/diff-failed': ['forge-diff-failed', 502],
    'forgePanel/checks-failed': ['forge-checks-failed', 502],
    'forgePanel/review-unsupported': ['forge-review-unsupported', 501],
    'forgePanel/review-failed': ['forge-review-failed', 502],
    'forgePanel/viewed-failed': ['forge-viewed-failed', 502],
    'forgePanel/reviewers-failed': ['forge-reviewers-failed', 502],
    'forgePanel/worktrees-unavailable': ['worktree-unavailable', 503],
    'forgePanel/session-started': ['worktree-session-started', 409],
    'forgePanel/session-busy': ['worktree-session-busy', 409],
    'forgePanel/no-worktree': ['worktree-missing', 404],
    'forgePanel/not-waiting': ['worktree-not-waiting', 409],
    'forgePanel/restore-failed': ['worktree-restore-failed', 502],
  };
  const [code, status] = map[hostCode] || ['forge-failed', 502];
  return { status, error: { code, message, details: { hostCode } } };
}

module.exports = { MAX_ID, MAX_URL, COMMIT_RE, text, requiredId, requiredUrl, commit, queryString, baseBody, diffCommits, lineComment, reviewRequest, reviewWrite, reviewers, errorResponse };

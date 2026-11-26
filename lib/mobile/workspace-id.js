// 任务提醒按精确证据解析会话的工作区归属：显式 workspaceId、唯一会话归属、唯一路径。
'use strict';

function normalizePath(value) {
  return typeof value === 'string' ? value.trim().replace(/[\\/]+$/, '') : '';
}

function workspaceIdOfRows(rows, summary) {
  if (summary && typeof summary.workspaceId === 'string' && summary.workspaceId.trim()) return summary.workspaceId.trim();
  const sessionId = summary && typeof summary.sessionId === 'string' ? summary.sessionId : '';
  const cwd = normalizePath(summary && summary.cwd);
  const items = Array.isArray(rows) ? rows : [];
  const bySession = items.filter((row) => row && Array.isArray(row.sessionIds) && sessionId && row.sessionIds.includes(sessionId));
  if (bySession.length === 1) return typeof bySession[0].workspaceId === 'string' ? bySession[0].workspaceId.trim() : '';
  if (bySession.length > 1) return '';
  if (!cwd) return '';
  const byPath = items.filter((row) => normalizePath(row && (row.path || row.cwd)) === cwd);
  if (byPath.length === 1) return typeof byPath[0].workspaceId === 'string' ? byPath[0].workspaceId.trim() : '';
  return '';
}

async function workspaceRows(ctx, signal) {
  const registry = ctx && ctx.get && ctx.get('workspaceRegistry');
  if (registry && typeof registry.list === 'function') {
    try { return registry.list().map((row) => ({ workspaceId: row.id, path: row.path, sessionIds: [...(row.sessionIds || [])] })); } catch { return []; }
  }
  try {
    const { workspaceListViaFollow } = require('./host-bridge/shims.js');
    const result = await workspaceListViaFollow(ctx, signal);
    const value = result && result.value;
    return value && Array.isArray(value.items) ? value.items : [];
  } catch { return []; }
}

async function workspaceIdOf(ctx, summary, signal) {
  if (summary && typeof summary.workspaceId === 'string' && summary.workspaceId.trim()) return summary.workspaceId.trim();
  return workspaceIdOfRows(await workspaceRows(ctx, signal), summary);
}

module.exports = { normalizePath, workspaceIdOfRows, workspaceRows, workspaceIdOf };

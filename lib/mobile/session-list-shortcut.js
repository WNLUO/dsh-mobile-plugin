'use strict';

/**
 * `GET /sessions?rev=` 的条件刷新：上一次构建留下的「这份清单是谁」。
 *
 * 只服务短路判断，不拿它当数据源 —— `cache.value` 那条路仍然按原来的规则走。四样
 * 一起对：客户端手上的 revision、这台设备的完成态代号、清单变更信号、上次构建时刻。
 * 单拎出来是因为 sessions.js 只剩列表 handler 的骨架，这类「记东西 / 对东西」的纯
 * 逻辑摆在 handler 中间会让状态和流程混在一起。
 *
 * 5 分钟上限只是兜底：`listSignal.watching()` 为假时根本不走短路，正常路径上信号
 * 一涨就会被判失效，用不到这个上限。
 */

const { listSignal } = require('../shared/list-signal.js');

const LIST_SHORTCUT_MAX_AGE_MS = 5 * 60 * 1000;

/** 命中就回一份 `unchanged` 身体，否则 null（交回原路重建）。 */
function listShortcut(cache, rev, generation) {
  if (!rev || typeof cache.lastRevision !== 'string' || cache.lastRevision !== rev) return null;
  if (cache.lastGeneration !== generation) return null;
  if (cache.lastSignalRevision !== listSignal.snapshot().revision) return null;
  if (!(Date.now() - (cache.lastBuiltAt || 0) <= LIST_SHORTCUT_MAX_AGE_MS)) return null;
  return { ok: true, revision: rev, generatedAt: cache.lastGeneratedAt };
}

/** 构建成功之后记下这一份：revision、生成时刻、当时的信号与完成态代号。 */
function rememberListBuild(cache, body, generation) {
  if (!body || typeof body.revision !== 'string' || !body.revision) return;
  cache.lastRevision = body.revision;
  cache.lastGeneratedAt = body.generatedAt;
  cache.lastGeneration = generation;
  cache.lastSignalRevision = listSignal.snapshot().revision;
  cache.lastBuiltAt = Date.now();
}

module.exports = { listShortcut, rememberListBuild };

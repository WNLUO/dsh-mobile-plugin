'use strict';

/**
 * 总管手上那两本账的装配入口：任务账（`task-ledger.js`）与知识库（`knowledge-base.js`）。
 *
 * ## 为什么合成一处 mount
 *
 * 两本账回答的是同一个问题 —— 「这一通电话里，他还挂着什么、他定下过什么」。分开挂会各自
 * 去听 `session/event`，同一轮的事件被折两遍，判据也迟早分叉（一边按 `turn/end` 收尾、
 * 一边按别的什么）。所以监听只装一份，两条路从同一个事件分出去。
 *
 * ## 挂的是什么
 *
 *  · `ctx.on('session/event')` —— 按会话进度更新任务账（开工 / 报错 / 在等人 / 等人答完了），
 *    在一轮结束时把这一通攒的草稿整理成知识库条目；
 *  · 四条 HTTP handler —— 给 App 读账、手动记一笔、读知识库、按关键词检索；
 *  · 一份 `callMemory()` —— 总管开口前要的那几行，工具层直接拿去用。
 *
 * ## 边界
 *
 * 路由不在这里登记（`routes/mobile-api.js` 那张表才是唯一入口，`mobile-routes.test.cjs`
 * 拿 App 的路径常量反向核对它）。这里只把 handler 造出来，装配层接走。
 *
 * 所有监听里做的事都包在 try 里：账本是旁路，写坏了不能让用户那一轮发不出去。
 */

const { sendJson, readJsonBody } = require('../../shared/http-util');

const ledger = require('../task-ledger.js');
const knowledge = require('../knowledge-base.js');

/** 宿主的两种会话 id 写法（与 `approvals.js` 的 `sessionIdOf` 同一口径）。 */
function sessionIdOf(session) {
  if (!session || typeof session !== 'object') return '';
  if (typeof session.id === 'string' && session.id) return session.id;
  const header = session.header;
  return header && typeof header.id === 'string' ? header.id : '';
}

/** 会话标题：宿主写在 header.title，认不出就空着（标题只是给人看的提示）。 */
function sessionTitleOf(session) {
  const header = session && session.header;
  if (header && typeof header.title === 'string' && header.title.trim()) return header.title.trim();
  return '';
}

/** 这一轮的结局码（`turn/end` 的 `data.reason.kind`）。 */
function endKindOf(event) {
  const data = event && event.data;
  const reason = data && data.reason;
  return reason && typeof reason.kind === 'string' ? reason.kind : undefined;
}

/**
 * 一条会话事件的进度折算。返回要写进账本的补丁，没必要动就回 null。
 *
 * 只更新**已经在账上**的会话条目：会话一多，每条都自动记账这本账就变成会话清单了。
 */
function progressPatchOf(event) {
  if (!event || typeof event.type !== 'string') return null;
  if (event.type === 'turn/start') return { step: '正在跑' };
  if (event.type === 'turn/end') {
    const kind = endKindOf(event);
    if (kind === 'error') return { step: '这一轮报错了', status: 'open', waiting: null };
    if (kind === 'completed' || kind === undefined) return { step: '这一轮跑完了' };
    return { step: `这一轮没跑完（${kind}）` };
  }
  // 在等人：审批与提问两条桥都把事实折进 session/event，这里跟着标一格。
  if (event.type === 'approval/asked' || event.type === 'approval/requested') {
    return { status: 'waiting', waiting: 'approval', step: '在等你审批' };
  }
  if (event.type === 'question/requested') return { status: 'waiting', waiting: 'question', step: '在等你回答' };
  // 等人这件事有结果了：回到「在做」，别让它一直挂在等人那一档。
  if (event.type === 'approval/decided' || event.type === 'approval/resolved' || event.type === 'question/resolved') {
    return { status: 'open', waiting: null };
  }
  return null;
}

/**
 * 总管开口前要的那几行：任务账在前，知识库检索在后。
 *
 * @param {{query?: string, limit?: number}} [options] 想起来的线索（用户刚说的那句话）
 * @returns {string} 没有可说的就回空串（调用方据此什么都不念）
 */
function callMemory(options) {
  const source = options && typeof options === 'object' ? options : {};
  const parts = [];
  const brief = ledger.briefText();
  if (brief) parts.push(`【任务账】\n${brief}`);
  const query = typeof source.query === 'string' ? source.query.trim() : '';
  if (query) {
    let recalled = [];
    try {
      recalled = knowledge.search(query, { limit: source.limit });
    } catch {
      recalled = [];
    }
    if (recalled.length > 0) {
      parts.push(`【知识库】\n${recalled.map((entry, index) => `${index + 1}. ${entry.text}`).join('\n')}`);
    }
  }
  return parts.join('\n\n');
}

// ── 路由 handler ─────────────────────────────────────────────────────────────

function fail(res, status, code, message) {
  return sendJson(res, status, { ok: false, error: { code, message } });
}

/** 一条任务账对外的形状：内部字段原样给，App 那边按它画。 */
function taskView(item) {
  return {
    id: item.id,
    title: item.title,
    step: item.step,
    status: item.status,
    waiting: item.waiting || null,
    note: item.note,
    sessionId: item.sessionId,
    sessionTitle: item.sessionTitle,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    doneAt: item.doneAt,
  };
}

/**
 * `GET /api/mobile/v1/supervisor/tasks` —— 全部任务账 + 各档条数 + 给总管念的那几行。
 *
 * 「全部」而不是「挂着的」：做完的事手机上也要看得到（它们永不删，只是不占电话里的时间）。
 */
async function handleTaskList(_ctx, _req, res) {
  const book = ledger.readLedger();
  const items = book.items
    .slice()
    .sort((a, b) => {
      if (a.status === 'done' !== (b.status === 'done')) return a.status === 'done' ? 1 : -1;
      return b.updatedAt - a.updatedAt;
    })
    .map(taskView);
  sendJson(res, 200, {
    ok: true,
    items,
    counts: ledger.counts(),
    brief: ledger.briefLines(),
    updatedAt: book.updatedAt,
  });
}

/**
 * `POST /api/mobile/v1/supervisor/tasks` —— 记一笔 / 改一笔。
 *
 * 给什么改什么：带 `id` 改那一条；带 `sessionId` 且账上有这条会话就改它；都不带就新建
 * （新建时 `title` 必须有）。`status: 'done'` 就是「这件事完了」，没有删除这条路。
 */
async function handleTaskWrite(_ctx, req, res) {
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') return fail(res, 400, 'bad-request', '参数不对。');
  let result;
  try {
    result = ledger.upsertTask(body);
  } catch {
    return fail(res, 500, 'ledger-write-failed', '账没记上，待会儿再试一次。');
  }
  if (!result) return fail(res, 400, 'title-required', '新建一件事得有个名字。');
  sendJson(res, 200, { ok: true, created: result.created, item: taskView(result.item) });
}

/** `GET /api/mobile/v1/supervisor/knowledge[?q=&limit=]` —— 不传 `q` 列全部，传了就按关键词检索。 */
async function handleKnowledgeList(_ctx, req, res) {
  const url = new URL(req.url || '/', 'http://x');
  const query = url.searchParams.get('q') || '';
  const rawLimit = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.trunc(rawLimit) : undefined;
  if (query.trim()) {
    const items = knowledge.search(query, { limit });
    return sendJson(res, 200, { ok: true, query, items });
  }
  const items = knowledge.listEntries();
  sendJson(res, 200, { ok: true, items: limit ? items.slice(0, limit) : items });
}

/**
 * `POST /api/mobile/v1/supervisor/knowledge` —— 追加一条。
 *
 * 模型侧**只有追加**：没有改、没有删，写错只能在 App 里由人删。人删走 DELETE（见下）。
 */
async function handleKnowledgeAppend(_ctx, req, res) {
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') return fail(res, 400, 'bad-request', '参数不对。');
  let entry;
  try {
    entry = knowledge.appendEntry(body);
  } catch {
    return fail(res, 500, 'knowledge-write-failed', '这条没记上，待会儿再试一次。');
  }
  if (!entry) return fail(res, 400, 'text-required', '一条知识得有点内容。');
  sendJson(res, 200, { ok: true, entry });
}

/** `DELETE /api/mobile/v1/supervisor/knowledge?id=` —— 人在界面上删掉一条记错的。 */
async function handleKnowledgeRemove(_ctx, req, res) {
  const url = new URL(req.url || '/', 'http://x');
  const id = url.searchParams.get('id') || '';
  let ok;
  try {
    ok = knowledge.removeEntry(id);
  } catch {
    return fail(res, 500, 'knowledge-delete-failed', '这条没删掉，待会儿再试一次。');
  }
  if (!ok) return fail(res, 404, 'not-found', '没有这一条。');
  sendJson(res, 200, { ok: true, id });
}

// ── 装配 ────────────────────────────────────────────────────────────────────

/**
 * 一条路径处理 GET / POST：宿主的注册器**不按方法分派**（与 `/relay/config`、
 * `/narration` 同一条路），所以两条必须合成一个 handler，靠 `req.method` 分开。
 */
async function handleTaskRoute(ctx, req, res) {
  if (req && req.method === 'POST') return handleTaskWrite(ctx, req, res);
  return handleTaskList(ctx, req, res);
}

async function handleKnowledgeRoute(ctx, req, res) {
  if (req && req.method === 'POST') return handleKnowledgeAppend(ctx, req, res);
  if (req && req.method === 'DELETE') return handleKnowledgeRemove(ctx, req, res);
  return handleKnowledgeList(ctx, req, res);
}

/**
 * 挂上这两本账。返回路由表要用的 handler 与给工具层的读口。
 *
 * `ctx.on` 只在有 ctx 时装：守卫与纯函数测试直接调 handler 时不碰宿主。返回的 `dispose`
 * 与 `ctx.effect` 同一套形状，装配层用 `ctx.effect(() => mount(...).dispose)` 包一层也行。
 */
function mount(ctx) {
  const disposers = [];

  if (ctx && typeof ctx.on === 'function') {
    try {
      disposers.push(ctx.on('session/event', (session, event) => {
        try {
          const sessionId = sessionIdOf(session);
          if (!sessionId || !event || typeof event !== 'object') return;
          const patch = progressPatchOf(event);
          if (patch) {
            ledger.updateFromSession(sessionId, { ...patch, sessionTitle: sessionTitleOf(session) });
          }
          // 一轮结束就是「这一通说到这儿」：把攒着的草稿整理一遍再写进知识库。
          if (event.type === 'turn/end') {
            knowledge.sweepDrafts();
            knowledge.flushCall(sessionId);
          }
        } catch {
          // 账本是旁路，任何一次折算失败都不该影响这一轮本身。
        }
      }, { global: true }));
    } catch {
      // 宿主不认这个事件（老版本）时只少一份自动更新，两本账本身照常能用。
    }
  }

  const dispose = () => {
    for (const off of disposers.splice(0)) {
      try {
        off();
      } catch {
        // 清理失败不抛。
      }
    }
  };

  return {
    handlers: {
      handleTasks: handleTaskRoute,
      handleKnowledge: handleKnowledgeRoute,
      handleTaskList,
      handleTaskWrite,
      handleKnowledgeList,
      handleKnowledgeAppend,
    },
    callMemory,
    progressPatchOf,
    ledger,
    knowledge,
    dispose,
  };
}

module.exports = {
  mount,
  callMemory,
  progressPatchOf,
  sessionIdOf,
  handleTaskRoute,
  handleKnowledgeRoute,
  handleTaskList,
  handleTaskWrite,
  handleKnowledgeList,
  handleKnowledgeAppend,
};

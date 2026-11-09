'use strict';

/**
 * `POST /session/new`：新建空白会话，以及 `isolate: true` 那条隔离工作目录的路。
 *
 * 为什么单列一个文件：`sessions.js` 有 500 行的拆分上限（见 `test/module-split.test.cjs`），
 * 而新建会话这一段是它身上唯一还在长的部分 —— 隔离那条路要开工作树、要回滚、要登记，
 * 再往列表 handler 里塞就把那个文件顶爆了。`sessions.js` 继续转出 `handleNew`，所以
 * 路由表与测试的 import 路径一行都不用改。
 *
 * ## 隔离是一条**事务**（2026-11-10 修）
 *
 * 建树与建会话此前是两件互不相干的事：树建好了、`session.create` 随即失败，那棵树就成了
 * 孤儿 —— 没有会话指向它，也没有任何登记说它存在，只有手工 `git worktree prune` 能收。
 * 现在两条路都堵上：失败时立刻回收刚建的那棵；同一个 requestId 重投时复用已经建好的那棵
 * （幂等窗口对 5xx 会删记录，重投会真的再进来一遍）。
 *
 * ## 能力面
 *
 * `isolate: true` 是唯一一条不走「cwd 必须在已登记工作区里」的路，但它**不是**放开任意
 * 路径：App 只发一个布尔，目录由插件在项目仓库里自己开一棵 git worktree。所以能力面仍然
 * 停在「已登记工作区」这一层。
 */

const path = require('node:path');

const { sendJson, readJsonBody } = require('../shared/http-util');
const { workspaceRoots, isWithin } = require('./allowed-zone.js');
const { withIdempotency, requestIdOf } = require('./idempotency.js');
const { canonicalDeviceKey, invalidateSessionList } = require('./session-cache.js');
const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');
const {
  createIsolationWorktreeForNew, releaseIsolationWorktree, bindSession,
} = require('./worktree-isolation.js');

/**
 * 会话没建成时收掉这一次刚开的树：目录、git 里的登记，以及那条还没干过活的分支。
 *
 * 分支上有提交就留着（那是用户在树里干完的活），判断在 `releaseIsolationWorktree` 里。
 * 清理失败不抛 —— 原始失败才是要报给用户的那一个。
 */
async function discardIsolated(isolated) {
  if (!isolated) return;
  await releaseIsolationWorktree({
    repoRoot: isolated.repoRoot,
    cwd: isolated.cwd,
    branch: isolated.branch,
    baseSha: isolated.baseSha,
  });
}

/**
 * POST /api/mobile/v1/session/new（token）{ workspaceId? | cwd? | isolate? | keepWorktree? }
 * → { ok, sessionId, cwd }
 *
 * 优先 workspaceId：宿主把新会话 attach 到该项目（workspace）的 sessionIds 账上，桌面端
 * 侧栏项目下立即可见；无 workspaceId 时回退 cwd（不传则归属其默认/未分组工作区）。
 * `isolate: true` 时改由插件在项目仓库里开一棵 git worktree 并把会话 cwd 指过去；
 * `keepWorktree: true` 表示这棵树建好后**不自动回收**（默认在会话结束后清掉）。
 * 走宿主 apiProxy 的 session.create（接受 workspaceId 或 cwd，二者不能同时给）。
 *
 * cwd 进来之前必须落在**宿主已登记的工作区**里：会话的 cwd 就是 allowed-zone 的第二个
 * 根（见 allowed-zone.js 的 allowedRoots），随手塞一个 `/` 进来等于把整台机器变成
 * 「允许读写区」。工作区清单读不到时照实回 502，不按「没有工作区」处理 —— 那会让每个
 * 目录都变成 403，用户看到的是「我的目录突然不能用了」。
 */
async function handleNew(ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const workspaceId = body && typeof body.workspaceId === 'string' && body.workspaceId.trim()
    ? body.workspaceId.trim()
    : '';
  const isolate = !!(body && body.isolate === true);
  const keepWorktree = !!(body && body.keepWorktree === true);
  // 隔离那条路要一个可解析的项目落点：优先 workspaceId，其次调用方给的 cwd。
  let projectCwd = '';
  // 只有走 cwd 那条路才需要校验：workspaceId 本身就把范围交给了宿主登记过的那一项。
  let cwd = '';
  if (!workspaceId && body && typeof body.cwd === 'string' && body.cwd.trim()) {
    const declared = body.cwd.trim();
    if (!path.isAbsolute(declared)) {
      return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'cwd 必须是绝对路径' } });
    }
    cwd = path.resolve(declared);
    let roots;
    try {
      roots = await workspaceRoots(ctx);
    } catch (error) {
      return sendJson(res, 502, {
        ok: false,
        error: {
          code: (error && error.code) || 'workspace-list-failed',
          message: String((error && error.message) || error),
        },
      });
    }
    if (!roots.some((root) => isWithin(root, cwd))) {
      return sendJson(res, 403, {
        ok: false,
        error: { code: 'outside-allowed', message: '这个目录不在能建会话的范围里（只能落在已登记的工作区）' },
      });
    }
  }
  if (isolate) {
    projectCwd = cwd;
    if (!workspaceId && !projectCwd) {
      return sendJson(res, 400, {
        ok: false,
        error: { code: 'bad-request', message: '开隔离工作目录需要指定一个项目' },
      });
    }
  }
  // 新建会话是**非幂等**写：同一发请求被重投一次就会凭空多一个会话。requestId 由
  // App 在构造请求头时生成一次，内核换通道重投复用同一个 init（同一个头），重投于是
  // 命中这里、直接拿回第一次的 sessionId（见 mobile/idempotency.js）。
  const requestId = requestIdOf(req, body);
  const outcome = await withIdempotency(ctx, canonicalDeviceKey(req), requestId, async () => {
    let payload = {};
    // 这一次请求建的那棵树：create 失败时按它回滚。
    let isolated = null;
    if (isolate) {
      // 建树失败就整次失败：不退回「就在原目录建会话」，否则用户以为已经隔离了、实际还在
      // 跟别人抢同一批文件。
      try {
        isolated = await createIsolationWorktreeForNew(ctx, {
          workspaceId: workspaceId || undefined,
          cwd: projectCwd || undefined,
          label: workspaceId || projectCwd,
          // 同一个 requestId 重投时复用它建过的那棵，而不是再开一棵。
          reuseKey: requestId || undefined,
          keep: keepWorktree,
        });
      } catch (error) {
        return {
          status: error && error.code === 'not-a-git-repo' ? 400 : 502,
          body: {
            ok: false,
            error: {
              code: (error && error.code) || 'worktree-failed',
              message: String((error && error.message) || error),
            },
          },
        };
      }
      payload.cwd = isolated.cwd;
    } else if (workspaceId) {
      payload.workspaceId = workspaceId;
    } else if (cwd) {
      payload.cwd = cwd;
    }
    // 宿主 session.create 接受 agentPreset：新建时直接定档，省掉「先建再 select」的
    // 两步（select 只在会话还没开跑时生效，新建后立刻 select 同样可行但多一次 RPC）。
    if (body && typeof body.agentPreset === 'string' && body.agentPreset.trim()) {
      payload.agentPreset = body.agentPreset.trim();
    }
    let create;
    try {
      create = unwrap(await callSessions(ctx, 'create', payload));
    } catch (error) {
      // 宿主那层直接抛了（网关不可用之类）：这棵树同样没人要了，收掉再说失败。
      await discardIsolated(isolated);
      throw error;
    }
    const { value, error } = create;
    if (error) {
      // 树已经建好、会话没建成：**回滚那棵树**。留着就是一具没人认领的孤儿，
      // 会话列表里不会出现、登记表里也没人会来收。
      await discardIsolated(isolated);
      return { status: 400, body: { ok: false, error } };
    }
    const sessionId = value && typeof value.sessionId === 'string' ? value.sessionId : null;
    if (!sessionId) {
      await discardIsolated(isolated);
      return { status: 500, body: { ok: false, error: { code: 'internal', message: '新建会话未返回 sessionId' } } };
    }
    // 树归这条会话了：登记表把「建树时那个请求键」改挂到会话号上，之后会话结束
    // （归档 / 删除）时 `worktree-lifecycle.js` 才能按会话号找到它并收掉。
    // 分支名与基线一起带过去 —— 回收时靠它判断分支上有没有用户留下的提交。
    if (isolated) {
      bindSession(sessionId, {
        cwd: isolated.cwd,
        repoRoot: isolated.repoRoot,
        reuseKey: requestId || undefined,
        keep: keepWorktree,
        branch: isolated.branch,
        baseSha: isolated.baseSha,
      });
    }
    // 新建的会话要立刻出现在列表里，否则手机端最长 10 秒看不到它。
    invalidateSessionList(ctx);
    return {
      status: 200,
      body: {
        ok: true,
        sessionId,
        cwd: payload.cwd || null,
        ...(isolated ? { isolated: true, keepWorktree: keepWorktree || undefined } : {}),
        ...(value && typeof value.agentPreset === 'string' ? { agentPreset: value.agentPreset } : {}),
      },
    };
  });
  sendJson(res, outcome.status, outcome.body);
}

module.exports = { handleNew };

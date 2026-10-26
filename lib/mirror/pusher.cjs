'use strict';

/**
 * 镜像推送调度器：把宿主的会话状态推到中转，手机端才看得到列表与消息。
 *
 * 三条不能丢的约束：隧道没连上就不构建快照（否则 503 刷屏，真故障被淹没）；空清单/空快照
 * 不许广播（「没取到」与「被删光」形状相同，放行会让手机侧整行消失且零报错）；推送成功后
 * 先 `sessionSignal.bump` 再 `announceSessionsRevision`，顺序反了手机会来取上一份镜像。
 *
 * 必须是 .cjs：包根声明 type=module，而 lib/mirror/ 没有自己的 `{"type":"commonjs"}`。
 */

const path = require('node:path');

const sessions = require('../mobile/sessions.js');
const workspaces = require('../mobile/workspaces.js');
const { createWorkspaceGuard, createSessionListGuard } = require('../shared/workspace-guard.js');
const { stableRevision } = require('../shared/list-revision.js');
const { dshHome } = require('../shared/paths.js');
const { listSignal: sharedListSignal } = require('../shared/list-signal.js');
const { sessionSignal: sharedSessionSignal } = require('../shared/session-signal.js');
const { dropSessionListCache } = require('../mobile/session-cache.js');
const { observeCompletionEvent } = require('../mobile/completion.js');
const { lastTurnOf } = require('../mobile/session-last-turn.js');

/** 后台循环每个 tick 补推一个冷会话，保证没人动的会话镜像也不长期不更新。 */
const HIGH_PRIORITY_WINDOW_MS = 5 * 60 * 1000;
const BG_TICK_INTERVAL_MS = 500;
/**
 * 没人看的时候，后台 tick 降到这个节拍。
 *
 * 500ms 是给「手机正在用」准备的：清单或工作区一变，半秒内就该看到。没人看时每 500ms
 * 整轮重建并推一次纯属空转。上限由 sidecar 的 15s 快照 TTL 卡着，取 5s（= TTL/3，
 * `test/mirror-tick-budget.test.cjs` 钉着这条比例）。
 */
const IDLE_TICK_INTERVAL_MS = 5_000;
/**
 * 多久没有手机请求就算「没人看」。
 *
 * 走中转的手机每个请求都会记一次 `mobile/activity.cjs` 的 `note()`；局域网直连的手机
 * 不走那道守卫所以记不到，那种情况另有 `listSignal.watching()` 兜着（有人订阅清单变化时
 * 它为真）。两个判据都不成立时才降频。
 */
const AUDIENCE_IDLE_MS = 30_000;
/**
 * 冷会话轮转的最小间隔（清单/工作区都没变时才生效）。
 *
 * 500ms 的 tick 不能省：清单与工作区的内容指纹就是这个节奏读宿主才发现的，App 侧
 * 「镜像正常最多旧 500ms」的新鲜度契约也押在它上面。
 *
 * 但 tick 里最贵的是轮转冷会话：合成 summary 让每轮指纹都不同，session-mirror 的缓存
 * 永不命中，每 500ms 真的去拉 200 条消息，而冷会话的正文按定义不会变。所以两个指纹都没变
 * 时轮转退到 5s 一次，只留「把冷会话正文补进镜像」这一个作用。5s 必须明显小于
 * `MIRROR_SNAPSHOT_TTL_MS`（15s），否则 sidecar 的镜像快照会被判过期。
 */
const BG_COLD_ROTATE_MIN_INTERVAL_MS = 5000;
const MAX_CONCURRENT_SESSION_BUILDS = 2;
const MAX_CONSECUTIVE_EVENT_BUILDS = 3;

function createMirrorPusher(deps) {
  const { ctx, tunnelConnected, getSidecar, listSignal = sharedListSignal, sessionSignal = sharedSessionSignal } = deps;
  // iOS 推送出口（`mobile/push-notify.js` 的 `notifyTurnEnded`）。不传就完全不推——
  // 装配层漏接线时不该在这里崩。标题从镜像清单现查（noteMirrorList 维护缓存）。
  const notifyTurnEnded = typeof deps.notifyTurnEnded === 'function' ? deps.notifyTurnEnded : null;
  const titleCache = new Map();
  const sessionTitleOf = (sessionId) => titleCache.get(sessionId) || '';
  /**
   * 「手机最近来过没有」的取值器（`mobile/activity.cjs` 的 `snapshot` 形态）。
   *
   * 不传就按「有人在看」处理、维持原来 500ms 的节拍：降频是个优化，不是契约，
   * 别让一处漏接线的装配把镜像悄悄降成 5s 一份。
   */
  const lastMobileAt = typeof deps.lastMobileAt === 'function' ? deps.lastMobileAt : null;
  /**
   * 本实例签发过、仍然有效的设备凭据摘要（凭据库 activeDigests 的形态）。
   *
   * 中转加了离线镜像缓存后，桌面还没上线时也要能判断「来读这份缓存的人是不是配对过的
   * 手机」，而它手上只有手机发来的 `dshc_` 原文 —— 摘要随镜像给上去，它才能自己算 sha256
   * 比对。不传就按「一份都没有」处理：镜像照推，只是中转认不出任何缓存读者。
   */
  const credentialDigests = typeof deps.credentialDigests === 'function' ? deps.credentialDigests : () => [];
  const hasAudience = () => {
    if (listSignal.watching()) return true;
    if (!lastMobileAt) return true;
    const at = Number(lastMobileAt()?.lastMobileAt) || 0;
    return at > 0 && Date.now() - at <= AUDIENCE_IDLE_MS;
  };

  // 移动镜像推送状态（供诊断/状态面板观测：最近推送时间 + 结果）
  let mirrorPushAt = 0
  let mirrorPushOk = null
  let mirrorPushError = null
  // 镜像推送状态的唯一记账点。/api/relay/status 的 mirror 字段是运维与 App
  // 诊断「镜像是否还在更新」的唯一抓手，任何一条推送路径漏记都会让它撒谎：
  // 要么「明明在推、pushedAt 却不动」，要么「快照构建失败却毫无信号」。
  const recordMirrorPush = (ok, error) => {
    mirrorPushAt = Date.now()
    mirrorPushOk = ok
    mirrorPushError = error || null
  }

  // 「正文没读上来，但清单照推了」的诊断出口。**刻意不写 ok/pushedAt**：这两者是
  // 「镜像还在不在更新」的判据，一次成功推送（清单已落地）不该被一条正文缺失翻成
  // 失败——0.1.51 真机上正是这么表现成「mirror.ok 长期 false、镜像其实在更新」的，
  // 反过来也让人误判成「镜像死了」。只留最近一条原因供 stderr 与状态诊断引用。
  let mirrorBodySkipCount = 0
  let mirrorBodySkipReason = null
  const recordMirrorPushSkipped = (reason) => {
    mirrorBodySkipCount += 1
    mirrorBodySkipReason = reason || null
  }

  // 内容未变的重复推送判重。
  //
  // 后台 500ms tick 每轮都会完整构建 sessions + workspaces（还带一个冷会话的消息
  // 快照），而多数 tick 的内容与上一份**语义相同**：推过去只会让 sidecar 落盘、中转
  // 更新镜像、手机再解一遍同样的 JSON。指纹取语义内容（清单 revision + 每个会话的
  // 消息水位/条数 + 统计投影 + 模型 revision），不含 `at` 之类的时间戳，所以「同一份
  // 数据」永远得到同一个指纹。只记成功推送的指纹：失败的那次必须能在下一 tick 重试。
  let lastPushedFingerprint = null;
  // 上一次推上去的摘要清单（判重键见 credsKeyOf）。**刻意不并进 pushFingerprint**：那是与
  // 中转共享的载荷指纹，收的是镜像内容；摘要另立一份，撤销一台设备后哪怕清单一个字都没变，
  // 新摘要也能在一个 tick 内传导过去（否则被撤销的手机还能继续读离线镜像）。
  let lastPushedCreds = null;
  /** 摘要清单的判重键：条数、顺序、过期时间任一变化都算新内容。 */
  const credsKeyOf = (creds) => creds.map((entry) => (entry.expiresAt ? `${entry.hash}@${entry.expiresAt}` : entry.hash)).join(',');
  // 「中转镜像里那份清单 / 工作区是哪一版」——同样只记真的推出去（或被判重跳过）的那一版，
  // 供 processBgQueue 的门判断这一轮有没有必要重建再推一份。判据必须是 revision 而不是
  // pushFingerprint：后者含轮转会话的消息水位与统计投影，每轮都不同。
  let lastPushedListRevision = '';
  let lastPushedWorkspacesRevision = '';
  const pushFingerprint = (payload) => {
    const parts = [
      `s:${payload.sessions && payload.sessions.revision ? payload.sessions.revision : ''}`,
      `w:${payload.workspaces && payload.workspaces.revision ? payload.workspaces.revision : ''}`,
      `a:${payload.activeSessionId || ''}`,
    ];
    for (const id of Object.keys(payload.messages || {}).sort()) {
      const m = payload.messages[id];
      const lastSeq = m && Number.isFinite(m.lastSeq) ? m.lastSeq : -1;
      const count = m && Array.isArray(m.items) ? m.items.length : -1;
      parts.push(`m:${id}:${lastSeq}:${count}`);
    }
    for (const id of Object.keys(payload.stats || {}).sort()) {
      const s = payload.stats[id];
      parts.push(`t:${id}:${stableRevision(s && s.projections)}`);
    }
    for (const id of Object.keys(payload.models || {}).sort()) {
      const d = payload.models[id];
      parts.push(`d:${id}:${d && d.revision !== undefined ? d.revision : ''}`);
    }
    return parts.join('|');
  };

  // 「清单内容变了，手机该刷新了」的唯一广播点。
  //
  // 判据只看清单自己的 revision，不能复用 pushFingerprint：指纹里还有本轮轮转推送的冷
  // 会话（消息水位 / 统计投影），每 tick 都在变，拿它当变更信号会变成每 500ms 一次的
  // 假变更。revision 是清单内容的哈希（lib/shared/list-revision.js），App 快照里存的
  // 也是同一个值，语义上就是「这份列表换了」。
  let lastSignalRevision = '';
  const sessionsRevisionOf = (body) => (body && typeof body.revision === 'string' ? body.revision : '');
  /**
   * 工作区清单的内容指纹也进信号总线。
   *
   * 不这么做，「`/workspaces` 的构建前短路」就没有可信的变更判据 —— 手机只能每 15 秒
   * 让宿主把整份工作区（含归档会话 id 列表，几十 KB）重建一遍。这里只报指纹（幂等），
   * 推送照旧按原来的指纹判重。
   */
  const observeWorkspaces = (body) => {
    if (body && typeof body.revision === 'string' && body.revision) listSignal.bumpWorkspaces(body.revision);
    return body;
  };
  const announceSessionsRevision = (revision) => {
    if (!revision || revision === lastSignalRevision) return false;
    // 只在真正广播时才前移基准：构建失败、守卫拦下、推送失败这些路径都不该消耗掉
    // 一次变更（否则手机要等到下一次内容变化，可能就是一分钟后）。
    lastSignalRevision = revision;
    // 手机上「我刚在桌面做的动作」也必须立刻可见：丢掉 /sessions 那层 10 秒缓存。
    // 用 drop 而不是 invalidate：后者会抬 completion generation，而清单 revision 在
    // 生成期每 500ms 就变一次，抬 generation 会让 confirmCompletionFromHistory 永远
    // 被跳过（completed / 红点彻底不亮，见 session-cache.js 的注释）。
    dropSessionListCache(ctx);
    listSignal.bump(revision);
    return true;
  };

  /**
   * 快照里「真正装上的消息」的最大 seq。
   *
   * 刻意不用快照自身的 `lastSeq`：那是**事件**水位（turn/end、usage 之类都会推高它），
   * 而 App 的会话缓存水位与 `afterSeq` 的语义都是**消息** seq（见
   * dsh-mobile-plugin/lib/mobile/session-snapshot.js 的 eventSeqOf 过滤，以及
   * app/src/services/conversation-cache.ts 的 cacheWatermark）。用事件水位当通知值，
   * 手机每收到一帧都会判「缓存落后」而白拉一次。
   */
  const messageWatermarkOf = (body) => {
    const items = body && Array.isArray(body.items) ? body.items : null;
    if (!items) return 0;
    let watermark = 0;
    for (const item of items) {
      const seq = Number(item && item.seq);
      if (Number.isFinite(seq) && seq > watermark) watermark = seq;
    }
    return watermark;
  };

  /**
   * 「这些会话的正文又长了」的唯一广播点。
   *
   * 广播的不是「镜像里有新正文」，而是「本机这份会话的正文到了这个水位」——手机拿水位和
   * 自己的缓存一比就知道该不该增量拉。所以它与「镜像有没有推成功」是两件事：隧道断开或
   * 纯局域网模式下推送会短路，广播绑在成功分支里就一帧水位都发不出去，非打开会话只能靠
   * 60s 兜底轮询。内容没变时补一次广播是幂等的，sessionSignal 保证水位不变或更低时不发。
   */
  const announceSessionActivity = (messages) => {
    if (!messages || typeof messages !== 'object') return;
    for (const [sessionId, body] of Object.entries(messages)) {
      const watermark = messageWatermarkOf(body);
      if (watermark > 0) sessionSignal.bump(sessionId, watermark);
    }
  };

  // 镜像推送的唯一出口：所有 pushSync 都必须经此，保证状态与真实推送一致。
  const pushMirrorPayload = async (payload) => {
    // 每一次推上去的清单都顺手记一下规模（含短路那两条路径：手机侧栏看的就是这份清单）。
    noteMirrorList(payload && payload.sessions);
    if (!tunnelConnected()) {
      recordMirrorPush(false, '隧道未连接，镜像未推送');
      // 没推成镜像，但「正文长到哪儿了」这件事仍然要说给手机听（见 announceSessionActivity）。
      announceSessionActivity(payload.messages);
      return false
    }
    const listRevision = sessionsRevisionOf(payload.sessions);
    const workspacesRevision = payload.workspaces && typeof payload.workspaces.revision === 'string'
      ? payload.workspaces.revision
      : '';
    // 摘要只在这一处塞进载荷：这里是唯一出口，三条推送路径（事件、整批、后台 tick）自然
    // 都带上，谁也不必记得自己补。放在隧道判定之后 —— 断线时这份清单没有任何去处，
    // 白读一趟凭据库。
    payload.creds = credentialDigests();
    const credsKey = credsKeyOf(payload.creds);
    const fingerprint = pushFingerprint(payload);
    if (fingerprint === lastPushedFingerprint && credsKey === lastPushedCreds) {
      // 跳过不等于故障：内容与上一份逐字段相同。但 pushedAt 必须继续走，它是运维与
      // App 诊断「镜像是否还在更新」的唯一抓手，停在这里会让它看起来像镜像死了。
      recordMirrorPush(true, '内容未变，跳过重复推送');
      lastPushedListRevision = listRevision;
      lastPushedWorkspacesRevision = workspacesRevision;
      lastPushedCreds = credsKey;
      announceSessionActivity(payload.messages);
      return false;
    }
    try {
      await getSidecar().pushSync(payload)
    } catch (error) {
      recordMirrorPush(false, error instanceof Error ? error.message : String(error))
      throw error
    }
    lastPushedFingerprint = fingerprint;
    lastPushedCreds = credsKey;
    recordMirrorPush(true, null)
    // 基准只在真的推进去（或被判重跳过）之后才前移：推送失败必须能在下一轮重试，
    // 否则「清单变了」会被一次失败吃掉，中转镜像永远停在旧版（见 processBgQueue 的门）。
    lastPushedListRevision = listRevision;
    lastPushedWorkspacesRevision = workspacesRevision;
    // 推送成功之后才广播：sidecar 把 payload 写进隧道就回 202，中转稍后才装进
    // inst.mirror，而信号帧走的是同一条隧道 —— 先推后广播，手机上紧跟信号的那次读取
    // 才不会读到还没来得及更新的旧镜像。
    announceSessionsRevision(sessionsRevisionOf(payload.sessions));
    // 上面刻意保留内联形式（而不是传局部 listRevision）：`app/scripts/test-session-activity.js`
    // 的跨仓契约按字面钉住「广播的 revision 必须由 payload.sessions 现算」，改写会让它红。
    // 与清单信号同一个「先推后广播」的顺序要求：手机收到这条帧后会立刻带 afterSeq 去
    // /session/messages 增量拉，中转那边必须已经有这份正文（走同一条隧道，只有先推后
    // 广播才能保证）。
    announceSessionActivity(payload.messages);
  }

  // 基准落盘：插件随桌面 harness 频繁重启，基准只在内存里的话，重启后的第一份快照
  // 正好撞上桌面刚起来的忙乱期（最可能出空的那一段）就会畅通无阻。
  const workspaceGuard = createWorkspaceGuard({
    persistPath: path.join(dshHome(), 'mobile-empty-workspaces.json'),
  })
  const guardWorkspaces = (workspacesBody) => workspaceGuard.check(workspacesBody)
  // 会话列表同样要守：它才是侧边栏的主体内容，宿主降级读一旦回空，App 立刻只剩
  // 设备行（真机现象）。此前只有工作区一侧有防线。
  const sessionListGuard = createSessionListGuard({
    persistPath: path.join(dshHome(), 'mobile-empty-sessions.json'),
  })
  const guardSessions = (sessionsResponse) => {
    if (!sessionsResponse || sessionsResponse.status !== 200) return 'sessions 响应不可用，本次未推送'
    return sessionListGuard.check(sessionsResponse.body)
  }

  const isHighPriority = (s) => s && (s.running || (s.updatedAt && Date.now() - s.updatedAt < HIGH_PRIORITY_WINDOW_MS));

  /**
   * 镜像清单本身的规模（自检台账用）：会话总数、其中活跃的、其中子会话。
   *
   * 这是插件侧能诚实报出的那部分规模：宿主内存里挂着多少会话、正文占多少，插件看不到。
   * 只在真拿到清单时更新，拿不到时保留上一次读数，与「清单突然变成 0」区分开。
   */
  let mirrorListSessions = 0;
  let mirrorListActiveSessions = 0;
  let mirrorListSubagents = 0;
  let mirrorListAt = 0;
  const noteMirrorList = (sessionsBody) => {
    const items = sessionsBody && Array.isArray(sessionsBody.items) ? sessionsBody.items : null;
    if (!items) return;
    mirrorListSessions = items.length;
    mirrorListActiveSessions = items.filter(isHighPriority).length;
    mirrorListSubagents = items.filter((s) => s && s.origin === 'subagent').length;
    mirrorListAt = Date.now();
    // 标题缓存：推送帧的标题从这里现查（列表本来就带 title，白拿）。
    titleCache.clear();
    for (const item of items) {
      if (item && typeof item.sessionId === 'string' && typeof item.title === 'string' && item.title.trim()) {
        titleCache.set(item.sessionId, item.title.trim());
      }
    }
  };

  // Every session snapshot fans out to three Host RPCs. Bound the number of sessions
  // being built globally; event work gets priority, but batch/cold work gets one slot
  // after at most three consecutive event jobs to prevent starvation.
  const sessionBuildQueues = { event: [], batch: [], cold: [] };
  let activeSessionBuilds = 0;
  let consecutiveEventBuilds = 0;
  let lastBackgroundBuildPriority = 'cold';
  const takeNextSessionBuild = () => {
    const { event, batch, cold } = sessionBuildQueues;
    if (event.length && (consecutiveEventBuilds < MAX_CONSECUTIVE_EVENT_BUILDS || (!batch.length && !cold.length))) {
      consecutiveEventBuilds += 1;
      return event.shift();
    }
    if (batch.length || cold.length) {
      consecutiveEventBuilds = 0;
      const priority = batch.length && (!cold.length || lastBackgroundBuildPriority === 'cold') ? 'batch' : 'cold';
      lastBackgroundBuildPriority = priority;
      return sessionBuildQueues[priority].shift();
    }
    if (event.length) {
      consecutiveEventBuilds = 1;
      return event.shift();
    }
    return null;
  };
  const drainSessionBuildQueue = () => {
    while (activeSessionBuilds < MAX_CONCURRENT_SESSION_BUILDS) {
      const job = takeNextSessionBuild();
      if (!job) return;
      activeSessionBuilds += 1;
      Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
        activeSessionBuilds -= 1;
        drainSessionBuildQueue();
      });
    }
  };
  const withSessionBuildSlot = (priority, run) => new Promise((resolve, reject) => {
    const queue = Object.hasOwn(sessionBuildQueues, priority) ? sessionBuildQueues[priority] : sessionBuildQueues.event;
    queue.push({ run, resolve, reject });
    drainSessionBuildQueue();
  });

  /**
   * 构建一个会话的镜像数据（正文快照 + 统计投影 + 模型列表）。
   *
   * `summary` 必须是清单里的那一行（或它的 Promise）：`session-mirror.js` 的后台缓存指纹
   * 就是 `updatedAt:running|idle:limit`，硬塞 `Date.now()` 会让 2 分钟 TTL 永不命中。
   * `running` 如实取清单值，高优先判定用的就是它。传 Promise 是为了与清单构建并行。
   *
   * `reuseCache` 默认 true，但事件驱动路径必须传 false：缓存只认「updatedAt 抬了」这一种
   * 变化，新消息落盘而摘要未变时会把上一份正文当成这一份发出去（`noCache` 既不读也不写缓存）。
   */
  const buildSessionDataUnlocked = async (sessionId, summaryOrPromise, { reuseCache = true } = {}) => {
    const summary = summaryOrPromise && typeof summaryOrPromise.then === 'function'
      ? await summaryOrPromise
      : summaryOrPromise;
    // 清单里没有这一行（比如事件先到、清单还没刷出来）时退回 Date.now()：这个值只参与
    // 缓存指纹，不影响正文内容本身。
    const updatedAt = (summary && summary.updatedAt) || Date.now();
    /**
     * 子会话的正文刻意不建：普通历史接口读子会话会被宿主按 durable parent address 拒掉
     * （`agent-busy: subagent Sessions require their durable parent address`），而手机打开
     * 子代理读的是专用通道（见 lib/mobile/subagents.js），这份正文本来就用不到。
     *
     * 提前认出清单行上的 `origin === 'subagent'` 就不发那次请求，且 skipReason 留空：它不是
     * 失败，不该进 `skippedBodies`。清单行、stats、models 照旧构建，载荷形状与「正文缺席」
     * 那条路径一致。
     */
    if (summary && summary.origin === 'subagent') {
      const [stats, models] = await Promise.all([
        sessions.buildStatsSnapshot(ctx, sessionId),
        sessions.buildModelsSnapshot(ctx, sessionId),
      ]);
      return {
        messages: null,
        skipReason: null,
        stats: stats?.ok ? stats : null,
        models: models?.ok ? models : null,
      };
    }
    const [messages, stats, models] = await Promise.all([
      sessions.buildMirrorWarmSnapshots(
        ctx,
        [{ sessionId, updatedAt, running: Boolean(summary && summary.running) }],
        sessionId,
        // 事件驱动路径必须**绕开缓存**（noCache），而不是塞一个假 updatedAt 去撞指纹：
        // 指纹是 `updatedAt:running:limit`，同一个毫秒里的两次推送指纹完全相同，照样会
        // 命中上一份正文（test/device-session-activity.test.cjs 真红过这一次）。
        { maxSessions: 1, limit: 200, noCache: !reuseCache },
      ),
      sessions.buildStatsSnapshot(ctx, sessionId),
      sessions.buildModelsSnapshot(ctx, sessionId),
    ]);
    const msg = messages?.[sessionId];
    // 读不到这个会话的消息快照**不是致命错误**：正文是镜像里的一个槽位，缺了它最坏是
    // 「这个会话的正文不新鲜」，而整轮抛错会把整份清单/工作区一起挡在门外、连同
    // `device/list-changed` 广播一起丢掉，手机侧表现为「列表停在几分钟前」。
    // 0.1.51 把它改成抛错之后，只要清单里有任何一个会话读不到（真机上长期有：活跃/
    // 子会话在生成期读不到历史），后台 tick 就被失败重试占满、镜像彻底不更新。
    // 失败原因随 `messages._errors` 带出来，状态接口与诊断不再只有一句「snapshot missing」。
    return {
      messages: msg?.ok ? msg : null,
      // 记一笔不推上去的原因，只为诊断与水位广播（见 pushSessionNow 的 skipped 处理）。
      skipReason: msg?.ok
        ? null
        : `session message snapshot unavailable for ${sessionId}: ${messages?._errors?.[sessionId] || 'unknown'}`,
      stats: stats?.ok ? stats : null,
      models: models?.ok ? models : null,
    };
  };
  const buildSessionData = (sessionId, summaryOrPromise, { priority = 'event', ...options } = {}) =>
    withSessionBuildSlot(priority, () => buildSessionDataUnlocked(sessionId, summaryOrPromise, options));

  // ── 失败会话的定向重试 ────────────────────────────────────────────────
  //
  // 为什么需要：pushSessionNow 的失败路径过去只记 stderr，而冷轮转又明确跳过所有高优先
  // 会话（下面的 `isHighPriority(s)` 分支），于是「正在生成的会话推送失败」没有任何补推
  // 途径 —— 它要等到自己变冷（超过 5 分钟没动）再排队等轮转，而轮转每个 5s 窗口只有一个
  // 名额，队列长了就是分钟级。叠加 sidecar-facade 的 5s 超时且零重试，一次抖动就能让
  // 某个会话的镜像停在旧版。
  //
  // 用「到期时间 + 现有 500ms tick」而不是 setTimeout：少一个要 unref 的定时器，退避精度
  // 到 tick 粒度完全够用，也天然随 effect 清理一起停。失败次数放在 Map 里（而不是闭包
  // 变量）是为了让测试与诊断能直接观察到「重试了几次」。
  const sessionPushFailures = new Map();
  const RETRY_BASE_DELAY_MS = 2000;
  const RETRY_MAX_DELAY_MS = 30000;
  const noteSessionPushFailure = (sessionId, error) => {
    const previous = sessionPushFailures.get(sessionId);
    const attempts = (previous ? previous.attempts : 0) + 1;
    const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempts - 1), RETRY_MAX_DELAY_MS);
    sessionPushFailures.set(sessionId, {
      attempts,
      dueAt: Date.now() + delay,
      lastError: error instanceof Error ? error.message : String(error),
    });
  };
  const clearSessionPushFailure = (sessionId) => { sessionPushFailures.delete(sessionId); };
  /** 到期该重试的会话 id（按到期时间升序）。 */
  const dueRetries = (now) => [...sessionPushFailures.entries()]
    .filter(([, entry]) => entry.dueAt <= now)
    .sort((a, b) => a[1].dueAt - b[1].dueAt)
    .map(([sessionId]) => sessionId);

  const retainSessionSignals = (sessionsBody) => {
    if (typeof sessionSignal.retain !== 'function') return;
    const items = sessionsBody?.body?.items;
    if (!Array.isArray(items)) return;
    sessionSignal.retain(items.map((item) => String(item?.sessionId || '')).filter(Boolean));
  };

  const pushSessionNow = (sessionId, priority = 'event') => withSessionBuildSlot(priority, async () => {
    try {
      // 清单与消息快照并行：summary 用 Promise 传进去（见 buildSessionData 的注释），
      // 避免为了一个真实 updatedAt 把热路径改成串行两跳。
      const sessionsPromise = sessions.buildSessionsResponse(ctx, 'legacy');
      const summaryPromise = sessionsPromise.then(
        (body) => (body?.body?.items || []).find((s) => String(s.sessionId) === String(sessionId)),
      );
      const [sessionsBody, workspacesBody, data] = await Promise.all([
        sessionsPromise,
        workspaces.buildWorkspacesBody(ctx).then(observeWorkspaces),
        // event slot covers the full push; call the unlocked builder to avoid nesting the semaphore.
        buildSessionDataUnlocked(sessionId, summaryPromise, { reuseCache: false }),
      ]);
      const wsBlocked = guardWorkspaces(workspacesBody) || guardSessions(sessionsBody)
      if (!(sessionsBody?.status === 200) || wsBlocked) {
        const reason = wsBlocked || 'sessions 快照不可用，本次未推送';
        recordMirrorPush(false, reason);
        noteSessionPushFailure(sessionId, new Error(reason));
        return;
      }
      retainSessionSignals(sessionsBody);
      await pushMirrorPayload({
        kind: 'sync', at: Date.now(),
        activeSessionId: sessionId,
        sessions: sessionsBody.body,
        workspaces: workspacesBody,
        messages: data.messages ? { [sessionId]: data.messages } : {},
        stats: data.stats ? { [sessionId]: data.stats } : {},
        models: data.models ? { [sessionId]: data.models } : {},
      });
      // 没抛错就算这一次过关：内容已推上去、或判重跳过、或隧道没连（局域网模式本来就不推）。
      // 正文读不到（data.skipReason 非空）也走这里：**清单照推**，不带那个会话的正文。
      // 这不算失败，所以不进退避账本——进了的话，一个永久读不到的会话会每 30s 占掉
      // 一次 tick 的额度，把冷轮转和清单推送一起饿死（0.1.51 的真机故障）。
      clearSessionPushFailure(sessionId);
      if (data.skipReason) {
        recordMirrorPushSkipped(data.skipReason);
        process.stderr.write(`[dsh-mobile-plugin] mirror body skipped: ${data.skipReason}\n`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      recordMirrorPush(false, message);
      noteSessionPushFailure(sessionId, e);
      process.stderr.write(`[dsh-mobile-plugin] mirror push failed for session ${sessionId}: ${message}\n`);
    }
  });

  // 按会话单飞。同一会话同一时刻只允许一次立即推送在途；在途期间再来事件只置一次待推
  // 标记，等这次推送结束后补推一次。没有它，一轮生成里的几百条事件会叠成几百次
  // 「五份全量快照构建 + 一次 sidecar 推送」，把宿主和 sidecar 一起拖垮。
  const sessionPushInFlight = new Map();
  const sessionPushQueued = new Set();
  const pushSessionImmediately = (sessionId) => {
    const running = sessionPushInFlight.get(sessionId);
    if (running) { sessionPushQueued.add(sessionId); return running; }
    const task = pushSessionNow(sessionId).finally(() => {
      sessionPushInFlight.delete(sessionId);
      if (sessionPushQueued.delete(sessionId)) void pushSessionImmediately(sessionId);
    });
    sessionPushInFlight.set(sessionId, task);
    return task;
  };

  const pushMirror = async (sessionIds) => {
    // 失败时要知道是哪几个会话没推上去（catch 里逐个记一笔，交给 tick 定向补推）。
    let attempted = [];
    try {
      const [sessionsBody, workspacesBody] = await Promise.all([
        sessions.buildSessionsResponse(ctx, 'legacy'),
        workspaces.buildWorkspacesBody(ctx).then(observeWorkspaces),
      ]);
      const wsBlocked = guardWorkspaces(workspacesBody) || guardSessions(sessionsBody)
      if (!(sessionsBody?.status === 200) || wsBlocked) {
        recordMirrorPush(false, wsBlocked || 'sessions 快照不可用，本次未推送')
        return
      }
      retainSessionSignals(sessionsBody);
      const list = sessionsBody.body.items || [];
      const highPrio = sessionIds
        ? list.filter(s => sessionIds.includes(String(s.sessionId)))
        : list.filter(isHighPriority);
      attempted = highPrio;
      const allMessages = {}; const allStats = {}; const allModels = {};
      await Promise.all(highPrio.map(async (s) => {
        const id = String(s.sessionId);
        // 整批高优先会话：host/* 帧或隧道刚连上（补推全量），内容同样可能刚变 —— 不复用缓存。
        const d = await buildSessionData(id, s, { reuseCache: false, priority: 'batch' });
        if (d.messages) allMessages[id] = d.messages;
        if (d.stats) allStats[id] = d.stats;
        if (d.models) allModels[id] = d.models;
        // 正文缺席在批量路径同样要留诊断：否则「整批里某个会话读不到」只表现为镜像里少一份
        // 正文，状态接口一句都看不到（这正是真机上查不出原因的那一类静默）。
        if (d.skipReason) recordMirrorPushSkipped(d.skipReason);
      }));
      const activeId = list.find(s => s.running)?.sessionId || null;
      await pushMirrorPayload({
        kind: 'sync', at: Date.now(),
        activeSessionId: activeId,
        sessions: sessionsBody.body,
        workspaces: workspacesBody,
        messages: allMessages, stats: allStats, models: allModels,
      });
      for (const s of highPrio) clearSessionPushFailure(String(s.sessionId));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      recordMirrorPush(false, message);
      // 整批失败归因不到单个会话，但这一批确实都没推上去：逐个记一笔，让 500ms tick 的
      // 定向重试把它们（包括高优先会话）一个个补推，而不是等它们变冷再排队。
      for (const s of attempted) noteSessionPushFailure(String(s.sessionId), e);
      process.stderr.write(`[dsh-mobile-plugin] mirror push failed: ${message}\n`);
    }
  };

  // 主动镜像：事件驱动。会话事件一律立即推（见下方 mux 循环）；后台循环每个 tick 再补推一个
  // 冷会话（从 bgQueuePos 起轮转），保证没人动的会话镜像也不会长期不更新。
  let bgQueuePos = 0;
  let bgQueueBusy = false;
  // 上一次真的跑过冷会话轮转的时刻（见 BG_COLD_ROTATE_MIN_INTERVAL_MS）。
  let lastColdRotateAt = 0;
  // 上一轮后台扫描真正跑起来的时刻（见 IDLE_TICK_INTERVAL_MS 的降频）。
  let lastBgScanAt = 0;

  const processBgQueue = async () => {
    if (bgQueueBusy) return;
    // 降频：没人看的时候不必每 500ms 重建一轮清单。判据用「手机最近有没有请求」，
    // 而不是「隧道连没连上」—— 隧道连着但人没在用，一样是空转。
    // 有人在看时不加额外下限，节奏仍由 500ms 的定时器自己决定。
    // 事件驱动那条路径（pushSessionImmediately）不受这里影响，会话真的变了仍是立即推。
    if (!hasAudience() && lastBgScanAt && Date.now() - lastBgScanAt < IDLE_TICK_INTERVAL_MS) return;
    lastBgScanAt = Date.now();
    const online = tunnelConnected();
    // 隧道未连接时这个 500ms 的 tick 只在**有人听**的时候才有意义：构建出来的快照没有
    // 任何去处（pushMirrorPayload 会短路），但「清单变了」这件事仍然要说给手机听 ——
    // 走局域网的手机是直接读本进程的，不需要中转镜像。没有观众就保留原来的空转早退，
    // 省掉构建开销，也避免每 tick 记一次推送失败。
    if (!online && !listSignal.watching()) return;
    bgQueueBusy = true;
    let shouldAnnounceRevision = true;
    try {
      const sessionsBody = await sessions.buildSessionsResponse(ctx, 'legacy');
      // 空列表此前只是静默 return，看不出是「真的没会话」还是「没取到」；这里让守卫
      // 判定并记录理由，别再无声无息。
      const sessionsBlocked = guardSessions(sessionsBody);
      if (sessionsBlocked) { if (online) recordMirrorPush(false, sessionsBlocked); return }
      retainSessionSignals(sessionsBody);
      // 清单内容版本（lib/shared/list-revision.js 的哈希）：既是广播判据，也是下面
      // 「中转镜像里那一版是不是这份」的比对基准 —— 全函数只算这一次。
      const revision = sessionsRevisionOf(sessionsBody && sessionsBody.body);
      if (!online) {
        // 离线：只广播「清单变了」，不推送也不记推送状态（否则会变成每 tick 一条假故障）。
        announceSessionsRevision(revision);
        return;
      }
      const list = sessionsBody?.body?.items || [];
      if (list.length === 0) {
        // 空清单**也要推**。守卫放行的空清单是「用户真的清空了」（body.emptyConfirmed
        // 由 mobile/sessions.js 按 items.length === 0 现算），不推的话中转镜像里那份旧
        // 清单会一直挂到 15s TTL 过期，手机上已删的会话最长还能看到十几秒；而且这条路径
        // 完全不记账，运维看不出镜像为什么不动。
        //
        // 跨包契约：中转侧对「空覆盖非空」有同口径保护，只认 emptyConfirmed === true 的空
        // 清单（中转的镜像状态里同一条谓词）。这里推的是 buildSessionsResponse 的原样 body，
        // 天然带这个字段。
        const workspacesBodyEmpty = await workspaces.buildWorkspacesBody(ctx).then(observeWorkspaces);
        const wsBlockedEmpty = guardWorkspaces(workspacesBodyEmpty);
        if (wsBlockedEmpty) {
          // 工作区那份快照不可用：别拿一份「没取到」的工作区去覆盖镜像，只广播清单。
          recordMirrorPush(false, wsBlockedEmpty);
          announceSessionsRevision(revision);
          return;
        }
        await pushMirrorPayload({
          kind: 'sync', at: Date.now(),
          activeSessionId: null,
          sessions: sessionsBody.body,
          workspaces: workspacesBodyEmpty,
          messages: {}, stats: {}, models: {},
        });
        announceSessionsRevision(revision);
        return;
      }
      // 门（见 BG_COLD_ROTATE_MIN_INTERVAL_MS）：清单与工作区都还停在中转镜像里那一版、
      // 又不到冷会话轮转时间时，这一轮到此为止 —— 省掉统计/模型投影与一个冷会话的 200 条
      // 正文（那才是这个 tick 的大头）。工作区体提前到这里构建，正是为了拿到它的 revision。
      const workspacesBody = await workspaces.buildWorkspacesBody(ctx).then(observeWorkspaces);
      const workspacesRevision = workspacesBody && typeof workspacesBody.revision === 'string' ? workspacesBody.revision : '';
      const now = Date.now();
      // 清掉已经不在清单里的会话（归档/删除），免得这张表无限长。
      const hasPendingRetry = sessionPushFailures.size > 0;
      if (hasPendingRetry) {
        const known = new Set(list.map((s) => String(s.sessionId)));
        for (const id of [...sessionPushFailures.keys()]) if (!known.has(id)) sessionPushFailures.delete(id);
      }
      // 失败会话只允许到期后的定向路径重试；不能让它绕过退避落入 500ms 冷轮转。
      // **重试是「额外补一次」，不是「这一轮的替代品」**：旧实现 retry 之后直接 return，
      // 于是只要账本里有一个到期失败会话（真机上是常态——活跃/子会话读不到历史），
      // 这一 tick 就永远停在重试上：冷轮转不跑、整份清单不推，镜像从此不再更新。
      const retryId = dueRetries(now).find((id) => list.some((s) => String(s.sessionId) === id));
      if (retryId) await pushSessionNow(retryId, 'batch');
      const coldRotateDue = now - lastColdRotateAt >= BG_COLD_ROTATE_MIN_INTERVAL_MS;
      // 摘要清单也是一份要推的内容：撤销一台设备时清单往往一个字都没变，只看 revision
      // 会把这一轮挡回去，被撤销的手机要等到下一个轮转窗口才失去离线镜像。
      if (revision === lastPushedListRevision && workspacesRevision === lastPushedWorkspacesRevision && credsKeyOf(credentialDigests()) === lastPushedCreds && !coldRotateDue) {
        // 清单与工作区都没变、也还没到轮转时间：这一轮除了刚做的重试什么都不用做。
        if (retryId) announceSessionsRevision(revision);
        return;
      }
      lastColdRotateAt = now;
      if (bgQueuePos >= list.length) bgQueuePos = 0;
      for (let i = 0; i < list.length; i++) {
        const idx = (bgQueuePos + i) % list.length;
        const s = list[idx];
        const candidateId = s ? String(s.sessionId) : '';
        // Failed sessions are retried only by dueRetries; cold ticks must not bypass their backoff.
        if (!s || sessionPushFailures.has(candidateId) || isHighPriority(s)) continue;
        const id = candidateId;
        let data;
        try {
          data = await buildSessionData(id, s, { priority: 'cold' });
        } catch (error) {
          // 单个会话构建失败只影响它自己：以前这里 rethrow，等于让一个读不到的会话
          // 把这一 tick 的整份清单推送一起带走。
          noteSessionPushFailure(id, error);
          shouldAnnounceRevision = false;
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[dsh-mobile-plugin] cold session build failed for ${id}: ${message}\n`);
          bgQueuePos = (idx + 1) % list.length;
          break;
        }
        const wsBlocked = guardWorkspaces(workspacesBody)
        if (!wsBlocked) {
          try {
            await pushMirrorPayload({
              kind: 'sync', at: Date.now(),
              activeSessionId: list.find(s2 => s2.running)?.sessionId || null,
              sessions: sessionsBody.body,
              workspaces: workspacesBody,
              messages: data.messages ? { [id]: data.messages } : {},
              stats: data.stats ? { [id]: data.stats } : {},
              models: data.models ? { [id]: data.models } : {},
            });
            if (data.skipReason) recordMirrorPushSkipped(data.skipReason);
          } catch (error) {
            // The payload helper already records the transport failure; add the session retry ledger
            // here without rethrowing into the generic catch (which would double-count the failure).
            noteSessionPushFailure(id, error);
            shouldAnnounceRevision = false;
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`[dsh-mobile-plugin] cold mirror push failed for session ${id}: ${message}\n`);
          }
        } else {
          recordMirrorPush(false, wsBlocked);
          noteSessionPushFailure(id, new Error(wsBlocked));
          shouldAnnounceRevision = false;
        }
        bgQueuePos = (idx + 1) % list.length;
        break;
      }
      // 所有会话都是高优先（正在跑 / 5 分钟内动过）时上面一条都没推：这一 tick 唯一
      // 能做的是把「清单变了」传下去。这类变更通常已经由事件路径推过镜像，广播是幂等的。
      if (shouldAnnounceRevision) announceSessionsRevision(revision);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      recordMirrorPush(false, message);
      process.stderr.write(`[dsh-mobile-plugin] bg queue: ${message}\n`);
    } finally {
      bgQueueBusy = false;
    }
  };

  /** 返回 effect 的清理函数，交给 index.js 用 ctx.effect 挂载（与原有形状一致）。 */
  const start = () => {
    let disposed = false;
    const ac = new AbortController();
    void (async () => {
      try {
        for await (const frame of ctx.apiProxy.events.mux({ rpcId: 'dsh-mirror-sync', payload: {} }, ac.signal)) {
          if (disposed) break;
          // 帧类型必须**先看 payload 再看顶层**。
          //
          // 0.2.0 的兼容桥（lib/mobile/host-bridge/*）把三类流合成旧 `events.mux` 时，产出的
          // 帧形状是 `{ payload: { type, sessionId, … } }` —— 顶层没有 type。旧实现只读
          // `frame?.type`，于是每一帧都在下面这行被 continue 丢掉：事件驱动的「变化即推」
          // 整条通道是哑的，镜像只剩 500ms 的冷轮转在推，而它每个 5s 窗口只补一个**冷**会话、
          // 明确跳过刚动过的会话（isHighPriority）⇒ 用户刚发过消息的那个会话永远轮不到，
          // 真机表现为「桌面发一条、手机列表要等好几秒甚至更久」。
          // 顶层 type 保留兼容（测试与将来恢复真 apiProxy 时形状可能不同）。
          const p = frame?.payload;
          const type = typeof frame?.type === 'string' ? frame.type : (p && typeof p.type === 'string' ? p.type : '');
          if (!type.startsWith('session/') && !type.startsWith('host/')) continue;
          if (type.startsWith('host/')) { void pushMirror(); continue; }
          // session/event 事件本身就是变更发生，按高优先级立即推送
          const sessionId = frame?.sessionId || p?.sessionId;
          if (!sessionId) { void pushMirror(); continue; }
          // assistant/chunk 是逐块流式增量，一轮生成里可达上千条。镜像只需要粗粒度状态：
          // 同一轮收尾时的 assistant/message 会把完整消息带进来，手机侧的实时文本由
          // session/stream 的 SSE 负责。不跳的话每条增量都要重建五份全量快照并推一次
          // sidecar，形成推送风暴（配合 pushSessionImmediately 的单飞才有稳定上界）。
          observeCompletionEvent(ctx, sessionId, p?.event);
          if (p?.event?.type === 'assistant/chunk') continue;
          // iOS 推送：turn/end 是「可能刚收尾」的信号，把事实（lastTurnOf 现读）交给
          // 通知器判断——只有 completed / failed 且这一轮之前没推过才会真发一帧。
          // 标题从镜像快照现查：中转与苹果都只认纯文本，没查到就用会话 id 前缀。
          if (p?.event?.type === 'turn/end' && notifyTurnEnded) {
            const fact = lastTurnOf(ctx, sessionId);
            if (fact) notifyTurnEnded(sessionId, fact, sessionTitleOf(sessionId));
          }
          void pushSessionImmediately(sessionId);
        }
      } catch { /* stream ended */ }
    })();
    const bgTimer = setInterval(() => { if (!disposed) void processBgQueue(); }, BG_TICK_INTERVAL_MS);
    // 定时器不该拖住进程退出（同 lib/sidecar-facade-worker.cjs 的 shutdown）。清理函数里
    // 已经 clearInterval，unref 是给「宿主进程要退出、effect 清理还没轮到」的那一瞬间兜底。
    if (bgTimer && typeof bgTimer.unref === 'function') bgTimer.unref();
    void pushMirror();
    return () => { disposed = true; ac.abort(); clearInterval(bgTimer); };
  };

  return {
    start,
    pushMirror,
    pushSessionImmediately,
    getMirrorPush: () => ({
      pushedAt: mirrorPushAt, ok: mirrorPushOk, error: mirrorPushError,
      // 正文缺失而清单照推的次数与最近原因：与 ok/pushedAt 分开，避免再把
      // 「某会话正文读不到」误读成「镜像死了」（见 recordMirrorPushSkipped）。
      skippedBodies: mirrorBodySkipCount, skipReason: mirrorBodySkipReason,
      // 清单规模（自检台账读它）：会话总数 / 其中活跃 / 其中子会话 / 这份读数的时间。
      // 这是「手机侧栏那份清单有多大」，**不是**「宿主内存里挂着多少会话、正文占多少」——
      // 后者插件看不到（见 lib/mobile/self-check.cjs 的口径段）。
      listSessions: mirrorListSessions,
      listActiveSessions: mirrorListActiveSessions,
      listSubagents: mirrorListSubagents,
      listAt: mirrorListAt,
    }),
    /** 失败会话的定向重试账（诊断 + 守卫用）：失败几次、下次什么时候补推。 */
    getPushFailures: () => [...sessionPushFailures.entries()].map(([sessionId, entry]) => ({
      sessionId, attempts: entry.attempts, dueAt: entry.dueAt, error: entry.lastError,
    })),
  };
}

module.exports = { createMirrorPusher };
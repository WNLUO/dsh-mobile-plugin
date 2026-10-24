/**
 * dsh-mobile-plugin 的**客户端半边**（在 DSH 桌面 Web 页面里运行）。
 *
 * 它做四件事：
 *
 * 1. **桌面端工作区展开态 → 宿主**。桌面侧边栏「哪些工作区分组是展开的」只记在
 *    **浏览器 localStorage**（`dsh.workspace.view.vN`，由 @deepseek-ai/dsh-client-ui-workspace
 *    的 createWorkspaceViewStore 持久化到 dsh-client-store 的 localStorage），
 *    宿主进程、中转和手机都读不到。移动端要与桌面端对齐展开态，就只能由页面里的
 *    这一半把状态读出来交给宿主。
 *
 *    数据方向是单向的：桌面 → 宿主 → 手机。手机上手动折叠/展开只存在 App 本地
 *    （AsyncStorage），不会写回这份 localStorage。
 *
 * 2. **设置 →「移动端」**（设置菜单里的顶层一项，不再挂在内置插件页签下）。保留
 *    **网页版入口**，并只加一颗由可信本机 DSH 设置页操作的公网访问开关；网页管理默认关闭，
 *    每次开启固定 2 小时，到期不因访问续时。管理界面本体仍在宿主吐出的 HTML 里。
 *
 *    为什么这里只加开关：这半边不可热替换，管理界面继续留在网页版；本机开关只控制
 *    网页管理路由，不改手机 App API 或隧道状态。插件更新仍交给 DSH 插件市场。
 *
 * 3. **桌面端已读 → 宿主**（`startDesktopReadSync`）。桌面侧栏的「已完成待读」绿点
 *    只活在渲染进程内存里（`UiSession.completionUnread`），宿主和手机都读不到。
 *    这一半盯着 `uiSession.sessionStatus`，把「刚从未读集合掉出去」的会话报给
 *    `/api/relay/desktop-read`，宿主据此清掉手机端那份完成提醒。
 *
 * 4. **手机端已读 → 桌面端**（`startReadReceiptSync`）。反方向：宿主把手机端读过
 *    哪些会话记成 `sessionId → readAt` 台账，这一半拉下来，对水位前进过的会话做一次
 *    瞬时 `sessions.retain(id, { source: 'mainView' })` + `release()`，借桌面自己的
 *    `reconcileStatus()` 把绿点摘掉。见 lib/read-receipt.cjs 的文件头。
 *
 * 写成惰性工厂（`window.__ModuleLoader__.load`）是 DSH 客户端插件的约定：
 * 运行 bundle 只注册工厂，副作用（这里的定时器、页签注册）在物化时才发生。
 * 工厂收到的 `require` 是 DSH 的模块表 require，`react` 是平台 seed word。
 *
 * 本文件**不经任何构建**（package.json 的 files 直接收录 lib 下的 .js），所以不能
 * 写 JSX：统一用 `React.createElement` 的别名 `h`。
 */

window.__ModuleLoader__.load({
  id: 'dsh-mobile-plugin',
  factory(require) {
    const {
      createElement: h,
      Fragment,
      useCallback,
      useEffect,
      useRef,
      useState,
    } = require('react');

    /* ── 样式 ──────────────────────────────────────────────────────────────
     * 用 DSH 的设计 token，跟随明暗主题；前缀 `dshm_` 避免与别的插件撞名。
     * 照抄 @deepseek-ai/dsh-client-ui-settings-plugins 的注入方式：同一
     * data-plugin-css 只注入一次，bundle 被重复物化也不会堆出第二份 <style>。
     *
     * 这里只留这一项用得到的几条：界面本体已经搬去网页版（那边自带一套样式），
     * 留着旧类名只会让人以为这里还画着那些东西。
     */
    const STYLE_ID = 'dsh-mobile-plugin/settings-tab.css';
    const CSS = `
.dshm_root{display:flex;flex-direction:column;gap:14px;width:100%;max-width:760px;color:var(--dsw-alias-label-primary)}
.dshm_card{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);display:flex;flex-direction:column;gap:10px;padding:14px 16px}
.dshm_cardTitle{font-size:14px;font-weight:600;line-height:20px;margin:0;display:flex;align-items:center;gap:8px}
.dshm_heading{font-size:18px;font-weight:600;margin:0}
.dshm_actions{display:flex;flex-wrap:wrap;gap:8px}
.dshm_note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshm_btn{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px;line-height:18px;padding:5px 12px;display:inline-flex;align-items:center;gap:6px;text-decoration:none}
.dshm_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshm_btn:disabled{cursor:default;opacity:.45}
.dshm_btnPrimary{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:var(--dsw-alias-bg-layer-1)}
.dshm_error{margin:0;border-radius:var(--dsw-radius-md);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;padding:8px 10px}
`;
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) === null) {
      const tag = document.createElement('style');
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ── 一：桌面工作区展开态同步（语义与原实现一字未改，只是搬进函数） ── */
    /** 桌面端持久化键：`dsh.workspace.view.v5`（版本号可能上浮，取版本最大的那个）。 */
    const STORAGE_KEY_RE = /^dsh\.workspace\.view\.v(\d+)$/;
    /** 轮询间隔：展开/折叠是低频操作，2s 足够跟手又不费电。 */
    const PUSH_INTERVAL_MS = 2000;
    /** 与宿主 lib/desktop-view.cjs 的上限保持一致，避免无谓的超大请求。 */
    const MAX_KEYS = 512;
    /**
     * 浏览器侧的应用路由一律写成**文档相对**形式（没有前导斜杠），与 DSH 自己的客户端
     * 一致：宿主给 index 注入了 `<base href="./">`，页面挂在哪个前缀下，请求就跟着哪个
     * 前缀走。写成 `/api/...` 这种站点根绝对地址，DSH 被反向代理挂到子路径（例如
     * `/dsh/`）时会直接打到站点根、拿回 404 —— 设置页看到的正是「读取宿主状态失败: HTTP 404」。
     */
    const DESKTOP_VIEW_ENDPOINT = 'api/relay/desktop-view';

    /** 读桌面端最新的视图状态；读不到返回 null（首次使用、隐私模式、键名变更等）。 */
    function readDesktopView() {
      let bestKey = null;
      let bestVersion = -1;
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        const match = key ? STORAGE_KEY_RE.exec(key) : null;
        if (!match) continue;
        const version = Number(match[1]);
        if (version > bestVersion) {
          bestVersion = version;
          bestKey = key;
        }
      }
      if (!bestKey) return null;
      const parsed = JSON.parse(localStorage.getItem(bestKey) || 'null');
      const state = parsed && typeof parsed === 'object' ? parsed : null;
      // 持久化写的是整份 store 状态（groupExpansion 就在顶层）；这里容忍将来可能
      // 出现的 { state } / { data } 包装。
      const holder = state && typeof state.groupExpansion === 'object' && state.groupExpansion !== null
        ? state
        : (state && state.state) || (state && state.data);
      const source = holder && typeof holder.groupExpansion === 'object' && holder.groupExpansion !== null
        ? holder.groupExpansion
        : null;
      if (!source) return null;
      const groupExpansion = {};
      let count = 0;
      for (const key of Object.keys(source)) {
        const value = source[key];
        if (typeof value !== 'boolean') continue;
        groupExpansion[key] = value;
        count += 1;
        if (count >= MAX_KEYS) break;
      }
      return { source: bestKey, groupExpansion };
    }

    function startDesktopViewSync(ctx) {
      ctx.effect(() => {
        let disposed = false;
        let lastBody = '';
        const push = async () => {
          if (disposed) return;
          let view = null;
          try {
            view = readDesktopView();
          } catch {
            view = null;
          }
          if (!view) return;
          const body = JSON.stringify(view);
          // 桌面没动过就不发：2s 轮询的成本压到最低，宿主也不用反复落盘。
          if (body === lastBody) return;
          try {
            const response = await fetch(DESKTOP_VIEW_ENDPOINT, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body,
              credentials: 'same-origin',
            });
            if (response.ok) lastBody = body;
          } catch {
            // 宿主没起来 / 页面正在重载：下一轮再试。
          }
        };
        void push();
        const timer = setInterval(() => {
          void push();
        }, PUSH_INTERVAL_MS);
        return () => {
          disposed = true;
          clearInterval(timer);
        };
      });
    }

    /* ── 二：控制面调用 ─────────────────────────────────────────────────────
     * 全部走同源 fetch，天然满足宿主的 `localOnly` 守卫（拒绝 cross-site、要求
     * Origin 与 Host 同源）——设置页与宿主同源，正是它被设计成的样子。
     *
     * 地址一律是**文档相对**的：宿主给 index 注入了 `<base href="./">`，把它挂在
     * 子路径下（反向代理 `/dsh/` 之类）时请求才会跟着前缀走。DSH 自己的客户端也是
     * 这么写的（`PATH.slice(1)`）。站点根绝对地址在那种部署下会打到根路径并 404。
     */
    const RELAY = 'api/relay';

    /** 错误正文有三种形状：字符串、{code,message}、{ok:false,error}。这里拍平成一句话。 */
    function errorText(body, status) {
      const raw = body && typeof body === 'object' ? body.error : body;
      if (typeof raw === 'string' && raw) return raw;
      if (raw && typeof raw === 'object') {
        const message = typeof raw.message === 'string' ? raw.message : '';
        const code = typeof raw.code === 'string' ? raw.code : '';
        if (message && code) return `${code}: ${message}`;
        if (message) return message;
        if (code) return code;
      }
      return `HTTP ${status}`;
    }

    /**
     * 控制面调用。`path` 既可以是 `/xxx` / `xxx` 这样的**短路径**（推荐，与
     * `postJson('/desktop-read')` 的写法一致），也可以直接甩一个完整的
     * `/api/relay/xxx` 或 `api/relay/xxx`——几种都接受，最终一律折成文档相对地址。
     *
     * **为什么必须几种都接受（2026-10-10 真机故障）**：这里以前是无条件
     * `${RELAY}${path}`，而绿点那两条同步传进来的偏偏是**已经带 `/api/relay` 的全路径**
     * （`READ_RECEIPT_ENDPOINT` / `DESKTOP_READ_ENDPOINT`），于是真正发出去的是
     * `/api/relay/api/relay/read-receipt` —— 一个不存在的地址。它返回 401/404，被
     * 两条同步各自的 `catch` 静静吞掉，所以「手机上读过桌面不灭灯」「桌面上读过手机
     * 不灭灯」从来就没通过，而且**一条日志都不留**（宿主侧活体台账里那两个计数恒为 0）。
     * 改断言而不是改实现是不行的：守卫测试里的假 fetch 按 `endsWith(endpoint)` 匹配，
     * 而 `/api/relay/api/relay/read-receipt` 也满足这个后缀 —— 测试因此一直是绿的。
     */
    function controlUrl(path) {
      const raw = String(path);
      if (raw.startsWith('/api/') || raw.startsWith('api/')) return raw.replace(/^\//, '');
      return `${RELAY}${raw.startsWith('/') ? raw : `/${raw}`}`;
    }

    async function call(path, init) {
      const url = controlUrl(path);
      let response;
      try {
        response = await fetch(url, {
          credentials: 'same-origin',
          ...(init || {}),
        });
      } catch (error) {
        throw new Error(String((error && error.message) || error));
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(errorText(body, response.status));
        error.status = response.status;
        throw error;
      }
      return body;
    }

    const postJson = (path, payload) => call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });

    /* ── 三：侧边栏未读绿点的双向同步 ───────────────────────────────────────
     * 两端的绿点是**两份互不相干**的状态：
     *   - 手机端 = 宿主按设备维度维护的完成提醒（lib/mobile/completion.js），
     *     由 `POST /api/mobile/v1/session/read` 清掉；
     *   - 桌面端 = 渲染进程内存里的 `UiSession.completionUnread`，既不落盘也不过服务端。
     * 所以「手机上读过了，桌面还亮着」和「桌面上读过了，手机还亮着」都得靠这一半补。
     *
     * 这两条同步都要桌面端的服务（uiSession / sessions），拿不到就整条不启动：
     * 注册了也只是空转的定时器。`ctx.get` 在 Cordis 上恒有，服务可能比我们晚就位，
     * 所以每个 tick 现取一次，而不是启动时取一次。
     */
    /** 轮询间隔：与展开态同步同频。绿点晚 2s 灭掉无感，但没必要更勤。 */
    const READ_SYNC_INTERVAL_MS = 2000;
    /** 一次上报最多带多少条，与宿主 lib/routes/control-plane.js 的上限一致。 */
    const MAX_READ_IDS = 200;
    const READ_RECEIPT_ENDPOINT = '/api/relay/read-receipt';
    const DESKTOP_READ_ENDPOINT = '/api/relay/desktop-read';
    /** 自检上报的出口与间隔：只为可观测性存在，不做任何状态变更。 */
    const CLIENT_HALF_ENDPOINT = '/api/relay/client-half';
    const CLIENT_HALF_REPORT_MS = 10000;

    /**
     * 把 sessionStatus 的快照摊成 [id, status] 列表。
     *
     * 快照是 Map，但这里不用 `instanceof Map` / 迭代协议：插件客户端半边在测试里会被
     * 塞进一个跨 realm 的假快照，`instanceof` 会跨 realm 判假。`forEach` 是鸭子类型，
     * 两种 realm 都认。
     */
    function statusEntries(snapshot) {
      const out = [];
      if (!snapshot) return out;
      if (typeof snapshot.forEach === 'function') {
        snapshot.forEach((value, key) => {
          out.push([key, value]);
        });
        return out;
      }
      if (typeof snapshot === 'object') {
        for (const key of Object.keys(snapshot)) out.push([key, snapshot[key]]);
      }
      return out;
    }

    /**
     * 方向一：桌面端读过了 → 告诉宿主，手机端侧栏灭灯。
     *
     * 三种情形算「桌面读过了」，每种只报一次（变回未读或重新跑起来时摘掉标记、可以再报）：
     *   - 本次打开页面之后**看见它从别的状态变成未读、又掉出去**（普通的点开）；
     *   - 此刻**正开在主视图里**（`retainedBy.mainView > 0`：用户盯着它读完，它压根不进未读集合）；
     *   - 本次打开页面之后**它变过、而且现在不是未读**（补掉漏采的那一瞬间）。
     *
     * **首帧一条都不报**：桌面页面刚加载时 `sessionStatus` 里全是 `completionUnread: false`
     * （`completionUnread` 只在浏览器内存里，重开页面就没了），照单全收会把手机上真的
     * 未读全灭掉。所以「页面打开之后变过」这条要求 `updatedAt > 页面打开时刻`，
     * 没拿到会话清单时宁可不报。
     */
    function startDesktopReadSync(ctx) {
      withClientServices(ctx, ['uiSession'], 'uiSession', 'mobile-plugin: 桌面端已读上报', (scope, isDisposed) => {
        /** 页面打开的时刻：只有这之后动过的会话才敢当成「看见过」。 */
        const openedAt = Date.now();
        let sending = false;
        /** 已经替它报过「读过」的会话；变回未读 / 运行中就摘掉。 */
        const reported = new Set();
        /** 本次页面里见过它处于未读的（普通的「点开」边沿就靠这个）。 */
        const everUnread = new Set();
        /** 待上报的会话 id；POST 失败就留着下一轮再发。 */
        const pending = new Set();

        /** 会话清单里每行的 `updatedAt` / `retainedBy`（拿不到就是空表，方向一退化成边沿判定）。 */
        const retainedRows = () => {
          try {
            const list = currentSessions && currentSessions.list;
            const snapshot = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : null;
            return (snapshot && snapshot.byId) || {};
          } catch {
            return {};
          }
        };

        const flush = async () => {
          if (sending || !pending.size) return;
          const ids = [];
          for (const id of pending) {
            ids.push(id);
            if (ids.length >= MAX_READ_IDS) break;
          }
          sending = true;
          try {
            await postJson(DESKTOP_READ_ENDPOINT, { sessionIds: ids });
            for (const id of ids) pending.delete(id);
          } catch {
            // 宿主没起来 / 页面正在重载：下一轮再试。
          } finally {
            sending = false;
          }
        };

        const scan = () => {
          if (isDisposed()) return;
          const uiSession = scope.uiSession;
          const store = uiSession && uiSession.sessionStatus;
          if (!store || typeof store.getSnapshot !== 'function') return;
          let snapshot = null;
          try {
            snapshot = store.getSnapshot();
          } catch {
            return;
          }
          const rows = retainedRows();
          for (const [id, status] of statusEntries(snapshot)) {
            const unread = !!(status && status.completionUnread === true);
            const running = !!(status && status.running === true);
            // 未读 = 还没读；运行中 = 这一轮的结局还没出来。两者都不是「读过了」。
            if (unread || running) {
              if (unread) everUnread.add(id);
              reported.delete(id);
              continue;
            }
            if (reported.has(id)) continue;
            const row = rows[id];
            const open = !!(row && Number(row.retainedBy && row.retainedBy.mainView) > 0);
            const changedWhileOpen = !!(row && typeof row.updatedAt === 'number' && row.updatedAt > openedAt);
            // 既没看见它掉出未读、也没见它这次变过、更没开着：多半只是页面刚加载，
            // 全是不带未读标记的空快照。一个都不许报。
            if (!everUnread.has(id) && !open && !changedWhileOpen) continue;
            reported.add(id);
            pending.add(id);
          }
          if (pending.size) void flush();
        };

        scan();
        const timer = setInterval(scan, READ_SYNC_INTERVAL_MS);
        return () => clearInterval(timer);
      });
    }

    /**
     * 拿到桌面客户端的两个服务：`uiSession`（未读绿点的真源 + 每会话运行态）与
     * `sessions`（会话清单 + `retain`）。
     *
     * **必须用 `ctx.inject([...], child => …)`，不能用 `ctx.get(name)`。** 2026-10-10
     * 真机故障：两条绿点同步通道一条都没在跑 —— 宿主侧的活体台账（`/api/relay/status`
     * 的 `desktopHalf`）显示桌面半边**一次 read-receipt 都没拉过**，而 read-receipt 那条
     * effect 是**无条件 2s 轮询**、`ctx.get` 之后才 fetch，所以只可能是 tick 在服务这一
     * 道 guard 上就返回了。同一个桌面里能正常工作的客户端插件（内置的 conversation /
     * approval、第三方 `dsh-opencode-go`）一律走 `inject`：DSH 自己的插件把服务写进
     * `inject` 数组，opencode-go 用 `ctx.inject([...], child => …)`。`ctx.get` 是「绕过
     * 注入直接取」，在客户端运行时里取不到这两个服务。拿不到就一个定时器都不起（与旧
     * 行为一致），由 lib/client.js 的自检上报把「到底看见了什么」说给宿主听。
     */
    /**
     * 客户端半边的自检状态：只给自检上报用（谁注入了、谁没注入）。
     * 放在这一层的原地变量：两条同步各占一格，拿不到服务时宿主能一眼看出来是**哪一条**
     * 没起来，而不是只看到「两边都没动静」。
     */
    const halfState = { uiSession: false, sessions: false, lastError: '' };

    function withClientServices(ctx, names, flagKey, label, run) {
      if (!ctx || typeof ctx.inject !== 'function') {
        halfState.lastError = 'ctx.inject 不可用';
        return;
      }
      try {
        ctx.inject(names, (scope) => {
          halfState[flagKey] = true;
          scope.effect(() => {
            let disposed = false;
            const stop = run(scope, () => disposed);
            return () => {
              disposed = true;
              if (typeof stop === 'function') stop();
            };
          }, label);
        });
      } catch (error) {
        halfState.lastError = `注入 ${names.join('+')} 失败：${String((error && error.message) || error).slice(0, 100)}`;
      }
    }

    /**
     * 把 sessions 服务抓进一个可变引用，供方向一判断「正开着」与「这次变过」。
     * 它缺席时少这一路增强（方向一仍有边沿与主视图两条判据），宿主侧自检里
     * `sessions` 那一格正是 false，排查时能一眼看出是服务没拿到。
     */
    let currentSessions = null;
    function captureSessions(ctx) {
      withClientServices(ctx, ['sessions'], 'sessions', 'mobile-plugin: 会话清单服务', (scope) => {
        currentSessions = scope.sessions;
        return () => { currentSessions = null; };
      });
    }

    /**
     * 方向二：手机上读过了 → 在桌面页面里就地清掉绿点。
     *
     * 拉宿主那份 `sessionId → readAt` 台账，对水位前进过的会话做一次瞬时
     * `sessions.retain(id, { source: 'mainView' })` + 同 tick `release()`。桌面自己的
     * `reconcileStatus()` 订阅了列表 store，而 `retain` 里的 `publishRetention` 会同步
     * 抬 `retainedBy.mainView`，于是 `completionUnread.delete(id)` 在 release 之前就已经
     * 发生；release 把引用数降回 0 也不会把绿点加回来（只有 `observeRunning(false)`
     * 且非 mainView 才会加）。整个过程同一个 tick 内完成，React 还没重渲染，看不到抖动。
     *
     * 为什么还要跟 `updatedAt` 比一次：台账只记「读过」不记「读完之后又跑完了一轮」。
     * 若不管这一条，桌面端**重新打开页面**时（内存里的 applied 游标是空的）会把一条
     * 早已被新一轮完成盖过的旧回执重新应用，把本该亮的绿点灭掉。会话的最后活动时间
     * 晚于已读水位，就说明这一轮是读完之后才跑完的，必须跳过。
     */
    function startReadReceiptSync(ctx) {
      withClientServices(ctx, ['sessions'], 'sessions', 'mobile-plugin: 已读回执应用', (scope, isDisposed) => {
        /** sessionId → 已经应用过的最大 readAt（只在本页存活期间有效）。 */
        const applied = new Map();

        const tick = async () => {
          if (isDisposed()) return;
          const sessions = scope.sessions;
          if (!sessions || typeof sessions.retain !== 'function') return;
          let payload = null;
          try {
            payload = await call(READ_RECEIPT_ENDPOINT);
          } catch {
            return;
          }
          if (isDisposed()) return;
          const receipt = payload && payload.receipt;
          const readAt = receipt && receipt.readAt;
          if (!readAt || typeof readAt !== 'object') return;
          let rows = {};
          try {
            const list = sessions.list;
            const snapshot = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : null;
            rows = (snapshot && snapshot.byId) || {};
          } catch {
            rows = {};
          }
          for (const id of Object.keys(readAt)) {
            const at = readAt[id];
            if (typeof at !== 'number' || !Number.isFinite(at)) continue;
            if (at <= (applied.get(id) || 0)) continue;
            const row = rows[id];
            const updatedAt = row && typeof row.updatedAt === 'number' ? row.updatedAt : 0;
            // 读完之后这一轮才跑完：回执已经过期，绿点该亮着。
            if (updatedAt > at) {
              applied.set(id, at);
              continue;
            }
            // 先把游标推进再动作：retain 对未知会话会抛错（会话可能已被删除），
            // 那是一次性失败，重试没有意义，不该让整份台账卡在它身上。
            applied.set(id, at);
            try {
              const reference = sessions.retain(id, { source: 'mainView' });
              if (reference && typeof reference.release === 'function') reference.release();
            } catch {
              // 未知/已删除的会话：跳过。
            }
          }
        };

        void tick();
        const timer = setInterval(() => {
          void tick();
        }, READ_SYNC_INTERVAL_MS);
        return () => clearInterval(timer);
      });
    }

    /* ── 文案 ──────────────────────────────────────────────────────────── */
    const NS = 'settings.mobileRelay';
    const DICT = {
      zh: {
        nav: '移动端',
        heading: '移动端',
        cardPanel: '配置页面',
        openPanel: '打开配置页面',
        openHint: '设置、配对和相关运维都在这个页面里。',
        panelPending: '正在读取页面地址…',
        panelMissing: '宿主还没给出页面地址，稍后再打开这一页试试。',
        loadFailed: '读取宿主状态失败',
        loadMissing: '插件宿主侧没有加载：把 DSH 完整退出再打开一次；还不行就在插件市场重装一遍插件。',
        webAccessOn: '公网网页管理已开放，到期时间',
        webAccessOff: '公网网页管理已关闭',
        webAccessOpen: '开放网页管理 2 小时',
        webAccessClose: '立即关闭网页管理',
        webAccessHint: '默认关闭；开启后 2 小时自动关闭，访问不会延长时间。关闭后公网不可访问，本机和局域网仍可访问；不影响手机 App。只可从本机 DSH 设置页开关。',
        webAccessUnavailable: '正在读取本机访问状态…',
        webAccessError: '更新网页访问状态失败',
      },
      en: {
        nav: 'Mobile',
        heading: 'Mobile',
        cardPanel: 'Configuration page',
        openPanel: 'Open the configuration page',
        openHint: 'Settings, pairing and plugin maintenance live on this page.',
        panelPending: 'Reading the page address…',
        panelMissing: 'The host has not reported a page address yet — reopen this item in a moment.',
        loadFailed: 'Failed to read host status',
        loadMissing: 'The plugin host half is not loaded: quit and reopen DSH; if that does not help, reinstall the plugin from the market.',
        webAccessOn: 'Public web management is open until',
        webAccessOff: 'Public web management is closed',
        webAccessOpen: 'Open web management for 2 hours',
        webAccessClose: 'Close web management now',
        webAccessHint: 'Closed by default; opening lasts 2 hours and visits do not extend it. When closed, public access is blocked while this machine and its LAN can still access the page. Mobile app access is unaffected. Only this local DSH settings page can toggle it.',
        webAccessUnavailable: 'Reading local access status…',
        webAccessError: 'Failed to update web access status',
      },
    };

    /* ── 设置项组件 ───────────────────────────────────────────────────────
     * 保持一个薄卡片：一个网页版入口，以及一个可信本机开关，控制网页管理是否短时向公网开放。
     * 界面本体仍在宿主吐出的 HTML（源码 `React/`，产物 `lib/panel/index.html`）。
     *
     * 本机设置项半边来自渲染器的 `node_modules`，不可热替换；插件更新仍走 DSH 市场。
     * 开关只影响控制面网页路由，不改移动 API、配对凭据或隧道状态。
     */
    function MobileSettingsSection({ t }) {
      /** null = 还没问到；'' = 问到了但这个宿主没给地址（老版本或还没起来）。 */
      const [panelUrl, setPanelUrl] = useState(null);
      const [error, setError] = useState(null);
      const [webAccess, setWebAccess] = useState(null);
      const [webAccessError, setWebAccessError] = useState(null);
      const [webAccessBusy, setWebAccessBusy] = useState(false);
      /** 最近一次失败的 HTTP 状态码（0 = 网络异常 / 还没失败过）。404 单独说。 */
      const [errorStatus, setErrorStatus] = useState(0);

      useEffect(() => {
        let alive = true;
        let retryTimer = null;
        let refreshTimer = null;
        const clearTimer = (timer) => {
          if (timer !== null) clearInterval(timer);
        };
        const load = async () => {
          try {
            const next = await call('/status');
            if (!alive) return;
            setError(null);
            setErrorStatus(0);
            setPanelUrl(typeof next.panelUrl === 'string' ? next.panelUrl : '');
            setWebAccess(next.webAccess && typeof next.webAccess.enabled === 'boolean' ? next.webAccess : null);
            if (retryTimer !== null) {
              clearTimer(retryTimer);
              retryTimer = null;
            }
            if (refreshTimer === null) {
              refreshTimer = setInterval(() => {
                if (typeof document !== 'undefined' && document.hidden) return;
                void load();
              }, 15000);
            }
          } catch (problem) {
            if (!alive) return;
            setError(String((problem && problem.message) || problem));
            setErrorStatus(Number(problem && problem.status) || 0);
            setWebAccess(null);
            if (refreshTimer !== null) {
              clearTimer(refreshTimer);
              refreshTimer = null;
            }
            // 无权的远程设置页不轮询；宿主还没启动等临时故障每 3s 重试。
            if (problem?.status !== 403 && problem?.status !== 423 && retryTimer === null) {
              retryTimer = setInterval(() => {
                if (typeof document !== 'undefined' && document.hidden) return;
                void load();
              }, 3000);
            }
          }
        };
        void load();
        return () => {
          alive = false;
          clearTimer(retryTimer);
          clearTimer(refreshTimer);
        };
      }, []);

      const toggleWebAccess = async () => {
        if (!webAccess || webAccessBusy) return;
        setWebAccessBusy(true);
        setWebAccessError(null);
        try {
          const next = await postJson('/web-access', { enabled: !webAccess.enabled });
          setWebAccess(next.webAccess && typeof next.webAccess.enabled === 'boolean' ? next.webAccess : null);
        } catch (problem) {
          setWebAccessError(String((problem && problem.message) || problem));
        } finally {
          setWebAccessBusy(false);
        }
      };

      const url = typeof panelUrl === 'string' ? panelUrl : '';
      const webAccessEnabled = Boolean(webAccess && webAccess.enabled);
      const expiresAt = webAccess && Number.isFinite(webAccess.expiresAt)
        ? new Date(webAccess.expiresAt).toLocaleTimeString()
        : '';
      let webAccessStatus = t('webAccessUnavailable');
      if (webAccess) webAccessStatus = webAccessEnabled ? `${t('webAccessOn')} ${expiresAt}` : t('webAccessOff');

      return h('div', { className: 'dshm_root' }, [
        h('h2', { className: 'dshm_heading' }, t('heading')),
        error
          ? h('p', { className: 'dshm_error' }, errorStatus === 404 ? t('loadMissing') : `${t('loadFailed')}: ${error}`)
          : null,

        // 用 `<a target="_blank">` 而不是 iframe：DSH 桌面端会把这个链接交给系统浏览器
        // 打开（网页版有自己的地址与刷新节奏，嵌在设置弹窗里反而不好用）。
        // href 必须是宿主给的绝对地址：相对地址在桌面端会被解析成 `dsh-app://`，
        // 而 Electron 只把 http(s) 交给浏览器，其它协议静默丢弃、点了没反应。
        h('section', { className: 'dshm_card', key: 'panel' }, [
          h('h3', { className: 'dshm_cardTitle' }, t('cardPanel')),
          h('div', { className: 'dshm_actions' }, [
            url
              ? h('a', {
                className: 'dshm_btn dshm_btnPrimary',
                href: url,
                target: '_blank',
                rel: 'noreferrer',
              }, t('openPanel'))
              : h('button', {
                type: 'button',
                className: 'dshm_btn',
                disabled: true,
              }, panelUrl === null ? t('panelPending') : t('panelMissing')),
          ]),
          h('p', { className: 'dshm_note' }, t('openHint')),
          h('p', { className: 'dshm_note' }, webAccessStatus),
          h('div', { className: 'dshm_actions' }, [
            h('button', {
              type: 'button',
              className: webAccessEnabled ? 'dshm_btn' : 'dshm_btn dshm_btnPrimary',
              disabled: !webAccess || webAccessBusy,
              onClick: toggleWebAccess,
            }, webAccessEnabled ? t('webAccessClose') : t('webAccessOpen')),
          ]),
          h('p', { className: 'dshm_note' }, t('webAccessHint')),
          webAccessError ? h('p', { className: 'dshm_error' }, `${t('webAccessError')}: ${webAccessError}`) : null,
        ]),
      ]);
    }

    /**
     * 客户端半边的自检上报：每 10s 把「这一半到底看见了什么」报给宿主。
     *
     * 为什么要它：宿主能数出「那半边没来敲门」（`/api/relay/status` 的 `desktopHalf`），
     * 但数不出「它为什么没来」。2026-10-10 那次故障里，正是这一点让「服务没拿到」和
     * 「服务拿到了但清理失败」两种可能耗掉了一整轮排查 —— 这条通路把答案直接摆出来：
     * 两条同步各自的 `ctx.inject` 到底有没有回调（`uiSession` / `sessions` 两格）、
     * `ctx.get` 能不能看见那两个服务、最后一次错在哪。
     *
     * 刻意**不**依赖任何客户端服务：探测全包在 try/catch 里，它自己要是也挂在服务上，
     * 就永远报不出「服务拿不到」这件事了。
     */
    function startClientHalfReport(ctx) {
      const probe = (name) => {
        if (typeof ctx.get !== 'function') return 'no-ctx.get';
        try {
          const value = ctx.get(name);
          if (!value) return String(value);
          if (name === 'sessions') return typeof value.retain === 'function' ? 'object:retain' : 'object:no-retain';
          return typeof value;
        } catch (error) {
          return `throw:${String((error && error.message) || error).slice(0, 80)}`;
        }
      };
      ctx.effect(() => {
        let disposed = false;
        const report = async () => {
          if (disposed) return;
          try {
            await postJson(CLIENT_HALF_ENDPOINT, {
              loaded: true,
              effectUiSession: halfState.uiSession,
              effectSessions: halfState.sessions,
              getUiSession: probe('uiSession'),
              getSessions: probe('sessions'),
              lastError: halfState.lastError,
            });
          } catch {
            // 宿主没起来：下一条再试。
          }
        };
        // 刻意不在挂载那一刻就报：它是周期自检，第一个采样点等一个间隔，
        // 免得给「页面刚打开时一个请求都不该发」这条既有契约添噪声。
        const timer = setInterval(() => {
          void report();
        }, CLIENT_HALF_REPORT_MS);
        return () => {
          disposed = true;
          clearInterval(timer);
        };
      }, 'mobile-plugin: 客户端半边自检上报');
    }

    return {
      // slots：注册设置项，由 @deepseek-ai/dsh-client-runtime 提供（它 require
      // dsh-client-ui-slots 的 SlotCore 再以 `super(ctx, "slots")` 暴露服务）。
      // locale：字典，由 @deepseek-ai/dsh-client-locale 提供。
      // 这两个服务名对应 package.json 里 dsh.client.inject 注入的两个包。
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT), 'mobile-plugin: settings dictionaries');
        const t = ctx.locale.bind(NS);
        startDesktopViewSync(ctx);
        captureSessions(ctx);
        startDesktopReadSync(ctx);
        startReadReceiptSync(ctx);
        startClientHalfReport(ctx);
        // 插槽是「先声明后注册」：宿主可能比我们晚一步声明 settings.section，
        // slots.inject 会等它就位再注册——已装的第三方插件（dsh-opencode-go）也是这么做的。
        // settings.section 是设置菜单里的顶层一项；settings.plugins.tab 是内置插件页里的页签，
        // 这一项原先挂在那里，后来按用户要求搬出来独立成一项。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'mobile',
          order: 20,
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ t }),
        }, MobileSettingsSection));
      },
    };
  },
});

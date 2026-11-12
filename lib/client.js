/**
 * dsh-mobile-plugin 的**客户端半边**（在 DSH 桌面 Web 页面里运行）。
 *
 * 五件事：桌面侧边栏的展开态与「读过了」报给宿主；手机端的已读回执应用回桌面绿点；
 * 设置里那一项「移动端」（一张薄卡，一颗「打开配置页面」）；在侧边栏最底下那一行挂一颗
 * 手机图标（点一下等于那张卡上的按钮）。方向是单向的（桌面 → 宿主 → 手机），手机上的
 * 折叠只存在 App 本地，不写回。
 *
 * 本文件不经任何构建（package.json 直接收录 lib 下的 .js），所以不能写 JSX，统一用
 * `React.createElement` 的别名 `h`；客户端插件按约定写成惰性工厂，定时器与页签在物化时才起。
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
     * 这一半有三样东西：设置里那一张薄卡、侧边栏那一颗图标（点它等于点那张卡上的按钮），
     * 以及打不开时那张诊断弹窗。界面本体在网页版里，那边自带一套样式。
     */
    const STYLE_ID = 'dsh-mobile-plugin/footer-icon.css';
    const CSS = `
.dshm_footAction{flex:none;width:28px;height:28px;margin:0 2px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;text-decoration:none}
.dshm_footAction:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshm_footAction:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.dshm_footAction[aria-disabled="true"]{opacity:.45;cursor:default}
.dshm_footAction[aria-disabled="true"]:hover{background:transparent;color:var(--dsw-alias-label-secondary)}
.dshm_footActionRail{width:36px;height:36px;margin:2px 0;border-radius:var(--dsw-radius-md)}
/* 宿主那一半没装载时：整颗转红，右上角那颗红点显出来（data-dshm-alert 是它的记号）。
   悬停不换回普通颜色——告警态跟着鼠标变浅等于这一颗在说谎。 */
.dshm_footAction[data-dshm-alert],.dshm_footAction[data-dshm-alert]:hover{color:var(--dsw-alias-state-error-primary)}
/* 中间那一档：确实有问题、但还没到「插件坏了」的程度（中转断着、旁挂进程没在跑、
   配了手机却一直没连上）。琥珀色 + 同一颗点，图形与尺寸一样不动。 */
.dshm_footAction[data-dshm-warn],.dshm_footAction[data-dshm-warn]:hover{color:var(--dsw-alias-state-warning-primary)}
.dshm_alertDot{display:none}
.dshm_footAction[data-dshm-alert] .dshm_alertDot,.dshm_footAction[data-dshm-warn] .dshm_alertDot{display:inline}
.dshm_overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.42)}
.dshm_dialog{box-sizing:border-box;width:100%;max-width:560px;max-height:82vh;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:18px 20px;border-radius:var(--dsw-radius-xl);border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-label-primary);box-shadow:0 12px 40px rgba(0,0,0,.28)}
/* 控制台那一窗比诊断窗宽：里面嵌的是一整页，窄了排版会挤成一列。 */
.dshm_dialogWide{max-width:1040px;height:82vh;max-height:82vh;overflow:hidden}
.dshm_dialogWide .dshm_frameWrap{flex:1;min-height:0;display:flex;position:relative}
.dshm_frame{flex:1;min-height:0;width:100%;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
/* iframe 一直不 load 时留的那句话：盖在空白之上，撤不撤由 onload 决定。 */
.dshm_frameTip{position:absolute;inset:auto 0 0;margin:0;padding:8px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
/* 版面竖向排列的那一列（外壳里没法内嵌时用它摆读数）。 */
.dshm_dialogColumn{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:10px}
.dshm_dialogTitle{margin:0;font-size:16px;font-weight:600;line-height:24px}
.dshm_dialogHeading{margin:2px 0 0;font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshm_dialogLead{margin:0;font-size:13px;line-height:20px}
.dshm_dialogNote{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshm_facts{margin:0;display:flex;flex-direction:column;gap:6px}
.dshm_fact{display:flex;gap:10px;align-items:baseline;font-size:12px;line-height:18px}
.dshm_factKey{flex:none;min-width:84px;color:var(--dsw-alias-label-tertiary)}
.dshm_factValue{margin:0;min-width:0;word-break:break-all}
.dshm_factMono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.dshm_steps{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:18px}
.dshm_dialogActions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:2px}
.dshm_root{display:flex;flex-direction:column;gap:14px;width:100%;max-width:760px;color:var(--dsw-alias-label-primary)}
.dshm_card{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);display:flex;flex-direction:column;gap:10px;padding:14px 16px}
.dshm_heading{font-size:18px;font-weight:600;margin:0}
.dshm_cardTitle{font-size:14px;font-weight:600;line-height:20px;margin:0}
.dshm_actions{display:flex;flex-wrap:wrap;gap:8px}
.dshm_note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshm_error{margin:0;border-radius:var(--dsw-radius-md);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;padding:8px 10px}
.dshm_btn{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px;line-height:18px;padding:5px 12px;display:inline-flex;align-items:center;gap:6px;text-decoration:none}
.dshm_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshm_btn:disabled{cursor:default;opacity:.45}
.dshm_btnPrimary{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:var(--dsw-alias-bg-layer-1)}
`;
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) === null) {
      const tag = document.createElement('style');
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ── 一：控制面调用 ─────────────────────────────────────────────────────
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
     * 控制面调用。`path` 既接受 `/xxx` 这样的短路径，也接受已经带 `/api/relay` 的全路径，
     * 几种都折成文档相对地址。
     *
     * 必须两种都认：绿点那两条同步传进来的本来就是全路径，无条件拼前缀会发到
     * `/api/relay/api/relay/...` 这个不存在的地址，而调用方的 catch 会把它静静吞掉。
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

    /**
     * 打开那两小时网页管理窗口。
     *
     * 只有「浏览器不是从这台机器上打开的」才需要它：控制面不认它，面板会回 423。设置卡与
     * 侧边栏图标都走这一份实现 —— 各写一遍迟早会在「窗口开着没有」上判得不一样，而这两种
     * 判法对应的是「多开一次」与「跳过去吃一个 423」。
     *
     * 返回值是宿主回的新窗口状态，交给调用方存进自己的 state。
     */
    async function requestAccessWindow() {
      const next = await postJson('/web-access', { enabled: true });
      return next && next.webAccess && typeof next.webAccess.enabled === 'boolean'
        ? next.webAccess
        : { enabled: true, expiresAt: 0 };
    }

    /* ── 三：侧边栏未读绿点的双向同步 ───────────────────────────────────────
     * 两端的绿点是两份互不相干的状态：
     *   - 手机端 = 宿主按设备维度维护的完成提醒（lib/mobile/completion.js），
     *     由 `POST /api/mobile/v1/session/read` 清掉；
     *   - 桌面端 = 渲染进程内存里的 `UiSession.completionUnread`，既不落盘也不过服务端。
     * 两边各缺一块，所以两个方向都要这一半补。
     *
     * 两条同步都依赖桌面端的服务（uiSession / sessions），拿不到就整条不启动：注册了
     * 也只是空转的定时器。服务可能比我们晚就位，所以每个 tick 现取一次。
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
     * 宿主半边的自检口（由**外壳**注册，实现挂了它也还在）。
     *
     * 实现装载失败时整张 `/api/relay/*` 都 404，而「它为什么没起来」只有外壳答得出来
     * （它自己活得好好的是刻意的故障边界）。诊断弹窗靠这两条把原因、版本、后台重试
     * 如实摆出来，并提供「重新装载」——那是唯一不必重启整个 DSH 的出路。
     */
    const HOST_HALF_ENDPOINT = '/api/relay/host-half';
    const HOST_HALF_RELOAD_ENDPOINT = '/api/relay/host-half/reload';

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
     * 三种情形算「桌面读过了」，每种只报一次：看见它从未读里掉出去、此刻正开在主视图里
     * （`retainedBy.mainView > 0`）、或本次页面里它变过且现在不是未读。
     *
     * 首帧一条都不报：页面刚加载时 `sessionStatus` 里全是 `completionUnread: false`，
     * 照单全收会把手机上真未读的全灭掉。所以要求 `updatedAt > 页面打开时刻`。
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
     * 必须用 `ctx.inject([...], child => …)`，不能用 `ctx.get(name)`：`ctx.get` 是绕过注入
     * 直接取，在客户端运行时里取不到这两个服务，两条绿点同步会一条都不跑。拿不到就一个
     * 定时器都不起，由自检上报把「到底看见了什么」说给宿主听。
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
     * `sessions.retain(id, { source: 'mainView' })` + 同 tick `release()`：`retain` 会同步
     * 抬 `retainedBy.mainView`，桌面自己的 `reconcileStatus()` 因此摘掉绿点，而 release
     * 把引用数降回 0 也不会把它加回来。同一个 tick 内完成，React 还没重渲染，看不到抖动。
     *
     * 还要跟 `updatedAt` 比一次：台账不记「读完之后又跑完了一轮」，重新打开页面时会把
     * 旧回执重新应用，灭掉本该亮的绿点。最后活动时间晚于已读水位就跳过。
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
        openHint: '配对、网络配置与插件更新都在这个页面里。',
        panelPending: '正在读取页面地址…',
        panelMissing: '宿主还没给出页面地址，稍后再打开这一页试试。',
        loadFailed: '读取宿主状态失败',
        openFailed: '打开配置页面失败',
        footerOpen: '打开移动端插件配置网页',
        footerPending: '网页地址还没就绪',
        footerNoDevice: '还没配对过手机',
        footerDeviceCount: '{count} 台设备',
        footerDeviceSeen: '{count} 台设备 · {ago}连过',
        footerTunnelBad: '中转没有连上',
        footerSidecarBad: '旁挂进程报错',
        footerAgoNow: '刚刚',
        footerAgoMinutes: '{count} 分钟前',
        footerAgoHours: '{count} 小时前',
        footerAgoDays: '{count} 天前',
        footerPublicConfirm: '这个地址位于公网。继续后会开放移动端插件的网页管理权限 2 小时；期间任何能访问该地址的人都可以操作面板。是否继续？',
        footerLoadMissing: '插件宿主侧没有加载：把 DSH 完整退出再打开一次；还不行就在插件市场重装一遍插件。',
        consoleTitle: '移动端插件控制台',
        consoleTroubleshoot: '报错调试',
        consolePopupBlocked: '浏览器拦掉了新窗口，允许本站弹出窗口后再点一次。',
        consoleOpenBrowser: '在浏览器里打开',
        consoleFrameless: '这一屏没载入进来（桌面壳或代理挡住了内嵌页面）。点下面那颗按钮在浏览器里打开，读数一样看得到。',
        diagTitleLoad: '打不开移动端配置页',
        diagTitleOpen: '开放网页管理失败',
        diagChecking: '正在读取宿主状态…',
        diagBusy: '正在重读状态…',
        diagHeadingFacts: '诊断读数（可直接复制发给维护者）',
        diagHeadingSteps: '你可以自己先试这几步',
        diagClose: '关闭',
        diagRetry: '重新读取状态',
        diagReload: '重新装载插件',
        diagReloadBusy: '正在让宿主重新装载…',
        diagReloadOk: '重新装载成功，控制面已经回来了。',
        diagReloadFailed: '重新装载没成：',
        diagCopy: '复制诊断信息',
        diagCopied: '诊断信息已复制，可以直接发给维护者。',
        diagCopyFailed: '复制失败：请手动选中上面的读数再复制。',
        diagOpenPanel: '打开配置页面',
        diagSummaryLoadMissing: '插件宿主侧没有加载：DSH 外壳在跑，插件本体没装起来（最常见的原因是装完没重启）。',
        diagSummaryUnreachable: '宿主没有回应状态查询，这一版插件可能还没带自检口。',
        diagSummaryNoError: '宿主自检说没报错，控制面路由却不在：多半是同一份 DSH 里跑着两份插件。',
        diagSummaryLoadFailed: '读取宿主状态失败。',
        diagSummaryOpenFailed: '两小时网页管理窗口没能打开，所以没有跳转。',
        diagPopupBlocked: '网页管理已经开好了，但浏览器拦掉了这个新窗口。允许本站打开弹窗后再点一次图标。',
        diagSummaryRestored: '状态已经读到了，可以再点一次图标。',
        diagStepRestart: '把 DSH 完整退出（不是只关窗口）再打开一次——装完插件没重启是最常见的原因。',
        diagStepReinstall: '还不行就在插件市场把这个插件重装一遍，装完再完整重启一次 DSH。',
        diagStepRetrying: '宿主还在后台自己重试，等几分钟再点一次图标，不必重装。',
        diagStepDuplicate: '确认没装两份（市场一份、本地目录一份）：页面会连到装不上的那一份。',
        diagStepProxy: '如果 DSH 挂在反向代理的子路径下（如 /dsh/），确认代理保留了 Host、Origin 与 X-Forwarded-Proto。',
        diagStepRetryOpen: '先点「重新读取状态」再试一次；刚重启过的 DSH 头几秒常常还没就绪。',
        diagFactReturned: '宿主返回',
        diagFactStatus: 'HTTP 状态',
        diagFactSelfcheck: '宿主自检',
        diagFactUnavailable: '没有回应（这一版可能还没带它）',
        diagFactPlugin: '插件版本',
        diagFactSource: '来源',
        diagFactActivated: '装载时刻',
        diagFactRetry: '后台重试',
        diagFactOnDisk: '盘上版本',
        diagFactShell: '外壳已改',
        diagFactReason: '宿主侧原因',
        diagFactPanelUrl: '面板地址',
        diagFactScope: '地址类别',
        diagFactWindow: '两小时窗口',
      },
      en: {
        nav: 'Mobile',
        heading: 'Mobile',
        cardPanel: 'Configuration page',
        openPanel: 'Open the configuration page',
        openHint: 'Pairing, network settings and plugin updates all live on this page.',
        panelPending: 'Reading the page address…',
        panelMissing: 'The host has not reported a page address yet — reopen this item in a moment.',
        loadFailed: 'Failed to read host status',
        openFailed: 'Could not open the configuration page',
        footerOpen: 'Open the mobile plugin configuration page',
        footerPending: 'The page address is not ready yet',
        footerNoDevice: 'No phone paired yet',
        footerDeviceCount: '{count} devices',
        footerDeviceSeen: '{count} devices · last seen {ago}',
        footerTunnelBad: 'Relay is not connected',
        footerSidecarBad: 'The sidecar reports an error',
        footerAgoNow: 'just now',
        footerAgoMinutes: '{count} min ago',
        footerAgoHours: '{count} h ago',
        footerAgoDays: '{count} d ago',
        footerPublicConfirm: 'This address is public. Continuing opens mobile plugin web management for 2 hours; anyone who can reach this address can operate the panel during that time. Continue?',
        footerLoadMissing: 'The plugin host half is not loaded: quit and reopen DSH; if that does not help, reinstall the plugin from the market.',
        consoleTitle: 'Mobile plugin console',
        consoleTroubleshoot: 'Troubleshoot',
        consolePopupBlocked: 'The browser blocked the new window — allow pop-ups for this site and press again.',
        consoleOpenBrowser: 'Open in a browser',
        consoleFrameless: 'This panel did not load (the desktop shell or a proxy blocked the embedded page). Use the button below to open it in a browser — the readings are the same.',
        diagTitleLoad: 'Cannot open the mobile configuration page',
        diagTitleOpen: 'Could not open web management',
        diagChecking: 'Reading host status…',
        diagBusy: 'Reading host status again…',
        diagHeadingFacts: 'Diagnostics (copy and send these to the maintainer)',
        diagHeadingSteps: 'Things you can check yourself',
        diagClose: 'Close',
        diagRetry: 'Read status again',
        diagReload: 'Reload the plugin',
        diagReloadBusy: 'Asking the host to reload…',
        diagReloadOk: 'Reloaded — the control plane is back.',
        diagReloadFailed: 'Reload failed: ',
        diagCopy: 'Copy diagnostics',
        diagCopied: 'Diagnostics copied — you can send them to the maintainer.',
        diagCopyFailed: 'Copy failed: select the readings above and copy them manually.',
        diagOpenPanel: 'Open the configuration page',
        diagSummaryLoadMissing: 'The plugin host half is not loaded: the DSH shell runs, the plugin itself does not (usually because DSH was not restarted after installing).',
        diagSummaryUnreachable: 'The host did not answer the status query; this plugin build may not ship the self-check route yet.',
        diagSummaryNoError: 'The host self-check reports no error, yet the control-plane routes are missing: most likely two copies of the plugin in one DSH.',
        diagSummaryLoadFailed: 'Reading the host status failed.',
        diagSummaryOpenFailed: 'The two-hour web management window could not be opened, so nothing was opened.',
        diagPopupBlocked: 'Web management is open, but the browser blocked the new window. Allow pop-ups for this site, then press the icon again.',
        diagSummaryRestored: 'Status is readable again — try the icon once more.',
        diagStepRestart: 'Quit DSH completely (not just the window) and open it again — not restarting after installing is the most common cause.',
        diagStepReinstall: 'If that does not help, reinstall the plugin from the market, then restart DSH completely.',
        diagStepRetrying: 'The host is still retrying on its own; wait a few minutes and press the icon again — no need to reinstall.',
        diagStepDuplicate: 'Make sure only one copy is installed (market copy plus a local directory copy): the page connects to the one that failed to load.',
        diagStepProxy: 'If DSH sits under a reverse-proxy subpath (e.g. /dsh/), make sure the proxy keeps Host, Origin and X-Forwarded-Proto.',
        diagStepRetryOpen: 'Press "Read status again" and retry; a DSH that just restarted often needs a few seconds.',
        diagFactReturned: 'Host returned',
        diagFactStatus: 'HTTP status',
        diagFactSelfcheck: 'Host self-check',
        diagFactUnavailable: 'no answer (this build may not ship it)',
        diagFactPlugin: 'Plugin version',
        diagFactSource: 'Source',
        diagFactActivated: 'Activated at',
        diagFactRetry: 'Background retries',
        diagFactOnDisk: 'On disk',
        diagFactShell: 'Shell changed',
        diagFactReason: 'Host-side reason',
        diagFactPanelUrl: 'Panel URL',
        diagFactScope: 'Address class',
        diagFactWindow: 'Two-hour window',
      },
    };

    /* ── 诊断弹窗 ──────────────────────────────────────────────────────────
     * 点这颗图标打不开配置页、或者开窗口失败时，不能只让用户「点了没反应」。
     *
     * 这一屏刻意做成**能自己动手的自查**，而不是一句报错：
     *   - 先把「谁说了什么」摆出来（宿主返回的原文 + 外壳自检那份快照）；
     *   - 再给一串用户自己就能做的检查与修复（重启、重装、确认没装两份、反代前缀）；
     *   - 能一键解决的直接给按钮（重新装载实现、重读状态、地址就绪时打开面板）；
     *   - 最后给「复制诊断信息」：一段 ASCII 记号，贴给维护者就能对着日志查，
     *     不必让人先截图、再问、再等回复。
     *
     * 纯 DOM：客户端半边不经构建，用不了 react 的 portal。所有文字一律走 `textContent`
     * —— 宿主原话里可能有尖括号，拼 HTML 就是把别人的报错当代码执行。
     */

    /** 诊断弹窗的记号：同一页面只留一份。 */
    const DIAG_MARK = 'data-dshm-mobile-diag';

    /**
     * 造一个可以反复更新的诊断弹窗（`open(model)` 打开或就地重画，`hide()` 收起）。
     *
     * 内容由调用方按这一轮的现场拼好交进来；这里只管画与收，不做任何请求。
     */
    function createDiagnosisDialog(doc) {
      let overlay = null;
      /** 底下那一句说明（复制结果就地改它，不重画整窗）。 */
      let noteEl = null;
      let escapeListener = null;
      const hide = () => {
        if (overlay && typeof overlay.remove === 'function' && overlay.parentElement) overlay.remove();
        overlay = null;
        noteEl = null;
        if (escapeListener && typeof doc.removeEventListener === 'function') {
          doc.removeEventListener('keydown', escapeListener);
        }
        escapeListener = null;
      };
      const make = (tag, className, text) => {
        const element = doc.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = String(text);
        return element;
      };
      const open = (model) => {
        if (!doc || typeof doc.createElement !== 'function' || !doc.body) return null;
        const spec = model && typeof model === 'object' ? model : {};
        if (!overlay) {
          overlay = make('div', 'dshm_overlay');
          overlay.setAttribute(DIAG_MARK, '');
          overlay.setAttribute('role', 'dialog');
          overlay.setAttribute('aria-modal', 'true');
          // 点遮罩收起；卡片内部的点击不冒到遮罩上（免得点按钮被当成「点外面」）。
          overlay.addEventListener('click', (event) => {
            if (event && event.target === overlay) hide();
          });
          doc.body.appendChild(overlay);
          if (typeof doc.addEventListener === 'function') {
            escapeListener = (event) => {
              if (event && (event.key === 'Escape' || event.key === 'Esc')) hide();
            };
            doc.addEventListener('keydown', escapeListener);
          }
        }
        if (spec.title) overlay.setAttribute('aria-label', spec.title);
        // 每次重画：读数与按钮都是这一轮的现场，别留上一轮的字。
        // **`children` 是 HTMLCollection，没有 `slice()`**（假元素是数组，测试覆盖不到）；
        // 先摊成数组再边删边走。
        for (const child of Array.from(overlay.children || [])) child.remove();
        const card = spec.wide
          ? make('div', 'dshm_dialog dshm_dialogWide')
          : make('div', 'dshm_dialog');
        card.addEventListener('click', (event) => {
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        });
        overlay.appendChild(card);
        if (spec.title) card.appendChild(make('h3', 'dshm_dialogTitle', spec.title));
        if (spec.summary) card.appendChild(make('p', 'dshm_dialogLead', spec.summary));
        // 自定义内容区（入口那两块就挂在这儿）：节点由调用方造，这里只负责挂上。
        if (spec.body) card.appendChild(spec.body);
        // 内嵌一整页（调试那一窗）：外壳里 `window.open` 不可靠，所以把页面嵌进来。
        // `src` 已经由调用方按同源地址算好（壳里是 `dsh-app://app/api/relay/panel/debug`，
        // 网页里是同源 http），远程浏览器的那两小时窗口也在拨号那一步开好了。
        //
        // **嵌不进来要有话说**：iframe 被挡（CSP、代理、协议处理器不认这条路径）时它只会
        // 静默留白，用户看到一屏空。所以先摆一句「正在载入」，`onload` 一到就撤掉；一直不
        // load 就一直是那句话 + 底下那颗「在浏览器里打开」——不至于「点了没反应」。
        if (spec.frame && spec.frame.src) {
          const wrap = make('div', 'dshm_frameWrap');
          const frame = doc.createElement('iframe');
          frame.className = 'dshm_frame';
          frame.setAttribute('src', spec.frame.src);
          frame.setAttribute('title', spec.frame.title || spec.title || '');
          frame.setAttribute('loading', 'eager');
          const tip = make('p', 'dshm_frameTip', spec.frame.hint || '');
          frame.onload = () => {
            if (tip && typeof tip.remove === 'function' && tip.parentElement) tip.remove();
          };
          wrap.appendChild(frame);
          wrap.appendChild(tip);
          card.appendChild(wrap);
        }
        if (spec.facts && spec.facts.length) {
          if (spec.factsHeading) card.appendChild(make('h4', 'dshm_dialogHeading', spec.factsHeading));
          const list = make('dl', 'dshm_facts');
          for (const fact of spec.facts) {
            const row = make('div', 'dshm_fact');
            row.appendChild(make('dt', 'dshm_factKey', fact.label));
            row.appendChild(make('dd', fact.mono === false ? 'dshm_factValue' : 'dshm_factValue dshm_factMono', fact.value));
            list.appendChild(row);
          }
          card.appendChild(list);
        }
        if (spec.steps && spec.steps.length) {
          if (spec.stepsHeading) card.appendChild(make('h4', 'dshm_dialogHeading', spec.stepsHeading));
          const steps = make('ol', 'dshm_steps');
          for (const step of spec.steps) steps.appendChild(make('li', null, step));
          card.appendChild(steps);
        }
        // 这一行**总是挂上**（空着不占位）：控制台那一窗的「复制」要就地改这一句，
        // 重画整窗会把嵌进去的页面重新加载一遍。
        const note = make('p', 'dshm_dialogNote', spec.note || '');
        card.appendChild(note);
        const actions = make('div', 'dshm_dialogActions');
        for (const action of spec.actions || []) {
          const button = make('button', action.primary ? 'dshm_btn dshm_btnPrimary' : 'dshm_btn', action.label);
          button.setAttribute('type', 'button');
          if (action.disabled) button.disabled = true;
          button.onclick = () => { void action.onClick(); };
          actions.appendChild(button);
        }
        card.appendChild(actions);
        noteEl = note;
        return overlay;
      };
      /** 就地更新底下那一句说明（不重画整窗）。 */
      const note = (text) => {
        if (noteEl) noteEl.textContent = text === undefined ? '' : String(text);
      };
      return { open, hide, note };
    }

    /** 复制一段文字：先走剪贴板 API，不行退回 textarea + execCommand。 */
    async function copyDiagnosisText(doc, text) {
      try {
        if (typeof navigator !== 'undefined'
          && navigator.clipboard
          && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        // 落到下面那一条：有的环境里剪贴板权限被拒。
      }
      try {
        const area = doc.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        doc.body.appendChild(area);
        if (typeof area.select === 'function') area.select();
        const done = typeof doc.execCommand === 'function' ? doc.execCommand('copy') : false;
        if (typeof area.remove === 'function') area.remove();
        return done === true;
      } catch {
        return false;
      }
    }

    /**
     * 当前页面是不是一张**普通网页**（`http(s)`）。
     *
     * 桌面壳把前端挂在 `dsh-app://app/` 下，那一层里 `window.open` 一律被拒 —— 壳只把
     * `http(s)` 地址交给系统浏览器，别的一概静默丢掉。所以「先开一个空窗口、等地址确认
     * 再导航过去」那套在壳里既开不出窗口、还会把整个页面盖成一块黑：那颗图标点下去按
     * 网络类别分流时，得先分清自己在哪种页面里。
     *
     * 不在网页里（自定义协议）就走**导航**：壳的 `will-navigate` 会把外部 http(s) 地址
     * 转给系统浏览器，与点一颗普通链接的结果一样，只是不必先开一个空窗口。
     */
    function isWebPage(win) {
      const protocol = String((win && win.location && win.location.protocol) || '');
      return protocol === 'http:' || protocol === 'https:';
    }

    /** 把一份 `/status` 返回收成拨号要用的几样；缺的当没有。 */
    function readStatusView(view) {
      const value = view && typeof view === 'object' ? view : {};
      return {
        panelUrl: typeof value.panelUrl === 'string' ? value.panelUrl : '',
        panelScope: typeof value.panelScope === 'string' ? value.panelScope : '',
        webAccess: value.webAccess && typeof value.webAccess.enabled === 'boolean' ? value.webAccess : null,
        // 图标与入口那一句要用的现场：配了几台手机、链路有没有断。与上面三样同一条 `/status`，
        // 不多打一次接口 —— 那份读数本来就是「此刻这台宿主怎么样」。
        devices: value.devices && typeof value.devices === 'object' ? value.devices : null,
        fault: faultKeyOf(value),
      };
    }

    /**
     * 「链路有没有毛病」：只有明确报错的才算，拿不准的一律当正常。
     *
     * 只认两条实打实的失败：隧道 `state === 'error'`（中转连不上 / 被准入拒了）与旁挂进程
     * 报错（`error: …`）。`starting` / `off` / 没开中转 都是正常态 —— 把「还没起来」也报成
     * 黄点，等于每次启动都先闪一下假警。判据比调试页那套窄：那一页是给人排查用的，宁可多说；
     * 这一颗常驻在侧边栏，只该在「现在确实坏了」的时候变脸。
     */
    function faultKeyOf(view) {
      const value = view && typeof view === 'object' ? view : {};
      const tunnel = value.tunnel && typeof value.tunnel === 'object' ? value.tunnel : {};
      if (value.enabled && tunnel.state === 'error') return 'footerTunnelBad';
      const sidecar = value.sidecar && typeof value.sidecar === 'object' ? value.sidecar : {};
      if (typeof sidecar.state === 'string' && sidecar.state.startsWith('error')) return 'footerSidecarBad';
      return '';
    }

    /**
     * 配置页在**这个页面自己**的同源地址上。
     *
     * 宿主的 `panelUrl` 是按请求的 Host 头拼的，反代把 DSH 挂在子路径（`/dsh/`）下时那条会
     * 丢掉前缀、Host 被改写时还会指到内网去；而页面自己的 `<base href="./">` 一定是带前缀、
     * 也一定是用户浏览器真能到的那一层。所以拿不到宿主地址时按这个推，推不出来就算了。
     */
    function sameOriginPanelUrl() {
      try {
        const base = typeof document !== 'undefined' && document.baseURI
          ? document.baseURI
          : (typeof location !== 'undefined' ? location.href : '');
        if (!base) return '';
        return new URL('api/relay/panel', base).href;
      } catch {
        return '';
      }
    }

    /**
     * 面板里的某一页在**这个页面自己**的同源地址上（不是宿主报的那个绝对地址）。
     *
     * 这里必须按 `document.baseURI` 推，**不能用面板那个绝对 http(s) 地址**：桌面版前端挂在
     * `dsh-app://app/` 下（Electron 把 `dsh-app` 当安全协议），往里面塞一条 http 的 iframe
     * 会被当成混合内容挡掉 —— 现场就是 `isWebPage()` 为假、退回「交给系统浏览器」，点了照旧跳走。
     * 用相对地址推出来的是 `dsh-app://app/api/relay/panel/console`：与页面同源，壳的协议处理器
     * 会把 `/api/*` 转给本机宿主（客户端半边那些 `api/relay/status` 请求一直就是这么走的）。
     * 反代挂子路径时 `baseURI` 自带前缀，这一条也顺带管住了。
     *
     * **2026-11-13 起地址只认这一条**：云服务器上用户是用公网 IP / 域名打开 DSH 的，而宿主
     * 按 Host 头拼出来的 `panelUrl` 常常是 `127.0.0.1:<端口>` —— 拿它去开窗，浏览器就跑到
     * 用户自己那台电脑上找服务，必然打不开。`baseURI` 是**用户此刻正在用的地址**，公网打开
     * 就是公网、反代子路径自带前缀，这才是对的。`panel` 只用来决定「要不要开两小时窗口」，
     * 不再决定「开到哪儿去」。
     */
    function panelPageUrlOf(page) {
      try {
        const base = typeof document !== 'undefined' && document.baseURI
          ? document.baseURI
          : (typeof location !== 'undefined' ? location.href : '');
        if (!base) return '';
        return new URL(`api/relay/panel${page ? `/${page}` : ''}`, base).href;
      } catch {
        return '';
      }
    }

    /**
     * 一次「打开配置页面」的完整拨号：取地址、必要时开两小时窗口、把地址交出去。
     *
     * 为什么不能只读一次 `/status`：那条接口自己也在窗口门后面（`WEB_ACCESS_ROUTES`），
     * 窗口关着时**不是本机**的浏览器只拿得到 423。而客户端原先规定「没地址就不去开窗口」，
     * 两边互相锁死 —— 远程用户点了只会看到「网页地址还没就绪」，没有任何顺序能走通。
     * 所以读不到地址时正确的动作不是放弃，而是**先开窗**：
     * 那条开关接口本来就对同源页面豁免，开完再读一次，地址与类别就都有了。
     *
     * 地址优先用宿主给的 `panelUrl`，拿不到再用页面自己的同源地址（见 `sameOriginPanelUrl`）。
     *
     * 新窗口必须由调用方在**点击那一帧**开出来（`window.open('')`），这里只负责导航它；
     * 等接口回来再开会被弹窗拦截器吃掉。`confirmed` = 调用方已经问过公网那句确认（问过的
     * 不再问第二遍；地址是自救拿到的，类别此前不知道，所以在这里补问）。
     *
     * @returns {Promise<{ok: true, cancelled?: boolean, url: string, webAccess: object|null}
     *   | {ok: false, missing: boolean, status: number, message: string}>}
     */
    async function openConfigurationPage({ view, loadStatus = 0, t, target = null, confirmed = false, navigate = true }) {
      let state = readStatusView(view);
      const failed = (error) => ({
        ok: false,
        missing: false,
        status: Number(error && error.status) || 0,
        message: String((error && error.message) || error),
      });

      if (!state.panelUrl) {
        // 404 = 宿主那一半没装载，开窗也救不了：交给调用方按「装完没重启」报。
        if (loadStatus === 404) return { ok: false, missing: true, status: 404, message: '' };
        // 先补读一次：可能只是页面上那一次读取还没回来，或者刚才网络抖了一下。
        try {
          state = readStatusView(await call('/status'));
        } catch (error) {
          if ((Number(error && error.status) || 0) === 404) {
            return { ok: false, missing: true, status: 404, message: '' };
          }
          // 读不到多半是被窗口门挡住（423）：先开窗再读一次。这是远程用户唯一能走通的顺序，
          // 也正因为原先把这一步排在了「拿到地址之后」，两个条件互等，谁都过不去。
          try {
            const opened = await requestAccessWindow();
            state = { ...readStatusView(await call('/status')), webAccess: opened };
          } catch (inner) {
            return failed(inner);
          }
        }
        if (!state.panelUrl) {
          return { ok: false, missing: false, status: 0, message: t('panelMissing') };
        }
      }

      const url = state.panelUrl || sameOriginPanelUrl();
      if (!url) return { ok: false, missing: false, status: 0, message: t('panelMissing') };

      if (state.panelScope === 'public'
        && !confirmed
        && typeof window !== 'undefined'
        && typeof window.confirm === 'function'
        && !window.confirm(t('footerPublicConfirm'))) {
        return { ok: true, cancelled: true, url, webAccess: state.webAccess };
      }

      if (state.panelScope !== 'loopback' && !(state.webAccess && state.webAccess.enabled)) {
        try {
          state.webAccess = await requestAccessWindow();
        } catch (error) {
          return failed(error);
        }
      }

      if (target) {
        target.location.href = url;
        return { ok: true, url, webAccess: state.webAccess };
      }
      // `navigate: false` = 只要地址与「控制面已经认这个浏览器」，别开任何窗口：
      // 控制台那一窗是把这一页**嵌进来**，多开一个浏览器窗口等于点了就跳走。
      if (navigate === false) return { ok: true, url, webAccess: state.webAccess };
      if (!isWebPage(window)) {
        // 交回给页面导航：壳会把外部 http(s) 地址转给系统浏览器。
        window.location.href = url;
        return { ok: true, url, webAccess: state.webAccess };
      }
      const opened = typeof window.open === 'function' ? window.open(url, '_blank', 'noreferrer') : null;
      if (!opened) return { ok: false, missing: false, status: 0, message: t('diagPopupBlocked') };
      return { ok: true, url, webAccess: state.webAccess };
    }

    /* ── 侧边栏底部那颗手机图标 ────────────────────────────────────────────
     * 用户要的是「点一下等于设置页那颗『打开配置页面』」，并且就在侧边栏最底下、头像
     * 那一行里。外壳那一行没有给插件留座位：那一行里从左到右是设置项自己渲染的一整颗
     * 按钮（弹性铺满）、连接状态提示、桌面更新提示。所以这里是往那一行里插一颗自己的
     * 按钮，而不是换成外壳的某一个座位：
     *
     *   - 认位置靠插槽出口的 `data-slot` 标记（外壳给每个出口都留了这个标记，它比哈希
     *     类名稳，也不依赖行里有什么），拿到它的父节点就是整行；
     *   - 那一行的按钮是 `flex:1`，插进去之后它自己让出宽度，谁都不会被盖住；
     *   - 认不出来（外壳换了版式、设置项还没挂上）就退回 `sidebar.footer.action` 给插件
     *     留的那一行，入口不会消失；
     *   - 外壳把这一行整棵重建时（宽窄切换、账户菜单重挂、提示挂上摘下）元素会掉线，
     *     所以挂上之后盯一次 DOM 变更，掉线就补回去。
     *
     * 这一颗是纯 DOM：客户端半边不经构建，用不了 `react-dom` 的 portal。地址、文案、
     * 可用状态都由 effect 直接同步到元素属性上，组件重渲染不会把它丢掉。
     */
    /** 外壳在设置那一行上方留的动作位；没有别的插件占用时是空的。 */
    const FOOTER_SLOT = 'sidebar.footer.action';
    /** 设置那一行里「头像那块」的出口标记。 */
    const FOOTER_ANCHOR = '[data-slot="settings.launcher"]';
    /** 侧栏底部那个座位（头像那一行在它里面）。插之前先确认出口真的在这个座位里。 */
    const FOOTER_SEAT = '[data-slot="sidebar.settings"]';
    /** 自己那颗按钮的记号：同一页面里出现第二份实现时，靠它摘掉上一颗。 */
    const FOOTER_MARK = 'data-dshm-mobile-web';
    /** 告警态的记号：宿主那一半没装载（`/status` 404）时，整颗转红并显出右上角那颗红点。 */
    const FOOTER_ALERT = 'data-dshm-alert';
    /** 中间那一档：确实有问题但还没到「插件坏了」。同一颗点，颜色换琥珀。 */
    const FOOTER_WARN = 'data-dshm-warn';
    /** 还没问到网页地址时的重试间隔。取到就停，不再问。 */
    const FOOTER_URL_RETRY_MS = 20000;
    /**
     * 手机图标（「刘海 + 底条」那一款）：24 画布描边，
     * 机身 6.2→17.8、圆角 2.8，顶上一条刘海、底下一条家条。比早先那版机身更满一点，
     * 因为窄高的形状按名义尺寸画出来会比旁边的方形图标显小。
     */
    const PHONE_PATHS = [
      'M9 2.6h6A2.8 2.8 0 0 1 17.8 5.4v13.2a2.8 2.8 0 0 1-2.8 2.8H9a2.8 2.8 0 0 1-2.8-2.8V5.4A2.8 2.8 0 0 1 9 2.6Z',
      'M10.4 4.4h3.2',
      'M11 19.4h2',
    ];
    /**
     * 告警态那颗红点（「整颗转红 + 右上角一颗点」那一款）。
     *
     * 圆心在机身右上角外侧：左缘压住右上那圈圆角（机身右边到 17.8），两块同色连成一整块，
     * 所以不用再抠一圈背景色的缝隙。24 画布内放得下——最右到 22，不越界。
     * 它常驻在 SVG 里，显示与否交给 CSS 的 `data-dshm-alert`：这一颗会被外壳整棵重建，
     * 换来换去不如让它挂着。
     */
    const PHONE_ALERT_DOT = { cx: 18.9, cy: 5, r: 3.1 };
    /**
     * 图标边长：展开那一行 20，窄条里的圆钮 22。
     *
     * 那一行的账号按钮高 44、里面真正画出来的只有 24 的头像，同行其它图标是 16。20 是
     * 28 的按钮里还能四边各留 4 像素的上限；窄条那颗放进 36 的圆钮里，用 22。
     * 别再往回调 16 / 18：手机图形窄，按名义尺寸画出来比同行的方形图标显小。
     * 真要再大，得连按钮一起撑到 30 以上——那一行其它按钮都是 28，会开始抢。
     */
    const PHONE_GLYPH_WIDE = 20;
    const PHONE_GLYPH_RAIL = 22;

    /** 造一颗手机图标（含那颗常驻的告警红点，显不显示看 `data-dshm-alert`）。文档没有 SVG 能力时返回 null，按钮照样成立（只剩无障碍名字）。 */
    function phoneIcon(doc, size) {
      if (!doc || typeof doc.createElementNS !== 'function') return null;
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', String(size));
      svg.setAttribute('height', String(size));
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.7');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      for (const d of PHONE_PATHS) {
        const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
      }
      const dot = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('class', 'dshm_alertDot');
      dot.setAttribute('cx', String(PHONE_ALERT_DOT.cx));
      dot.setAttribute('cy', String(PHONE_ALERT_DOT.cy));
      dot.setAttribute('r', String(PHONE_ALERT_DOT.r));
      dot.setAttribute('fill', 'currentColor');
      svg.appendChild(dot);
      return svg;
    }

    /** 造那一颗按钮：28 点，与同一行里那几颗图标按钮同尺寸。 */
    function createFooterIcon(doc) {
      const anchor = doc.createElement('a');
      anchor.className = 'dshm_footAction';
      anchor.setAttribute(FOOTER_MARK, '');
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noreferrer');
      const icon = phoneIcon(doc, PHONE_GLYPH_WIDE);
      if (icon) anchor.appendChild(icon);
      return anchor;
    }

    /**
     * 把「打开哪一页 / 现在是什么状态」同步到元素上。
     *
     * 没有地址时**不写 href**（没有地址可写，别挂死链），但**点击处理照样挂上**：那颗图标的
     * 点击会自己去把两小时窗口开出来、再读一次地址（见 `openConfigurationPage`）。别把
     * `onclick` 一起摘掉 —— 摘了就是「点了完全没反应」。
     *
     * `tone` 三档：`''` 正常、`'warn'` 有问题但插件没坏（琥珀）、`'error'` 真故障（红）。
     * 换的只是记号与颜色，图形和尺寸一个像素都不动 —— 那一行是外壳的，动尺寸就会挤到别人。
     *
     * 地址、网络类别和窗口状态都由 effect 往上同步，组件重渲染不会把它丢掉。
     */
    function syncFooterIcon(node, { href, label, onClick, tone }) {
      node.setAttribute('aria-label', label);
      node.setAttribute('title', label);
      node.setAttribute('aria-disabled', 'false');
      if (tone === 'error') node.setAttribute(FOOTER_ALERT, '');
      else node.removeAttribute(FOOTER_ALERT);
      if (tone === 'warn') node.setAttribute(FOOTER_WARN, '');
      else node.removeAttribute(FOOTER_WARN);
      // 有地址时仍然写 `href`：普通链接照旧能中键 / 新标签打开。只有「浏览器不是从本机来的」
      // 那两种情况要拦下来先开窗口，见 `openPanel`。
      if (href) node.setAttribute('href', href);
      else node.removeAttribute('href');
      node.onclick = onClick;
    }

    /** 把按钮放回设置那一行、紧跟头像出口。返回是否真在那一行里。 */
    function ensureFooterIcon(doc, node) {
      const outlet = typeof doc.querySelector === 'function' ? doc.querySelector(FOOTER_ANCHOR) : null;
      const row = outlet && outlet.parentElement;
      if (!row || typeof row.insertBefore !== 'function') return false;
      // 只认「侧栏底部那个座位里的 launcher」：头像那块万一被外壳渲染到别处（设置面板里、
      // 以后的新位置），按出口插进去就插错地方了。认不出座位就当没认出行，退回自己一行。
      if (typeof outlet.closest === 'function' && outlet.closest(FOOTER_SEAT) === null) return false;
      if (node.parentElement === row && node.previousSibling === outlet) return true;
      row.insertBefore(node, outlet.nextSibling);
      return true;
    }

    /** 摘掉上一次物化留下的那一颗（插件重装、同一页面里出现第二份实现）。 */
    function dropStaleFooterIcons(doc) {
      if (!doc || typeof doc.querySelectorAll !== 'function') return;
      let stale = null;
      try {
        stale = doc.querySelectorAll(`[${FOOTER_MARK}]`);
      } catch {
        return;
      }
      for (const node of stale || []) {
        if (node && typeof node.remove === 'function') node.remove();
      }
    }

    /**
     * 侧边栏底部的那颗手机图标（进网页的唯一入口）。
     *
     * 展开态：插进设置那一行（那一行里插得进、也不遮东西），自己不出现在
     * `sidebar.footer.action` 那一行里。
     * 收窄成 56 点的窄条时：那一行只有 36 点、已经被设置那颗占满，插不进第二颗，于是
     * 就画在 `sidebar.footer.action` 自己那一行（居中摞在设置上方）——这一条是物理限制，
     * 不是退路。认不出那一行的时候也走这条路，入口不会消失。
     *
     * 点下去做什么：宿主在 `/status` 上按请求 Host 报一个
     * `panelScope`，图标据此分流：
     *   - `loopback`：人就在这台机器的 DSH 里，控制面本来就认它 —— 普通链接跳转；
     *   - `private` / `public`：浏览器是从别的机器来的，控制面不认它、面板会回 423，
     *     所以先把那两小时窗口打开再跳；`public` 多弹一句确认（那个地址谁都能拨）。
     *
     * **打不开的时候不许「点了没反应」**：一律弹诊断窗——宿主与外壳各说了什么、用户自己
     * 能做的几步检查、能一键试的修复（重新装载 / 重读状态），以及一段可复制的读数。
     */
    function MobileWebEntry({ wide, t }) {
      /** null = 还没问到；'' = 问到了但宿主没给地址（老版本或还没起来）。 */
      const [url, setUrl] = useState(null);
      const [webAccess, setWebAccess] = useState(null);
      /** 面板地址落在哪类网络上：`loopback` / `private` / `public`（宿主算好给的）。 */
      const [panelScope, setPanelScope] = useState('');
      /** 最近一次读状态失败的原因（`null` = 没失败过）；`status: 404` = 实现那一半没装载。 */
      const [problem, setProblem] = useState(null);
      /** 链路报错的键（`footerTunnelBad` / `footerSidecarBad`）；`''` = 没报错。 */
      const [fault, setFault] = useState('');
      /** 标题上那句「现在什么情况」（几台设备、多久没连过）；读不到现场时是空串。 */
      const [hint, setHint] = useState('');
      /** 展开态是否已经插进设置那一行。插不上就自己占一行。 */
      const [anchored, setAnchored] = useState(true);
      const nodeRef = useRef(null);
      const dialogRef = useRef(null);
      /**
       * 文案在这里取、并把结果塞进下面那些 effect 的依赖里。
       *
       * 不能只依赖 `t` 本身：它是 `ctx.locale.bind(NS)` 绑出来的一个稳定函数，切语言时
       * 引用不变，effect 就不会重跑，插进那一行的那颗按钮会一直挂着旧的标题。
       */
      const openLabel = t('footerOpen');
      const pendingLabel = t('footerPending');
      const loadMissingLabel = t('footerLoadMissing');
      const publicConfirm = t('footerPublicConfirm');
      /**
       * 宿主那一半没装载（`/status` 404）：点了也打不开、重装前谁也修不好，所以这一种是
       * **真故障**，那颗图标转红告警；标题也换成更具体的那一句。地址只是还没读到（后台
       * 重试中）、或者窗口关着被回 423，都不是插件坏了，不红。
       */
      const hostMissing = Boolean(problem && problem.status === 404);

      /** 诊断窗单例：同一页面只留一个，反复打开就地重画。 */
      function diagnosisDialog() {
        if (!dialogRef.current) {
          dialogRef.current = createDiagnosisDialog(typeof document !== 'undefined' ? document : null);
        }
        return dialogRef.current;
      }

      /**
       * 拉一次宿主状态，把地址 / 分类 / 窗口 / 失败原因同步进 state。
       *
       * 返回值给调用方用（诊断窗要拿最新那一份读数，不能读组件里那份可能还没更新的状态）：
       * `{ ok: true, status }` 或 `{ ok: false, problem }`。
       */
      async function refreshStatus() {
        try {
          const next = await call('/status');
          const view = next && typeof next === 'object' ? next : {};
          const summary = readStatusView(view);
          setUrl(summary.panelUrl);
          setWebAccess(summary.webAccess);
          setPanelScope(summary.panelScope);
          setFault(summary.fault);
          setHint(hintOf(summary));
          setProblem(null);
          return { ok: true, status: view };
        } catch (error) {
          const failed = {
            status: Number(error && error.status) || 0,
            message: String((error && error.message) || error),
          };
          setProblem(failed);
          // 读不到现场就把那句话撤掉：留着上一轮那句「2 台设备 · 3 分钟前」会让人以为
          // 现场还是那样，而其实这一刻我们什么都不知道。
          setHint('');
          return { ok: false, problem: failed };
        }
      }

      /**
       * 标题那一句「现在是什么情况」。
       *
       * 只有读到链路现场时才说得出口；地址还没有、或者读失败时这一句是空的，标题退回
       * 「还没就绪」/「宿主没装载」那两句固定的。设备台数为 0 时说「还没配对过」——
       * 那是「去配一台」的提示，不是故障。
       */
      function hintOf(summary) {
        if (!summary || !summary.panelUrl) return '';
        if (summary.fault) return t(summary.fault);
        const devices = summary.devices;
        if (devices) {
          const count = Number(devices.count) || 0;
          if (count === 0) return t('footerNoDevice');
          const ago = relativeAgo(devices.lastSeenAt);
          return ago ? t('footerDeviceSeen', { count, ago }) : t('footerDeviceCount', { count });
        }
        return '';
      }

      /**
       * 三档状态：正常 / 有问题（琥珀）/ 真故障（红）。
       *
       * 红只留给「点了也没用」的那一种（宿主那一半没装载）；链路报错是琥珀——面板还能开，
       * 只是现在连不通。地址还没读到（后台重试中）与窗口关着被回 423 都算正常态：
       * 那种情况每开一次页面都会出现，一有它就变脸等于天天报假警。
       */
      function footerState() {
        if (hostMissing) return { tone: 'error', label: loadMissingLabel };
        if (fault) return { tone: 'warn', label: hint ? `${t(fault)} · ${openLabel}` : openLabel };
        if (!url) return { tone: '', label: pendingLabel };
        return { tone: '', label: hint ? `${hint} · ${openLabel}` : openLabel };
      }

      /**
       * 「多久以前」：只给三个够用的颗粒度。
       *
       * 侧边栏那一句靠人一眼扫过去，精确到秒没有意义；而「3 分钟前 / 2 小时前 / 昨天」正好
       * 对应「刚在用 / 今天用过 / 隔了点时间」。没有时间戳（`0`）返回空串，调用方退回只说台数。
       */
      function relativeAgo(at) {
        const stamp = Number(at) || 0;
        if (!stamp) return '';
        const minutes = Math.floor((Date.now() - stamp) / 60000);
        if (minutes < 1) return t('footerAgoNow');
        if (minutes < 60) return t('footerAgoMinutes', { count: minutes });
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return t('footerAgoHours', { count: hours });
        return t('footerAgoDays', { count: Math.floor(hours / 24) });
      }

      /**
       * 点下去要做什么，取决于面板地址落在哪一类网络上（宿主在 `/status` 上算的 `panelScope`）。
       *
       * 有地址且就在本机：普通链接，交给浏览器自己开。
       * 其余情况（从别的机器打开的页面、或者压根还没读到地址）都要先把两小时窗口开出来：
       * 新窗口必须在**点击这一帧**开出来（`window.open('', '_blank')`），等接口回来再开会被
       * 浏览器的弹窗拦截器吃掉；地址确认到之后才把那个空窗口导航过去，失败就关掉它并弹诊断。
       * 只有**网页**（`http(s)`）才需要这一手：桌面壳里那个函数一定被拒，见 `isWebPage`。
       */
      /**
       * 点下去做什么。
       *
       * **点了先在这一页弹一屏**（不是直接跳浏览器）：用户遇到问题时最缺的不是
       * 跳过去，而是「它现在到底哪一环断了」——启动、装载、隧道、旁挂进程、自检全都在那一屏
       * 里，比一个打不开的页面有用。跳转本身没取消，挪进了那一屏里的一颗按钮。
       *
       * 那一屏的内容是网页版的 `/api/relay/panel/debug`（React 写的，改完刷新就见效），
       * 这里只把同源地址算出来嵌进去。**必须先保证控制面认这个浏览器**，否则嵌进来的是一屏
       * 423 JSON：所以先按 `panelScope` 把两小时窗口开好，再画窗。
       *
       * 三种走不通的情况一律回到诊断窗（外壳里 `window.open` 不可靠、宿主那一半没装载、
       * 窗口开不出来）—— 不许「点了没反应」。
       */
      function openPanel(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        // 公网地址先问一句——但**只在真要开那两小时窗口的时候问**：窗口已经开着，
        // 这一下没有扩大任何权限，再弹一次只是把上一轮点过的确认重问一遍。
        const willOpenWindow = panelScope !== 'loopback' && !(webAccess && webAccess.enabled);
        if (panelScope === 'public'
          && url
          && willOpenWindow
          && typeof window !== 'undefined'
          && typeof window.confirm === 'function'
          && !window.confirm(publicConfirm)) return;
        // 桌面壳（`dsh-app://app`）里不嵌：往自定义协议页里塞一条 http(s) iframe，多半被
        // 当成混合内容挡掉，用户看到的是一窗空白。那种环境仍走「交给系统浏览器」那条老路
        //（`navigate` 默认 true，壳的 `will-navigate` 会把它转给系统浏览器）。
        void (async () => {
          const outcome = await openConsole({
            view: { panelUrl: url || '', panelScope, webAccess },
            loadStatus: problem ? problem.status : 0,
            t,
          });
          if (outcome.ok) {
            if (outcome.webAccess) setWebAccess(outcome.webAccess);
            return;
          }
          // 宿主那一半压根没装载：那是一屏「装完没重启」，不是这一屏能修的。
          if (outcome.missing) {
            void openDiagnosis('load', { status: outcome.status || 404, message: (problem && problem.message) || '' });
            return;
          }
          void openDiagnosis('open', { status: outcome.status || 0, message: outcome.message });
        })();
      }

      /**
       * 把「控制台」那一屏画出来：标题 + 一颗「在浏览器里打开」+ 内嵌的调试页。
       *
       * 嵌的是同一台宿主吐的页面（同源），所以它读 `/api/relay/*` 和面板页一模一样，
       * 不需要 token、也不新增接口。远程浏览器要先开那两小时窗口：`openConfigurationPage`
       * 在这一步之前已经把窗口开好了（它的 `target` 传 null，不导航任何地方）。
       */
      async function openConsole({ view, loadStatus, t }) {
        if (typeof document === 'undefined') return { ok: false, missing: false, status: 0, message: t('panelMissing') };
        const outcome = await openConfigurationPage({ view, loadStatus, t, target: null, confirmed: true, navigate: false });
        if (!outcome.ok) return outcome;
        const consolePage = panelPageUrlOf('console');
        const debugPage = panelPageUrlOf('debug');
        if (!consolePage) return { ok: false, missing: false, status: 0, message: t('panelMissing') };
        const dialog = diagnosisDialog();

        /**
         * 点一下手机图标，**直接就是这一屏控制台**（2026-11-13 用户拍板）。
         *
         * 改掉的是原先那两层：第一层「进入控制台 / 报错调试」两块大按钮、第二层才是页面。
         * 理由有两条：
         *  1. 那一层唯一的作用是让人多按一次 —— 而这一窗存在的意义就是「点进来就能扫码 /
         *     看手机连没连上」，中间夹一层只是把正门多砌一道门槛；
         *  2. 那颗「进入控制台」以前是**跳去浏览器**，用的是宿主报的 `panelUrl`。云服务器上
         *     用户从公网 IP 打开 DSH 时，那个地址常常是本机的 `127.0.0.1:端口`，跳过去必然
         *     打不开。现在整页就地嵌、地址按 `document.baseURI` 推（见 `panelPageUrlOf`），
         *     公网、域名、反代子路径三种都能对上。
         *
         * 调试页没删：它退到操作栏里的「报错调试」一颗按钮（次要样式）。那一屏是排障用的，
         * 不该跟日常那一屏抢第一眼。
         */
        const openBrowser = (page) => {
          if (typeof window === 'undefined' || typeof window.open !== 'function') return;
          const opened = window.open(page || consolePage, '_blank', 'noreferrer');
          if (opened) dialog.hide();
          else dialog.note(t('consolePopupBlocked'));
        };

        dialog.open({
          title: t('consoleTitle'),
          wide: true,
          frame: {
            src: consolePage,
            title: t('consoleTitle'),
            hint: t('consoleFrameless'),
          },
          actions: [
            { label: t('consoleOpenBrowser'), primary: true, onClick: () => openBrowser(consolePage) },
            { label: t('consoleTroubleshoot'), onClick: () => openBrowser(debugPage) },
            { label: t('diagCopy'), onClick: () => void copyConsole() },
            { label: t('diagClose'), onClick: () => dialog.hide() },
          ],
        });
        return { ok: true, webAccess: outcome.webAccess };
      }

      /** 把「复制诊断信息」那一套复用在控制台上：读的是嵌入页同样的几份，不另开一套。 */
      async function copyConsole() {
        const dialog = diagnosisDialog();
        const lines = ['dsh-mobile-plugin console'];
        lines.push(`panel_url=${url || ''}`);
        lines.push(`panel_scope=${panelScope || ''}`);
        try {
          const view = await call('/status');
          const next = view && typeof view === 'object' ? view : {};
          lines.push(`plugin_version=${next.appVersion || ''}`);
          lines.push(`tunnel=${next.tunnel && next.tunnel.state ? next.tunnel.state : ''}`);
          lines.push(`lan=${next.lan && next.lan.state ? next.lan.state : ''}`);
          lines.push(`sidecar=${next.sidecar && next.sidecar.state ? next.sidecar.state : ''}`);
          lines.push(`last_mobile_at=${next.lastMobileAt || 0}`);
        } catch (error) {
          lines.push(`status_error=${String((error && error.message) || error)}`);
        }
        try {
          const picture = await call(HOST_HALF_ENDPOINT);
          const half = picture && picture.half && typeof picture.half === 'object' ? picture.half : {};
          lines.push(`plugin_source=${half.source || ''}`);
          lines.push(`host_last_error=${half.lastError || ''}`);
        } catch {
          lines.push('host_half=unavailable');
        }
        if (typeof navigator !== 'undefined' && navigator.userAgent) lines.push(`user_agent=${navigator.userAgent}`);
        const ok = await copyDiagnosisText(document, lines.join('\n'));
        // 复制结果就地提示一下即可，不必重画整窗（重画会把嵌着的页面重新加载一遍）。
        dialog.note(ok ? t('diagCopied') : t('diagCopyFailed'));
      }

      /**
       * 把这一轮的现场摆成一屏**能自己动手**的自查。
       *
       * `kind` 两种：`'load'`（连状态都读不到，所以没有地址可去）、`'open'`（两小时窗口没
       * 开成，没跳过去）。前者的首要原因是「装完没重启」，后者先重试再看反代。
       *
       * 这一屏的三个层次，顺序就是用户该想的顺序：
       *   1. 谁说了什么（宿主返回的原文 + 外壳自检那份快照，含版本/来源/后台重试/要不要重启）；
       *   2. 用户自己就能做的检查与修复（重启、重装、确认没装两份、反代前缀）；
       *   3. 能一键试的（重新装载实现、重读状态、地址就绪时直接打开面板）与「复制诊断信息」。
       */
      async function openDiagnosis(kind, failure) {
        if (typeof document === 'undefined') return;
        const view = diagnosisDialog();
        /** 这一屏用的现场：重读之后就地更新（组件状态要等下一次渲染，这里不能等它）。 */
        const snapshot = {
          url: typeof url === 'string' ? url : '',
          scope: panelScope || 'unknown',
          access: webAccess,
        };
        let current = failure || problem || null;
        let half = null;

        const title = kind === 'open' ? t('diagTitleOpen') : t('diagTitleLoad');
        const closeAction = { label: t('diagClose'), onClick: () => view.hide() };
        const adopt = (status) => {
          const next = status && typeof status === 'object' ? status : {};
          snapshot.url = typeof next.panelUrl === 'string' ? next.panelUrl : '';
          snapshot.scope = typeof next.panelScope === 'string' ? next.panelScope : 'unknown';
          snapshot.access = next.webAccess && typeof next.webAccess.enabled === 'boolean' ? next.webAccess : null;
        };

        /** 问外壳那份自检（实现挂了它还在）：原因、版本、后台重试都在这儿。 */
        const readHalf = async () => {
          try {
            const picture = await call(HOST_HALF_ENDPOINT);
            half = picture && typeof picture.half === 'object' ? picture.half : { unavailable: true };
          } catch {
            half = { unavailable: true };
          }
          return half;
        };

        const facts = () => {
          const rows = [];
          if (current) {
            rows.push({ key: 'host_returned', label: t('diagFactReturned'), value: current.message });
            rows.push({ key: 'http_status', label: t('diagFactStatus'), value: current.status ? String(current.status) : '—' });
          }
          if (half && half.unavailable === true) {
            rows.push({ key: 'self_check', label: t('diagFactSelfcheck'), value: t('diagFactUnavailable') });
          } else if (half) {
            rows.push({ key: 'plugin_version', label: t('diagFactPlugin'), value: half.version ? String(half.version) : '—' });
            if (half.source) rows.push({ key: 'plugin_source', label: t('diagFactSource'), value: half.source });
            if (half.activatedAt) rows.push({ key: 'activated_at', label: t('diagFactActivated'), value: half.activatedAt });
            if (half.retrying) {
              const attempts = Number.isFinite(half.retryAttempts) ? half.retryAttempts : 0;
              rows.push({
                key: 'retrying',
                label: t('diagFactRetry'),
                value: `${attempts}${half.nextRetryAt ? ` → ${half.nextRetryAt}` : ''}`,
              });
            }
            if (half.installedVersion && half.installedVersion !== half.version) {
              rows.push({ key: 'on_disk', label: t('diagFactOnDisk'), value: half.installedVersion });
            }
            if (half.shellChanged) rows.push({ key: 'shell_changed', label: t('diagFactShell'), value: 'true' });
            if (half.lastError) rows.push({ key: 'host_last_error', label: t('diagFactReason'), value: half.lastError });
          }
          rows.push({ key: 'panel_url', label: t('diagFactPanelUrl'), value: snapshot.url || '—' });
          rows.push({ key: 'panel_scope', label: t('diagFactScope'), value: snapshot.scope });
          rows.push({
            key: 'web_access',
            label: t('diagFactWindow'),
            value: snapshot.access && snapshot.access.enabled ? `open → ${new Date(snapshot.access.expiresAt).toISOString()}` : 'closed',
          });
          return rows;
        };

        const summaryOf = () => {
          if (!current) return t('diagSummaryRestored');
          if (kind === 'open') return t('diagSummaryOpenFailed');
          if (current.status === 404) {
            if (half && half.unavailable === true) return t('diagSummaryUnreachable');
            if (half && !half.lastError) return t('diagSummaryNoError');
            return t('diagSummaryLoadMissing');
          }
          return t('diagSummaryLoadFailed');
        };

        const stepsOf = () => {
          if (kind === 'open') return [t('diagStepRetryOpen'), t('diagStepProxy')];
          const steps = [t('diagStepRestart'), t('diagStepReinstall')];
          if (half && half.retrying) steps.push(t('diagStepRetrying'));
          steps.push(t('diagStepDuplicate'), t('diagStepProxy'));
          return steps;
        };

        const copyTextOf = () => {
          const lines = ['dsh-mobile-plugin diagnosis'];
          for (const row of facts()) lines.push(`${row.key}=${row.value}`);
          if (typeof navigator !== 'undefined' && navigator.userAgent) lines.push(`user_agent=${navigator.userAgent}`);
          return lines.join('\n');
        };

        const render = (note) => {
          const actions = [];
          if (snapshot.url) {
            actions.push({
              label: t('diagOpenPanel'),
              primary: true,
              onClick: () => {
                if (typeof window !== 'undefined' && typeof window.open === 'function') {
                  window.open(snapshot.url, '_blank', 'noreferrer');
                }
                view.hide();
              },
            });
          }
          if (kind === 'load' && (!current || current.status === 404)) {
            actions.push({ label: t('diagReload'), onClick: () => void reload() });
          }
          actions.push({ label: t('diagRetry'), onClick: () => void retry() });
          actions.push({ label: t('diagCopy'), onClick: () => void copy() });
          actions.push(closeAction);
          view.open({
            title,
            summary: summaryOf(),
            factsHeading: t('diagHeadingFacts'),
            facts: facts(),
            stepsHeading: t('diagHeadingSteps'),
            steps: stepsOf(),
            note,
            actions,
          });
        };

        async function copy() {
          const ok = await copyDiagnosisText(document, copyTextOf());
          render(ok ? t('diagCopied') : t('diagCopyFailed'));
        }

        /** 重读一遍状态；读到就把这一屏的现场换成新的（心跳式的即时自愈）。 */
        async function retry() {
          render(t('diagBusy'));
          const outcome = await refreshStatus();
          if (outcome.ok) {
            current = null;
            adopt(outcome.status);
          } else {
            current = outcome.problem;
          }
          await readHalf();
          render(null);
        }

        /** 让外壳当场把实现再装一次：装载失败时唯一不必重启整个 DSH 的出路。 */
        async function reload() {
          render(t('diagReloadBusy'));
          let note = null;
          try {
            const answer = await postJson(HOST_HALF_RELOAD_ENDPOINT, {});
            if (answer && answer.ok === false) note = `${t('diagReloadFailed')}${errorText(answer, 200)}`;
          } catch (error) {
            note = `${t('diagReloadFailed')}${String((error && error.message) || error)}`;
          }
          await readHalf();
          // 成没成以重读状态为准：外壳回了一声 ok 不等于控制面路由这就回来了。
          const outcome = await refreshStatus();
          if (outcome.ok) {
            current = null;
            adopt(outcome.status);
            if (note === null) note = t('diagReloadOk');
          } else {
            current = outcome.problem;
            if (note === null) note = `${t('diagReloadFailed')}${current.message}`;
          }
          render(note);
        }

        view.open({ title, summary: t('diagChecking'), actions: [closeAction] });
        await readHalf();
        render(null);
      }

      // 页面一打开就问一次地址：点下去要么是一次同步的链接跳转、要么先把窗口开好，
      // 地址与分类都得提前在手上。宿主还没起来时留一个定时器，取到地址就自己收掉。
      useEffect(() => {
        let alive = true;
        let timer = null;
        const load = async () => {
          const outcome = await refreshStatus();
          if (!alive || !outcome.ok) return;
          const next = outcome.status || {};
          if (typeof next.panelUrl === 'string' && next.panelUrl && timer !== null) {
            clearInterval(timer);
            timer = null;
          }
        };
        void load();
        if (timer === null) {
          timer = setInterval(() => {
            if (typeof document !== 'undefined' && document.hidden) return;
            void load();
          }, FOOTER_URL_RETRY_MS);
        }
        return () => {
          alive = false;
          if (timer !== null) clearInterval(timer);
        };
      }, []);

      useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const doc = document;
        // 窄条那一行塞不下第二颗：不插，自己占一行。
        if (!wide) {
          setAnchored(false);
          return undefined;
        }
        let node = nodeRef.current;
        if (!node) {
          try {
            dropStaleFooterIcons(doc);
            node = createFooterIcon(doc);
          } catch {
            node = null;
          }
          nodeRef.current = node;
        }
        if (!node) {
          setAnchored(false);
          return undefined;
        }
        // 标题与颜色都由这一份状态得出：没地址时说「为什么没有」（404 = 宿主没装载，
        // 其余 = 还没就绪），有地址时说现场（几台设备、多久没连过、链路有没有报错）。
        const sync = () => {
          const state = footerState();
          syncFooterIcon(node, { href: url, label: state.label, onClick: openPanel, tone: state.tone });
        };
        let attached = false;
        try {
          attached = ensureFooterIcon(doc, node);
          sync();
        } catch {
          attached = false;
        }
        setAnchored(attached);
        // 那一行会被外壳整棵重建（宽窄切换、账户菜单换人、提示挂上/摘下），元素掉线就
        // 补回去；第一次没找到（设置项比我们晚挂上）也靠它捡回来。变动只排一次检查：
        // 流式输出时每帧最多一次查询，且不写 DOM 就不触发重排。
        const Observer = typeof window !== 'undefined' ? window.MutationObserver : undefined;
        let observer = null;
        let frame = 0;
        if (typeof Observer === 'function' && doc.body) {
          observer = new Observer(() => {
            if (frame !== 0) return;
            const raf = typeof requestAnimationFrame === 'function'
              ? requestAnimationFrame
              : (fn) => setTimeout(fn, 16);
            frame = raf(() => {
              frame = 0;
              try {
                sync();
                setAnchored(ensureFooterIcon(doc, node));
              } catch {
                setAnchored(false);
              }
            });
          });
          observer.observe(doc.body, { childList: true, subtree: true });
        }
        return () => {
          if (observer !== null) observer.disconnect();
          if (frame !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
          if (typeof node.remove === 'function' && node.parentElement) node.remove();
        };
      }, [wide, url, openLabel, loadMissingLabel, pendingLabel, problem, panelScope, webAccess, hint, fault]);

      // 窄条，或者这一版外壳里认不出那一行：自己占一行，入口不能因为认不出位置就消失。
      if (!wide || !anchored) {
        const state = footerState();
        return h('a', {
          className: 'dshm_footAction dshm_footActionRail',
          href: url || undefined,
          target: '_blank',
          rel: 'noreferrer',
          'aria-label': state.label,
          title: state.label,
          'aria-disabled': 'false',
          [FOOTER_ALERT]: state.tone === 'error' ? '' : undefined,
          [FOOTER_WARN]: state.tone === 'warn' ? '' : undefined,
          onClick: openPanel,
        }, h('svg', {
          viewBox: '0 0 24 24',
          width: PHONE_GLYPH_RAIL,
          height: PHONE_GLYPH_RAIL,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        }, [
          ...PHONE_PATHS.map((d) => h('path', { key: d, d })),
          h('circle', {
            key: 'alert',
            className: 'dshm_alertDot',
            cx: PHONE_ALERT_DOT.cx,
            cy: PHONE_ALERT_DOT.cy,
            r: PHONE_ALERT_DOT.r,
            fill: 'currentColor',
          }),
        ]));
      }
      return null;
    }

    /**
     * 客户端半边的自检上报：每 10s 把「这一半到底看见了什么」报给宿主。
     *
     * 宿主能数出「那半边没来敲门」，数不出「为什么没来」。这条通路直接摆出：两条同步各自的
     * `ctx.inject` 有没有回调、`ctx.get` 能不能看见那两个服务、最后一次错在哪。
     *
     * 刻意不依赖任何客户端服务：探测全包在 try/catch 里，它自己挂在服务上就永远报不出
     * 「服务拿不到」这件事。
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

    /* ── 设置里的那一项「移动端」───────────────────────────────────────────
     * 设置里的「移动端」与侧边栏那颗图标进的是同一个页面、走同一条拨号链路（图标是快捷方式，
     * 这一张是设置里的正规入口）：介绍产品时说的入口就是「设置 → 移动端」，只留图标会让从
     * 网页版进来的人不知道配置在哪。
     *
     * 刻意只有一张薄卡：界面本体全在网页版里（A3-37），在这里再画一套等于长期维护第二套 UI，
     * 而两套迟早会打架。卡片只做两件事——说清配置在哪、把那一页开出来；开不出来就在卡上写原因。
     */
    function MobileSettingsSection({ t }) {
      /** null = 还在问宿主；'' = 问到了但宿主没给地址（老版本或还没起来）。 */
      const [url, setUrl] = useState(null);
      const [scope, setScope] = useState('');
      const [access, setAccess] = useState(null);
      /** `null` = 这一次没出错；否则 `{ kind: 'load' | 'open', message }`。 */
      const [failure, setFailure] = useState(null);

      useEffect(() => {
        let alive = true;
        void (async () => {
          try {
            const next = await call('/status');
            if (!alive) return;
            const view = next && typeof next === 'object' ? next : {};
            setUrl(typeof view.panelUrl === 'string' ? view.panelUrl : '');
            setScope(typeof view.panelScope === 'string' ? view.panelScope : '');
            setAccess(view.webAccess && typeof view.webAccess.enabled === 'boolean' ? view.webAccess : null);
            setFailure(null);
          } catch (error) {
            if (!alive) return;
            setUrl('');
            setFailure({ kind: 'load', status: Number(error && error.status) || 0, message: String((error && error.message) || error) });
          }
        })();
        return () => { alive = false; };
      }, []);

      /**
       * 拨到面板。判据与侧边栏那颗图标完全一致（A3-25）：本机直接跳；从别的机器打开的浏览器
       * 控制面不认它，先把两小时窗口开出来再跳；公网地址多弹一句确认。地址还没读到时也照样
       * 走这条路——它会自己开窗再读一次（见 `openConfigurationPage`），不是干等。
       *
       * 新窗口必须在**点击这一帧**开出来，等到接口回来再开会被弹窗拦截器吃掉。
       */
      function openPanel(event) {
        const knowsUrl = typeof url === 'string' && url !== '';
        const needsWindow = !knowsUrl || (scope !== 'loopback' && !(access && access.enabled));
        if (!needsWindow) return; // 普通链接，交给浏览器自己开
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (knowsUrl
          && scope === 'public'
          && typeof window !== 'undefined'
          && typeof window.confirm === 'function'
          && !window.confirm(t('footerPublicConfirm'))) return;
        const target = isWebPage(window) && typeof window.open === 'function'
          ? window.open('', '_blank')
          : null;
        void (async () => {
          const outcome = await openConfigurationPage({
            view: { panelUrl: url || '', panelScope: scope, webAccess: access },
            loadStatus: failure && failure.kind === 'load' ? failure.status || 0 : 0,
            t,
            target,
            confirmed: knowsUrl,
          });
          if (outcome.ok) {
            if (outcome.cancelled && target && typeof target.close === 'function') target.close();
            if (outcome.webAccess) setAccess(outcome.webAccess);
            if (!outcome.cancelled) setFailure(null);
            return;
          }
          if (target && typeof target.close === 'function') target.close();
          setFailure({ kind: outcome.missing ? 'load' : 'open', status: outcome.status || 0, message: outcome.message });
        })();
      }

      const hint = url === null ? t('panelPending') : url === '' ? t('panelMissing') : t('openHint');
      return h('div', { className: 'dshm_root' },
        h('h2', { className: 'dshm_heading' }, t('heading')),
        h('div', { className: 'dshm_card' },
          h('h3', { className: 'dshm_cardTitle' }, t('cardPanel')),
          h('p', { className: 'dshm_note' }, hint),
          h('div', { className: 'dshm_actions' },
            h('a', {
              className: 'dshm_btn dshm_btnPrimary',
              href: url || undefined,
              target: '_blank',
              rel: 'noreferrer',
              'aria-disabled': 'false',
              onClick: openPanel,
            }, t('openPanel'))),
          failure
            ? h('p', { className: 'dshm_error' },
              `${failure.kind === 'load' ? t('loadFailed') : t('openFailed')}：${failure.message}`)
            : null));
    }

    return {
      // slots：注册设置项与侧边栏那颗图标，由 @deepseek-ai/dsh-client-runtime 提供（它 require
      // dsh-client-ui-slots 的 SlotCore 再以 `super(ctx, "slots")` 暴露服务）。
      // locale：字典，由 @deepseek-ai/dsh-client-locale 提供。
      // 这两个服务名对应 package.json 里 dsh.client.inject 注入的两个包。
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT), 'mobile-plugin: settings dictionaries');
        const t = ctx.locale.bind(NS);
        captureSessions(ctx);
        startDesktopReadSync(ctx);
        startReadReceiptSync(ctx);
        startClientHalfReport(ctx);
        // 设置里那一项：外壳声明 `settings.section`（设置菜单里的顶层一项），先声明后注册 ——
        // 外壳可能比我们晚一步声明它。跟内置插件页的页签是两回事：这一项是自己的设置页。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'mobile',
          order: 20,
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ t }),
        }, MobileSettingsSection));
        // 侧边栏底部那颗手机图标：它是设置那一项的快捷方式，进的是同一个页面。走外壳给插件
        // 留的动作位注册（`name` 与 `inject()` 的路径必须是同一个槽名，改一处不报错、只是
        // 静默挂不上）；展开态再自己插进设置那一行，细节见 `MobileWebEntry` 上面那段注释。
        ctx.slots.inject(FOOTER_SLOT, () => ctx.slots.register({
          name: FOOTER_SLOT,
          id: 'mobile-web',
          order: 10,
          label: () => t('footerOpen'),
          locale: NS,
          inject: () => ({ t }),
        }, MobileWebEntry));
      },
    };
  },
});

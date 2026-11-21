// 用途：桌面端入口与诊断反馈；打开配置页失败附带稳定原因码，不外发原始错误和访问凭据。
/**
 * 移动端插件提供电脑插件页面目录；标准页面保留宿主上下文并支持直接导航。
 * 聊天嵌入服务合并顶部栏显示声明，随提供方与消费方生命周期释放。
 * 入口不看到达来源：本机、局域网、公网、反代后面都能直接进管理页。
 *
 * 五件事：桌面侧边栏的展开态与「读过了」报给宿主；手机端的已读回执应用回桌面绿点；
 * 设置里那一项「移动端」（一张薄卡，一颗「打开配置页面」）；在侧边栏最底下那一行挂两颗
 * 图标——手机图标（点一下等于那张卡上的按钮，进控制台）与它右边的电脑图标（进远程电脑页）；
 * 聊天嵌入页里按目标打开会话、守住它不被网页端启动时那次「恢复上次会话」顶掉，换目标则在
 * 页面里切过去、不重新加载。方向是单向的（桌面 → 宿主 → 手机），手机上的折叠只存在 App
 * 本地，不写回。
 *
 * 设置卡上另有两颗侧边栏图标（手机 / 电脑）的显示开关：默认全开、至少留一颗，选择写进
 * 插件配置；同一页里两颗图标当场收起或回来，不必等下一次状态轮询。
 *
 * 本文件不经任何构建（package.json 直接收录 lib 下的 .js），所以不能写 JSX，统一用
 * `React.createElement` 的别名 `h`；客户端插件按约定写成惰性工厂，定时器与页签在物化时才起。
 *
 * 诊断 / 控制台 / 远程电脑共用那一扇弹窗外壳：打开时复位 display（复用已收起的 keep 窗）、
 * 把焦点移入并锁背景滚动，收起时还原；compact 整页窗另在外壳层放一颗固定关闭角标。侧边栏
 * 两颗图标的轮询不再拿到地址就停，改为低频刷新并在页面重新可见时补一次。
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
/* 手机与电脑两颗图标合在同一只方框里：一个细边框圈成一组，两颗之间只留 2px 的缝。
   进组后撤掉单颗各自的外边距，否则间距会翻倍、还会把边框撑松。 */
.dshm_footerGroup{flex:none;display:inline-flex;align-items:center;gap:2px;padding:1px 2px;border:1px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-md)}
.dshm_footerGroup .dshm_footAction{margin:0}
/* 宿主那一半没装载时：整颗转红，右上角那颗红点显出来（data-dshm-alert 是它的记号）。
   悬停不换回普通颜色——告警态跟着鼠标变浅等于这一颗在说谎。 */
.dshm_footAction[data-dshm-alert],.dshm_footAction[data-dshm-alert]:hover{color:var(--dsw-alias-state-error-primary)}
/* 中间那一档：确实有问题、但还没到「插件坏了」的程度（中转断着、旁挂进程没在跑、
   配了手机却一直没连上）。琥珀色 + 同一颗点，图形与尺寸一样不动。 */
.dshm_footAction[data-dshm-warn],.dshm_footAction[data-dshm-warn]:hover{color:var(--dsw-alias-state-warning-primary)}
/* 需要重启 DSH 才能把这次更新的外壳部分用上：那颗入口临时变成「提醒」按钮，
   旁边的电脑图标暂时藏起来，方框里只剩这颗，点它弹一扇说明窗。重启后自动变回来。 */
.dshm_footerGroup[data-dshm-restart] .dshm_footAction:not([data-dshm-restart-icon]){display:none}
.dshm_alertDot{display:none}
.dshm_footAction[data-dshm-alert] .dshm_alertDot,.dshm_footAction[data-dshm-warn] .dshm_alertDot{display:inline}
.dshm_overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:clamp(8px,3vh,20px);background:rgba(0,0,0,.42)}
.dshm_dialog{box-sizing:border-box;width:100%;max-width:min(560px,100%);max-height:min(82vh,calc(100vh - 16px));overflow:auto;display:flex;flex-direction:column;gap:10px;padding:18px 20px;border-radius:var(--dsw-radius-xl);border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-label-primary);box-shadow:0 12px 40px rgba(0,0,0,.28)}
/* 内容窗（嵌一整页）：宽高都自适应——最宽 1040、再宽跟着视口收；高取视口的 88%，
   矮屏上让出遮罩留白。旧版写死 82vh + 1040px，小窗口和大屏都不合适。
   顶部留白收到 6px：窗口按钮已经搬进页面顶栏，外壳这层只留一圈薄边。 */
.dshm_dialogWide{max-width:min(1040px,100%);height:min(88vh,900px);max-height:calc(100vh - 16px);overflow:hidden;padding:6px;gap:0}
/* 空的说明行不占位：只有在浏览器被拦这类真要说话时才撑开一行。 */
.dshm_dialogNote:empty{display:none}
.dshm_dialogWide .dshm_frameWrap{flex:1;min-height:0;display:flex;position:relative}
.dshm_frame{flex:1;min-height:0;width:100%;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
/* 加载提示由内嵌页就绪回执撤掉，不能只凭 iframe load。 */
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
/* 整页嵌入窗的外壳关闭角标：页面顶栏出不来（加载失败）时也能收起这一窗。 */
.dshm_shellClose{position:absolute;top:10px;right:10px;z-index:1;width:32px;height:32px;padding:0;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-label-primary);font-size:18px;line-height:1;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.dshm_shellClose:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshm_shellClose:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
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
/* 侧边栏图标开关：沿用卡片里的字号与描边，不开第二种控件语言。 */
.dshm_iconRow{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px;line-height:20px}
.dshm_iconSwitch{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;line-height:18px;min-width:48px;padding:3px 10px}
.dshm_iconSwitch[aria-checked="true"]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:var(--dsw-alias-bg-layer-1)}
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
        const failed = new Error(String((error && error.message) || error));
        failed.code = 'network-request-failed';
        throw failed;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(errorText(body, response.status));
        error.status = response.status;
        const code = body && body.error && typeof body.error === 'object' ? body.error.code : '';
        error.code = typeof code === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(code) ? code : `http-${response.status}`;
        throw error;
      }
      return body;
    }

    const postJson = (path, payload) => call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });

    /* ── 就地反馈：不经过 AI 工具，直接 POST 公开接口 ──────────────────────────
     * 诊断窗里点一颗按钮就能交。只带插件自己拿得到的诊断文本；不读任意本地文件、
     * 不读密钥、不读会话内容。没配对手机也能交：device_id 用本机持久随机 id，
     * 受影响手机的字段留空，source 固定 plugin，绝不伪造安卓 / iOS / extension。
     */
    const FEEDBACK_URL = 'https://app.wnluo.com/api/sdk/feedback';
    const FEEDBACK_DEVICE_ID_KEY = 'dsh-mobile-plugin.feedback.deviceId';
    const FEEDBACK_TIMEOUT_MS = 30000;
    const feedbackSubmissionIds = new Map();

    function feedbackRandomId() {
      const webCrypto = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
      if (webCrypto && typeof webCrypto.randomUUID === 'function') return webCrypto.randomUUID();
      return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
    }

    function feedbackDeviceId() {
      try {
        const saved = localStorage.getItem(FEEDBACK_DEVICE_ID_KEY);
        if (saved) return saved;
        const id = feedbackRandomId();
        localStorage.setItem(FEEDBACK_DEVICE_ID_KEY, id);
        return id;
      } catch {
        return feedbackRandomId();
      }
    }

    /** 同一条反馈重试复用同一个 submission_id。 */
    function feedbackSubmissionIdOf(text) {
      if (!feedbackSubmissionIds.has(text)) feedbackSubmissionIds.set(text, feedbackRandomId());
      return feedbackSubmissionIds.get(text);
    }

    /**
     * 就地反馈附件的诊断文本：只放插件自己认得的固定字段。原始错误串、面板地址与 UA
     * 只留在「复制诊断信息」那份给人看的全文里，不随附件出门。
     */
    function feedbackDiagnosisText({ version, stage, code, scope, error_code }) {
      return [
        'dsh-mobile-plugin feedback',
        `source=plugin`,
        `component_id=dsh-mobile-plugin`,
        `component_version=${version || ''}`,
        `stage=${stage || ''}`,
        `code=${code === undefined || code === null ? '' : String(code)}`,
        `scope=${scope || ''}`,
        ...(error_code ? [`error_code=${error_code}`] : []),
      ].join('\n');
    }

    async function submitIssueFeedback({ summary, diagnosis, version, context }) {
      const submissionId = feedbackSubmissionIdOf(summary);
      const form = new FormData();
      for (const key of ['package_id', 'platform', 'version_name', 'build_number', 'model', 'system_version', 'channel']) {
        form.append(key, '');
      }
      form.append('device_id', feedbackDeviceId());
      form.append('content', summary);
      form.append('product_slug', 'dsh-mobile');
      form.append('source', 'plugin');
      form.append('component_id', 'dsh-mobile-plugin');
      form.append('component_version', version || '');
      form.append('submission_id', submissionId);
      form.append('context', JSON.stringify({
        source: 'plugin',
        product_slug: 'dsh-mobile',
        component_id: 'dsh-mobile-plugin',
        component_version: version || '',
        device_source: 'install',
        files: { name: 'diagnosis.txt', type: 'text/plain' },
        ...(context || {}),
      }));
      form.append('files', new Blob([diagnosis || ''], { type: 'text/plain' }), 'diagnosis.txt');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FEEDBACK_TIMEOUT_MS);
      try {
        const response = await fetch(FEEDBACK_URL, { method: 'POST', body: form, signal: controller.signal });
        let body = null;
        try { body = await response.json(); } catch { body = null; }
        if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`);
        const threadKey = body && body.data && body.data.thread_key;
        if (!threadKey) throw new Error('反馈接口没有返回线程编号');
        // 成功后清掉这条的 id：下一次同文案提交是新反馈，不能被服务端当成重试返回旧回执。
        // 失败时保留，重试仍沿用同一个 id；在途的重复点击此前已取到同一个号，不受影响。
        feedbackSubmissionIds.delete(summary);
        return { threadKey, submissionId };
      } catch (error) {
        if (error && error.name === 'AbortError') throw new Error('反馈提交超时，网络可能不通');
        throw error;
      } finally {
        clearTimeout(timer);
      }
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
        pluginPages: '电脑插件',
        pluginPagesEmpty: '这台电脑暂时没有可打开的插件页面。',
        pluginPagesHint: '这里打开电脑上的插件界面，不要求插件专门适配 App。',
        pluginPageMissing: '这个页面已经不可用，请返回列表重试。',
        nav: '移动端',
        heading: '移动端',
        cardPanel: '配置页面',
        openPanel: '打开配置页面',
        openHint: '配对、网络配置与插件更新都在这个页面里。',
        iconsTitle: '侧边栏图标',
        iconsHint: '选择桌面侧边栏底部显示哪颗入口；至少保留一颗。',
        iconPhone: '手机图标',
        iconComputer: '电脑图标',
        iconShown: '显示',
        iconHidden: '隐藏',
        iconKeepOne: '至少要保留一颗图标',
        iconSaveFailed: '保存图标设置失败',
        restartNoticeButton: '有新版本，需要重启 DSH 生效',
        restartNoticeTitle: '更新已就绪，需要重启一次 DSH',
        restartNoticeBody: '这次更新的实现部分已经生效；其中外壳那部分要重启一次 DSH 才能用上。你正在进行的对话不会因此丢失，可以挑方便的时候再重启。',
        restartNoticeHint: '重启方式：把 DSH 完整退出（不是只关窗口）再打开一次。',
        restartNoticeClose: '知道了',
        panelPending: '正在读取页面地址…',
        panelMissing: '宿主还没给出页面地址，稍后再打开这一页试试。',
        loadFailed: '读取宿主状态失败',
        openFailed: '打开配置页面失败',
        footerOpen: '打开移动端插件配置网页',
        footerRemoteOpen: '打开远程电脑',
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
        footerLoadMissing: '插件宿主侧没有加载：把 DSH 完整退出再打开一次；还不行就在插件市场重装一遍插件。',
        consoleTitle: '移动端插件控制台',
        remoteConsoleTitle: '远程电脑',
        consolePopupBlocked: '浏览器拦掉了新窗口，允许本站弹出窗口后再点一次。',
        consoleLoading: '正在载入控制台…',
        consoleFrameless: '控制台未能完成加载，请关闭后重新点图标，也可以在浏览器里打开。',
        diagTitleLoad: '打不开移动端配置页',
        diagTitleOpen: '打开配置页面失败',
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
        diagSummaryOpenFailed: '打开配置页面失败，所以没有跳转。',
        diagPopupBlocked: '浏览器拦掉了这个新窗口。允许本站打开弹窗后再点一次图标。',
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
      },
      en: {
        pluginPages: 'Computer plugins',
        pluginPagesEmpty: 'This computer has no plugin pages available to open.',
        pluginPagesHint: 'Open computer plugin interfaces here, including plugins without App adaptation.',
        pluginPageMissing: 'This page is no longer available. Return to the list and try again.',
        nav: 'Mobile',
        heading: 'Mobile',
        cardPanel: 'Configuration page',
        openPanel: 'Open the configuration page',
        openHint: 'Pairing, network settings and plugin updates all live on this page.',
        iconsTitle: 'Sidebar icons',
        iconsHint: 'Choose which shortcut sits at the bottom of the desktop sidebar; keep at least one.',
        iconPhone: 'Phone icon',
        iconComputer: 'Computer icon',
        iconShown: 'Shown',
        iconHidden: 'Hidden',
        iconKeepOne: 'Keep at least one icon',
        iconSaveFailed: 'Could not save icon settings',
        restartNoticeButton: 'Update installed — restart DSH to finish',
        restartNoticeTitle: 'Update ready — restart DSH once',
        restartNoticeBody: 'The implementation part of this update is already live; the shell part needs one DSH restart to take effect. Your running conversations are safe — restart whenever it suits you.',
        restartNoticeHint: 'To restart: quit DSH completely (not just the window) and open it again.',
        restartNoticeClose: 'Got it',
        panelPending: 'Reading the page address…',
        panelMissing: 'The host has not reported a page address yet — reopen this item in a moment.',
        loadFailed: 'Failed to read host status',
        openFailed: 'Could not open the configuration page',
        footerOpen: 'Open the mobile plugin configuration page',
        footerRemoteOpen: 'Open remote computers',
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
        footerLoadMissing: 'The plugin host half is not loaded: quit and reopen DSH; if that does not help, reinstall the plugin from the market.',
        consoleTitle: 'Mobile plugin console',
        remoteConsoleTitle: 'Remote computers',
        consolePopupBlocked: 'The browser blocked the new window — allow pop-ups for this site and press again.',
        consoleLoading: 'Loading the console…',
        consoleFrameless: 'The console could not finish loading. Close this pane and press the icon again, or open it in a browser.',
        diagTitleLoad: 'Cannot open the mobile configuration page',
        diagTitleOpen: 'Could not open the configuration page',
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
        diagSummaryOpenFailed: 'Could not open the configuration page, so nothing was opened.',
        diagPopupBlocked: 'The browser blocked the new window. Allow pop-ups for this site, then press the icon again.',
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
      },
    };

    /**
     * 就地反馈另挂一份小字典：原 `DICT` 的键集被守卫逐条钉死，新增动作不再往里挤。
     * 中英各一份，与原字典同口径（locale 服务按命名空间注册 / 取词）。
     */
    const FEEDBACK_NS = 'settings.mobileRelay.feedback';
    const FEEDBACK_DICT = {
      zh: {
        send: '发送此问题',
        sending: '正在提交…',
        receipt: '已提交，反馈编号 {key}。请复制编号留档；这条先留在本机，不会写进 App 的反馈列表。',
        failed: '发送失败：{error}',
        copyKey: '复制编号',
        copied: '编号已复制。',
        copyFailed: '复制失败，请手动选中编号复制。',
      },
      en: {
        send: 'Send this issue',
        sending: 'Submitting…',
        receipt: 'Submitted. Feedback key {key}. Copy it for your records; this stays local first and is not written into the in-app feedback list.',
        failed: 'Could not send: {error}',
        copyKey: 'Copy key',
        copied: 'Key copied.',
        copyFailed: 'Copy failed; select the key and copy it manually.',
      },
    };

    /* ── 侧边栏图标选择（同一页共享） ────────────────────────────────────────
     * 设置卡和两颗图标各自物化，谁先谁后不定；选择放在这一份闭包里，开关一拨当场生效，
     * 不必等下一轮 20 秒的 /status。状态先到者写入；用户拨过之后，在途的旧状态不再覆盖
     * 他的选择（否则图标会先消失、再自己回来）。写盘失败时回滚并通知同一页的订阅者。
     */
    let footerIcons = { phone: true, computer: true };
    let footerIconsTouched = false;
    const footerIconWatchers = new Set();
    function setFooterIcons(next) {
      footerIcons = next;
      for (const watch of footerIconWatchers) watch(next);
    }
    function adoptFooterIcons(view) {
      if (footerIconsTouched || !view) return;
      const next = {
        phone: view.desktopPhoneIcon !== false,
        computer: view.desktopComputerIcon !== false,
      };
      if (footerIcons.phone === next.phone && footerIcons.computer === next.computer) return;
      setFooterIcons(next);
    }
    function watchFooterIcons(watch) {
      watch(footerIcons);
      footerIconWatchers.add(watch);
      return () => { footerIconWatchers.delete(watch); };
    }

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
    /**
     * 嵌在窗里的那一页对父窗口说的两句话：我还能不能继续轮询。
     *
     * **关窗必须让它真的停下来**：这一窗改成「收起不销毁」之后（见 `createDiagnosisDialog`
     * 的 `keep`），那一页仍然挂在 DOM 上，页内那几个 3 秒轮询不会自己停 —— 用户说的
     * 「关掉窗口就恢复正常」正是靠这一条维持的。iframe 跨源还好、跨源也被挡，所以这里按
     * 同源 `postMessage` 通知，页面那边听不到就照常按 `document.hidden` 判。
     */
    const PANEL_VISIBILITY = 'dsh-mobile-plugin:panel-visibility';
    const PANEL_STATE = 'dsh-mobile-plugin:panel-state';
    /** 内嵌页请外面那层窗做事：在浏览器里打开 / 关闭。按钮画在页面里，动作落在这里。 */
    const PANEL_ACTION = 'dsh-mobile-plugin:panel-action';
    const PANEL_LOAD_TIMEOUT_MS = 20000;

    /** 通知嵌着的那一页：现在看得见 / 看不见。拿不到窗口就静默跳过。 */
    function tellFrame(overlay, visible) {
      try {
        const frame = overlay && typeof overlay.querySelector === 'function'
          ? overlay.querySelector('iframe')
          : null;
        const win = frame && frame.contentWindow;
        if (!win || typeof win.postMessage !== 'function') return;
        win.postMessage({ type: PANEL_VISIBILITY, visible: Boolean(visible) }, '*');
      } catch {
        // 跨源（理论上不该发生：这一窗嵌的就是同源面板页）—— 页面自己按 document.hidden 判。
      }
    }

    function createDiagnosisDialog(doc) {
      let overlay = null;
      /** 底下那一句说明（复制结果就地改它，不重画整窗）。 */
      let noteEl = null;
      let escapeListener = null;
      let stopFrame = () => {};
      /**
       * 打开时把焦点移进这一窗、锁住背景滚动（并让背景 inert）；收起时原样还原。
       * 弹窗是 modal：不锁的话滚轮会把背后页面带着滚，Tab 也会跑到背景里。
       */
      let chromePrev = null;
      const focusablesOf = (root) => {
        if (!root || typeof root.querySelectorAll !== 'function') return [];
        try {
          return Array.from(root.querySelectorAll(
            'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),iframe,[tabindex]:not([tabindex="-1"])',
          ));
        } catch {
          return [];
        }
      };
      const trapTab = (event) => {
        if (!event || event.key !== 'Tab') return;
        const list = focusablesOf(overlay);
        if (list.length === 0) { if (typeof event.preventDefault === 'function') event.preventDefault(); return; }
        const active = doc.activeElement;
        const inside = overlay && typeof overlay.contains === 'function' ? overlay.contains(active) : false;
        if (event.shiftKey && (active === list[0] || !inside)) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          try { list[list.length - 1].focus(); } catch { /* ignore */ }
        } else if (!event.shiftKey && (active === list[list.length - 1] || !inside)) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          try { list[0].focus(); } catch { /* ignore */ }
        }
      };
      const applyChrome = () => {
        const body = doc.body;
        const first = !chromePrev;
        if (first) {
          chromePrev = {
            focus: doc.activeElement || null,
            overflow: body && body.style ? body.style.overflow : '',
            inert: [],
          };
          // 背景 inert：挡掉 Tab / 指针落到遮罩后的页面上。不支持 inert 的老环境就只靠焦点陷阱。
          if (body) {
            for (const child of Array.from(body.children || [])) {
              // 不要 inert 另一扇已打开的弹窗（它自己有壳），只 inert 背景页面。
              if (child === overlay || ('getAttribute' in child && child.getAttribute(DIAG_MARK) !== null)) continue;
              if (!('inert' in child)) continue;
              try { child.inert = true; chromePrev.inert.push(child); } catch { /* ignore */ }
            }
          }
        }
        if (body && body.style) body.style.overflow = 'hidden';
        if (overlay && typeof overlay.addEventListener === 'function' && !overlay.__dshmTrap) {
          overlay.addEventListener('keydown', trapTab);
          overlay.__dshmTrap = true;
        }
        // 只在第一次打开时移入焦点：之后的重画（render 就地更新）不许把用户手上的焦点抢回来。
        if (!first) return;
        const list = focusablesOf(overlay);
        const target = list[0] || overlay;
        if (target === overlay && typeof overlay.setAttribute === 'function') overlay.setAttribute('tabindex', '-1');
        try { if (typeof target.focus === 'function') target.focus(); } catch { /* 无焦点环境 */ }
      };
      const releaseChrome = () => {
        if (!chromePrev) return;
        const prev = chromePrev;
        chromePrev = null;
        const body = doc.body;
        if (body && body.style) body.style.overflow = prev.overflow;
        for (const child of prev.inert || []) {
          try { child.inert = false; } catch { /* ignore */ }
        }
        try { if (prev.focus && typeof prev.focus.focus === 'function') prev.focus.focus(); } catch { /* ignore */ }
      };
      const hide = () => {
        releaseChrome();
        // 只有已确认就绪的页面保活；加载中或失败的页面，下次打开必须重新请求。
        if (overlay && overlay.__dshmFrameState !== 'ready') overlay.__dshmKeep = false;
        // **`keep` 的窗只收起、不销毁**：那一页是一份 1.4MB 的单文件产物，销毁掉下次
        // 打开就得整份重新下载 + 重新挂载，实测每次多花七百来毫秒 —— 而用户点一下手机图标
        // 只是想看一眼。留着它、隐藏起来，再打开是热的（实测 866ms → 123ms）。
        // 代价是那一页还占着内存、页内轮询也还在跑，所以下面必须通知它「看不见了」，
        // 让它自己把轮询停掉 —— 否则「关掉窗口就恢复正常」这条就不成立了。
        if (overlay && overlay.__dshmKeep) {
          if (typeof overlay.style === 'object') overlay.style.display = 'none';
          tellFrame(overlay, false);
          // 说明那一行**不清**：下次复用这一窗时还要往上写一句「已复制」之类。
        } else if (overlay) {
          stopFrame();
          if (typeof overlay.remove === 'function' && overlay.parentElement) overlay.remove();
          // 不保留的那种收起就是彻底不留：引用一并清掉，下次是全新一窗（Esc / 遮罩也重新挂）。
          overlay = null;
        }
        if (!(overlay && overlay.__dshmKeep)) noteEl = null;
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
        const frameSrc = spec.frame && spec.frame.src ? String(spec.frame.src) : '';
        // **同一页再开一次，直接把上一次那一窗亮出来**（见 `hide` 里的说明）：那一页还活着，
        // 重建等于把整份产物重新解析、React 重新挂载一遍。地址变了（换了页）才重建。
        if (overlay && overlay.__dshmKeep && overlay.__dshmSrc === frameSrc
          && overlay.__dshmFrameState === 'ready') {
          if (typeof overlay.style === 'object') overlay.style.display = '';
          if (spec.title) overlay.setAttribute('aria-label', spec.title);
          tellFrame(overlay, true);
          // 底下那句说明仍然按这一轮重置（`noteEl` 是上一轮那个节点，还挂着）。
          if (noteEl) noteEl.textContent = spec.note || '';
          if (typeof doc.addEventListener === 'function' && !escapeListener) {
            escapeListener = (event) => {
              if (event && (event.key === 'Escape' || event.key === 'Esc')) hide();
            };
            doc.addEventListener('keydown', escapeListener);
          }
          applyChrome();
          return overlay;
        }
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
        // 复用一个**已收起**（keep 且被 `hide` 设成 display:none）的窗时，必须显式把 display 复位。
        // 否则从控制台窗切到诊断窗会落进同一个 overlay、整窗仍是隐藏的 —— 点了没反应。
        if (typeof overlay.style === 'object') overlay.style.display = '';
        if (spec.title) overlay.setAttribute('aria-label', spec.title);
        // 「这一窗收起时不销毁」的记号（见 `hide`）。只有带整页 iframe 的那一窗需要它：
        // 那一页重建一次要重新解析一整份产物，而诊断窗那几行读数是现拼的，重建几乎不要钱。
        stopFrame();
        overlay.__dshmKeep = Boolean(spec.keep);
        overlay.__dshmSrc = frameSrc;
        overlay.__dshmFrameState = frameSrc ? 'loading' : '';
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
        // 内容窗（嵌一整页）：连标题也不画，留白收到最紧；窗口操作那两颗按钮在页面顶栏里，
        // 通过 PANEL_ACTION 消息交回外壳执行。诊断窗保持原样。
        const compact = Boolean(spec.compact && spec.frame && spec.frame.src);
        if (!compact && spec.title) card.appendChild(make('h3', 'dshm_dialogTitle', spec.title));
        if (spec.summary) card.appendChild(make('p', 'dshm_dialogLead', spec.summary));
        // 自定义内容区（入口那两块就挂在这儿）：节点由调用方造，这里只负责挂上。
        if (spec.body) card.appendChild(spec.body);
        // 内嵌一整页（控制台 / 远程电脑那一窗）：外壳里 `window.open` 不可靠，所以把页面嵌进来。
        // `src` 已经由调用方按同源地址算好（壳里是 `dsh-app://app/api/relay/panel/console`，
        // 网页里是同源 http）。
        //
        // load 只说明文档结束导航；空页、错误响应、脚本启动失败都不能算控制台就绪。
        if (spec.frame && spec.frame.src) {
          const wrap = make('div', 'dshm_frameWrap');
          const frame = doc.createElement('iframe');
          frame.className = 'dshm_frame';
          frame.setAttribute('title', spec.frame.title || spec.title || '');
          frame.setAttribute('loading', 'eager');
          const tip = make('p', 'dshm_frameTip', spec.frame.loading || '');
          const owner = overlay;
          const host = doc.defaultView || window;
          let timer = null;
          const clearTimer = () => {
            if (timer !== null) host.clearTimeout(timer);
            timer = null;
          };
          const update = (state, message) => {
            if (overlay !== owner) return;
            owner.__dshmFrameState = state;
            clearTimer();
            if (state === 'ready') {
              if (tip.parentElement) tip.remove();
              tellFrame(owner, !(owner.style && owner.style.display === 'none'));
            } else {
              tip.textContent = message || spec.frame.hint || '';
              if (!tip.parentElement) wrap.appendChild(tip);
            }
          };
          const onMessage = (event) => {
            if (!frame.contentWindow || event.source !== frame.contentWindow) return;
            const data = event.data;
            if (!data) return;
            if (data.type === PANEL_STATE) {
              if (data.state === 'ready' || data.state === 'error') update(data.state, data.message);
              return;
            }
            // 页面顶栏那两颗按钮只发动作、不碰窗本身；这里按同源 iframe 的来源校验后执行。
            if (data.type === PANEL_ACTION && typeof spec.onAction === 'function'
              && (data.action === 'open-browser' || data.action === 'close')) {
              spec.onAction(data.action);
            }
          };
          host.addEventListener('message', onMessage);
          frame.onload = () => {
            try {
              const root = frame.contentDocument && frame.contentDocument.documentElement;
              const state = root && root.getAttribute('data-dshm-panel-state');
              if (state === 'ready' || state === 'error') {
                update(state, root.getAttribute('data-dshm-panel-error'));
              }
            } catch { /* 被协议或浏览器阻断时，由超时提示与重试入口接管。 */ }
          };
          frame.onerror = () => update('error');
          timer = host.setTimeout(() => update('error'), PANEL_LOAD_TIMEOUT_MS);
          stopFrame = () => {
            clearTimer();
            host.removeEventListener('message', onMessage);
            frame.onload = null;
            frame.onerror = null;
            stopFrame = () => {};
          };
          frame.setAttribute('src', spec.frame.src);
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
        // 说明行总挂上（`:empty` 时 CSS 不让它占位）：弹窗被拦那句就地写进来，不重画整窗。
        const note = make('p', 'dshm_dialogNote', spec.note || '');
        card.appendChild(note);
        noteEl = note;
        if (!compact) {
          const actions = make('div', 'dshm_dialogActions');
          for (const action of spec.actions || []) {
            const button = make('button', action.primary ? 'dshm_btn dshm_btnPrimary' : 'dshm_btn', action.label);
            button.setAttribute('type', 'button');
            if (action.disabled) button.disabled = true;
            button.onclick = () => { void action.onClick(); };
            actions.appendChild(button);
          }
          card.appendChild(actions);
        }
        // compact（整页嵌入）没有外壳标题栏，平时靠页面顶栏那两颗按钮收起；可一旦嵌页加载失败，
        // 页面按钮出不来，就只剩 Esc 与点边缘。这里在外壳层固定放一颗关闭角标，任何时候都能收起。
        if (compact) {
          const close = make('button', 'dshm_shellClose', '×');
          close.setAttribute('type', 'button');
          close.setAttribute('aria-label', spec.title || spec.frame.title || '关闭');
          close.onclick = () => hide();
          overlay.appendChild(close);
        }
        applyChrome();
        return overlay;
      };
      /**
       * 彻底销毁这一窗（连同嵌着的那一页）。
       *
       * `hide` 对带整页的窗是「收起、留着复用」，但**离开这一窗去浏览器**那一支不该留：
       * 用户已经不在这里看了，把那一页和一整份产物继续占着内存没有道理。
       */
      const dispose = () => {
        releaseChrome();
        stopFrame();
        if (overlay && typeof overlay.remove === 'function' && overlay.parentElement) overlay.remove();
        overlay = null;
        noteEl = null;
        if (escapeListener && typeof doc.removeEventListener === 'function') {
          doc.removeEventListener('keydown', escapeListener);
        }
        escapeListener = null;
      };
      /** 就地更新底下那一句说明（不重画整窗）。 */
      const note = (text) => {
        if (noteEl) noteEl.textContent = text === undefined ? '' : String(text);
      };
      return { open, hide, note, dispose };
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
        // 图标与入口那一句要用的现场：配了几台手机、链路有没有断。与上面三样同一条 `/status`，
        // 不多打一次接口 —— 那份读数本来就是「此刻这台宿主怎么样」。
        devices: value.devices && typeof value.devices === 'object' ? value.devices : null,
        fault: faultKeyOf(value),
        // 盘上的外壳跟跑着的不一样：这次更新动了外壳，要重启一次 DSH 才生效（见 `/api/relay/status`）。
        // 侧栏那颗入口据此临时换成「需要重启」的提醒。
        shellChanged: value.shellChanged === true,
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
     * 就是公网、反代子路径自带前缀，这才是对的。
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
     * 一次「打开配置页面」的完整拨号：取地址、把地址交出去。
     *
     * 地址优先用宿主给的 `panelUrl`，拿不到再用页面自己的同源地址（见 `sameOriginPanelUrl`）。
     * 读不到地址时补读一次：可能只是页面上那次读取还没回来，或者刚才网络抖了一下。
     *
     * 新窗口必须由调用方在**点击那一帧**开出来（`window.open('')`），这里只负责导航它；
     * 等接口回来再开会被弹窗拦截器吃掉。
     *
     * @returns {Promise<{ok: true, cancelled?: boolean, url: string}
     *   | {ok: false, missing: boolean, status: number, message: string}>}
     */
    async function openConfigurationPage({ view, loadStatus = 0, t, target = null, navigate = true }) {
      let state = readStatusView(view);
      const failed = (error) => ({
        ok: false,
        missing: false,
        status: Number(error && error.status) || 0,
        code: error && typeof error.code === 'string' ? error.code : '',
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
          return failed(error);
        }
        if (!state.panelUrl) {
          return { ok: false, missing: false, status: 0, code: 'panel-url-missing', message: t('panelMissing') };
        }
      }

      const url = state.panelUrl || sameOriginPanelUrl();
      if (!url) return { ok: false, missing: false, status: 0, code: 'panel-url-missing', message: t('panelMissing') };

      if (target) {
        target.location.href = url;
        return { ok: true, url };
      }
      // `navigate: false` = 只要地址，别开任何窗口：
      // 控制台那一窗是把这一页**嵌进来**，多开一个浏览器窗口等于点了就跳走。
      if (navigate === false) return { ok: true, url };
      if (!isWebPage(window)) {
        // 交回给页面导航：壳会把外部 http(s) 地址转给系统浏览器。
        window.location.href = url;
        return { ok: true, url };
      }
      const opened = typeof window.open === 'function' ? window.open(url, '_blank', 'noreferrer') : null;
      if (!opened) return { ok: false, missing: false, status: 0, code: 'popup-blocked', message: t('diagPopupBlocked') };
      return { ok: true, url };
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

    /**
     * 电脑图标（「显示器 + 底座」那一款）：24 画布描边，与手机图标同一套笔画粗细。
     * 屏幕 3→21、4.4→16.6，底下一条底座加中柱。与面板里那颗 `DesktopIcon` 同形，
     * 只是这里的手写 DOM 不走构建。它是远程电脑页的入口，与手机图标并排。
     */
    const COMPUTER_PATHS = [
      'M4.5 3.5h15A1.5 1.5 0 0 1 21 5v9.6A1.5 1.5 0 0 1 19.5 16.1h-15A1.5 1.5 0 0 1 3 14.6V5a1.5 1.5 0 0 1 1.5-1.5Z',
      'M9 20h6',
      'M12 16.5V20',
    ];
    /** 第二颗图标自己的记号：同一页面里出现第二份实现时，靠它摘掉上一颗（与手机那颗分开）。 */
    const REMOTE_MARK = 'data-dshm-remote-web';
    /** 两颗图标那只方框的记号与类名：谁先落位谁造盒子，另一颗认记号挂进来。 */
    const GROUP_MARK = 'data-dshm-footer-group';
    const GROUP_CLASS = 'dshm_footerGroup';
    /** 需要重启时挂在方框上的记号（CSS 据此藏起旁边那颗电脑图标）与那颗「提醒」按钮自己的记号。 */
    const RESTART_GROUP_ATTR = 'data-dshm-restart';
    const RESTART_ICON_ATTR = 'data-dshm-restart-icon';
    /**
     * 「需要重启」那颗图标（循环箭头那一款）：与手机/电脑同一套 24 画布描边。
     * 它不是入口，是一声提醒——点开弹一扇说明窗，告诉用户装好了但要重启一次 DSH。
     */
    const RESTART_PATHS = [
      'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8',
      'M21 3v5h-5',
      'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16',
      'M8 16H3v5',
    ];

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

    /** 造电脑图标：与手机图标同一套画布、描边与底色。 */
    function computerIcon(doc, size) {
      if (!doc || typeof doc.createElementNS !== 'function') return null;
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', String(size));
      svg.setAttribute('height', String(size));
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.7');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      for (const d of COMPUTER_PATHS) {
        const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
      }
      return svg;
    }

    /** 造「需要重启」那颗图标：循环箭头 + 右上角那颗告警红点（琥珀色由 `data-dshm-warn` 给）。 */
    function restartIcon(doc, size) {
      if (!doc || typeof doc.createElementNS !== 'function') return null;
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', String(size));
      svg.setAttribute('height', String(size));
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.7');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      for (const d of RESTART_PATHS) {
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

    /** 造那一颗手机按钮：28 点，与同一行里那几颗图标按钮同尺寸。 */
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

    /** 造那一颗电脑按钮：与手机按钮同尺寸，紧跟在它右边。 */
    function createRemoteFooterIcon(doc) {
      const anchor = doc.createElement('a');
      anchor.className = 'dshm_footAction';
      anchor.setAttribute(REMOTE_MARK, '');
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noreferrer');
      const icon = computerIcon(doc, PHONE_GLYPH_WIDE);
      if (icon) anchor.appendChild(icon);
      return anchor;
    }

    /**
     * 把「打开哪一页 / 现在是什么状态」同步到元素上。
     *
     * 没有地址时**不写 href**（没有地址可写，别挂死链），但**点击处理照样挂上**：那颗图标的
     * 点击会自己补读一次地址（见 `openConfigurationPage`）。别把 `onclick` 一起摘掉 ——
     * 摘了就是「点了完全没反应」。
     *
     * `tone` 三档：`''` 正常、`'warn'` 有问题但插件没坏（琥珀）、`'error'` 真故障（红）。
     * 换的只是记号与颜色，图形和尺寸一个像素都不动 —— 那一行是外壳的，动尺寸就会挤到别人。
     *
     * 地址与网络类别都由 effect 往上同步，组件重渲染不会把它丢掉。
     */
    function syncFooterIcon(node, { href, label, onClick, tone }) {
      node.setAttribute('aria-label', label);
      node.setAttribute('title', label);
      node.setAttribute('aria-disabled', 'false');
      if (tone === 'error') node.setAttribute(FOOTER_ALERT, '');
      else node.removeAttribute(FOOTER_ALERT);
      if (tone === 'warn') node.setAttribute(FOOTER_WARN, '');
      else node.removeAttribute(FOOTER_WARN);
      // 有地址时仍然写 `href`：普通链接照旧能中键 / 新标签打开。地址还没读到时才拦下来
      // 补读一次，见 `openPanel`。
      if (href) node.setAttribute('href', href);
      else node.removeAttribute('href');
      node.onclick = onClick;
    }

    /**
     * 按「要不要重启」把方框里那颗按钮的图形换掉：正常是手机图标，需要重启时换成循环箭头。
     * 只在状态真的变了时才重画图形（每次同步都重建会闪）。
     */
    function applyFootGlyph(doc, node, pending) {
      if (!node || node.__dshmPending === pending) return;
      node.__dshmPending = pending;
      for (const child of Array.from(node.children || [])) {
        if (child && typeof child.remove === 'function') child.remove();
      }
      if (pending) {
        node.setAttribute(RESTART_ICON_ATTR, '');
        const icon = restartIcon(doc, PHONE_GLYPH_WIDE);
        if (icon) node.appendChild(icon);
      } else {
        node.removeAttribute(RESTART_ICON_ATTR);
        const icon = phoneIcon(doc, PHONE_GLYPH_WIDE);
        if (icon) node.appendChild(icon);
      }
    }

    /**
     * 在设置那一行找（或造）那只包住两颗图标的方框，紧跟头像出口。
     *
     * 两颗图标是两个组件分别物化的，谁先谁后不定：先到的造盒子并插到出口后，后到的认记号
     * 挂进同一个盒子。认不出那一行（座位不在）就返回 null，两颗各自退回自己一行。
     */
    function ensureFooterGroup(doc) {
      const outlet = typeof doc.querySelector === 'function' ? doc.querySelector(FOOTER_ANCHOR) : null;
      const row = outlet && outlet.parentElement;
      if (!row || typeof row.insertBefore !== 'function') return null;
      // 只认「侧栏底部那个座位里的 launcher」：头像那块万一被外壳渲染到别处（设置面板里、
      // 以后的新位置），按出口插进去就插错地方了。
      if (typeof outlet.closest === 'function' && outlet.closest(FOOTER_SEAT) === null) return null;
      let group = typeof doc.querySelector === 'function' ? doc.querySelector(`[${GROUP_MARK}]`) : null;
      // 认出的盒子得真在这一行里：别处遗留的同名盒子（认错座位）不能拿来用。
      if (group && group.parentElement !== row) group = null;
      if (!group) {
        group = doc.createElement('span');
        group.className = GROUP_CLASS;
        group.setAttribute(GROUP_MARK, '');
        row.insertBefore(group, outlet.nextSibling);
      }
      return group;
    }

    /** 把手机图标放回方框里的第一位。返回是否真在设置那一行里。 */
    function ensureFooterIcon(doc, node) {
      const group = ensureFooterGroup(doc);
      if (!group) return false;
      const first = group.children.length ? group.children[0] : null;
      // 手机永远是第一颗：盒子先被电脑图标占住时也要插到它前面，两颗的先后与渲染顺序无关。
      if (node.parentElement === group && first === node) return true;
      group.insertBefore(node, first);
      return true;
    }

    /**
     * 把电脑图标放进方框、紧跟手机图标右边（第二颗）。
     *
     * 盒子由 `ensureFooterGroup` 统一找或造；手机永远是第一颗，所以这里 append 到末尾即可。
     * 两颗各由一个组件物化、先后不定：电脑先到时它是盒里唯一一颗，手机后到会插到它前面。
     */
    function ensureRemoteFooterIcon(doc, node) {
      const group = ensureFooterGroup(doc);
      if (!group) return false;
      if (node.parentElement === group && node === group.children[group.children.length - 1]) return true;
      group.insertBefore(node, null);
      return true;
    }

    /** 摘掉上一次物化留下的电脑图标（插件重装、同一页面里出现第二份实现）。 */
    function dropStaleRemoteIcons(doc) {
      if (!doc || typeof doc.querySelectorAll !== 'function') return;
      let stale = null;
      try {
        stale = doc.querySelectorAll(`[${REMOTE_MARK}]`);
      } catch {
        return;
      }
      for (const node of stale || []) {
        if (node && typeof node.remove === 'function') node.remove();
      }
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
     *   - `loopback` / `private` / `public`：都直接进入控制台，不再按来源分流。
     *
     * **打不开的时候不许「点了没反应」**：一律弹诊断窗——宿主与外壳各说了什么、用户自己
     * 能做的几步检查、能一键试的修复（重新装载 / 重读状态），以及一段可复制的读数。
     */
    /**
     * 「需要重启」的说明窗：一个常规应用内弹窗（复用与控制台同一套 `dshm_overlay`/`dshm_dialog`
     * 样式，不是另开网页），说清这次更新装好了、外壳那部分要重启一次 DSH 才生效、正在进行的
     * 对话不会丢，只放一颗「知道了」。**不做任何重启动作**——只是提醒，什么时候重启由用户定。
     */
    function openRestartNotice(t) {
      if (typeof document === 'undefined' || !document.body) return;
      const doc = document;
      // 同一页面只留一份：反复点不叠窗。
      let existing = null;
      try {
        existing = typeof doc.querySelector === 'function' ? doc.querySelector('[data-dshm-restart-notice]') : null;
      } catch {
        existing = null;
      }
      if (existing) return;
      const overlay = doc.createElement('div');
      overlay.className = 'dshm_overlay';
      overlay.setAttribute('data-dshm-restart-notice', '');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      const card = doc.createElement('div');
      card.className = 'dshm_dialog';
      const title = doc.createElement('h3');
      title.className = 'dshm_dialogTitle';
      title.textContent = t('restartNoticeTitle');
      const lead = doc.createElement('p');
      lead.className = 'dshm_dialogLead';
      lead.textContent = t('restartNoticeBody');
      const hint = doc.createElement('p');
      hint.className = 'dshm_dialogNote';
      hint.textContent = t('restartNoticeHint');
      const actions = doc.createElement('div');
      actions.className = 'dshm_dialogActions';
      const ok = doc.createElement('button');
      ok.className = 'dshm_btn dshm_btnPrimary';
      ok.setAttribute('type', 'button');
      ok.textContent = t('restartNoticeClose');
      let escape = null;
      const close = () => {
        try { if (overlay.parentElement) overlay.remove(); } catch { /* ignore */ }
        if (escape && typeof doc.removeEventListener === 'function') doc.removeEventListener('keydown', escape);
      };
      ok.onclick = close;
      overlay.addEventListener('click', (event) => {
        if (event && event.target === overlay) close();
      });
      card.addEventListener('click', (event) => {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      });
      if (typeof doc.addEventListener === 'function') {
        escape = (event) => {
          if (event && (event.key === 'Escape' || event.key === 'Esc')) close();
        };
        doc.addEventListener('keydown', escape);
      }
      actions.appendChild(ok);
      card.appendChild(title);
      card.appendChild(lead);
      card.appendChild(hint);
      card.appendChild(actions);
      overlay.appendChild(card);
      doc.body.appendChild(overlay);
    }

    function MobileWebEntry({ wide, t, tf }) {
      /** null = 还没问到；'' = 问到了但宿主没给地址（老版本或还没起来）。 */
      const [url, setUrl] = useState(null);
      /** 面板地址落在哪类网络上：`loopback` / `private` / `public`（宿主算好给的）。 */
      const [panelScope, setPanelScope] = useState('');
      /** 最近一次读状态失败的原因（`null` = 没失败过）；`status: 404` = 实现那一半没装载。 */
      const [problem, setProblem] = useState(null);
      /** 链路报错的键（`footerTunnelBad` / `footerSidecarBad`）；`''` = 没报错。 */
      const [fault, setFault] = useState('');
      /** 标题上那句「现在什么情况」（几台设备、多久没连过）；读不到现场时是空串。 */
      const [hint, setHint] = useState('');
      /** 盘上外壳改过、要重启一次 DSH 才生效：这时这颗入口临时变成「需要重启」的提醒。 */
      const [restartPending, setRestartPending] = useState(false);
      /** 展开态是否已经插进设置那一行。插不上就自己占一行。 */
      const [anchored, setAnchored] = useState(true);
      /** 用户在设置卡上有没有把这颗收起来；收起来时连插入的 DOM 一起撤掉。 */
      const [visible, setVisible] = useState(footerIcons.phone);
      useEffect(() => watchFooterIcons((next) => setVisible(next.phone)), []);
      const nodeRef = useRef(null);
      const dialogRef = useRef(null);
      useEffect(() => () => {
        if (dialogRef.current) dialogRef.current.dispose();
        dialogRef.current = null;
      }, []);
      /**
       * 文案在这里取、并把结果塞进下面那些 effect 的依赖里。
       *
       * 不能只依赖 `t` 本身：它是 `ctx.locale.bind(NS)` 绑出来的一个稳定函数，切语言时
       * 引用不变，effect 就不会重跑，插进那一行的那颗按钮会一直挂着旧的标题。
       */
      const openLabel = t('footerOpen');
      const pendingLabel = t('footerPending');
      const loadMissingLabel = t('footerLoadMissing');
      /** 「需要重启」那颗按钮的无障碍名字／悬停提示。 */
      const restartLabel = t('restartNoticeButton');
      /**
       * 宿主那一半没装载（`/status` 404）：点了也打不开、重装前谁也修不好，所以这一种是
       * **真故障**，那颗图标转红告警；标题也换成更具体的那一句。地址只是还没读到（后台
       * 重试中），都不是插件坏了，不红。
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
       * 拉一次宿主状态，把地址 / 分类 / 失败原因同步进 state。
       *
       * 返回值给调用方用（诊断窗要拿最新那一份读数，不能读组件里那份可能还没更新的状态）：
       * `{ ok: true, status }` 或 `{ ok: false, problem }`。
       */
      async function refreshStatus() {
        try {
          const next = await call('/status');
          const view = next && typeof next === 'object' ? next : {};
          adoptFooterIcons(view);
          const summary = readStatusView(view);
          setUrl(summary.panelUrl);
          setPanelScope(summary.panelScope);
          setFault(summary.fault);
          setHint(hintOf(summary));
          setProblem(null);
          setRestartPending(summary.shellChanged === true);
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
          setRestartPending(false);
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
       * 只是现在连不通。地址还没读到（后台重试中）也算正常态：
       * 那种情况每开一次页面都会出现，一有它就变脸等于天天报假警。
       */
      function footerState() {
        if (restartPending) return { tone: 'warn', label: restartLabel };
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
       * 点下去做什么。
       *
       * **点了先在这一页弹一屏**（不是直接跳浏览器）：用户遇到问题时最缺的不是
       * 跳过去，而是「它现在到底哪一环断了」——启动、装载、隧道、旁挂进程、自检全都在那一屏
       * 里，比一个打不开的页面有用。跳转本身没取消，挪进了那一屏里的一颗按钮。
       *
       * 那一屏的内容是网页版的 `/api/relay/panel/console`（React 写的，改完刷新就见效），
       * 这里只把同源地址算出来嵌进去。控制面现在不按来源拦，嵌进来的就是面板本身。
       *
       * 三种走不通的情况一律回到诊断窗（外壳里 `window.open` 不可靠、宿主那一半没装载、
       * 窗口开不出来）—— 不许「点了没反应」。
       */
      function openPanel(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        // 桌面壳（`dsh-app://app`）里不嵌：往自定义协议页里塞一条 http(s) iframe，多半被
        // 当成混合内容挡掉，用户看到的是一窗空白。那种环境仍走「交给系统浏览器」那条老路
        //（`navigate` 默认 true，壳的 `will-navigate` 会把它转给系统浏览器）。
        void (async () => {
          const outcome = await openConsole({
            view: { panelUrl: url || '', panelScope },
            loadStatus: problem ? problem.status : 0,
            t,
          });
          if (outcome.ok) return;
          // 宿主那一半压根没装载：那是一屏「装完没重启」，不是这一屏能修的。
          if (outcome.missing) {
            void openDiagnosis('load', { status: outcome.status || 404, message: (problem && problem.message) || '' });
            return;
          }
          void openDiagnosis('open', { status: outcome.status || 0, code: outcome.code || '', message: outcome.message });
        })();
      }

      /**
       * 把「控制台」那一屏画出来：标题 + 一颗「在浏览器里打开」+ 内嵌的调试页。
       *
       * 嵌的是同一台宿主吐的页面（同源），所以它读 `/api/relay/*` 和面板页一模一样，
       * 不需要 token、也不新增接口。`openConfigurationPage` 只确认地址可用（`target` 传 null，
       * 不导航任何地方），页面本身由下面这扇窗嵌进来。
       */
      async function openConsole({ view, loadStatus, t }) {
        if (typeof document === 'undefined') return { ok: false, missing: false, status: 0, code: 'panel-url-missing', message: t('panelMissing') };
        const outcome = await openConfigurationPage({ view, loadStatus, t, target: null, navigate: false });
        if (!outcome.ok) return outcome;
        const consolePage = panelPageUrlOf('console');
        if (!consolePage) return { ok: false, missing: false, status: 0, code: 'panel-url-missing', message: t('panelMissing') };
        const dialog = diagnosisDialog();

        /**
         * 那一页交给系统浏览器时打开的地址。
         *
         * 网页（`http(s)`）里用**同源推算**的地址（`panelPageUrlOf`）：公网 / 域名 / 反代
         * 子路径都能对上，宿主报的 `panelUrl` 反而常是 `127.0.0.1`，从公网打开的人点过去
         * 必然打不开。桌面壳里那条同源地址是 `dsh-app://`，系统浏览器不认，只能换用宿主
         * 报的绝对 http(s) 地址（`outcome.url`）。
         */
        const browserPageUrl = () => {
          if (isWebPage(window)) return consolePage;
          const root = String(outcome.url || '').replace(/\/console\/?$/, '').replace(/\/+$/, '');
          if (!/^https?:\/\//i.test(root)) return '';
          return root;
        };
        const openBrowser = () => {
          const url = browserPageUrl();
          if (!url) {
            dialog.note(t('consolePopupBlocked'));
            return;
          }
          // 桌面壳里 `window.open` 一律被拒：交给页面导航，由壳的 `will-navigate`
          // 把外部 http(s) 地址转给系统浏览器（与 `openConfigurationPage` 同一条路）。
          if (!isWebPage(window)) {
            window.location.href = url;
            dialog.dispose();
            return;
          }
          if (typeof window === 'undefined' || typeof window.open !== 'function') return;
          const opened = window.open(url, '_blank', 'noreferrer');
          // 开出去了就彻底销毁：用户已经不在这一窗里看了，没必要继续留着一整页。
          if (opened) dialog.dispose();
          else dialog.note(t('consolePopupBlocked'));
        };

        /**
         * 点一下手机图标，**直接就是这一屏控制台**：没有中间入口。调试页 2026-11-17 删了，
         * 窗口操作那两颗按钮也搬进了页面顶栏；这一窗的外壳只剩一圈薄边，不占嵌页的地方。
         */
        dialog.open({
          title: t('consoleTitle'),
          wide: true,
          compact: true,
          // 收起时不销毁（见 `hide`）：再点一次图标就是热的，省掉一次整页重载。
          keep: true,
          frame: {
            src: consolePage,
            title: t('consoleTitle'),
            loading: t('consoleLoading'),
            hint: t('consoleFrameless'),
          },
          // 窗口操作由页面顶栏那两颗按钮发消息过来；外壳这边只认消息、执行，不画按钮。
          onAction: (action) => {
            if (action === 'open-browser') openBrowser();
            else if (action === 'close') dialog.hide();
          },
        });
        return { ok: true };
      }

      /**
       * 把这一轮的现场摆成一屏**能自己动手**的自查。
       *
       * `kind` 两种：`'load'`（连状态都读不到，所以没有地址可去）、`'open'`（地址读到了但
       * 页面没开成）。前者的首要原因是「装完没重启」，后者先重试再看反代。
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
        };
        let current = failure || problem || null;
        let half = null;
        let submittedKey = '';
        let sendingFeedback = false;

        const title = kind === 'open' ? t('diagTitleOpen') : t('diagTitleLoad');
        const closeAction = { label: t('diagClose'), onClick: () => view.hide() };
        const adopt = (status) => {
          const next = status && typeof status === 'object' ? status : {};
          snapshot.url = typeof next.panelUrl === 'string' ? next.panelUrl : '';
          snapshot.scope = typeof next.panelScope === 'string' ? next.panelScope : 'unknown';
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
          actions.push({
            label: submittedKey ? tf('copyKey') : (sendingFeedback ? tf('sending') : tf('send')),
            onClick: () => {
              if (submittedKey) {
                void copyDiagnosisText(document, submittedKey).then((ok) => render(ok
                  ? `${tf('receipt', { key: submittedKey })} ${tf('copied')}`
                  : tf('copyFailed')));
              } else {
                void sendFeedback();
              }
            },
          });
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

        /** 把诊断读数作 text/plain 附件直接提交，回来就地给出线程 key。 */
        async function sendFeedback() {
          if (sendingFeedback) return;
          sendingFeedback = true;
          let note = tf('sending');
          try {
            const safeFacts = {
              version: half && half.version ? String(half.version) : '',
              stage: kind,
              code: current && Number.isFinite(current.status) ? String(current.status) : '',
              scope: snapshot.scope,
              error_code: current && typeof current.code === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(current.code) ? current.code : '',
            };
            const result = await submitIssueFeedback({
              summary: `${title}\n${summaryOf()}`,
              diagnosis: feedbackDiagnosisText(safeFacts),
              version: safeFacts.version,
              context: { title, ...safeFacts },
            });
            submittedKey = result.threadKey;
            note = tf('receipt', { key: submittedKey });
          } catch (error) {
            note = tf('failed', { error: String((error && error.message) || error) });
          } finally {
            sendingFeedback = false;
          }
          render(note);
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
        const load = async () => {
          if (!alive) return;
          // 拿到地址后**不停止**刷新：设备台数、告警、需要重启这些都要跟着变。低频轮询就够，
          // 页面不可见时跳过；重新可见时立刻补一次，别等下一拍。
          await refreshStatus();
        };
        void load();
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return;
          void load();
        }, FOOTER_URL_RETRY_MS);
        const onVisible = () => {
          if (typeof document !== 'undefined' && document.hidden) return;
          void load();
        };
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisible);
        }
        return () => {
          alive = false;
          clearInterval(timer);
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisible);
          }
        };
      }, []);

      useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const doc = document;
        // 窄条那一行塞不下第二颗：不插，自己占一行。用户在设置卡上收起来时同样不插，
        // 走下面的清理把已插的那颗摘掉；观察器也不能再把它捡回来。
        if (!wide || !visible) {
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
          // 需要重启时这颗不做入口，改成「提醒」：点开弹说明窗，别让人以为还能当链接点走。
          const onClick = restartPending ? () => openRestartNotice(t) : openPanel;
          syncFooterIcon(node, { href: restartPending ? '' : url, label: state.label, onClick, tone: state.tone });
          applyFootGlyph(doc, node, restartPending);
          // 方框上的记号改由这颗同步：置上它，旁边的电脑图标由 CSS 暂时藏起，方框里只剩提醒。
          const group = node.parentElement;
          try {
            if (group && typeof group.getAttribute === 'function' && group.getAttribute(GROUP_MARK) !== null) {
              if (restartPending) group.setAttribute(RESTART_GROUP_ATTR, '');
              else group.removeAttribute(RESTART_GROUP_ATTR);
            }
          } catch {
            // 认不出方框就还原成两颗各占位，不因为这一条把图标弄丢。
          }
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
                setAnchored(visible ? ensureFooterIcon(doc, node) : false);
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
      }, [wide, visible, url, openLabel, loadMissingLabel, pendingLabel, problem, panelScope, hint, fault, restartPending, restartLabel]);

      // 窄条，或者这一版外壳里认不出那一行：自己占一行，入口不能因为认不出位置就消失。
      // 收起来的那一颗例外：它这一页里根本不该再有入口。
      if (!visible) return null;
      if (!wide || !anchored) {
        const state = footerState();
        const glyphPaths = restartPending ? RESTART_PATHS : PHONE_PATHS;
        return h('a', {
          className: 'dshm_footAction dshm_footActionRail',
          href: restartPending ? undefined : (url || undefined),
          target: '_blank',
          rel: 'noreferrer',
          'aria-label': state.label,
          title: state.label,
          'aria-disabled': 'false',
          [FOOTER_ALERT]: state.tone === 'error' ? '' : undefined,
          [FOOTER_WARN]: state.tone === 'warn' ? '' : undefined,
          [RESTART_ICON_ATTR]: restartPending ? '' : undefined,
          onClick: restartPending ? () => openRestartNotice(t) : openPanel,
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
          ...glyphPaths.map((d) => h('path', { key: d, d })),
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
     * 侧边栏底部那颗电脑图标（远程电脑独立页的入口）。
     *
     * 与手机图标并排，共用同一套状态读数：地址与网络类别都从同一条 `/status` 来。它只是打开另一条面板页（`/api/relay/panel/remote`），所以没有
     * 手机图标那一套链路告警着色——这一颗是纯入口，状态色交给旁边那颗去说。
     *
     * 点下去和手机图标一样弹一扇内嵌窗（不是跳走），不再按来源分流。打不开时落到诊断窗，
     * 不许「点了没反应」。
     */
    function RemoteWebEntry({ wide, t, tf }) {
      const [url, setUrl] = useState(null);
      const [panelScope, setPanelScope] = useState('');
      const [problem, setProblem] = useState(null);
      const [anchored, setAnchored] = useState(true);
      const [visible, setVisible] = useState(footerIcons.computer);
      useEffect(() => watchFooterIcons((next) => setVisible(next.computer)), []);
      const nodeRef = useRef(null);
      const dialogRef = useRef(null);
      useEffect(() => () => {
        if (dialogRef.current) dialogRef.current.dispose();
        dialogRef.current = null;
      }, []);

      const openLabel = t('footerRemoteOpen');
      const pendingLabel = t('footerPending');

      /** 拉一次状态；电脑图标只要地址，不碰设备数与链路告警。 */
      async function refreshStatus() {
        try {
          const next = await call('/status');
          const view = readStatusView(next);
          adoptFooterIcons(next);
          setUrl(view.panelUrl);
          setPanelScope(view.panelScope);
          setProblem(null);
          return { ok: true, status: next };
        } catch (error) {
          const failed = {
            status: Number(error && error.status) || 0,
            message: String((error && error.message) || error),
          };
          setProblem(failed);
          return { ok: false, problem: failed };
        }
      }

      /** 诊断窗单例：与手机图标那扇分开，两扇互不顶掉。 */
      function diagnosisDialog() {
        if (!dialogRef.current) {
          dialogRef.current = createDiagnosisDialog(typeof document !== 'undefined' ? document : null);
        }
        return dialogRef.current;
      }

      /** 打不开时落到诊断窗：宿主与外壳各说了什么、能一键试的重试与复制读数。 */
      async function openDiagnosis(failure) {
        if (typeof document === 'undefined') return;
        const view = diagnosisDialog();
        let current = failure || problem || null;
        let half = null;
        let submittedKey = '';
        let sendingFeedback = false;
        const snapshot = {
          url: typeof url === 'string' ? url : '',
          scope: panelScope || 'unknown',
        };
        const closeAction = { label: t('diagClose'), onClick: () => view.hide() };
        const readHalf = async () => {
          try {
            const picture = await call(HOST_HALF_ENDPOINT);
            half = picture && picture.half && typeof picture.half === 'object' ? picture.half : { unavailable: true };
          } catch {
            half = { unavailable: true };
          }
        };
        const facts = () => {
          const rows = [];
          if (current) {
            rows.push({ key: 'host_returned', label: t('diagFactReturned'), value: current.message });
            rows.push({ key: 'http_status', label: t('diagFactStatus'), value: current.status ? String(current.status) : '—' });
          }
          rows.push({ key: 'panel_url', label: t('diagFactPanelUrl'), value: snapshot.url || '—' });
          rows.push({ key: 'panel_scope', label: t('diagFactScope'), value: snapshot.scope });
          if (half && half.lastError) rows.push({ key: 'host_last_error', label: t('diagFactReason'), value: half.lastError });
          return rows;
        };
        async function sendFeedback() {
          if (sendingFeedback) return;
          sendingFeedback = true;
          let note = tf('sending');
          try {
            const safeFacts = {
              version: half && half.version ? String(half.version) : '',
              stage: 'open',
              code: current && Number.isFinite(current.status) ? String(current.status) : '',
              scope: snapshot.scope,
              error_code: current && typeof current.code === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(current.code) ? current.code : '',
            };
            const result = await submitIssueFeedback({
              summary: `${t('diagTitleOpen')}\n${current ? t('diagSummaryOpenFailed') : ''}`,
              diagnosis: feedbackDiagnosisText(safeFacts),
              version: safeFacts.version,
              context: { title: t('diagTitleOpen'), ...safeFacts },
            });
            submittedKey = result.threadKey;
            note = tf('receipt', { key: submittedKey });
          } catch (error) {
            note = tf('failed', { error: String((error && error.message) || error) });
          } finally {
            sendingFeedback = false;
          }
          render(note);
        }
        const feedbackAction = () => ({
          label: submittedKey ? tf('copyKey') : (sendingFeedback ? tf('sending') : tf('send')),
          onClick: () => {
            if (submittedKey) {
              void copyDiagnosisText(document, submittedKey).then((ok) => render(ok
                ? `${tf('receipt', { key: submittedKey })} ${tf('copied')}`
                : tf('copyFailed')));
            } else {
              void sendFeedback();
            }
          },
        });
        const render = (note) => {
          view.open({
            title: t('diagTitleOpen'),
            summary: current ? t('diagSummaryOpenFailed') : t('diagChecking'),
            factsHeading: t('diagHeadingFacts'),
            facts: facts(),
            actions: [feedbackAction(), closeAction],
            note,
          });
        };
        view.open({ title: t('diagTitleOpen'), actions: [closeAction] });
        await readHalf();
        render(null);
      }

      /**
       * 点电脑图标：弹一扇内嵌远程电脑页的窗。
       *
       * 与手机图标走的是同一条 `openConfigurationPage` 拨号（只确认地址可用），
       * 区别只在内嵌的是 `/remote` 那一页。新窗口不在这里开：`navigate:false` 只确认地址，
       * 页面本身嵌进诊断窗的 iframe。
       */
      function openRemote(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        void (async () => {
          const outcome = await openConfigurationPage({
            view: { panelUrl: url || '', panelScope },
            loadStatus: problem ? problem.status : 0,
            t,
            target: null,
            navigate: false,
          });
          if (!outcome.ok) {
            if (outcome.missing) void openDiagnosis({ status: outcome.status || 404, message: '' });
            else void openDiagnosis({ status: outcome.status || 0, code: outcome.code || '', message: outcome.message });
            return;
          }
          const remotePage = panelPageUrlOf('remote');
          if (!remotePage) {
            void openDiagnosis({ status: 0, message: t('panelMissing') });
            return;
          }
          const dialog = diagnosisDialog();
          const browserOpen = () => {
            if (typeof window === 'undefined' || typeof window.open !== 'function') return;
            const opened = window.open(remotePage, '_blank', 'noreferrer');
            if (opened) dialog.dispose();
            else dialog.note(t('consolePopupBlocked'));
          };
          dialog.open({
            title: t('remoteConsoleTitle'),
            wide: true,
            compact: true,
            keep: true,
            frame: { src: remotePage, title: t('remoteConsoleTitle'), loading: t('consoleLoading') },
            onAction: (action) => {
              if (action === 'open-browser') browserOpen();
              else if (action === 'close') dialog.hide();
            },
          });
        })();
      }

      // 页面一打开就问一次地址：点下去要么进窗、要么先开窗再读。取到就停，没取到后台重试。
      useEffect(() => {
        let alive = true;
        const load = async () => {
          if (!alive) return;
          // 拿到地址后**不停止**刷新：设备台数、告警、需要重启这些都要跟着变。低频轮询就够，
          // 页面不可见时跳过；重新可见时立刻补一次，别等下一拍。
          await refreshStatus();
        };
        void load();
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return;
          void load();
        }, FOOTER_URL_RETRY_MS);
        const onVisible = () => {
          if (typeof document !== 'undefined' && document.hidden) return;
          void load();
        };
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisible);
        }
        return () => {
          alive = false;
          clearInterval(timer);
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisible);
          }
        };
      }, []);

      // 展开态：纯 DOM 插进设置那一行，紧跟手机图标；认不出位置就退回自己一行。
      // 收起来时不插，也不让观察器把它捡回来（已插的那颗在 effect 清理里摘掉）。
      useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const doc = document;
        if (!wide || !visible) {
          setAnchored(false);
          return undefined;
        }
        let node = nodeRef.current;
        if (!node) {
          try {
            dropStaleRemoteIcons(doc);
            node = createRemoteFooterIcon(doc);
          } catch {
            node = null;
          }
          nodeRef.current = node;
        }
        if (!node) {
          setAnchored(false);
          return undefined;
        }
        const sync = () => {
          node.setAttribute('aria-label', openLabel);
          node.setAttribute('title', openLabel);
          node.setAttribute('aria-disabled', 'false');
          if (url) node.setAttribute('href', url);
          else node.removeAttribute('href');
          node.onclick = openRemote;
        };
        let attached = false;
        try {
          attached = ensureRemoteFooterIcon(doc, node);
          sync();
        } catch {
          attached = false;
        }
        setAnchored(attached);
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
                setAnchored(visible ? ensureRemoteFooterIcon(doc, node) : false);
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
      }, [wide, visible, url, openLabel, problem, panelScope]);

      // 窄条，或认不出那一行：自己占一行，入口不能因为认不出位置就消失。
      if (!visible) return null;
      if (!wide || !anchored) {
        return h('a', {
          className: 'dshm_footAction dshm_footActionRail',
          href: url || undefined,
          target: '_blank',
          rel: 'noreferrer',
          'aria-label': openLabel,
          title: openLabel,
          'aria-disabled': 'false',
          onClick: openRemote,
        }, h('svg', {
          viewBox: '0 0 24 24',
          width: PHONE_GLYPH_RAIL,
          height: PHONE_GLYPH_RAIL,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        }, COMPUTER_PATHS.map((d) => h('path', { key: d, d }))));
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

    /** 列实际页面注册，不把工具、装饰槽或后台插件当作可打开的页面。 */
    function pluginPageRows(ctx) {
      const slots = ctx.slots;
      if (typeof slots.entries !== 'function') return [];
      const rows = [];
      const add = (kind, id, label) => {
        if (!id || id === 'mobile' || id === 'dsh-mobile-plugins' || id === 'conversation') return;
        if (kind === 'settings' && ['general', 'account', 'models', 'agent-presets', 'archived-sessions', 'plugins'].includes(id)) return;
        const value = typeof label === 'function' ? label() : label;
        rows.push({ key: `${kind}:${id}`, kind, id, label: value || id });
      };
      for (const entry of slots.entries('settings.section')) add('settings', entry.options.id, entry.options.label);
      const nav = slots.entries('sidebar.panellist');
      for (const entry of slots.entries('main')) {
        const id = entry.options.key;
        const label = nav.find((row) => row.options.id === id)?.options.label;
        if (id !== 'plugins') add('panel', id, label);
      }
      for (const entry of slots.entries('plugins.bundle.config')) add('bundle', entry.options.key, entry.options.label);
      for (const entry of slots.entries('plugins.row.config')) add('row', entry.options.key, entry.options.label);
      return rows.sort((a, b) => a.label.localeCompare(b.label));
    }

    /** 导航既有页面，复用其共享 store，保留页面自己的注入、权限与生命周期。 */
    function openPluginPage(ctx, row) {
      if (!pluginPageRows(ctx).some((entry) => entry.key === row.key)) return false;
      const layout = ctx.get('layout');
      if (!layout) return false;
      if (row.kind === 'panel') {
        layout.selectPanel(row.id);
        return true;
      }
      if (row.kind === 'settings') {
        const entry = ctx.slots.entries('sidebar.settings')[0];
        const actions = entry?.store?.create().actions;
        if (typeof actions?.openSection !== 'function') return false;
        actions.openSection(row.id);
        return true;
      }
      const navigation = ctx.get('pluginNavigation');
      if (typeof navigation?.openBundle !== 'function') return false;
      const [name, rowId] = row.id.split('#');
      navigation.openBundle(name);
      if (row.kind === 'row') {
        const entry = ctx.slots.entries('main').find((item) => item.options.key === 'plugins');
        const actions = entry?.store?.create().actions;
        if (typeof actions?.setView !== 'function') return false;
        actions.setView({ kind: 'row', name, rowId });
      }
      return true;
    }

    let pluginPageProblem = false;
    function PluginPages({ ctx, t }) {
      const [rows, setRows] = useState(() => pluginPageRows(ctx));
      const [problem, setProblem] = useState(() => pluginPageProblem);
      useEffect(() => {
        const failed = () => setProblem(true);
        window.addEventListener('dsh-mobile-plugin-missing', failed);
        return () => window.removeEventListener('dsh-mobile-plugin-missing', failed);
      }, []);
      useEffect(() => {
        const update = () => setRows(pluginPageRows(ctx));
        const offs = ['settings.section', 'main', 'sidebar.panellist', 'plugins.bundle.config', 'plugins.row.config']
          .map((name) => ctx.slots.subscribe(name, update));
        offs.push(ctx.locale.subscribe(update));
        update();
        return () => offs.forEach((off) => off());
      }, [ctx]);
      return h('section', { className: 'dshm_root', style: { padding: '16px', boxSizing: 'border-box', overflow: 'auto', height: '100%' } },
        h('h2', { className: 'dshm_heading' }, t('pluginPages')),
        h('p', { className: 'dshm_note' }, t('pluginPagesHint')),
        problem ? h('p', { className: 'dshm_error' }, t('pluginPageMissing')) : null,
        rows.length === 0 ? h('p', { className: 'dshm_note' }, t('pluginPagesEmpty')) : null,
        rows.map((row) => h('button', {
          key: row.key, type: 'button', className: 'dshm_btn',
          onClick: () => {
            pluginPageProblem = false;
            setProblem(false);
            window.location.hash = `#dsh-mobile-plugin=${encodeURIComponent(row.key)}`;
          },
        }, row.label)));
    }

    function installPluginPages(ctx, t) {
      if (typeof window === 'undefined' || typeof ctx.slots.entries !== 'function') return;
      ctx.effect(() => {
        let release = null;
        const route = () => {
          const hash = window.location.hash;
          const layout = ctx.get('layout');
          if (!layout) return;
          if (hash === '#dsh-mobile-plugins') {
            const shell = ctx.slots.entries('sidebar.settings')[0];
            shell?.store?.create().actions.close();
            layout.selectPanel('dsh-mobile-plugins');
          } else if (hash.startsWith('#dsh-mobile-plugin=')) {
            let key;
            try { key = decodeURIComponent(hash.slice('#dsh-mobile-plugin='.length)); } catch { return; }
            const row = pluginPageRows(ctx).find((item) => item.key === key);
            let opened = false;
            try { opened = Boolean(row && openPluginPage(ctx, row)); } catch { opened = false; }
            pluginPageProblem = !opened;
            if (!opened) {
              layout.selectPanel('dsh-mobile-plugins');
              window.dispatchEvent(new Event('dsh-mobile-plugin-missing'));
            }
          }
        };
        const activate = () => {
          if (window.location.hash !== '#dsh-mobile-plugins' && !window.location.hash.startsWith('#dsh-mobile-plugin=')) return;
          if (release) { route(); return; }
          release = ctx.inject(['layout'], (scope) => scope.slots.inject('main', () => {
            const off = scope.slots.register({ name: 'main', key: 'dsh-mobile-plugins', locale: NS, inject: () => ({ ctx, t }) }, PluginPages);
            route();
            return off;
          }));
        };
        activate();
        window.addEventListener('hashchange', activate);
        return () => { window.removeEventListener('hashchange', activate); if (typeof release === 'function') release(); };
      }, 'mobile-plugin: computer plugin pages');
    }

    /* ── 设置里的那一项「移动端」───────────────────────────────────────────
     * 设置里的「移动端」与侧边栏那颗图标进的是同一个页面、走同一条拨号链路（图标是快捷方式，
     * 这一张是设置里的正规入口）：介绍产品时说的入口就是「设置 → 移动端」，只留图标会让从
     * 网页版进来的人不知道配置在哪。
     *
     * 刻意只放轻量的设置：界面本体全在网页版里（A3-37），在这里再画一套等于长期维护第二套 UI，
     * 而两套迟早会打架。配置页卡只做两件事——说清配置在哪、把那一页开出来；开不出来就在卡上写
     * 原因。2026-11-17 用户要在这一页选侧边栏那两颗图标，才添了第二张小卡。
     */
    function MobileSettingsSection({ t }) {
      /** null = 还在问宿主；'' = 问到了但宿主没给地址（老版本或还没起来）。 */
      const [url, setUrl] = useState(null);
      const [scope, setScope] = useState('');
      /** `null` = 这一次没出错；否则 `{ kind: 'load' | 'open', message }`。 */
      const [failure, setFailure] = useState(null);
      /** 侧边栏两颗图标的选择，与那两颗图标共享同一份状态。 */
      const [icons, setIcons] = useState(footerIcons);
      const [iconError, setIconError] = useState('');
      useEffect(() => watchFooterIcons(setIcons), []);

      useEffect(() => {
        let alive = true;
        void (async () => {
          try {
            const next = await call('/status');
            if (!alive) return;
            const view = next && typeof next === 'object' ? next : {};
            adoptFooterIcons(view);
            setUrl(typeof view.panelUrl === 'string' ? view.panelUrl : '');
            setScope(typeof view.panelScope === 'string' ? view.panelScope : '');
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
       * 拨到面板。地址还没读到时补读一次再开（见 `openConfigurationPage`），不是干等。
       * 新窗口必须在**点击这一帧**开出来，等到接口回来再开会被弹窗拦截器吃掉。
       */
      function openPanel(event) {
        if (typeof url === 'string' && url !== '') return; // 普通链接，交给浏览器自己开
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        const target = isWebPage(window) && typeof window.open === 'function'
          ? window.open('', '_blank')
          : null;
        void (async () => {
          const outcome = await openConfigurationPage({
            view: { panelUrl: '', panelScope: scope },
            loadStatus: failure && failure.kind === 'load' ? failure.status || 0 : 0,
            t,
            target,
          });
          if (outcome.ok) {
            setFailure(null);
            return;
          }
          if (target && typeof target.close === 'function') target.close();
          setFailure({ kind: outcome.missing ? 'load' : 'open', status: outcome.status || 0, message: outcome.message });
        })();
      }

      /**
       * 拨一颗图标的开关。至少留一颗：两颗都收起来，侧边栏就没有桌面入口了，用户回到这一页
       * 才能改回来——这不是「都关掉也行」的偏好，是别把人锁在门外。
       * 先改共享状态让图标当场跟着变，再落盘；写失败就把两颗都还原，并说清原因。
       */
      async function toggleIcon(key) {
        const before = { ...icons };
        const other = key === 'phone' ? 'computer' : 'phone';
        if (before[key] && !before[other]) {
          setIconError(t('iconKeepOne'));
          return;
        }
        const next = { ...before, [key]: !before[key] };
        footerIconsTouched = true;
        setFooterIcons(next);
        setIconError('');
        try {
          await postJson('/config', {
            desktopPhoneIcon: next.phone,
            desktopComputerIcon: next.computer,
          });
        } catch (error) {
          setFooterIcons(before);
          setIconError(`${t('iconSaveFailed')}：${String((error && error.message) || error)}`);
        }
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
            : null),
        h('div', { className: 'dshm_card' },
          h('h3', { className: 'dshm_cardTitle' }, t('iconsTitle')),
          h('p', { className: 'dshm_note' }, t('iconsHint')),
          [['phone', 'iconPhone'], ['computer', 'iconComputer']].map(([key, label]) => h('div', {
            key,
            className: 'dshm_iconRow',
          },
            h('span', {}, t(label)),
            h('button', {
              type: 'button',
              className: 'dshm_iconSwitch',
              role: 'switch',
              'aria-checked': icons[key] ? 'true' : 'false',
              'aria-label': t(label),
              onClick: () => void toggleIcon(key),
            }, t(icons[key] ? 'iconShown' : 'iconHidden')))),
          iconError ? h('p', { className: 'dshm_error' }, iconError) : null));
    }

    /* ── 聊天嵌入页：把网页定位到顶栏那条会话 ───────────────────────────────
     * 官方整页没选工作区时停在欢迎页。App 在页面启动前写下目标会话号，
     * 这里照 liveshare 的 viewer-session 做：等会话清单出现它，再用 uiWorkspace 打开。
     * 打开会让清单再通知一次，所以订阅回调里必须先退订再打开，且只开一次。
     * 回报仍走 App 认的那一个 kind；没有目标、或服务没就位都不回报，免得被当成失败盖住整页。
     */
    const CHAT_EMBED_KIND = 'dsh-chat-embed';
    /** 等清单出现目标的最长时间：九秒够页面把工作区与会话清单拉起来。 */
    const CHAT_EMBED_WAIT_MS = 9000;
    /**
     * 打开之后再盯住主视图的时长与节拍。
     *
     * 网页端启动时会把「上次那条会话」摆回主视图（选择记在本地，页面每加载一次就恢复一次），
     * 页面装载的那几趟（第一次打开、换电脑、点重试）都会跑到它。打开只是把主视图指过去，
     * 不等于停在那儿：窗口内每一拍复核一次，被抢回去就再指一次。窗口走完停在哪就是哪，按
     * 那一刻回报。
     */
    const CHAT_EMBED_HOLD_TICKS = 10;
    const CHAT_EMBED_HOLD_STEP_MS = 150;
    function openEmbeddedSession(ctx) {
      const target = globalThis.__DSH_CHAT_EMBED_TARGET__;
      if (!ctx || typeof ctx.inject !== 'function') return;
      const sessionId = target && typeof target.sessionId === 'string' ? target.sessionId : '';
      // 本插件是 immediately 那一档，apply 时 ctx.get 还看不见宿主稍后才提供的 sessions
      // （绿点两条同步当初就是被这点坑过，才统一改走 ctx.inject）。liveshare 的 viewer
      // 插件同样把 sessions 与 uiWorkspace 列进 inject 才读清单、打开会话。这里等两者
      // 就位，拿到的是带服务的子 ctx；没就位就一直不回调，安静降级，不回报也不抛。
      ctx.inject(['sessions', 'uiWorkspace'], (scope) => {
        scope.effect(() => {
          // 入口一直挂着，装载时目标为空也照挂：App 切会话走这个入口进来，会话还没建出来的
          // 新会话页切到网页模式时，也靠它稍后补一个目标。
          installEmbedOpener(scope);
          if (sessionId) openEmbeddedTarget(scope, sessionId);
          return () => {
            disposeEmbedTask();
            const win = typeof window !== 'undefined' ? window : null;
            if (win) {
              try { delete win.__DSH_CHAT_EMBED_OPEN__; } catch { /* 删不掉不影响会话本身 */ }
            }
          };
        }, 'mobile-plugin: 打开聊天嵌入页目标会话');
      });
    }

    /** 正在跑的那一次定位。换目标时把上一次的等待与盯住收掉，免得两趟抢同一条会话。 */
    let embedTask = null;

    function disposeEmbedTask() {
      const task = embedTask;
      embedTask = null;
      if (task) task.dispose();
    }

    /**
     * 页面里那个「换到这条会话」的入口。
     *
     * App 切会话不再重建 WebView（页面因此不重新加载，也就不会触发网页端启动时那次会话恢复），
     * 改由它在页面里调这个入口把新目标送进来。同名入口只留最新一个。
     */
    function installEmbedOpener(scope) {
      const win = typeof window !== 'undefined' ? window : null;
      if (!win) return;
      try {
        win.__DSH_CHAT_EMBED_OPEN__ = (next) => {
          if (typeof next !== 'string' || next === '') return;
          openEmbeddedTarget(scope, next);
        };
      } catch { /* 挂不上入口：这一趟就只剩装载时那一次定位 */ }
    }

    /** 清单与导航就位后：等目标出现，退订再打开一次，盯住它，并按原 kind 回报 App。 */
    function openEmbeddedTarget(scope, sessionId) {
      const sessions = scope.sessions;
      const uiWorkspace = scope.uiWorkspace;
      if (!sessions || !sessions.list || typeof sessions.list.subscribe !== 'function'
        || typeof sessions.list.getSnapshot !== 'function'
        || !uiWorkspace || typeof uiWorkspace.openSession !== 'function') return;
      disposeEmbedTask();
      embedTask = armEmbeddedTarget(sessions, uiWorkspace, sessionId);
    }

    /** 一次定位：返回一个随时能收掉的任务（换目标、页面卸载都走它）。 */
    function armEmbeddedTarget(sessions, uiWorkspace, sessionId) {
      const win = typeof window !== 'undefined' ? window : null;

      const post = (located) => {
        try {
          const bridge = win && win.ReactNativeWebView;
          if (bridge && typeof bridge.postMessage === 'function') {
            bridge.postMessage(JSON.stringify({ kind: CHAT_EMBED_KIND, sessionId, located: Boolean(located) }));
          }
        } catch { /* 桌面网页里没有 WebView 桥：回报不到也不影响会话本身 */ }
      };
      const listed = () => {
        try {
          const snapshot = sessions.list.getSnapshot();
          return !!(snapshot && snapshot.byId && snapshot.byId[sessionId]);
        } catch {
          return false;
        }
      };

      /** 目标此刻是不是网页的主视图。网页端把「当前会话」记在清单条目的 `retainedBy.mainView` 上。 */
      const isMain = () => {
        try {
          const entry = sessions.list.getSnapshot().byId[sessionId];
          return !!entry && !!(entry.retainedBy && entry.retainedBy.mainView > 0);
        } catch {
          return false;
        }
      };

      let done = false;
      let opened = false;
      let unsubscribe = null;
      let timer = null;
      let holdTimer = null;
      let ticks = 0;
      const clearTimers = () => {
        if (timer !== null && win && typeof win.clearTimeout === 'function') win.clearTimeout(timer);
        if (holdTimer !== null && win && typeof win.clearTimeout === 'function') win.clearTimeout(holdTimer);
        timer = null;
        holdTimer = null;
      };
      const settle = (located) => {
        if (done) return;
        done = true;
        clearTimers();
        if (typeof unsubscribe === 'function') unsubscribe();
        post(located);
      };
      /** 把主视图指到目标；宿主没给这个方法就由调用方收成一次「没定位到」。 */
      const point = () => {
        try {
          uiWorkspace.openSession(sessionId);
          return true;
        } catch {
          return false;
        }
      };
      /**
       * 盯住主视图直到窗口走完。
       *
       * 每一拍先看目标还在不在主视图上，网页端那次恢复把它顶掉时就再指一次。读不到那一格
       * （宿主没这个字段）同样按「不在」处理，于是每拍补指一次 —— 那不过是一次重复打开，
       * 同一条会话重复打开是幂等的。
       */
      const hold = () => {
        if (!isMain() && !point()) {
          settle(false);
          return;
        }
        if (ticks <= 0) {
          settle(true);
          return;
        }
        ticks -= 1;
        if (win && typeof win.setTimeout === 'function') {
          holdTimer = win.setTimeout(hold, CHAT_EMBED_HOLD_STEP_MS);
        } else {
          settle(true);
        }
      };
      const finish = (located) => {
        if (done || opened) return;
        opened = true;
        // 退订要赶在打开之前：打开会再次通知清单，留着监听器会重进自己直到栈溢出。
        if (typeof unsubscribe === 'function') unsubscribe();
        if (!located || !point()) {
          settle(false);
          return;
        }
        ticks = CHAT_EMBED_HOLD_TICKS;
        hold();
      };
      const onListed = () => {
        if (done || opened || !listed()) return;
        finish(true);
      };
      if (listed()) {
        finish(true);
      } else {
        unsubscribe = sessions.list.subscribe(onListed);
        if (win && typeof win.setTimeout === 'function') {
          timer = win.setTimeout(() => finish(false), CHAT_EMBED_WAIT_MS);
        }
      }
      return {
        dispose() {
          done = true;
          clearTimers();
          if (typeof unsubscribe === 'function') unsubscribe();
        },
      };
    }

    /** 每个提供方独立持有声明；旧撤销函数不能碰到重载后的新声明。 */
    function provideMobileChatEmbed(ctx) {
      const candidate = globalThis.__DSH_MOBILE_CHAT_EMBED__;
      const bridge = candidate && candidate.version === 1 && candidate.surface === 'chat'
        && typeof candidate.setTopBarVisible === 'function' ? candidate : null;
      const claims = new Set();
      let disposed = false;
      const service = {
        isEmbedded: () => Boolean(bridge && !disposed),
        keepTopBar() {
          if (!bridge || disposed) return () => {};
          const claim = {};
          claims.add(claim);
          if (claims.size === 1) bridge.setTopBarVisible(true);
          return () => {
            if (disposed || !claims.delete(claim)) return;
            if (claims.size === 0) bridge.setTopBarVisible(false);
          };
        },
      };
      ctx.effect(() => () => {
        disposed = true;
        const hadClaims = claims.size > 0;
        claims.clear();
        if (bridge && hadClaims) bridge.setTopBarVisible(false);
      }, 'mobile-plugin: chat embed top bar');
      ctx.provide('mobileChatEmbed', service);
    }

    return {
      // slots：注册设置项与侧边栏那颗图标，由 @deepseek-ai/dsh-client-ui-renderer 提供（它的
      // SlotRegistry 继承 dsh-client-ui-slots 的 SlotCore，再以 `super(ctx, "slots")` 暴露服务）。
      // locale：字典，由 @deepseek-ai/dsh-client-locale 提供。
      // 这两个服务名对应 package.json 里 dsh.client.inject 注入的两个包。
      inject: ['slots', 'locale'],
      apply(ctx) {
        provideMobileChatEmbed(ctx);
        ctx.effect(() => {
          const offDictionary = ctx.locale.register(NS, DICT);
          const offFeedbackDictionary = ctx.locale.register(FEEDBACK_NS, FEEDBACK_DICT);
          return () => {
            if (typeof offDictionary === 'function') offDictionary();
            if (typeof offFeedbackDictionary === 'function') offFeedbackDictionary();
          };
        }, 'mobile-plugin: settings dictionaries');
        const t = ctx.locale.bind(NS);
        const tf = ctx.locale.bind(FEEDBACK_NS);
        installPluginPages(ctx, t);
        captureSessions(ctx);
        openEmbeddedSession(ctx);
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
          inject: () => ({ t, tf }),
        }, MobileWebEntry));
        // 手机图标右边那颗电脑图标：远程电脑独立页的入口。展开态由组件自己插到手机图标
        // 后面（两个组件分别物化、谁先谁后不定，认手机图标的记号定位），窄条态各占一行。
        ctx.slots.inject(FOOTER_SLOT, () => ctx.slots.register({
          name: FOOTER_SLOT,
          id: 'remote-web',
          order: 11,
          label: () => t('footerRemoteOpen'),
          locale: NS,
          inject: () => ({ t, tf }),
        }, RemoteWebEntry));
      },
    };
  },
});

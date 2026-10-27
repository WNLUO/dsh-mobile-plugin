'use strict';

/**
 * 控制面路由（`/api/relay/*`）：桌面端设置页与宿主本机运维动作走这里。
 *
 * 与移动端路由表是刻意的两套：控制面只认本机来源（localOnly），移动端只认 token（guarded）。
 * 控制面会读进程级错误账本（含堆栈）、能改配置、能吊销全部授权，暴露给中转等于把后门开到
 * 公网；反过来移动端请求可能来自中转，根本没有本机 socket 可言。
 *
 * 依赖以取值器 / 函数注入，不捕获对象：闭包里那些 `let`（sidecarSnapshot、sidecarState…）
 * 会被整体替换。`getSidecar` 尤其重要：sidecar 会被自重启换掉，拿到实例就等于拿到旧 facade
 * 的快照。
 *
 * 改中转地址（`POST /api/relay/config`）与手机端写的是同一份配置、走同一条下发路径；「先登记
 * 迁移、再重建隧道」的顺序在 worker 的 configure 里（见 ../relay/migrate.js），这里只把那次
 * 下发的失败原因如实带回给面板。
 */

const fs = require('node:fs');
const path = require('node:path');
const QRCode = require('qrcode');
const { randomBytes } = require('node:crypto');

const core = require('../relay/core.js');
const pairingApproval = require('../relay/pairing-policy.js');
// 端口自检用的是局域网代理**同一把探针**（见 `../relay/port-allocator.cjs` 的文件头）：
// 这里说「可用」，真正 listen 时就不会 EADDRINUSE，两边不会各说各话。
const { canListen } = require('../relay/port-allocator.cjs');
// 面板的「手机该填哪个地址」要三份：私网（lanCandidates）、公网（publicCandidates）与
// IPv6 全球单播（ipv6Candidates）。三者刻意分开，理由写在 lan-network.cjs 里那三个函数头上。
//
// ⚠️ 面板里**能被选中的**那份仍然只能是 `lan`（没有私网时才退 `public`）——它与
// `advertisedCandidates` 同口径。IPv6 那份只**显示**、不进那个选择：它由手机侧实测择优
// （和公网中转比速度），做成可选中等于骗人（同 A3-40 的刻意设计）。
const { lanCandidates, publicCandidates, ipv6Candidates } = require('../relay/lan-network.cjs');
const desktopView = require('../desktop-view.cjs');
const readReceipt = require('../read-receipt.cjs');
// 客户端半边的活体台账：两条绿点同步通道都是「单向轮询 + 无回执」，不记账就永远分不开
// 「那半边根本没在跑」和「跑了但没清掉」（详见 lib/desktop-half-stats.cjs 的文件头）。
const desktopHalf = require('../desktop-half-stats.cjs');
// 内存自检台账：两个进程的内存、活着的流数、镜像缓存与凭据库规模。口径（「宿主进程」
// 不等于「插件内存」）与各字段的来源写在 lib/mobile/self-check.cjs 的文件头。
const { createSelfCheck } = require('../mobile/self-check.cjs');
// 「查有没有新版」与「装新版」这两格都归插件自己：查直接问 npm 注册表，装在 profile 里跑
// 它自己的包管理器（见 `../update-registry.cjs` / `../update-install.cjs`）。不再借道市场。
const { checkForUpdate } = require('../update-registry.cjs');
const { declaredSource } = require('../update-install.cjs');
const { clearCompletionForAllDevices, invalidateSessionList } = require('../mobile/session-cache.js');
const { recordSessionRead } = require('../mobile/session-last-turn.js');
// 收件目录的占用与清理：和移动端那条路由是同一份实现（`lib/mobile/inbox-clean.js`）。
const { scanInbox, clearInbox, usageView, setAutoClear } = require('../mobile/inbox-clean.js');

/** 一次 desktop-read 上报最多带多少个会话 id（防灌爆；客户端半边一次最多也就几个）。 */
const MAX_DESKTOP_READ_IDS = 200;
/** 公用中转测速的单项超时：远端多半在境外，给足 6 秒但别让整页干等。 */
const RELAY_PROBE_TIMEOUT_MS = 6000;

function createWebAccessWindow({ now = Date.now, monotonicNow = () => performance.now() } = {}) {
  let deadline = 0;
  let expiresAt = 0;
  const status = () => {
    const current = monotonicNow();
    if (deadline <= current) {
      deadline = 0;
      expiresAt = 0;
      return { enabled: false, expiresAt: 0 };
    }
    return { enabled: true, expiresAt };
  };
  return {
    status,
    isOpen: () => status().enabled,
    enable() {
      deadline = monotonicNow() + WEB_ACCESS_WINDOW_MS;
      expiresAt = now() + WEB_ACCESS_WINDOW_MS;
      return status();
    },
    disable() {
      deadline = 0;
      expiresAt = 0;
      return status();
    },
  };
}

function createWebAccessLocalOnly({ localOnly, trustedLocalUi, webAccessWindow, sendJson }) {
  return (method, handler) => localOnly(method, async (req, res) => {
    const route = String(req?.url || '').split('?', 1)[0];
    if (WEB_ACCESS_ROUTES.has(route) && !trustedLocalUi(req) && !webAccessWindow.isOpen()) {
      return sendJson(res, 423, {
        ok: false,
        error: { code: 'web_access_closed', message: '网页管理暂未开放，请从 DSH 本机设置页开启 2 小时窗口' },
      });
    }
    return handler(req, res);
  });
}

/**
 * 面板页（`React/` 构建成的单文件 HTML）在包里的位置。
 *
 * 用 `__dirname` 而不是包根：HTML 是提交物，和 `lib/` 在同一份安装里，装哪个版本就带哪个
 * 版本的页面。改版式只有一条路：`React/` 里重建 → 提交产物 → 发新版本 → 完整重启 DSH。
 */
const PANEL_FILE = path.join(__dirname, '..', 'panel', 'index.html');

/** 插件包根（`<pkg>/lib/routes` 往上两级）：诊断时读它的 `package.json` 与 `React/`。 */
const PACKAGE_DIR = path.join(__dirname, '..', '..');

/**
 * 这一代（`lib/` 所在的那份包）自己的版本号。
 *
 * 「检查更新」在**没有外壳**的宿主上（无头部署、或那一版没装外壳）也要能答，而盘上版本
 * 是外壳的 `manager.js` 才知道的事；拿不到就退回这一代的版本号 —— 它至少是「这台机器上
 * 正在跑的实现」的真实版本，比空着或回一句「问不了」有用。
 */
function generationVersion() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));
    return typeof raw.version === 'string' && raw.version ? raw.version : null;
  } catch {
    return null;
  }
}

/** 按 mtime 缓存：文件被换掉之后内容变了，缓存自然失效，不必手工清。 */
let panelCache = { file: '', mtime: -1, html: '' };

function panelHtml() {
  try {
    const stat = fs.statSync(PANEL_FILE);
    if (panelCache.file === PANEL_FILE && panelCache.mtime === stat.mtimeMs) return panelCache.html;
    const html = fs.readFileSync(PANEL_FILE, 'utf8');
    panelCache = { file: PANEL_FILE, mtime: stat.mtimeMs, html };
    return html;
  } catch {
    return '';
  }
}

/**
 * 面板读不到时，说清楚是哪一种读不到。
 *
 * 两种情形解法完全不同，所以分开报，并把路径与版本一起带上：
 * 1. 安装目录整个不见了——市场里装/更新过、DSH 还没完整重启，跑着的仍是旧实例，而旧实例
 *    所在的目录已被这次安装删掉。代码在内存里所以路由照常响应，`fs` 一读就 ENOENT。解法是
 *    重启 DSH，不是去跑构建。
 * 2. 这份安装里根本没有产物——老版本还没有这一页。解法是更新到当前版本。
 *
 * 三种情形由 `test/panel-artifact.test.cjs` 钉住。
 *
 * @param {{panelFile?: string, packageDir?: string}} [paths] 只给测试喂临时目录用；运行时走默认路径
 * @returns {{reason: 'install-gone'|'artifact-missing'|'unreadable', message: string}}
 */
function panelDiagnosis(paths) {
  const panelFile = paths?.panelFile ?? PANEL_FILE;
  const packageDir = paths?.packageDir ?? PACKAGE_DIR;
  let version = '';
  try {
    version = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version || '';
  } catch {}
  const versionOf = version ? `v${version}` : '版本读不到';

  if (!fs.existsSync(packageDir)) {
    return {
      reason: 'install-gone',
      message: `插件的安装目录已经不在了（${packageDir}）：多半是刚在插件市场里装/更新过、但 DSH 还没完整重启 —— 跑着的旧实例还挂在这次安装删掉的那个目录上。完整重启 DSH 即可恢复。`,
    };
  }
  if (!fs.existsSync(panelFile)) {
    // 有没有 `React/src` 是「源码树 vs 装进来的包」唯一可靠的判据：`files` 不收 React/。
    const sourceTree = fs.existsSync(path.join(packageDir, 'React', 'src'));
    return {
      reason: 'artifact-missing',
      message: sourceTree
        ? `面板产物还没构建（${panelFile}）：在 dsh-mobile-plugin/React 里跑一次 pnpm run build（产物是提交物，构建完要跟源码一起提交）。`
        : `这份安装（${versionOf}）里没有面板产物（${panelFile}）：0.1.47 及更早的版本还没有这一页。在 DSH 的插件市场里更新到当前版本，再完整重启 DSH。`,
    };
  }
  let cause = '';
  try {
    fs.readFileSync(panelFile);
  } catch (error) {
    cause = `：${error && error.message ? error.message : error}`;
  }
  return { reason: 'unreadable', message: `面板产物读不出来（${panelFile}，${versionOf}）${cause}` };
}

/**
 * 面板页的绝对地址，给客户端半边那个「打开配置页面」的链接用。
 *
 * **必须是绝对 http(s) 地址**：桌面版把前端挂在 `dsh-app://app/` 下，页面里写相对
 * 地址会被解析成那个自定义协议，而 Electron 的 `setWindowOpenHandler` 只把 http(s)
 * 交给系统浏览器，其它协议一律静默丢弃（devmap 的面板入口踩过这个坑）。
 * 拿不到 Host 头就回空串，让客户端半边退成「还没就绪」而不是给一个点不开的链接。
 */
function panelUrlOf(req) {
  const host = typeof req?.headers?.host === 'string' ? req.headers.host : '';
  if (!host) return '';
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return `${forwarded || 'http'}://${host}/api/relay/panel`;
}

/**
 * @param {object} deps 见 `lib/impl.js` 里 registerControlPlaneRoutes({...}) 的调用点
 */
function registerControlPlaneRoutes(deps) {
  const {
    registerRoute,
    localOnly: baseLocalOnly,
    trustedLocalUi,
    readJson,
    sendJson,
    sendHtml,
    state,
    sidecarToken,
    status,
    settings,
    syncSidecar,
    getSidecar,
    credentials,
    activeGuard,
    resolveLanPort,
    lanPortInUse,
    getLanPortAdjusted,
    pairingPayload,
    restartSidecar,
    // 「手机上最近来过没有」。**只往本机这条状态路由上补**（和 panelUrl 一样），
    // 不动 createStatusView——那份 JSON 手机端也在读，给它加字段是另一个决定。
    // 缺省回 0：没有记账的宿主（老版本 / 测试里单独挂 impl）如实报「从来没来过」。
    mobileActivity = () => ({ lastMobileAt: 0 }),
    // 插件 ctx。只给「桌面端说它读过了」那条路由用：它要清掉宿主侧的完成提醒。
    // 缺省 null 时那条路由降级为「只回 200、什么都不清」。
    ctx = null,
    // 内存自检台账的取值器（`/api/relay/status` 的 `selfCheck` 字段）。
    // `getSidecarSnapshot` 是 worker 的 `/status` 快照——侧车内存与中转路 SSE 数只有
    // 这一条既有通道；`getLanProxyStats` 是局域网代理的 `stats()`，约定形状
    // `() => ({ upstreamOpen, sseOpen })`。拿不到就报 null（`unavailable` 里说明原因），
    // 不拿 0 顶替：0 是「一条流都没有」，与「不知道」是两件事。
    getSidecarSnapshot = () => null,
    getMirrorPush = () => null,
    getMirrorPushFailures = () => null,
    getLanProxyStats = () => null,
    // **外壳**暴露的换代服务（`dshMobilePluginRuntime`）。更新的机制住在外壳里，而这几条
    // 路由住在代里 —— 代被换掉之后服务还在，接口也就跟着活下来。
    // 缺省返回 null：`lib/impl.js` 单独挂载时（测试 / 老宿主）没有外壳，如实报不可用。
    getPluginRuntime = () => null,
    /**
     * 收掉某台设备已经开着的 SSE 流（吊销时用）。
     *
     * token 换了只保证「下一次请求」被拒，已经开着的流不会自己停。缺省返回 0（老宿主 /
     * 测试里没有流登记）：那时吊销仍然对下一次请求生效，只是收不了在途的流。
     */
    dropDeviceStreams = () => 0,
  } = deps;
  const selfCheck = createSelfCheck({
    ctx,
    credentials,
    getSidecarSnapshot,
    getMirrorPush,
    getMirrorPushFailures,
    getLanProxyStats,
  });
  const webAccessWindow = createWebAccessWindow();
  const localOnly = createWebAccessLocalOnly({
    localOnly: baseLocalOnly,
    trustedLocalUi: typeof trustedLocalUi === 'function' ? trustedLocalUi : () => false,
    webAccessWindow,
    sendJson,
  });

  // Pairing approval. The desktop shell used to answer this with an interactive
  // prompt; a headless host has no surface for one, so `pairingPolicy` decides.
  // Both transports funnel through here — the relay forwards `pairRequest` and
  // the LAN proxy calls the worker's onApprove — and the sidecar treats anything
  // other than an explicit `true` as a rejection, so 'deny' reproduces the
  // previous fail-closed behaviour exactly.
  //
  // 这条不走 localOnly：它由中转与局域网代理代转，没有本机 socket 可言。身份靠
  // sidecarToken（中转与 worker 之间的共享密钥）。
  registerRoute({ kind: 'exact', path: '/api/relay/internal/approval', handler: async (req, res) => {
    if (req.headers.authorization !== `Bearer ${sidecarToken}`) return sendJson(res, 401, { error: 'unauthorized' })
    let body = {}
    try { body = (await readJson(req)) || {} } catch { body = {} }
    const decision = pairingApproval.evaluate(state.pairingPolicy, body.device)
    // Audit trail: the removed prompt showed the device before letting it in.
    process.stderr.write(`[dsh-mobile-plugin] pairing ${decision.approved ? 'approved' : 'denied'} policy=${decision.policy} device=${decision.device}${decision.ip ? ` ip=${decision.ip}` : ''}\n`)
    // `hostPlatform` 一并回给中转：手机要靠它把「这台宿主是什么系统」在配对那一刻就落盘，
    // 不能等到第一次 status 轮询（那之前设备行画不出图标）。被拒时不给，没有意义。
    return sendJson(res, 200, { data: { approved: decision.approved, reason: decision.reason, ...(decision.approved ? pairingApproval.hostPlatform() : {}) } })
  } })
  /**
   * 旁路子进程的签发通道（§3.7）。局域网配对跑在旁路里，而凭据库只有一个写方 —— 主进程。
   * 旁路把「给这台设备签一枚」交到这里，主进程落盘后把凭据回给它。
   *
   * 身份同 `/internal/approval`：sidecarToken，不走 localOnly。
   */
  registerRoute({ kind: 'exact', path: '/api/relay/internal/issue-credential', handler: async (req, res) => {
    if (req.headers.authorization !== `Bearer ${sidecarToken}`) return sendJson(res, 401, { error: 'unauthorized' })
    let body = {}
    try { body = (await readJson(req)) || {} } catch { body = {} }
    const device = body.device && typeof body.device === 'object' ? body.device : {}
    const extra = body.extra && typeof body.extra === 'object' ? body.extra : {}
    try {
      const issued = credentials.issue(state.instanceId, device, '', undefined, extra)
      return sendJson(res, 200, { data: issued })
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: { code: 'internal', message: String(error?.message || error) } })
    }
  } })
  /**
   * 局域网配对成功之后换码 + 换票据（§5.1）的内部通道。
   *
   * 为什么需要一条内部路由：局域网代理跑在旁路子进程里，换码要写宿主的状态文件，而**唯一
   * 能写的地方是主进程**。旁路配对成功后发一条到这里，主进程落盘、再让旁路重读。
   * 身份同 `/internal/approval`：sidecarToken，不走 localOnly（没有本机 socket 可言）。
   *
   * 少了这条，局域网配对成功后码与票据都还是旧的 —— 截图里那张二维码长期有效，而它里面
   * 是整条链路的密钥，正是 §8.10 第 3 条要堵的那条。旁路那边一句 `.catch(() => {})`
   * 会把 404 吞掉，现场只表现为「配完还能拿旧图再配一次」。
   */
  registerRoute({ kind: 'exact', path: '/api/relay/internal/rotate-pairing', handler: async (req, res) => {
    if (req.headers.authorization !== `Bearer ${sidecarToken}`) return sendJson(res, 401, { error: 'unauthorized' })
    let next
    try {
      next = core.rotatePairing(state)
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: { code: 'internal', message: String(error?.message || error) } })
    }
    // 落盘之后要让旁路重读：它手上那份还是旧码旧票，不推下去等于只换了主进程那一份。
    try { await syncSidecar() } catch { /* 旁路不可达时下次 configure 会带上新值 */ }
    return sendJson(res, 200, { ok: true, data: next })
  } })
  // 控制面状态里额外带上面板页的绝对地址：客户端半边（lib/client.js）那一项现在只是
  // 一个「打开配置页面」的入口，链接必须是绝对的（原因见 panelUrlOf）。地址只在这里
  // 补，不动 createStatusView —— 那份 JSON 手机端也在读，127.0.0.1 的地址对它没意义。
  // 面板的「手机该填哪个地址」：把检测到的网卡地址按**局域网 / 公网 / IPv6**分成三份报出来，
  // 用户不用自己去 `ipconfig`，界面也能一眼看出该填哪个（引导第三、四页用它）。
  //
  // 只给面板看：移动端那份候选契约（二维码里带的 `lanUrls`）的**取舍**一个字都没动，那边的
  // 私网/公网取舍见 `../relay/lan-network.cjs` 的 `advertisedCandidates`。
  //
  // `preferred` 是用户在这两份地址里选中的那条（设置项 `preferredLanAddress`）：界面靠它回显
  // 「现在选的是这条」。选中的地址要真生效在二维码与 `/connection-info` 里，不在这一条上。
  // `ipv6` 是 2026-10 加的第三份：它**不参与** `preferred`，只用来显示「这台机器在公网
  // IPv6 上是哪个地址」—— 真机验证时人要拿这个地址去拨，没有它就只能敲命令行。
  registerRoute({ kind: 'exact', path: '/api/relay/addresses', handler: localOnly('GET', async (_req, res) => {
    const port = lanPortInUse()
    const preferred = typeof state.preferredLanAddress === 'string' ? state.preferredLanAddress : ''
    // `manual` 是用户手填的直连地址（内网穿透域名）：网卡扫不出来，所以单列一格让面板回显与修改。
    const manual = typeof state.manualLanUrl === 'string' ? state.manualLanUrl : ''
    sendJson(res, 200, { ok: true, port, preferred, manual, lan: lanCandidates(port), public: publicCandidates(port), ipv6: ipv6Candidates(port) })
  }) })
  /**
   * 公用中转候选的测速（`POST /api/relay/probe-relays`，body `{ urls: string[] }`）。
   *
   * 必须由宿主代测：引导页在浏览器里，直连那些域名会被 CORS 挡住，读到的是浏览器拦截而不是
   * 真实耗时。判定分两步：`/healthz` 回 2xx 且 `/api/mobile/v1/health` 回的 `service` 是
   * `dsh-mobile-relay`——只看 `/healthz` 的话任何静态站都会被当成可用中转。超时照实报 null。
   */
  registerRoute({ kind: 'exact', path: '/api/relay/probe-relays', handler: localOnly('POST', async (req, res) => {
    const body = await readJson(req)
    const list = Array.isArray(body?.urls) ? body.urls : []
    // 只认 http(s)，别让前端一句糊话把宿主变成任意地址探测工具；并发上限 8 条。
    const targets = list
      .filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u.trim()))
      .slice(0, 8)
      .map((u) => u.trim().replace(/\/+$/, ''))
    const results = await Promise.all(targets.map(async (url) => {
      const started = Date.now()
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), RELAY_PROBE_TIMEOUT_MS)
        const response = await fetch(`${url}/healthz`, { signal: controller.signal, redirect: 'follow' })
        // 读完响应体再停表：只等到响应头会把「连得上但发不出东西」算成很快。
        const text = await response.text().catch(() => '')
        if (!response.ok) {
          clearTimeout(timer)
          return { url, ms: null }
        }
        // **只认运维意义上「这一台确实是中转」**：`/healthz` 回 200 的站点满互联网都是，
        // 光看它等于把随便一个域名也当可用中转。
        // 中转自己那条地址体检 `/api/mobile/v1/health` 会带回 `service`，对不上就不是它。
        const who = await fetch(`${url}/api/mobile/v1/health`, { signal: controller.signal, redirect: 'follow' })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
        clearTimeout(timer)
        if (!who || who.service !== 'dsh-mobile-relay') return { url, ms: null }
        return { url, ms: Date.now() - started, service: who.service, version: who.version }
      } catch {
        return { url, ms: null }
      }
    }))
    sendJson(res, 200, { ok: true, results })
  }) })
  // 只有可信本机设置入口可以开 / 关窗口；窗口状态仅驻留进程内，DSH 重启后必定关闭。
  registerRoute({ kind: 'exact', path: '/api/relay/web-access', handler: localOnly('POST', async (req, res) => {
    if (typeof trustedLocalUi !== 'function' || !trustedLocalUi(req)) return sendJson(res, 403, { ok: false, error: { code: 'local_ui_only', message: '请从 DSH 本机设置页管理网页访问' } });
    const body = await readJson(req);
    if (typeof body?.enabled !== 'boolean') {
      return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'enabled 必须是布尔值' } });
    }
    const webAccess = body.enabled ? webAccessWindow.enable() : webAccessWindow.disable();
    return sendJson(res, 200, { ok: true, webAccess });
  }) });
  registerRoute({ kind: 'exact', path: '/api/relay/status', handler: localOnly('GET', async (req, res) => sendJson(res, 200, { ...status(), panelUrl: panelUrlOf(req), webAccess: webAccessWindow.status(), ...mobileActivity(), selfCheck: selfCheck.snapshot() })) })
  // 面板页本体：设置界面从客户端半边搬到这里，浏览器（或桌面端里的「打开配置页面」）
  // 直接打开它。三条地址吐的是同一份 HTML，分流在 React 侧（见 React/src/Root.tsx）：
  //   /api/relay/panel            看宿主记的「配没配过」，自己决定先走引导还是直接进主页
  //   /api/relay/panel/setup      强制走引导（想再看一遍流程时用）
  //   /api/relay/panel/settings   强制进主页（演示 / 排查时跳过引导）
  // 整页 HTML 不需要 token，但这几条仍然走 localOnly —— 它读的是本机运维界面，
  // 而局域网与中转那两条链路本来就不该看到它（它们带 dsh_pair/dsh_lan 凭据，会被挡掉）。
  const servePanel = (res) => {
    const html = panelHtml();
    if (html) return sendHtml(res, 200, html);
    // 读不到就别只说「还没构建」：装进来的包几乎从不是这个原因，而是「装完没重启」或
    // 「装了老版本」（见 panelDiagnosis 的注释）。原因也写进宿主 stderr —— 页面上的
    // JSON 只有点开那个人看得见，而这类故障通常是在别人的机器上被报出来的。
    const diagnosis = panelDiagnosis();
    process.stderr.write(`[dsh-mobile-plugin] panel unavailable (${diagnosis.reason}) ${PANEL_FILE}: ${diagnosis.message}\n`);
    return sendJson(res, 500, { ok: false, error: { code: 'panel_missing', reason: diagnosis.reason, message: diagnosis.message, path: PANEL_FILE } });
  };
  registerRoute({ kind: 'exact', path: '/api/relay/panel', handler: localOnly('GET', async (_req, res) => servePanel(res)) })
  registerRoute({ kind: 'exact', path: '/api/relay/panel/setup', handler: localOnly('GET', async (_req, res) => servePanel(res)) })
  registerRoute({ kind: 'exact', path: '/api/relay/panel/settings', handler: localOnly('GET', async (_req, res) => servePanel(res)) })
  // 桌面端工作区视图（侧栏展开态）的回传/读取。桌面端只把展开态记在浏览器
  // localStorage 里，宿主进程读不到，只能由页面内的客户端半边（lib/client.js）
  // 每 2s 变了就 POST 到这里；App 再经 /api/mobile/v1/desktop-view 取走。
  registerRoute({ kind: 'exact', path: '/api/relay/desktop-view', handler: localOnly(['GET', 'POST'], async (req, res) => {
    if (String(req.method || 'GET').toUpperCase() === 'GET') {
      return sendJson(res, 200, { ok: true, view: desktopView.snapshot() })
    }
    let body = {}
    try { body = (await readJson(req)) || {} } catch { body = {} }
    try {
      desktopHalf.noteDesktopViewPost()
      return sendJson(res, 200, { ok: true, view: desktopView.update(body) })
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: String((error && error.message) || error) } })
    }
  }) })
  // 手机端「已读回执」的下发口：客户端半边每 2s GET 一次，拿 sessionId → readAt 水位，
  // 对水位前进过的会话在桌面页面里就地清掉 completionUnread（见 lib/client.js）。
  // 台账由 /api/mobile/v1/session/read 写（lib/mobile/session-send.js）。
  registerRoute({ kind: 'exact', path: '/api/relay/read-receipt', handler: localOnly('GET', async (_req, res) => {
    desktopHalf.noteReadReceiptGet()
    return sendJson(res, 200, { ok: true, receipt: readReceipt.snapshot() })
  }) })
  // 客户端半边的自检上报口。它每 10s 把自己「能不能看见那两个服务」报一次：
  // 宿主只能数出「它没来敲门」，数不出「它为什么没来」，而这条通道是唯一的问法。
  // 只收白名单里的布尔/短字符串/整数（见 lib/desktop-half-stats.cjs 的 noteClientHalf）。
  registerRoute({ kind: 'exact', path: '/api/relay/client-half', handler: localOnly('POST', async (req, res) => {
    let body = {}
    try { body = (await readJson(req)) || {} } catch { body = {} }
    return sendJson(res, 200, { ok: true, client: desktopHalf.noteClientHalf(body) })
  }) })
  // 反方向：桌面端页面里的客户端半边发现某个会话的未读绿点掉了（用户刚在桌面点开），
  // 把它报回宿主，宿主清掉**所有设备**维度上的完成提醒，手机端侧栏随之灭灯。
  // 只清「刚刚掉出去」的那些 id：首帧的全量未读集合不上报，否则会把还没读的也灭掉。
  registerRoute({ kind: 'exact', path: '/api/relay/desktop-read', handler: localOnly('POST', async (req, res) => {
    let body = {}
    try { body = (await readJson(req)) || {} } catch { body = {} }
    const raw = Array.isArray(body.sessionIds) ? body.sessionIds : []
    const ids = []
    for (const item of raw) {
      if (typeof item !== 'string') continue
      const id = item.trim()
      if (!id || id.length > 200 || ids.includes(id)) continue
      ids.push(id)
      if (ids.length >= MAX_DESKTOP_READ_IDS) break
    }
    if (!ids.length) return sendJson(res, 200, { ok: true, cleared: 0 })
    if (!ctx) return sendJson(res, 200, { ok: true, cleared: 0 })
    let cleared = 0
    let advanced = 0
    const at = Date.now()
    for (const id of ids) {
      cleared += clearCompletionForAllDevices(ctx, id, at)
      // 「这一轮被读过了」还要记一笔**设备无关**的水位：手机侧的点现在由它自己按这份
      // 水位算（见 mobile/session-last-turn.js）。只清按设备的提醒的话，桌面点开之后
      // 手机上那个点永远不会灭 —— 那条提醒本来就不在手机读取的路径上。
      if (recordSessionRead(ctx, id, at)) advanced += 1
    }
    desktopHalf.noteDesktopRead({ ids: ids.length, cleared })
    // 作废列表缓存要抬 generation，让镜像推送器重建清单并广播 device/list-changed
    // （见 A3-14）—— 只在**真有东西变了**时才调：已读水位进了下行清单，水位前进同样算
    // 内容变了；但重复上报（客户端半边每 2s 报一批，多数都是旧的）绝不能每次都抬，
    // 否则 App 的会话列表缓存会被永久压住。
    if (cleared > 0 || advanced > 0) invalidateSessionList(ctx)
    return sendJson(res, 200, { ok: true, cleared })
  }) })
  // The process-level error ledger (see lib/host-guard.cjs). "Stop an unknown
  // error before it kills DSH" is only actionable if the faults are visible, and
  // they cannot ride on /api/relay/status: that one is answered by the sidecar
  // worker, a different process that never sees this one's uncaught errors.
  // Local-only, same as status — the ledger carries stack traces.
  registerRoute({ kind: 'exact', path: '/api/relay/faults', handler: localOnly('GET', async (_req, res) => {
    const guard = activeGuard()
    if (!guard) return sendJson(res, 200, { ok: true, installed: false, faults: [], stats: null })
    return sendJson(res, 200, { ok: true, installed: true, faults: guard.faults(), stats: guard.stats() })
  }) })
  registerRoute({ kind: 'exact', path: '/api/relay/pairing', handler: localOnly('GET', async (req, res) => {
    // **二维码只在本机屏幕上出现**。
    //
    // 二维码里现在装的是一次性票据 —— 用它能派生出整条链路的密钥。而「经中转/局域网
    // 代理转发来的请求在判据眼里长得像本机」这件事已经被实测证实过，所以这条不能只靠
    // `localOnly`；它要的是**可信本机界面**这个更强的判据（socket 回环 + Host 回环 +
    // 没有任何代理来源头）。网页管理窗口（两小时窗口那套）打开时能看到设备列表，但看
    // 不到这张码 —— 窗口本身是从浏览器发起的，`trustedLocalUi` 对它不成立。
    //
    // 拿不到就回 423 而不是 403：面板那边据此显示「请在这台电脑上打开面板」，
    // 也**不给**「点这里强制显示」——那等于把刚堵上的口子又开一遍。
    if (typeof trustedLocalUi !== 'function' || !trustedLocalUi(req)) {
      return sendJson(res, 423, {
        ok: false,
        error: { code: 'pairing_local_only', message: '配对二维码只在本机屏幕显示，请在这台电脑上打开面板' },
      })
    }
    if (!state.enabled) {
      sendJson(res, 409, { ok: false, error: '请先启用远程控制并保存配置' })
      return
    }
    await resolveLanPort()
    /**
     * `?relayUrl=` 是**只看不写**的预览：按这个候选地址生成二维码，但一个字都不落盘。
     *
     * 给「自建中转填完就想看到码」用。以前那版是「填完就把地址写进
     * 配置」，等于拿一条还没验过的地址覆盖正在用的设置；现在预览走这里，真写入只在用户
     * 明确按下「连接中转」时发生。
     */
    const preview = typeof req.url === 'string' ? new URL(req.url, 'http://local').searchParams.get('relayUrl') : null
    const source = preview && /^https?:\/\/[^\s]+$/i.test(preview.trim())
      ? { ...state, relayUrl: preview.trim().replace(/\/+$/, '') }
      : state
    const { payload, text } = pairingPayload(source, lanPortInUse())
    if (!payload.relayUrl && payload.lanUrls.length === 0) {
      sendJson(res, 409, { ok: false, error: '没有可用的局域网或中转连接地址' })
      return
    }
    try {
      const svg = await QRCode.toString(text, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 280,
      })
      sendJson(res, 200, {
        ok: true,
        name: payload.name,
        relayUrl: payload.relayUrl,
        lanUrls: payload.lanUrls,
        pairingCode: payload.code,
        // 二维码里带的局域网地址用的是这个端口：首选端口被占时它与 relay.json 里
        // 的 `lanPort` 不同，不说清楚会让人对着 18787 排查一个根本没在监听的端口。
        lanPort: lanPortInUse(),
        lanPortAdjusted: getLanPortAdjusted(),
        svg,
      })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }) })
  registerRoute({ kind: 'exact', path: '/api/relay/toggle', handler: localOnly('POST', async (req, res) => {
    const body = await readJson(req)
    await settings.update({ enabled: Boolean(body && body.enabled) })
    // 等同步真正落地再回状态，否则返回的是重启前的旧快照。
    await syncSidecar().catch(() => undefined)
    sendJson(res, 200, status())
  }) })
  registerRoute({ kind: 'exact', path: '/api/relay/regenerate', handler: localOnly('POST', async (_req, res) => {
    state.pairingCode = core.genPairingCode()
    core.saveState(state)
    await syncSidecar().catch(() => undefined)
    sendJson(res, 200, status())
  }) })
  // 「首次接入引导已经走完」的标记。落盘（saveState 把整个 state 写进 relay.json），
  // 所以换浏览器、换端口、重启宿主都还在；面板据此决定打开时先走引导还是直接进主页。
  // 刻意不碰 sidecar、也不进 RemoteControlSettingsSchema：它不是一项远程控制配置，
  // 改它不该触发一次重配（那条链上每加一个字段都要同步改三处，见 core.js 的注释）。
  registerRoute({ kind: 'exact', path: '/api/relay/onboarded', handler: localOnly('POST', async (_req, res) => {
    state.onboarded = true
    core.saveState(state)
    sendJson(res, 200, status())
  }) })
  /**
   * 已绑定的设备列表（§3.4）。
   *
   * 只回「面板画一行需要的东西」，**不回 `hash` / `hostToken`** —— 那些是凭据材料，
   * 面板只是显示谁连着、什么时候来的。
   *
   * 与二维码那条不一样，这条**进** `WEB_ACCESS_ROUTES`：设备列表里没有密钥材料，
   * 两小时窗口打开时能看、能踢是它的用途；而二维码里是整条链路的密钥，绝不能。
   *
   * `serverNow` 是给面板算「几分钟前」用的：手机与宿主的时钟可能差得多，但面板只需要
   * 一个同一台机器上的基准。
   */
  registerRoute({ kind: 'exact', path: '/api/relay/devices', handler: localOnly('GET', async (_req, res) => {
    sendJson(res, 200, {
      ok: true,
      serverNow: Date.now(),
      devices: credentials.listDevices(state.instanceId),
    })
  }) })

  /**
   * 解除一台设备的绑定（§3.4）。
   *
   * 吊销该 deviceId 下所有仍有效的记录 —— 同一台手机重配过几次就是几条，只吊最新那条
   * 等于旧的还能用。已建立的 SSE 要主动断开：token 换了只保证「下一次请求」被拒，
   * 一条已经开着的流不会自己停。
   */
  registerRoute({ kind: 'exact', path: '/api/relay/devices/revoke', handler: localOnly('POST', async (req, res) => {
    const body = await readJson(req)
    const deviceId = body && typeof body.deviceId === 'string' ? body.deviceId.trim() : ''
    if (!deviceId) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 deviceId' } })
    const revoked = credentials.revokeDevice(state.instanceId, deviceId)
    // 已建立的流主动收掉：否则被踢的设备还能继续收消息直到它自己重连。
    let closed = 0
    try { closed = typeof dropDeviceStreams === 'function' ? dropDeviceStreams(deviceId) : 0 } catch { /* 尽力 */ }
    return sendJson(res, 200, { ok: true, revoked, closed })
  }) })

  registerRoute({ kind: 'exact', path: '/api/relay/revoke-all', handler: localOnly('POST', async (_req, res) => {
    // 清除所有授权 = 中转清空本实例全部设备授权 + 本机吊销局域网设备凭据 +
    // 轮换 lanSecret/配对码。三处都要做：只清中转的话，同网设备仍能用旧的
    // `dshc_` 凭据直连宿主，而移动端的「撤销全部授权」正是在要求它们全部失效。
    let revoked = 0
    try {
      const result = await getSidecar().request('/revoke-all', 'POST', undefined, 20_000)
      revoked = Number(result && result.revoked) || 0
    } catch { /* 中转不可达时仍继续吊销本机凭据与密钥 */ }
    const localRevoked = credentials.revokeAllByInstance(state.instanceId)
    state.lanSecret = randomBytes(32).toString('hex')
    state.pairingCode = core.genPairingCode()
    core.saveState(state)
    await syncSidecar().catch(() => undefined)
    sendJson(res, 200, { ok: true, revoked: revoked + localRevoked, revokedRelay: revoked, revokedLocal: localRevoked, ...status() })
  }) })
  registerRoute({ kind: 'exact', path: '/api/relay/config', handler: localOnly('POST', async (req, res) => {
    const body = await readJson(req)
    const patch = {}
    if (typeof body?.relayUrl === 'string') patch.relayUrl = body.relayUrl.trim()
    if (typeof body?.lanEnabled === 'boolean') patch.lanEnabled = body.lanEnabled
    if (Number.isInteger(body?.lanPort) && body.lanPort >= 1024 && body.lanPort <= 65535) patch.lanPort = body.lanPort
    if (typeof body?.name === 'string' && body.name.trim()) patch.name = body.name.trim()
    if (body?.pairingPolicy === 'code' || body?.pairingPolicy === 'deny') patch.pairingPolicy = body.pairingPolicy
    // 注册密钥：只接受字符串，过长拒绝；写空串等于关掉（回到"中转开了校验就连不上"）。
    if (typeof body?.registerSecret === 'string' && body.registerSecret.length <= 512) patch.registerSecret = body.registerSecret
    // 手机优先用哪条地址。**空串是合法值**（= 不指定，回到宿主的网卡优先级），所以这里
    // 只挡类型和长度，不像 name 那样要求非空——那是「清掉这次选择」的唯一方式。
    if (typeof body?.preferredLanAddress === 'string' && body.preferredLanAddress.length <= 64) {
      patch.preferredLanAddress = body.preferredLanAddress.trim()
    }
    // 用户手填的直连地址（内网穿透域名 / 公网 IP）。空串合法 = 清掉，理由同上。
    if (typeof body?.manualLanUrl === 'string' && body.manualLanUrl.length <= 200) {
      patch.manualLanUrl = body.manualLanUrl.trim().replace(/\/+$/, '')
    }
    await settings.update(patch)
    // 换中转地址时宿主会**先在旧隧道上登记迁移、再重建**（顺序在 worker 的 configure 里，
    // 见 lib/relay/migrate.js）—— 面板与手机走的是同一条下发路径，不需要各自实现一遍。
    // 失败不能再像以前那样 `.catch(() => undefined)` 吞掉：面板上这一发是用户填完地址之后
    // 唯一的反馈，如实报出来才谈得上「改坏了能看见」。
    let applyError = null
    try { await syncSidecar() } catch (error) { applyError = String(error?.message || error) }
    sendJson(res, 200, { ...status(), ...(applyError ? { applyError } : {}) })
  }) })
  // 端口自检：面板上那颗「检查端口」用的。真实地试绑一次，回答「本机现在能不能监听它」，
  // 探针就是局域网代理挑端口用的那一把，所以它给的答案和真正 listen 的结果是同一件事。
  //
  // 只读，不写任何配置：用户点着玩的动作不该改落盘状态（要改端口走上面的 `/config`）。
  // 一个例外必须认出来：同一个端口如果是这台宿主**自己**正在监听的直连端口，
  // `canListen` 当然会失败，但那不是「被别的程序占用」，要单独回 `ours`。
  registerRoute({ kind: 'exact', path: '/api/relay/check-port', handler: localOnly('POST', async (req, res) => {
    const body = await readJson(req)
    const port = Number(body?.port)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return sendJson(res, 200, { ok: true, port: null, available: false, reason: 'out-of-range' })
    }
    const snapshot = status()
    const listening = snapshot.lan.state === 'listening'
    const currentPort = snapshot.lan.port
    // 宿主自己的网页端口不能当直连端口——那等于把桌面 GUI 挂到手机上（预览那条路由的
    // `protectedPorts` 也排它）。**这一条光靠试绑发现不了**：实测 macOS 上别的进程占着
    // `127.0.0.1:P` 时，`0.0.0.0:P` 照样绑得成功，于是「可用」会是个假答案。
    if (snapshot.localPort === port) {
      return sendJson(res, 200, { ok: true, port, available: false, ours: false, listening, currentPort, reason: 'host-web-port' })
    }
    if (listening && currentPort === port) {
      return sendJson(res, 200, { ok: true, port, available: true, ours: true, listening, currentPort })
    }
    sendJson(res, 200, { ok: true, port, available: await canListen(port, '0.0.0.0'), ours: false, listening, currentPort })
  }) })
  registerRoute({ kind: 'exact', path: '/api/relay/reconnect', handler: localOnly('POST', async (_req, res) => {
    await syncSidecar()
    sendJson(res, 200, status())
  }) })
  // ── 插件更新 ──
  //
  // 分工：**查归插件自己**（问 npm 注册表，`../update-registry.cjs`）、
  // **装也归插件自己**（在 profile 里跑它自己的包管理器，`../update-install.cjs`），
  // **换代码留给外壳**（`lib/index.js` 的 runtime）。市场不再是这条路上的任何一环。
  //
  // 四条都走 localOnly：`check` 读的是版本情况，另外三条会改盘上的插件（`apply` 直接动
  // profile 的依赖树），全是本机运维动作，不该有局域网 / 中转来的调用者。
  const pluginRuntime = () => {
    try {
      return getPluginRuntime() || null
    } catch {
      return null
    }
  }
  const runtimeUnavailable = { ok: false, error: { code: 'update_unavailable', message: '这一版没有可换代的外壳（插件是被直接挂载的），装完没法就地生效，所以这里不装：无头部署请 rsync 源码后重启' } }
  registerRoute({ kind: 'exact', path: '/api/relay/update/status', handler: localOnly('GET', async (_req, res) => {
    const runtime = pluginRuntime()
    if (!runtime) return sendJson(res, 200, { ok: true, data: { available: false, runningVersion: null, installedVersion: null } })
    return sendJson(res, 200, { ok: true, data: { available: true, ...runtime.status() } })
  }) })
  // 「检查更新」：插件自己问 npm 注册表，**不经过市场、也没有经过外壳**。
  //
  // 刻意不要求外壳在场（所以这一条**不是** `runtimeUnavailable`）：查不需要换代能力，
  // 装才需要。从前这条转调 `runtime.check()` → 外壳 → 市场，于是市场没装、太老或者坏了，
  // 「有没有新版」就整个答不出来 —— 一个插件得另一个插件在场才能告诉你自己的版本情况。
  // 盘上版本仍然优先取外壳那份（市场装完立刻变，和运行中版本对照才看得出「要不要换」），
  // 拿不到（无头部署 / 没有外壳的那一版）就退回这一代自己的版本号。
  registerRoute({ kind: 'exact', path: '/api/relay/update/check', handler: localOnly('POST', async (_req, res) => {
    const runtime = pluginRuntime()
    // 形状必须和上面那条 `update/status` **一模一样**（含 `available`）：
    // 这条只回 `runtime.status()`，面板拿它 `setHost()` 覆盖掉好状态，`available` 变成 undefined，
    // 卡片当场从「宿主模式」掉进取降级那一半 —— 用户看到的现象是「有新版本却没有『立即更新』」。
    const snapshot = runtime ? { available: true, ...runtime.status() } : null
    try {
      const update = await checkForUpdate({
        installedVersion: snapshot?.installedVersion ?? snapshot?.version ?? generationVersion(),
        // 「安装来源」也自己看：profile 的依赖声明里写的是什么（npm / file: / link:）。读不到
        // 才退回外壳上次问市场的记忆 —— 这条路上不为它去敲市场。
        source: declaredSource(snapshot?.profileNodeModules ? path.dirname(snapshot.profileNodeModules) : null) ?? snapshot?.marketResult?.source ?? null,
      })
      return sendJson(res, 200, { ok: true, data: { update, status: snapshot } })
    } catch (error) {
      return sendJson(res, 500, {
        ok: false,
        error: { code: 'update_check_failed', message: String(error?.message || error) },
        data: { update: null, status: snapshot },
      })
    }
  }) })
  // 「更新并立即生效」：**交给外壳去做**（`runtime.apply`）。它在 profile 里跑插件自己的包
  // 装器装新版、装完就地换代，并把这次结果写进它那本 `lastApply` 账 —— 面板「最近一次更新」
  // 与那颗「强制更新」按钮的「上次没装成」判据读的都是这本账。
  //
  // 为什么这条路由不再自己去装：从前它自己调 `installLatestIfNeeded` 再
  // `reload`，判定确实和自动更新是同一套（外壳那条路最后也走盘上那一代的同一个函数），
  // **但结果没人落账** —— 手动（含强制）更新装完，外壳的账一动不动，面板那一行永远停在上一次
  // 自动更新的结果上。判定与记账必须是同一个动作，所以这里只负责传参、把外壳记完账的状态
  // 原样回给面板（`status` 必须是 apply **之后**的快照，拿 apply 之前那份等于没落账）。
  //
  // 只在有外壳时才装（没外壳回 409）：盘上换了版本、运行中的实现换不掉，等于白装。装没装成
  // 一律回 200 + 如实的结果（面板照着 `failure` 说人话）；只有外壳**抛错**才是意料之外，回 500。
  registerRoute({ kind: 'exact', path: '/api/relay/update/apply', handler: localOnly('POST', async (req, res) => {
    const runtime = pluginRuntime()
    if (!runtime || typeof runtime.apply !== 'function') return sendJson(res, 409, runtimeUnavailable)
    let body = {}
    try {
      body = (await readJson(req)) || {}
    } catch {
      body = {}
    }
    const force = body.force === true
    const snapshot = runtime.status()
    const beforeVersion = snapshot.installedVersion ?? snapshot.version ?? generationVersion()
    const beforeOnDisk = snapshot.installedVersion ?? null

    let applied
    try {
      applied = await runtime.apply({ force })
    } catch (error) {
      // 外壳抛错只有两类：装的那步就炸了（网络 / 权限 / 注册表），或者装上了、换代码那步炸了。
      // 必须分开说 —— 后者盘上的版本已经变了，回一句「装上了但没换过来」比笼统报失败有用得多。
      const after = runtime.status()
      const landed = beforeOnDisk !== null && (after.installedVersion ?? null) !== beforeOnDisk
      const failure = landed
        ? { code: 'swap_failed', message: `新版已经装到盘上（${after.installedVersion}），但换代码没成：${String(error?.message || error)}` }
        : { code: 'install_failed', message: String(error?.message || error) }
      return sendJson(res, 500, {
        ok: false,
        error: { code: 'update_apply_failed', message: failure.message },
        data: {
          installed: landed,
          skipped: false,
          state: landed ? 'installed-not-swapped' : 'failed',
          beforeVersion,
          installedVersion: after.installedVersion ?? beforeVersion,
          swapped: false,
          // 更新后绝不重启 DSH（外壳就地换代），这两格只为如实上报。
          restartRequired: false,
          refreshRequired: false,
          failure,
          status: after,
        },
      })
    }

    // `ok` 只有「装上了」与「已经最新、什么都没动」算真；其余（含「有对话在跑」）都是没成。
    const outcome = {
      installed: applied.installed === true,
      skipped: applied.skipped === true,
      state: applied.state ?? (applied.installed || applied.skipped ? 'succeeded' : 'failed'),
      beforeVersion: applied.beforeVersion ?? beforeVersion,
      installedVersion: applied.installedVersion ?? beforeVersion,
      swapped: applied.swapped === true,
      restartRequired: applied.restartRequired === true,
      refreshRequired: applied.refreshRequired === true,
      failure: applied.failure ?? null,
      retryable: applied.retryable === true,
      command: applied.command ?? null,
      check: applied.check ?? null,
      // 外壳自己记完账后的状态（`lastApply` / `appliedAt` 就在这里面）。
      status: applied.status ?? runtime.status(),
    }
    return sendJson(res, 200, { ok: outcome.installed || outcome.skipped, data: outcome })
  }) })
  // 自动更新开关（默认关）。开=外壳每 2 分钟问一次有没有新版，有就自己装并就地切换
  // （轮询住在外壳里，因为「没人看着也要发生」；装与换代用的就是上面这两条同一套实现）。
  registerRoute({ kind: 'exact', path: '/api/relay/update/auto', handler: localOnly('POST', async (req, res) => {
    const runtime = pluginRuntime()
    if (!runtime) return sendJson(res, 409, runtimeUnavailable)
    let body = {}
    try {
      body = (await readJson(req)) || {}
    } catch {
      body = {}
    }
    if (typeof body.enabled !== 'boolean') return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'enabled 必须是布尔值' } })
    const enabled = runtime.setAutoUpdate(body.enabled)
    return sendJson(res, 200, { ok: true, data: { enabled, status: runtime.status() } })
  }) })


  // 本机调试 OTA：操作设备端插件实现，不经过公网控制面或中转路由。
  registerRoute({ kind: 'exact', path: '/api/relay/update/ota/status', handler: localOnly('GET', async (_req, res) => {
    const runtime = pluginRuntime()
    if (!runtime || typeof runtime.deviceOta?.status !== 'function') return sendJson(res, 404, { ok: false, error: { code: 'ota_unavailable', message: '当前宿主不支持调试 OTA' } })
    return sendJson(res, 200, { ok: true, data: runtime.deviceOta?.status() })
  }) })
  registerRoute({ kind: 'exact', path: '/api/relay/update/ota/check', handler: localOnly('POST', async (_req, res) => {
    const runtime = pluginRuntime()
    if (!runtime || typeof runtime.deviceOta?.check !== 'function') return sendJson(res, 404, { ok: false, error: { code: 'ota_unavailable', message: '当前宿主不支持调试 OTA' } })
    try { return sendJson(res, 200, { ok: true, data: { update: await runtime.deviceOta?.check(), status: runtime.deviceOta?.status() } }) }
    catch (error) { return sendJson(res, 500, { ok: false, error: { code: 'ota_check_failed', message: String(error?.message || error) } }) }
  }) })
  registerRoute({ kind: 'exact', path: '/api/relay/update/ota/apply', handler: localOnly('POST', async (_req, res) => {
    const runtime = pluginRuntime()
    if (!runtime || typeof runtime.deviceOta?.apply !== 'function') return sendJson(res, 404, { ok: false, error: { code: 'ota_unavailable', message: '当前宿主不支持调试 OTA' } })
    try {
      const outcome = await runtime.deviceOta?.apply()
      return sendJson(res, 200, { ok: true, data: { ...outcome, status: runtime.deviceOta?.status() } })
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: { code: 'ota_apply_failed', message: String(error?.message || error) } })
    }
  }) })

  // sidecar 自重启：换掉 worker 子进程 + facade 模块，宿主本身不重启。
  // 走 localOnly——和其余控制面一样，这是本机运维动作。
  registerRoute({ kind: 'exact', path: '/api/relay/restart-sidecar', handler: localOnly('POST', async (_req, res) => {
    const result = await restartSidecar()
    sendJson(res, result.ok ? 200 : 500, { ...result, status: status() })
  }) })
  // 开发机专用：就地把**盘上这一份**重新装载一遍，不重启 DSH。
  //
  // 与 `/update/apply` 的分界线：那条是「去 npm 装新版」（新目录 → 新 realpath，天然绕开
  // 全部缓存）；这条是「版本号没变、目录没变，只是文件被改了」。默认那条换代判据看到
  // 「版本身份一致」就直接返回，于是开发时改完代码触发一次，什么都不会发生 —— 现场就是
  // 「我改了、也触发了、还是旧行为」。
  //
  // 刻意做成**本机接口**（localOnly + POST），而不是包一层开关：它能把这台机器上跑着的
  // 插件实现换成盘上任意一份代码，权限面与「改 profile 里的文件」等价，只该给本机运维。
  registerRoute({ kind: 'exact', path: '/api/relay/reload-implementation', handler: localOnly('POST', async (_req, res) => {
    const runtime = pluginRuntime()
    // 没有外壳（实现被直接挂载）时换不了：如实说清楚，别假装成功。
    if (!runtime || typeof runtime.reread !== 'function') {
      return sendJson(res, 409, runtimeUnavailable)
    }
    try {
      const result = await runtime.reread()
      return sendJson(res, 200, { ok: true, data: result })
    } catch (error) {
      // 装载失败时外壳已经按老规矩回滚到上一代了，这里只把原因与回滚后的状态一起交出去。
      return sendJson(res, 500, {
        ok: false,
        error: { code: 'reload_failed', message: String(error?.message || error) },
        data: runtime.status(),
      })
    }
  }) })
  // ── 收件目录（手机分享进来的文件）──
  //
  // 同一份实现在移动端也有两条（`/api/mobile/v1/inbox/{status,clear}`），这里只是把它
  // 开到网页面板上：面板与 App 读同一份扫描结果，两边不各算一套口径。
  //
  // 走 localOnly：清的是本机上那个固定收件目录，属于本机运维动作，和其余控制面一样。
  // 面板侧也因此在网页管理窗口打不开时仍可由本机操作。
  registerRoute({ kind: 'exact', path: '/api/relay/inbox/status', handler: localOnly('GET', async (_req, res) => {
    sendJson(res, 200, usageView(await scanInbox()))
  }) })
  // 自动清理开关：默认关。打开后宿主每次启动顺手清一次（见 mobile/inbox-clean.js 的
  // clearInboxOnce）。手动那颗「清理收件文件」不受它管 —— 那个是用户当场按的。
  registerRoute({ kind: 'exact', path: '/api/relay/inbox/auto', handler: localOnly('POST', async (req, res) => {
    let body = {}
    try {
      body = (await readJson(req)) || {}
    } catch {
      body = {}
    }
    if (typeof body.enabled !== 'boolean') return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'enabled 必须是布尔值' } })
    try {
      return sendJson(res, 200, { ok: true, data: { autoClear: setAutoClear(body.enabled) } })
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: { code: 'write-failed', message: String(error?.message || error) } })
    }
  }) })
  registerRoute({ kind: 'exact', path: '/api/relay/inbox/clear', handler: localOnly('POST', async (_req, res) => {
    // 面板上那颗按钮自带二次确认；这里不额外要 `confirm` 字段 —— 移动端那条要求它，
    // 是因为那里没有既有的确认口径，而这一页的确认是界面自己的事。
    const result = await clearInbox()
    sendJson(res, 200, { ok: true, ...result })
  }) })
}

// 路由字符串清单放在注册区之后，避免被按路由源码切片的契约测试误认为是真正的 handler。
/** 网页管理的固定开放窗口；按单调时钟计时，系统校时不会把窗口意外延长。 */
const WEB_ACCESS_WINDOW_MS = 2 * 60 * 60 * 1000;
const WEB_ACCESS_ROUTES = new Set([
  '/api/relay/addresses',
  '/api/relay/probe-relays',
  '/api/relay/status',
  '/api/relay/panel',
  '/api/relay/panel/setup',
  '/api/relay/panel/settings',
  '/api/relay/faults',
  '/api/relay/toggle',
  '/api/relay/regenerate',
  '/api/relay/onboarded',
  '/api/relay/devices',
  '/api/relay/devices/revoke',
  '/api/relay/revoke-all',
  '/api/relay/config',
  '/api/relay/check-port',
  '/api/relay/reconnect',
  '/api/relay/update/status',
  '/api/relay/update/check',
  '/api/relay/update/apply',
  '/api/relay/update/auto',
  '/api/relay/update/ota/status',
  '/api/relay/update/ota/check',
  '/api/relay/update/ota/apply',
  '/api/relay/restart-sidecar',
  // 开发机的「就地重载」：能换掉本机跑着的实现，属于最该只允许本机调的那一类。
  '/api/relay/reload-implementation',
  // 收件目录的占用与清理（面板那张「收件文件」卡）。
  '/api/relay/inbox/status',
  '/api/relay/inbox/clear',
  '/api/relay/inbox/auto',
]);

// `panelDiagnosis` 一并导出，只为让 test/panel-artifact.test.cjs 能拿临时目录跑那三条分支：
// 三种「读不到」的文案分别对应「重启 / 升级 / 构建」，它们混起来就是这个 bug 的原样。
module.exports = {
  registerControlPlaneRoutes,
  panelDiagnosis,
  WEB_ACCESS_ROUTES,
  WEB_ACCESS_WINDOW_MS,
  createWebAccessWindow,
  createWebAccessLocalOnly,
};
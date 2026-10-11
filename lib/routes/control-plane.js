'use strict';

/**
 * 控制面路由（`/api/relay/*`）：桌面端设置页与宿主本机运维动作走这里。
 *
 * 与移动端路由表（lib/routes/mobile-api.js）是刻意的两套：控制面只认本机来源
 * （localOnly），移动端只认 token（guarded）。这条不对称是有原因的——控制面会读
 * 进程级错误账本（含堆栈）并且能改配置、能吊销全部授权，暴露给中转等于把桌面端的
 * 后门开到公网；反过来，移动端请求可能来自中转，根本没有本机 socket 可言。
 *
 * 抽出来的原因与移动端路由表一样：它们原本是 apply() 闭包里连着 130 多行的注册语句，
 * 混在 sidecar 生命周期与镜像推送之间，改一条路由要在 1000 行文件里找。依赖以
 * 取值器/函数注入，不捕获对象——闭包里那些 `let`（sidecarSnapshot、lanPortAdjusted、
 * sidecarState…）会被整体替换或重新赋值。`getSidecar` 尤其重要：sidecar 会被自重启换掉，
 * 拿到实例本身就等于拿到一份指向旧 facade 的快照。
 */

const fs = require('node:fs');
const path = require('node:path');
const QRCode = require('qrcode');
const { randomBytes } = require('node:crypto');

const core = require('../relay/core.js');
const pairingApproval = require('../relay/pairing-policy.js');
const desktopView = require('../desktop-view.cjs');
const readReceipt = require('../read-receipt.cjs');
// 客户端半边的活体台账：两条绿点同步通道都是「单向轮询 + 无回执」，不记账就永远分不开
// 「那半边根本没在跑」和「跑了但没清掉」（详见 lib/desktop-half-stats.cjs 的文件头）。
const desktopHalf = require('../desktop-half-stats.cjs');
// 「查有没有新版」与「装新版」这两格都归插件自己：查直接问 npm 注册表，装在 profile 里跑
// 它自己的包管理器（见 `../update-registry.cjs` / `../update-install.cjs`）。不再借道市场。
const { checkForUpdate } = require('../update-registry.cjs');
const { installLatestIfNeeded, declaredSource } = require('../update-install.cjs');
const { clearCompletionForAllDevices, invalidateSessionList } = require('../mobile/session-cache.js');

/** 一次 desktop-read 上报最多带多少个会话 id（防灌爆；客户端半边一次最多也就几个）。 */
const MAX_DESKTOP_READ_IDS = 200;

/**
 * 面板页（`React/` 那份 React 源码构建成的单文件 HTML）在包里的位置。
 *
 * 用 `__dirname` 而不是包根，是为了「谁跟着这份路由一起走」：HTML 是**提交物**，和
 * `lib/` 在同一份安装里，装哪个版本就带哪个版本的页面。
 *
 * 这段注释过去写的是「控制面路由住在实现代 `lib/.live/<releaseId>/` 里，改版式不用重装」——
 * 那套「稳定外壳 + 可热替换的代」随插件 OTA 在 2026-10 一起删了（A5-02）。现在改版式只有
 * 一条路：`React/` 里重建 → 提交产物 → 发新版本 → 市场里更新 → 完整重启 DSH。
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
 * 面板读不到时，说清楚**是哪一种读不到**。
 *
 * 这条是给「装了但打不开」的现场用的。过去这里只有一句「去 `React/` 里跑一次
 * pnpm run build」，那是**开发树**才遇得到的情况；装到别人机器上时它几乎总是另外两件事：
 *
 *  1. **安装目录整个不见了**（2026-10-10 实测现场）：在插件市场里装/更新过、DSH 还没完整
 *     重启，跑着的仍是旧实例，而旧实例所在的 pnpm 目录已经被这次安装删掉了 —— 代码在内存里，
 *     所以路由照常响应，`fs` 一读就 ENOENT，面板页于是吐一段 JSON。解法是**重启 DSH**，
 *     不是去跑构建。
 *  2. **这份安装里根本没有产物**：0.1.47 及更早的版本还没有这一页（`files` 白名单当时
 *     没收 `lib/` 下的 html），老包里点开就是这条。解法是**更新到当前版本**。
 *
 * 两件事的解法完全不同，所以分开报，并把路径与版本一起带上 —— 下次看到这段报错，一眼就知道
 * 该重启还是该升级。三种情形由 `test/panel-artifact.test.cjs` 钉住。
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
 * @param {object} deps 见 index.js 里 registerControlPlaneRoutes({...}) 的调用点
 */
function registerControlPlaneRoutes(deps) {
  const {
    registerRoute,
    localOnly,
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
    // 插件 ctx。只给「桌面端说它读过了」那条路由用：它要清掉宿主侧的完成提醒。
    // 缺省 null 时那条路由降级为「只回 200、什么都不清」。
    ctx = null,
    // **外壳**暴露的换代服务（`dshMobilePluginRuntime`）。更新的机制住在外壳里，而这几条
    // 路由住在代里 —— 代被换掉之后服务还在，接口也就跟着活下来。
    // 缺省返回 null：`lib/impl.js` 单独挂载时（测试 / 老宿主）没有外壳，如实报不可用。
    getPluginRuntime = () => null,
  } = deps;

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
    return sendJson(res, 200, { data: { approved: decision.approved, reason: decision.reason } })
  } })
  // 控制面状态里额外带上面板页的绝对地址：客户端半边（lib/client.js）那一项现在只是
  // 一个「打开配置页面」的入口，链接必须是绝对的（原因见 panelUrlOf）。地址只在这里
  // 补，不动 createStatusView —— 那份 JSON 手机端也在读，127.0.0.1 的地址对它没意义。
  registerRoute({ kind: 'exact', path: '/api/relay/status', handler: localOnly('GET', async (req, res) => sendJson(res, 200, { ...status(), panelUrl: panelUrlOf(req) })) })
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
    for (const id of ids) cleared += clearCompletionForAllDevices(ctx, id)
    desktopHalf.noteDesktopRead({ ids: ids.length, cleared })
    // 有东西真被清掉才作废列表缓存：invalidateSessionList 会抬 generation，
    // 让镜像推送器重建清单并广播 device/list-changed（见 A3-14）。
    if (cleared > 0) invalidateSessionList(ctx)
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
  registerRoute({ kind: 'exact', path: '/api/relay/pairing', handler: localOnly('GET', async (_req, res) => {
    if (!state.enabled) {
      sendJson(res, 409, { ok: false, error: '请先启用远程控制并保存配置' })
      return
    }
    await resolveLanPort()
    const { payload, text } = pairingPayload(state, lanPortInUse())
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
    await settings.update(patch)
    await syncSidecar().catch(() => undefined)
    sendJson(res, 200, status())
  }) })
  registerRoute({ kind: 'exact', path: '/api/relay/reconnect', handler: localOnly('POST', async (_req, res) => {
    await syncSidecar()
    sendJson(res, 200, status())
  }) })
  // ── 插件更新（2026-10 搬回自更新之后重新有这四条）──
  //
  // 分工（2026-10-11 起）：**查归插件自己**（问 npm 注册表，`../update-registry.cjs`）、
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
  /**
   * 取一个宿主服务，拿不到就当没有。
   *
   * 更新这条路要用两个：`profileContext`（宿主发布的包管理器调用方式，装的时候必须优先用它）
   * 与 `agents`（「有对话在跑就别换插件文件」那道闸的判据）。宿主没提供某个服务时如实降级，
   * **不许让路由因此抛错** —— 服务不存在时 `ctx.get` 本身可能就不在。
   */
  const hostService = key => {
    try {
      return ctx && typeof ctx.get === 'function' ? ctx.get(key) ?? null : null
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
    const snapshot = runtime ? runtime.status() : null
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
  // 「更新并立即生效」：插件**自己**去 profile 里装新版（`../update-install.cjs`），装完请外壳
  // 就地换代。不再问市场 —— 装这一半也是插件自己的事了（查在同一条路上的 `check`）。
  //
  // 只在有外壳时才装：盘上换了版本、运行中的实现换不掉，等于「装了个用不上的东西」，不如
  // 直说办不了。装失败一律回 200 + 如实的结果（面板照着 `failure` 说人话），只有我们这边
  // 出了意料之外的错才回 500。
  registerRoute({ kind: 'exact', path: '/api/relay/update/apply', handler: localOnly('POST', async (req, res) => {
    const runtime = pluginRuntime()
    if (!runtime) return sendJson(res, 409, runtimeUnavailable)
    let body = {}
    try {
      body = (await readJson(req)) || {}
    } catch {
      body = {}
    }
    const force = body.force === true
    const snapshot = runtime.status()
    const beforeVersion = snapshot.installedVersion ?? snapshot.version ?? generationVersion()
    const outcome = {
      installed: false,
      skipped: false,
      state: 'failed',
      beforeVersion,
      installedVersion: beforeVersion,
      swapped: false,
      // 更新后绝不重启 DSH（外壳就地换代），这两格只为如实上报。
      restartRequired: false,
      refreshRequired: false,
      failure: null,
    }
    const answer = (extra = {}) => Object.assign(outcome, extra)

    const profileNodeModules = snapshot.profileNodeModules ?? null
    if (!profileNodeModules) {
      answer({ failure: { code: 'profile-unknown', message: '宿主没给出 profile 的 node_modules 路径，装不了' } })
      return sendJson(res, 500, { ok: false, error: { code: 'update_apply_failed', message: outcome.failure.message }, data: { ...outcome, status: snapshot } })
    }

    // 查一次（有没有新版）、可不可能被「有 agent 在跑」挡住、装不装，全在 `installLatestIfNeeded`
    // 里一起判：面板那颗按钮与外壳的自动更新必须走同一套判定，否则会出现「手动说有新版、
    // 自动说没有」这种最难查的偏差。
    let result
    try {
      result = await installLatestIfNeeded({
        profileNodeModules,
        force,
        // 宿主发布的包管理器调用方式（`{command, args, env?}`）。**必须优先用它**：PATH 上
        // 那个 pnpm 的版本可能和 profile 的 store 对不上（实测 10.x 装 11.x 的 profile 直接
        // `ERR_PNPM_UNEXPECTED_STORE`）。市场也是这么取的（`profileContext.packageManager`）。
        packageManager: hostService('profileContext')?.packageManager ?? null,
        // 「有对话在跑就先别换插件文件」那道闸的判据。force 由用户点按钮时显式带上。
        agents: hostService('agents'),
      })
    } catch (error) {
      result = { installed: false, installedVersion: beforeVersion, command: null, output: '', failure: { code: 'install_failed', message: String(error?.message || error) } }
    }
    outcome.installedVersion = result.installedVersion ?? beforeVersion
    outcome.failure = result.failure ?? null
    outcome.command = result.command ?? null
    outcome.output = result.output ?? ''
    outcome.retryable = result.retryable === true
    // `skipped` 也要如实带出去：已经是最新那一条**不是失败**，面板照着它说「没有改动任何文件」。
    outcome.skipped = result.skipped === true
    outcome.state = result.installed || result.skipped ? 'succeeded' : 'failed'
    if (!result.installed) {
      return sendJson(res, 200, { ok: result.skipped === true, data: { ...outcome, check: result.check ?? null, status: runtime.status() } })
    }

    // 装上了才换代：换代码是外壳的事，失败要如实报（回滚由外壳负责，见 shell/runtime.js）。
    try {
      const status = await runtime.reload()
      answer({ installed: true, state: 'succeeded', swapped: true, installedVersion: status?.version ?? outcome.installedVersion, refreshRequired: status?.shellChanged === true })
    } catch (error) {
      answer({ installed: true, state: 'installed-not-swapped', failure: { code: 'swap_failed', message: `新版已经装到盘上，但换代码没成：${String(error?.message || error)}` } })
    }
    return sendJson(res, 200, { ok: true, data: { ...outcome, status: runtime.status() } })
  }) })
  // 自动更新开关（默认关）。开=外壳每 10 分钟问一次有没有新版，有就自己装并就地切换
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


  // sidecar 自重启：换掉 worker 子进程 + facade 模块，宿主本身不重启。
  // 走 localOnly——和其余控制面一样，这是本机运维动作。
  registerRoute({ kind: 'exact', path: '/api/relay/restart-sidecar', handler: localOnly('POST', async (_req, res) => {
    const result = await restartSidecar()
    sendJson(res, result.ok ? 200 : 500, { ...result, status: status() })
  }) })
}

// `panelDiagnosis` 一并导出，只为让 test/panel-artifact.test.cjs 能拿临时目录跑那三条分支：
// 三种「读不到」的文案分别对应「重启 / 升级 / 构建」，它们混起来就是这个 bug 的原样。
module.exports = { registerControlPlaneRoutes, panelDiagnosis };
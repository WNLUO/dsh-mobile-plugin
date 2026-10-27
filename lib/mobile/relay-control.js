'use strict';

/**
 * 移动端「这台设备的中转与连接配置」：读写、配对码、吊销、重连、端口自检、地址候选。
 *
 * 这些项不会让插件代码变，最坏结果只是这台电脑从网上找不到，而重连的主动权在手机这一侧，
 * 所以能力面有意放开给已配对手机；控制面那条 `localOnly` 路由防的是「中转进来的人」，不能
 * 复用，这里直接持有同一份 settings 与 schema 校验，两个入口写同一份真值。
 *
 * 改地址 / 关遥控 / 吊销 / 重连 / 重启后台服务会掐断承载当前请求的隧道，所以一律先把响应
 * 吐完再动手，手机看到 200 只代表「已受理」，结果靠重连后读状态。
 *
 * 换中转地址是唯一**不能**「先落盘再重建」的一项：填错地址的后果就是这台电脑从网上消失，
 * 而改地址的入口正挂在要被拆掉的那条隧道上。所以它分成两阶段 —— `stage:"prepare"` 拿新
 * 地址真连一次（不落盘），`stage:"commit"` 才改，并在旧隧道上先发 `MIGRATE` 再重建
 * （顺序见 lib/relay/migrate.js）。失败台账（`apply-ledger`）在 `/diagnostics` 里报出来。
 *
 * 注册密钥只进不出：状态里只报「设没设」，手机看不到它。
 */

const { randomBytes } = require('node:crypto');

const core = require('../relay/core.js');
const pairingApproval = require('../relay/pairing-policy.js');
const applyLedger = require('../relay/apply-ledger.cjs');
const { probeInstanceId, verifyRelayRegistration } = require('../relay/verify.js');
const { canListen } = require('../relay/port-allocator.cjs');
const { lanCandidates, publicCandidates, ipv6Candidates } = require('../relay/lan-network.cjs');
const { sendJson, readJsonBody } = require('../shared/http-util');

/** 改配置的请求体上限：几个短字符串，4KB 很宽。 */
const CONFIG_BODY_MAX = 4 * 1024;

/** 「先回包、再动手」的延迟：装/换一次隧道要几百毫秒，留一点让响应真正写完。 */
const AFTER_RESPONSE_MS = 120;

/** 换中转地址的两个阶段（见文件头）。不传 `stage` 的老客户端按 `commit` 走。 */
const STAGES = ['prepare', 'commit'];

/** 测速的单条上限，与控制面 `/probe-relays` 同一档（6 秒）。 */
const PROBE_TIMEOUT_MS = 6000;

/** 一次最多测几条：手机只会问它自己存着的那几条，8 条已经很宽。 */
const PROBE_MAX_URLS = 8;

/** 离线故障台账只搬最近几条，且**不搬堆栈**：那是宿主内部路径，手机上没用。 */
const FAULT_TAIL = 5;

/** 名字最长多少字：与 `RemoteControlSettingsSchema` 的 `name` 同一条口径（不限长，但挡个糊话）。 */
const NAME_MAX_CHARS = 200;

/**
 * 配置投影：手机要看到的每一项。
 *
 * `registerSecret` **只报设没设**，不回值 —— 理由见文件头。
 * `pairingTicket` 同理不出：它是配对票据，只该活在二维码与配对流程里。
 */
function configView(state) {
  return {
    enabled: state.enabled === true,
    relayUrl: typeof state.relayUrl === 'string' ? state.relayUrl : '',
    name: typeof state.name === 'string' ? state.name : '',
    lanEnabled: state.lanEnabled === true,
    lanPort: Number.isInteger(state.lanPort) ? state.lanPort : 18787,
    pairingPolicy: pairingApproval.normalize(state.pairingPolicy),
    preferredLanAddress: typeof state.preferredLanAddress === 'string' ? state.preferredLanAddress : '',
    manualLanUrl: typeof state.manualLanUrl === 'string' ? state.manualLanUrl : '',
    /** 注册密钥设没设（值本身不回）。 */
    registerSecretSet: typeof state.registerSecret === 'string' && state.registerSecret !== '',
  };
}

/**
 * 把请求体收敛成一个可以交给 `settings.update` 的 patch。
 *
 * 逐项都按控制面 `/api/relay/config` 的判据来：**空串对 `preferredLanAddress` 是合法值**
 * （那是「清掉这次选择」的唯一方式），对 `name` 不是（改成一个没名字的宿主没有意义）。
 * 任何一项形状不对就整次拒绝 —— 部分写入会让用户以为全都改好了。
 */
function configPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: '请求体必须是一个对象' };
  const patch = {};
  if (body.relayUrl !== undefined) {
    if (typeof body.relayUrl !== 'string') return { ok: false, message: 'relayUrl 必须是字符串' };
    patch.relayUrl = body.relayUrl.trim();
  }
  if (body.lanEnabled !== undefined) {
    if (typeof body.lanEnabled !== 'boolean') return { ok: false, message: 'lanEnabled 必须是布尔值' };
    patch.lanEnabled = body.lanEnabled;
  }
  if (body.lanPort !== undefined) {
    if (!Number.isInteger(body.lanPort) || body.lanPort < 1024 || body.lanPort > 65535) {
      return { ok: false, message: 'lanPort 必须是 1024–65535 之间的整数' };
    }
    patch.lanPort = body.lanPort;
  }
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return { ok: false, message: 'name 必须是字符串' };
    const name = body.name.trim();
    if (!name) return { ok: false, message: '这台电脑的名字不能为空' };
    if (name.length > NAME_MAX_CHARS) return { ok: false, message: `名字最多 ${NAME_MAX_CHARS} 个字` };
    patch.name = name;
  }
  if (body.pairingPolicy !== undefined) {
    if (!pairingApproval.POLICIES.includes(body.pairingPolicy)) {
      return { ok: false, message: `配对策略只能是 ${pairingApproval.POLICIES.join(' / ')}` };
    }
    patch.pairingPolicy = body.pairingPolicy;
  }
  if (body.registerSecret !== undefined) {
    if (typeof body.registerSecret !== 'string' || body.registerSecret.length > 512) {
      return { ok: false, message: '注册密钥必须是 512 字以内的字符串' };
    }
    patch.registerSecret = body.registerSecret;
  }
  if (body.preferredLanAddress !== undefined) {
    if (typeof body.preferredLanAddress !== 'string' || body.preferredLanAddress.length > 64) {
      return { ok: false, message: '优先地址必须是 64 字以内的字符串（空串表示不指定）' };
    }
    patch.preferredLanAddress = body.preferredLanAddress.trim();
  }
  // 用户手填的直连地址：**空串是合法值**（= 清掉这条，回到只认网卡候选）。
  // 与 `relayUrl` 一样只挡类型与长度，格式由 `relay/lan-network.cjs` 的 `manualCandidate`
  // 在产候选那一步判 —— 这里拒掉一条「看着不像地址」的字符串，只会让手机上那句错误提示
  // 指向一个它自己也说不清的规则。
  if (body.manualLanUrl !== undefined) {
    if (typeof body.manualLanUrl !== 'string' || body.manualLanUrl.length > 200) {
      return { ok: false, message: '直连地址必须是 200 字以内的字符串（空串表示清掉）' };
    }
    patch.manualLanUrl = body.manualLanUrl.trim().replace(/\/+$/, '');
  }
  if (Object.keys(patch).length === 0) return { ok: false, message: '没有任何可改的字段' };
  return { ok: true, patch };
}

/** 响应写完再动手：这几条都会掐掉承载本请求的那条隧道。 */
function afterResponse(fn) {
  setTimeout(() => { void fn(); }, AFTER_RESPONSE_MS);
}

/**
 * 构造这组 handler。依赖由装配层注入，**只用取值器**：
 * `settings` 是 relay.json 的 config store（会随 watch 整体替换），
 * `state` 是内存真值（就地改），`syncSidecar` 让旁路重读配置。
 */
function createRelayControlHandlers(deps) {
  const {
    state,
    settings,
    syncSidecar,
    status,
    resolveLanPort,
    lanPortInUse,
    getLanPortAdjusted,
    restartSidecar = null,
    getSidecar = null,
    credentials = null,
    activeGuard = () => null,
    probeUrls = null,
    verifyRelay = null,
  } = deps || {};

  /**
   * 装配层没把真值接进来时（单测里只挂路由表、或某一版装配漏了），统一回 503 而不是让
   * handler 去读 undefined —— 那种错会被守卫兜成 500 `internal`，界面上看不出是「这台没
   * 这个能力」还是「代码坏了」，而这两件事的处置完全不同。
   */
  const unavailable = (res) => sendJson(res, 503, {
    ok: false,
    error: { code: 'relay-control-unavailable', message: '这台宿主的插件没有把中转配置接进来，改不了配置' },
  });
  const wired = Boolean(state && settings);

  /**
   * 把「配置变了」这件事真正推下去。
   *
   * 优先走 config store 的通知：装配层那唯一一个订阅者负责 `saveState` **与**重配 sidecar，
   * 走它才和桌面面板改配置是同一条路。没有 notify（测试里的假 store）才退回收 `syncSidecar`。
   */
  function applyNow() {
    if (typeof settings.notify === 'function') {
      try { settings.notify(); return; } catch { /* 退回收 syncSidecar */ }
    }
    return syncSidecar().catch(() => undefined);
  }

  /**
   * 把配置推下去，并**等它真的落地**（换地址那一发要等新隧道注册完）。
   *
   * 与 `applyNow()` 走同一条路：先让 config store 通知订阅者（桌面面板改配置也是这一条），
   * 再等这次下发的结果。失败会一路抛上来 —— 换地址失败必须如实回给调用方，而不是先回 200
   * 再往台账里记一笔。
   */
  async function applyNowAndWait() {
    if (typeof settings.notify === 'function') {
      try { settings.notify(); } catch { /* 退回收 syncSidecar */ }
    }
    return syncSidecar();
  }

  /**
   * 试连一次新地址：`stage:"prepare"` 的全部实现。
   *
   * **一行都不落盘**，也不碰正在服务的隧道：用临时实例 id（`probeInstanceId`）在一个**新**
   * 连接上注册，成功立刻断开。地址形状不对、连不上、注册被拒都把原因原样带回调用方 ——
   * 手机上那句错误就是它。
   */
  async function verifyTarget(patch) {
    const snapshot = typeof status === 'function' ? status() : {};
    const upstreamPort = Number(snapshot?.localPort);
    if (!Number.isInteger(upstreamPort) || upstreamPort <= 0) {
      return { ok: false, message: '宿主没报出本地网页端口，没法试连' };
    }
    const runner = typeof verifyRelay === 'function' ? verifyRelay : verifyRelayRegistration;
    try {
      await runner({
        relayUrl: patch.relayUrl,
        // 临时 id 必须与正式 id 不同：中转按实例 id 认人，拿正式 id 试连会把正在服务的那条顶掉。
        instanceId: probeInstanceId(state.instanceId),
        upstreamPort,
        name: typeof state.name === 'string' ? state.name : '',
        registerSecret: patch.registerSecret === undefined ? state.registerSecret : patch.registerSecret,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: String(error?.message || error) };
    }
  }

  /** 地址候选：与控制面 `/addresses` 同一份来源，三份分开报（理由见 lan-network.cjs）。 */
  function addressView() {
    const port = typeof lanPortInUse === 'function' ? lanPortInUse() : state.lanPort;
    const preferred = typeof state.preferredLanAddress === 'string' ? state.preferredLanAddress : '';
    return {
      port,
      preferred,
      adjusted: typeof getLanPortAdjusted === 'function' ? getLanPortAdjusted() === true : false,
      lan: lanCandidates(port),
      public: publicCandidates(port),
      ipv6: ipv6Candidates(port),
      /** 用户手填的那条直连地址（空串 = 没填）。与上面三份并列给出，界面不用拼。 */
      manual: typeof state.manualLanUrl === 'string' ? state.manualLanUrl : '',
    };
  }

  /** 故障台账摘要：只给最近几条的 kind / 时间 / 一句话，**不带堆栈**。 */
  function faultsView() {
    const guard = typeof activeGuard === 'function' ? activeGuard() : null;
    if (!guard || typeof guard.faults !== 'function') {
      return { installed: false, faults: [], stats: null };
    }
    const all = guard.faults();
    const tail = all.slice(-FAULT_TAIL).map((fault) => ({
      at: typeof fault.at === 'number' ? fault.at : 0,
      kind: typeof fault.kind === 'string' ? fault.kind : 'unknown',
      // 台账里 message 是 `describeError()` 的产物，可能带堆栈首行；只取第一行。
      message: String(fault.message || '').split('\n')[0].slice(0, 300),
      fatal: fault.fatal === true,
    }));
    const stats = typeof guard.stats === 'function' ? guard.stats() : null;
    return {
      installed: true,
      faults: tail,
      total: all.length,
      stats: stats ? {
        total: stats.total,
        consecutive: stats.consecutive,
        lastAt: stats.lastAt,
        fatal: stats.fatal === true,
      } : null,
    };
  }

  /** 把一条探测做得有界：打 `/healthz`，2xx/3xx 算通，耗时从发出到读完响应体。 */
  async function probeOne(url) {
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      const response = await fetch(`${url}/healthz`, { signal: controller.signal, redirect: 'follow' });
      clearTimeout(timer);
      await response.text().catch(() => '');
      return { url, ms: response.ok ? Date.now() - started : null };
    } catch {
      return { url, ms: null };
    }
  }

  /**
   * `GET /api/mobile/v1/relay/config` —— 当前配置 + 运行状态 + 地址候选。
   *
   * 一次给全：手机进这一页只要一发就能把「配了什么、现在通不通、能填哪条地址」都拿到，
   * 不需要连打四五条再自己拼。
   */
  async function handleRelayConfig(ctx, req, res) {
    // POST 也收在这一条路径上：契约写的是 `POST /api/mobile/v1/relay/config`，而 App 现在打
    // 的是 `/relay/config/save`（同一件事的两个名字）。宿主的注册器不按方法分派，所以这里
    // 自己分一次 —— 两条入口共用下面同一份实现，不存在第二套「改配置」。
    if (req && req.method === 'POST') return handleRelayConfigSave(ctx, req, res);
    if (!wired) return unavailable(res);
    sendJson(res, 200, {
      ok: true,
      config: configView(state),
      addresses: addressView(),
    });
  }

  /**
   * `POST /api/mobile/v1/relay/config/save`（`POST /relay/config` 同一份）—— 改配置。
   *
   * 三档结果（`stage` 是这次新增的那一格，老客户端不传）：
   *  · `stage:"prepare"` —— **一行都不落盘**，拿新地址用临时实例 id 真连一次中转，注册上了
   *    才回 `{ok:true, verified:true, target}`，否则 400 带原因。填错地址不再等于把自己锁在
   *    门外：先验证，再让用户点保存。
   *  · `stage:"commit"` —— 落盘并**等这次下发真的完成**：换地址时宿主会先在旧隧道上登记
   *    迁移、再重建（顺序见 lib/relay/migrate.js），失败会撤销登记并如实回错误。
   *  · 不传 `stage` —— 老 App 的行为一字不差：先回 200 再让旁路去重配。隧道照旧「先登记
   *    迁移再重建」，只是结果只能靠重连后读状态（`/diagnostics` 里有失败台账）。
   *
   * 只改了不进 sidecar 的项（`preferredLanAddress` / `name` / `manualLanUrl`）时当场改完、
   * 回新配置，手机不用重连。
   */
  async function handleRelayConfigSave(_ctx, req, res) {
    if (!wired) return unavailable(res);
    let body = {};
    try {
      body = (await readJsonBody(req, CONFIG_BODY_MAX)) || {};
    } catch {
      body = {};
    }
    const parsed = configPatch(body);
    if (!parsed.ok) {
      return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: parsed.message } });
    }
    const stage = body.stage === undefined ? null : body.stage;
    if (stage !== null && !STAGES.includes(stage)) {
      return sendJson(res, 400, {
        ok: false,
        error: { code: 'bad-request', message: `stage 只能是 ${STAGES.join(' / ')}` },
      });
    }
    // ── 第一段：试连，不落盘 ──
    if (stage === 'prepare') {
      const target = parsed.patch.relayUrl;
      if (target === undefined) {
        return sendJson(res, 400, {
          ok: false,
          error: { code: 'bad-request', message: '试连要带新的 relayUrl（它才是要验证的那个地址）' },
        });
      }
      if (!core.normalizeRelayUrl(target)) {
        return sendJson(res, 400, {
          ok: false,
          verified: false,
          target: '',
          error: { code: 'bad-request', message: '空地址没什么可试连的：要关掉中转请直接提交' },
        });
      }
      const probe = await verifyTarget(parsed.patch);
      if (!probe.ok) {
        return sendJson(res, 400, {
          ok: false,
          verified: false,
          target: core.normalizeRelayUrl(target),
          error: { code: 'relay-unverified', message: `这个地址连不上：${probe.message}` },
        });
      }
      // 到这里为止既没调 settings.update、也没碰压载着本请求的那条隧道。
      return sendJson(res, 200, { ok: true, verified: true, target: core.normalizeRelayUrl(target) });
    }
    // ── 第二段：落盘（`stage:"commit"` 或不传 stage）──
    const urlChanged = parsed.patch.relayUrl !== undefined
      && core.normalizeRelayUrl(parsed.patch.relayUrl) !== core.normalizeRelayUrl(state.relayUrl);
    try {
      // `notify: false` 是关键：订阅者（装配层那个 watch）一跑就会重配隧道，而那一发响应
      // 还没吐完。所以先只落盘，回完包再通知。
      await settings.update(parsed.patch, { notify: false });
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: { code: 'config-rejected', message: String(error?.message || error) },
      });
    }
    // 改了端口：下一次同步前必须重新探一次（首选端口被占时要让内核换一个），
    // 否则二维码与状态里报的仍是一个没人监听的端口。
    if (parsed.patch.lanPort !== undefined && typeof resolveLanPort === 'function') {
      await resolveLanPort().catch(() => undefined);
    }
    const view = { ok: true, config: configView(state), addresses: addressView() };
    // 显式 commit 且换了地址：必须等这次下发的结果。旧隧道在这期间还开着（见
    // lib/relay/migrate.js 的 linger），所以这一发响应仍然送得回去。
    if (stage === 'commit' && urlChanged) {
      try {
        await applyNowAndWait();
      } catch (error) {
        return sendJson(res, 502, {
          ok: false,
          config: configView(state),
          error: { code: 'relay-switch-failed', message: String(error?.message || error) },
        });
      }
      return sendJson(res, 200, { ...view, migrated: true });
    }
    sendJson(res, 200, view);
    // 推给旁路：改地址 / 端口 / 局域网开关都会重配隧道与直连，这一下多半会断。
    afterResponse(() => applyNow());
  }

  /**
   * `POST /api/mobile/v1/relay/enabled` —— 远程控制总开关。
   *
   * 单独一条而不是并进 config：它在控制面上也是单独一条（`/toggle`），而且**关掉它等于
   * 手机立刻失去这台电脑**（只能同网用局域网）。所以口径上与其余配置分开，界面上也要
   * 单独确认。
   */
  async function handleRelayToggle(_ctx, req, res) {
    if (!wired) return unavailable(res);
    let body = {};
    try {
      body = (await readJsonBody(req, CONFIG_BODY_MAX)) || {};
    } catch {
      body = {};
    }
    if (typeof body.enabled !== 'boolean') {
      return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'enabled 必须是布尔值' } });
    }
    try {
      await settings.update({ enabled: body.enabled }, { notify: false });
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: { code: 'config-rejected', message: String(error?.message || error) },
      });
    }
    sendJson(res, 200, { ok: true, enabled: state.enabled === true, config: configView(state) });
    afterResponse(() => applyNow());
  }

  /**
   * `POST /api/mobile/v1/relay/pairing-code` —— 重新生成配对码。
   *
   * 换码**同时也换票据**（`core.rotatePairing`）：只换码不换票据，截图里的票据还能再配
   * 一次；只换票据不换码，旧码在旧形状那条路上还能用。两件必须在同一个动作里。
   */
  async function handleRelayRegenerate(_ctx, _req, res) {
    if (!wired) return unavailable(res);
    try {
      core.rotatePairing(state);
      core.saveState(state);
    } catch (error) {
      return sendJson(res, 500, {
        ok: false,
        error: { code: 'rotate-failed', message: String(error?.message || error) },
      });
    }
    sendJson(res, 200, { ok: true, pairingCode: state.pairingCode });
    afterResponse(() => syncSidecar().catch(() => undefined));
  }

  /**
   * `POST /api/mobile/v1/relay/revoke-all` —— 吊销全部设备授权。
   *
   * **这一发会把这台手机自己也踢掉**（它就在「全部设备」里），所以必须先回包：回包之后
   * 隧道被拆，手机看到的是断线，重连时会发现自己已经没凭据了 —— 那正是用户要的结果。
   *
   * 三处都要做（与 `/api/relay/revoke-all` 同一条口径）：中转侧清授权、本机吊销局域网
   * `dshc_` 凭据、轮换 `lanSecret` 与配对码。只做其中一处都会留下还能用的旧凭据。
   */
  async function handleRelayRevokeAll(_ctx, req, res) {
    if (!wired) return unavailable(res);
    let body = {};
    try {
      body = (await readJsonBody(req, CONFIG_BODY_MAX)) || {};
    } catch {
      body = {};
    }
    if (body.confirm !== true) {
      return sendJson(res, 400, {
        ok: false,
        error: { code: 'confirm-required', message: '吊销全部授权不可撤销，请求需要带 confirm: true' },
      });
    }
    sendJson(res, 200, { ok: true, started: true });
    afterResponse(async () => {
      // 三处都要做（与控制面 `/api/relay/revoke-all` 同一条口径）：中转清空本实例全部设备
      // 授权、本机吊销局域网 `dshc_` 凭据、轮换 `lanSecret` 与配对码。只做其中一处都会留下
      // 还能用的旧凭据 —— 而「撤销全部授权」正是在要求它们**全部**失效。
      let revoked = 0;
      try {
        const sidecar = typeof getSidecar === 'function' ? getSidecar() : null;
        if (sidecar && typeof sidecar.request === 'function') {
          const result = await sidecar.request('/revoke-all', 'POST', undefined, 20_000);
          revoked = Number(result && result.revoked) || 0;
        }
      } catch { /* 中转不可达时仍继续吊销本机凭据与密钥 */ }
      try {
        const localRevoked = credentials && typeof credentials.revokeAllByInstance === 'function'
          ? credentials.revokeAllByInstance(state.instanceId)
          : 0;
        state.lanSecret = randomBytes(32).toString('hex');
        state.pairingCode = core.genPairingCode();
        core.saveState(state);
        console.warn(`[dsh-mobile-plugin] [relay-control] 已吊销全部授权：中转 ${revoked}、本机 ${localRevoked}`);
        await syncSidecar().catch(() => undefined);
      } catch (error) {
        console.warn('[dsh-mobile-plugin] [relay-control] 吊销后收尾失败：', String(error?.message || error));
      }
    });
  }

  /** `POST /api/mobile/v1/relay/reconnect` —— 让旁路重读配置并重建隧道。 */
  async function handleRelayReconnect(_ctx, _req, res) {
    if (!wired) return unavailable(res);
    sendJson(res, 200, { ok: true, started: true });
    afterResponse(() => syncSidecar().catch(() => undefined));
  }

  /**
   * `POST /api/mobile/v1/relay/restart-sidecar` —— 重启后台服务（worker + facade）。
   *
   * 与 `/api/relay/restart-sidecar` 是同一个动作：换掉 worker 子进程与 facade 模块，
   * 宿主本身不重启。隧道会断一两秒，这也是「先回包再动手」。
   */
  async function handleRelayRestartSidecar(_ctx, _req, res) {
    if (!wired) return unavailable(res);
    if (typeof restartSidecar !== 'function') {
      return sendJson(res, 409, {
        ok: false,
        error: { code: 'restart-unavailable', message: '这台宿主的插件版本不支持重启后台服务' },
      });
    }
    sendJson(res, 200, { ok: true, started: true });
    afterResponse(() => restartSidecar().catch(() => undefined));
  }

  /**
   * `POST /api/mobile/v1/relay/check-port` —— 端口自检。
   *
   * **只读，不写配置**（用户点着玩的动作不该改落盘状态）。用的是局域网代理同一把探针，
   * 所以这里说「可用」、真正 listen 时就不会 EADDRINUSE。
   *
   * 两个必须单独认出来的现场（与控制面同一条经验）：这台宿主自己的网页端口不能当直连
   * 端口；而它**自己正在监听**的那个端口，`canListen` 当然会失败，但那不是「被别的程序
   * 占用」。
   */
  async function handleRelayCheckPort(_ctx, req, res) {
    let body = {};
    try {
      body = (await readJsonBody(req, CONFIG_BODY_MAX)) || {};
    } catch {
      body = {};
    }
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return sendJson(res, 200, { ok: true, port: null, available: false, reason: 'out-of-range' });
    }
    const snapshot = typeof status === 'function' ? status() : {};
    const listening = snapshot?.lan?.state === 'listening';
    const currentPort = snapshot?.lan?.port;
    if (snapshot?.localPort === port) {
      return sendJson(res, 200, { ok: true, port, available: false, ours: false, listening, currentPort, reason: 'host-web-port' });
    }
    if (listening && currentPort === port) {
      return sendJson(res, 200, { ok: true, port, available: true, ours: true, listening, currentPort });
    }
    sendJson(res, 200, { ok: true, port, available: await canListen(port, '0.0.0.0'), ours: false, listening, currentPort });
  }

  /**
   * `POST /api/mobile/v1/relay/probe` —— 测中转候选的连通与耗时。
   *
   * **必须由宿主代测**：手机在蜂窝网络下直连那些域名可能被运营商挡、也可能被 CORS 挡住
   * （读到的是浏览器拦截而不是真实耗时）。宿主是出站无 CORS 的本机进程。
   *
   * 只认 http(s)、最多 8 条：这条不接受「任意地址探测」那种用法。
   */
  async function handleRelayProbe(_ctx, req, res) {
    let body = {};
    try {
      body = (await readJsonBody(req, CONFIG_BODY_MAX)) || {};
    } catch {
      body = {};
    }
    const list = Array.isArray(body.urls) ? body.urls : [];
    const targets = list
      .filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url.trim()))
      .slice(0, PROBE_MAX_URLS)
      .map((url) => url.trim().replace(/\/+$/, ''));
    const runner = typeof probeUrls === 'function' ? probeUrls : (urls) => Promise.all(urls.map(probeOne));
    const results = await runner(targets);
    sendJson(res, 200, { ok: true, results });
  }

  /**
   * `GET /api/mobile/v1/relay/diagnostics` —— 只读诊断：故障台账 + 地址候选的端口细节。
   *
   * 隧道为什么断、局域网为什么没起来，答案在故障台账与端口自检这两处；两条一起给，
   * 手机上一页就能回答「这台到底怎么了」。
   *
   * `apply` 那一格是「按新配置重建隧道」的失败台账：以前那一发被 `.catch(() => undefined)`
   * 吞掉，换地址失败在手机上表现为「保存成功、然后永久离线」，谁也说不清为什么。它只留最近
   * 一条（时间 + 一句话 + 当时要切过去的地址），不带堆栈 —— 宿主内部路径对手机没用。
   *
   * **不搬堆栈**：台账的 message 只取第一行，截断 300 字。
   */
  async function handleRelayDiagnostics(_ctx, _req, res) {
    if (!wired) return unavailable(res);
    const snapshot = typeof status === 'function' ? status() : {};
    sendJson(res, 200, {
      ok: true,
      faults: faultsView(),
      /** 最近一次「按新配置重建隧道失败」的错误与时间（见上方说明）。 */
      apply: applyLedger.view(),
      addresses: addressView(),
      /** 端口那两格的来历：「配置里写的」与「真的在监听的」可能不同。 */
      port: {
        requested: Number.isInteger(state.lanPort) ? state.lanPort : null,
        inUse: typeof lanPortInUse === 'function' ? lanPortInUse() : null,
        adjusted: typeof getLanPortAdjusted === 'function' ? getLanPortAdjusted() === true : false,
      },
      /** 隧道为什么被拒那几条判断（宿主那边按中转错误文案推出来的）。 */
      tunnel: snapshot?.tunnel ?? null,
    });
  }

  return {
    handleRelayConfig,
    handleRelayConfigSave,
    handleRelayToggle,
    handleRelayRegenerate,
    handleRelayRevokeAll,
    handleRelayReconnect,
    handleRelayRestartSidecar,
    handleRelayCheckPort,
    handleRelayProbe,
    handleRelayDiagnostics,
  };
}

module.exports = {
  createRelayControlHandlers,
  configView,
  configPatch,
  AFTER_RESPONSE_MS,
  CONFIG_BODY_MAX,
  PROBE_MAX_URLS,
  FAULT_TAIL,
  NAME_MAX_CHARS,
  STAGES,
};

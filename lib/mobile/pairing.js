'use strict';

/**
 * 移动端配对：手机在中转上用自己的配对码换到 token 与设备凭据。
 *
 * **这条路由归宿主，不归中转。**「谁可以进这台机器」是宿主自己的判断，配对码本来就存在
 * 宿主的 `state` 里；中转只按实例标识把请求转过来。早先这套判断长在独立的中转进程里
 * （`dsh-mobile-server/server.js` 的 `/pair`），换成 Rust 中转时整块没搬过去，于是手机
 * 按老地址 POST `/pair`、请求被中转原样转给宿主、宿主没有这条路由，只能回 405。
 *
 * 与局域网那条（`lib/relay/lan-proxy.js` 的 `/__lan_pair`）是**同一件事的两个入口**：
 * 都是「配对码 / 票据 → 签发凭据」，差别只在网络路径。凭据本身两条路签发的是同一种 HMAC
 * （都用宿主 lanSecret 签名），所以经中转配对拿到的 token 可以直接用于局域网请求。
 *
 * 请求体**两种形状都认**（讨论记录 §8.3(2)）：
 *   老形状  `{ instanceId?, code, device }`   —— 旧 App，明文，一字不改地照旧处理；
 *   新形状  `{ instanceId, sealed }`          —— 协议 v2，`sealed` 是用二维码票据派生的
 *                                                密钥封的，解出来是设备主密钥与设备信息。
 * 新形状里**没有配对码**：票据本身就是资格证明。回包同样是密文 —— 里面是 token / cookie /
 * 设备凭据，明文回包等于让中转顺手拿到这台设备未来一年的通行证。
 *
 * 故意**不**在这里做的事：
 *  - 不问宿主再确认一次。宿主的配对策略（pairingPolicy）已经决定了它接不接受新设备，
 *    `deny` 时中转根本连不上；而这条路由本身就跑在宿主进程里。
 *  - 不做「多台机器撞同一个配对码」的处理。那是中转的职责（它才看得见全部实例），
 *    在这台宿主上，配对码要么对上要么对不上。
 */

const { sendJson } = require('../shared/http-util');
const { safeEqual } = require('../shared/dshtoken');
const { createPairThrottle, PAIR_RATE_NORMAL } = require('../shared/pair-throttle');
const { openSealedPairRequest, sealPairResponse } = require('../shared/e2ee-pair');

/**
 * 一条入口一份闸门（见 `shared/pair-throttle.js` 头部的取舍说明）。
 *
 * 原来这里是「按来源分桶、错五次锁一分钟」，而这条链路上没有可靠的来源：经中转进来的
 * 请求对端永远是本机回环，客户端自带的来源头又能覆盖它。于是那套机制两头都错 ——
 * 陌生人连错五次把所有人一起锁死，换一个来源头就绕过。现在改成不看来源的全局令牌桶。
 */
const throttle = createPairThrottle();

/** 配对请求的线上上限：明文 16KB 按信封 4/3 放大（§8.3(9)）。超了就按畸形请求处理。 */
const PAIR_MAX_BODY = Math.ceil(16 * 1024 * 4 / 3);

/** 测试用：把闸门重置成满桶。 */
function resetPairLocks() {
  throttle.reset();
}

/**
 * 请求方地址，**只用于审计日志与设备记录**，不参与任何限流判定。
 *
 * 不再读 `x-real-ip`：那个值决定不了任何事，留着只会让日志和凭据记录说谎。局域网那条
 * 用的是连接对端（手机上真实的局域网地址，还有用）；经中转那条对端就是本机，本来没有
 * 信息量，记本机也不算错。
 */
function clientIp(req) {
  return (req && req.socket && req.socket.remoteAddress) || '';
}

/**
 * 配对码错误 / 策略拒绝统一回同一响应。
 *
 * 分开回等于告诉对方「这个码是真的，只是被拒了」，也就是把一个免费的存在性查询送出去。
 */
function pairDenied(res) {
  sendJson(res, 401, { ok: false, error: '配对码错误' });
}

/**
 * 读请求体。配对体很小（配对码 + 设备元信息），上限给 16KB。
 */
function readBody(req) {
  return new Promise((resolve) => {
    if (!req || typeof req.on !== 'function') {
      resolve({});
      return;
    }
    let raw = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve(null);
      }
    };
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      // 配对请求的明文上限仍是 16KB；线上多 4/3 是信封那层（§8.3(9)）。
      if (raw.length > PAIR_MAX_BODY) {
        raw = raw.slice(0, PAIR_MAX_BODY);
        req.destroy();
        finish();
      }
    });
    req.on('end', finish);
    req.on('error', finish);
  });
}

/**
 * 构造 `/pair` 的 handler。依赖由 impl.js 注入，与移动端其它路由同一形状。
 *
 * @param {object} deps
 * @param {object} deps.state  宿主状态（instanceId / pairingCode / lanSecret）
 * @param {Function} deps.readJsonBody
 * @param {object} deps.core    relay/core.js（签 token 用）
 * @param {object} deps.credentials 设备凭据库（issue 接口）
 * @param {object} deps.pairingApproval pairing-policy.js（决定这台机器收不收新设备）
 * @param {(port: number) => Array<object>} [deps.lanCandidates] 直连候选（与 `/connection-info` 同一份）
 * @param {(port: number) => Array<object>} [deps.ipv6Candidates] IPv6 直连候选
 * @param {() => number} [deps.lanPort] 宿主实绑的直连端口（配置端口被占时会换）
 * @param {(message: string) => void} deps.log
 */
function createPairHandler(deps) {
  const { state, core, credentials, pairingApproval, lanCandidates, ipv6Candidates, lanPort, log } = deps;
  /**
   * 配对成功之后换掉配对码与票据（§5.1）。
   *
   * **两件必须同一个动作**：只换码不换票据，那张截图里的票据依旧能配一次；只换票据不换码，
   * 旧码在旧形状那条路上依旧能配。所以这里是一个回调，由装配层一次做完（写状态 + 同步
   * 旁路），而不是在这里分两步。
   *
   * 传 null 表示不换（测试或旧装配方）。换不动不该让已经签发的配对失败 —— 用户手上已经
   * 拿到凭据了，回滚反而更糟；记一行日志就够。
   */
  const rotatePairing = typeof deps.rotatePairing === 'function' ? deps.rotatePairing : null;

  // ⚠️ 签名必须是 `(req, res)` **两个**参数：宿主 webServer 就是 `handler(req, res)` 调的。
  // 写成 `(_ctx, req, res)` 会把 res 挤成 undefined，而 sendJson 的 catch 会把那个
  // TypeError 当成「连接已关闭」吞掉——既没报错也没回包，请求永久挂住（/health 踩过）。
  return async function handlePair(req, res) {
    // 闸门：不看来源，满了直接 429 + retry-after，不排队也不硬锁。
    const gate = throttle.take();
    if (!gate.allowed) {
      res.setHeader?.('retry-after', String(gate.retryAfterSec));
      sendJson(res, 429, { ok: false, error: '尝试过于频繁，请稍后再试' });
      return;
    }

    const body = await readBody(req);
    if (!body || typeof body !== 'object') {
      sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      return;
    }

    const ip = clientIp(req);
    const instanceId = String(state.instanceId || '');

    // ── 形状判定 ──────────────────────────────────────────────────
    //
    // 有 `sealed` 就是协议 v2；有 `code` 就是旧 App 的老形状，**一字不改地照旧走**；
    // 两样都没有就是畸形请求。两条路只在「怎么拿到设备信息」上不同，签发凭据之后完全汇合。
    const sealed = typeof body.sealed === 'string' ? body.sealed.trim() : '';
    const isSealedShape = sealed !== '';

    // ── 可猜形状的收口（§10.4(d)）─────────────────────────────────
    //
    // 新 App 已经没有手输这条路了：二维码里带着票据，扫到就走 `sealed`。所以「认得协议、
    // 却还带着六位码」只可能是一张过期的旧二维码（截图、面板重开之前的那份）。这个形状
    // 的码是逐位可试的，没有必要继续为它开门 —— 直接让它重扫当前那张。
    //
    // **判据是请求里带没带 `proto`，不是版本号**：老 App 没有协议概念、不带这个字段，
    // 照旧能配；而版本号在 OTA 里并不一定变（热更换的是 JS，App 版本还是那个），拿它
    // 当判据会把「就是不给更新的人」和「已经更新的人」一起判错。
    if (!isSealedShape && body.proto !== undefined) {
      sendJson(res, 400, {
        ok: false,
        code: 'legacy-pairing-retired',
        error: '这张二维码已过期，请重新扫一下电脑面板上当前的二维码',
      });
      return;
    }

    let supplied;
    let issuedExtra;
    let pairKey = null;
    if (isSealedShape) {
      const opened = openSealedPairRequest({
        ticket: state.pairingTicket,
        instanceId,
        sealed,
        claimedInstanceId: typeof body.instanceId === 'string' ? body.instanceId : '',
      });
      if (!opened.ok) {
        // 解不开就是「配对失败」，不回细节 —— 与「配对码错」同形，不给探测空间。
        throttle.noteFail();
        pairDenied(res);
        return;
      }
      supplied = opened.device;
      issuedExtra = { deviceKey: opened.deviceKey, keyId: opened.keyId };
      pairKey = opened.pairKey;
    } else {
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      if (!/^\d{6}$/.test(code)) {
        sendJson(res, 400, { ok: false, error: '配对码需为 6 位数字' });
        return;
      }
      const expected = String(state.pairingCode || '');
      if (!expected || !safeEqual(code, expected)) {
        throttle.noteFail();
        pairDenied(res);
        return;
      }
      supplied = body.device && typeof body.device === 'object' ? body.device : {};
    }

    // 还要宿主自己的策略点头：'deny' 就是明确不收新设备。
    const decision = pairingApproval.evaluate(state.pairingPolicy, supplied);
    if (!decision.approved) {
      // 被拒的尝试同样要记数，否则猜对码但被策略拒的一方可以无限重试。
      throttle.noteFail();
      pairDenied(res);
      return;
    }

    // 只有真正放行才清零并回满档。
    throttle.noteSuccess();

    const device = {
      ...Object.fromEntries(Object.entries(supplied).filter(([, value]) => value !== undefined)),
      ip,
    };

    let issued;
    try {
      issued = credentials.issue(instanceId, device, '', undefined, issuedExtra);
    } catch (error) {
      log('pair issue failed:', error && error.message);
      sendJson(res, 500, { ok: false, error: 'internal error' });
      return;
    }

    // 成功签发之后立刻换码 + 换票据：谁截了二维码，那张图从这一刻起就没有用了。
    if (rotatePairing) {
      try {
        rotatePairing();
      } catch (error) {
        log('pair rotate failed:', error && error.message);
      }
    }

    // 三样给的是**同一枚**（§3.2 的 T1 口径）：`token`（`Authorization: Bearer`）、
    // `cookie`（中转路由用的那张）与 `deviceCredential` 全等于刚签发的每设备凭据。
    //
    // 不再另签一张全局 HMAC Bearer：那张有效期一年、不带设备身份，发出去就吊销不掉 ——
    // 而「单台吊销」正是 T1 存在的理由。一枚凭据既是通行证、又能在库里查到。
    // 老 App 把整串当不透明串存起来，三段形状没变，它不需要改。
    const token = issued.credential;
    const cookieValue = issued.credential;
    const hostPlatform = pairingApproval.hostPlatform().platform;
    // 宿主自己那批直连候选随配对一起回给手机：手输公网地址（域名 / 公网 IP）配对时没有
    // 二维码，这是手机拿到内网地址的唯一机会。回家后那个公网地址若打不通（路由器不支持
    // 回环 / 域名只在外网解析），手机可以靠这批候选找到这台机器，否则只能删设备重配。
    // 语义与 `/connection-info` 那份一致（`advertisedCandidates`：有私网只给私网），
    // 关掉局域网直连时两份都为空。App 的 `doPair` 本来就合并这两个字段。
    const port = typeof lanPort === 'function' ? lanPort() : state.lanPort
    const directCandidates = state.lanEnabled && typeof lanCandidates === 'function'
      ? lanCandidates(port).map((candidate) => candidate.url).filter(Boolean)
      : []
    const v6Candidates = state.lanEnabled && typeof ipv6Candidates === 'function'
      ? ipv6Candidates(port).map((candidate) => candidate.url).filter(Boolean)
      : []
    const payload = {
      ok: true,
      // 协议版本回给手机：它据此把 `MobileSession.proto` 落盘，之后每条请求按它决定发不发
      // 信封。**握手时定死**，不逐请求协商（协商就等于给中转一个降级开关）。
      proto: isSealedShape ? 2 : 1,
      instanceId,
      token,
      // cookie 同时放进 body：RN 的 fetch 读不到 Set-Cookie，App 得自己带上。
      cookie: `dsh_lan=${cookieValue}`,
      deviceId: issued.deviceId,
      deviceCredential: issued.credential,
      credentialExpiresAt: issued.expiresAt,
      // 手机拿它对一次时钟（§8.3(7)）：时钟偏太多会被当成重放，而用户完全不知道
      // 「这个 App 连不上」的原因是手机时间不准。
      serverTime: Date.now(),
      // 宿主自己的系统标识，不是手机的。键名**必须是 `hostPlatform`**：App 落盘的就是它
      //（app/src/services/pairApi.ts 读 `body.hostPlatform` 存进 `MobileSession.hostPlatform`），
      // 局域网那条（lan-proxy.js）给的也是它。`hostPlatform()` 回的是 `{platform}` 对象，
      // 整块展开就变成 `platform` —— App 收不到，设备行退回通用图标（真机上少的就是企鹅）。
      ...(hostPlatform ? { hostPlatform } : {}),
      ...(directCandidates.length ? { lanUrls: directCandidates } : {}),
      ...(v6Candidates.length ? { ipv6Candidates: v6Candidates } : {}),
    };

    // 新协议的回包必须加密：里面有 token / cookie / deviceCredential，明文回包等于让
    // 中转顺手拿到这台设备未来一年的通行证。
    if (pairKey) {
      try {
        sendJson(res, 200, sealPairResponse(pairKey, instanceId, payload));
      } catch (error) {
        log('pair seal failed:', error && error.message);
        sendJson(res, 500, { ok: false, error: 'internal error' });
      }
      return;
    }
    sendJson(res, 200, payload);
  };
}

module.exports = {
  createPairHandler,
  resetPairLocks,
  clientIp,
  openSealedPairRequest,
};

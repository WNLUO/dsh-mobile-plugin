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
 * 都是「配对码 → 签发凭据」，差别只在网络路径。凭据本身两条路签发的是同一种 HMAC
 * （都用宿主 lanSecret 签名），所以经中转配对拿到的 token 可以直接用于局域网请求。
 *
 * 故意**不**在这里做的事：
 *  - 不问宿主再确认一次。宿主的配对策略（pairingPolicy）已经决定了它接不接受新设备，
 *    `deny` 时中转根本连不上；而这条路由本身就跑在宿主进程里。
 *  - 不做「多台机器撞同一个配对码」的处理。那是中转的职责（它才看得见全部实例），
 *    在这台宿主上，配对码要么对上要么对不上。
 */

const { sendJson } = require('../shared/http-util');
const { safeEqual } = require('../shared/dshtoken');

/** 与局域网那条同口径：连错 5 次锁 60 秒。 */
const PAIR_MAX_FAILS = 5;
const PAIR_LOCK_MS = 60_000;

/** ip -> { fails, lockedUntil }。放在模块作用域，两种入口共用同一份额度。 */
const pairLocks = new Map();

function isPairLocked(ip) {
  const entry = pairLocks.get(ip);
  return !!entry && entry.lockedUntil > Date.now();
}

function recordPairFail(ip) {
  const entry = pairLocks.get(ip) || { fails: 0, lockedUntil: 0 };
  entry.fails += 1;
  if (entry.fails >= PAIR_MAX_FAILS) {
    entry.lockedUntil = Date.now() + PAIR_LOCK_MS;
    entry.fails = 0;
  }
  pairLocks.set(ip, entry);
}

function clearPairFails(ip) {
  pairLocks.delete(ip);
}

/** 测试用：清空限流计数。 */
function resetPairLocks() {
  pairLocks.clear();
}

/** 请求方 IP。中转会把真实来源放进 x-real-ip（与 nginx 同一约定）。 */
function clientIp(req) {
  const headers = (req && req.headers) || {};
  const raw = headers['x-real-ip'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header === 'string' && header.trim()) return header.trim();
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
      if (raw.length > 16 * 1024) {
        raw = raw.slice(0, 16 * 1024);
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
 * @param {(message: string) => void} deps.log
 */
function createPairHandler(deps) {
  const { state, core, credentials, pairingApproval, log } = deps;

  // ⚠️ 签名必须是 `(req, res)` **两个**参数：宿主 webServer 就是 `handler(req, res)` 调的。
  // 写成 `(_ctx, req, res)` 会把 res 挤成 undefined，而 sendJson 的 catch 会把那个
  // TypeError 当成「连接已关闭」吞掉——既没报错也没回包，请求永久挂住（/health 踩过）。
  return async function handlePair(req, res) {
    const ip = clientIp(req);

    if (isPairLocked(ip)) {
      sendJson(res, 429, { ok: false, error: '尝试过于频繁，请稍后再试' });
      return;
    }

    const body = await readBody(req);
    if (!body || typeof body !== 'object') {
      sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      return;
    }

    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!/^\d{6}$/.test(code)) {
      sendJson(res, 400, { ok: false, error: '配对码需为 6 位数字' });
      return;
    }

    const expected = String(state.pairingCode || '');
    if (!expected || !safeEqual(code, expected)) {
      recordPairFail(ip);
      pairDenied(res);
      return;
    }

    // 配对码对了，还要宿主自己的策略点头：'deny' 就是明确不收新设备。
    const decision = pairingApproval.evaluate(state.pairingPolicy, body.device);
    if (!decision.approved) {
      recordPairFail(ip);
      pairDenied(res);
      return;
    }

    // **配对码正确时不清限流计数**：被拒的尝试同样要记数，否则猜对码但被策略拒的一方
    // 可以无限重试。只有真正放行才清零。
    clearPairFails(ip);

    const instanceId = String(state.instanceId || '');
    const supplied = body.device && typeof body.device === 'object' ? body.device : {};
    const device = {
      ...Object.fromEntries(Object.entries(supplied).filter(([, value]) => value !== undefined)),
      ip,
    };

    let issued;
    try {
      issued = credentials.issue(instanceId, device, '');
    } catch (error) {
      log('pair issue failed:', error && error.message);
      sendJson(res, 500, { ok: false, error: 'internal error' });
      return;
    }

    // 两样都要给，缺一样 App 就停在「配对响应缺少 token/cookie」：
    //  - `token` 是 **bearer**（`Authorization: Bearer …`），365 天；
    //  - `cookie` 是**中转路由**用的那张，30 天。
    // 两者的 TTL 刻意不同，别合成一个常量（见 relay/core.js 的 MOBILE_BEARER_TTL_SEC 注释）。
    const token = core.signLanToken(state.lanSecret, instanceId, core.MOBILE_BEARER_TTL_SEC);
    const cookieValue = core.signLanToken(state.lanSecret, instanceId, core.MOBILE_TOKEN_TTL_SEC);
    const hostPlatform = pairingApproval.hostPlatform().platform;
    sendJson(res, 200, {
      ok: true,
      instanceId,
      token,
      // cookie 同时放进 body：RN 的 fetch 读不到 Set-Cookie，App 得自己带上。
      cookie: `dsh_lan=${cookieValue}`,
      deviceId: issued.deviceId,
      deviceCredential: issued.credential,
      credentialExpiresAt: issued.expiresAt,
      // 宿主自己的系统标识，不是手机的。键名**必须是 `hostPlatform`**：App 落盘的就是它
      //（app/src/services/pairApi.ts 读 `body.hostPlatform` 存进 `MobileSession.hostPlatform`），
      // 局域网那条（lan-proxy.js）给的也是它。`hostPlatform()` 回的是 `{platform}` 对象，
      // 整块展开就变成 `platform` —— App 收不到，设备行退回通用图标（真机上少的就是企鹅）。
      ...(hostPlatform ? { hostPlatform } : {}),
    });
  };
}

module.exports = {
  createPairHandler,
  resetPairLocks,
  clientIp,
  PAIR_MAX_FAILS,
  PAIR_LOCK_MS,
};

'use strict';

/**
 * 旧凭据原地升级：把协议 v1 的会话（HMAC 令牌 / 只带配对码的 `dshc_`）换成带设备主密钥的
 * T1，让一台早就配好的手机不用重新扫码就能开始加密。
 *
 * **主密钥以手机为准**（2026-10-24 修）：手机在本地生成 `deviceKey` 与 `keyId`，这次升级
 * 请求里明文带上，宿主原样存进凭据库、把同一个 `keyId` 回给手机。宿主**不能**自己生成
 * 一把再回标识 —— 那会让两端各拿一把钥匙，升级完手机立刻按 v2 封请求，而宿主用另一把
 * 验签，之后每一条请求都是 `e2ee-bad-signature`，比不升级更糟。
 *
 * 明文上行是一次性的取舍：老会话手上只有旧凭据，既没有二维码里那张票据，也没有任何别的
 * 保密通道（局域网直连与公网 IPv6 直连都是明文 HTTP，中转本来就按「不可信的那一跳」设计）。
 * 不这么做就只能让用户重新扫一次码。升级之后所有流量仍由这把钥匙端到端加密。
 *
 * 换成什么不在本次判断里：拿到完整一套（凭据 + 密钥 + 标识）才回补丁，缺一样就当没升级。
 *
 * **请求体必须现读**（2026-10-25 修）：这条路服务的恰好是协议 v1 的老会话，而老会话发的
 * 是明文 —— 守卫只为「带信封」的那条路预先解好 `req.body`，明文请求的字节还挂在 socket 上
 * 没人读过。原来这里直接取 `req.body`，于是永远拿到空对象、宿主每次都回「没升级」，手机
 * 那边一次都没成功过（真机表现是「App 与插件都更新了，设备行仍旧写链路未加密」）。
 * 现在与其它移动端路由同一条读法（`readJsonBody`：`req.body` 有就用，没有就读流）。
 */

const crypto = require('node:crypto');
const { sendJson, readJsonBody } = require('../shared/http-util.js');
const { DEVICE_KEY_RE, KEY_ID_RE } = require('../shared/e2ee-pair.js');

/** 请求出示的设备凭据：独立头优先，`Authorization` 只用于兼容早期客户端。 */
function presentedCredential(req) {
  const header = req.headers && req.headers['x-dsh-device-credential'];
  if (typeof header === 'string' && header) return header;
  const match = /^Bearer\s+([^\s]+)$/.exec(String((req.headers && req.headers.authorization) || ''));
  return match ? match[1] : null;
}

/** 手机这次带上来的密钥材料；没带或形状不对都返回 null。 */
function deviceSecretOf(body) {
  if (!body || typeof body !== 'object') return null;
  const device = body.device && typeof body.device === 'object' ? body.device : {};
  const pick = (key) => {
    const top = body[key];
    if (typeof top === 'string' && top) return top;
    const inner = device[key];
    return typeof inner === 'string' && inner ? inner : '';
  };
  const deviceKey = pick('deviceKey');
  const keyId = pick('keyId');
  if (!deviceKey && !keyId) return null;
  return { deviceKey, keyId };
}

/**
 * 处理 `POST /api/mobile/v1/device-credential/upgrade`。
 *
 * @param {object} req
 * @param {object} res
 * @param {{ instanceId: string, store: object, log?: Function }} deps
 */
async function handleCredentialUpgrade(req, res, deps) {
  const instanceId = String((deps && deps.instanceId) || '');
  const store = deps && deps.store;
  if (!store) return sendJson(res, 503, { ok: false, error: { code: 'unavailable', message: '凭据库不可用' } });

  const presented = presentedCredential(req);
  const record = presented ? store.lookup(presented, instanceId) : null;
  // 见文件头：明文请求的体没人读过，必须在这里现读（读法与其它移动端路由一致）。
  const parsed = await readJsonBody(req, 64 * 1024);
  const body = parsed && typeof parsed === 'object' ? parsed : {};
  const meta = body.device && typeof body.device === 'object' ? body.device : body;
  const deviceId = String(meta.deviceId || meta.id || (record && record.deviceId) || '');

  const secret = deviceSecretOf(body);

  // 没带密钥材料：只可能是旧客户端或它没准备好。已经在 T1 上的顺手续期并如实回一句
  // 「没换东西」；还在 v1 上的什么都不动 —— 宿主不代生成密钥（见文件头）。
  if (!secret) {
    if (record && record.deviceKey && record.keyId) {
      store.renew(record);
      return sendJson(res, 200, {
        ok: true,
        upgraded: false,
        proto: 2,
        instanceId,
        token: presented,
        cookie: `dsh_lan=${presented}`,
        deviceCredential: presented,
        keyId: record.keyId,
        deviceId: record.deviceId,
        credentialExpiresAt: record.expiresAt || null,
        serverTime: Date.now(),
      });
    }
    return sendJson(res, 200, {
      ok: true,
      upgraded: false,
      proto: 1,
      instanceId,
      token: presented || '',
      cookie: presented ? `dsh_lan=${presented}` : '',
      deviceCredential: presented || '',
      deviceId,
      serverTime: Date.now(),
    });
  }

  // 带了却不合形状：这是实现错了，不是「还没准备好」。写进凭据库会变成一台永远验不过的
  // 设备，所以当场拒掉。
  if (!DEVICE_KEY_RE.test(secret.deviceKey) || !KEY_ID_RE.test(secret.keyId)) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'bad-device-secret', message: 'deviceKey / keyId 形状不对' },
    });
  }

  // 同一个 keyId 已经登记过一枚（上一次的响应可能在路上丢了，手机又发了一遍）：
  // **不再签发第二条** —— 手机留着手上这枚凭据、按 v2 签名，宿主按 keyId 验签，链路照样通。
  // 没有这一条时每次重试都往库里堆一条记录（实测同一台设备 54 分钟里堆了 39 条，
  // 面板上于是出现一堆同名的行）。
  const known = presented && typeof store.findByKeyId === 'function'
    ? store.findByKeyId(instanceId, secret.keyId)
    : null;
  if (known) {
    store.touch(known, { channel: 'upgrade', meta: { ...meta, deviceId: known.deviceId } });
    return sendJson(res, 200, {
      ok: true,
      upgraded: true,
      proto: 2,
      instanceId,
      token: presented,
      cookie: `dsh_lan=${presented}`,
      deviceCredential: presented,
      keyId: known.keyId,
      deviceId: known.deviceId,
      credentialExpiresAt: known.expiresAt || null,
      serverTime: Date.now(),
    });
  }

  const issued = store.issue(instanceId, { ...meta, deviceId }, '', undefined, {
    deviceKey: secret.deviceKey,
    keyId: secret.keyId,
  });
  // 旧记录**不立刻吊销**：无法确认手机真的把新的存下来了，立刻吊销会把一台正常设备锁在
  // 门外。让它自然过期，期间它仍走旧 HMAC 兜底那条路。
  return sendJson(res, 200, {
    ok: true,
    upgraded: true,
    proto: 2,
    instanceId,
    token: issued.credential,
    cookie: `dsh_lan=${issued.credential}`,
    deviceCredential: issued.credential,
    keyId: secret.keyId,
    deviceId: issued.deviceId,
    credentialExpiresAt: issued.expiresAt,
    serverTime: Date.now(),
  });
}

module.exports = { handleCredentialUpgrade, presentedCredential, deviceSecretOf };

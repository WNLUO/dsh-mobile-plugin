/**
 * relay.json 的状态形状与读写，外加实例 ID / 配对码 / 隧道地址这几个纯函数。
 *
 * 内存里的 `state` 是本进程唯一真值，这里只负责落盘与还原（见 A3-20 的坑）。中转地址的
 * 规范形态（`normalizeRelayUrl`）也在这里：配置里、设备手上、`MIGRATE` 帧里必须是同一份
 * 字符串，否则「地址变了」会被判错，迁移登记白跑一次。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sharedToken = require('../shared/dshtoken');
const paths = require('../shared/paths');

const STATE_FILE = paths.relayStateFile();
/** 浏览器/局域网代理签发的 `dsh_lan` Cookie 有效期（30 天）。 */
const MOBILE_TOKEN_TTL_SEC = 30 * 24 * 3600;
/**
 * App 侧长期 bearer token 的有效期（1 年）。
 *
 * App 没有续签流程，这个 token 只能靠宿主轮换 `lanSecret`（`/api/relay/revoke-all`）
 * 整体作废；单设备吊销改由 `dshc_` 设备凭据承担（见 `lib/mobile/auth.js`）。
 * 旧实现把它写成 10 年，且与 Cookie 的 30 天完全脱钩，`MOBILE_TOKEN_TTL_SEC`
 * 这个常量实际上从未被任何人使用过。
 */
const MOBILE_BEARER_TTL_SEC = 365 * 24 * 3600;

function genInstanceId() { return crypto.randomBytes(4).toString('hex'); }
function genPairingCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
/**
 * 二维码里那张一次性票据：32 字节随机数的 base64url（43 字符，无补位）。
 *
 * 它是**密钥材料**：手机拿它派生配对密钥，所以谁看到二维码谁就能配一次。它由宿主自己
 * 生成、写进二维码、绝不经过中转 —— 中转连它长什么样都看不到。
 */
function genPairingTicket() { return crypto.randomBytes(32).toString('base64url'); }
function defaultState() {
  return {
    instanceId: genInstanceId(), pairingCode: genPairingCode(), pairingTicket: genPairingTicket(), relayUrl: '', name: os.hostname(),
    lanEnabled: true, lanPort: 18787, lanSecret: crypto.randomBytes(32).toString('hex'), enabled: false,
    // 中转侧 TUNNEL_REGISTER_SECRET 的对偶值。为空时隧道注册会被中转以
    // close(1008, 'bad registration secret') 拒掉（除非中转根本没开校验）。
    registerSecret: '',
    // 手机优先用哪条地址（空 = 不指定）。它是 `RemoteControlSettingsSchema` 里的一项，
    // 写它不碰 sidecar（那份配置是 `impl.js` 的 `buildConfig` 逐字段拼的，不带它）。
    preferredLanAddress: '',
    // 用户手填的直连地址（空 = 没填）。与上面那条同一条口径：也是 schema 里的一项、
    // 也不进 sidecar 配置 —— 它只影响「报给手机的候选」与二维码，不影响隧道怎么连。
    manualLanUrl: '',
    // 首次接入引导走完没有。**刻意不进 RemoteControlSettingsSchema**：它不是一项
    // 「远程控制设置」，改它不该触发 sidecar 重配（那条链上每加一个字段都要同步改
    // schema、worker 的 allowed 数组与 buildConfig，漏一处就抛 unknown field）。
    // 它只是面板用来决定「打开先走引导还是直接进主页」的一个落盘标记，
    // `settings.update()` 的 Object.assign 不会碰它（schema 里没这个键）。
    onboarded: false,
  };
}
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { ...defaultState(), ...raw };
  } catch {
    const state = defaultState();
    saveState(state);
    return state;
  }
}
/**
 * 配对成功之后换掉配对码与票据（§5.1）。
 *
 * **两件必须同一个动作**：只换码不换票据，那张截图里的票据还能再配一次；只换票据不换码，
 * 旧码在旧形状那条路上还能用。所以这里一次改两个字段、一次落盘。
 *
 * 放在这里而不是装配层：它只碰 state，是可单测的纯状态变更；装配层只负责在写完之后
 * 让旁路重读配置。
 */
function rotatePairing(state) {
  state.pairingCode = genPairingCode();
  state.pairingTicket = genPairingTicket();
  saveState(state);
  return { pairingCode: state.pairingCode, pairingTicket: state.pairingTicket };
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}
/**
 * 中转地址的规范形态：去首尾空白、去尾斜杠。
 *
 * 设备手上存的那份、`MIGRATE` 帧里报出去的 `to`、配置里落盘的那份，必须是同一个字符串 ——
 * 差一个尾斜杠就是「地址变了」，换地址那套迁移登记会白跑一次。
 */
function normalizeRelayUrl(relayUrl) {
  return String(relayUrl || '').trim().replace(/\/+$/, '');
}
/**
 * 中转地址 → 隧道 WebSocket 地址。
 *
 * 旧实现只是把 `http` 前缀替换成 `ws`，因此 `example.com:8700`、`//relay.example`
 * 这类缺协议的输入会生成一个 `new WebSocket()` 直接拒绝的字符串，错误要等到
 * 隧道连接阶段才以 `tunnel.state='error'` 的形式浮现。这里提前抛错，让
 * `/api/relay/config` 能在保存时就给出明确反馈。
 */
function tunnelWsUrl(relayUrl) {
  const raw = normalizeRelayUrl(relayUrl);
  if (!/^https?:\/\/[^\s/]+/i.test(raw)) {
    throw new Error(`无效的中转地址「${relayUrl || ''}」：必须以 http:// 或 https:// 开头`);
  }
  return `${raw.replace(/^http/i, 'ws')}/tunnel`;
}
function signLanToken(secret, instanceId, ttlSec = MOBILE_TOKEN_TTL_SEC) { return sharedToken.signLanToken(secret, instanceId, ttlSec); }
function verifyLanToken(secret, token, instanceId) { return sharedToken.verifyLanToken(secret, token, instanceId); }

module.exports = {
  STATE_FILE, MOBILE_TOKEN_TTL_SEC, MOBILE_BEARER_TTL_SEC, loadState, saveState, rotatePairing, genInstanceId, genPairingCode, genPairingTicket,
  tunnelWsUrl, normalizeRelayUrl, signLanToken, verifyLanToken,
};

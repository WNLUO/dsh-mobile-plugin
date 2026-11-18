/**
 * relay.json 的状态形状与读写，外加实例 ID / 配对码 / 隧道地址这几个纯函数。
 *
 * 内存里的 `state` 是本进程唯一真值，这里只负责落盘与还原（见 A3-20 的坑）。中转地址的
 * 规范形态（`normalizeRelayUrl`）也在这里：配置里、设备手上、`MIGRATE` 帧里必须是同一份
 * 字符串，否则「地址变了」会被判错，迁移登记白跑一次。
 *
 * 地址是**一组**：`relayUrls` 是完整列表、`relayUrl` 恒为它的首项（`docs/relay-multi-address.md`）。
 * 读盘 / 落盘 / 一次配置写入各收敛一次，`relayUrls[0] === relayUrl` 这条才不会在某一处走样。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sharedToken = require('../shared/dshtoken');
const paths = require('../shared/paths');

const STATE_FILE = paths.relayStateFile();
/** 局域网代理签发的 `dsh_lan` Cookie 有效期（30 天），也是 `signLanToken` 的默认值。 */
const MOBILE_TOKEN_TTL_SEC = 30 * 24 * 3600;
/**
 * 全局 bearer token 的有效期（1 年）。
 *
 * 当前配对签发的是每设备凭据（`token` / cookie / `deviceCredential` 三者同值），只有隧道
 * `pairRequest` 那条兼容路径还会签这张不带设备身份的 token。它没有续签流程，只能靠宿主
 * 轮换 `lanSecret`（`/api/relay/revoke-all`）整体作废；单设备吊销由 `dshc_` 设备凭据承担
 * （见 `lib/mobile/auth.js`）。
 */
const MOBILE_BEARER_TTL_SEC = 365 * 24 * 3600;

/**
 * 实例 id（128 位随机、32 位十六进制）。
 *
 * 它同时是「总控地址目录」里的设备标识：知道它对不上令牌就改不了别人（见 relay/control.js 的
 * 令牌绑定），所以**不可猜**很重要。早先是 4 字节（32 位，8 位十六进制），一个知道它的攻击者
 * 有机会抢在某台新设备首次注册前把它占了；加长到 16 字节后这种枚举不现实。
 * 老设备的 id 保持原样（改了等于换身份、配对全失效），只有新装/重建的才用新的长度。
 */
function genInstanceId() { return crypto.randomBytes(16).toString('hex'); }
function genPairingCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
/**
 * 二维码里那张一次性票据：32 字节随机数的 base64url（43 字符，无补位）。
 *
 * 它是**密钥材料**：手机拿它派生配对密钥，所以谁看到二维码谁就能配一次。它由宿主自己
 * 生成、写进二维码、绝不经过中转 —— 中转连它长什么样都看不到。
 */
function genPairingTicket() { return crypto.randomBytes(32).toString('base64url'); }
/** 实例历史密钥（HK）：32 字节随机数的 base64url。**密钥材料**，绝不进中转。 */
function genHistoryKey() { return crypto.randomBytes(32).toString('base64url'); }
function defaultState() {
  return {
    instanceId: genInstanceId(), pairingCode: genPairingCode(), pairingTicket: genPairingTicket(), relayUrl: '', relayUrls: [], name: os.hostname(),
    // 新配对设备的权限档位（只读 / 可答审批 / 全权）。缺省 full = 与单 token 全给等价；
    // 老状态文件没这一格时靠这里兜底，别在别处再判一次「没有就拒绝」。
    pairingTier: 'full',
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
    // 用户手填的 IPv6 直连地址（空 = 没填）。与上一条同一条口径：schema 里的一项、不进
    // sidecar 配置，只影响「报给手机的 IPv6 候选」与二维码。
    manualIpv6Url: '',
    // 用户手填的「TCP 直连」目标（空 = 没填，形如 `主机:端口` 或 `http://主机:端口`，IPv6 用方括号）。
    // 与上面两条并列、同样**不进 sidecar 配置**：它只决定手机经本机回环（安卓直接）用裸 TCP
    // 拨哪个目标，不影响隧道怎么连。schema 里的一项，改它不该触发 sidecar 重配。
    manualTcpUrl: '',
    // 首次接入引导走完没有。**刻意不进 RemoteControlSettingsSchema**：它不是一项
    // 「远程控制设置」，改它不该触发 sidecar 重配（那条链上每加一个字段都要同步改
    // schema、worker 的 allowed 数组与 buildConfig，漏一处就抛 unknown field）。
    // 它只是面板用来决定「打开先走引导还是直接进主页」的一个落盘标记，
    // `settings.update()` 的 Object.assign 不会碰它（schema 里没这个键）。
    onboarded: false,
    // 实例历史密钥（HK）：32 字节随机数的 base64url，加密离线历史 blob 用。**绝不进中转**，
    // 只在配对封包里下发给手机。缺失时由 `ensureHistoryKey` 惰性生成并落盘；这里是空串，
    // 不能给一个随机默认值 —— 读盘成功时不回写，随机默认会让每次重启都换一把新钥。
    historyKey: '',
  };
}
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // 读盘即收敛：`relayUrls` 与 `relayUrl` 是同一件事的两种写法，落盘那份可能被手改过
    // 或者来自还没写这格的老版本，两条不变式必须在这里先成立（见 docs/relay-multi-address.md）。
    const merged = { ...defaultState(), ...raw };
    // **老文件里没有这一格**：默认值那个空数组会顶上来，把「只有 relayUrl 一条」判成
    // 「明确没有中转」，地址当场被清空。所以先把这一格撤掉，交给收敛函数从 relayUrl 生出来。
    if (!Object.prototype.hasOwnProperty.call(raw, 'relayUrls')) delete merged.relayUrls;
    return normalizeRelayAddresses(merged);
  } catch {
    const state = defaultState();
    saveState(state);
    return state;
  }
}
/**
 * 配对成功之后换掉配对码与票据。
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
  normalizeRelayAddresses(state);
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}
/**
 * 取这台实例的历史密钥（HK）：没有就惰性生成 32 随机字节、base64url 落盘。
 *
 * 必须首次就落盘：HK 一旦丢了（换一把新的），已经推到中转的密文全都解不开，而且用户
 * 无从知道。所以这里同步写盘；写盘失败也把本次的值返回（进程内还能用），下一次再补。
 */
function ensureHistoryKey(state) {
  if (!state || typeof state !== 'object') return '';
  const existing = typeof state.historyKey === 'string' ? state.historyKey.trim() : '';
  if (existing) return existing;
  const key = genHistoryKey();
  state.historyKey = key;
  try { saveState(state); } catch { /* 落盘失败不阻断本次使用，下次调用会再试 */ }
  return key;
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
 * 一组中转地址的清洗：丢空串、去重、丢弃不以 http(s) 开头的，其余按原顺序留着。
 *
 * 这三条就是契约里的「读到的列表不满足就地丢弃、不报错」（docs/relay-multi-address.md）。
 * 每一条都过 `normalizeRelayUrl` 的规范形态，否则列表首项与 `relayUrl` 会差一个尾斜杠，
 * 那条「`relayUrls[0]` 恒等于 `relayUrl`」的不变式就不成立了。
 */
function normalizeRelayUrlList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const url = normalizeRelayUrl(entry);
    if (!/^https?:\/\/[^\s/]+/i.test(url)) continue;
    if (out.includes(url)) continue;
    out.push(url);
  }
  return out;
}
/**
 * 把 state 上的两格收敛成契约那个形状（就地改，返回同一个对象）：
 * `relayUrls` 是完整列表、`relayUrl` 是它的首项；列表空或缺失就由 `relayUrl` 生出单元素列表。
 *
 * 这是「老 relay.json 里只有 relayUrl」「手改过文件」「写单值 == 写单元素列表」三件事共同的
 * 落点，读盘与落盘各过一次，就不会有一处写歪而另一处照旧。
 */
function normalizeRelayAddresses(state) {
  if (!state || typeof state !== 'object') return state;
  // **列表在场就由列表说了算**（含空数组）：`relayUrls: []` 是一次明确的「没有中转了」，
  // 拿 `relayUrl` 的旧值兜底会让它清不掉 —— 那正是契约第 2 条要的效果。判据是**有没有
  // 这一格**，不是「清完之后还剩几条」：清洗把整份列表丢空（全是垃圾 / 全是空串）时，
  // 那个空结果本身就是最终答案，拿 `relayUrl` 兜回去等于让一条非法地址借尸还魂。
  // 只有老文件里这一格压根不存在（`undefined`）时，才由 `relayUrl` 生出单元素列表。
  const declared = Array.isArray(state.relayUrls)
    ? normalizeRelayUrlList(state.relayUrls)
    : (state.relayUrls === undefined ? null : []);
  const urls = declared ?? (normalizeRelayUrl(state.relayUrl) ? [normalizeRelayUrl(state.relayUrl)] : []);
  state.relayUrl = urls.length ? urls[0] : '';
  state.relayUrls = urls;
  return state;
}
/**
 * 只读版：给「要报给外面」的地方取一份两格一致的值，**不改调用方手里那份 state**。
 *
 * 与 `normalizeRelayAddresses` 的差别只在「判据更松」：读盘那一步才做完整清洗（去重、
 * 非 http(s) 丢弃），出口这里只丢空串与规范形态 —— 那些脏值本来就进不了内存，
 * 出口再判一道只会让一个已经在用的值在状态里凭空消失。
 */
function relayAddressesOf(state) {
  const relayUrl = normalizeRelayUrl(state && state.relayUrl);
  // 与 `normalizeRelayAddresses` 同一条判据：列表在场（含空数组）就由它说了算，只有这一格
  // 压根不存在时才退回 `relayUrl`。两处判据不一致，就会出现「写进去的」与「读出来的」不是一个。
  const declared = Array.isArray(state && state.relayUrls)
    ? (state.relayUrls.filter(entry => typeof entry === 'string' && entry.trim()).map(normalizeRelayUrl))
    : null;
  const urls = declared ?? (relayUrl ? [relayUrl] : []);
  return { relayUrl: urls.length ? urls[0] : '', relayUrls: urls };
}
/**
 * 把一次配置写入里涉及中转地址的两格收敛好（就地改 `next`，返回它）。
 *
 * 两条规矩：两个一起带时**以 `relayUrls` 为准**（契约 §接口面）；只带一个时另一格跟着写
 * —— 写 `relayUrl` 等价于写 `[它]`，写列表则 `relayUrl` 变成首项。
 *
 * 放在这里而不是装配层，是因为**漏一处就是静默的**：只写 `relayUrl`、列表原样不动，落盘
 * 时的收敛又会拿旧列表把新地址盖回去，表现是「地址改了但没生效」，一个错都不报。
 */
function applyRelayAddressPatch(next, incoming) {
  if (!next || typeof next !== 'object' || !incoming || typeof incoming !== 'object') return next;
  const hasList = 'relayUrls' in incoming;
  if (!hasList && !('relayUrl' in incoming)) return next;
  if (hasList) {
    // 以请求里那份列表为准（不是 `next` 上那份：调用方可能已经把原样值拷进去了）。
    const urls = normalizeRelayUrlList(incoming.relayUrls);
    next.relayUrls = urls;
    next.relayUrl = urls.length ? urls[0] : '';
    return next;
  }
  const url = normalizeRelayUrl(incoming.relayUrl);
  next.relayUrl = url;
  next.relayUrls = url ? [url] : [];
  return next;
}
/**
 * 中转地址 → 隧道 WebSocket 地址。
 *
 * 缺协议的输入（`example.com:8700`、`//relay.example`）会被拼成一个 `new WebSocket()`
 * 直接拒绝的字符串，错误要等到隧道连接阶段才以 `tunnel.state='error'` 的形式浮现。
 * 这里提前抛错，让 `/api/relay/config` 能在保存时就给出明确反馈。
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

/**
 * 公用中转的入口 host。**必须与面板 `React/src/lib/links.ts` 的 `PUBLIC_RELAYS`、
 * App `services/viewmodels/public-relay.ts` 的 `PUBLIC_RELAY_URLS` 保持一致** —— 三处各有一份，
 * 加一台公用中转要三处一起补，少补一处那台上的设备就会被漏判。按 host 比：协议、默认端口、
 * 尾斜杠的差异都不影响它是不是公用。
 */
const PUBLIC_RELAY_HOSTS = new Set(['ai-hub-de-1.wnluo.com', 'dsh.iouf.cn', 'dsh.yfyidc.cn']);
function isPublicRelayUrl(url) {
  try {
    return PUBLIC_RELAY_HOSTS.has(new URL(String(url).trim()).host.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * 判定「用户是否已经配了公网可达的自建服务」——是的话，公用中转要自动、强制停用。
 *
 * 公网可达的三类才算：① 自建中转（`relayUrls` 里有非公用地址）；② 手填直连
 * `manualLanUrl`（内网穿透域名 / 公网 IP）；③ TCP 直连 `manualTcpUrl`。**排除**局域网
 * `preferredLanAddress` 与 IPv6 `manualIpv6Url` —— 它们在外面访问不进来，不足以让人放弃
 * 公用中转（见用户 2026-11-18 口径）。
 *
 * 判据只写这一处：写入时据它把公用地址剔除（真停用），status 也据它回 `publicRelayBlocked`
 * 给面板划删除线、禁用「启用」。两边必须问同一个函数，否则界面说停用了、实际还在走公用。
 */
function publicRelayBlocked(state) {
  if (!state || typeof state !== 'object') return false;
  const relay = relayAddressesOf(state);
  if (relay.relayUrls.some((url) => !isPublicRelayUrl(url))) return true;
  return Boolean(String(state.manualLanUrl || '').trim() || String(state.manualTcpUrl || '').trim());
}

/**
 * 把公用中转地址从传入的配置里剔除（就地改 `next`）：有公网自建时，公用必须退场。
 *
 * 只删中转列表里命中的公用项，别的一个字节不动；删空了就让 `relayUrl` 也空（契约：
 * `relayUrls[0] === relayUrl`）。调用方要在 `applyRelayAddressPatch` + schema 校验之后、
 * 落盘之前调，保证存下去的那份与报给手机的那份都不含公用地址。
 */
function stripPublicRelay(next) {
  if (!publicRelayBlocked(next)) return false;
  const relay = relayAddressesOf(next);
  const kept = relay.relayUrls.filter((url) => !isPublicRelayUrl(url));
  if (kept.length === relay.relayUrls.length) return false;
  next.relayUrls = kept;
  next.relayUrl = kept.length ? kept[0] : '';
  return true;
}

module.exports = {
  STATE_FILE, MOBILE_TOKEN_TTL_SEC, MOBILE_BEARER_TTL_SEC, defaultState, loadState, saveState, rotatePairing, genInstanceId, genPairingCode, genPairingTicket, genHistoryKey, ensureHistoryKey,
  tunnelWsUrl, normalizeRelayUrl, normalizeRelayUrlList, normalizeRelayAddresses, relayAddressesOf, applyRelayAddressPatch, signLanToken, verifyLanToken,
  isPublicRelayUrl, publicRelayBlocked, stripPublicRelay,
};

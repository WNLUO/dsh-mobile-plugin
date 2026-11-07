'use strict';

/**
 * 点对点隧道的**会合**：手机把自己的打洞候选报上来，电脑按它把自己那半边拉起来，
 * 再把电脑自己的候选还回去。
 *
 * 为什么需要这一步：打洞的本质是「两端同时往对方的出口地址发包」。手机上知道自己的
 * 出口（它自己问 STUN），电脑也知道自己的；但**彼此不知道对方的**。没有这一次交换，
 * 两边都只能往空气里打 —— 这正是这条通道早先一次也连不上的原因。
 *
 * 为什么走这条路而不是另架一个会合服务：这一发就打在我们**已经有**的那条链路上（局域网 /
 * 中转 / tailcat 隧道），只传几十个字节的地址。它不承载业务数据，也不新增任何部署物 ——
 * 与「用户没有服务器、我们也不提供」是同一条原则。真正的数据面完全在两端之间。
 *
 * 端点本身是幂等的：手机每次心跳都可以带上当前候选再来一次，电脑发现「我已经按这份候选
 * 起来过了」就直接复用，不重新打洞（重打会让已经打通的洞白丢一次）。
 */

const { sendJson } = require('../http/routing.js');
const { readJsonBody } = require('../shared/http-util.js');

/** 候选白名单：只收 `ip:port` 形状，长度也限住 —— 对端给的任何东西都当不可信数据。 */
const CANDIDATE = /^[0-9a-fA-F.:[\]]{3,64}$/;

/** 手机的公钥：只认 base64（44 字符）或 hex（64 字符）两种，长度不等就不是密钥。 */
const PUBLIC_KEY = /^[A-Za-z0-9+/=]{43,44}$|^[0-9a-fA-F]{64}$/;

function normalizePublicKey(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return PUBLIC_KEY.test(text) ? text : '';
}

function normalizeCandidates(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text || text.length > 64 || !CANDIDATE.test(text)) continue;
    if (!out.includes(text)) out.push(text);
    // 上限 16 条：正常也就两三条，多出来的只可能是拼错的输入。
    if (out.length >= 16) break;
  }
  return out;
}

/**
 * @param {object} deps
 * @param {object} deps.p2p 装配层交下来的 P2P 门面（`lib/p2p/wiring.cjs`）
 * @param {() => number} [deps.lanPortInUse] 本机插件端口（隧道里那些连接最终转给它）
 */
function createP2PRendezvousHandler(deps) {
  return async function handleRendezvous(_ctx, req, res) {
    if (!deps.p2p || typeof deps.p2p.open !== 'function') {
      // 这台电脑没装助手 / 没起这条通道：如实说，手机那边据此把这一条标成不可用，
      // 而不是一直等一个永远不会来的回答。
      sendJson(res, 200, { ok: true, available: false, reason: 'p2p-unavailable' });
      return;
    }

    const body = await readJsonBody(req, 16 * 1024);
    const candidates = normalizeCandidates(body && body.candidates);
    const localCandidates = normalizeCandidates(body && body.localCandidates);
    // 手机自己的公钥：电脑拉起隧道时要拿它对 WireGuard 握手。没有它，电脑配不出对端，
    // 这条通道根本起不来（不是「打洞打不通」，是连设备都配不上）。
    const phonePublicKey = normalizePublicKey(body && body.phonePublicKey);
    // 手机候选为空也允许：电脑照样能「只听不打」地起来、把自己的候选报回去，等手机来打。
    // 硬要它先有候选，等于把「谁先拨」的顺序焊死，第一发永远没有候选。

    const opened = await deps.p2p.open({
      // **不转 `body.peerKey`**：手机那一格装的是**我这台电脑的公钥**（它拿它确认「对面是那台
      // 电脑」），不是它自己的。会话要的对端是手机那把，只有 `phonePublicKey` 一处。
      // 早先把这一格直接当对端传下去，电脑于是拿自己的公钥配 WireGuard —— 洞能开、`path`
      // 报 `direct`，但握手永远对不上，数据面一个包都过不去。
      phonePublicKey,
      candidates,
      localCandidates,
      targetPort: typeof deps.lanPortInUse === 'function' ? deps.lanPortInUse() : 0,
    });
    if (!opened || opened.ok === false) {
      sendJson(res, 200, {
        ok: true,
        available: false,
        reason: (opened && opened.code) || 'start-failed',
      });
      return;
    }

    // 回我自己的候选：手机拿到这份，才知道往哪打。
    sendJson(res, 200, {
      ok: true,
      available: true,
      // 隧道里那个固定端口（手机拨它）。
      port: deps.p2p.constants ? deps.p2p.constants.P2P_PORT : undefined,
      // **我这一把公钥**：手机要拿它确认「对面是那台电脑」并配 WireGuard 对端。二维码里
      // 有这一份，但已经配过对、或换过电脑的老会话也得能自己拿到 —— 否则手机只能重新扫码。
      publicKey: typeof opened.publicKey === 'string' ? opened.publicKey : '',
      // 电脑的出口地址（STUN 那份 + 本机私网那份）。**这一份才是打洞的起点**。
      candidates: normalizeCandidates(opened.candidates),
      localCandidates: [],
    });
  };
}

module.exports = { createP2PRendezvousHandler, normalizeCandidates };

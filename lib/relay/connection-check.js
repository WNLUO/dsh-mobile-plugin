// 2026-11-25：自检加回环 health 探针，代理抢占 127.0.0.1 时不再误报 ok。
'use strict';

/**
 * 连接自检：把「手机连不上」拆成电脑这侧能查的几件事，最后落一个结论。
 *
 * 回答的是两个不同的问题，能查到的程度差很远：
 *
 * 1. **我这一侧整不整**——端口在不在听、隧道有没有注册上、防火墙放不放行。这三样
 *    本机查得到，都是确定答案。
 * 2. **手机到底拨得进来吗**——本机证明不了。朝自己的局域网地址发请求，包根本不走
 *    物理网卡，测出来永远是通的（`test-network-addresses` 那边记过这个假阳性）。
 *    所以这里只能退一步用**证据**：最近一次手机真的从外面来敲过门是什么时候
 *    （`mobileActivity` 的记账，只记带有效 token 的请求）。
 *
 * 于是结论分五档，`verdict` 就是这五档之一：
 *
 * - `not-listening`：直连端口没在听，手机拨不进来。下一步是去主页重连 / 换端口。
 * - `firewall-blocked`：防火墙明确挡着这个程序。这是唯一能**点名**系统原因的一档。
 * - `unknown`：防火墙状态读不到（Linux、或被系统策略限制）。如实说读不到，
 *   不许把「不知道」写成「正常」。
 * - `network`：电脑这侧没毛病，但手机三十分钟没来过 —— 多半没连同一个 WiFi、
 *   路由器隔离了设备，或者该走中转。
 * - `ok`：最近连上过。
 *
 * **判据顺序是有讲究的**：手机来过就说明这条链整体通着（哪怕它走的是中转、
 * 局域网仍被挡着），所以「来过」排在防火墙前面 —— 不然会在人家正用着的时候报
 * 一个吓人的红字。反过来，没来过才轮到防火墙说话。
 */

const net = require('node:net');
const { readFirewall } = require('./firewall-probe.js');

/** 「最近来过」的窗口。比侧栏那 30 秒心跳宽得多：它要回答的是「人还在不在用」。 */
const MOBILE_RECENT_MS = 30 * 60 * 1000;

/** 回环 health 只认本插件自己那份响应；中转回的是 `dsh-mobile-relay`。 */
const LOOPBACK_SERVICE = 'dsh-mobile-plugin';

/**
 * 试一下本机某个回环端口连不连得上。
 *
 * 直连隧道（tailcat）的数据是「隧道 → 回环入口 → 下游端口」一路转的：助手进程报 ready
 * 只说明它起来了、拿到了地址，**不代表这条链的下游还活着**。所以自检要真去拨一下那个下游
 * 端口——拨得通才算这条通道真能用。这不是「朝自己的局域网地址发请求」（那是假阳性，见
 * 文件头），而是对一个明确在 127.0.0.1 上的内部端口做 TCP 连接，只回答「有没有人在听」。
 */
function defaultProbePort(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0) return resolve(false);
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * 纯判据。守卫直接喂五组输入断言这五档，不碰进程、不碰时钟。
 *
 * @param {{listeningState?: string, firewall?: object|null, lastMobileAt?: number, now?: number}} input
 * @returns {'not-listening'|'firewall-blocked'|'unknown'|'network'|'ok'}
 */
function verdictOf(input = {}) {
  const now = typeof input.now === 'number' ? input.now : Date.now();
  const lastMobileAt = typeof input.lastMobileAt === 'number' ? input.lastMobileAt : 0;
  const firewall = input.firewall || null;
  const listening = input.listeningState === 'listening';
  const mobileRecent = lastMobileAt > 0 && now - lastMobileAt < MOBILE_RECENT_MS;

  if (!listening) return 'not-listening';
  if (mobileRecent) return 'ok';
  if (firewall && firewall.allowsApp === false) return 'firewall-blocked';
  if (!firewall || firewall.supported !== true || firewall.allowsApp === null) return 'unknown';
  return 'network';
}

/**
 * 回环 health 响应的判据。本机代理客户端抢占 127.0.0.1:<port> 时裸 TCP 照样连得上，
 * 但回的是 403 页面或别的服务——只拨 TCP 看不出来。只有 ok:true 且 service 是本插件，
 * 才能证明「这条通道绕回来接的确是插件」；其余一律报被抢，不是「正常」。
 */
function loopbackVerdictOf(body) {
  if (body && typeof body === 'object' && body.ok === true && body.service === LOOPBACK_SERVICE) {
    return { state: 'ok', reason: '' };
  }
  const service = body && typeof body === 'object' && typeof body.service === 'string' ? body.service.trim() : '';
  if (service && service !== LOOPBACK_SERVICE) {
    return { state: 'blocked', reason: `回环 health 回的是别的程序（${service}），127.0.0.1 端口被抢占` };
  }
  if (service === LOOPBACK_SERVICE) {
    return { state: 'blocked', reason: '回环 health 没报 ok' };
  }
  return { state: 'blocked', reason: '回环 health 没回本插件的 JSON，127.0.0.1 端口可能被抢占' };
}

/**
 * 装配一份自检载荷。
 *
 * 取值全部注入：`status` 是那份状态视图、`lanCandidates` 给监听地址清单、
 * `mobileActivity` 给「手机最近来过没有」、`probeFirewall` 换掉真探测（守卫用）。
 */
function createConnectionCheck(deps = {}) {
  const status = typeof deps.status === 'function' ? deps.status : () => ({});
  const lanCandidates = typeof deps.lanCandidates === 'function' ? deps.lanCandidates : () => [];
  const mobileActivity = typeof deps.mobileActivity === 'function' ? deps.mobileActivity : () => ({ lastMobileAt: 0 });
  const probe = typeof deps.probeFirewall === 'function' ? deps.probeFirewall : readFirewall;
  const probePort = typeof deps.probePort === 'function' ? deps.probePort : defaultProbePort;
  // 回环 health 的传输由接线层注入（复用 control-plane 的裸 TCP 探针 + chunked 解析）。
  // 没有注入就不探：纯 IPv6 / 老宿主不会在 127.0.0.1 上答 health，不该凭空报「被抢」。
  const probeLoopback = typeof deps.probeLoopback === 'function' ? deps.probeLoopback : null;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const platform = typeof deps.platform === 'string' ? deps.platform : process.platform;

  return {
    /** @param {{force?: boolean}} [options] */
    async run(options = {}) {
      const snapshot = status() || {};
      const lan = snapshot.lan && typeof snapshot.lan === 'object' ? snapshot.lan : {};
      const tunnel = snapshot.tunnel && typeof snapshot.tunnel === 'object' ? snapshot.tunnel : {};
      const port = Number.isInteger(lan.port) && lan.port > 0 ? lan.port : 0;
      const urls = port > 0
        ? (lanCandidates(port) || []).map((item) => (item && typeof item.url === 'string' ? item.url : '')).filter(Boolean)
        : [];
      // 防火墙查不到就让它是「查不到」：探测自己负责把 reason 说清楚，这里不兜底成 null 之外的值。
      let firewall;
      try {
        // 把当前监听端口带过去：Windows 那边规则若收窄到别的端口，不能算放行。
        firewall = await probe({ force: options.force === true, platform, port });
      } catch {
        firewall = null;
      }
      const mobile = mobileActivity() || {};
      const lastMobileAt = Number.isFinite(mobile.lastMobileAt) ? mobile.lastMobileAt : 0;
      const at = now();
      const listeningState = typeof lan.state === 'string' ? lan.state : 'off';
      // 端口在听不代表 127.0.0.1 上答 health 的就是本插件（Windows 上通配绑定与具体地址
      // 能共存，代理客户端抢先绑回环时流量落到它那里，TCP 照通但回 403）。port=0 / LAN
      // 没在听就跳过；探测抛错降级为 unknown，绝不让自检接口 500。
      let loopback = null;
      if (port > 0 && listeningState === 'listening' && probeLoopback) {
        try {
          loopback = loopbackVerdictOf(await probeLoopback(port));
        } catch {
          loopback = { state: 'unknown', reason: '回环 health 探测失败，无法判断端口是否被抢占' };
        }
      }
      // 直连隧道的下游端口真拨一下：`ready` 只说明助手起来了、拿到地址，不代表这条链还通
      // （见 defaultProbePort）。关了/没起来就 reachable 留 null（没得测，不是「不通」）。
      const tc = snapshot.tailcat && typeof snapshot.tailcat === 'object' ? snapshot.tailcat : null;
      let tailcat = null;
      if (tc) {
        const available = tc.available !== false;
        const enabled = tc.enabled !== false;
        const ready = tc.ready === true;
        const targetPort = Number.isInteger(tc.targetPort) && tc.targetPort > 0 ? tc.targetPort : 0;
        let reachable = null;
        if (available && enabled && ready && targetPort > 0) {
          try {
            reachable = await probePort(targetPort);
          } catch {
            reachable = null;
          }
        }
        tailcat = {
          available,
          enabled,
          ready,
          paired: Number.isInteger(tc.paired) ? tc.paired : 0,
          targetPort,
          reachable,
        };
      }
      return {
        ok: true,
        checkedAt: at,
        platform,
        verdict: verdictOf({ listeningState, firewall, lastMobileAt, now: at }),
        listening: {
          state: listeningState,
          port,
          urls,
          portAdjusted: lan.adjusted === true,
          loopback,
        },
        tunnel: {
          state: typeof tunnel.state === 'string' ? tunnel.state : 'off',
          relayUrl: typeof snapshot.relayUrl === 'string' && snapshot.relayUrl ? snapshot.relayUrl : null,
        },
        tailcat,
        firewall,
        mobile: {
          lastMobileAt,
          idle: !(lastMobileAt > 0 && at - lastMobileAt < MOBILE_RECENT_MS),
        },
      };
    },
  };
}

module.exports = { MOBILE_RECENT_MS, verdictOf, loopbackVerdictOf, createConnectionCheck };

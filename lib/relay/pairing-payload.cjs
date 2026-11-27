// 2026-11-27：进二维码的服务商线路名字截到 40 字——名字只是显示用，长名字能把码撑到扫不出来。
// 2026-11-24：服务商的 http(s) 地址同时进 lanUrls，让不认 routes 的老包也能扫码走服务商直连；
//   二维码只带电脑自己配的线路，新机没自己的线路时蜂窝首次配对失败属于预期。
// 2026-11-24：出码前的「有没有可用地址」收成 `pairingHasAddress`，服务商线路也算数——两个出码入口同用一处判据。
// 2026-11-23：第三方服务商线路随二维码一起下发（通用 `routes` 一栏）：以后加服务商不用再改二维码。
// 配对二维码的 IPv6 候选为手填那条预留一席，避免被条数上限切掉。
// 2026-11-21：TCP 目标同时写进 lanUrls，让现网 App 在扫码配对时也能拨它（过渡桥）。
// 生成配对邀请，并独立发布 IPv6 监听候选。
'use strict';

/**
 * 配对二维码的载荷与原文。
 *
 * 面板（`/api/relay/pairing`）与终端命令（`lib/cli/pair.cjs`）都从这里取，**只此一份**：
 * 两处各拼一遍的话，迟早出现「面板里的码能配上、终端里打出来的配不上」这种最难查的分叉。
 *
 * 只做「把 state 折成一张卡里要说的东西」，不认识 HTTP、不认识渲染：二维码图片怎么画由
 * 调用方决定（面板要 SVG、终端要字符画）。
 */

const os = require('node:os');
// 中转地址两格的收敛：二维码里 `relayUrls[0]` 必须与 `relayUrl` 是同一个字符串。
const { relayAddressesOf } = require('./core.js');
const { providerLinesOf } = require('./provider-lines.cjs');
const {
  advertisedCandidates,
  phoneCandidates,
  manualCandidate,
  ipv6Candidates,
  withManualIpv4Candidate,
  withManualIpv6Candidate,
  tcpDirectTarget,
} = require('./lan-network.cjs');

/**
 * 二维码里最多带几条 IPv6 候选。
 *
 * 每条 `http://[240e:...]:18787` 是五十多个字符，逼着整张码升一到两个版本。两块就够
 * 手机实测择优（稳的那条通常排在前），多出来的交给 `/connection-info` 定期刷新。
 */
const QR_IPV6_MAX = 2;

/**
 * 二维码里最多带几条服务商线路。
 *
 * 每条是 `https://域名` 或 `主机:端口` 加名字，条数一多整张码就密到扫不出来；而配对只需要
 * 有一条能拨通。超出的部分照旧靠配对后的心跳与总控下发，手机上照样能用，只是不参与「扫码
 * 这一下」。真到那一步（一家机器挂了几十个服务商），也还在心跳那份清单里。
 */
const QR_ROUTES_MAX = 8;

/**
 * 二维码要带的服务商线路：与心跳 / 总控同源（`providerLinesOf`），再补上 Cloudflare 兜底
 * 那条（它在别处单独一格，不在 providerLines 里）。已经作为手填直连 / TCP 桥进 `lanUrls`
 * 的同址线路不再重复写，省二维码的字节。
 *
 * @param {object} state
 * @param {Set<string>} taken 已经在 lanUrls 里出现过的地址（去重用）
 */
function pairingRoutes(state, taken) {
  const out = [];
  const seen = new Set(taken || []);
  const push = (row) => {
    const url = row && typeof row.url === 'string' ? row.url.trim().replace(/\/+$/, '') : '';
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({
      url,
      transport: row.transport === 'tcp' ? 'tcp' : 'http',
      // 名字只是面板/手机上给人看的标签，不参与拨号；按二维码的字节预算截到 40，
      // 八条线路各带 80 字长名字足以把整张码撑爆。完整名字仍在心跳与总控那份清单里。
      name: typeof row.name === 'string' ? row.name.trim().slice(0, 40) : '',
    });
  };
  for (const row of providerLinesOf(state)) push(row);
  // Cloudflare 兜底隧道：一个 https 地址，独立一格。带进码里，只有 Cloudflare 也能在外配对。
  const cf = typeof state.cloudflareUrl === 'string' ? state.cloudflareUrl.trim().replace(/\/+$/, '') : '';
  if (cf) push({ url: cf, name: 'Cloudflare', transport: 'http' });
  return out.slice(0, QR_ROUTES_MAX);
}

/**
 * @param {object} state relay.json 那份状态（至少要有 name/instanceId/pairingCode/pairingTicket/relayUrl/lanEnabled）
 * @param {number} [lanPort] 实绑的局域网端口（首选端口被占时会与配置里那个不同）
 * @returns {{payload: object, text: string}} `text` 就是二维码里那串 `dshpair://`
 */
function pairingPayload(state, lanPort) {
  const port = Number.isInteger(lanPort) ? lanPort : state.lanPort;
  // 面板上选过的「手机优先用这条」在这里兑现：只挪到最前，其余继续当兜底（App 按顺序挨个试）。
  const candidates = state.lanEnabled
    ? withManualIpv4Candidate(phoneCandidates(advertisedCandidates(port), { preferred: state.preferredLanAddress, manual: state.manualLanUrl }), state.manualIpv4Url)
    : [];
  const urls = candidates.map(candidate => candidate.url).filter(Boolean);
  const tcpTarget = tcpDirectTarget(state.manualTcpUrl);
  // 过渡桥：现网 App 的扫码配对只把中转与 lanUrls 当候选，TCP 那格只是配对后的直连配置。
  // 把同一条 TCP 目标按 http://host:port 塞进 lanUrls，它就会走裸 TCP 回环转发去打配对口；
  // 等 App 把 TCP 正式接进选路后，这里撤掉。重复的手动直连地址不写第二遍。
  const tcpLanUrl = tcpTarget ? `http://${tcpTarget}` : '';
  if (tcpLanUrl && !urls.includes(tcpLanUrl)) urls.push(tcpLanUrl);
  // 老手机只读 `relayUrl`（语义一个字没变），新手机优先读数组、没有就退化到单条。
  // `relayUrls[0]` 恒等于 `relayUrl` 这条不变式，在发进码的这一份里由下面的 codeRelays 保证。
  const relay = relayAddressesOf(state);
  // 服务商线路：与心跳 / 总控同源，另补 Cloudflare；同址已进 lanUrls 的不重复写。
  const routes = pairingRoutes(state, new Set(urls));
  // 老包不认 routes 那一栏，只认 lanUrls。把 http(s) 服务商线路按「直连」形状也写一份进
  // lanUrls，老包扫码就能直接拨服务商。tcp 类的不塞——它在 lanUrls 里会被当 http 拨不通
  // （要靠原生裸 TCP），仍只走 routes 那条。
  for (const row of routes) {
    if (row.transport === 'http' && !urls.includes(row.url)) urls.push(row.url);
  }
  // 二维码只带电脑自己配的中转线路；新机一条都没配时码里就没有中转，蜂窝首次配对失败属于预期。
  const codeRelays = [...relay.relayUrls];
  const codeRelayUrl = codeRelays[0] || '';
  // **只有一条时不写数组**：那个数组恒等于单值，写进去是同一串地址在码里出现两遍，
  // 白占七八个模块。
  const relayList = codeRelays.length > 1 ? codeRelays : undefined;
  const payload = {
    type: 'dsh-pair',
    version: 1,
    name: state.name || os.hostname(),
    instanceId: state.instanceId,
    code: state.pairingCode,
    // 协议版本与一次性票据（§8.3(1)）。
    //
    // `proto: 2` 由**宿主**写、也由宿主生成，中转没有任何机会改写它 —— 所以「新 App 被
    // 中转骗回明文」这个问题从一开始就不存在。`ticket` 是 32 字节随机数，手机拿它派生
    // 配对密钥；二维码是屏幕对摄像头，这条通道完全绕开中转。
    //
    // 老 App 只取自己认识的那几个字段，多出来的两个会被忽略 —— 一张二维码同时服务新旧两种。
    proto: 2,
    ticket: state.pairingTicket || '',
    relayUrl: codeRelayUrl,
    lanUrls: urls,
    // 用户手填的直连地址（穿透域名 / 公网 IP）单独一格：手机据此把它落到「直连」栏，
    // 不从 `lanUrls` 里猜。`lanUrls` 里仍带着它只为老手机兼容，新手机读到这一格会剔掉。
    ...(() => {
      const direct = state.lanEnabled ? manualCandidate(state.manualLanUrl) : null;
      return direct ? { directUrl: direct.url } : {};
    })(),
    // 「TCP 直连」那一条：设置项 `manualTcpUrl` 里能当裸 TCP 目标的，只此一条、不掺网卡候选
    // （与直连地址是两条，别混）。App 用它当 `tcpTarget`（经本机回环 + 原生裸 TCP 出站，ATS 不参与）。
    // 没有可用的就整格不写 —— 二维码的字节数很贵，重配对时目标由 `/connection-info` 补。
    ...(() => {
      return tcpTarget ? { tcpUrl: tcpTarget } : {};
    })(),
    // **不再带 `lanCandidates`**：它与上面 `lanUrls` 是同一个数组，App 侧从来没读过它
    // （`parsePairingInvite` 只取 `lanUrls`）。一份地址在二维码里出现两遍，白占几十个字符、
    // 把码点压密一档 —— 而这正是「码看着清楚却扫不出来」的成本。
    //
    // 同理 `relayUrls` 也**只在真的有第二条时才写**（`relayList`）：单中转是常态，
    // 那份单元素数组与上面的 `relayUrl` 逐字相同，写进去只是把码压密一档。
    // IPv6 直连候选（理想情况下是手机**不在同一个 Wi-Fi 里**时唯一能拨到的地址）：不参与上面
    // 那份的排序，顺序由 App 侧拿它和公网中转实测比出来；直连监听没开就没有这条通道。
    // 用户手填的那条缀在最后当兜底（只追加、不删网卡候选），见 `withManualIpv6Candidate`。
    //
    // **二维码里只带前两条**：一块网卡能报出「一条稳定地址 + 两条隐私地址」（RFC 4941 的
    // 临时地址按小时轮换，写进码里的那两条多半扫完就过期了），三条一起塞要吃掉近三十个模块。
    // 前两条够手机实测择优；`/connection-info` 那份照旧给全，换前缀之后靠它刷新。
    ipv6Candidates: port > 0
      ? (() => {
        const nic = ipv6Candidates(port)
        const merged = withManualIpv6Candidate(nic, state.manualIpv6Url)
        // 手填那条是「手机不在同一个 Wi-Fi 时唯一拨得到」的兜底，不能被二维码的条数上限切掉：
        // 网卡候选截到 QR_IPV6_MAX-1 条，再补上手填那条；没有手填就照常截 QR_IPV6_MAX 条。
        const manual = merged.length > nic.length ? merged[merged.length - 1] : null
        const picked = manual
          ? [...merged.filter(candidate => candidate !== manual).slice(0, QR_IPV6_MAX - 1), manual]
          : merged.slice(0, QR_IPV6_MAX)
        return picked.map(candidate => candidate.url).filter(Boolean)
      })()
      : [],
    // 服务商线路清单（ZeroNews / 节点小宝 / FRP / Cloudflare / 用户自定义）：手机据此既能在
    // 扫码时把它们当配对候选，配对后直接落成会话线路。老 App 不认识这栏就忽略，行为不变；
    // 以后加服务商只往 `providerLinesOf` 里加，二维码不用再改。
    ...(routes.length ? { routes } : {}),
  };
  if (relayList) payload.relayUrls = relayList;
  return { payload, text: pairingText(payload) };
}

/**
 * 载荷 → 二维码里那一串 `dshpair://`。
 *
 * 单独导出是因为**直连隧道那段信息要在拼 text 之前塞进 payload**：隧道窗口是异步起的
 * （要拉一个节点），拼装函数本身是纯的，不能为了它变成异步。调用方拿到 payload、补上
 * `tailcat`，再调这里生成 text —— 仍然只有这一处拼格式。
 */
function pairingText(payload) {
  return `dshpair://v1?data=${encodeURIComponent(JSON.stringify(payload))}`;
}

/**
 * 这张二维码里有没有一条手机能拿去配对的路。
 *
 * 配对这一刻能拨的：中转、局域网 / 直连 / TCP 桥（都在 `lanUrls`）、服务商线路（`routes`）、
 * 隧道与点对点。IPv6 候选只做配对后的数据通道（宿主拒公网 IPv6 来源的配对），不算。
 *
 * 面板与命令行两个出码入口都调这一个判据。以前各写一遍、都把 `routes` 漏了，结果一台
 * 「只接了一家服务商」的机器（比如只挂 ZeroNews / 节点小宝 / FRP 自建 TCP）二维码出不来，
 * 而 App 侧明明把服务商线路当合法配对入口。
 */
function pairingHasAddress(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  return Boolean(
    (typeof p.relayUrl === 'string' && p.relayUrl)
    || (Array.isArray(p.lanUrls) && p.lanUrls.length > 0)
    || (Array.isArray(p.routes) && p.routes.length > 0)
    || p.tailcat
    || p.p2p,
  );
}

module.exports = { pairingPayload, pairingText, pairingHasAddress };

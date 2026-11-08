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
const {
  advertisedCandidates,
  phoneCandidates,
  ipv6Candidates,
  withManualIpv6Candidate,
} = require('./lan-network.cjs');

/**
 * @param {object} state relay.json 那份状态（至少要有 name/instanceId/pairingCode/pairingTicket/relayUrl/lanEnabled）
 * @param {number} [lanPort] 实绑的局域网端口（首选端口被占时会与配置里那个不同）
 * @returns {{payload: object, text: string}} `text` 就是二维码里那串 `dshpair://`
 */
function pairingPayload(state, lanPort) {
  const port = Number.isInteger(lanPort) ? lanPort : state.lanPort;
  // 面板上选过的「手机优先用这条」在这里兑现：只挪到最前，其余继续当兜底（App 按顺序挨个试）。
  const candidates = state.lanEnabled
    ? phoneCandidates(advertisedCandidates(port), { preferred: state.preferredLanAddress, manual: state.manualLanUrl })
    : [];
  const urls = candidates.map(candidate => candidate.url).filter(Boolean);
  // 两格都要在：老手机只读 `relayUrl`（语义一个字没变），新手机优先读数组、没有就退化到
  // 单条。`relayUrls[0]` 恒等于 `relayUrl`，这条不变式由 core 的收敛函数保证。
  const relay = relayAddressesOf(state);
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
    relayUrl: relay.relayUrl,
    relayUrls: relay.relayUrls,
    lanUrls: urls,
    // 候选列表随二维码一起带走：App 配对后即使换了网段，也能按这份列表
    // 依次重试而不用先回到公网中转去问。
    lanCandidates: urls,
    // IPv6 直连候选（理想情况下是手机**不在同一个 Wi-Fi 里**时唯一能拨到的地址）：不参与上面
    // 那份的排序，顺序由 App 侧拿它和公网中转实测比出来；直连监听没开就没有这条通道。
    // 用户手填的那条缀在最后当兜底（只追加、不删网卡候选），见 `withManualIpv6Candidate`。
    ipv6Candidates: state.lanEnabled
      ? withManualIpv6Candidate(ipv6Candidates(port), state.manualIpv6Url).map(candidate => candidate.url).filter(Boolean)
      : [],
  };
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

module.exports = { pairingPayload, pairingText };

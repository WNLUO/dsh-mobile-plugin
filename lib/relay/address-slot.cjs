// 2026-11-25：地址分栏校验抽成共用件，面板与手机两条保存路径同一个判据、同一句中文。
'use strict';

/**
 * 什么地址能进哪一栏 —— 面板 `/api/relay/config` 与手机 `/api/mobile/v1/relay/config/save`
 * 共用的那道校验。返回一句中文错误，空串表示没问题。
 *
 *  - 优先的局域网地址必须在这台电脑当前检测到的局域网 / 公网候选里（空串 = 清掉，合法）。
 *    候选拿不到时（端口没监听 / 局域网关）不硬拦，交给排序层按「不在清单里」自然忽略。
 *  - 直连地址不能填成某条中转：两者是不同通道，串栏正是「局域网栏出现中转地址」的根源。
 *
 * 这里只拦「存了也不会生效」的值，不碰候选顺序（`orderCandidates` 的语义不变），也不把
 * CGNAT / VPN 地址收进候选 —— 那类地址手机拨不到，自动广播有拨错人的风险。
 */

const core = require('./core.js');
const { lanCandidates, publicCandidates } = require('./lan-network.cjs');

/** 文案只此一份，两条路径报同一句，不各写各的。 */
const PREFERRED_NOT_DETECTED = '优先的局域网地址不在这台电脑当前检测到的地址里';
const MANUAL_IS_RELAY = '直连地址不能填成中转地址：这两条是不同通道，请把中转填到中转那一栏';

function addressSlotProblem(patch, state, port) {
  if (patch.preferredLanAddress) {
    const candidates = [...lanCandidates(port), ...publicCandidates(port)]
      .map((item) => String((item && item.address) || '').trim()).filter(Boolean);
    if (candidates.length && !candidates.includes(patch.preferredLanAddress)) return PREFERRED_NOT_DETECTED;
  }
  if (patch.manualLanUrl) {
    const want = core.normalizeRelayUrl(patch.manualLanUrl);
    const relays = [state.relayUrl, ...(Array.isArray(state.relayUrls) ? state.relayUrls : [])]
      .map((url) => (typeof url === 'string' ? core.normalizeRelayUrl(url) : '')).filter(Boolean);
    if (want && relays.includes(want)) return MANUAL_IS_RELAY;
  }
  return '';
}

module.exports = { addressSlotProblem, PREFERRED_NOT_DETECTED, MANUAL_IS_RELAY };

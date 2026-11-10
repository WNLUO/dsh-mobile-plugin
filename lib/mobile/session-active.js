'use strict';

/**
 * 「这条会话还在跑」的最终判据：自己的主轮在跑，**或者**它派出去的子代理还有在跑的。
 *
 * 宿主只按自己的主轮报 `running`：主对话把正文输出完、`turn/end` 一落，它就报 false，
 * 哪怕派出去的子代理还要跑几十秒。手机侧栏据此把这一行标成「已完成待读」、后台还会弹一条
 * 「跑完了」—— 而那个对话明明还有活没干完。桌面端不看 `running` 翻面，看的是整棵会话树
 * 还有没有活动，所以两侧对同一时刻给出不同答案。
 *
 * 判据只用会话列表本身就有的两格：子会话的 `origin === 'subagent'` + `parentSessionId`，
 * 以及每条会话的 `running`。不去读投影基线（那要多开一条流、3 秒预算，而这里每 10 秒
 * 重建一次列表），也不逐条查子代理目录（一条会话几十个 child，等于每轮几十次往返）。
 *
 * 只往上顶一层是不够的：子代理还能再派子代理，所以整条祖先链都要跟着变「在跑」，
 * 否则「孙代理在跑、父会话显示已完成」又会出现同一个现象。链上有环时停手（宿主数据
 * 异常时宁可少标一条，也不能死循环把列表请求挂住）。
 */

/**
 * 会话列表 → 顶过的列表（只有需要改的那几行是新对象，其余原样返回）。
 *
 * @param {unknown} items 宿主 `session.list` 的 items（或插件归一化后的同形数组）
 * @returns {unknown} 同一个数组或一份浅拷贝；形状不对时原样返回
 */
function withActiveParents(items) {
  if (!Array.isArray(items) || items.length === 0) return items;

  const parentOf = new Map();
  const runningIds = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const sessionId = typeof item.sessionId === 'string' ? item.sessionId : '';
    if (!sessionId) continue;
    // 只有子代理会带 parentSessionId；普通会话即便带了也不该把别人顶起来。
    if (item.origin === 'subagent' && typeof item.parentSessionId === 'string' && item.parentSessionId) {
      parentOf.set(sessionId, item.parentSessionId);
    }
    if (item.running === true) runningIds.push(sessionId);
  }
  if (parentOf.size === 0 || runningIds.length === 0) return items;

  const busy = new Set();
  for (const sessionId of runningIds) {
    const seen = new Set([sessionId]);
    let current = sessionId;
    for (;;) {
      const parent = parentOf.get(current);
      if (!parent || seen.has(parent)) break;
      seen.add(parent);
      // 已经标过的祖先，其更上层上一轮也标过了。
      if (busy.has(parent)) break;
      busy.add(parent);
      current = parent;
    }
  }
  if (busy.size === 0) return items;

  return items.map((item) => {
    if (!item || typeof item !== 'object') return item;
    if (item.running === true || !busy.has(item.sessionId)) return item;
    return { ...item, running: true };
  });
}

module.exports = { withActiveParents };

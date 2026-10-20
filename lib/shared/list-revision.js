'use strict';

/**
 * 清单内容指纹（sessions / workspaces 共用）。
 *
 * 存在的理由：手机端有两件事需要「这份清单和上次是不是同一份」——
 *
 *  1. 数据新鲜度：列表响应带 `revision`，App 把它连同 `generatedAt` 一起存进快照，
 *     就能把「数据是谁在什么时候给的」显示给用户，而不是让用户自己猜；
 *  2. 镜像推送判重（见 lib/mirror/pusher.cjs）：后台 500ms tick 每轮都会完整构建
 *     sessions + workspaces，内容没变时推送一份字节完全相同的 payload 纯属浪费，
 *     比对 revision 就能安全跳过。
 *
 * 为什么用内容哈希而不是自增序号：插件随桌面 harness 频繁重启，内存里的序号每次
 * 都从 0 开始，重启后第一份快照会因为「序号变了」而被当成新内容重推一遍；内容哈希
 * 跨重启稳定（同样的清单 → 同样的 revision），这才是判重想要的性质。
 *
 * 为什么用 sha1 而不是更省的 32 位哈希：这个值会被用来**跳过推送**，一次碰撞就等于
 * 一份该推的新数据被静默丢掉。sha1 足够便宜（清单量级下每 tick 亚毫秒），不值得为
 * 几个字节冒这个风险。截断到 16 个十六进制字符只是为了让日志短一点。
 */

const crypto = require('node:crypto');

/**
 * 语义内容的稳定指纹。
 *
 * `JSON.stringify` 保留键的插入顺序，而同一份清单在不同构建路径上键序是稳定的
 * （都由同一段投影代码生成），所以这里不做键排序；调用方换投影字段时自然得到新
 * revision，这正是我们要的（字段变了就是内容变了）。
 *
 * @param {unknown} value 任意可序列化值
 * @returns {string} 16 个十六进制字符；不可序列化时返回空串（调用方按「未知」处理）
 */
function stableRevision(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return '';
  }
  if (typeof text !== 'string') return '';
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/** 清单数组的 revision；空清单也有一个稳定的值（不是空串）。 */
function listRevision(items) {
  return stableRevision(Array.isArray(items) ? items : []);
}

/**
 * 条件刷新的极简响应（sessions / workspaces 共用）。
 *
 * 客户端带上上次拿到的 `revision` 来问「还是那一份吗」：**恰好相等**时只回一句
 * `{ok, unchanged:true, revision, generatedAt}`，不带 items —— 几十字节换几十 KB。
 *
 * 调用方负责决定「这次请求该不该走这条」（`?fresh=1` 的写后刷新、归档子集、子代理等
 * 一律不走）；这里只管形状与相等判定。不相等返回 null，调用方回完整 body。
 *
 * @param {object} body 最终要回的那份完整清单体
 * @param {string} rev  客户端带来的 revision
 */
function unchangedListBody(body, rev) {
  if (!body || body.ok !== true) return null;
  if (typeof rev !== 'string' || rev === '') return null;
  if (typeof body.revision !== 'string' || body.revision !== rev) return null;
  return { ok: true, unchanged: true, revision: body.revision, generatedAt: body.generatedAt };
}

module.exports = { stableRevision, listRevision, unchangedListBody };

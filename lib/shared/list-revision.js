'use strict';

/**
 * 清单内容指纹（sessions / workspaces 共用）。
 *
 * 两处要用：列表响应带 `revision`，App 连同 `generatedAt` 存进快照就能说清数据是什么时候的；
 * 镜像推送每 500ms 完整构建一次清单，内容没变时比对 revision 就能安全跳过。
 *
 * 用内容哈希而不是自增序号：插件随桌面 harness 频繁重启，序号每次都从 0 开始，重启后第一份
 * 快照会被当成新内容重推。用 sha1 而不是 32 位哈希：这个值会被用来跳过推送，一次碰撞等于
 * 一份该推的新数据被静默丢掉。截断到 16 个十六进制字符只是为了让日志短一点。
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

/**
 * 请求串里的 `?rev=`（条件刷新的客户端指纹）；没有、为空或解析不出来都返回空串。
 *
 * 空串在 `unchangedListBody` 那里是「照常回整份」，所以老 App 不带这个参数时行为不变。
 * 路径匹配发生在宿主那一侧、早就忽略了查询串，这里只负责取值。
 *
 * @param {{ url?: string }} req
 */
function revisionOf(req) {
  const raw = req && typeof req.url === 'string' ? req.url : '';
  if (!raw) return '';
  try {
    return (new URL(raw, 'http://x').searchParams.get('rev') || '').trim();
  } catch {
    return '';
  }
}

module.exports = { stableRevision, listRevision, unchangedListBody, revisionOf };

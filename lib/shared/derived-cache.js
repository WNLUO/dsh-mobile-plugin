'use strict';

/**
 * 派生结果缓存：同一份输入算过一次，内容没变就把上一份原样交回去。
 *
 * 会话历史、统计投影、镜像正文这几条都是「从整份源数据重新折一遍」的重活：长会话折一次
 * 要走上百个事件、几百 KB。而它们绝大多数时候面对的是同一份输入 —— 手机 15 秒轮询一次、
 * 镜像后台 500ms tick 一次，源数据没动的那几轮全在白算。
 *
 * 判据是**内容指纹**（`shared/list-revision.js` 的 `stableRevision`，与清单 / 工作区的
 * revision 同一套做法，不另发明一把尺子）：指纹相同就是同一份输出，指纹不同一定重算。
 * 指纹取不到（序列化失败）时**不进缓存**——那等于「不知道内容有没有变」，宁可老实重算。
 *
 * 按桶分：桶名就是会话 id，桶与桶之间不共享条目。同一段事件在两条会话里折出来的东西
 * 本来就不该串，分桶也顺带让淘汰能按会话整桶丢掉。
 *
 * 两道上限：每个桶留几条（同一会话的几次不同输入，例如翻页窗口前后各一份），桶总数也
 * 有上限，超出按插入序淘汰最旧的桶。
 *
 * 存进去的值必须是**只读**的：调用方拿到的是同一份引用，就地改它等于改别人的结果。
 */

const { stableRevision } = require('./list-revision.js');

/** 默认留下的会话桶数：手机上真正在看的就那么几条，翻页也只在一两条里翻。 */
const DEFAULT_MAX_BUCKETS = 32;

/**
 * 每个桶留几个指纹各不相同的版本。
 *
 * 会话历史会同时被三条路折：手机轮询的整窗、镜像的整窗、打开对话时的入口窗口。窗口
 * 差几条事件就是一个新指纹，只留一个的话它们会互相把对方的缓存挤掉，命中率掉到接近零。
 */
const DEFAULT_MAX_ENTRIES = 4;

/**
 * 建一份缓存。
 *
 * @param {object} [options]
 * @param {number} [options.maxBuckets]        最多留几个桶（会话）
 * @param {number} [options.maxEntriesPerBucket] 每个桶最多留几个版本
 */
function createDerivedCache(options = {}) {
  const maxBuckets = Number.isInteger(options.maxBuckets) && options.maxBuckets > 0
    ? options.maxBuckets
    : DEFAULT_MAX_BUCKETS;
  const maxEntries = Number.isInteger(options.maxEntriesPerBucket) && options.maxEntriesPerBucket > 0
    ? options.maxEntriesPerBucket
    : DEFAULT_MAX_ENTRIES;
  /** 桶名 → Map(指纹 → 值)。两个 Map 的插入序就是淘汰序。 */
  const buckets = new Map();

  /** 取到这个桶（顺带挪到末尾 = 最近用过）。 */
  const bucketOf = (name) => {
    const existing = buckets.get(name);
    if (!existing) return null;
    buckets.delete(name);
    buckets.set(name, existing);
    return existing;
  };

  /**
   * 内容没变就交回上一份。
   *
   * @param {string} name        桶名（会话 id）
   * @param {string} fingerprint 内容指纹（`stableRevision`）；空串一律当没命中
   * @returns {unknown|undefined} 上一份结果；没命中给 undefined
   */
  const get = (name, fingerprint) => {
    if (!name || !fingerprint) return undefined;
    const bucket = bucketOf(name);
    if (!bucket) return undefined;
    const hit = bucket.get(fingerprint);
    if (hit === undefined) return undefined;
    // 命中也挪到末尾：按使用序淘汰，别把正在看的这条会话挤掉。
    bucket.delete(fingerprint);
    bucket.set(fingerprint, hit);
    return hit;
  };

  /** 记下这一次算出来的结果（指纹为空时什么都不做）。 */
  const set = (name, fingerprint, value) => {
    if (!name || !fingerprint || value === undefined) return value;
    let bucket = bucketOf(name);
    if (!bucket) {
      bucket = new Map();
      buckets.set(name, bucket);
      while (buckets.size > maxBuckets) buckets.delete(buckets.keys().next().value);
    }
    bucket.delete(fingerprint);
    bucket.set(fingerprint, value);
    while (bucket.size > maxEntries) bucket.delete(bucket.keys().next().value);
    return value;
  };

  /** 丢掉一个桶（会话被删 / 归档时用）。 */
  const drop = (name) => {
    buckets.delete(name);
  };

  /** 全清（测试与「换个 DSH_HOME 重来」用）。 */
  const clear = () => {
    buckets.clear();
  };

  return { get, set, drop, clear, maxBuckets, maxEntriesPerBucket: maxEntries };
}

/**
 * 进程级单例：会话历史与别的派生共用一份，省掉每个模块各挂一张表。
 *
 * 它只活在插件进程里，重算一份也不贵 —— 重启之后手机本来就要重新拉一遍历史。
 */
const derivedCache = createDerivedCache();

module.exports = {
  createDerivedCache,
  derivedCache,
  DEFAULT_MAX_BUCKETS,
  DEFAULT_MAX_ENTRIES,
};

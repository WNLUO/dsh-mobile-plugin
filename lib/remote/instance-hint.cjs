// 远程电脑两条入口的实例号口径：头优先，缺头看 instance 查询参数。
'use strict';

/**
 * 浏览器是跨源客户端，有两件事它做不到：给 WebSocket 升级加自定义头，给 CORS 预检加自定义头。
 * 所以「这台电脑是哪一台」必须同时能从头和查询参数里读出来。
 *
 * 口径与中转侧同一个：**`x-dsh-instance` 头存在就先用它，没有才看 `instance` 查询参数**；
 * 两者都给且不是同一台，就是一张指向别的电脑的链接，按 `instance-conflict` 拒掉。
 *
 * 查参数与查头都只认**第一个**值：Node 对入站重复头给数组，早先的实现一律取 `[0]`。
 */

/** `x-dsh-instance` 头里的实例号，没有就给空串。 */
function headerInstanceOf(req) {
  const raw = req && req.headers ? req.headers['x-dsh-instance'] : undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.trim() : '';
}

/** `instance` 查询参数里的实例号，没有（或 URL 畸形）就给空串。 */
function queryInstanceOf(url) {
  const text = typeof url === 'string' ? url : '';
  if (!text) return '';
  try {
    const value = new URL(text, 'http://lan.local').searchParams.get('instance');
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

/** `{ header, query }` 两份原始读数。 */
function readInstanceHint(req) {
  return { header: headerInstanceOf(req), query: queryInstanceOf(req && req.url) };
}

/**
 * 按上面的优先级收成**这一条请求自报的实例号**。
 *
 * @returns {{ instance: string, conflict: boolean }} 两份读数都没有时 `instance` 为空串、
 *   `conflict` 为假 —— 「什么都没说」由握手与密文本身去判，这里不替它们下结论。
 */
function resolveInstanceHint(req) {
  const { header, query } = readInstanceHint(req);
  if (!header) return { instance: query, conflict: false };
  return { instance: header, conflict: Boolean(query) && query !== header };
}

/**
 * 两条入口共用的那道闸：请求自报的实例号与本机对不上就拒。
 *
 * 只认「自报了、而且说的不是本机」这一种。两份读数都没有时返回 null —— 这时该由协议本身
 * 判（配对请求里那份密文自报 instanceId，隧道的 hello 也带 instanceId），这里不抢着下结论。
 *
 * @param {object} req 请求（读 `headers` 与 `url`）
 * @param {string} instanceId 本机实例号
 * @returns {string} 拒绝原因码（`instance-conflict` / `instance-mismatch`），放行给 null
 */
function instanceHintRefusal(req, instanceId) {
  const { instance, conflict } = resolveInstanceHint(req);
  if (conflict) return 'instance-conflict';
  return instance && instance !== String(instanceId || '') ? 'instance-mismatch' : null;
}

module.exports = { resolveInstanceHint, instanceHintRefusal };

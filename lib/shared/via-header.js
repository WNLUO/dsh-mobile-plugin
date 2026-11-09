'use strict';

/**
 * 代理转发时给上游请求打「谁转发的」标记。
 *
 * 中转与局域网代理都跑在宿主这台机器上，它们转给本地上游的请求，socket 对端是回环地址、
 * `host` 又是 `127.0.0.1:<上游端口>`，所以上游**任何**看来源地址或 Host 的判断都会把它们
 * 当成「本机 DSH 设置页」。控制面因此是敞开的：不带实例头、不带 cookie 的
 * `POST /api/relay/config` 经中转能改中转地址、改注册密钥、`revoke-all`。
 *
 * 判据只能落在「谁转发的」这个事实上，而这个头必须**由代理覆盖写入**：先删客户端自带的
 * 同名副本（大小写不敏感、数组形态也删干净），再写自己的值。只写不删等于让客户端自己声明
 * 「我是本机」。
 */

const VIA_HEADER = 'x-dsh-via';

/**
 * 隧道落点代理（`lib/relay/tunnel-forwarder.cjs`）写进来的值。
 *
 * 与 `relay` / `lan` 分开，是因为面板上的「最近一次走的是哪条路」只有那两格有对应文案：
 * 把隧道流量记成 `lan` 会让一台走隧道的手机在设备列表里显示成「局域网」——那是假话。
 * 而控制面只需要「有标记」这一个事实，值取哪个都一样，所以这里挑不冒充别人的那个。
 */
const VIA_TUNNEL = 'tunnel';

/**
 * 这条请求是从哪条路转发进来的（`relay` / `lan`），本机直连返回空串。
 *
 * 设备列表要显示「最近一次走的是哪条路」，而这两条路最后都进到自己的代理里、
 * 各自注入了标记 —— 所以宿主不用问中转，也不用等别的版本。
 *
 * `tunnel`（隧道落点代理）**不在这里露面**：那一格只有中转 / 局域网两套文案，硬塞进去
 * 要么显示成谎话、要么得新增一种可见文案。控制面判据只认「有没有标记」，所以这里返回
 * 空串，设备列表照旧显示「—」。
 */
function viaChannel(req) {
  const headers = req?.headers;
  if (!headers || typeof headers !== 'object') return '';
  for (const [name, raw] of Object.entries(headers)) {
    if (name.toLowerCase() !== VIA_HEADER) continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return text === 'relay' || text === 'lan' ? text : '';
  }
  return '';
}

/** 删掉任意大小写的同名头（Node 的 headers 可能是数组值）。 */
function stripHeader(headers, name) {
  const target = name.toLowerCase();
  let removed = false;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== target) continue;
    delete headers[key];
    removed = true;
  }
  return removed;
}

/**
 * 复制一份转发用头：原头不动，去掉客户端自带的来源标记，写入代理自己的值。
 *
 * @param {Record<string, unknown>} incoming 客户端原始请求头
 * @param {'relay'|'lan'|'tunnel'} via 转发方
 * @param {string} fallbackHost 客户端没给 host 时用哪个
 * @returns {Record<string, unknown>}
 */
function withViaHeader(incoming, via, fallbackHost) {
  const headers = { ...(incoming || {}) };
  stripHeader(headers, VIA_HEADER);
  // 保留手机端原始 Host（信任围栏按 Host 判定）；缺省回退本地上游。
  if (!headers.host) headers.host = fallbackHost;
  headers[VIA_HEADER] = via;
  return headers;
}

module.exports = { VIA_HEADER, VIA_TUNNEL, stripHeader, withViaHeader, viaChannel };

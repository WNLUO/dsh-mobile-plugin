// 读本机节点小宝设备端的状态与绑定链接，给面板「接入这条线路」用。
'use strict';

/**
 * 节点小宝（iepose）的设备端以系统服务方式装在本机，插件不启动、不管理它的进程 ——
 * 它自己开机自启，死了也会自己重连。这里只做两件只读的事：问它「你装好没有、绑没绑」，
 * 以及没绑时把它的绑定链接取出来交给面板。
 *
 * 为什么走宿主而不是面板直接 fetch：设备端本地管理口在回环上，面板在浏览器里跨域读它会被
 * CORS 挡下；宿主是本机 node 进程，读回环没有跨域问题，而且这条路径本身是 localOnly 控制面。
 *
 * 端口是实测出来的、不是它对外的承诺：macOS 精简版 2080，Linux 安装脚本起在 9118。
 * 两个都试，哪个先答话用哪个；都不答就是没装或没起。
 */

/** 设备端本地管理口：按平台列候选，顺序即偏好。 */
const LOCAL_PORTS = { darwin: [2080], linux: [9118] };
/** /detect/version 是轻量探针，超时短；/bind 要等它去云端换短链，实测 5~16 秒。 */
const PROBE_TIMEOUT_MS = 3000;
const BIND_TIMEOUT_MS = 30_000;

function portsFor(platform) {
  const key = String(platform || process.platform);
  const list = LOCAL_PORTS[key];
  return Array.isArray(list) ? list : [];
}

/**
 * 问一个本地管理口要状态。返回 `{ ok, peerid, tun, workmode, error }`：
 * `ok=false` 表示这个口没人应答（没装 / 没起 / 被别的程序占着）。
 */
async function probePort(port, options = {}) {
  const doFetch = typeof options.fetchImpl === 'function'
    ? options.fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  if (!doFetch) return { ok: false, peerid: '', error: '当前环境没有可用的 fetch' };
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : PROBE_TIMEOUT_MS;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await doFetch(`http://127.0.0.1:${port}/detect/version`, {
      headers: { accept: 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response || response.ok !== true) return { ok: false, peerid: '', error: `HTTP ${response && response.status ? response.status : '?'}` };
    const payload = await response.json();
    // 名字对不上说明这个口是别的程序，不能因为「有个东西在 2080 上答话」就认它是节点小宝。
    if (!payload || payload.name !== 'NodeBabyLinkService') return { ok: false, peerid: '', error: '端口上不是节点小宝' };
    return {
      ok: true,
      peerid: typeof payload.peerid === 'string' ? payload.peerid : '',
      tun: typeof payload.tun === 'string' ? payload.tun : '',
      workmode: typeof payload.workmode === 'string' ? payload.workmode : '',
      error: '',
    };
  } catch (error) {
    const raw = error && error.message ? error.message : String(error);
    return { ok: false, peerid: '', error: raw };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 读本机设备端状态。
 *
 * @returns {Promise<{ supported: boolean, installed: boolean, bound: boolean, peerid: string,
 *   tun: string, port: number, error: string }>}
 *   `supported=false` 是这一版没接的平台（Windows 设备端没验过本地口，不乱猜）；
 *   `installed=false` 表示本机找不到设备端；`bound=false` 表示装了但还没登录绑定。
 */
async function readStatus(options = {}) {
  const platform = String(options.platform || process.platform);
  const ports = Array.isArray(options.ports) ? options.ports : portsFor(platform);
  if (!ports.length) {
    return { supported: false, installed: false, bound: false, peerid: '', tun: '', port: 0, error: '这一版只接了 macOS 与 Linux 的节点小宝设备端' };
  }
  let lastError = '';
  for (const port of ports) {
    const result = await probePort(port, options);
    if (result.ok) {
      return {
        supported: true,
        installed: true,
        bound: result.peerid !== '',
        peerid: result.peerid,
        tun: result.tun,
        port,
        error: '',
      };
    }
    lastError = result.error || lastError;
  }
  return { supported: true, installed: false, bound: false, peerid: '', tun: '', port: 0, error: lastError };
}

/**
 * 取设备端的绑定链接。设备端回 302 指向它的云端绑定页，把那一段 Location 原样交给面板。
 * 已经绑过的设备不会再给链接（它回 404 或直接给已绑页面），这里按 `ok:false` 如实说明。
 */
async function readBindUrl(options = {}) {
  const doFetch = typeof options.fetchImpl === 'function'
    ? options.fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  if (!doFetch) return { ok: false, url: '', error: '当前环境没有可用的 fetch' };
  const port = Number(options.port) > 0 ? Number(options.port) : (portsFor(options.platform)[0] || 0);
  if (!port) return { ok: false, url: '', error: '这一版没接这个平台' };
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : BIND_TIMEOUT_MS;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    // 手动接管跳转：要的是那一跳的目标地址，不是跳过去之后的页面。
    const response = await doFetch(`http://127.0.0.1:${port}/bind`, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
      ...(controller ? { signal: controller.signal } : {}),
    });
    const location = response && response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('location') : '';
    if (typeof location === 'string' && /^https?:\/\//i.test(location.trim())) {
      return { ok: true, url: location.trim(), error: '' };
    }
    return { ok: false, url: '', error: '设备端没有给出绑定链接（可能已经绑定过）' };
  } catch (error) {
    if (controller && controller.signal.aborted) {
      return { ok: false, url: '', error: '向设备端要绑定链接超时，请确认它正在运行' };
    }
    const raw = error && error.message ? error.message : String(error);
    return { ok: false, url: '', error: `连不上本机设备端：${raw}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 把用户在面板里填的那一条归一成线路：`https://域名` 走 http 线路，`主机:端口` 走 tcp 线路。
 *
 * 两种都要认，因为节点小宝有「网页服务」和「TCP服务」两类；但对我们的 App 只有前者能用 ——
 * 它的 TCP 网关会拦 HTTP 形状的流量（实测 GET/POST/HEAD/PUT/OPTIONS 全被换成一张拒绝页），
 * 而 App 发的就是 HTTP。保留 tcp 形状是为了不把用户填的东西悄悄改掉。
 */
function lineOf(value) {
  const raw = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (!url.hostname) return null;
      return { url: raw, transport: 'http' };
    } catch {
      return null;
    }
  }
  const { tcpDirectTarget } = require('../relay/lan-network.cjs');
  const target = tcpDirectTarget(raw);
  return target ? { url: target, transport: 'tcp' } : null;
}

module.exports = {
  LOCAL_PORTS,
  lineOf,
  probePort,
  readStatus,
  readBindUrl,
};

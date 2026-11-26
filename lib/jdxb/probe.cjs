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
 * 端口是实测 / 官方文档给的、不是它对外的承诺：macOS 2080、Linux 9118、Windows 在它自己的
 * 虚拟回环 127.66.36.18:2080（官方文档给的绑定地址），也试本地回环 2080 兜底。哪个先答话
 * 用哪个；都不答就是没装或没起。返回的 `service.installed` 以这次探测为准，面板据此决定
 * 显示「一键安装」还是「启动」，不靠各平台的文件标记。
 */

/** 设备端本地管理口：按平台列候选，顺序即偏好。 */
const LOCAL_ENDPOINTS = {
  darwin: [{ host: '127.0.0.1', port: 2080 }],
  linux: [{ host: '127.0.0.1', port: 9118 }],
  win32: [{ host: '127.66.36.18', port: 2080 }, { host: '127.0.0.1', port: 2080 }],
};
/** 兼容只按端口取候选的调用方：同一平台的端口按偏好去重。 */
const LOCAL_PORTS = Object.fromEntries(
  Object.entries(LOCAL_ENDPOINTS).map(([platform, endpoints]) => [platform, [...new Set(endpoints.map((endpoint) => endpoint.port))]]),
);
/** /detect/version 是轻量探针，超时短；/bind 要等它去云端换短链，实测 5~16 秒。 */
const PROBE_TIMEOUT_MS = 3000;
const BIND_TIMEOUT_MS = 30_000;
/** status 每 3 秒被轮询，判绑定时顺带问 /bind 只用探测级短超时：等不到就按没绑定算，不把用户卡在「已绑定」上。 */
const BIND_STATUS_TIMEOUT_MS = PROBE_TIMEOUT_MS;

function endpointsFor(platform) {
  const key = String(platform || process.platform);
  return Array.isArray(LOCAL_ENDPOINTS[key]) ? LOCAL_ENDPOINTS[key] : [];
}

function portsFor(platform) {
  return LOCAL_PORTS[String(platform || process.platform)] || [];
}

function hostsFor(platform) {
  return [...new Set(endpointsFor(platform).map((endpoint) => endpoint.host))];
}

/**
 * 问一个本地管理口要状态。返回 `{ ok, peerid, tun, workmode, error }`：
 * `ok=false` 表示这个口没人应答（没装 / 没起 / 被别的程序占着）。
 */
async function probePort(port, options = {}) {
  const host = typeof options.host === 'string' && options.host ? options.host : '127.0.0.1';
  const doFetch = typeof options.fetchImpl === 'function'
    ? options.fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  if (!doFetch) return { ok: false, peerid: '', error: '当前环境没有可用的 fetch' };
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : PROBE_TIMEOUT_MS;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await doFetch(`http://${host}:${port}/detect/version`, {
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
 *   tun: string, host: string, port: number, service: {installed:boolean}, error: string }>}
 *   `supported=false` 是这一版没接的平台（Windows 只接 x64，Linux 接 x64/arm64）；
 *   `installed=false` 表示本机找不到设备端；`bound` 由 /bind 是否仍给链接判定（给链接=没绑）。
 */
async function readStatus(options = {}) {
  const platform = String(options.platform || process.platform);
  const endpoints = Array.isArray(options.endpoints)
    ? options.endpoints
    : (Array.isArray(options.ports) ? options.ports.map((port) => ({ host: '127.0.0.1', port })) : endpointsFor(platform));
  if (!endpoints.length) {
    return {
      supported: false, installed: false, bound: false, peerid: '', tun: '', host: '', port: 0,
      service: { installed: false }, error: '这一版只接了 macOS、Windows 与 Linux 的节点小宝设备端',
    };
  }
  let lastError = '';
  for (const { host, port } of endpoints) {
    const result = await probePort(port, { ...options, host });
    if (result.ok) {
      const bind = await readBindUrl({ ...options, host, port, timeoutMs: BIND_STATUS_TIMEOUT_MS });
      // 是否绑定只看 /bind：仍给链接=没绑；设备端答话却不给链接=已绑；超时或连不上按没绑算，
      // 让面板继续给绑定链接，别把用户卡死在误判的「已绑定」上。
      const bound = bind.ok === false && bind.answered === true;
      return {
        supported: true,
        installed: true,
        bound,
        peerid: result.peerid,
        tun: result.tun,
        host,
        port,
        service: { installed: true },
        error: '',
      };
    }
    lastError = result.error || lastError;
  }
  return {
    supported: true, installed: false, bound: false, peerid: '', tun: '', host: '', port: 0,
    service: { installed: false }, error: lastError,
  };
}

/**
 * 取设备端的绑定链接。设备端回 302 指向它的云端绑定页，把那一段 Location 原样交给面板。
 * 已经绑过的设备不会再给链接（它回 404 或直接给已绑页面），这里按 `ok:false` 如实说明；
 * 返回的 `answered` 区分「设备端答话但不给链接」（已绑）与「超时/连不上」（无从判断）。
 * 只给了端口没给主机时，按平台的候选主机逐个问（Windows 要先问它的虚拟回环）。
 */
async function readBindUrl(options = {}) {
  const doFetch = typeof options.fetchImpl === 'function'
    ? options.fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  if (!doFetch) return { ok: false, url: '', answered: false, error: '当前环境没有可用的 fetch' };
  const platform = String(options.platform || process.platform);
  const port = Number(options.port) > 0 ? Number(options.port) : 0;
  const hosts = typeof options.host === 'string' && options.host ? [options.host] : hostsFor(platform);
  const endpoints = port ? hosts.map((host) => ({ host, port })) : endpointsFor(platform);
  if (!endpoints.length) return { ok: false, url: '', answered: false, error: '这一版没接这个平台' };
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : BIND_TIMEOUT_MS;
  let lastError = '';
  let answered = false;
  for (const { host, port: candidatePort } of endpoints) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      // 手动接管跳转：要的是那一跳的目标地址，不是跳过去之后的页面。
      const response = await doFetch(`http://${host}:${candidatePort}/bind`, {
        redirect: 'manual',
        headers: { accept: 'text/html' },
        ...(controller ? { signal: controller.signal } : {}),
      });
      answered = true;
      const location = response && response.headers && typeof response.headers.get === 'function'
        ? response.headers.get('location') : '';
      if (typeof location === 'string' && /^https?:\/\//i.test(location.trim())) {
        return { ok: true, url: location.trim(), answered: true, error: '' };
      }
      lastError = '设备端没有给出绑定链接（可能已经绑定过）';
    } catch (error) {
      if (controller && controller.signal.aborted) {
        lastError = '向设备端要绑定链接超时，请确认它正在运行';
      } else {
        lastError = `连不上本机设备端：${error && error.message ? error.message : String(error)}`;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { ok: false, url: '', answered, error: lastError };
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
  LOCAL_ENDPOINTS,
  LOCAL_PORTS,
  endpointsFor,
  portsFor,
  hostsFor,
  lineOf,
  probePort,
  readStatus,
  readBindUrl,
};

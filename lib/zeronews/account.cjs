// 只读账号快照：把 CLI 的 status / show 三张清单归一成面板能直接画的结构，不写配置、不建隧道。
'use strict';

/**
 * ZeroNews 是账号制内网穿透，客户端一登录就能通过官方 CLI 读到「这台机器 + 整个账号」的现状：
 *   · `status --json`        —— 登录 / 连接状态、client_id、节点、主机、版本、最近心跳、套餐名、账号；
 *   · `show devices --json`  —— 账号下所有设备（在线、版本、系统、IP、接入时间……）；
 *   · `show tunnels --json`  —— 账号下所有隧道（域名、协议、带宽、状态、转发到本机哪个端口……）；
 *   · `show domains --json`  —— 账号下的域名（默认域名 / 自有域名）。
 *
 * 这里只做「读 + 归一」，全部字段按官方 JSON 的真实形状挑，缺字段就给空值，不让界面出现 undefined。
 * 定位可执行文件走 provision 的 locate（只找不下），客户端没装就如实回 available:false，绝不顺手下载。
 *
 * 官方 CLI 与本地 API 都没暴露「套餐配额上限」（能建多少条隧道 / 多少台设备），只有套餐名与已用数量，
 * 所以这里也只给「套餐名 + 已用数量」，不编造上限。所有命令 / 定位都可注入，守卫用假体走完整条分支。
 */

const { execFile } = require('node:child_process');
const path = require('node:path');

const { locateZeroNews } = require('./provision.cjs');

const DEFAULT_TIMEOUT_MS = 15_000;

/** 统一跑一条 CLI 命令：拿到 stdout / stderr / 退出码，不抛异常（登录过期等按空结果处理）。 */
function defaultRun(binary, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(binary, args, {
      timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
      cwd: opts.cwd || path.dirname(binary),
      maxBuffer: 1 << 20,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** 命令行里可能夹着日志行；只取第一对花括号之间的 JSON。解析不出就 null。 */
function parseJson(text) {
  const raw = String(text || '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

function str(value) {
  return typeof value === 'string' ? value : (value === null || value === undefined ? '' : String(value));
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function bool(value) {
  return value === true || value === 'true';
}

/** `{total, items}` 这一层的 items，认不出就给空数组。 */
function itemsOf(page) {
  if (!page || typeof page !== 'object') return [];
  return Array.isArray(page.items) ? page.items : [];
}

/** 总数优先用 CLI 的 total（分页时它才是全量），没有再退回本页条数。 */
function totalOf(page, items) {
  if (page && typeof page === 'object' && page.total !== undefined) {
    const n = Number(page.total);
    if (Number.isFinite(n)) return n;
  }
  return items.length;
}

/** status --json 归一到面板用的字段。 */
function normalizeClient(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    login: bool(raw.login),
    loginPending: bool(raw.login_pending),
    configured: bool(raw.configured),
    connected: bool(raw.connected),
    clientId: str(raw.client_id),
    node: str(raw.cloud_server_addr),
    hostname: str(raw.hostname),
    os: str(raw.os),
    arch: str(raw.arch),
    version: str(raw.version),
    endpointCount: num(raw.endpoint_count),
    lastPongAt: str(raw.last_pong_at),
    clientEnabled: raw.client_enabled !== false,
  };
}

function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object') return { planName: '', userId: '', userTel: '' };
  return {
    planName: str(raw.plan_name),
    userId: str(raw.user_id),
    userTel: str(raw.user_tel),
  };
}

function normalizeDevice(row) {
  if (!row || typeof row !== 'object') return null;
  const id = str(row.id);
  if (!id) return null;
  return {
    id,
    name: str(row.custom_name) || str(row.name),
    hostname: str(row.hostname),
    os: str(row.os),
    arch: str(row.arch),
    version: str(row.version),
    ip: str(row.ip),
    online: bool(row.is_online),
    enabled: bool(row.enabled),
    createdAt: str(row.created_at),
    edgeNode: str(row.edge_node_name),
    workspace: str(row.workspace && row.workspace.name),
  };
}

/** 隧道第一个转发后端指向的本机地址（面板只显示一条，够用且不吓人）。 */
function tunnelLocal(row) {
  const rules = Array.isArray(row.route_rules) ? row.route_rules : [];
  for (const rule of rules) {
    const forwards = Array.isArray(rule.forward_rules) ? rule.forward_rules : [];
    for (const fwd of forwards) {
      const endpoints = fwd && fwd.load_balance_policy && fwd.load_balance_policy.backend_endpoints;
      if (!Array.isArray(endpoints)) continue;
      for (const ep of endpoints) {
        const port = Number(ep && ep.local_port);
        if (Number.isFinite(port) && port > 0) {
          const ip = str(ep.local_ip) || '127.0.0.1';
          return `${ip}:${port}`;
        }
      }
    }
  }
  return '';
}

/** 隧道的公网地址：自有域名优先，否则子域 + 根域。 */
function tunnelDomain(row) {
  const self = str(row.self_hosted_domain);
  if (self) return self;
  const sub = str(row.subdomain);
  const root = str(row.root_domain && row.root_domain.domain);
  if (sub && root) return `${sub}.${root}`;
  return sub || root;
}

function normalizeTunnel(row) {
  if (!row || typeof row !== 'object') return null;
  const id = str(row.id);
  if (!id) return null;
  return {
    id,
    type: str(row.type).toUpperCase(),
    feature: str(row.feature),
    mode: str(row.mode),
    domain: tunnelDomain(row),
    enabled: bool(row.enabled),
    bw: num(row.bw),
    status: str(row.status),
    local: tunnelLocal(row),
    createdAt: str(row.created_at),
    lastSyncedAt: str(row.last_synced_at),
  };
}

function normalizeDomain(row) {
  if (!row || typeof row !== 'object') return null;
  const id = str(row.id);
  if (!id) return null;
  const sub = str(row.subdomain);
  const root = str(row.root_domain && row.root_domain.domain);
  return {
    id,
    fqdn: str(row.cname_domain) || (sub && root ? `${sub}.${root}` : (sub || root)),
    type: str(row.type),
    status: str(row.status),
    enabled: bool(row.enabled),
    portCount: Array.isArray(row.ports) ? row.ports.length : 0,
  };
}

function compact(list) {
  return list.filter(Boolean);
}

/** 客户端没装 / 没登录时的统一空壳：字段齐全，让界面照常渲染。 */
function emptySnapshot(extra = {}) {
  return {
    ok: true,
    available: true,
    login: false,
    resourcesLoaded: false,
    error: '',
    client: null,
    account: { planName: '', userId: '', userTel: '' },
    counts: { tunnels: 0, devices: 0, domains: 0 },
    tunnels: [],
    devices: [],
    domains: [],
    ...extra,
  };
}

/**
 * @param {object} [options]
 * @param {() => Promise<{ok:boolean,path:string}>} [options.locate] 定位已装客户端（只找不下）
 * @param {(bin:string,args:string[],opts:object)=>Promise<{code:number,stdout:string,stderr:string}>} [options.run] 命令执行注入
 * @param {number} [options.timeoutMs] 单条命令超时
 */
function createZeroNewsAccountReader(options = {}) {
  const locate = typeof options.locate === 'function' ? options.locate : locateZeroNews;
  const run = typeof options.run === 'function' ? options.run : defaultRun;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;

  async function runJson(binary, args) {
    const result = await run(binary, args, { timeoutMs });
    return { parsed: parseJson(result && result.stdout), result };
  }

  async function read() {
    let found = null;
    try { found = await locate(); } catch { found = null; }
    if (!found || !found.ok || !found.path) {
      return emptySnapshot({ available: false, error: '' });
    }
    const binary = found.path;
    const { parsed: status } = await runJson(binary, ['status', '--json']);
    const client = normalizeClient(status);
    const account = normalizeAccount(status);
    const loggedIn = Boolean(client && client.login);
    if (!loggedIn) {
      return emptySnapshot({ available: true, login: false, client, account, resourcesLoaded: false });
    }
    // 三张清单彼此独立，一起拉；某一张读失败就空着，不把整页带崩。
    const [devicesRes, tunnelsRes, domainsRes] = await Promise.all([
      runJson(binary, ['show', 'devices', '--json']),
      runJson(binary, ['show', 'tunnels', '--json']),
      runJson(binary, ['show', 'domains', '--json']),
    ]);
    const deviceItems = itemsOf(devicesRes.parsed);
    const tunnelItems = itemsOf(tunnelsRes.parsed);
    const domainItems = itemsOf(domainsRes.parsed);
    const failed = [devicesRes, tunnelsRes, domainsRes].some((r) => !r.parsed);
    return {
      ok: true,
      available: true,
      login: true,
      resourcesLoaded: !failed,
      error: failed ? 'part of account data could not be loaded' : '',
      client,
      account,
      counts: {
        devices: totalOf(devicesRes.parsed, deviceItems),
        tunnels: totalOf(tunnelsRes.parsed, tunnelItems),
        domains: totalOf(domainsRes.parsed, domainItems),
      },
      devices: compact(deviceItems.map(normalizeDevice)),
      tunnels: compact(tunnelItems.map(normalizeTunnel)),
      domains: compact(domainItems.map(normalizeDomain)),
    };
  }

  return { read };
}

module.exports = {
  DEFAULT_TIMEOUT_MS, parseJson, normalizeClient, normalizeAccount, normalizeDevice,
  normalizeTunnel, normalizeDomain, tunnelLocal, tunnelDomain, createZeroNewsAccountReader,
};

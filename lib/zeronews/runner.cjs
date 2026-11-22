// ZeroNews 客户端运行器：ensure→login→start→建隧道→读域名，进程生命周期与状态。
'use strict';

/**
 * 把官方客户端从「没有」带到「有一个指向本机端口、拿到公网域名的隧道」。顺序照厂商现行流程：
 *   ① ensureZeroNews 拿到可执行文件（用户不装）；
 *   ② `login` 拉起浏览器让用户确认（login_pending / status.login 判定），**不收用户 token**（厂商明令弃用 authtoken）；
 *   ③ `start` 起本地客户端 + HTTP API（幂等，已登录已运行就跳过）；
 *   ④ 本地 API 建一条 HTTPS 隧道指向本机端口（已有则复用，免费档一条额度，绝不重复建）；
 *   ⑤ 读 endpoints 拿公网域名 → 交调用方写进线路清单。
 *
 * 所有进程 / 网络 / 时钟都可注入，守卫用假体走完整条链，不连真网、不起真进程。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const DEFAULT_BASE = 'http://127.0.0.1:37271';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 浏览器确认最长等 5 分钟，别一直挂在「登录中」。
const START_TIMEOUT_MS = 40_000;
// 轮询也按次数封顶：光看 wall-clock 的话，时钟源被替换或定时器被加速时会无限空转。
const LOGIN_POLL_MAX = 300;
const START_POLL_MAX = 40;

function endpointUrl(text) {
  const raw = String(text || '').trim();
  if (!/^https:\/\/[^\s/]+/i.test(raw)) return '';
  try { return new URL(raw).hostname ? raw.replace(/\/+$/, '') : ''; } catch { return ''; }
}

/** 从 endpoints 响应里取第一条 active 的 HTTPS 域名（兼容 data.items / 裸数组 / endpoints）。 */
function pickEndpoint(payload) {
  const data = payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
  const items = Array.isArray(data) ? data
    : (data && Array.isArray(data.items)) ? data.items
      : (data && Array.isArray(data.endpoints)) ? data.endpoints : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const status = String(item.status || '').toLowerCase();
    if (status && status !== 'active') continue;
    const type = String(item.type || '').toUpperCase();
    if (type && type !== 'HTTPS') continue;
    const domain = typeof item.domain === 'string' && item.domain ? item.domain
      : typeof item.public_url === 'string' ? item.public_url : '';
    const url = endpointUrl(domain.includes('://') ? domain : `https://${domain}`);
    if (url) return url;
  }
  return '';
}

/**
 * @param {object} options
 * @param {() => Promise<{ok:boolean,path:string,code?:string}>} options.ensure 取二进制（provision）
 * @param {() => number} options.portOf 本机要映射的 LAN 端口
 * @param {object} [options.spawnImpl] spawn 注入
 * @param {(url:string, init:object)=>Promise<any>} [options.fetchImpl] 本地 API fetch 注入
 * @param {(bin:string,args:string[],opts:object)=>Promise<{code:number,stdout:string,stderr:string}>} [options.runImpl] 一次性命令注入
 * @param {string} [options.base] 本地 API 根
 */
function createZeroNewsRunner(options = {}) {
  const ensure = options.ensure;
  const portOf = typeof options.portOf === 'function' ? options.portOf : () => 0;
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn;
  const doFetch = typeof options.fetchImpl === 'function' ? options.fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  const runImpl = typeof options.runImpl === 'function' ? options.runImpl : null;
  const base = String(options.base || DEFAULT_BASE).replace(/\/+$/, '');
  const sleep = typeof options.sleepImpl === 'function' ? options.sleepImpl : (ms) => new Promise((r) => setTimeout(r, ms));

  let child = null;
  let binary = '';
  let error = '';
  let url = '';
  let phase = 'off'; // off | installing | login | starting | connecting | connected | error
  let generation = 0;

  function status() {
    return {
      available: Boolean(binary) || phase !== 'off',
      running: Boolean(child),
      phase,
      url: phase === 'connected' ? url : '',
      error,
    };
  }

  /** 一次性跑一条命令，汇总 stdout/stderr/退出码（login 起浏览器那条用 spawn 不 wait）。 */
  async function run(args) {
    if (!runImpl) throw new Error('没有命令执行器');
    const result = await runImpl(binary, args, { timeoutMs: 8000 });
    if (result && result.code !== 0) {
      const msg = String(result.stderr || result.stdout || '').trim();
      throw new Error(msg || `zeronews ${args[0]} 退出码 ${result.code}`);
    }
    return result;
  }

  async function api(pathname, init) {
    if (!doFetch) return null;
    const res = await doFetch(`${base}${pathname}`, { headers: { accept: 'application/json' }, ...(init || {}) });
    if (!res || res.ok !== true) return null;
    try { return await res.json(); } catch { return null; }
  }

  /** 轮询 status.login，等浏览器确认完成（或超时）。 */
  async function waitLogin(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (let i = 0; i < LOGIN_POLL_MAX && Date.now() < deadline; i += 1) {
      const s = await api('/api/v1/status');
      const login = s && (s.data || s);
      if (login && (login.login === true || login.logged_in === true)) return true;
      await sleep(1000);
    }
    return false;
  }

  /** 轮询 endpoints 拿到隧道域名，最多等到 START_TIMEOUT_MS。 */
  async function waitEndpoint(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (let i = 0; i < START_POLL_MAX && Date.now() < deadline; i += 1) {
      const payload = await api('/api/v1/endpoints');
      const found = pickEndpoint(payload);
      if (found) return found;
      await sleep(1500);
    }
    return '';
  }

  /** 确保有一条指向本机端口的 HTTPS 隧道：已有一条就复用（免费档只有一条额度）。 */
  async function ensureTunnel(port) {
    const payload = await api('/api/v1/endpoints');
    const existing = pickEndpoint(payload);
    if (existing) return existing;
    if (!Number.isInteger(port) || port <= 0) return '';
    await api('/api/v1/tunnels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'https', port }),
    });
    return waitEndpoint(START_TIMEOUT_MS);
  }

  async function start() {
    const gen = ++generation;
    error = '';
    url = '';
    try {
      phase = 'installing';
      const got = await ensure();
      if (!got || !got.ok) throw new Error(got && got.code === 'unsupported-platform' ? '这台系统不支持自动安装 ZeroNews 客户端' : '下载 ZeroNews 客户端失败，请稍后重试');
      binary = got.path;

      // login：已登录会秒回；未登录会拉起浏览器，等用户确认。厂商明令不用 token/authtoken。
      phase = 'login';
      const opts = { stdio: 'ignore', cwd: path.dirname(binary) };
      const who = spawnImpl(binary, ['login'], opts);
      if (who && typeof who.on === 'function') who.on('error', () => {});
      const loggedIn = await waitLogin(LOGIN_TIMEOUT_MS);
      if (gen !== generation) return status();
      if (!loggedIn) throw new Error('等待浏览器确认登录超时，请在弹出的浏览器里完成登录后再点连接');

      phase = 'starting';
      // start 常驻：后台拉起，不 wait；已运行时官方命令自身幂等。
      if (!child) {
        child = spawnImpl(binary, ['start'], { stdio: 'ignore', detached: true, cwd: path.dirname(binary) });
        if (child && typeof child.on === 'function') {
          child.on('error', () => {});
          child.on('exit', () => { if (gen === generation) { child = null; if (phase === 'connected') { phase = 'error'; error = 'ZeroNews 客户端意外退出'; } } });
          if (typeof child.unref === 'function') child.unref();
        }
      }
      phase = 'connecting';
      const healthDeadline = Date.now() + START_TIMEOUT_MS;
      while (Date.now() < healthDeadline) {
        if (await api('/healthz')) break;
        await sleep(1000);
      }
      url = await ensureTunnel(portOf());
      if (gen !== generation) return status();
      if (!url) throw new Error('客户端已连上，但还没拿到隧道公网地址，请稍后刷新');
      phase = 'connected';
    } catch (err) {
      if (gen !== generation) return status();
      phase = 'error';
      error = err && err.message ? err.message : String(err);
    }
    return status();
  }

  function stop() {
    generation += 1;
    if (child && typeof child.kill === 'function') { try { child.kill(); } catch {} }
    child = null;
    url = '';
    error = '';
    phase = 'off';
    return status();
  }

  return { start, stop, status, pickEndpoint, endpointUrl };
}

module.exports = { DEFAULT_BASE, LOGIN_TIMEOUT_MS, START_TIMEOUT_MS, endpointUrl, pickEndpoint, createZeroNewsRunner };

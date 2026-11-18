'use strict';
// 远程电脑管理仅接受本机可信界面；电脑配对和加密升级由各自协议独立认证。
// 桌面壳入口带专属标记，本机代理据此只给壳会话启用桌面端排版。
// 2026-11-19：spawn 的异步失败（没有 pid 或收到 error）和 900ms 内闪退同等处理，回 shellOpened:false；
// 错误文案改读 controller 里那一份唯一定义，并给 bad-invite / bad-id / bad-mode 带上错误码。
// 2026-11-19：/mode 删掉静态档位白名单，存在性只由 controller.setMode → router.setMode 校验
// （静态那份冗余且先过期，会把新通道挡在门外）。
const { sendJson, readJsonBody } = require('../shared/http-util.js');
const { trustedLocalUi, crossSiteRequest } = require('../http/routing.js');
const { launchShell, spawnFailed } = require('./shell.cjs');
const { REMOTE_ERROR_TEXT, REMOTE_ERROR_FALLBACK } = require('./controller.cjs');
const PREFIX = '/api/relay/remote-computers';
// 壳拉起后先观察一小会儿：刚起来就退（缺运行库 / 无图形会话 / 闪退）就当没打开，让前端退回浏览器。
const SHELL_GRACE_MS = 900;
function shellSurvived(child, waitMs = SHELL_GRACE_MS) {
  // 测试里 launch 可能只给个占位值（不响应事件）：没法判死活，按起来处理，保持原契约。
  if (!child || typeof child.once !== 'function') return Promise.resolve(true);
  // 进程没拿到 pid 或已收到 error：可执行文件根本没跑起来，和闪退一样当没打开。
  if (child.exitCode !== null && child.exitCode !== undefined) return Promise.resolve(false);
  if (spawnFailed(child)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (alive) => { if (settled) return; settled = true; clearTimeout(timer); child.removeListener?.('exit', onExit); child.removeListener?.('error', onError); resolve(alive); };
    const onExit = () => finish(false);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(true), waitMs);
    timer.unref?.();
    child.once('exit', onExit);
    child.once('error', onError);
  });
}
const METHODS = { '': 'GET', '/invite': 'POST', '/add': 'POST', '/open': 'POST', '/open-shell': 'POST',
  '/renew': 'POST', '/stop': 'POST', '/remove': 'POST', '/mode': 'POST', '/probe': 'POST', '/diagnose': 'POST', '/revoke': 'POST' };
function createRemoteRoutes({ controller, host, credentials, instanceId, now = Date.now, launch = launchShell }) {
  function authorizedComputers() {
    return credentials.listRemoteComputers(instanceId);
  }
  function handler(suffix) {
    return async (req, res) => {
      res.setHeader('cache-control', 'no-store');
      if (!trustedLocalUi(req) || crossSiteRequest(req)) return sendJson(res, 403, {
        ok: false, error: { code: 'local_only', message: '请从本机 DSH 插件打开远程电脑管理' },
      });
      if (req.method !== METHODS[suffix]) return sendJson(res, 405, {
        ok: false, error: { code: 'method-not-allowed', message: '请求方法不支持' },
      });
      try {
        if (!suffix) return sendJson(res, 200, { ok: true, devices: await controller.list(),
          authorizedComputers: authorizedComputers(), serverNow: now() });
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
          return sendJson(res, 415, { ok: false, error: { code: 'json-required', message: '请使用 JSON 请求' } });
        }
        const body = await readJsonBody(req, 32 * 1024);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, {
          ok: false, error: { code: 'bad-request', message: '请求内容不合法' },
        });
        if (suffix === '/invite') return sendJson(res, 200, { ok: true, ...await host.mintInvite() });
        if (suffix === '/add') {
          if (typeof body.invite !== 'string' || body.invite.length > 24 * 1024) throw Object.assign(new Error('bad-invite'), { code: 'bad-invite' });
          return sendJson(res, 200, { ok: true, device: await controller.add(body.invite) });
        }
        if (suffix === '/revoke') {
          if (typeof body.deviceId !== 'string' || !authorizedComputers().some(row => row.deviceId === body.deviceId)) {
            return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '电脑授权不存在' } });
          }
          const revoked = credentials.revokeDevice(instanceId, body.deviceId);
          host.revoke(body.deviceId);
          return sendJson(res, 200, { ok: true, revoked });
        }
        if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.id)) throw Object.assign(new Error('bad-id'), { code: 'bad-id' });
        if (suffix === '/open') return sendJson(res, 200, { ok: true, ...await controller.open(body.id) });
        if (suffix === '/open-shell') {
          const result = await controller.open(body.id);
          const devices = await controller.list();
          const deviceName = devices.find(row => row.id === body.id)?.name || '';
          // 壳入口带专属标记，本机代理据此只给壳会话启用桌面端排版。
          const shellUrl = new URL(result.url);
          shellUrl.searchParams.set('shell', '1');
          // 记下这次拉起的桌面进程：它一退出就当窗口关掉，面板据此回到未打开。
          const child = launch({ url: shellUrl.href, deviceName });
          // 壳没挺过起手那一小会儿就说明本机起不来它（缺运行库、无图形会话或直接闪退）：
          // 回 shellOpened:false，让前端退回浏览器打开，而不是让用户点了像什么都没发生。
          if (!await shellSurvived(child)) {
            return sendJson(res, 200, { ok: true, ...result, shellOpened: false });
          }
          controller.watchWindow(body.id, child);
          return sendJson(res, 200, { ok: true, ...result, shellOpened: true });
        }
        if (suffix === '/renew') return sendJson(res, 200, { ok: true, ...await controller.renew(body.id) });
        if (suffix === '/stop') await controller.stop(body.id);
        if (suffix === '/remove') await controller.remove(body.id);
        if (suffix === '/mode') {
          if (typeof body.mode !== 'string') throw Object.assign(new Error('bad-mode'), { code: 'bad-mode' });
          await controller.setMode(body.id, body.mode);
        }
        if (suffix === '/probe') await controller.probe(body.id);
        if (suffix === '/diagnose') return sendJson(res, 200, { ok: true, routes: await controller.diagnose(body.id) });
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'remote-operation-failed';
        const status = /REVOKED|AUTH/.test(code) ? 401 : /EXPIRED|expired/i.test(code) ? 410 : 400;
        return sendJson(res, status, { ok: false, error: { code,
          message: REMOTE_ERROR_TEXT[code] || REMOTE_ERROR_FALLBACK } });
      }
    };
  }
  return { register(registerRoute) {
    for (const suffix of Object.keys(METHODS)) registerRoute({ kind: 'exact', path: PREFIX + suffix, handler: handler(suffix) });
  }, handler, authorizedComputers };
}
module.exports = { createRemoteRoutes, PREFIX, METHODS };

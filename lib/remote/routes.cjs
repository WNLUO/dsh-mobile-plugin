'use strict';
// 远程电脑管理仅接受本机可信界面；电脑配对和加密升级由各自协议独立认证。
const { sendJson, readJsonBody } = require('../shared/http-util.js');
const { trustedLocalUi, crossSiteRequest } = require('../http/routing.js');
const PREFIX = '/api/relay/remote-computers';
const METHODS = { '': 'GET', '/invite': 'POST', '/add': 'POST', '/open': 'POST', '/renew': 'POST',
  '/stop': 'POST', '/remove': 'POST', '/mode': 'POST', '/probe': 'POST', '/revoke': 'POST' };
const PUBLIC_ERRORS = {
  'credentials-unavailable': '宿主凭据存储暂不可用，请稍后重试',
  REMOTE_AUTH: '远程电脑认证失败，请重新绑定', REMOTE_REVOKED: '这台电脑的授权已被撤销，请重新绑定',
  REMOTE_EXPIRED: '授权已到期，请重新打开', REMOTE_TIMEOUT: '连接远程电脑超时，请重试或检测线路',
  REMOTE_CONNECT: '暂时无法连接远程电脑，请检查网络和对方是否在线',
};
function createRemoteRoutes({ controller, host, credentials, instanceId, now = Date.now }) {
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
          if (typeof body.invite !== 'string' || body.invite.length > 24 * 1024) throw new Error('bad-invite');
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
        if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.id)) throw new Error('bad-id');
        if (suffix === '/open') return sendJson(res, 200, { ok: true, ...await controller.open(body.id) });
        if (suffix === '/renew') return sendJson(res, 200, { ok: true, ...await controller.renew(body.id) });
        if (suffix === '/stop') await controller.stop(body.id);
        if (suffix === '/remove') await controller.remove(body.id);
        if (suffix === '/mode') {
          if (typeof body.mode !== 'string' || !['auto', 'lan', 'direct', 'ipv6', 'relay', 'tunnel', 'p2p'].includes(body.mode)) throw new Error('bad-mode');
          await controller.setMode(body.id, body.mode);
        }
        if (suffix === '/probe') await controller.probe(body.id);
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'remote-operation-failed';
        const status = /REVOKED|AUTH/.test(code) ? 401 : /EXPIRED|expired/i.test(code) ? 410 : 400;
        return sendJson(res, status, { ok: false, error: { code,
          message: PUBLIC_ERRORS[code] || '远程电脑操作未完成，请确认绑定信息、网络和访问期限后重试' } });
      }
    };
  }
  return { register(registerRoute) {
    for (const suffix of Object.keys(METHODS)) registerRoute({ kind: 'exact', path: PREFIX + suffix, handler: handler(suffix) });
  }, handler, authorizedComputers };
}
module.exports = { createRemoteRoutes, PREFIX, METHODS };

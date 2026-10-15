'use strict';

/**
 * 移动端「宿主凭据」API：把密钥的查看 / 写入 / 清除补齐到手机上。
 *
 * 桌面端的设置面板能往宿主写 API Key（dsh-client-ui-settings-plugins/lib/client.js
 * 的 writeKey() → credentials.set，写完再 credentials.describe 复核），手机此前
 * 只能在设置页看到一句「· 1 项密钥未设置」，却没有任何入口去填——这正是本轮补的缺口。
 *
 * 三条接口都只是转发宿主的 credentials 域：
 *  - GET  /credentials?refs=A,B  → credentials.describe
 *  - POST /credentials/set       → credentials.set
 *  - POST /credentials/unset     → credentials.unset
 *
 * 密钥值只在这条路上出现一次（手机 → 宿主）。宿主从不回传值：describe 只给
 * {configured, source?, writable}，所以这里的响应里也永远不会有 value 字段。
 *
 * 宿主 describe **回的就是一张平表**：键是引用名、值是上面那个视图
 * （`dsh-api-settings-controller/lib/types/credentials.js` 的
 * `Object.fromEntries(branded.map(...))`，0.2.0 的网关与旧 apiProxy 两条路都打到
 * 同一个 Remote 命名空间）。曾经在这里多拆一层 `value.credentials` —— 那一层从来
 * 不存在，于是每个引用都落成「未配置」，设置页永远显示「密钥未设置」，而测试假体
 * 照抄了同一个错形状，绿的。读了宿主源码才看出来。
 *
 * 「能不能写」由宿主的 credentials 服务说了算：如果某个引用是启动环境变量提供的，
 * 宿主会回 writable:false，set 则回 credential-rejected（"supplied read-only by the
 * launching environment"）。这里不自己判断，一律如实透传，让 App 显示宿主的原话。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');
const { unwrap } = require('./sessions.js');

const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/; // 与宿主 credentialRefNameSchema 同一条规则
const CREDENTIAL_MAX_REFS = 64;            // describe 一次最多问这么多个引用（宿主也是 64）
const CREDENTIAL_MAX_REF_CHARS = 128;      // 单个引用名长度上限
const CREDENTIAL_MAX_VALUE_CHARS = 8192;   // 密钥值长度上限：够放任何 API Key，又不至于让请求体失控

/** 校验一个凭据引用名；畸形一律拒绝，不把垃圾转发给宿主。 */
function normalizeRef(value) {
  if (typeof value !== 'string') return null;
  const ref = value.trim();
  if (!ref || ref.length > CREDENTIAL_MAX_REF_CHARS) return null;
  return CREDENTIAL_REF_PATTERN.test(ref) ? ref : null;
}

/** 把宿主的凭据视图压成手机需要的形状；source 只在宿主给出时带上，值永不出现。 */
function normalizeCredentialView(view) {
  if (!view || typeof view !== 'object' || Array.isArray(view)) return null;
  const source = typeof view.source === 'string' && view.source.trim() ? view.source.trim() : undefined;
  return {
    configured: view.configured === true,
    ...(source === undefined ? {} : { source }),
    writable: view.writable === true,
  };
}

/** GET /api/mobile/v1/credentials?refs=A,B —— 这批引用是否已配置、能不能写。 */
async function handleCredentialsDescribe(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = (url.searchParams.get('refs') || '').split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length > CREDENTIAL_MAX_REFS) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'bad-request', message: `refs 一次最多 ${CREDENTIAL_MAX_REFS} 个` },
    });
  }
  const refs = [];
  for (const part of parts) {
    const ref = normalizeRef(part);
    if (!ref) {
      return sendJson(res, 400, {
        ok: false,
        error: { code: 'bad-request', message: 'refs 必须是逗号分隔的凭据引用名，形如 DEEPSEEK_API_KEY' },
      });
    }
    if (!refs.includes(ref)) refs.push(ref);
  }

  const { value, error } = unwrap(await ctx.apiProxy.credentials.describe({
    rpcId: 'mobile',
    method: 'credentials.describe',
    payload: { refs },
  }));
  if (error) return sendJson(res, 400, { ok: false, error });

  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const credentials = {};
  for (const ref of refs) {
    const view = normalizeCredentialView(source[ref]);
    if (view) credentials[ref] = view;
  }
  sendJson(res, 200, { ok: true, credentials });
}

/**
 * POST /api/mobile/v1/credentials/set（token）{ ref, value } → { ok }
 *
 * 值只进不出：成功响应里只有 ok，不回显、不回传宿主的任何值。
 */
async function handleCredentialsSet(ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const ref = normalizeRef(body ? body.ref : undefined);
  if (!ref) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'bad-request', message: '需要 { ref, value }，ref 形如 DEEPSEEK_API_KEY' },
    });
  }
  const value = body && typeof body.value === 'string' ? body.value : '';
  if (!value) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '密钥值不能为空' } });
  }
  if (value.length > CREDENTIAL_MAX_VALUE_CHARS) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'bad-request', message: `密钥值不能超过 ${CREDENTIAL_MAX_VALUE_CHARS} 个字符` },
    });
  }

  const { error } = unwrap(await ctx.apiProxy.credentials.set({
    rpcId: 'mobile',
    method: 'credentials.set',
    payload: { ref, value },
  }));
  if (error) return sendJson(res, 400, { ok: false, error });
  sendJson(res, 200, { ok: true });
}

/** POST /api/mobile/v1/credentials/unset（token）{ ref } → { ok }（宿主对没设过的引用也回 ok）。 */
async function handleCredentialsUnset(ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const ref = normalizeRef(body ? body.ref : undefined);
  if (!ref) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'bad-request', message: '需要 { ref }，ref 形如 DEEPSEEK_API_KEY' },
    });
  }

  const { error } = unwrap(await ctx.apiProxy.credentials.unset({
    rpcId: 'mobile',
    method: 'credentials.unset',
    payload: { ref },
  }));
  if (error) return sendJson(res, 400, { ok: false, error });
  sendJson(res, 200, { ok: true });
}

module.exports = {
  handleCredentialsDescribe,
  handleCredentialsSet,
  handleCredentialsUnset,
  normalizeCredentialView,
  normalizeRef,
};

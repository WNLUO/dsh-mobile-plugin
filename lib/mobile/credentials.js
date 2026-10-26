'use strict';

/**
 * 移动端「宿主凭据」API：把密钥的查看 / 写入 / 清除补齐到手机上。
 *
 * 三条接口只转发宿主的 credentials 域：describe / set / unset。密钥值只在手机 → 宿主这个
 * 方向出现一次，宿主从不回传值，所以响应里永远没有 value。
 *
 * 宿主 describe 回的是平表（键是引用名、值是 `{configured, source?, writable}`），不要再拆
 * 一层；多拆一层会让每个引用都落成「未配置」。能不能写由宿主说了算：环境变量提供的引用回
 * writable:false、set 回 credential-rejected，这里如实透传，让 App 显示宿主原话。
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

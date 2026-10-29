'use strict';

/** Read-only DeepSeek account projection for the mobile app. */

const { sendJson } = require('../shared/http-util');
const { unwrap } = require('./envelope.js');

function readClientMetadata(req) {
  let query;
  try {
    query = new URL(req.url, 'http://127.0.0.1').searchParams;
  } catch {
    return null;
  }
  const version = query.get('version');
  const locale = query.get('locale');
  const timezoneOffset = query.get('timezoneOffsetSeconds');
  const timezoneOffsetSeconds = Number(timezoneOffset);
  if (!version || !locale || timezoneOffset === null || !timezoneOffset.trim() || !Number.isInteger(timezoneOffsetSeconds)) return null;
  return { version, locale, timezoneOffsetSeconds };
}

async function callAccount(ctx, method, payload = {}) {
  try {
    const call = ctx.apiProxy && ctx.apiProxy.account && ctx.apiProxy.account[method];
    if (typeof call !== 'function') return { error: { code: 'host-unavailable' } };
    return unwrap(await call({
      rpcId: 'mobile',
      method: `account.${method}`,
      payload,
    }));
  } catch {
    return { error: { code: 'host-unavailable' } };
  }
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeProfile(result) {
  const profile = result && result.status === 'ready' ? result.value : null;
  if (!profile || typeof profile !== 'object') return { status: 'failed' };
  return {
    status: 'ready',
    name: textOrNull(profile.name),
    contact: textOrNull(profile.contact),
    // 头像是资料的一部分（和名字、联系方式同级），手机拿去当 <Image> 的 uri 用；
    // 账号 ID、token、attempt 仍然不出这一层。
    avatarUrl: textOrNull(profile.avatarUrl),
  };
}

function normalizeWallets(result) {
  if (!result || result.status !== 'ready') return { status: 'failed' };
  const walletsOf = (value) => Array.isArray(value)
    ? value.filter((wallet) => wallet && (wallet.currency === 'CNY' || wallet.currency === 'USD') && typeof wallet.balance === 'string')
      .map((wallet) => ({ currency: wallet.currency, balance: wallet.balance }))
    : [];
  return {
    status: 'ready',
    wallets: walletsOf(result.value),
    bonusWallets: walletsOf(result.bonusWallets),
  };
}

function safeLinks(state) {
  const links = state && state.links;
  return {
    usageUrl: textOrNull(links && links.usageUrl),
    topUpUrl: textOrNull(links && links.topUpUrl),
  };
}

/** GET /api/mobile/v1/deepseek-account — safe account details only; never login state or credentials. */
async function handleDeepSeekAccount(ctx, req, res) {
  const client = readClientMetadata(req);
  if (!client) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'bad-request', message: '需要 version、locale 和 timezoneOffsetSeconds' },
    });
  }

  const stateResult = await callAccount(ctx, 'getState');
  if (stateResult.error) {
    return sendJson(res, 502, {
      ok: false,
      error: { code: stateResult.error.code || 'host-unavailable', message: '这台宿主暂时无法读取 DeepSeek 账号信息' },
    });
  }

  const state = stateResult.value;
  if (!state || (state.status !== 'signed-out' && state.status !== 'credential-stored')) {
    return sendJson(res, 502, {
      ok: false,
      error: { code: 'host-response-invalid', message: '宿主返回的 DeepSeek 账号状态无效' },
    });
  }

  const links = safeLinks(state);
  if (state.status === 'signed-out') {
    return sendJson(res, 200, {
      ok: true,
      status: 'signed-out',
      profile: { status: 'unavailable' },
      balance: { status: 'unavailable' },
      links,
    });
  }

  const [profileResult, balanceResult] = await Promise.all([
    callAccount(ctx, 'getProfile', { client }),
    callAccount(ctx, 'getBalance', { client }),
  ]);
  const profile = normalizeProfile(profileResult.value);
  const balance = normalizeWallets(balanceResult.value);

  return sendJson(res, 200, {
    ok: true,
    status: 'credential-stored',
    profile: profileResult.error ? { status: 'failed' } : profile,
    balance: balanceResult.error ? { status: 'failed' } : balance,
    links,
  });
}

module.exports = { handleDeepSeekAccount, readClientMetadata, normalizeProfile, normalizeWallets, safeLinks };

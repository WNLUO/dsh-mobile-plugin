'use strict';

/**
 * 移动端「这台设备上的移动端插件」自我管理：版本、来源、运行状态、更新与回滚结果。
 *
 * 只管 dsh-mobile-plugin 自己在这台电脑上的版本，不碰电脑上装的全部插件：动别人的插件会把
 * 承载 App 连接的那条链一起带走，而手机没有在电脑前的那双手。判定只有一份真源（外壳的
 * `dshMobilePluginRuntime`），这里只做投影与瘦身。
 *
 * 回滚是宿主自己做的，不是手机按的：装坏了 App 就连不上，那时手机上的回滚按钮发不出去。
 * 外壳装前备份、装完自检，不过就自己退回去；手机只读 `rolledBack` 如实显示，不重新判。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');

/** 一次更新结果的合法状态（外壳给的 `state` 只有这几种取值，别的一律当未知）。 */
const APPLY_STATES = new Set([
  'succeeded',
  'failed',
  'installed-not-swapped',
  'skipped',
  'rolled-back',
  'rolled-back-partial',
]);

/** 来源枚举：与 `update-install.cjs` 的 `declaredSource` 同一份。 */
const SOURCES = new Set(['npm', 'linked', 'file', 'workspace']);

/** 外壳服务；没有它（无头部署 / 实现被直接挂载）就是「这台没有升级能力」。 */
function runtimeOf(ctx) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get('dshMobilePluginRuntime') || null : null;
  } catch {
    return null;
  }
}

function textOrNull(value, max = 200) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

/**
 * 上一轮更新的账：只挑前端要用的几格。
 *
 * 刻意**不带** `check`（注册表原始响应）与 `command`（本机装法命令行）：都不是 App 该显示
 * 的东西，后端那条路由背了同样的规矩。
 */
function applyView(value) {
  if (!value || typeof value !== 'object') return null;
  const failure = value.failure && typeof value.failure === 'object'
    ? {
      code: textOrNull(value.failure.code, 64),
      message: typeof value.failure.message === 'string' ? value.failure.message : '',
    }
    : null;
  return {
    installed: value.installed === true,
    skipped: value.skipped === true,
    state: typeof value.state === 'string' && APPLY_STATES.has(value.state) ? value.state : null,
    beforeVersion: textOrNull(value.beforeVersion, 64),
    installedVersion: textOrNull(value.installedVersion, 64),
    swapped: value.swapped === true,
    retryable: value.retryable === true,
    /**
     * 装上了、但新版装起来之后自检没过，外壳自己退回了上一代。
     *
     * 这是「回滚」在手机端唯一的表达：它不是一颗按钮，是一条已经发生过的事实。
     */
    rolledBack: value.rolledBack === true,
    /** 退回之后跑着的是哪个版本（外壳只在真的退成功时给）。 */
    runningAfterRollback: textOrNull(value.runningAfterRollback, 64),
    failure,
  };
}

/**
 * 这一台的插件现场。
 *
 * `supported` = 有没有可就地换代的外壳。没有外壳时「装了也没法立刻生效」，界面上要说明
 * 清（无头部署 / 源码挂载的机器就是这种）。
 */
function snapshot(ctx) {
  const runtime = runtimeOf(ctx);
  if (!runtime || typeof runtime.status !== 'function') {
    return {
      supported: false,
      runningVersion: null,
      installedVersion: null,
      source: null,
      appliedAt: null,
      lastApply: null,
      shellChanged: false,
      autoUpdate: false,
      autoIntervalMs: null,
    };
  }
  let raw = {};
  try {
    raw = runtime.status() || {};
  } catch {
    raw = {};
  }
  const source = textOrNull(raw.source, 32);
  return {
    supported: typeof runtime.apply === 'function',
    runningVersion: textOrNull(raw.version, 64),
    installedVersion: textOrNull(raw.installedVersion, 64),
    source: source && SOURCES.has(source) ? source : (source || null),
    appliedAt: textOrNull(raw.appliedAt, 64),
    lastApply: applyView(raw.lastApply),
    /** 这个版本连外壳一起改了：换得掉实现，外壳那部分要等下次启动 DSH。 */
    shellChanged: raw.shellChanged === true,
    autoUpdate: raw.autoUpdate === true,
    autoIntervalMs: typeof raw.autoIntervalMs === 'number' && Number.isFinite(raw.autoIntervalMs) ? raw.autoIntervalMs : null,
  };
}

/** `GET /api/mobile/v1/plugin/self` */
async function handlePluginSelf(ctx, _req, res) {
  sendJson(res, 200, { ok: true, plugin: snapshot(ctx) });
}

/**
 * `POST /api/mobile/v1/plugin/self/auto` —— 自动更新开关（每 10 分钟自己查一次）。
 *
 * 只收布尔：这个开关意味着「没人看着也换掉正在跑的代码」，它必须是一个明确的选择。
 * 给不出外壳（`setAutoUpdate` 不在）时回 409，不假装已经打开 —— 开了却什么都不做的开关
 * 比没有更糟。
 */
async function handlePluginAuto(ctx, req, res) {
  const runtime = runtimeOf(ctx);
  if (!runtime || typeof runtime.setAutoUpdate !== 'function') {
    return sendJson(res, 409, {
      ok: false,
      error: {
        code: 'plugin_auto_unavailable',
        message: '这台宿主没有可就地换代的插件外壳，自动更新开不了；请在电脑上更新后重启 DSH',
      },
    });
  }
  let body = {};
  try {
    body = (await readJsonBody(req, 4 * 1024)) || {};
  } catch {
    body = {};
  }
  if (typeof body.enabled !== 'boolean') {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'enabled 必须是布尔值' } });
  }
  try {
    const enabled = runtime.setAutoUpdate(body.enabled);
    return sendJson(res, 200, { ok: true, plugin: { ...snapshot(ctx), autoUpdate: enabled === true } });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: { code: 'write-failed', message: `开关没写进去：${error?.message || error}` },
    });
  }
}

module.exports = {
  handlePluginSelf,
  handlePluginAuto,
  snapshot,
  applyView,
  APPLY_STATES,
  SOURCES,
};

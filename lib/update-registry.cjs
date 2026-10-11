'use strict';

/**
 * 「有没有新版」由插件自己回答：直接问 npm 注册表（`<registry>/<name>/latest`）。
 *
 * ## 为什么不再借道 DSH 插件市场
 *
 * 更新其实分两件事：**查**（线上最新是几、这台机器上是几）和**装**（在 profile 里跑依赖
 * 安装、再把运行中的实现换掉）。装只能交给市场 —— 它握着 profile 的依赖树、版本核验与
 * 回滚点，插件自己再 shell 出去装一遍等于把那些抄一遍，而抄漏一处就是「装了个不是最新
 * 的版本」。但**查**不需要市场：这是个公开的 npm 包，一个 GET 就够了。
 *
 * 绕市场的代价很具体：市场（另一个插件）没装、太老或者坏了，「检查更新」就整个答不出来
 * —— 一个插件得另一个插件在场，才能告诉你自己有没有新版。所以这一格拿回来自己做。
 *
 * ## 边界（别把这条读成「更新彻底不依赖市场了」）
 *
 * · 这里**只查不装**：从头到尾不碰 profile、不碰市场、不写盘。装仍然是
 *   `/api/relay/update/apply` 那条路（外壳问市场 → 市场装 → 外壳就地换代）。
 * · `source`（npm / 本地 link / `file:` tgz）只有市场知道 —— 它读的是 profile 里的依赖
 *   声明。所以那一格传进来的是外壳**上次**问市场的结果；市场不在时如实为空，本模块
 *   **不会**为了这一格去敲市场。
 * · 判据是「线上版本严格大于盘上版本」。线上比盘上旧（回滚、本地构建跑在发布前面）一律
 *   报「没有新版」——「这次更新会降级」必须由版本比较判定，不能由「两个号不相等」判定。
 */

/** 默认注册表：官方源。私有镜像 / 测试用 `DSHM_NPM_REGISTRY` 覆盖。 */
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** 本插件的 npm 包名（`package.json` 的 name）。 */
const DEFAULT_NAME = 'dsh-mobile-plugin';

/** 一次查询的上限。查更新是背景动作，宁可如实报「连不上」也不要挂住面板。 */
const REQUEST_TIMEOUT_MS = 8000;

/** 注册表地址（去掉末尾斜杠；空串当没设）。 */
function registryBase(env = process.env) {
  const value = env && typeof env.DSHM_NPM_REGISTRY === 'string' ? env.DSHM_NPM_REGISTRY.trim() : '';
  return value ? value.replace(/\/+$/, '') : DEFAULT_REGISTRY;
}

/**
 * 版本号比较：只认 `x.y.z` 的三段数字，返回正数表示 `a` 比 `b` 新。
 *
 * 与外壳那份（`lib/shell/manager.js` 的 `compareVersion`）**刻意各留一份**：代不许 require
 * 外壳文件（外壳在进程启动时被缓存，代去读它会拿到另一份模块实例，而且换代清 CJS 缓存时
 * 会被连着清掉）。两份都是十几行、语义必须一致：预发布后缀（`-rc.1`）按主段比，缺段补 0。
 */
function compareVersion(a, b) {
  const left = String(a || '0').split('-')[0].split('.').map(Number);
  const right = String(b || '0').split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const l = Number.isFinite(left[i]) ? left[i] : 0;
    const r = Number.isFinite(right[i]) ? right[i] : 0;
    if (l !== r) return l - r;
  }
  return 0;
}

/** 注册表的错误：带上一个稳定 code，路由与面板照着说人话。 */
class RegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
  }
}

/**
 * 问一次「线上最新是几」。
 *
 * `fetchImpl` 注入只为测试（真跑时用全局 fetch）；`timeoutMs` 同理。
 */
async function latestVersion({ base, name = DEFAULT_NAME, fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new RegistryError('registry-unavailable', '这个运行时里没有 fetch，问不了 npm 注册表');
  }
  const url = `${base || registryBase()}/${name}/latest`;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await doFetch(url, { headers: { accept: 'application/json' }, signal: controller ? controller.signal : undefined });
  } catch (error) {
    throw new RegistryError('registry-unreachable', `连不上 npm 注册表：${error && error.message ? error.message : error}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!response || response.ok !== true) {
    const status = response && Number.isFinite(response.status) ? response.status : 0;
    if (status === 404) throw new RegistryError('registry-not-found', `npm 上找不到 ${name}（404）`);
    throw new RegistryError(`registry-http-${status || 'unknown'}`, `npm 注册表返回 HTTP ${status || '未知'}`);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const version = body && typeof body.version === 'string' ? body.version.trim() : '';
  if (!version) throw new RegistryError('registry-bad-response', 'npm 注册表没有给出可读的版本号');
  return version;
}

/**
 * 查一次更新。
 *
 * `installedVersion` 由调用方给（外壳的「盘上版本」，没有外壳时是这一代自己的版本号）；
 * 给不出来时如实返回 `installedVersion: null` + `updateAvailable: false` —— 比不出来就
 * 不喊「有新版」，免得把用户引去装一次什么都没变的更新。
 */
async function checkForUpdate({
  installedVersion = null,
  source = null,
  base,
  name = DEFAULT_NAME,
  fetchImpl,
  timeoutMs = REQUEST_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  const latest = await latestVersion({ base, name, fetchImpl, timeoutMs });
  const installed = typeof installedVersion === 'string' && installedVersion ? installedVersion : null;
  return {
    installedVersion: installed,
    latestVersion: latest,
    updateAvailable: installed !== null && compareVersion(latest, installed) > 0,
    source: typeof source === 'string' && source ? source : null,
    checkedAt: new Date(now()).toISOString(),
  };
}

module.exports = {
  checkForUpdate,
  compareVersion,
  registryBase,
  latestVersion,
  RegistryError,
  DEFAULT_REGISTRY,
  DEFAULT_NAME,
  REQUEST_TIMEOUT_MS,
};

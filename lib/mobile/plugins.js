'use strict';

/**
 * 移动端「插件清单」API：把桌面端 设置 → 插件 的只读快照搬到手机上。
 *
 * 桌面端由 dsh-client-ui-settings-plugin-inventory 渲染：一个可搜索的紧凑卡片列表，
 * 每张卡片用模块短名作标题、用小标签表示有效启停、用彩色圆点表示根 fiber 状态，
 * 展开后展示 Loader 条目 id 与 Cordis 状态；选中该标签页时才懒调用一次
 * `ctx.remote.pluginInventory.list()`，不订阅 Loader 变化（重新打开设置才取新快照）。
 *
 * 关键：这个宿主服务 **不在 apiProxy 上** —— 它是 Typert Remote 服务
 * （dsh-host-plugin-inventory 的 pluginInventory）。手机侧本来就能到它：
 * lib/mobile/sessions.js 早已用 `ctx.get('typertGateway')` 派发 commands.execute，
 * lib/mobile/references.js 通了 fileReferences / sessionReferenceResolver，
 * 这里照搬同一条路。
 *
 * 接口（只转发宿主的部署快照，不做任何加工）：
 *  - GET /api/mobile/v1/plugins → pluginInventory.list
 *
 * 参数：这个方法 **没有声明任何参数**，args 必须是空对象——assertExactArguments
 * 按声明逐位比对，多给一个字段就会被拒。
 *
 * 返回值形状：`gateway.invoke()` 回的是 decode 后的业务结果本体，不是
 * {ok:true,value} 外壳（那层壳是浏览器传输加的，见 lib/mobile/references.js 里的长注释）。
 * pluginInventory.list 声明的是 { entries: […] } 对象，所以 invoke 回来就是这个对象。
 *
 * 语义按宿主原文透传：
 *  - moduleName 是 npm 包名（如 @deepseek-ai/dsh-host-directory-picker-native），
 *    展示用的短名截断属于客户端的事。
 *  - enabled 是「有效启停状态」，和 fiberPhase 不是一回事：停用的条目 fiberPhase 是 null。
 *  - fiberPhase 只有 failed/pending/active/loading/unloading 五种，宿主也可能给 null。
 */

const { sendJson } = require('../shared/http-util');

const PLUGIN_ID_MAX_CHARS = 200;      // entryId 长度上限
const PLUGIN_NAME_MAX_CHARS = 300;    // moduleName 长度上限
const PLUGIN_MAX_ITEMS = 500;         // 手机侧兜底上限（真实宿主是几十条）
const PLUGIN_PHASES = new Set(['failed', 'pending', 'active', 'loading', 'unloading']);

/** 宿主网关；宿主没组合 dsh-api-gateway 时返回 null，调用方回 503。 */
function gatewayOf(ctx) {
  return (ctx.get && ctx.get('typertGateway')) || null;
}

/** 网关缺失/命名空间缺失对客户端是同一件事：宿主这个能力没装。 */
const UNAVAILABLE = Object.freeze({
  code: 'plugin-inventory-unavailable',
  message: '宿主没有组合插件清单服务（dsh-host-plugin-inventory / dsh-api-gateway）',
});

/** 网关自己抛的错（不是业务失败）的文字化。 */
function errorText(error) {
  if (!error) return '未知错误';
  if (typeof error.message === 'string' && error.message) return error.message;
  return String(error);
}

/**
 * 经 typertGateway 取一次插件清单快照。
 *
 * @returns {Promise<{value?: unknown, error?: {code: string, message: string}}>}
 */
async function callInventory(ctx) {
  const gateway = gatewayOf(ctx);
  if (!gateway) return { error: { ...UNAVAILABLE } };
  let result;
  try {
    // 没有声明参数 → args 必须是空对象；这个方法也没声明 cancellation，不能多塞 signal。
    result = await gateway.invoke({ namespace: 'pluginInventory', method: 'list', args: {} });
  } catch (error) {
    // 0.2.0 的网关错误码带 `gateway/` 前缀（dsh-api-gateway/src/types.ts:117-136）；
    // 0.1.x 时期是不带前缀的。两种都认，否则「宿主没装这个服务」的降级分支形同虚设。
    const raw = error && typeof error.code === 'string' ? error.code.replace(/^gateway\//, '') : ''
    const code = raw === 'invocation-unavailable' || raw === 'service-unavailable' || raw === 'method-unavailable'
      ? UNAVAILABLE.code
      : 'plugin-inventory-error';
    return { error: { code, message: errorText(error) } };
  }
  // decode 本体就是 { entries: […] }；另外两种形状只是容错，防宿主以后改成联合。
  if (result && typeof result === 'object') {
    if (result.ok === true) return { value: result.value };
    if (result.ok === false) {
      const raw = result.error && typeof result.error === 'object' ? result.error : {};
      const code = typeof raw.code === 'string' && raw.code ? raw.code : 'plugin-inventory-error';
      return { error: { code, message: errorText(raw) } };
    }
    return { value: result };
  }
  return { error: { code: 'plugin-inventory-error', message: '宿主插件清单返回了意外的结果' } };
}

/** 非空字符串、长度受限，否则 null。 */
function normalizeId(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > max) return null;
  return text;
}

/**
 * 归一化一条清单。entryId 与 moduleName 缺一不可（它们是这张卡的身份与标题）；
 * fiberPhase 不在枚举里就当 null（桌面端也是「无状态点」的处理）。
 */
function normalizePluginEntry(value) {
  if (!value || typeof value !== 'object') return null;
  const entryId = normalizeId(value.entryId, PLUGIN_ID_MAX_CHARS);
  const moduleName = normalizeId(value.moduleName, PLUGIN_NAME_MAX_CHARS);
  if (!entryId || !moduleName) return null;
  const fiberPhase = typeof value.fiberPhase === 'string' && PLUGIN_PHASES.has(value.fiberPhase)
    ? value.fiberPhase
    : null;
  return { entryId, moduleName, enabled: value.enabled === true, fiberPhase };
}

/** 能力缺失 503（客户端据此显示「宿主没装」），其余业务/网关失败 400。 */
function statusOf(error) {
  return error && error.code === UNAVAILABLE.code ? 503 : 400;
}

/**
 * GET /api/mobile/v1/plugins
 * 成功：{ ok:true, items:[{ entryId, moduleName, enabled, fiberPhase }] }
 */
async function handlePlugins(ctx, req, res) {
  const result = await callInventory(ctx);
  if (result.error) return sendJson(res, statusOf(result.error), { ok: false, error: result.error });
  const raw = result.value && Array.isArray(result.value.entries) ? result.value.entries : [];
  const items = [];
  for (const row of raw) {
    const entry = normalizePluginEntry(row);
    if (!entry) continue;
    items.push(entry);
    if (items.length >= PLUGIN_MAX_ITEMS) break;
  }
  sendJson(res, 200, { ok: true, items });
}

module.exports = {
  handlePlugins,
  normalizePluginEntry,
  normalizeId,
  statusOf,
  callInventory,
  PLUGIN_ID_MAX_CHARS,
  PLUGIN_NAME_MAX_CHARS,
  PLUGIN_MAX_ITEMS,
  PLUGIN_UNAVAILABLE: UNAVAILABLE,
};

'use strict';

/**
 * 移动端「宿主设置」API：只读暴露宿主的模型提供方名单与设置命名空间。
 *
 * 桌面端有完整的设置面板（默认模型、提供方配置、凭据是否已设），手机端此前一点都看不到，
 * 只能看到一个「设置」页里全是 App 自己的偏好项。这里先把「看得到」补齐：
 * settings.describe 与 llm.providers 都是只读接口，且宿主自己已经做了脱敏
 * （secrets 只给出 path 与 set，从不返回值），所以可以原样转给手机。
 *
 * 命名空间里的 schema 字段是序列化后的 zod 树（几百个 uid/refs），对手机没有任何用处，
 * 直接丢掉，只保留 value / base / user / applies / revision 与密钥槽。
 *
 * 写入侧（POST /host-settings/mutate）与桌面端同一口径：只走宿主的 settings.mutate，
 * 用「按路径寻址的 op」（set / unset）+ expectedRevision 做乐观并发，绝不整段 replace。
 * 桌面端就是这么写的：dsh-client-ui-settings/lib/client.js 一次只提交一个 op
 * （`settings.mutate({ ns, ops: [op], expectedRevision })`），失败后重新 describe 再重试。
 * 手机上一般一次改好几个字段，所以这里一次收一组 op，但语义与桌面端逐字段提交完全一致。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');
const { unwrap } = require('./sessions.js');

const HOST_SETTINGS_MAX_NAMESPACES = 60; // 命名空间数量上限（避免异常宿主把响应撑爆）
const HOST_SETTINGS_MAX_MODELS_PER_GROUP = 200; // 单个提供方下的模型条数上限
const HOST_SETTINGS_VALUE_DEPTH = 4;     // 值递归深度上限
const HOST_SETTINGS_VALUE_KEYS = 40;     // 每层键/元素数量上限
const HOST_SETTINGS_VALUE_CHARS = 4000;  // 单个字符串长度上限

/**
 * 把任意设置值压成可安全 JSON 传输的形状。
 *
 * 只保留 JSON 原生类型：字符串超长截断、数组/对象限深限宽、函数与 symbol 一律丢弃成 null，
 * bigint 转成字符串（JSON.stringify 遇到 bigint 会直接抛错）。
 */
function boundValue(value, depth = 0) {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === 'string') {
    return value.length > HOST_SETTINGS_VALUE_CHARS ? `${value.slice(0, HOST_SETTINGS_VALUE_CHARS)}…` : value;
  }
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'boolean') return value;
  if (type === 'bigint') return String(value);
  if (Array.isArray(value)) {
    if (depth >= HOST_SETTINGS_VALUE_DEPTH) return [];
    return value.slice(0, HOST_SETTINGS_VALUE_KEYS).map((entry) => boundValue(entry, depth + 1));
  }
  if (type === 'object') {
    if (depth >= HOST_SETTINGS_VALUE_DEPTH) return {};
    const out = {};
    for (const key of Object.keys(value).slice(0, HOST_SETTINGS_VALUE_KEYS)) {
      out[key] = boundValue(value[key], depth + 1);
    }
    return out;
  }
  // function / symbol：设置值里出现这些没有意义，丢掉比抛错好。
  return null;
}

/**
 * 从序列化的 zod 树里读出「这个命名空间的密钥写到哪个凭据引用上」。
 *
 * 宿主把两个标记留在 schema 的 meta 里：`.role('secret')` 标出密钥字段，
 * `.role('credential-ref')` 标出「写着凭据引用名」的那个字段
 * （见 dsh-web-search-deepseek/lib/index.js:240-241 的 apiKey / apiKeyEnv）。
 * settings.describe 的 secrets 槽就是由 role('secret') 生成的，而真正写入时
 * 要用的是 role('credential-ref') 指向字段的值（桌面端也是这么取的：
 * dsh-client-ui-settings-plugins/lib/client.js 的 refOf() 读 snapshot.value.apiKeyEnv）。
 *
 * 这里按同一口径从 schema 推导，不写死任何命名空间；推导不出来就返回 null，
 * 于是 App 不会给没有密钥槽的设置项画密码框。
 */
function credentialRefOf(schema, value) {
  const refs = schema && typeof schema === 'object' && !Array.isArray(schema) ? schema.refs : null;
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) return null;
  const root = refs[String(schema.uid)];
  const dict = root && typeof root === 'object' ? root.dict : null;
  if (!dict || typeof dict !== 'object' || Array.isArray(dict)) return null;

  let refField = '';
  let refDefault = '';
  let secretFields = 0;
  for (const field of Object.keys(dict)) {
    const entry = refs[String(dict[field])];
    const meta = entry && typeof entry === 'object' ? entry.meta : null;
    const role = meta && typeof meta === 'object' ? meta.role : undefined;
    if (role === 'secret') { secretFields += 1; continue; }
    if (role === 'credential-ref' && !refField) {
      refField = field;
      refDefault = typeof meta.default === 'string' ? meta.default.trim() : '';
    }
  }
  // 只认「恰好一个密钥槽」的命名空间：凭据引用是命名空间级的，两个密钥槽共用一个引用
  // 时没法知道该往哪个引用写，宁可让手机端不给入口，也不写错地方。
  if (secretFields !== 1 || !refField) return null;

  const declared = value && typeof value === 'object' && !Array.isArray(value) ? value[refField] : undefined;
  const ref = typeof declared === 'string' && declared.trim() ? declared.trim() : refDefault;
  return ref ? { ref, refField } : null;
}

/**
 * 把 settings.describe 的一条命名空间视图压成手机需要的形状。
 *
 * 畸形条目（没有 ns，或不是对象）返回 null，由调用方过滤掉；settings.describe 的值来自宿主，
 * 但回放/旧版本宿主仍可能给出意外形状，这里不抛错。
 */
function normalizeNamespace(item) {
  if (!item || typeof item !== 'object') return null;
  const ns = typeof item.ns === 'string' ? item.ns.trim() : '';
  if (!ns) return null;

  const secrets = Array.isArray(item.secrets)
    ? item.secrets
      .map((slot) => {
        if (!slot || typeof slot !== 'object') return null;
        const path = Array.isArray(slot.path)
          ? slot.path.filter((part) => typeof part === 'string' && part !== '').join('.')
          : '';
        if (!path) return null;
        // 宿主只给「这个密钥槽是否已设置」，永远不给值；这里保持同一口径。
        return { path, set: slot.set === true };
      })
      .filter(Boolean)
    : [];

  const out = {
    ns,
    value: boundValue(item.value),
    applies: item.applies === 'restart' ? 'restart' : 'live',
    revision: typeof item.revision === 'number' && Number.isFinite(item.revision) ? item.revision : 0,
    secrets,
  };
  if (item.base !== undefined) out.base = boundValue(item.base);
  if (item.user !== undefined) out.user = boundValue(item.user);
  // 只有「宿主确实报了密钥槽」且「schema 里能推导出凭据引用」时才给出引用名；
  // 两者缺一，App 就不该显示写密钥的入口。
  if (secrets.length > 0) {
    const credential = credentialRefOf(item.schema, item.value);
    if (credential) out.credentialRef = credential.ref;
  }
  return out;
}

/** 把 llm.providers 的一条提供方压成手机需要的形状；缺 provider 的条目丢掉。 */
function normalizeProvider(item) {
  if (!item || typeof item !== 'object') return null;
  const provider = typeof item.provider === 'string' ? item.provider.trim() : '';
  if (!provider) return null;
  const displayName = typeof item.displayName === 'string' && item.displayName.trim() ? item.displayName.trim() : provider;
  return { provider, displayName, active: item.active === true };
}

/** GET /api/mobile/v1/host-settings —— 宿主设置命名空间（只读、已脱敏）。 */
async function handleHostSettings(ctx, req, res) {
  // 宿主的 settings.describe 不接受取消信号（apiproxy 的 invoke 也只传 request），故只传信封。
  const { value, error } = unwrap(await ctx.apiProxy.settings.describe({
    rpcId: 'mobile',
    method: 'settings.describe',
    payload: {},
  }));
  if (error) return sendJson(res, 400, { ok: false, error });

  const list = Array.isArray(value && value.namespaces) ? value.namespaces : [];
  const namespaces = list
    .map(normalizeNamespace)
    .filter(Boolean)
    .slice(0, HOST_SETTINGS_MAX_NAMESPACES);

  sendJson(res, 200, {
    ok: true,
    writable: value != null && value.writable === true,
    hasDocument: value != null && value.hasDocument === true,
    namespaces,
  });
}

/** GET /api/mobile/v1/llm/providers —— 宿主的模型提供方名单（只读）。 */
async function handleLlmProviders(ctx, req, res) {
  const { value, error } = unwrap(await ctx.apiProxy.llm.providers({
    rpcId: 'mobile',
    method: 'llm.providers',
    payload: {},
  }));
  if (error) return sendJson(res, 400, { ok: false, error });

  const list = Array.isArray(value && value.providers) ? value.providers : [];
  const providers = list.map(normalizeProvider).filter(Boolean);

  sendJson(res, 200, { ok: true, providers });
}

/** 把 llm.models 的一组渠道压成手机选择器要的形状；没有模型的组丢掉。 */
function normalizeModelGroup(group) {
  if (!group || typeof group !== 'object') return null;
  const provider = typeof group.id === 'string' ? group.id.trim() : '';
  if (!provider) return null;
  const displayName = typeof group.name === 'string' && group.name.trim() ? group.name.trim() : provider;
  const models = (Array.isArray(group.models) ? group.models : [])
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      if (!id) return null;
      const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id;
      return { id, name };
    })
    .filter(Boolean)
    .slice(0, HOST_SETTINGS_MAX_MODELS_PER_GROUP);
  if (models.length === 0) return null;
  return { provider, displayName, models };
}

/**
 * GET /api/mobile/v1/llm/models —— 宿主的模型目录（`llm.models`，与 session 无关）。
 *
 * 与 `/llm/providers` 的区别：那条只说「有哪些提供方 / 哪个在生效」，这条给出每个提供方
 * 下面真正可请求的模型 id。手机上没有活动会话时（比如从 Git 页打开选择器）也能拿到。
 */
async function handleLlmModels(ctx, req, res) {
  const { value, error } = unwrap(await ctx.apiProxy.llm.models({
    rpcId: 'mobile',
    method: 'llm.models',
    payload: {},
  }));
  if (error) return sendJson(res, 400, { ok: false, error });

  const list = Array.isArray(value && value.groups) ? value.groups : [];
  const groups = list.map(normalizeModelGroup).filter(Boolean).slice(0, HOST_SETTINGS_MAX_NAMESPACES);
  sendJson(res, 200, { ok: true, groups });
}

const HOST_SETTINGS_MAX_OPS = 40;   // 一次写入的 op 数量上限
const HOST_SETTINGS_MAX_PATH = 8;   // 单个路径的层数上限

/**
 * 校验一条 op 的路径：非空字符串数组。
 *
 * 空路径等于改整个命名空间，手机端一律不许（要整段替换就得走 settings.replace，
 * 这里不暴露那条路）。上层元素也只接受非空字符串，避免 `[0]` 这种数组下标意外命中。
 */
function normalizePath(path) {
  if (!Array.isArray(path) || path.length === 0 || path.length > HOST_SETTINGS_MAX_PATH) return null;
  const out = [];
  for (const part of path) {
    if (typeof part !== 'string' || part === '') return null;
    out.push(part);
  }
  return out;
}

/**
 * 校验并原样重建 op 列表；任何一条不合法就整批拒绝。
 *
 * `value` 不在这里做类型校验：那是宿主 schema 的活，宿主的 settings-rejected 会带着
 * 具体原因回来，比在这里猜准得多（值也可能就是 undefined）。
 */
function normalizeOps(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > HOST_SETTINGS_MAX_OPS) return null;
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const path = normalizePath(item.path);
    if (!path) return null;
    if (item.op === 'unset') { out.push({ op: 'unset', path }); continue; }
    if (item.op === 'set') { out.push({ op: 'set', path, value: item.value }); continue; }
    return null;
  }
  return out;
}

/**
 * POST /api/mobile/v1/host-settings/mutate（token）
 * { ns, ops: [{op:'set',path:[...],value}|{op:'unset',path:[...]}], expectedRevision? }
 * → { ok, namespace }
 *
 * 乐观并发：把 App 看到的 revision 原样带上，宿主在 revision 不匹配时回
 * `settings-conflict`（details 里有 expected/actual），这里如实透传，App 才能提示
 * 「别处改过了，刷新重试」。写入成功后宿主会回该命名空间的新视图，同样过一遍
 * normalizeNamespace 再给手机。
 */
async function handleHostSettingsMutate(ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const ns = body && typeof body.ns === 'string' ? body.ns.trim() : '';
  if (!ns) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { ns, ops }' } });
  }
  const ops = normalizeOps(body ? body.ops : undefined);
  if (!ops) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'bad-request', message: 'ops 必须是 [{op:"set",path:[…],value}|{op:"unset",path:[…]}] 的非空数组' },
    });
  }
  const expectedRevision = body && typeof body.expectedRevision === 'number' && Number.isInteger(body.expectedRevision) && body.expectedRevision > 0
    ? body.expectedRevision
    : undefined;

  const { value, error } = unwrap(await ctx.apiProxy.settings.mutate({
    rpcId: 'mobile',
    method: 'settings.mutate',
    payload: { ns, ops, ...(expectedRevision === undefined ? {} : { expectedRevision }) },
  }));
  if (error) return sendJson(res, 400, { ok: false, error });

  const namespace = normalizeNamespace(value);
  if (!namespace) {
    return sendJson(res, 400, { ok: false, error: { code: 'internal', message: '宿主没有返回这个设置项的视图' } });
  }
  sendJson(res, 200, { ok: true, namespace });
}

module.exports = {
  handleHostSettings,
  handleHostSettingsMutate,
  handleLlmProviders,
  handleLlmModels,
  boundValue,
  credentialRefOf,
  normalizeNamespace,
  normalizeProvider,
  normalizeOps,
};

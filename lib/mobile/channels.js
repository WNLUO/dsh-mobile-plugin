'use strict';

/**
 * 移动端「渠道管理」API：列出这台宿主上的渠道，并增删「本机自建」那一类。
 *
 * 判据不是「谁建的」，而是这条 provider 在不在 `llm-pi-ai` 的 `providers` 里：在 = 本机配置
 * 的、可增删（设置走 `settings.mutate`，Key 走 `credentials.set` / `unset`）；不在 = 别的
 * 插件提供的、只读，移动端一个写操作都不做。
 *
 * 不读桌面面板另存的那份自建渠道元数据：那是另一个插件的私有状态，两个进程抢同一个文件
 * 只会写出半截。代价是两边列表的标记会对不上，但真源都是 `llm-pi-ai` 的路由表。
 *
 * 获取模型在宿主侧发：渠道端点常常只有这台电脑能直连，这里借宿主 `llm.discoverModels` 问
 * 一次，只回 id 与名字；手机直接发既可能不通，也绕过宿主的协议适配。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');
const { unwrap } = require('./envelope.js');
const { dropSessionModelsForDevice } = require('./session-cache.js');
const { unchangedListBody, revisionOf, stableRevision } = require('../shared/list-revision.js');

/** 自建渠道写在这个命名空间里；桌面端 `src/custom-channels.js` 的 PI_AI_NS 同值。 */
const PI_AI_NS = 'llm-pi-ai';

const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'];

/** 与 pi-ai 的缺省值同值：上游没报的时候，落到这里就是协议层本来会给的那个数。 */
const DEFAULT_CONTEXT_WINDOW = 262144;
const DEFAULT_MAX_TOKENS = 32768;

/** 新模型默认四档全开：空清单在 pi-ai 那边是「明确声明不思考」。 */
const DEFAULT_REASONING = ['low', 'medium', 'high', 'max'];

/**
 * 内置渠道的 provider id（与免费模型插件的 `CHANNEL_PROVIDER_IDS` 同一份名单）。
 *
 * 只用来**占位**：新渠道的 id 撞上已注册的 provider 就会把那条静默顶掉。名单少一个
 * 不报错，只是那个 id 有被占的风险；插件没装时这些 id 本来也不存在，仍一并绕开，
 * 免得日后装上插件才撞。
 */
const RESERVED_PROVIDER_IDS = new Set([
  'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae',
  'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini', 'antigravity',
]);

const MAX_CHANNEL_NAME_CHARS = 60;
/** 渠道 id 的形状：小写字母数字起头、只收连字符（与 `providerIdOf` 的产出同一口径）。 */
const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_MODEL_ID_CHARS = 200;
const MAX_MODELS = 200;
const MAX_BASE_URL_CHARS = 500;
const MAX_KEY_CHARS = 8192;

/** `apiKeyEnv` 的引用名，与桌面端 `credentialRefOf` 逐字一致（同一把 Key 两边都认）。 */
function credentialRefOf(providerId) {
  return `OFM_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_KEY`;
}

/** 渠道名 → 路由 id：小写、连字符、只留 ASCII 字母数字；撞上已占用的就加序号。 */
function providerIdOf(name, taken) {
  const ascii = String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = ascii === '' || /^[0-9]/.test(ascii) ? `route-${ascii}`.replace(/-+$/, '') : ascii;
  const seed = base === '' || base === 'route-' ? 'route' : base;
  if (!taken.has(seed)) return seed;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${seed}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${seed}-${Date.now()}`;
}

/**
 * 只收「协议 + 域名（+ 端口，可带路径）」，末尾斜杠去掉。
 *
 * 与桌面端同一口径：各家 baseURL 约定不统一（有的要把 `/v1` 算进地址），路径留给
 * 协议层或下面的 `/v1` 回退去拼，不在这里猜。
 */
function normalizeBaseUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return { error: '渠道地址不能为空' };
  if (text.length > MAX_BASE_URL_CHARS) return { error: '渠道地址太长' };
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { error: '地址格式不对，需要 http:// 或 https:// 开头' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: '只支持 http / https 地址' };
  }
  if (!parsed.hostname) return { error: '地址里没有主机名' };
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return { url: `${parsed.origin}${pathname === '/' ? '' : pathname}` };
}

/** 模型清单归一：必须至少一条，id 非空且不重复；能力字段缺省按上面那两个常量。 */
function normalizeModels(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { error: '至少要有 1 个模型' };
  if (raw.length > MAX_MODELS) return { error: `模型最多 ${MAX_MODELS} 个` };
  const seen = new Set();
  const models = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') return { error: '模型清单里有畸形条目' };
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (id === '') return { error: '有模型没有填 id' };
    if (id.length > MAX_MODEL_ID_CHARS) return { error: `模型 id 太长：${id.slice(0, 40)}…` };
    if (seen.has(id)) return { error: `模型 id 重复：${id}` };
    seen.add(id);
    const contextWindow = Number(row.contextWindow);
    const maxTokens = Number(row.maxTokens);
    models.push({
      id,
      name: typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, MAX_MODEL_ID_CHARS) : id,
      // 这里**不落缺省值**：留空才分得出「表单没报」与「表单报了一个值」，
      // 编辑时前者要沿用原路由的配置，后者才覆盖。缺省由 profileOf 最后补。
      ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow: Math.trunc(contextWindow) } : {}),
      ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens: Math.trunc(maxTokens) } : {}),
      ...(row.vision === true ? { vision: true } : {}),
    });
  }
  return { models };
}

/**
 * 一条渠道 → pi-ai 的 provider profile。
 *
 * 只写必须显式说的字段，与桌面端 `profileOf` 一致：自建路由没有内置目录，协议必须点名；
 * 思考档位不写就是「不思考」，所以这里给默认四档。
 *
 * 编辑时按已有那一条做基底：手机表单只有名称 / 协议 / 地址 / 模型 id，能力字段不在界面上，
 * 直接按缺省值重写等于改一次名字就把桌面调过的参数全冲掉。同一模型沿用原能力字段，新加的
 * 模型用表单值或缺省，不认识的字段原样带回去。
 */
function profileOf(channel, existing) {
  const previous = new Map();
  for (const model of Array.isArray(existing && existing.models) ? existing.models : []) {
    if (model && typeof model === 'object' && typeof model.id === 'string' && model.id) previous.set(model.id, model);
  }
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  return {
    ...base,
    displayName: channel.name,
    api: channel.protocol,
    baseURL: channel.baseUrl,
    apiKeyEnv: credentialRefOf(channel.id),
    models: channel.models.map((model) => {
      const before = previous.get(model.id);
      const contextWindow = Number(model.contextWindow) > 0
        ? Math.trunc(model.contextWindow)
        : (Number(before && before.contextWindow) > 0 ? Math.trunc(before.contextWindow) : DEFAULT_CONTEXT_WINDOW);
      const maxTokens = Number(model.maxTokens) > 0
        ? Math.trunc(model.maxTokens)
        : (Number(before && before.maxTokens) > 0 ? Math.trunc(before.maxTokens) : DEFAULT_MAX_TOKENS);
      return {
        id: model.id,
        // 表单没带名字时 normalizeModels 会拿 id 顶上；那条路由原来有显示名就沿用，
        // 别因为一次「只改了地址」把桌面那边起好的名字冲成 id。
        name: model.name && model.name !== model.id
          ? model.name
          : (before && typeof before.name === 'string' && before.name.trim() ? before.name : model.name),
        contextWindow,
        maxTokens,
        input: model.vision === true
          ? ['text', 'image']
          : (Array.isArray(before && before.input) ? before.input : ['text']),
        // 保留 `false`（「明确不思考」）也是有效值，不能当缺省吞掉。
        reasoningEfforts: before && before.reasoningEfforts !== undefined
          ? before.reasoningEfforts
          : Object.fromEntries(DEFAULT_REASONING.map((level) => [level, level])),
      };
    }),
  };
}

/** 从 `settings.describe` 的 `llm-pi-ai` 视图里取 providers 字典；形状不对就当空表。 */
function piAiProvidersOf(value) {
  const providers = value && typeof value === 'object' && !Array.isArray(value) ? value.providers : null;
  return providers && typeof providers === 'object' && !Array.isArray(providers) ? providers : {};
}

/** 一条 pi-ai 路由 → 手机要的形状；畸形条目丢掉。 */
function customChannelOf(id, profile) {
  if (typeof id !== 'string' || id === '') return null;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
  const models = (Array.isArray(profile.models) ? profile.models : [])
    .map((model) => {
      if (!model || typeof model !== 'object') return null;
      const modelId = typeof model.id === 'string' ? model.id.trim() : '';
      if (!modelId) return null;
      return { id: modelId, name: typeof model.name === 'string' && model.name.trim() ? model.name.trim() : modelId };
    })
    .filter(Boolean);
  return {
    id,
    name: typeof profile.displayName === 'string' && profile.displayName.trim() ? profile.displayName.trim() : id,
    protocol: typeof profile.api === 'string' ? profile.api : '',
    baseUrl: typeof profile.baseURL === 'string' ? profile.baseURL : '',
    models,
  };
}

/**
 * GET /api/mobile/v1/channels —— 这台宿主的渠道清单（自建 + 插件提供）。
 *
 * 三处宿主读数各管一段：`settings.describe` 给自建路由，`llm.providers` 给「哪些 provider
 * 真的存在」，`llm.models` 给每个 provider 下面的模型。合并顺序是「先外部、后自建」——
 * 自建的是用户刚动手的那几条，放后面不容易被一长串插件渠道挤到视口之外。
 */
async function handleChannels(ctx, req, res) {
  const settings = unwrap(await ctx.apiProxy.settings.describe({
    rpcId: 'mobile',
    method: 'settings.describe',
    payload: {},
  }));
  if (settings.error) return sendJson(res, 400, { ok: false, error: settings.error });
  const namespaces = Array.isArray(settings.value && settings.value.namespaces) ? settings.value.namespaces : [];
  const piAi = namespaces.find((entry) => entry && entry.ns === PI_AI_NS);
  const providers = piAiProvidersOf(piAi && piAi.value);

  const listed = unwrap(await ctx.apiProxy.llm.providers({
    rpcId: 'mobile',
    method: 'llm.providers',
    payload: {},
  }));
  const catalog = unwrap(await ctx.apiProxy.llm.models({
    rpcId: 'mobile',
    method: 'llm.models',
    payload: {},
  }));
  const registered = listed.error ? [] : (Array.isArray(listed.value && listed.value.providers) ? listed.value.providers : []);
  const groups = catalog.error ? [] : (Array.isArray(catalog.value && catalog.value.groups) ? catalog.value.groups : []);

  const modelsOf = new Map();
  for (const group of groups) {
    if (!group || typeof group.id !== 'string') continue;
    const models = (Array.isArray(group.models) ? group.models : [])
      .map((model) => (model && typeof model.id === 'string' && model.id !== ''
        ? { id: model.id, name: typeof model.name === 'string' && model.name.trim() ? model.name.trim() : model.id }
        : null))
      .filter(Boolean);
    modelsOf.set(group.id, models);
  }

  const customIds = Object.keys(providers);
  const refs = customIds.map(credentialRefOf);
  let keyState = {};
  if (refs.length > 0) {
    const described = unwrap(await ctx.apiProxy.credentials.describe({
      rpcId: 'mobile',
      method: 'credentials.describe',
      payload: { refs },
    }));
    if (!described.error && described.value && typeof described.value === 'object') keyState = described.value;
  }

  const channels = [];
  for (const item of registered) {
    if (!item || typeof item.provider !== 'string' || item.provider === '') continue;
    // 自建路由同样会出现在 llm.providers 里，跳过——下面会以「自建」身份列一次。
    if (Object.prototype.hasOwnProperty.call(providers, item.provider)) continue;
    channels.push({
      id: item.provider,
      source: 'external',
      name: typeof item.displayName === 'string' && item.displayName.trim() ? item.displayName.trim() : item.provider,
      active: item.active === true,
      models: modelsOf.get(item.provider) || [],
    });
  }
  for (const id of customIds) {
    const channel = customChannelOf(id, providers[id]);
    if (!channel) continue;
    const view = keyState[credentialRefOf(id)];
    channels.push({
      ...channel,
      source: 'custom',
      // 凭据那一发失败时不给 keySet：界面按「未知」处理，比谎报「未设置」好。
      ...(view ? { keySet: view.configured === true, writable: view.writable !== false } : {}),
    });
  }

  const body = { ok: true, channels, revision: stableRevision(channels) };
  sendJson(res, 200, unchangedListBody(body, revisionOf(req)) || body);
}

/**
 * 「获取模型」要依次试哪几个 baseURL。
 *
 * OpenAI 系把 `/v1` 算进 baseURL，而表单只收「协议 + 域名」：先照填的问一次，不成就补
 * `/v1`。用户自己写了路径就只问那一个；Anthropic 协议自己会拼 `/v1/models`，不参与回退。
 * 与桌面端 `discoverCandidates` 同一份规则。
 */
function discoverCandidates(baseUrl, protocol) {
  if (protocol === 'anthropic-messages') return [baseUrl];
  let pathname = '/';
  try {
    pathname = new URL(baseUrl).pathname;
  } catch {
    return [baseUrl];
  }
  return pathname === '/' ? [baseUrl, `${baseUrl}/v1`] : [baseUrl];
}

/** 宿主 `llm` 服务可能没装（老运行时）：取不到就走 503，别让整条路由挂掉。 */
function lookupService(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 宿主 `llm.discoverModels` 的失败 → 中文一句（宿主的英文原话留在 `details.hostMessage`）。
 *
 * 宿主的原话是英文（`could not reach …`、`… answered 401; check the API key`），而 App 那边
 * 规定英文原话不上界面（`services/http` 的 `unwrapResult` 会整句换成「电脑那边出了错，请重试」），
 * 「连不上地址」与「Key 不对」在手机上就分不出来。所以在这一层按已经见到的几种形状换成中文：
 * App 拿到的原话是中文就照原样显示，用户读得到下一步该干什么。
 */
function discoverFailureMessage(caught) {
  const raw = caught && typeof caught.message === 'string' ? caught.message : String(caught == null ? '' : caught);
  const code = caught && typeof caught.code === 'string' ? caught.code : '';
  if (/could not reach/i.test(raw)) return '连不上这个地址：确认地址没写错，也确认这台电脑访问得到它';
  const answered = /answered (\d{3})/i.exec(raw);
  if (answered) {
    const status = answered[1];
    if (status === '401' || status === '403') return '这个地址要求鉴权：Key 不对或者没填';
    return `这个地址没有模型清单这个接口（HTTP ${status}），检查地址有没有多写路径`;
  }
  if (/did not answer with JSON/i.test(raw)) return '这个地址回的不是模型清单，可能填成了网页地址';
  if (/no model listing this build can read/i.test(raw)) return '这条协议取不到模型清单，手动填模型 id 吧';
  if (/no credential for provider route/i.test(raw) || /API key is blank/i.test(raw)) {
    return '这条渠道在这台电脑上没有可用的 Key，填一次 Key 再获取';
  }
  return `取模型失败${code ? `（${code}）` : ''}`;
}

/**
 * POST /api/mobile/v1/channels/discover（token）{ id?, protocol, baseUrl, apiKey? }
 * → { ok, models: [{id,name,contextWindow?,maxTokens?,vision?}], baseUrl }
 *
 * `baseUrl` 回的是**问通的那个**：`/v1` 回退成功时保存要写它，否则聊天请求还会打到
 * 刚才失败的那个地址上。只读不落盘，用户确认清单之后再调 `/channels/save`。
 *
 * `id` 是编辑中的那条渠道：宿主按路由名就能在「请求没带 Key」时自己去凭据库取原来那把
 * （`discoverModels` 的 `provider`），所以表单里 Key 留空也能取模型。新建时没有 id，
 * 沿用当场填的那把。
 */
async function handleChannelDiscover(ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const protocol = body && typeof body.protocol === 'string' ? body.protocol.trim() : '';
  if (!PROTOCOLS.includes(protocol)) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '端点类型不认识' } });
  }
  const base = normalizeBaseUrl(body ? body.baseUrl : undefined);
  if (base.error) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: base.error } });
  const editingId = body && typeof body.id === 'string' ? body.id.trim() : '';
  if (editingId !== '' && !CHANNEL_ID_PATTERN.test(editingId)) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '渠道 id 不合法' } });
  }
  const apiKey = body && typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (apiKey.length > MAX_KEY_CHARS) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'API Key 太长' } });
  }

  const llm = lookupService(ctx, 'llm');
  if (!llm || typeof llm.discoverModels !== 'function') {
    return sendJson(res, 503, {
      ok: false,
      error: { code: 'unsupported', message: '这台宿主不支持代取模型清单，请升级电脑上的 DSH' },
    });
  }

  let lastError;
  for (const baseURL of discoverCandidates(base.url, protocol)) {
    try {
      const found = await llm.discoverModels(PI_AI_NS, {
        ...(editingId === '' ? {} : { provider: editingId }),
        baseURL,
        api: protocol,
        ...(apiKey === '' ? {} : { apiKey }),
      });
      const models = (Array.isArray(found) ? found : [])
        .map((row) => {
          if (!row || typeof row !== 'object') return null;
          const id = typeof row.id === 'string' ? row.id.trim() : '';
          if (!id) return null;
          const contextWindow = Number(row.contextWindow);
          const maxTokens = Number(row.maxTokens);
          return {
            id,
            name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : id,
            ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow: Math.trunc(contextWindow) } : {}),
            ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens: Math.trunc(maxTokens) } : {}),
            ...(row.vision === true ? { vision: true } : {}),
          };
        })
        .filter(Boolean)
        .slice(0, MAX_MODELS);
      return sendJson(res, 200, { ok: true, baseUrl: baseURL, models });
    } catch (caught) {
      lastError = caught;
    }
  }
  // 失败说人话：宿主那几句英文摆到手机的英文过滤后面会变成「电脑那边出了错」，原文留在 details。
  const hostMessage = String((lastError && lastError.message) || lastError).slice(0, 300);
  const hostCode = lastError && typeof lastError.code === 'string' ? lastError.code : '';
  sendJson(res, 422, {
    ok: false,
    error: {
      code: 'discover-failed',
      message: discoverFailureMessage(lastError),
      details: { hostMessage, ...(hostCode === '' ? {} : { hostCode }) },
    },
  });
}

/** 新建渠道时 id 的占用集合：已注册的 provider + 内置名单 + pi-ai 里已有的每条路由。 */
function takenIdsOf(registered, providers) {
  const taken = new Set(RESERVED_PROVIDER_IDS);
  for (const item of registered) {
    if (item && typeof item.provider === 'string' && item.provider !== '') taken.add(item.provider);
  }
  for (const id of Object.keys(providers)) taken.add(id);
  return taken;
}

/**
 * POST /api/mobile/v1/channels/save（token）
 * { id?, name, protocol, baseUrl, apiKey?, models: [{id, name?, contextWindow?, maxTokens?, vision?}] }
 * → { ok, channel }
 *
 * 带 `id` = 编辑那一条（id 不变、Key 留空表示沿用原来的）；不带 = 新建（Key 必填）。
 * 写 Key → 写路由，两步都成了才回成功；路由写失败就把这一次新写的 Key 清掉，不留孤儿凭据。
 * 路由只能按路径写：整段覆盖会把用户手写的其它路由抹掉。
 */
async function handleChannelSave(ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要渠道表单' } });
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '') return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '渠道名称不能为空' } });
  if (name.length > MAX_CHANNEL_NAME_CHARS) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: `渠道名称最多 ${MAX_CHANNEL_NAME_CHARS} 字` } });
  }
  const protocol = typeof body.protocol === 'string' ? body.protocol.trim() : '';
  if (!PROTOCOLS.includes(protocol)) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '端点类型不认识' } });
  }
  const base = normalizeBaseUrl(body.baseUrl);
  if (base.error) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: base.error } });
  const givenId = typeof body.id === 'string' ? body.id.trim() : '';
  if (givenId !== '' && !CHANNEL_ID_PATTERN.test(givenId)) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '渠道 id 不合法' } });
  }
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  // 新建必须带 Key；编辑留空 = 沿用凭据库里那把（凭据只写不读，所以「原样保留」只能是这个语义）。
  if (apiKey === '' && givenId === '') {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'API Key 不能为空' } });
  }
  if (apiKey.length > MAX_KEY_CHARS) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'API Key 太长' } });
  }
  const normalized = normalizeModels(body.models);
  if (normalized.error) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: normalized.error } });
  }

  const registeredRead = unwrap(await ctx.apiProxy.llm.providers({
    rpcId: 'mobile',
    method: 'llm.providers',
    payload: {},
  }));
  const registered = registeredRead.error ? [] : (Array.isArray(registeredRead.value && registeredRead.value.providers) ? registeredRead.value.providers : []);

  const describe = unwrap(await ctx.apiProxy.settings.describe({
    rpcId: 'mobile',
    method: 'settings.describe',
    payload: {},
  }));
  if (describe.error) return sendJson(res, 400, { ok: false, error: describe.error });
  const namespaces = Array.isArray(describe.value && describe.value.namespaces) ? describe.value.namespaces : [];
  const piAi = namespaces.find((entry) => entry && entry.ns === PI_AI_NS);
  const providers = piAiProvidersOf(piAi && piAi.value);

  // 编辑只认「确实在自建清单里」的那一条：id 是给外部（默认模型、缓存、别的插件）认的，
  // 不能凭一个不存在的 id 在这里凭空建路由。
  if (givenId !== '' && !Object.prototype.hasOwnProperty.call(providers, givenId)) {
    return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '这条渠道不在宿主的自建清单里' } });
  }

  const id = givenId || providerIdOf(name, takenIdsOf(registered, providers));
  const ref = credentialRefOf(id);
  const channel = {
    id,
    name,
    protocol,
    baseUrl: base.url,
    models: normalized.models,
  };
  const previous = givenId === '' ? null : providers[givenId];

  // Key 留空（编辑）就完全不动凭据库：写一个空串会把原来那把覆盖掉。
  if (apiKey !== '') {
    const keyWrite = unwrap(await ctx.apiProxy.credentials.set({
      rpcId: 'mobile',
      method: 'credentials.set',
      payload: { ref, value: apiKey },
    }));
    if (keyWrite.error) return sendJson(res, 400, { ok: false, error: keyWrite.error });
  }

  const settingsWrite = unwrap(await ctx.apiProxy.settings.mutate({
    rpcId: 'mobile',
    method: 'settings.mutate',
    payload: { ns: PI_AI_NS, ops: [{ op: 'set', path: ['providers', id], value: profileOf(channel, previous) }] },
  }));
  if (settingsWrite.error) {
    // 只回滚这一次新写的 Key；编辑时没写 Key 就没有可回滚的东西。
    if (apiKey !== '') {
      try {
        await ctx.apiProxy.credentials.unset({ rpcId: 'mobile', method: 'credentials.unset', payload: { ref } });
      } catch { /* 回滚失败不掩盖原始错误 */ }
    }
    return sendJson(res, 400, { ok: false, error: settingsWrite.error });
  }

  // 模型目录是设备级的，缓存却按会话存：这台设备上每个会话的旧目录都得作废。
  dropSessionModelsForDevice(ctx, req);
  sendJson(res, 200, {
    ok: true,
    channel: {
      ...channel,
      source: 'custom',
      // 编辑时没重填 Key：这里不猜它有没有设过，App 保存后会重新拉一次清单拿准的。
      ...(apiKey !== '' ? { keySet: true } : {}),
      writable: true,
    },
  });
}

/**
 * POST /api/mobile/v1/channels/delete（token）{ id } → { ok }
 *
 * 只删 `llm-pi-ai` 里真的存在的那一条：路径写到 `providers.<id>`，不碰别的路由。
 * 先删路由再清 Key——反过来的话路由还在、凭据先没了，中间那一小段时间模型会以
 * 「鉴权失败」的形式出现在选择器里。
 */
async function handleChannelDelete(ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const id = body && typeof body.id === 'string' ? body.id.trim() : '';
  if (!CHANNEL_ID_PATTERN.test(id)) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '渠道 id 不合法' } });
  }

  const describe = unwrap(await ctx.apiProxy.settings.describe({
    rpcId: 'mobile',
    method: 'settings.describe',
    payload: {},
  }));
  if (describe.error) return sendJson(res, 400, { ok: false, error: describe.error });
  const namespaces = Array.isArray(describe.value && describe.value.namespaces) ? describe.value.namespaces : [];
  const piAi = namespaces.find((entry) => entry && entry.ns === PI_AI_NS);
  const providers = piAiProvidersOf(piAi && piAi.value);
  if (!Object.prototype.hasOwnProperty.call(providers, id)) {
    return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '这条渠道不在宿主的自建清单里' } });
  }

  const removed = unwrap(await ctx.apiProxy.settings.mutate({
    rpcId: 'mobile',
    method: 'settings.mutate',
    payload: { ns: PI_AI_NS, ops: [{ op: 'unset', path: ['providers', id] }] },
  }));
  if (removed.error) return sendJson(res, 400, { ok: false, error: removed.error });

  try {
    await ctx.apiProxy.credentials.unset({ rpcId: 'mobile', method: 'credentials.unset', payload: { ref: credentialRefOf(id) } });
  } catch { /* 凭据可能早就不在了；路由已经删掉，别因此把成功报成失败 */ }

  dropSessionModelsForDevice(ctx, req);
  sendJson(res, 200, { ok: true });
}

module.exports = {
  handleChannels,
  handleChannelDiscover,
  handleChannelSave,
  handleChannelDelete,
  credentialRefOf,
  providerIdOf,
  normalizeBaseUrl,
  normalizeModels,
  profileOf,
  discoverCandidates,
  PI_AI_NS,
};

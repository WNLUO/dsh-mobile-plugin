'use strict';

/**
 * 手机侧「DSH 插件市场」的清单服务：读社区精选清单，收窄成 App 要的那一页。
 *
 * 为什么是读社区清单，而不是我们自己的分发系统：这一页装的是**电脑上 DSH 的插件**
 * （npm 包 / GitHub 仓库），社区那份清单（awesome-dsh-plugin.com，另有 jsDelivr 上的镜像
 * 一份）已经把「有哪些、是谁的、多少 star / 下载、图标、截图、能力声明」维护好了——那是
 * 别人的一份公开索引，我们照读即可，没有自己的审核流水线要养。
 *
 * 为什么不在手机上装包、也不自己跑 pnpm：装插件是宿主的活。DSH 里本来就有插件管理器
 * （桌面端 设置 → 插件 那个页面背后的同一个服务），版本兼容检查、依赖脚本授权、失败回滚、
 * 要不要重启才生效，全由它判断。插件侧只把清单削干净、把 `installSpec` 算好，安装动作交给
 * 已有的 `POST /plugin/market/install`。能力面对手机只多「读一份公开 JSON」（外网 GET），
 * 仍然不碰 shell、不碰系统设置、不写任意文件。
 *
 * 三个取舍：
 *  1. **缓存收窄后的结果，不缓存原文**：源清单 14MB / 4MB，缓存原文等于在宿主进程里常驻
 *     十几 MB；收窄后通常是几百 KB 到一两 MB。10 分钟有效，过期重拉。
 *  2. **过期重拉失败不回旧缓存**：清单过期是错误答案，不是降级答案（与 dshmarket 自己的
 *     判据一致）。宁可让手机说「读不到清单」，也不要让它按一周前的数据装一个已经下架的包。
 *  3. **并发只允许一个在飞**：手机切搜索词、翻页会连续打这条接口，每次各拉 14MB 毫无意义。
 *     其余请求等同一个 Promise。
 *
 * 接口：`GET /api/mobile/v1/plugin/catalog`（走 token 守卫），query 见 A3-101。
 * 失败回 `{ ok:false, error:{ code:'catalog-unavailable', message } }`，message 里带上每个源
 * 各自的失败原因（排查时最想知道的是「哪一个源、哪一步坏了」）。
 *
 * 清单里认不出的条目**整条丢弃**：`name` / `owner` / `repo` 缺一、repo 不是
 * `https://github.com/<owner>/<repo>`、或与 owner 不一致，都不是能安装的东西，App 侧不再兜。
 */

const { sendJson } = require('../shared/http-util');

/**
 * 数据源，按顺序试，前一个失败才试下一个。两份清单是社区同一批数据的两条腿：
 * 主源字段全（star / 下载 / 图标 / 截图 / 收录时间），镜像源只剩名字、说明、仓库与版本。
 */
const SOURCES = [
  {
    id: 'awesome',
    url: 'https://awesome-dsh-plugin.com/plugins.json',
    // { categories: { id: {en,zh} }, plugins: [...] }
    format: 'plugins',
  },
  {
    id: 'index',
    url: 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json',
    // { format: 1, metadata: { categories: { id: { title } } }, plugins: [...] }
    format: 'index',
  },
];

/** 缓存有效期：清单一天更新不了几次，10 分钟足够新，也不至于每次翻页都拉 14MB。 */
const CACHE_TTL_MS = 10 * 60 * 1000;
/** 每个源最多试两次：14MB 的 CDN 偶发断流很常见，一次失败不代表源坏了。 */
const ATTEMPTS_PER_SOURCE = 2;
/** 单次拉取的等待上限。14MB 在慢网络上也要留够时间，但绝不能无限等。 */
const FETCH_TIMEOUT_MS = 30 * 1000;

/** 文案每门语言的字数上限（契约：600）。 */
const TEXT_MAX_CHARS = 600;
/** 图标只认 https 绝对地址；截图最多 4 张；能力最多 12 项（契约）。 */
const SCREENSHOTS_MAX = 4;
const CAPABILITIES_MAX = 12;
/** 搜索词上限 100 字，超了截断而不是报错：手机输入框不会让用户数到 100。 */
const Q_MAX_CHARS = 100;
/** 分页：缺省 20 条，最多 60 条一页（手机一屏装不下更多，再大只是白算）。 */
const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 60;

const SORTS = ['downloads', 'stars', 'added', 'name'];
const DIRS = ['asc', 'desc'];
/** 条目没有分类时的落点：它仍会出现在「全部」里，只是不属于任何一颗胶囊。 */
const FALLBACK_CATEGORY = 'other';

/** 一份 `https://github.com/<owner>/<repo>`；允许尾部 `.git` 与多余斜杠，输出统一成干净形状。 */
const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;
/** npm 包名（含 scope）。只有合法名字才当安装目标，否则退回 github: 形态。 */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const NPM_NAME_MAX = 214;
/** 收录日期只认 `YYYY-MM-DD`。 */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 收窄后的缓存：{ source, fetchedAt, fetchedAtWall, items, categories }。 */
let cache = null;
/** 正在飞的那一次拉取；并发请求等它。 */
let inflight = null;
/** 测试注入点：假 fetch 与假时钟。真跑时就是全局 fetch / Date.now。 */
let fetchImpl = null;
let clock = null;

function nowMs() {
  return clock ? clock() : Date.now();
}

function errorText(error) {
  if (!error) return '未知错误';
  if (typeof error.message === 'string' && error.message) return error.message;
  return String(error);
}

/** 非空字符串才收，其余 null；`max` 用来挡掉离谱长的字段。 */
function textOrNull(value, max = 300) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? (max ? text.slice(0, max) : text) : null;
}

/** 只认 https 绝对地址：http 会混合内容、其它协议 App 也画不出来。 */
function httpsOrNull(value, max = 1000) {
  const text = textOrNull(value, max);
  if (!text) return null;
  try {
    return new URL(text).protocol === 'https:' ? text : null;
  } catch {
    return null;
  }
}

/**
 * 双语表：只留「语言 → 非空字符串」的项，每门语言截到 600 字；一项都不剩时是 `null`
 * （不是空对象 —— App 侧据此判断「这条没有文案」）。
 */
function localizedOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [language, text] of Object.entries(value)) {
    const clean = textOrNull(text, TEXT_MAX_CHARS);
    if (clean) out[language] = clean;
  }
  return Object.keys(out).length ? out : null;
}

/** 非负安全整数，否则 null（`stars` 那里再由调用方退成 0）。 */
function countOf(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/** 分类字段可能是字符串或字符串数组，取第一个可用值。 */
function firstString(value) {
  if (typeof value === 'string') return textOrNull(value, 64);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const clean = textOrNull(entry, 64);
      if (clean) return clean;
    }
  }
  return null;
}

/** `https://` 截图数组，最多 4 张。 */
function screenshotsOf(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const url = httpsOrNull(entry);
    if (url && out.length < SCREENSHOTS_MAX) out.push(url);
  }
  return out;
}

/** 能力声明：只留字符串，最多 12 项，重复的不给第二份。 */
function capabilitiesOf(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const name = textOrNull(entry, 64);
    if (name && !out.includes(name) && out.length < CAPABILITIES_MAX) out.push(name);
  }
  return out;
}

/**
 * 仓库地址解析：只认 `https://github.com/<owner>/<repo>`，统一成不带 `.git` / 尾斜杠的形状。
 * 返回 null 表示这条不该进清单。
 */
function parseRepo(value) {
  const text = textOrNull(value, 300);
  if (!text) return null;
  const match = GITHUB_REPO.exec(text);
  if (!match) return null;
  return { owner: match[1], repo: match[2], url: `https://github.com/${match[1]}/${match[2]}` };
}

/**
 * 一条原始记录 → 契约里的 Item；认不出就 null。
 *
 * `raw.owner` 有值时必须与 repo 里的 owner 一致（大小写不敏感）：清单里这两格打架的条目，
 * 装起来只会给人装错仓库。镜像源没有 owner 字段，从仓库地址里解析。
 */
function normalizeItem(raw, sourceId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = textOrNull(raw.name, 200);
  if (!name) return null;
  const repoUrl = sourceId === 'index'
    ? (raw.repository && raw.repository.url)
    : (raw.url || (raw.repository && raw.repository.url));
  const parsed = parseRepo(repoUrl);
  if (!parsed) return null;
  const declaredOwner = textOrNull(raw.owner, 100);
  if (declaredOwner && declaredOwner.toLowerCase() !== parsed.owner.toLowerCase()) return null;

  // 镜像源没有 npm 字段：它的 `name` 就是 npm 包名（契约这么写的）。
  const npm = textOrNull(sourceId === 'index' ? raw.name : raw.npm, NPM_NAME_MAX);
  // 分类：主源在顶层 `category`，镜像源在 `metadata.category`（都可能是字符串或数组）。
  const rawCategory = sourceId === 'index' && raw.metadata ? raw.metadata.category : raw.category;
  const npmValid = npm && NPM_NAME.test(npm) ? npm : null;

  // 版本：主源给 `version`，镜像源给 `versions: [{ version }]` 取第一条。
  const version = textOrNull(
    raw.version || (Array.isArray(raw.versions) && raw.versions[0] && raw.versions[0].version),
    64,
  );

  const stars = countOf(raw.stars);
  const downloads = countOf(raw.downloads);
  const added = textOrNull(raw.added, 32);

  return {
    name,
    owner: parsed.owner,
    repo: parsed.url,
    category: firstString(rawCategory) || FALLBACK_CATEGORY,
    title: localizedOf(raw.title),
    description: localizedOf(raw.description),
    npm: npmValid,
    version,
    stars: stars === null ? 0 : stars,
    downloads,
    icon: httpsOrNull(raw.icon),
    screenshots: screenshotsOf(raw.screenshots),
    capabilities: capabilitiesOf(raw.capabilities),
    // 安装目标是宿主算好的：有合法 npm 名就用它，否则让插件管理器按 GitHub 仓库去装。
    installSpec: npmValid || `github:${parsed.owner}/${parsed.repo}`,
    added: added && DAY_PATTERN.test(added) ? added : null,
  };
}

/**
 * 两份清单的形状差异只在这里抹平：返回 { categories, items }。
 * `items` 已去重（按 `owner/name`，同一份清单里同名同源的两条只留第一条）。
 */
function narrowCatalog(document, source) {
  if (!document || typeof document !== 'object') throw new Error('返回的不是清单 JSON');
  if (source.format === 'index' && document.format !== 1) {
    throw new Error(`清单格式不认识（format=${String(document.format)}）`);
  }
  const plugins = document.plugins;
  if (!Array.isArray(plugins) || plugins.length === 0) throw new Error('清单里没有 plugins 数组');

  // 分类：主源是 `categories: { id: {en,zh} }`，镜像源是 `metadata.categories: { id: { title } }`。
  const rawCategories = source.format === 'index'
    ? (document.metadata && document.metadata.categories)
    : document.categories;
  const categories = [];
  if (rawCategories && typeof rawCategories === 'object' && !Array.isArray(rawCategories)) {
    for (const [id, value] of Object.entries(rawCategories)) {
      const cleanId = textOrNull(id, 64);
      if (!cleanId) continue;
      const title = source.format === 'index'
        ? (localizedOf(value && value.title) || localizedOf(value))
        : localizedOf(value);
      // 分类没写文案时退回 id 当名字：胶囊总得有个字，不能画成空白。
      categories.push({ id: cleanId, title: title || { en: cleanId } });
    }
  }

  const seen = new Set();
  const items = [];
  for (const raw of plugins) {
    const item = normalizeItem(raw, source.id);
    if (!item) continue;
    const key = `${item.owner}/${item.name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  if (items.length === 0) throw new Error('清单里没有一条可用的插件（缺仓库地址或名字）');
  return { categories, items };
}

/** 拉一个源：读 JSON、把表单收窄。抛出的错误由 `loadCatalog` 记进失败原因。 */
async function fetchCatalogDocument(source) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('这个运行时里没有 fetch，拉不了清单');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;
  let response;
  try {
    response = await doFetch(source.url, {
      headers: { accept: 'application/json' },
      signal: controller ? controller.signal : undefined,
    });
  } catch (error) {
    throw new Error(`连不上：${errorText(error)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!response || response.ok !== true) {
    const status = response && Number.isFinite(response.status) ? response.status : 0;
    throw new Error(`HTTP ${status || '未知'}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error('返回的不是 JSON');
  }
}

/**
 * 按顺序试源，每个源最多两次；全挂了抛错，message 是每个源各自的失败原因拼接。
 * 成功时把**收窄后**的结果塞进缓存（不是原文）。
 */
async function fetchCatalog() {
  const failures = [];
  for (const source of SOURCES) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_SOURCE; attempt += 1) {
      try {
        const document = await fetchCatalogDocument(source);
        const { categories, items } = narrowCatalog(document, source);
        const fetchedAt = nowMs();
        cache = {
          source: source.url,
          fetchedAt,
          // 墙钟另存一份：`fetchedAt` 走可注入的时钟（测试用），这一格永远是真实时间。
          fetchedAtWall: Date.now(),
          items,
          categories,
        };
        return cache;
      } catch (error) {
        failures.push(`${source.url} 第 ${attempt} 次：${errorText(error)}`);
      }
    }
  }
  throw new Error(failures.join('；'));
}

/**
 * 取一份可用的收窄结果。
 *
 * - 缓存有效期内直接返回；
 * - 过期 / 没有缓存时拉一次，**失败就抛**（绝不拿旧缓存冒充成功）；
 * - 并发只允许一个在飞：后来者 await 同一个 Promise。
 */
async function loadCatalog() {
  const at = nowMs();
  if (cache && at - cache.fetchedAt >= 0 && at - cache.fetchedAt < CACHE_TTL_MS) return cache;
  if (!inflight) {
    inflight = fetchCatalog().finally(() => { inflight = null; });
  }
  return inflight;
}

/** 搜索词：名字 / 作者 / 仓库名 / 双语标题与说明 / npm 名，大小写不敏感。 */
function matchesQuery(item, needle) {
  if (!needle) return true;
  const haystack = [
    item.name,
    item.owner,
    item.repo,
    item.npm || '',
    ...Object.values(item.title || {}),
    ...Object.values(item.description || {}),
    ...item.capabilities,
  ].join('\n').toLowerCase();
  return haystack.includes(needle);
}

/** 排序值：缺一格时 `null`（排在最后，与 App 侧「缺哪格就不画」一致）。 */
function sortValue(item, sort) {
  if (sort === 'downloads') return item.downloads;
  if (sort === 'stars') return item.stars;
  if (sort === 'added') return item.added;
  return item.name.toLowerCase();
}

/**
 * 比较：null 恒排最后（不管升序降序，都不该让「没有数据」冒到顶上——镜像源本来就没有
 * 下载量，排在前面等于整页被一堆空数字占住）。
 */
function compareItems(a, b, sort, dir) {
  const left = sortValue(a, sort);
  const right = sortValue(b, sort);
  if (left === null && right === null) return compareNames(a, b);
  if (left === null) return 1;
  if (right === null) return -1;
  if (left === right) return compareNames(a, b);
  const order = left < right ? -1 : 1;
  return dir === 'asc' ? order : -order;
}

/** 同值的兜底顺序：名字、再作者。翻页因此是确定性的，不会两页看到同一条。 */
function compareNames(a, b) {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  const ao = a.owner.toLowerCase();
  const bo = b.owner.toLowerCase();
  if (ao !== bo) return ao < bo ? -1 : 1;
  return 0;
}

/** 取整数 query 参数；不是整数就退回缺省。 */
function intParam(raw, fallback) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return fallback;
  return Number.parseInt(raw.trim(), 10);
}

/**
 * query 清洗。排序 / 方向 / 分页的缺省与上限全部照契约；认不出的值退回缺省而不是报错
 * （手机拼错一个参数不该让整页变红，界面上的胶囊本来就只会给合法值）。
 */
function parseQuery(searchParams) {
  const q = textOrNull(searchParams.get('q'), Q_MAX_CHARS) || '';
  const rawCategory = textOrNull(searchParams.get('category'), 64);
  const category = rawCategory && rawCategory !== 'all' ? rawCategory : 'all';
  const rawSort = textOrNull(searchParams.get('sort'), 16);
  const sort = SORTS.includes(rawSort) ? rawSort : 'downloads';
  const rawDir = textOrNull(searchParams.get('dir'), 8);
  const dir = DIRS.includes(rawDir) ? rawDir : (sort === 'name' ? 'asc' : 'desc');
  const offset = intParam(searchParams.get('offset'), 0);
  const limit = Math.min(Math.max(intParam(searchParams.get('limit'), LIMIT_DEFAULT), 1), LIMIT_MAX);
  return { q: q.toLowerCase(), category, sort, dir, offset, limit };
}

/**
 * 把一份收窄结果切成契约要的那一页。
 *
 * `categories` 的 `count` 只受搜索词影响、**不受 `category` 影响**：否则选中一颗胶囊之后
 * 其余胶囊的计数全变 0，界面只能把它们藏起来，用户就再也切不回去了。
 */
function pageOf(catalog, query) {
  const searched = query.q ? catalog.items.filter((item) => matchesQuery(item, query.q)) : catalog.items;

  const counts = new Map();
  for (const item of searched) counts.set(item.category, (counts.get(item.category) || 0) + 1);
  const categories = catalog.categories.map((category) => ({
    id: category.id,
    title: category.title,
    count: counts.get(category.id) || 0,
  }));

  const filtered = query.category === 'all'
    ? searched
    : searched.filter((item) => item.category === query.category);

  const sorted = filtered.slice().sort((a, b) => compareItems(a, b, query.sort, query.dir));

  const items = sorted.slice(query.offset, query.offset + query.limit);
  return {
    source: catalog.source,
    fetchedAt: catalog.fetchedAt,
    total: sorted.length,
    categories,
    items,
    hasMore: query.offset + items.length < sorted.length,
  };
}

/** GET /api/mobile/v1/plugin/catalog */
async function handlePluginCatalog(ctx, req, res) {
  let catalog;
  try {
    catalog = await loadCatalog();
  } catch (error) {
    return sendJson(res, 503, {
      ok: false,
      error: { code: 'catalog-unavailable', message: errorText(error) },
    });
  }
  let query;
  try {
    query = parseQuery(new URL((req && req.url) || '/', 'http://x').searchParams);
  } catch {
    query = parseQuery(new URLSearchParams());
  }
  const page = pageOf(catalog, query);
  sendJson(res, 200, { ok: true, ...page });
}

module.exports = {
  handlePluginCatalog,
  // 纯逻辑（守卫 / 测试直接加载）
  parseQuery,
  pageOf,
  narrowCatalog,
  normalizeItem,
  loadCatalog,
  SOURCES,
  CACHE_TTL_MS,
  LIMIT_DEFAULT,
  LIMIT_MAX,
  Q_MAX_CHARS,
  // 测试注入：假 fetch / 假时钟 / 清缓存（真跑时一个都不该被调用）
  __setFetchForTests(next) { fetchImpl = next || null; },
  __setClockForTests(next) { clock = next || null; },
  __resetForTests() { cache = null; inflight = null; fetchImpl = null; clock = null; },
};

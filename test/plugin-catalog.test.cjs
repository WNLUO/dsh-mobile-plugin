'use strict';

/**
 * 手机侧「DSH 插件市场」清单服务的契约。
 *
 * 钉的是三件事：
 *  1. **两个源都能收窄**：社区主源（plugins.json）与 jsDelivr 镜像（index.json，format 1）
 *     形状不一样，但出去必须是同一个 Item；认不出的条目整条丢，不许带着半条数据进手机。
 *  2. **installSpec 由宿主算好**：有合法 npm 名就用 npm 名，否则 `github:<owner>/<repo>`。
 *     App 直接透传给已有的 `POST /plugin/market/install`，不许自己拼。
 *  3. **缓存与失败语义**：10 分钟内不重发；过期重拉失败**不许**拿旧缓存冒充成功；
 *     并发只允许一次在飞。这条与 dshmarket 自己的判据一致——清单过期是错误答案。
 *
 * 测试驱动真实 handler（`handlePluginCatalog`），假 fetch 由这里注入；不转写实现。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { Readable } = require('node:stream');

const catalog = require('../lib/mobile/plugin-catalog.js');

const {
  handlePluginCatalog,
  parseQuery,
  normalizeItem,
  __setFetchForTests,
  __setClockForTests,
  __resetForTests,
  CACHE_TTL_MS,
  LIMIT_MAX,
} = catalog;

const AWESOME_URL = 'https://awesome-dsh-plugin.com/plugins.json';
const INDEX_URL = 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json';

// ---------------------------------------------------------------------------
// 假宿主：一个按 URL 给答案的 fetch，记录每一次调用
// ---------------------------------------------------------------------------

/** 一份社区主源形状的清单。 */
function awesomeDocument() {
  return {
    categories: {
      ui: { en: 'UI Enhancements', zh: 'UI 增强' },
      workflow: { en: 'Workflow', zh: '工作流' },
      unused: { en: 'Empty', zh: '空的' },
    },
    plugins: [
      {
        name: 'dsh-plan-note',
        owner: '0-0-user',
        url: 'https://github.com/0-0-user/dsh-plan-note',
        category: 'workflow',
        title: { en: 'Plan Note', zh: '计划笔记' },
        description: { en: 'Notes for plans', zh: '给计划做笔记' },
        npm: 'dsh-plan-note',
        version: '0.1.2',
        stars: 12,
        downloads: 686,
        icon: 'https://raw.githubusercontent.com/0-0-user/dsh-plan-note/main/icon.png',
        screenshots: ['https://a.example/1.png', 'http://insecure.example/2.png'],
        capabilities: ['fs-read', 'fs-read', 42],
        added: '2026-10-25',
      },
      {
        name: 'dsh-theme-lab',
        owner: 'alice',
        url: 'https://github.com/alice/dsh-theme-lab.git',
        category: ['ui'],
        title: { en: 'Theme Lab' },
        // 没有 npm 名 → installSpec 退回 github:
        stars: 300,
        downloads: 1200000,
        added: 'not-a-date',
      },
      {
        // 整条丢弃：repo 不是 github
        name: 'bad-repo',
        owner: 'bob',
        url: 'https://gitlab.com/bob/bad-repo',
        npm: 'bad-repo',
      },
      {
        // 整条丢弃：owner 与 repo 打架
        name: 'owner-clash',
        owner: 'carol',
        url: 'https://github.com/dave/owner-clash',
      },
      {
        // 整条丢弃：没有名字
        owner: 'erin',
        url: 'https://github.com/erin/nameless',
      },
    ],
  };
}

/** 一份镜像源形状的清单（format 1）。 */
function indexDocument() {
  return {
    format: 1,
    title: { en: 'DSH Plugin Catalog', zh: 'DSH 插件目录' },
    metadata: {
      categories: {
        ui: { title: { en: 'UI', zh: '界面' } },
        data: { title: { en: 'Data', zh: '数据' } },
      },
    },
    plugins: [
      {
        name: 'dsh-chart',
        title: { en: 'Chart' },
        description: { en: 'Charts in chat', zh: '聊天里画图' },
        repository: { url: 'https://github.com/dan/dsh-chart' },
        metadata: { category: ['data'] },
        versions: [{ version: '0.4.0' }],
      },
      {
        // 坏条目：没有 repository
        name: 'no-repo',
        versions: [{ version: '1.0.0' }],
      },
    ],
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

/**
 * 假 fetch：`routes` 是 URL → 一次或多次的回答（函数或数组）。
 * 记录每次调用，测试据此断言「发了几次请求」。
 */
function makeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (typeof route === 'function') return route(url, calls.length);
    if (Array.isArray(route)) {
      const next = route.shift();
      if (next === undefined) return jsonResponse({}, 500);
      return typeof next === 'function' ? next() : next;
    }
    if (route) return route;
    return jsonResponse({}, 404);
  };
  return { fetchImpl, calls };
}

function makeRes() {
  const res = { status: null, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = JSON.parse(payload); };
  return res;
}

function makeReq(query = '') {
  const req = Readable.from([]);
  req.headers = {};
  req.url = `/api/mobile/v1/plugin/catalog${query ? `?${query}` : ''}`;
  return req;
}

/** 走一次真 handler，返回 { status, body }。 */
async function call(query) {
  const res = makeRes();
  await handlePluginCatalog({}, makeReq(query), res);
  return res;
}

/** 每个用例都从干净状态开始：没有缓存、没有在飞的请求、没有注入。 */
test.beforeEach(() => {
  __resetForTests();
});

test.after(() => {
  __resetForTests();
});

/** 主源可用的标准场景。 */
function serveAwesome() {
  return makeFetch({ [AWESOME_URL]: [jsonResponse(awesomeDocument())] });
}

// ---------------------------------------------------------------------------
// 源 1（plugins.json）
// ---------------------------------------------------------------------------

test('主源收窄：字段逐格对，坏条目整条丢', async () => {
  const { fetchImpl } = serveAwesome();
  __setFetchForTests(fetchImpl);
  // 按名字排，让这一条只看收窄、不看排序（排序另有专门用例）。
  const { status, body } = await call('sort=name&dir=asc');

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.source, AWESOME_URL);
  assert.ok(Number.isSafeInteger(body.fetchedAt) && body.fetchedAt > 0, 'fetchedAt 必须是毫秒时间戳');
  assert.equal(body.items.length, 2, '三条坏条目（gitlab / owner 打架 / 没名字）必须整条丢掉');

  const [note, theme] = body.items;
  assert.deepEqual(note, {
    name: 'dsh-plan-note',
    owner: '0-0-user',
    repo: 'https://github.com/0-0-user/dsh-plan-note',
    category: 'workflow',
    title: { en: 'Plan Note', zh: '计划笔记' },
    description: { en: 'Notes for plans', zh: '给计划做笔记' },
    npm: 'dsh-plan-note',
    version: '0.1.2',
    stars: 12,
    downloads: 686,
    icon: 'https://raw.githubusercontent.com/0-0-user/dsh-plan-note/main/icon.png',
    screenshots: ['https://a.example/1.png'],
    capabilities: ['fs-read'],
    installSpec: 'dsh-plan-note',
    added: '2026-10-25',
  }, '主源第一条要逐格对得上契约里的 Item');

  // 分类是数组时取第一个；`.git` 尾巴被削掉；没有 npm 名走 github:。
  assert.equal(theme.category, 'ui');
  assert.equal(theme.repo, 'https://github.com/alice/dsh-theme-lab');
  assert.equal(theme.npm, null);
  assert.equal(theme.installSpec, 'github:alice/dsh-theme-lab');
  assert.equal(theme.added, null, '认不出的收录日期给 null，不要原样透出');
  assert.equal(theme.description, null, '没有文案时是 null，不是空对象');
  assert.deepEqual(theme.screenshots, []);
  assert.deepEqual(theme.capabilities, []);
});

test('分类顺序照清单声明，计数为 0 的分类照旧下发（App 自己决定折不折）', async () => {
  const { fetchImpl } = serveAwesome();
  __setFetchForTests(fetchImpl);
  const { body } = await call();

  assert.deepEqual(body.categories.map((category) => category.id), ['ui', 'workflow', 'unused'],
    '顺序必须是清单里的声明顺序');
  assert.deepEqual(body.categories, [
    { id: 'ui', title: { en: 'UI Enhancements', zh: 'UI 增强' }, count: 1 },
    { id: 'workflow', title: { en: 'Workflow', zh: '工作流' }, count: 1 },
    { id: 'unused', title: { en: 'Empty', zh: '空的' }, count: 0 },
  ]);
});

test('字段闸：icon 只认 https、稿图最多 4 张、能力最多 12 项、文案每门截 600 字', () => {
  const long = 'x'.repeat(900);
  const item = normalizeItem({
    name: 'lab',
    owner: 'eve',
    url: 'https://github.com/eve/lab',
    npm: 'lab',
    icon: 'http://insecure.example/icon.png',
    screenshots: ['https://a/1.png', 'https://a/2.png', 'http://a/3.png', 'https://a/4.png', 'https://a/5.png', 'https://a/6.png'],
    capabilities: Array.from({ length: 20 }, (_unused, index) => `cap-${index}`),
    title: { en: long },
    stars: -3,
    downloads: 1.5,
  }, 'awesome');

  assert.equal(item.icon, null, 'http 图标不收（混合内容，App 也画不出来）');
  assert.equal(item.screenshots.length, 4, '截图最多 4 张');
  assert.ok(item.screenshots.every((url) => url.startsWith('https://')), '非 https 的截图要滤掉');
  assert.equal(item.capabilities.length, 12, '能力最多 12 项');
  assert.equal(item.title.en.length, 600, '每门语言截到 600 字');
  assert.equal(item.stars, 0, 'stars 不是非负安全整数时退成 0');
  assert.equal(item.downloads, null, 'downloads 不是非负安全整数时是 null（不冒充 0）');
});

// ---------------------------------------------------------------------------
// 源 2（index.json，format 1）
// ---------------------------------------------------------------------------

test('主源两次都挂才换镜像源；镜像源的形状也收窄得对', async () => {
  const { fetchImpl, calls } = makeFetch({
    // 主源两次都失败（契约：每个源最多试两次）
    [AWESOME_URL]: [jsonResponse({}, 502), jsonResponse({}, 503)],
    [INDEX_URL]: [jsonResponse(indexDocument())],
  });
  __setFetchForTests(fetchImpl);
  const { status, body } = await call();

  assert.equal(status, 200, '主源挂了、镜像源活着 → 仍然成功');
  assert.equal(body.source, INDEX_URL);
  assert.deepEqual(calls, [AWESOME_URL, AWESOME_URL, INDEX_URL], '主源必须试两次，才轮到镜像源');

  assert.equal(body.items.length, 1, '镜像源里没 repository 的那条要丢');
  const item = body.items[0];
  assert.equal(item.name, 'dsh-chart');
  assert.equal(item.owner, 'dan', 'owner 从 repository.url 解析');
  assert.equal(item.repo, 'https://github.com/dan/dsh-chart');
  assert.equal(item.version, '0.4.0', 'version 取 versions[0]');
  assert.equal(item.npm, 'dsh-chart', '镜像源把 name 当 npm 名');
  assert.equal(item.installSpec, 'dsh-chart');
  assert.equal(item.category, 'data', 'metadata.category 是数组时取第一个');
  assert.equal(item.icon, null);
  assert.deepEqual(item.screenshots, [], '镜像源本来就没有截图 / 下载量 / star');
  assert.equal(item.downloads, null);
  assert.equal(item.stars, 0);
  assert.equal(item.added, null);
  assert.deepEqual(body.categories, [
    { id: 'ui', title: { en: 'UI', zh: '界面' }, count: 0 },
    { id: 'data', title: { en: 'Data', zh: '数据' }, count: 1 },
  ], '镜像源的分类标题在 metadata.categories.<id>.title 里');
});

test('镜像源 format 不是 1 时当成坏清单，继续往后试', async () => {
  const { fetchImpl, calls } = makeFetch({
    [AWESOME_URL]: [jsonResponse({}, 500), jsonResponse({}, 500)],
    [INDEX_URL]: [jsonResponse({ format: 2, plugins: [] })],
  });
  __setFetchForTests(fetchImpl);
  const { status, body } = await call();

  assert.equal(status, 503);
  assert.equal(body.error.code, 'catalog-unavailable');
  assert.equal(calls.length, 4, '两个源各两次，一共四次');
  assert.match(body.error.message, /format=2/, '失败原因里要说清是格式不认识');
});

test('两个源都失败：回 catalog-unavailable，message 把每个源的原因串起来', async () => {
  const { fetchImpl, calls } = makeFetch({
    [AWESOME_URL]: [jsonResponse({}, 502), () => { throw new Error('socket hang up'); }],
    [INDEX_URL]: [jsonResponse({}, 404), jsonResponse({}, 404)],
  });
  __setFetchForTests(fetchImpl);
  const { status, body } = await call();

  assert.equal(status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'catalog-unavailable');
  assert.equal(calls.length, 4);
  // 每个源各自的原因都要在（排查时最先想知道「哪个源、哪一步」）。
  assert.match(body.error.message, new RegExp(AWESOME_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(body.error.message, /HTTP 502/);
  assert.match(body.error.message, /socket hang up/);
  assert.match(body.error.message, new RegExp(INDEX_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(body.error.message, /HTTP 404/);
});

// ---------------------------------------------------------------------------
// query 清洗
// ---------------------------------------------------------------------------

test('query 清洗：缺省、上限、认不出的值退回缺省', () => {
  const defaults = parseQuery(new URLSearchParams());
  assert.deepEqual(defaults, { q: '', category: 'all', sort: 'downloads', dir: 'desc', offset: 0, limit: 20 });

  const clamped = parseQuery(new URLSearchParams('limit=500&offset=-3&sort=banana&dir=sideways&category='));
  assert.equal(clamped.limit, LIMIT_MAX, 'limit 超过 60 要夹回 60');
  assert.equal(clamped.offset, 0, '负数 offset 退回 0');
  assert.equal(clamped.sort, 'downloads', '认不出的排序退回 downloads');
  assert.equal(clamped.dir, 'desc');
  assert.equal(clamped.category, 'all');

  // name 排序缺省方向是 asc（契约）
  assert.equal(parseQuery(new URLSearchParams('sort=name')).dir, 'asc');
  // limit 下限 1，不能是 0（否则 hasMore 永远真、永远翻不动）
  assert.equal(parseQuery(new URLSearchParams('limit=0')).limit, 1);
  // 搜索词截到 100 字
  assert.equal(parseQuery(new URLSearchParams(`q=${'a'.repeat(300)}`)).q.length, 100);
  // 分类与排序/方向按值收
  const kept = parseQuery(new URLSearchParams('q=Theme&category=ui&sort=stars&dir=asc'));
  assert.deepEqual(kept, { q: 'theme', category: 'ui', sort: 'stars', dir: 'asc', offset: 0, limit: 20 });
});

test('搜索：命中名字 / 作者 / 说明都算，且大小写不敏感', async () => {
  const { fetchImpl } = serveAwesome();
  __setFetchForTests(fetchImpl);

  const byName = await call('q=PLAN');
  assert.equal(byName.body.total, 1);
  assert.equal(byName.body.items[0].name, 'dsh-plan-note');

  const byOwner = await call('q=alice');
  assert.equal(byOwner.body.items[0].name, 'dsh-theme-lab');

  const byDescription = await call('q=给计划做笔记');
  assert.equal(byDescription.body.items[0].name, 'dsh-plan-note');

  const none = await call('q=zzzz-nothing');
  assert.equal(none.body.total, 0);
  assert.deepEqual(none.body.items, []);
  assert.equal(none.body.hasMore, false);
});

// ---------------------------------------------------------------------------
// 分页 / 过滤 / 排序
// ---------------------------------------------------------------------------

/** 造 n 条主源条目，下载量递减，分类交替。 */
function manyPlugins(n) {
  const plugins = [];
  for (let index = 0; index < n; index += 1) {
    plugins.push({
      name: `plugin-${String(index).padStart(2, '0')}`,
      owner: 'someone',
      url: `https://github.com/someone/plugin-${String(index).padStart(2, '0')}`,
      category: index % 2 === 0 ? 'ui' : 'workflow',
      npm: `plugin-${String(index).padStart(2, '0')}`,
      downloads: (n - index) * 10,
      stars: index,
    });
  }
  return { categories: { ui: { en: 'UI' }, workflow: { en: 'Workflow' } }, plugins };
}

test('分页：total 是过滤之后的条数，hasMore 跟着 offset + 本页条数走', async () => {
  const { fetchImpl } = makeFetch({ [AWESOME_URL]: [jsonResponse(manyPlugins(7))] });
  __setFetchForTests(fetchImpl);

  const first = await call('limit=3&offset=0');
  assert.equal(first.body.total, 7, 'total 是过滤 + 搜索之后的条数');
  assert.equal(first.body.items.length, 3);
  assert.equal(first.body.hasMore, true);

  const second = await call('limit=3&offset=3');
  assert.equal(second.body.items.length, 3);
  assert.equal(second.body.hasMore, true);
  assert.notDeepEqual(
    second.body.items.map((item) => item.name),
    first.body.items.map((item) => item.name),
    '翻页不能回到同一条',
  );

  const last = await call('limit=3&offset=6');
  assert.equal(last.body.items.length, 1);
  assert.equal(last.body.hasMore, false, '最后一页 hasMore 必须是 false');

  const beyond = await call('limit=3&offset=99');
  assert.deepEqual(beyond.body.items, []);
  assert.equal(beyond.body.hasMore, false);
});

test('分页与排序：下载量降序缺省，名字升序缺省', async () => {
  const { fetchImpl } = makeFetch({ [AWESOME_URL]: [jsonResponse(manyPlugins(4))] });
  __setFetchForTests(fetchImpl);

  const byDownloads = await call('limit=10');
  assert.deepEqual(byDownloads.body.items.map((item) => item.downloads), [40, 30, 20, 10]);

  const byStars = await call('limit=10&sort=stars&dir=desc');
  assert.deepEqual(byStars.body.items.map((item) => item.stars), [3, 2, 1, 0]);

  const byName = await call('limit=10&sort=name');
  assert.deepEqual(byName.body.items.map((item) => item.name), ['plugin-00', 'plugin-01', 'plugin-02', 'plugin-03'],
    'name 排序缺省是升序');
});

test('categories 的计数只受搜索词影响，不受 category 参数影响', async () => {
  const { fetchImpl } = makeFetch({ [AWESOME_URL]: [jsonResponse(manyPlugins(6))] });
  __setFetchForTests(fetchImpl);

  const all = await call('limit=1');
  const ui = await call('limit=1&category=ui');
  const workflow = await call('limit=1&category=workflow');

  // 选中 ui 之后，workflow 那颗胶囊的计数不能变 0（否则用户再也切不回去）。
  assert.deepEqual(
    ui.body.categories,
    all.body.categories,
    'categories 始终是全部、计数与不选分类时一致',
  );
  assert.deepEqual(workflow.body.categories, all.body.categories);
  assert.deepEqual(all.body.categories, [
    { id: 'ui', title: { en: 'UI' }, count: 3 },
    { id: 'workflow', title: { en: 'Workflow' }, count: 3 },
  ]);

  // 但 items / total 确实按分类过滤了。
  assert.equal(ui.body.total, 3);
  assert.ok(ui.body.items.every((item) => item.category === 'ui'));
  assert.equal(workflow.body.total, 3);
});

// ---------------------------------------------------------------------------
// 缓存 / 并发 / 失败语义
// ---------------------------------------------------------------------------

test('缓存命中：10 分钟内不重发请求', async () => {
  const { fetchImpl, calls } = makeFetch({ [AWESOME_URL]: [jsonResponse(awesomeDocument())] });
  __setFetchForTests(fetchImpl);

  const first = await call();
  const second = await call('q=plan');
  const third = await call('limit=5');

  assert.equal(calls.length, 1, '缓存有效期内翻页 / 换搜索词都不该再拉清单');
  assert.equal(first.body.fetchedAt, third.body.fetchedAt, 'fetchedAt 是那份缓存的拉取时间');
  assert.notEqual(second.body.items[0].name, undefined);
});

test('缓存过期：过了 10 分钟就重拉', async () => {
  let now = 1_700_000_000_000;
  __setClockForTests(() => now);
  const { fetchImpl, calls } = makeFetch({
    [AWESOME_URL]: [jsonResponse(awesomeDocument()), jsonResponse(manyPlugins(2))],
  });
  __setFetchForTests(fetchImpl);

  const first = await call();
  assert.equal(first.body.total, 2);

  now += CACHE_TTL_MS - 1;
  const cached = await call();
  assert.equal(calls.length, 1, '差一毫秒还在有效期内');
  assert.equal(cached.body.total, 2);

  now += 2;
  const refreshed = await call();
  assert.equal(calls.length, 2, '过期必须重拉');
  assert.equal(refreshed.body.total, 2);
  assert.notEqual(refreshed.body.items[0].name, 'dsh-plan-note', '拿到的必须是新清单，不是旧缓存');
});

test('过期重拉失败不许拿旧缓存冒充成功', async () => {
  let now = 1_700_000_000_000;
  __setClockForTests(() => now);
  const { fetchImpl } = makeFetch({
    [AWESOME_URL]: [
      jsonResponse(awesomeDocument()),
      // 过期之后两个源各两次全挂
      jsonResponse({}, 502), jsonResponse({}, 502),
    ],
    [INDEX_URL]: [jsonResponse({}, 502), jsonResponse({}, 502)],
  });
  __setFetchForTests(fetchImpl);

  const first = await call();
  assert.equal(first.status, 200, '第一次能拿到清单');

  now += CACHE_TTL_MS + 1;
  const after = await call();
  assert.equal(after.status, 503, '清单过期是错误答案，不是降级答案');
  assert.equal(after.body.error.code, 'catalog-unavailable');
  assert.equal(after.body.items, undefined, '不许把旧缓存当成功结果返回');
});

test('并发只允许一个在飞：连打三次只发一次请求', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { fetchImpl, calls } = makeFetch({
    [AWESOME_URL]: [async () => {
      await gate;
      return jsonResponse(awesomeDocument());
    }],
  });
  __setFetchForTests(fetchImpl);

  const pending = [call(), call('q=plan'), call('limit=5')];
  // 让三个 handler 都走到「等同一个 Promise」那一步，再放开假 fetch。
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  const results = await Promise.all(pending);

  assert.equal(calls.length, 1, '三个并发请求只该拉一次清单');
  assert.ok(results.every((result) => result.status === 200));
  assert.equal(results[0].body.total, 2);
  assert.equal(results[1].body.total, 1);
});

test('拿到的清单空（一条可用的都没有）当成源失败，继续往后试', async () => {
  const { fetchImpl, calls } = makeFetch({
    [AWESOME_URL]: [
      jsonResponse({ categories: {}, plugins: [{ name: 'broken', owner: 'x', url: 'https://example.com/x' }] }),
      jsonResponse({ plugins: 'not-an-array' }),
    ],
    [INDEX_URL]: [jsonResponse(indexDocument())],
  });
  __setFetchForTests(fetchImpl);
  const { status, body } = await call();

  assert.equal(status, 200);
  assert.equal(body.source, INDEX_URL);
  assert.equal(calls.length, 3);
});

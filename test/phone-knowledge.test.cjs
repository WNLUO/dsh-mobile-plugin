'use strict';

/**
 * App 用法知识库的守卫。
 *
 * 知识库坏起来不报错：一份格式错的 frontmatter 只是那一条永远匹配不上，一段写进「先问用户」
 * 的行为规则会和审批层打架却没人发现。所以这里直接读 `knowledge/apps/*.md` 原件，把格式与
 * 内容门槛钉住，再用真模块验匹配与「只附一次」。
 *
 * 运行：node --test test/phone-knowledge.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const knowledge = require('../lib/mobile/phone-knowledge.js');
const routes = require('../lib/mobile/phone/routes.js');

const APPS_DIR = path.join(__dirname, '..', 'knowledge', 'apps');
const SITES_DIR = path.join(__dirname, '..', 'knowledge', 'sites');

/** 合法的站点域名：至少两段、每段字母数字或连字符。 */
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** 正文里禁止出现的行为规则词（这些属于审批层，不属于知识）。 */
const FORBIDDEN_PHRASES = [
  '先问用户',
  '不要付款',
  '必须先',
  '请先',
  '先确认',
  '需要用户确认',
  '让用户确认',
  '征得用户',
  '不要点击',
  '不要操作',
  '必须征得',
  '要问用户',
  '得先问',
];

/** 合法的 Android 包名：至少两段、每段字母开头。 */
const PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i;

/** 读原始 Markdown，抽 frontmatter 文本与正文。守卫用自带解析，不依赖被测实现。 */
function splitRaw(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { front: '', body: text };
  return { front: match[1], body: match[2] || '' };
}

/** 从 frontmatter 文本抽 `key: value`（数组按 JSON 解）。 */
function parseFront(front) {
  const meta = {};
  for (const line of front.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (value.startsWith('[')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = null;
      }
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return meta;
}

/** 知识库目录下的全部 .md 文件。 */
function mdFiles() {
  return fs
    .readdirSync(APPS_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({ name, file: path.join(APPS_DIR, name) }));
}

test('知识库至少有十条起步，且都是 .md', () => {
  const files = mdFiles();
  assert.ok(files.length >= 10, `知识库只有 ${files.length} 条，起步要求 10 条`);
});

test('每份文件 frontmatter 必需字段齐全', () => {
  for (const { name, file } of mdFiles()) {
    const raw = fs.readFileSync(file, 'utf8');
    const { front } = splitRaw(raw);
    assert.ok(front, `${name} 缺 frontmatter`);
    const meta = parseFront(front);
    for (const key of ['name', 'display', 'description', 'packages', 'aliases', 'open', 'pace']) {
      assert.ok(meta[key] !== undefined && meta[key] !== '', `${name} 缺字段 ${key}`);
    }
    assert.ok(Array.isArray(meta.packages) && meta.packages.length > 0, `${name} 的 packages 不是非空数组`);
    assert.ok(Array.isArray(meta.aliases), `${name} 的 aliases 不是数组`);
    assert.ok(meta.name === name.replace(/\.md$/, ''), `${name} 的 name 与文件名不一致`);
  }
});

test('每份文件的正文分四节且不超过 2500 字', () => {
  for (const { name, file } of mdFiles()) {
    const raw = fs.readFileSync(file, 'utf8');
    const { body } = splitRaw(raw);
    const text = body.trim();
    assert.ok(text.length > 0, `${name} 正文为空`);
    assert.ok(text.length <= 2500, `${name} 正文 ${text.length} 字，超过 2500`);
    for (const heading of ['## 是什么', '## 界面', '## 功能', '## 已知现象']) {
      assert.ok(text.includes(heading), `${name} 缺小节「${heading}」`);
    }
  }
});

test('正文里不出现行为规则词', () => {
  for (const { name, file } of mdFiles()) {
    const raw = fs.readFileSync(file, 'utf8');
    const { body } = splitRaw(raw);
    for (const phrase of FORBIDDEN_PHRASES) {
      assert.ok(!body.includes(phrase), `${name} 正文出现行为规则「${phrase}」`);
    }
  }
});

test('包名格式合法，且各文件的包名互不重复', () => {
  const seen = new Map();
  for (const { name, file } of mdFiles()) {
    const { front } = splitRaw(fs.readFileSync(file, 'utf8'));
    const meta = parseFront(front);
    for (const pkg of meta.packages) {
      assert.match(pkg, PACKAGE_RE, `${name} 的包名「${pkg}」不合法`);
      assert.ok(!seen.has(pkg), `包名「${pkg}」同时出现在 ${seen.get(pkg)} 和 ${name}`);
      seen.set(pkg, name);
    }
  }
});

test('listApps 列出全部条目且带 name/display/packages/aliases/open', () => {
  const apps = knowledge.listApps();
  assert.ok(apps.length >= 10);
  for (const app of apps) {
    assert.ok(app.name);
    assert.ok(app.display);
    assert.ok(Array.isArray(app.packages) && app.packages.length > 0);
    assert.ok(Array.isArray(app.aliases));
    assert.equal(typeof app.open, 'string');
    assert.equal(app.body, undefined, 'listApps 不该带正文');
  }
  const names = apps.map((app) => app.name);
  for (const expected of [
    'wechat',
    'douyin',
    'xiaohongshu',
    'bilibili',
    'zhihu',
    'weibo',
    'alipay',
    'taobao',
    'boss-zhipin',
    'android-settings',
  ]) {
    assert.ok(names.includes(expected), `listApps 少了 ${expected}`);
  }
});

test('matchByPackage 命中包名/别名，未命中回空串', () => {
  const wechat = knowledge.matchByPackage('com.tencent.mm');
  assert.ok(wechat.includes('微信'), 'com.tencent.mm 应命中微信');

  assert.ok(knowledge.matchByPackage('com.ss.android.ugc.aweme').includes('抖音'));
  assert.ok(knowledge.matchByPackage('com.xingin.xhs').includes('小红书'));
  assert.ok(knowledge.matchByPackage('tv.danmaku.bili').includes('哔哩哔哩'));
  assert.ok(knowledge.matchByPackage('com.zhihu.android').includes('知乎'));
  assert.ok(knowledge.matchByPackage('com.sina.weibo').includes('微博'));
  assert.ok(knowledge.matchByPackage('com.eg.android.AlipayGphone').includes('支付宝'));
  assert.ok(knowledge.matchByPackage('com.taobao.taobao').includes('淘宝'));
  assert.ok(knowledge.matchByPackage('com.hpbr.bosszhipin').includes('BOSS直聘'));
  assert.ok(knowledge.matchByPackage('com.android.settings').includes('设置'));

  // 别名
  assert.ok(knowledge.matchByPackage('微信').includes('微信'));
  assert.ok(knowledge.matchByPackage('WeChat').includes('微信'));
  assert.ok(knowledge.matchByPackage('B站').includes('哔哩哔哩'));
  // 大小写不敏感
  assert.ok(knowledge.matchByPackage('COM.TENCENT.MM').includes('微信'));

  // 未命中 / 空输入
  assert.equal(knowledge.matchByPackage('com.nonexistent.app'), '');
  assert.equal(knowledge.matchByPackage(''), '');
  assert.equal(knowledge.matchByPackage('   '), '');
  assert.equal(knowledge.matchByPackage(null), '');
});

test('noteFor 同一个对话同一个 App 只附一次', () => {
  knowledge.resetNotes();

  const first = knowledge.noteFor('sess-1', 'com.tencent.mm');
  assert.ok(first.includes('微信'), '第一次应附上微信正文');

  assert.equal(knowledge.noteFor('sess-1', 'com.tencent.mm'), '', '同一对话同一 App 第二次应为空');

  // 换个别名匹配到同一个 App，仍算同一个，不再附
  assert.equal(knowledge.noteFor('sess-1', 'WeChat'), '', '别名命中同一条也算已经附过');

  // 同一对话换一个 App，仍应附
  assert.ok(knowledge.noteFor('sess-1', 'com.sina.weibo').includes('微博'));

  // 另一个对话重新开始
  assert.ok(knowledge.noteFor('sess-2', 'com.tencent.mm').includes('微信'));

  // 未命中 / 没 sessionId
  assert.equal(knowledge.noteFor('sess-1', 'com.nonexistent.app'), '');
  assert.equal(knowledge.noteFor('', 'com.tencent.mm'), '');
});

test('loadDocs 按 mtime 缓存：文件没改就复用同一个对象', () => {
  const first = knowledge.loadDocs();
  const second = knowledge.loadDocs();
  assert.equal(first.length, second.length);
  for (let i = 0; i < first.length; i += 1) {
    assert.equal(first[i], second[i], '同一份缓存条目应复用同一个对象');
  }
});

test('知识库目录不存在时安静退化：返回空，不抛', () => {
  const previous = process.env.DSH_PHONE_KNOWLEDGE_DIR;
  process.env.DSH_PHONE_KNOWLEDGE_DIR = path.join(__dirname, 'no-such-knowledge-dir');
  knowledge.resetCache();
  try {
    assert.deepEqual(knowledge.listApps(), []);
    assert.equal(knowledge.matchByPackage('com.tencent.mm'), '');
    assert.equal(knowledge.noteFor('sess-x', 'com.tencent.mm'), '');
  } finally {
    if (previous === undefined) delete process.env.DSH_PHONE_KNOWLEDGE_DIR;
    else process.env.DSH_PHONE_KNOWLEDGE_DIR = previous;
    knowledge.resetCache();
  }
});

test('知识路由只读：列出 App、包名与命中状态', async () => {
  assert.equal(typeof routes.handlePhoneKnowledge, 'function');
  assert.equal(typeof routes.createPhoneRoutes({}).knowledge, 'function');

  const makeRes = () => {
    const res = {
      writeHead(status, headers) {
        res.status = status;
        res.headers = headers;
      },
      end(body) {
        res.body = String(body);
      },
    };
    return res;
  };

  // 带 package：命中微信
  const hitRes = makeRes();
  await routes.handlePhoneKnowledge(
    {},
    {},
    { url: '/api/mobile/v1/phone/knowledge?package=com.tencent.mm' },
    hitRes,
  );
  assert.equal(hitRes.status, 200);
  const hitPayload = JSON.parse(hitRes.body);
  assert.equal(hitPayload.ok, true);
  assert.equal(hitPayload.matched, 'wechat');
  assert.ok(hitPayload.apps.length >= 10);
  const wechatRow = hitPayload.apps.find((app) => app.name === 'wechat');
  assert.ok(wechatRow);
  assert.equal(wechatRow.hit, true);
  assert.deepEqual(wechatRow.packages, ['com.tencent.mm']);
  assert.equal(hitPayload.apps.filter((app) => app.hit).length, 1, '只应有一条命中');

  // 不带 package：都不命中
  const plainRes = makeRes();
  await routes.handlePhoneKnowledge({}, {}, { url: '/api/mobile/v1/phone/knowledge' }, plainRes);
  const plainPayload = JSON.parse(plainRes.body);
  assert.equal(plainPayload.matched, '');
  assert.equal(plainPayload.apps.filter((app) => app.hit).length, 0);
});

/* ── 网站知识（knowledge/sites） ─────────────────────────────────────────── */

/** 网站知识目录下的全部 .md 文件。 */
function siteFiles() {
  return fs
    .readdirSync(SITES_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({ name, file: path.join(SITES_DIR, name) }));
}

test('网站知识 6 条起步，且都是 .md', () => {
  const files = siteFiles();
  assert.ok(files.length >= 6, `网站知识只有 ${files.length} 条，起步要求 6 条`);
});

test('每份网站知识 frontmatter 必需字段齐全，name 与文件名一致', () => {
  for (const { name, file } of siteFiles()) {
    const { front } = splitRaw(fs.readFileSync(file, 'utf8'));
    assert.ok(front, `${name} 缺 frontmatter`);
    const meta = parseFront(front);
    for (const key of ['name', 'display', 'description', 'sites', 'aliases']) {
      assert.ok(meta[key] !== undefined && meta[key] !== '', `${name} 缺字段 ${key}`);
    }
    assert.ok(Array.isArray(meta.sites) && meta.sites.length > 0, `${name} 的 sites 不是非空数组`);
    assert.ok(Array.isArray(meta.aliases), `${name} 的 aliases 不是数组`);
    assert.equal(meta.name, name.replace(/\.md$/, ''), `${name} 的 name 与文件名不一致`);
  }
});

test('每份网站知识正文分四节且不超过 2500 字', () => {
  for (const { name, file } of siteFiles()) {
    const { body } = splitRaw(fs.readFileSync(file, 'utf8'));
    const text = body.trim();
    assert.ok(text.length > 0, `${name} 正文为空`);
    assert.ok(text.length <= 2500, `${name} 正文 ${text.length} 字，超过 2500`);
    for (const heading of ['## 是什么', '## 界面', '## 功能', '## 已知现象']) {
      assert.ok(text.includes(heading), `${name} 缺小节「${heading}」`);
    }
  }
});

test('网站知识正文里不出现行为规则词', () => {
  for (const { name, file } of siteFiles()) {
    const { body } = splitRaw(fs.readFileSync(file, 'utf8'));
    for (const phrase of FORBIDDEN_PHRASES) {
      assert.ok(!body.includes(phrase), `${name} 正文出现行为规则「${phrase}」`);
    }
  }
});

test('网站域名格式合法且互不重复', () => {
  const seen = new Map();
  for (const { name, file } of siteFiles()) {
    const { front } = splitRaw(fs.readFileSync(file, 'utf8'));
    const meta = parseFront(front);
    for (const site of meta.sites) {
      assert.match(site, DOMAIN_RE, `${name} 的域名「${site}」不合法`);
      assert.ok(!seen.has(site), `域名「${site}」同时出现在 ${seen.get(site)} 和 ${name}`);
      seen.set(site, name);
    }
  }
});

test('listSites 列出全部网站且带 name/display/sites/aliases，不带正文', () => {
  const sites = knowledge.listSites();
  assert.ok(sites.length >= 6);
  const names = sites.map((site) => site.name);
  for (const expected of ['x.com', 'youtube.com', 'github.com', 'bilibili.com', 'zhihu.com', 'xiaohongshu.com']) {
    assert.ok(names.includes(expected), `listSites 少了 ${expected}`);
  }
  for (const site of sites) {
    assert.ok(site.display);
    assert.ok(Array.isArray(site.sites) && site.sites.length > 0);
    assert.ok(Array.isArray(site.aliases));
    assert.equal(site.body, undefined, 'listSites 不该带正文');
  }
});

test('matchBySite 按主机名命中，子域也算，未命中回空串', () => {
  assert.ok(knowledge.matchBySite('https://www.youtube.com/watch?v=abc').includes('YouTube'));
  assert.ok(knowledge.matchBySite('https://m.youtube.com').includes('YouTube'), '子域应命中');
  assert.ok(knowledge.matchBySite('youtube.com').includes('YouTube'), '不带协议也应命中');
  assert.ok(knowledge.matchBySite('https://x.com/home').includes('X'));
  assert.ok(knowledge.matchBySite('https://twitter.com/foo').includes('X'), '旧域名 twitter.com 也应命中 X');
  assert.ok(knowledge.matchBySite('https://github.com/a/b').includes('GitHub'));
  assert.ok(knowledge.matchBySite('https://www.bilibili.com/video/BV1').includes('哔哩哔哩'));
  assert.ok(knowledge.matchBySite('https://www.zhihu.com/question/1').includes('知乎'));
  assert.ok(knowledge.matchBySite('https://www.xiaohongshu.com/explore/1').includes('小红书'));

  assert.equal(knowledge.matchBySite('https://www.example.com'), '');
  assert.equal(knowledge.matchBySite(''), '');
  assert.equal(knowledge.matchBySite(null), '');
});

test('知识路由返回里带 sites 清单', async () => {
  const makeRes = () => {
    const res = {
      writeHead(status, headers) { res.status = status; res.headers = headers; },
      end(body) { res.body = String(body); },
    };
    return res;
  };
  const res = makeRes();
  await routes.handlePhoneKnowledge({}, {}, { url: '/api/mobile/v1/phone/knowledge' }, res);
  const payload = JSON.parse(res.body);
  assert.ok(Array.isArray(payload.sites) && payload.sites.length >= 6, '返回里应有 sites 清单');
  const yt = payload.sites.find((site) => site.name === 'youtube.com');
  assert.ok(yt && yt.sites.includes('youtube.com'));
});

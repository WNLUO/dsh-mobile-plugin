'use strict';

/**
 * 第三方插件自带的扩展：这台电脑的 profile 里**任何一个插件**都可以在自己的包里带一份给手机用的扩展，
 * 不用把包提到本仓库、不用登记进 `extensions/catalog.json`。
 *
 * 声明方式只有一处：插件自己的 `package.json` 里写 `"dshMobileExtensions": "extensions"`
 * （字符串＝包内的相对目录，`true` 等于 `extensions`）。没这一格的插件一概不看 —— 插件包里的
 * `extensions/` 目录名太常见，不声明就扫等于把别人的打包物当成扩展下发。
 *
 * 与随本插件发布那一档（`extension-catalog.js`）的分界：那边是我们审过的、跟着我们的 npm 包走；
 * 这边属于作者自己，作者怎么装插件就怎么装，声明了就能被他自己的手机拉到。审核不在我们这边，
 * 判的是能不能装：入口页、体积与文件数、slug 形状，判不过就不列，不解释原因。
 *
 * 能力面与那两条同一档 —— 只读 profile 里那几个 `node_modules` 子目录，路径全由这里算好，
 * 不接受任意路径，也不写任何东西。
 *
 * 纯 Node，无 cordis 依赖，测试可以直接传假目录。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 插件 `package.json` 里声明「我带了给手机用的扩展」的那一格。 */
const DECL_FIELD = 'dshMobileExtensions';
/**
 * 插件 `package.json` 里声明「我给手机扩展开哪个数据接口」的那一格。
 *
 * 形状是一个数组，每项 `{ service, allow }`：
 *  - `service`：扩展包 `manifest.json` 的 `hostData.service` 要写的那个名字；
 *  - `allow`：允许被够到的路径前缀（以 `/` 开头）。
 *
 * 没有这一格的插件，它的扩展页只能拿基础两项能力，「读宿主数据」那一项即使声明了能力
 * 也找不到服务、一律 404。安全边界不变：目标固定是宿主自己那个 web 端口，不指向任何
 * 外部地址，路径还必须落在 `allow` 里。
 */
const DATA_SERVICES_FIELD = 'dshMobileDataServices';
/** `true` 时读这个目录名。 */
const DEFAULT_DIR = 'extensions';
/** 目录名与 slug 的字符口径，与包内清单那一档一致。 */
const SLUG_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** 暴露给手机的 slug 总长度上限：手机拿它当目录名，长到这份上已经没人读得懂。 */
const SLUG_MAX = 64;

/**
 * 一个插件的声明解析成包内目录；没声明 / 形状不对都返回 null。
 *
 * 只认字符串与 `true`：写成一个数组或对象就开始出现「第二条声明规则」，而这里要的只是
 * 「有没有、在哪」。
 */
function declaredDir(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  const value = manifest[DECL_FIELD];
  if (value === true) return DEFAULT_DIR;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || path.isAbsolute(text)) return null;
  if (text.split(/[\\/]/).includes('..')) return null;
  return text.split(path.sep).join('/');
}

/** 服务名的字符口径：与扩展包 `hostData.service` 那一侧同一套（`host-data.ts`）。 */
const SERVICE_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** 一条声明最多带这么多路径前缀：一个网页界面够用了，几十条已经离谱。 */
const MAX_ALLOW = 32;
/** 单条前缀长度上限。 */
const MAX_ALLOW_PREFIX = 256;

/**
 * 读一个插件 `package.json` 里的数据服务声明。
 *
 * 只认最窄的那种写法：数组，每项一个对象带 `service` 与非空的 `allow` 字符串数组。
 * 任何一项不合规就**只丢那一项**，不因此把整份声明判废 —— 一个手滑的前缀不该让同包
 * 另一个本来能用的服务也一起消失。`service` 撞名的以后扫到的为准由调用方决定（见
 * `discoverDataServices` 的注释：先扫到的优先）。
 *
 * 返回 `[{ service, allow }]`；没声明 / 不是数组一律空数组。
 */
function parseDataServices(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return [];
  const raw = manifest[DATA_SERVICES_FIELD];
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const service = typeof item.service === 'string' ? item.service.trim() : '';
    if (!SERVICE_RE.test(service)) continue;
    if (!Array.isArray(item.allow)) continue;
    const allow = [];
    for (const prefix of item.allow) {
      if (typeof prefix !== 'string') continue;
      const text = prefix.trim();
      if (!text || text.length > MAX_ALLOW_PREFIX) continue;
      // 只认本源绝对路径前缀：整条 URL 或 `//host` 之类的写法会把它变成对外站的跳板。
      if (!text.startsWith('/') || text.startsWith('//')) continue;
      if (allow.includes(text)) continue;
      allow.push(text);
      if (allow.length >= MAX_ALLOW) break;
    }
    if (allow.length === 0) continue;
    out.push({ service, allow });
  }
  return out;
}

/** 包名 → slug 前缀：`@scope/name` 变成 `scope.name`，其余字符削成 `_`。 */
function ownerSlugOf(name) {
  const raw = String(name || '').replace(/^@/, '').replace(/[\\/]+/g, '.');
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[.-]+/, '');
  return cleaned || 'plugin';
}

/**
 * 两家拼成一个 slug：`<插件名>.<扩展目录名>`。
 *
 * 手机拿 slug 当本地目录名，所以必须落进 `SLUG_PATTERN`，也不能与随本插件发布那一档撞。
 * 前缀给足到 64 的上限：插件名过长时先削插件名那一半，扩展目录名那一半原样留着。
 */
function slugOf(ownerSlug, extSlug) {
  const tail = extSlug;
  const room = SLUG_MAX - tail.length - 1;
  if (room < 1) return tail.slice(0, SLUG_MAX);
  return `${ownerSlug.slice(0, room)}.${tail}`;
}

/** 列 profile 的 `node_modules` 里所有**装了**的包目录（含 `@scope/name` 两层）。 */
function installedPackageDirs(pluginsRoot) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(pluginsRoot, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(pluginsRoot, entry.name);
    if (entry.name.startsWith('@')) {
      let scoped;
      try { scoped = fs.readdirSync(full, { withFileTypes: true }); } catch { continue; }
      for (const inner of scoped) {
        if (inner.name.startsWith('.')) continue;
        out.push({ name: `${entry.name}/${inner.name}`, directory: path.join(full, inner.name) });
      }
      continue;
    }
    out.push({ name: entry.name, directory: full });
  }
  return out;
}

/** 读一个包的 `package.json`；读不出 / 不是对象都返回 null。 */
function manifestOf(packageDir) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')); } catch { return null; }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

/**
 * 扫一遍 profile，列出所有「声明了带扩展」的插件里的扩展目录。
 *
 * 返回 `[{ slug, directory, packageName }]`，slug 全局去重（同一个 slug 只认先扫到的那个）。
 * 一个插件的声明目录不存在、不是目录、或 resolve 之后跑到包外面，都不算数 —— 这里只负责
 * 「在哪儿」，包本身合不合规交给 `listThirdParty` 判。
 */
function discoverPackages(pluginsRoot) {
  if (typeof pluginsRoot !== 'string' || !pluginsRoot) return [];
  const found = [];
  const seen = new Set();
  for (const { name, directory } of installedPackageDirs(pluginsRoot)) {
    const manifest = manifestOf(directory);
    const declared = declaredDir(manifest);
    if (!declared) continue;
    let root;
    try { root = fs.realpathSync(directory); } catch { continue; }
    const declaredRoot = path.resolve(root, declared);
    if (declaredRoot !== root && !declaredRoot.startsWith(`${root}${path.sep}`)) continue;
    let stats;
    try { stats = fs.statSync(declaredRoot); } catch { continue; }
    if (!stats.isDirectory()) continue;

    const ownerSlug = ownerSlugOf(typeof manifest.name === 'string' ? manifest.name : name);
    let children;
    try { children = fs.readdirSync(declaredRoot, { withFileTypes: true }); } catch { continue; }
    for (const child of children) {
      if (!child.isDirectory() || child.name.startsWith('.')) continue;
      if (!SLUG_PATTERN.test(child.name)) continue;
      const slug = slugOf(ownerSlug, child.name);
      if (!SLUG_PATTERN.test(slug) || seen.has(slug)) continue;
      seen.add(slug);
      found.push({ slug, directory: path.join(declaredRoot, child.name), packageName: name });
    }
  }
  return found;
}

/**
 * `discoverPackages` 的结果按 slug 再查一次目录（取文件那条路用）。
 *
 * 每次现扫，不缓存：插件是用户随手装 / 卸的，缓存一版就得回答「什么时候失效」，
 * 而这条路上一次扫几十个 `package.json` 而已。
 */
function directoryOf(pluginsRoot, slug) {
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) return null;
  const hit = discoverPackages(pluginsRoot).find((entry) => entry.slug === slug);
  return hit ? hit.directory : null;
}

/**
 * 扫一遍 profile，列出所有插件声明过的**数据服务**。
 *
 * 返回 `[{ service, allow, packageName }]`。同名服务先扫到的优先 —— 与 slug 去重同一套
 * 口径（`installedPackageDirs` 的顺序是稳定的：先顶层包、再按名字），避免两个插件抢同一个
 * 名字时结果随文件系统顺序漂。静态登记表里的服务（magpie）在调用方那一层先查，所以第三方
 * 也不可能把内置那几个名字顶掉。
 */
function discoverDataServices(pluginsRoot) {
  if (typeof pluginsRoot !== 'string' || !pluginsRoot) return [];
  const found = [];
  const seen = new Set();
  // 按包名排一次再扫：`readdirSync` 的顺序不是承诺，同名服务「先扫到的优先」得先有个确定的顺序，
  // 否则重启一次谁赢都可能变。
  const dirs = installedPackageDirs(pluginsRoot).sort((a, b) => a.name.localeCompare(b.name));
  for (const { name, directory } of dirs) {
    const manifest = manifestOf(directory);
    if (!manifest) continue;
    for (const declared of parseDataServices(manifest)) {
      if (seen.has(declared.service)) continue;
      seen.add(declared.service);
      found.push({ service: declared.service, allow: declared.allow, packageName: name });
    }
  }
  return found;
}

module.exports = {
  DECL_FIELD,
  DEFAULT_DIR,
  DATA_SERVICES_FIELD,
  SLUG_PATTERN,
  declaredDir,
  parseDataServices,
  ownerSlugOf,
  slugOf,
  discoverPackages,
  directoryOf,
  discoverDataServices,
};

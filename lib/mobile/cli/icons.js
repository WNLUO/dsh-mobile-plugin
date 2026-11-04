'use strict';

/**
 * CLI 品牌图标：注册表里每条都带一枚官方 SVG（`icon` 字段），这里是它的本地缓存。
 *
 * 为什么放插件侧而不写进 App：清单里有二十来家、还在增加，每一家一枚 SVG 写进 App 就是
 * 每来一家都要发一次版。插件本来就在读那份注册表，顺手把图标存下来，App 只按 id 取。
 *
 * 缓存规则与注册表同一套：内存 → 盘上（`$DSH_HOME/storages/mobile-plugin/acp-icons.json`）
 * → 联网拉。拉不到就空着，App 退回首字母 / 方块 —— 不为此报错。
 *
 * **原样留着那份 SVG，只摘掉尺寸与命名空间**：注册表里的图标有的靠 `fill`（Claude、OpenCode），
 * 有的靠 `stroke`（Agoragentic 那一枚就是圆 + 三条线）。在插件这一层按「只留 path」筛一遍，
 * 描边那几家会整枚消失；颜色也不在这里定 —— App 侧统一把 `currentColor` 换成主题色（见
 * `components/CliLogo`），与 `ModelVendorBadge` 同一个规矩。
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('../../shared/paths');

/** 一次拉取最多等这么久：图标是锦上添花，不该把「列清单」拖住。 */
const FETCH_TIMEOUT_MS = 6000;

/** 一枚图标在缓存里最多留这么久；注册表按小时更新，图标跟着换。 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

let memory = null;

function cacheFile() {
  return path.join(paths.dshHome(), 'storages', 'mobile-plugin', 'acp-icons.json');
}

/**
 * 官方 SVG → App 画得出来的那一份。
 *
 * 去掉 `width` / `height` 与 `xmlns`（尺寸由调用方给），`viewBox` 留着 —— 各家的画布不一样
 * （Claude 是 1200×1200），丢了它图标会被裁掉大半。解析不出 `viewBox` 的按 24×24 处理，
 * 这是 Simple Icons 的通用画布，也是我们内置那四家的。
 */
function normalizeSvg(svg) {
  if (typeof svg !== 'string' || !svg.trim()) return '';
  const open = svg.match(/<svg\b[^>]*>/i);
  if (!open) return '';
  const viewBox = (open[0].match(/viewBox="([^"]+)"/i) || [])[1] || '0 0 24 24';
  const inner = svg
    .slice(open.index + open[0].length)
    .replace(/<\/svg>\s*$/i, '')
    .replace(/<(defs|style|title|desc)\b[\s\S]*?<\/\1>/gi, '')
    .trim();
  if (!inner) return '';
  return `<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    const icons = raw && raw.icons && typeof raw.icons === 'object' ? raw.icons : null;
    if (!icons) return null;
    return { fetchedAt: Number(raw.fetchedAt) || 0, icons };
  } catch {
    return null;
  }
}

function writeCache(icons) {
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify({ fetchedAt: Date.now(), icons }), 'utf8');
  } catch {
    // 写不进去只是下次再拉一遍。
  }
}

/**
 * id → SVG 串。
 *
 * `entries` 是注册表条目（`{ id, icon }`），`want` 是要哪几个 id（空 = 全都要）。
 * 只拉还没缓存过的那些，并发拉完；任何一条失败就当它没有图标。
 */
async function loadIcons(entries, want) {
  const targets = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.icon === 'string' && entry.icon);
  const naming = new Set(Array.isArray(want) ? want : []);
  const picked = (list) => {
    const out = {};
    for (const id of naming.size ? naming : Object.keys(list)) {
      if (list[id]) out[id] = list[id];
    }
    return out;
  };
  if (targets.length === 0) return {};

  const now = Date.now();
  if (!memory || now - memory.at >= TTL_MS) {
    const cached = readCache();
    memory = cached && now - cached.fetchedAt < TTL_MS
      ? { at: cached.fetchedAt, icons: cached.icons }
      : { at: 0, icons: (cached && cached.icons) || {} };
  }
  const icons = { ...memory.icons };
  const todo = targets.filter((entry) => (naming.size === 0 || naming.has(entry.id)) && !icons[entry.id]);
  if (todo.length > 0) {
    const fetched = await Promise.all(todo.map(async (entry) => {
      try {
        const res = await fetch(entry.icon, {
          // 这台 CDN 不认裸 Node 的默认 UA（会回 403）。
          headers: { accept: 'image/svg+xml', 'user-agent': 'dsh-mobile' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return null;
        const svg = normalizeSvg(await res.text());
        return svg ? [entry.id, svg] : null;
      } catch {
        return null;
      }
    }));
    let changed = false;
    for (const pair of fetched) {
      if (!pair) continue;
      icons[pair[0]] = pair[1];
      changed = true;
    }
    if (changed) {
      memory = { at: now, icons };
      writeCache(icons);
    }
  }
  return picked(icons);
}

/** 测试用：清掉内存那一份。 */
function resetIconMemory() {
  memory = null;
}

module.exports = { loadIcons, normalizeSvg, resetIconMemory, cacheFile };

/**
 * 面板的界面语言：**跟着浏览器 / 系统走，不提供手动切换**。
 *
 * 为什么这一页要有自己的字典，而不是沿用 App 那套：面板是电脑上的一个网页（宿主起在
 * `127.0.0.1` 上，浏览器里打开），它跟手机 App 是两个进程、两套构建，共用不了同一份模块。
 * 2026-10-11 曾经因为「整页都是中文语境、为一张卡维护两份字典不划算」删过一次字典；
 * 2026-10-24 海外发布这轮**整页一起做**（正是当时说的「要再国际化就整页一起做」）。
 *
 * 口径与 App 一致（`app/src/i18n/language.ts`）：简中 / 繁中 / 英 / 日 / 韩五门；
 * 认不出的语言落**英文**。中文只一条规则：出现 `hant` / `tw` / `hk` / `mo` 算繁体。
 *
 * 不引第三方库：面板产物是**单文件内联**（`lib/panel/index.html`），多一个运行时依赖
 * 就多几 KB，而这一层只有「查表 + 括号占位符替换」两件事。
 */

export type PanelLanguage = 'zh-Hans' | 'zh-Hant' | 'en' | 'ja' | 'ko'

export const PANEL_LANGUAGES: readonly PanelLanguage[] = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko']

/** 源语言：键集真源，其他语言缺键时回退它。 */
const SOURCE_LANGUAGE: PanelLanguage = 'zh-Hans'

/**
 * 浏览器语言标签 → 我们支持的语言；认不出回 null（调用方落英文）。
 *
 * 接受 BCP 47（`zh-Hant-TW`）与带下划线的老写法（`zh_TW`）。
 * 简体在前：「认成简体」的代价（繁体用户看到简体）比反过来小。
 */
export function normalizeLocale(tag: string): PanelLanguage | null {
  const raw = String(tag ?? '').trim().replace(/_/g, '-').toLowerCase()
  if (!raw) return null
  const parts = raw.split('-')
  const head = parts[0]
  if (head === 'zh') {
    const rest = parts.slice(1)
    return rest.some((p) => p === 'hant' || p === 'tw' || p === 'hk' || p === 'mo') ? 'zh-Hant' : 'zh-Hans'
  }
  if (head === 'en') return 'en'
  if (head === 'ja') return 'ja'
  if (head === 'ko') return 'ko'
  return null
}

/** 当前这门语言。渲染时读它；不需要订阅（换系统语言要重开面板，这是网页的常态）。 */
let current: PanelLanguage | null = null

/** 浏览器给的语言标签列表（拿不到就空）。 */
function navigatorLanguages(): string[] {
  try {
    const nav = typeof navigator === 'undefined' ? null : navigator
    if (!nav) return []
    if (Array.isArray(nav.languages) && nav.languages.length > 0) return nav.languages as string[]
    if (typeof nav.language === 'string' && nav.language) return [nav.language]
  } catch {
    /* 读不到就当没有 */
  }
  return []
}

/**
 * 定下这一页用哪门语言。
 *
 * 按浏览器的语言列表逐个试：第一个认得出的说了算。都不认得出就落英文 —— 与 App 同一条
 * 兜底（系统语言不是我们支持的五种时，英文比中文更有用）。
 */
export function resolvePanelLanguage(): PanelLanguage {
  if (current) return current
  for (const tag of navigatorLanguages()) {
    const hit = normalizeLocale(tag)
    if (hit) { current = hit; return current }
  }
  current = 'en'
  return current
}

/** 当前语言（测试与渲染用）。 */
export function panelLanguage(): PanelLanguage {
  return resolvePanelLanguage()
}

/** 测试用：把语言钉死（面板没有手动切换入口，这个只给守卫）。 */
export function setPanelLanguageForTest(language: PanelLanguage | null): void {
  current = language
}

/** 一张扁平表：键 → 文案。 */
type Table = Record<string, string>

/** 占位符替换：`{name}`；缺参时保留原样（看得出是缺参，而不是少一块字）。 */
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name: string) => {
    const value = params[name]
    if (value === undefined || value === null) return whole
    return String(value)
  })
}

/** 合并各领域文件：后出现的覆盖先前同名键（守卫按前缀查重叠，不会真发生）。 */
export function mergeTables(tables: readonly Table[]): Table {
  const out: Table = {}
  for (const table of tables) Object.assign(out, table)
  return out
}

/** 取一条文案：当前语言 → 源语言 → 键名本身。 */
export function translate(
  messages: Record<PanelLanguage, Table>,
  language: PanelLanguage,
  key: string,
  params?: Record<string, string | number>,
): string {
  const raw = messages[language]?.[key] || messages[SOURCE_LANGUAGE]?.[key]
  if (typeof raw !== 'string' || raw.length === 0) return key
  return interpolate(raw, params)
}

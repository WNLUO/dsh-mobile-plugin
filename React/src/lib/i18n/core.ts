/**
 * 面板的界面语言：缺省跟浏览器 / 系统走，右上角那颗按钮可以手动选一门并记住。
 *
 * 这一页有自己的字典，不沿用 App 那套：面板是电脑上的一个网页（宿主起在 `127.0.0.1` 上），
 * 跟手机 App 是两个进程、两套构建，共用不了同一份模块。
 *
 * 口径与 App 一致（`app/src/i18n/language.ts`）：简中 / 繁中 / 英 / 日 / 韩五门，认不出的
 * 语言落**英文**；中文只一条规则：出现 `hant` / `tw` / `hk` / `mo` 算繁体。
 *
 * 手动选的那一门写进 localStorage 的 `dsh-mobile-panel-language`（按来源隔离，与主题那个键
 * 同一个规矩）。存盘失败（隐私模式、盘满）只影响「下次记不记得」，这一次照样当场生效。
 *
 * 不引第三方库：面板产物是**单文件内联**（`lib/panel/index.html`），这一层只有「查表 +
 * 括号占位符替换」两件事。
 */

export type PanelLanguage = 'zh-Hans' | 'zh-Hant' | 'en' | 'ja' | 'ko'

export const PANEL_LANGUAGES: readonly PanelLanguage[] = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko']

/** 语言自称：一律用该语言自己的写法，**不进字典**（翻译过的语言名没人认得出）。 */
export const LANGUAGE_LABELS: Record<PanelLanguage, string> = {
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
}

/** 源语言：键集真源，其他语言缺键时回退它。 */
const SOURCE_LANGUAGE: PanelLanguage = 'zh-Hans'

/** 手动选择存在这个键里；删掉它等于回到「跟随浏览器」。 */
export const LANGUAGE_STORAGE_KEY = 'dsh-mobile-panel-language'

/** 用户的选择：跟随浏览器，或者钉死某一门。 */
export type LanguagePreference = 'system' | PanelLanguage

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
 * 浏览器说的是哪一门。
 *
 * 按语言列表逐个试：第一个认得出的说了算。都不认得出就落英文 —— 与 App 同一条
 * 兜底（系统语言不是我们支持的五种时，英文比中文更有用）。
 */
function detectLanguage(): PanelLanguage {
  for (const tag of navigatorLanguages()) {
    const hit = normalizeLocale(tag)
    if (hit) return hit
  }
  return 'en'
}

/** localStorage：读不到（没有 / 隐私模式）就当没有，绝不因此让页面起不来。 */
function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** 盘上那条选择；没存过、存的值认不出、读不了盘，一律算「跟随浏览器」。 */
function readPreference(): LanguagePreference {
  const store = storage()
  if (!store) return 'system'
  try {
    const raw = store.getItem(LANGUAGE_STORAGE_KEY)
    if (!raw) return 'system'
    return normalizeLocale(raw) ?? 'system'
  } catch {
    return 'system'
  }
}

/** null = 还没读过盘：读一次就够，之后以内存里那份为准。 */
let preference: LanguagePreference | null = null
/** 跟随浏览器时算出来的那一门；改偏好时清掉重算。 */
let detected: PanelLanguage | null = null
const listeners = new Set<() => void>()

function preferenceOnce(): LanguagePreference {
  if (preference === null) preference = readPreference()
  return preference
}

/** 用户当前的选择：`'system'` 表示跟着浏览器走。 */
export function panelLanguagePreference(): LanguagePreference {
  return preferenceOnce()
}

/**
 * 当前这门语言。渲染时读它 —— 与 `t()` 读到的是同一份状态，
 * 所以不会出现「切了语言但某一块没跟着变」。
 */
export function panelLanguage(): PanelLanguage {
  const pref = preferenceOnce()
  if (pref !== 'system') return pref
  if (!detected) detected = detectLanguage()
  return detected
}

/** 换语言：写盘、通知订阅者，页面当场重绘（不用刷新）。 */
export function setPanelLanguagePreference(next: LanguagePreference): void {
  const normalized: LanguagePreference = next === 'system' ? 'system' : normalizeLocale(next) ?? 'system'
  preference = normalized
  detected = null
  const store = storage()
  try {
    if (store) {
      if (normalized === 'system') store.removeItem(LANGUAGE_STORAGE_KEY)
      else store.setItem(LANGUAGE_STORAGE_KEY, normalized)
    }
  } catch {
    /* 存不下只是「下次不记得」，这一次的选择照样生效 */
  }
  for (const listener of listeners) listener()
}

/** 订阅语言变化（`usePanelLanguage` 用它接 React）。 */
export function subscribePanelLanguage(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 当前语言（旧名字，保留给既有调用方与守卫）。 */
export function resolvePanelLanguage(): PanelLanguage {
  return panelLanguage()
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

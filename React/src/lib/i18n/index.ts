/**
 * 面板取词的唯一出口：`t('panel.pairing.copyCode')`。
 *
 * 只做「合并各领域表 + 查当前语言」两件事。当前语言由 `core.ts` 那一份状态回答：
 * 缺省跟着浏览器 / 系统走，右上角那颗按钮选了某一门就按那一门（见 `core.ts` 的文件头）。
 *
 * 非组件代码（`lib/format.ts`、`lib/links.ts` 的渠道表）也走这里 —— 那些是**渲染时才拼**
 * 的字符串，不是模块级常量，所以读到的永远是当下那门语言。
 */
import { mergeTables, resolvePanelLanguage, translate, type PanelLanguage } from './core.ts'
import { COMMON, STATUS, SHELL } from './messages/shell.ts'
import { ADDRESS, CHANNELS, CONNECTION, INBOX, PAIRING } from './messages/panel.ts'
import { ONBOARDING } from './messages/onboarding.ts'
import { UPDATE } from './messages/update.ts'
import { DEVICES } from './messages/devices.ts'

/** 全部领域表。守卫按它逐门检查键集对齐与占位符一致。 */
export const MESSAGE_TABLES = [COMMON, STATUS, SHELL, CONNECTION, PAIRING, ADDRESS, CHANNELS, INBOX, ONBOARDING, UPDATE, DEVICES]

/** 合并后的字典：语言 → 扁平表。 */
export const MESSAGES: Record<PanelLanguage, Record<string, string>> = (() => {
  const out = {
    'zh-Hans': {},
    'zh-Hant': {},
    en: {},
    ja: {},
    ko: {},
    de: {},
    es: {},
    fr: {},
    pt: {},
    ru: {},
  } as Record<PanelLanguage, Record<string, string>>
  for (const language of Object.keys(out) as PanelLanguage[]) {
    out[language] = mergeTables(MESSAGE_TABLES.map((table) => table[language] ?? {}))
  }
  return out
})()

/** 取一条文案（当前语言 → 源语言 → 键名本身）。 */
export function t(key: string, params?: Record<string, string | number>): string {
  return translate(MESSAGES, resolvePanelLanguage(), key, params)
}

export type { PanelLanguage }
export { normalizeLocale, resolvePanelLanguage } from './core.ts'
export {
  LANGUAGE_LABELS,
  LANGUAGE_STORAGE_KEY,
  PANEL_LANGUAGES,
  panelLanguage,
  panelLanguagePreference,
  setPanelLanguagePreference,
  subscribePanelLanguage,
} from './core.ts'
export type { LanguagePreference } from './core.ts'

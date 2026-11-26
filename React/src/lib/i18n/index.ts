// 2026-11-26：面板补齐第 11 门语言土耳其语（tr），MESSAGES 初始化同步加入。
/**
 * 面板取词的唯一出口：`t('panel.pairing.cardTitle')`。
 *
 * 只做「合并各领域表 + 查当前语言」两件事。当前语言由 `core.ts` 那一份状态回答：
 * 缺省跟着浏览器 / 系统走，右上角那颗按钮选了某一门就按那一门（见 `core.ts` 的文件头）。
 *
 * 非组件代码（`lib/format.ts`、`lib/links.ts` 的渠道表）也走这里 —— 那些是**渲染时才拼**
 * 的字符串，不是模块级常量，所以读到的永远是当下那门语言。
 */
// 远程电脑的操作与租期提示纳入全部面板语言。
import { mergeTables, resolvePanelLanguage, translate, type PanelLanguage } from './core.ts'
import { COMMON, STATUS, SHELL } from './messages/shell.ts'
import { ADDRESS, CHANNELS, CONNECTION, INBOX, PAIRING } from './messages/panel.ts'
import { TAILCAT } from './messages/tailcat.ts'
import { P2P } from './messages/p2p.ts'
import { ONBOARDING } from './messages/onboarding.ts'
import { UPDATE } from './messages/update.ts'
import { DEVICES } from './messages/devices.ts'
import { SELFCHECK } from './messages/selfcheck.ts'
import { CONSOLE } from './messages/console.ts'
import { REMOTE_COMPUTERS } from './messages/remote-computers.ts'
import { NOTICE } from './messages/notice.ts'
import { NETWORK_PANEL } from './messages/network-panel.ts'
import { AI_DIAGNOSIS } from './messages/ai-diagnosis.ts'

/** 全部领域表。守卫按它逐门检查键集对齐与占位符一致。 */
export const MESSAGE_TABLES = [COMMON, STATUS, SHELL, CONNECTION, PAIRING, ADDRESS, CHANNELS, INBOX, TAILCAT, P2P, ONBOARDING, UPDATE, DEVICES, SELFCHECK, CONSOLE, REMOTE_COMPUTERS, NOTICE, NETWORK_PANEL, AI_DIAGNOSIS]

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
    tr: {},
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

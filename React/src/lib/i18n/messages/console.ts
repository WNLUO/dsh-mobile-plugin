/**
 * 面板控制台（`Console.tsx`）的文案：侧边栏那颗手机图标点开的那一窗。
 *
 * 与网页面板共用同一份字典与同一个 `t()` 出口，所以键名同样带 `panel.` 前缀、
 * 键集由 `test/panel-i18n.test.cjs` 逐门对齐。这里只放**这一窗独有的词**：
 * 页面里的卡片、开关、弹窗全部复用现有领域表（`panel.pairing.*` / `panel.devices.*` …），
 * 别在第二个领域文件里再抄一遍（同一个键落在两个文件里守卫当场红）。
 */
import type { PanelMessages } from './shell.ts'

export const CONSOLE: PanelMessages = {
  'zh-Hans': {
    'panel.console.troubleshoot': '报错调试',
    'panel.console.openBrowser': '在浏览器打开',
  },
  'zh-Hant': {
    'panel.console.troubleshoot': '報錯除錯',
    'panel.console.openBrowser': '在瀏覽器開啟',
  },
  en: {
    'panel.console.troubleshoot': 'Troubleshoot',
    'panel.console.openBrowser': 'Open in browser',
  },
  ja: {
    'panel.console.troubleshoot': 'トラブルシュート',
    'panel.console.openBrowser': 'ブラウザーで開く',
  },
  ko: {
    'panel.console.troubleshoot': '문제 진단',
    'panel.console.openBrowser': '브라우저에서 열기',
  },
  de: {
    'panel.console.troubleshoot': 'Fehlersuche',
    'panel.console.openBrowser': 'Im Browser öffnen',
  },
  es: {
    'panel.console.troubleshoot': 'Diagnóstico',
    'panel.console.openBrowser': 'Abrir en el navegador',
  },
  fr: {
    'panel.console.troubleshoot': 'Diagnostic',
    'panel.console.openBrowser': 'Ouvrir dans le navigateur',
  },
  pt: {
    'panel.console.troubleshoot': 'Diagnóstico',
    'panel.console.openBrowser': 'Abrir no navegador',
  },
  ru: {
    'panel.console.troubleshoot': 'Диагностика',
    'panel.console.openBrowser': 'Открыть в браузере',
  },
}

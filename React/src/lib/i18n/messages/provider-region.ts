// 2026-11-27：服务商线路加「中国 / 国际」标签切换与两地专属面板，文案十一门语言逐键对齐。
/**
 * 服务商线路区的标签与专属面板文案。
 *
 * 标题右边那两个标签（中国 / 国际）默认按界面语言选：中文 / 繁体默认中国，其余默认国际；
 * 用户点过一次之后以手动选择为准。面板只展示宿主已给的事实，不编造套餐用量与流量数字。
 * 这一份只管标签、地区说明与中国面板的使用情况标题，其余沿用已有词条。
 */
import type { PanelMessages } from './shell.ts'

export const PROVIDER_REGION: PanelMessages = {
  'zh-Hans': {
    'panel.providerRegion.tabChina': '中国',
    'panel.providerRegion.tabGlobal': '国际',
    'panel.providerRegion.chinaHint': '国内线路 · ZeroNews',
    'panel.providerRegion.globalHint': '国际线路 · Cloudflare',
    'panel.providerRegion.usage': '使用情况',
    'panel.providerRegion.notConnected': '尚未接入，点「详细配置」开始。',
  },
  'zh-Hant': {
    'panel.providerRegion.tabChina': '中國',
    'panel.providerRegion.tabGlobal': '國際',
    'panel.providerRegion.chinaHint': '國內線路 · ZeroNews',
    'panel.providerRegion.globalHint': '國際線路 · Cloudflare',
    'panel.providerRegion.usage': '使用情況',
    'panel.providerRegion.notConnected': '尚未接入，點「詳細設定」開始。',
  },
  en: {
    'panel.providerRegion.tabChina': 'China',
    'panel.providerRegion.tabGlobal': 'International',
    'panel.providerRegion.chinaHint': 'China routes · ZeroNews',
    'panel.providerRegion.globalHint': 'Global routes · Cloudflare',
    'panel.providerRegion.usage': 'Usage',
    'panel.providerRegion.notConnected': 'Not connected yet. Open Configure to set it up.',
  },
  ja: {
    'panel.providerRegion.tabChina': '中国',
    'panel.providerRegion.tabGlobal': '国際',
    'panel.providerRegion.chinaHint': '中国回線 · ZeroNews',
    'panel.providerRegion.globalHint': '国際回線 · Cloudflare',
    'panel.providerRegion.usage': '利用状況',
    'panel.providerRegion.notConnected': 'まだ接続されていません。「詳細設定」から開始してください。',
  },
  ko: {
    'panel.providerRegion.tabChina': '중국',
    'panel.providerRegion.tabGlobal': '국제',
    'panel.providerRegion.chinaHint': '중국 회선 · ZeroNews',
    'panel.providerRegion.globalHint': '국제 회선 · Cloudflare',
    'panel.providerRegion.usage': '사용량',
    'panel.providerRegion.notConnected': '아직 연결되지 않았습니다. 「상세 설정」에서 시작하세요.',
  },
  de: {
    'panel.providerRegion.tabChina': 'China',
    'panel.providerRegion.tabGlobal': 'International',
    'panel.providerRegion.chinaHint': 'China-Routen · ZeroNews',
    'panel.providerRegion.globalHint': 'Globale Routen · Cloudflare',
    'panel.providerRegion.usage': 'Verbrauch',
    'panel.providerRegion.notConnected': 'Noch nicht verbunden. Öffne „Konfigurieren" zum Einrichten.',
  },
  es: {
    'panel.providerRegion.tabChina': 'China',
    'panel.providerRegion.tabGlobal': 'Internacional',
    'panel.providerRegion.chinaHint': 'Rutas en China · ZeroNews',
    'panel.providerRegion.globalHint': 'Rutas globales · Cloudflare',
    'panel.providerRegion.usage': 'Uso',
    'panel.providerRegion.notConnected': 'Aún no conectado. Abre «Configurar» para empezar.',
  },
  fr: {
    'panel.providerRegion.tabChina': 'Chine',
    'panel.providerRegion.tabGlobal': 'International',
    'panel.providerRegion.chinaHint': 'Routes en Chine · ZeroNews',
    'panel.providerRegion.globalHint': 'Routes mondiales · Cloudflare',
    'panel.providerRegion.usage': 'Utilisation',
    'panel.providerRegion.notConnected': 'Pas encore connecté. Ouvrez « Configurer » pour commencer.',
  },
  pt: {
    'panel.providerRegion.tabChina': 'China',
    'panel.providerRegion.tabGlobal': 'Internacional',
    'panel.providerRegion.chinaHint': 'Rotas na China · ZeroNews',
    'panel.providerRegion.globalHint': 'Rotas globais · Cloudflare',
    'panel.providerRegion.usage': 'Uso',
    'panel.providerRegion.notConnected': 'Ainda não conectado. Abra «Configurar» para começar.',
  },
  ru: {
    'panel.providerRegion.tabChina': 'Китай',
    'panel.providerRegion.tabGlobal': 'Международный',
    'panel.providerRegion.chinaHint': 'Маршруты в Китае · ZeroNews',
    'panel.providerRegion.globalHint': 'Глобальные маршруты · Cloudflare',
    'panel.providerRegion.usage': 'Использование',
    'panel.providerRegion.notConnected': 'Ещё не подключено. Откройте «Настроить», чтобы начать.',
  },
  tr: {
    'panel.providerRegion.tabChina': 'Çin',
    'panel.providerRegion.tabGlobal': 'Uluslararası',
    'panel.providerRegion.chinaHint': 'Çin hatları · ZeroNews',
    'panel.providerRegion.globalHint': 'Küresel hatlar · Cloudflare',
    'panel.providerRegion.usage': 'Kullanım',
    'panel.providerRegion.notConnected': 'Henüz bağlanılmadı. Başlamak için «Yapılandır»ı açın.',
  },
}

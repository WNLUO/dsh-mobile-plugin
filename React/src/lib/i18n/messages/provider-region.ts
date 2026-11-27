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
    'panel.providerRegion.globalHint': '国际线路 · Cloudflare',
    'panel.providerRegion.usage': '使用情况',
    'panel.providerRegion.notConnected': '尚未接入。',
    'panel.providerRegion.freeQuota': '免费版权益：{bw} Mbps 带宽 · {traffic} GB 月流量 · 单隧道并发 {concurrency}。',
  },
  'zh-Hant': {
    'panel.providerRegion.tabChina': '中國',
    'panel.providerRegion.tabGlobal': '國際',
    'panel.providerRegion.globalHint': '國際線路 · Cloudflare',
    'panel.providerRegion.usage': '使用情況',
    'panel.providerRegion.notConnected': '尚未接入。',
    'panel.providerRegion.freeQuota': '免費版權益：{bw} Mbps 頻寬 · {traffic} GB 月流量 · 單隧道並發 {concurrency}。',
  },
  en: {
    'panel.providerRegion.tabChina': 'China',
    'panel.providerRegion.tabGlobal': 'International',
    'panel.providerRegion.globalHint': 'Global routes · Cloudflare',
    'panel.providerRegion.usage': 'Usage',
    'panel.providerRegion.notConnected': 'Not connected yet.',
    'panel.providerRegion.freeQuota': 'Free plan: {bw} Mbps bandwidth · {traffic} GB monthly traffic · {concurrency} connections per tunnel.',
  },
  ja: {
    'panel.providerRegion.tabChina': '中国',
    'panel.providerRegion.tabGlobal': '国際',
    'panel.providerRegion.globalHint': '国際回線 · Cloudflare',
    'panel.providerRegion.usage': '利用状況',
    'panel.providerRegion.notConnected': 'まだ接続されていません。',
    'panel.providerRegion.freeQuota': '無料プラン：帯域 {bw} Mbps · 月間トラフィック {traffic} GB · トンネル同時接続 {concurrency}。',
  },
  ko: {
    'panel.providerRegion.tabChina': '중국',
    'panel.providerRegion.tabGlobal': '국제',
    'panel.providerRegion.globalHint': '국제 회선 · Cloudflare',
    'panel.providerRegion.usage': '사용량',
    'panel.providerRegion.notConnected': '아직 연결되지 않았습니다.',
    'panel.providerRegion.freeQuota': '무료 요금제: 대역폭 {bw} Mbps · 월 트래픽 {traffic} GB · 터널 동시 연결 {concurrency}.',
  },
  de: {
    'panel.providerRegion.tabChina': 'China',
    'panel.providerRegion.tabGlobal': 'International',
    'panel.providerRegion.globalHint': 'Globale Routen · Cloudflare',
    'panel.providerRegion.usage': 'Verbrauch',
    'panel.providerRegion.notConnected': 'Noch nicht verbunden.',
    'panel.providerRegion.freeQuota': 'Kostenloser Tarif: {bw} Mbps Bandbreite · {traffic} GB Traffic pro Monat · {concurrency} Verbindungen pro Tunnel.',
  },
  es: {
    'panel.providerRegion.tabChina': 'China',
    'panel.providerRegion.tabGlobal': 'Internacional',
    'panel.providerRegion.globalHint': 'Rutas globales · Cloudflare',
    'panel.providerRegion.usage': 'Uso',
    'panel.providerRegion.notConnected': 'Aún no conectado.',
    'panel.providerRegion.freeQuota': 'Plan gratuito: ancho de banda de {bw} Mbps · {traffic} GB de tráfico mensual · {concurrency} conexiones por túnel.',
  },
  fr: {
    'panel.providerRegion.tabChina': 'Chine',
    'panel.providerRegion.tabGlobal': 'International',
    'panel.providerRegion.globalHint': 'Routes mondiales · Cloudflare',
    'panel.providerRegion.usage': 'Utilisation',
    'panel.providerRegion.notConnected': 'Pas encore connecté.',
    'panel.providerRegion.freeQuota': 'Offre gratuite : bande passante {bw} Mbps · trafic mensuel {traffic} Go · {concurrency} connexions par tunnel.',
  },
  pt: {
    'panel.providerRegion.tabChina': 'China',
    'panel.providerRegion.tabGlobal': 'Internacional',
    'panel.providerRegion.globalHint': 'Rotas globais · Cloudflare',
    'panel.providerRegion.usage': 'Uso',
    'panel.providerRegion.notConnected': 'Ainda não conectado.',
    'panel.providerRegion.freeQuota': 'Plano gratuito: largura de banda de {bw} Mbps · {traffic} GB de tráfego mensal · {concurrency} conexões por túnel.',
  },
  ru: {
    'panel.providerRegion.tabChina': 'Китай',
    'panel.providerRegion.tabGlobal': 'Международный',
    'panel.providerRegion.globalHint': 'Глобальные маршруты · Cloudflare',
    'panel.providerRegion.usage': 'Использование',
    'panel.providerRegion.notConnected': 'Ещё не подключено.',
    'panel.providerRegion.freeQuota': 'Бесплатный тариф: {bw} Мбит/с · {traffic} ГБ трафика в месяц · {concurrency} соединений на туннель.',
  },
  tr: {
    'panel.providerRegion.tabChina': 'Çin',
    'panel.providerRegion.tabGlobal': 'Uluslararası',
    'panel.providerRegion.globalHint': 'Küresel hatlar · Cloudflare',
    'panel.providerRegion.usage': 'Kullanım',
    'panel.providerRegion.notConnected': 'Henüz bağlanılmadı.',
    'panel.providerRegion.freeQuota': 'Ücretsiz plan: {bw} Mbps bant genişliği · aylık {traffic} GB trafik · tünel başına {concurrency} bağlantı.',
  },
}

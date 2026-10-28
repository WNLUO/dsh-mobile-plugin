/**
 * 面板文案：左侧栏那块公告板（公用中转要求的插件最低版本）。
 *
 * 一段话要说清三件事：这条公告**什么时候生效**、插件**至少要哪个号**、不够的人
 * **怎么办**。少最后一句，读到的人只会知道自己不达标，不知道往哪走。
 *
 * 号本身不在这张表里（它是 `components/NoticeBoard.tsx` 的 `MIN_PLUGIN_VERSION`），
 * 这里只留 `{version}` 占位符 —— 改号只改一处，十门语言一起跟着变。
 *
 * 正文一律往短里写：那块地只有一条窄缝宽，一行十来个字，多一句就多几行。
 */
import type { PanelMessages } from './shell.ts'

export const NOTICE: PanelMessages = {
  'zh-Hans': {
    'panel.notice.title': '关于公用中转限制插件版本的公告',
    'panel.notice.versionLabel': '最低插件版本',
    'panel.notice.effective': '苹果商店版正式发布后生效',
    'panel.notice.body': '公用中转要求插件 {version} 或更高；旧版请先升级，否则连不上中转。',
  },
  'zh-Hant': {
    'panel.notice.title': '關於公用中轉限制外掛版本的公告',
    'panel.notice.versionLabel': '最低外掛版本',
    'panel.notice.effective': '蘋果商店版正式發布後生效',
    'panel.notice.body': '公用中轉要求外掛 {version} 或更高；舊版請先升級，否則連不上中轉。',
  },
  en: {
    'panel.notice.title': 'Plugin version limit on the public relay',
    'panel.notice.versionLabel': 'Minimum plugin',
    'panel.notice.effective': 'Applies after the App Store release',
    'panel.notice.body': 'The public relay requires plugin {version} or newer. On an older build, update first — otherwise it cannot connect.',
  },
  ja: {
    'panel.notice.title': '共用リレーでのプラグインのバージョン制限について',
    'panel.notice.versionLabel': 'プラグイン最低バージョン',
    'panel.notice.effective': 'App Store 版のリリース後に適用',
    'panel.notice.body': '共用リレーはプラグイン {version} 以上が必要です。古い場合は先に更新してください。',
  },
  ko: {
    'panel.notice.title': '공용 릴레이의 플러그인 버전 제한 안내',
    'panel.notice.versionLabel': '최소 플러그인 버전',
    'panel.notice.effective': 'App Store 정식 출시 후 적용',
    'panel.notice.body': '공용 릴레이는 플러그인 {version} 이상이 필요합니다. 이전 버전이라면 먼저 업데이트하세요.',
  },
  de: {
    'panel.notice.title': 'Versionsgrenze für das Plugin am öffentlichen Relay',
    'panel.notice.versionLabel': 'Mindestversion',
    'panel.notice.effective': 'Gilt ab dem App-Store-Release',
    'panel.notice.body': 'Das öffentliche Relay braucht Plugin {version} oder neuer. Sonst erst aktualisieren, sonst keine Verbindung.',
  },
  es: {
    'panel.notice.title': 'Límite de versión del plugin en el relay público',
    'panel.notice.versionLabel': 'Versión mínima',
    'panel.notice.effective': 'Desde el lanzamiento en App Store',
    'panel.notice.body': 'El relay público exige el plugin {version} o superior. Si es más antiguo, actualiza primero.',
  },
  fr: {
    'panel.notice.title': 'Limite de version du plugin sur le relais public',
    'panel.notice.versionLabel': 'Version minimale',
    'panel.notice.effective': 'Dès la sortie App Store',
    'panel.notice.body': 'Le relais public exige le plugin {version} ou plus. Sinon, mettez-le à jour d’abord.',
  },
  pt: {
    'panel.notice.title': 'Limite de versão do plugin no relay público',
    'panel.notice.versionLabel': 'Versão mínima',
    'panel.notice.effective': 'Vale a partir do lançamento na App Store',
    'panel.notice.body': 'O relay público exige o plugin {version} ou superior. Se estiver mais antigo, atualize primeiro.',
  },
  ru: {
    'panel.notice.title': 'Ограничение версии плагина на публичном релее',
    'panel.notice.versionLabel': 'Минимальная версия',
    'panel.notice.effective': 'После релиза в App Store',
    'panel.notice.body': 'Публичному релею нужен плагин {version} или новее. Иначе сначала обновите.',
  },
}

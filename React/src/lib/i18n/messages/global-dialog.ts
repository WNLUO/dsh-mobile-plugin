/**
 * 全局弹窗文案：挂在页面最外层那一扇，内容目前是占位。
 *
 * 十门语言逐键对齐（守卫 `test/panel-i18n.test.cjs` 会查），真实文案定了只改这两条，
 * 组件那层不用动。
 */
import type { PanelLanguage } from '../core.ts'

type Table = Record<string, string>
export type PanelMessages = Record<PanelLanguage, Table>

/** 全局弹窗的标题与正文。 */
export const GLOBAL_DIALOG: PanelMessages = {
  'zh-Hans': {
    'panel.globalDialog.title': '提示',
    'panel.globalDialog.body': '内容待补充。',
  },
  'zh-Hant': {
    'panel.globalDialog.title': '提示',
    'panel.globalDialog.body': '內容待補充。',
  },
  en: {
    'panel.globalDialog.title': 'Notice',
    'panel.globalDialog.body': 'Content to be added.',
  },
  ja: {
    'panel.globalDialog.title': 'お知らせ',
    'panel.globalDialog.body': '内容は未定です。',
  },
  ko: {
    'panel.globalDialog.title': '알림',
    'panel.globalDialog.body': '내용은 준비 중입니다.',
  },
  de: {
    'panel.globalDialog.title': 'Hinweis',
    'panel.globalDialog.body': 'Inhalt folgt.',
  },
  es: {
    'panel.globalDialog.title': 'Aviso',
    'panel.globalDialog.body': 'Contenido pendiente.',
  },
  fr: {
    'panel.globalDialog.title': 'Notification',
    'panel.globalDialog.body': 'Contenu à venir.',
  },
  pt: {
    'panel.globalDialog.title': 'Aviso',
    'panel.globalDialog.body': 'Conteúdo pendente.',
  },
  ru: {
    'panel.globalDialog.title': 'Уведомление',
    'panel.globalDialog.body': 'Содержимое будет добавлено.',
  },
}

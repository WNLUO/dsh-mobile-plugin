// 2026-11-26：面板补齐第 11 门语言土耳其语（tr），新增完整 tr 文案表。
/**
 * 网络面板文案：只有指标卡那四个标签，刻度与时间由采样直接生成。
 * 十一门语言逐键对齐（守卫 `test/panel-network-panel.test.cjs` 会查）。
 *
 * 口径从本机看：上行=本机发出去（与「总发送」同向），下行=本机收进来（与「总接收」同向）。
 */
import type { PanelLanguage } from '../core.ts'

type Table = Record<string, string>
export type PanelMessages = Record<PanelLanguage, Table>

/** 流速指标的四个标签。 */
export const NETWORK_PANEL: PanelMessages = {
  'zh-Hans': {
    'panel.network.up': '上行',
    'panel.network.down': '下行',
    'panel.network.totalSent': '总发送',
    'panel.network.totalReceived': '总接收',
  },
  'zh-Hant': {
    'panel.network.up': '上行',
    'panel.network.down': '下行',
    'panel.network.totalSent': '總發送',
    'panel.network.totalReceived': '總接收',
  },
  en: {
    'panel.network.up': 'Up',
    'panel.network.down': 'Down',
    'panel.network.totalSent': 'Total sent',
    'panel.network.totalReceived': 'Total received',
  },
  ja: {
    'panel.network.up': 'アップロード',
    'panel.network.down': 'ダウンロード',
    'panel.network.totalSent': '総送信',
    'panel.network.totalReceived': '総受信',
  },
  ko: {
    'panel.network.up': '업로드',
    'panel.network.down': '다운로드',
    'panel.network.totalSent': '총 전송',
    'panel.network.totalReceived': '총 수신',
  },
  de: {
    'panel.network.up': 'Upload',
    'panel.network.down': 'Download',
    'panel.network.totalSent': 'Gesendet',
    'panel.network.totalReceived': 'Empfangen',
  },
  es: {
    'panel.network.up': 'Subida',
    'panel.network.down': 'Bajada',
    'panel.network.totalSent': 'Enviado',
    'panel.network.totalReceived': 'Recibido',
  },
  fr: {
    'panel.network.up': 'Envoi',
    'panel.network.down': 'Réception',
    'panel.network.totalSent': 'Envoyé',
    'panel.network.totalReceived': 'Reçu',
  },
  pt: {
    'panel.network.up': 'Subida',
    'panel.network.down': 'Descida',
    'panel.network.totalSent': 'Enviado',
    'panel.network.totalReceived': 'Recebido',
  },
  ru: {
    'panel.network.up': 'Отправка',
    'panel.network.down': 'Приём',
    'panel.network.totalSent': 'Отправлено',
    'panel.network.totalReceived': 'Получено',
  },
  tr: {
    'panel.network.up': 'Yükleme',
    'panel.network.down': 'İndirme',
    'panel.network.totalSent': 'Toplam gönderilen',
    'panel.network.totalReceived': 'Toplam alınan',
  },
}

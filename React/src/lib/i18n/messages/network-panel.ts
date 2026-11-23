/**
 * 网络面板文案：只有指标卡那四个标签，刻度与时间由采样直接生成。
 * 十门语言逐键对齐（守卫 `test/panel-network-panel.test.cjs` 会查）。
 */
import type { PanelLanguage } from '../core.ts'

type Table = Record<string, string>
export type PanelMessages = Record<PanelLanguage, Table>

/** 延迟指标的四个标签。 */
export const NETWORK_PANEL: PanelMessages = {
  'zh-Hans': {
    'panel.network.current': '当前',
    'panel.network.average': '平均',
    'panel.network.min': '最低',
    'panel.network.max': '最高',
  },
  'zh-Hant': {
    'panel.network.current': '當前',
    'panel.network.average': '平均',
    'panel.network.min': '最低',
    'panel.network.max': '最高',
  },
  en: {
    'panel.network.current': 'Current',
    'panel.network.average': 'Average',
    'panel.network.min': 'Lowest',
    'panel.network.max': 'Highest',
  },
  ja: {
    'panel.network.current': '現在',
    'panel.network.average': '平均',
    'panel.network.min': '最低',
    'panel.network.max': '最高',
  },
  ko: {
    'panel.network.current': '현재',
    'panel.network.average': '평균',
    'panel.network.min': '최저',
    'panel.network.max': '최고',
  },
  de: {
    'panel.network.current': 'Aktuell',
    'panel.network.average': 'Ø',
    'panel.network.min': 'Min',
    'panel.network.max': 'Max',
  },
  es: {
    'panel.network.current': 'Actual',
    'panel.network.average': 'Media',
    'panel.network.min': 'Mínimo',
    'panel.network.max': 'Máximo',
  },
  fr: {
    'panel.network.current': 'Actuel',
    'panel.network.average': 'Moyenne',
    'panel.network.min': 'Minimum',
    'panel.network.max': 'Maximum',
  },
  pt: {
    'panel.network.current': 'Atual',
    'panel.network.average': 'Média',
    'panel.network.min': 'Mínimo',
    'panel.network.max': 'Máximo',
  },
  ru: {
    'panel.network.current': 'Сейчас',
    'panel.network.average': 'Средняя',
    'panel.network.min': 'Мин',
    'panel.network.max': 'Макс',
  },
}

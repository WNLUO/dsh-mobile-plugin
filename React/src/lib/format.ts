/** 一点点展示用的纯函数，和接口无关。 */

import { t } from './i18n/index.ts'

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

/** 状态点／文字的颜色档：ok 绿、warn 黄、error 红、off 灰。 */
export type Tone = 'ok' | 'warn' | 'error' | 'off'

export const toneDot: Record<Tone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  error: 'bg-error',
  off: 'bg-foreground-subtle',
}

export const toneText: Record<Tone, string> = {
  ok: 'text-success',
  warn: 'text-warning',
  error: 'text-error',
  off: 'text-foreground-muted',
}

/** 时间戳（毫秒）与 ISO 字符串都吃；空值给一个破折号，别让界面出现 NaN。 */
export function timeText(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === 0 || value === '') return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('zh-CN', { hour12: false })
}

/** 隧道状态：state 是宿主给的英文枚举，配一句中文。 */
export function tunnelTone(state: string): Tone {
  if (state === 'connected') return 'ok'
  if (state === 'error') return 'error'
  if (state === 'connecting') return 'warn'
  return 'off'
}

export function tunnelText(state: string): string {
  // 状态词进字典：`state` 本身是宿主给的机读值，认不出的原样透出（别把它翻成不存在的东西）。
  const keys: Record<string, string> = {
    connected: 'panel.status.connected',
    connecting: 'panel.status.connecting',
    error: 'panel.status.error',
    off: 'panel.status.off',
  }
  return keys[state] ? t(keys[state]) : state
}

export function lanTone(state: string, enabled: boolean): Tone {
  if (!enabled) return 'off'
  if (state === 'listening') return 'ok'
  if (state === 'error') return 'error'
  return 'warn'
}

export function lanText(state: string, enabled: boolean): string {
  if (!enabled) return t('panel.lan.off')
  if (state === 'listening') return t('panel.lan.listening')
  if (state === 'error') return t('panel.lan.error')
  return state
}

export function sidecarText(state: string): string {
  const keys: Record<string, string> = {
    healthy: 'panel.sidecar.healthy',
    starting: 'panel.sidecar.starting',
    restarting: 'panel.sidecar.restarting',
    error: 'panel.sidecar.error',
    stopped: 'panel.sidecar.stopped',
  }
  return keys[state] ? t(keys[state]) : state
}

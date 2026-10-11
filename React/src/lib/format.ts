/** 一点点展示用的纯函数，和接口无关。 */

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
  const map: Record<string, string> = {
    connected: '已连接',
    connecting: '连接中',
    error: '被关闭',
    off: '未启用',
  }
  return map[state] ?? state
}

export function lanTone(state: string, enabled: boolean): Tone {
  if (!enabled) return 'off'
  if (state === 'listening') return 'ok'
  if (state === 'error') return 'error'
  return 'warn'
}

export function lanText(state: string, enabled: boolean): string {
  if (!enabled) return '未启用'
  if (state === 'listening') return '正在监听'
  if (state === 'error') return '启动失败'
  return state
}

export function sidecarText(state: string): string {
  const map: Record<string, string> = {
    healthy: '运行中',
    starting: '启动中',
    restarting: '正在重启',
    error: '异常',
    stopped: '已停止',
  }
  return map[state] ?? state
}

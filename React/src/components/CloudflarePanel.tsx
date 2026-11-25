// Cloudflare 匿名隧道的管理与状态：国际线路那一页与「连接状态」卡里的管理弹窗共用这一份。
// 等待端口时把局域网端口的真实错误带出来，免得用户以为这条隧道自己坏了。
/**
 * Cloudflare 兜底隧道的面板内容（不含窗口外壳）。
 *
 * 两处消费：`CloudflareDialog`（连接状态卡那行的「管理」）与国际线路页（网络配置 →
 * 国际入口）。同一份实现，免得两个入口各写一套状态判断、说的还不是同一件事。
 *
 * 读数来自上层每 3 秒刷新的 `status.cloudflare`；switch 的回包只插一拍即时值，
 * 下一轮仍以宿主为准。
 */
import { Switch } from '@appica/ui-react/switch'
import { useEffect, useState } from 'react'

import { cloudflareStart, cloudflareStop, errorText, type CloudflareStatus, type StatusView } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'
import { InfoRow, ToneValue } from './InfoRow.tsx'

type Props = {
  /** 宿主当前状态：Cloudflare 那一格从这里读（老宿主没有就是 null）。 */
  status: StatusView
  /** 动作之后通知外层刷新一次 `/api/relay/status`（连接卡那行也跟着变）。 */
  onChanged?: () => void
}

export function CloudflarePanel({ status, onChanged }: Props) {
  /** 一次 start/stop 请求在飞：开关期间禁用，防止连点。 */
  const [busy, setBusy] = useState(false)
  /** 最近一次 start/stop 失败的原因（网络错误或回包里的 message）；成功或下一次操作前清空。 */
  const [error, setError] = useState('')
  /** start/stop 回包里的即时状态：先照它渲染，下一轮宿主轮询会用 `status.cloudflare` 覆盖回真值。 */
  const [live, setLive] = useState<CloudflareStatus | null>(null)

  // 宿主每 3 秒换一次 status，跟着它刷新；本窗回包只是插一拍即时值。
  useEffect(() => {
    setLive(status.cloudflare ?? null)
  }, [status.cloudflare])

  /** 当前状态：回包优先，其次宿主轮询回来的那一格；老宿主没有就是 null。 */
  const cf = live ?? status.cloudflare ?? null
  /** 开关认「在跑或正在起来」为开：点开后即便还在 starting 也照开显示。 */
  const cfOn = !!cf && (cf.running || cf.starting || cf.retrying || cf.waitingForPort)
  /** 状态行的点色：不可用 / 出错 / 运行中 / 起来中 / 可用待开。 */
  const tone: 'ok' | 'warn' | 'error' | 'off' = !cf || !cf.available
    ? 'off'
    : cf.error
      ? 'error'
      : cf.running
        ? 'ok'
        : cf.starting || cf.retrying || cf.waitingForPort
          ? 'warn'
          : 'off'
  /** 状态行的文案：与 tone 同一条判定链，保证点色与文字永远说的是同一件事。 */
  const text = !cf || !cf.available
    ? t('panel.cloudflare.unavailable')
    : cf.error
      ? t('panel.cloudflare.error')
      : cf.running
        ? t('panel.cloudflare.running')
        : cf.starting
          ? t('panel.cloudflare.starting')
          : cf.retrying
            ? t('panel.cloudflare.retrying')
            : cf.waitingForPort
              ? t('panel.cloudflare.waitingForPort')
              : t('panel.cloudflare.available')
  /** 状态行的细节：运行中给当前地址，出错给原因，等端口时给局域网那头的真实原因；其余不留。 */
  const detail = cf?.running && cf.url ? `${t('panel.cloudflare.url')}: ${cf.url}` : cf?.error ? cf.error
    : cf?.waitingForPort && status.lan?.error ? status.lan.error : undefined
  /** 请求在飞、或 cloudflared 未安装时开关不可点。 */
  const disabled = busy || cf?.available === false

  /** 开 / 关 Cloudflare 兜底隧道：开→start、关→stop；失败只在这里显示原因，不动其它状态。 */
  async function toggle(next: boolean) {
    if (busy || cf?.available === false) return
    setBusy(true)
    setError('')
    try {
      const reply = next ? await cloudflareStart() : await cloudflareStop()
      if (reply.ok === false) {
        setError(reply.error?.message || t('panel.cloudflare.error'))
        return
      }
      setLive({
        available: reply.available ?? true,
        enabled: reply.enabled ?? next,
        running: reply.running ?? next,
        url: reply.url ?? '',
        error: '',
        startedAt: reply.startedAt ?? 0,
        starting: reply.starting ?? false,
        retrying: reply.retrying ?? false,
        waitingForPort: reply.waitingForPort ?? false,
      })
      onChanged?.()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {error ? <p className="text-xs text-error">{error}</p> : null}

      <InfoRow label={t('panel.cloudflare.state')}>
        <ToneValue tone={tone} text={text} detail={detail} />
      </InfoRow>

      <label className="flex items-center justify-between gap-4 border-b border-border-muted py-2">
        <span className="text-sm text-foreground-muted">{t('panel.cloudflare.title')}</span>
        <Switch
          size="md"
          checked={cfOn}
          disabled={disabled}
          onCheckedChange={(next) => void toggle(next)}
          aria-label={t('panel.cloudflare.title')}
        />
      </label>
    </div>
  )
}

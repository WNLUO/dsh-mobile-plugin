/**
 * 「收件文件」卡片：手机分享进来的文件落在宿主这台机器上的收件目录，报占用、按龄清理。
 *
 * ## 这是什么东西
 *
 * App 把用户分享的文件分片传上来，宿主落盘到 `~/.dsh/mobile-inbox/<日期>/<文件名>`。
 * 那条通道**只进不出**：落盘的文件不认识会话、也不认识工作区（唯一的引用是会话日志正文里
 * 那句 `@路径`，那是文本），所以「归档对话 / 删掉对话」都带不走它们。不设出口，这个目录
 * 只会按天堆下去 —— 真机上几天就能堆出几十 MB。
 *
 * ## 为什么口径只能是「按龄」
 *
 * 想按会话清就得反推每份文件被谁引用过，而那个关系没有记录过。所以清的是**落盘满 24 小时**
 * 的那些（保留期由宿主回，界面只写出来，不自己判）。今天传的、正在跑的那一回合要读的文件
 * 一开始就不在清理范围内。
 *
 * ## 与「清理缓存」不是一件事
 *
 * 那一页清的是**手机本机**的缓存副本；这张卡清的是**电脑上**的盘。两者刻意不合并。
 */
import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@appica/ui-react/alert'
import { t } from '../lib/i18n/index.ts'
import { Button } from '@appica/ui-react/button'
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card'
import { Spinner } from '@appica/ui-react/spinner'
import { Switch } from '@appica/ui-react/switch'
import { useCallback, useEffect, useState } from 'react'

import { apiGet, apiPost, errorText } from '../lib/api.ts'
import { useNotify } from '../lib/notify.ts'

/** `GET /api/relay/inbox/status` 的回答。 */
type InboxStatus = {
  ok: boolean
  root: string
  files: number
  bytes: number
  deletableFiles: number
  deletableBytes: number
  /** 其中暂存残片（半截上传留下的 `.part`）占了多少；老宿主没有这两个字段。 */
  stagingFiles?: number
  stagingBytes?: number
  /** 自动清理开着没有（默认关；老宿主没有这个字段，按关处理）。 */
  autoClear?: boolean
  /** 最老那份的落盘时刻（毫秒）；空目录为 null。 */
  oldestAt: number | null
  keepHours: number
}

/** `POST /api/relay/inbox/clear` 的回答：这次真的腾出来的量。 */
type InboxClearResult = {
  ok: boolean
  deletedFiles: number
  freedBytes: number
  failedFiles: number
  keepHours: number
}

/** 字节 → 读数。0 显示成 0 MB（这一页要回答的正是「有没有东西可清」）。 */
export function formatInboxBytes(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  if (value === 0) return '0 MB'
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

/** 毫秒时刻 → 「3 小时前」这种人话；没有值就回空串。 */
export function inboxAgeText(at: number | null, now = Date.now()): string {
  if (!at) return ''
  const hours = Math.floor((now - at) / (60 * 60 * 1000))
  if (hours < 1) return t('panel.inbox.ageLessThanHour')
  if (hours < 24) return t('panel.inbox.ageHours', { hours })
  return t('panel.inbox.ageDays', { days: Math.floor(hours / 24) })
}

export function InboxCard() {
  const notify = useNotify()
  const [status, setStatus] = useState<InboxStatus | null>(null)
  const [settled, setSettled] = useState(false)
  const [busy, setBusy] = useState(false)
  /** 正在写自动清理开关。只锁那颗开关，不锁清理按钮。 */
  const [savingAuto, setSavingAuto] = useState(false)

  const load = useCallback(async () => {
    try {
      setStatus(await apiGet<InboxStatus>('/api/relay/inbox/status'))
    } catch {
      // 老宿主没有这条路由（404）：卡片退化成一句「这一版读不到」，不摆按钮。
      setStatus(null)
    } finally {
      setSettled(true)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const deletable = status?.deletableFiles ?? 0
  const age = inboxAgeText(status?.oldestAt ?? null)
  /** 读数里混着的暂存残片：够了龄一起清，界面上单独说一句来源。 */
  const staging = status?.stagingFiles ?? 0

  /** 切自动清理开关。失败就弹胶囊并保留旧值，不假装已经改好了。 */
  async function flipAuto(next: boolean) {
    if (savingAuto) return
    setSavingAuto(true)
    try {
      const result = await apiPost<{ ok: boolean; data: { autoClear: boolean } }>('/api/relay/inbox/auto', { enabled: next })
      setStatus((current) => (current ? { ...current, autoClear: result.data.autoClear } : current))
    } catch (error) {
      notify('error', t('panel.inbox.autoFailed', { message: errorText(error) }))
    } finally {
      setSavingAuto(false)
    }
  }

  async function clear() {
    if (busy) return
    // 与配对卡里「吊销全部设备授权」同一条口径：不可逆的删除先过一道 `window.confirm`。
    // 这里**不用 notify/Alert 代替**：胶囊会自己走掉，而这一步要的是「停一下、看清再按」。
    const detail = deletable > 0
      ? t('panel.inbox.confirmDetail', {
        count: deletable,
        hours: status?.keepHours ?? 24,
        bytes: formatInboxBytes(status?.deletableBytes ?? 0),
      })
      : t('panel.inbox.confirmNothing', { hours: status?.keepHours ?? 24 })
    if (!window.confirm(`${t('panel.inbox.confirmTitle')}\n\n${detail}\n\n${t('panel.inbox.confirmIrreversible')}`)) return
    setBusy(true)
    try {
      const result = await apiPost<InboxClearResult>('/api/relay/inbox/clear')
      const freed = formatInboxBytes(result.freedBytes)
      notify(
        result.failedFiles > 0 ? 'soft' : 'ok',
        result.deletedFiles > 0
          ? `${t('panel.inbox.cleared', { bytes: freed, count: result.deletedFiles })}${result.failedFiles > 0 ? t('panel.inbox.clearedSomeFailed', { count: result.failedFiles }) : ''}`
          : t('panel.inbox.nothingToClear'),
      )
      await load()
    } catch (error) {
      notify('error', t('panel.inbox.clearFailed', { message: errorText(error) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card frame="solid">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span>{t('panel.inbox.title')}</span>
        </CardTitle>
      </CardHeader>

      {!settled ? (
        <div className="flex items-center gap-2 py-2 text-sm text-foreground-muted">
          <Spinner />
          {t('panel.inbox.reading')}
        </div>
      ) : null}

      {settled && status === null ? (
        <Alert variant="info" className="mt-2">
          <AlertIcon />
          <AlertTitle>{t('panel.inbox.unreadableTitle')}</AlertTitle>
          <AlertDescription>{t('panel.inbox.unreadableBody')}</AlertDescription>
        </Alert>
      ) : null}

      {status !== null ? (
        <>
          <dl className="mt-1">
            <div className="flex items-baseline justify-between gap-4 border-b border-border-muted py-2">
              <dt className="shrink-0 text-sm text-foreground-muted">{t('panel.inbox.used')}</dt>
              <dd className="min-w-0 text-right text-sm break-all">
                {t('panel.inbox.usedValue', { bytes: formatInboxBytes(status.bytes), count: status.files })}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 border-b border-border-muted py-2">
              <dt className="shrink-0 text-sm text-foreground-muted">{t('panel.inbox.deletable')}</dt>
              <dd className="min-w-0 text-right text-sm break-all">
                {deletable > 0
                  ? t('panel.inbox.deletableValue', { bytes: formatInboxBytes(status.deletableBytes), count: deletable })
                  : t('panel.common.none')}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 py-2">
              <dt className="shrink-0 text-sm text-foreground-muted">{t('panel.inbox.keep')}</dt>
              <dd className="min-w-0 text-right text-sm break-all">
                {age
                  ? t('panel.inbox.keepValueOldest', { hours: status.keepHours, age })
                  : t('panel.inbox.keepValue', { hours: status.keepHours })}
              </dd>
            </div>
          </dl>

          <p className="mt-2 text-xs text-foreground-muted">
            {t('panel.inbox.hint')}
          </p>

          {staging > 0 ? (
            <p className="mt-1 text-xs text-foreground-muted">
              {t('panel.inbox.staging', { bytes: formatInboxBytes(status.stagingBytes ?? 0), count: status.stagingFiles ?? 0 })}
            </p>
          ) : null}

          {/* 自动清理：默认关。它管的是「宿主每次启动顺手清一次」，与下面那颗按钮是两件事 ——
              那颗是用户当场按的，不受开关管。默认关的理由写在 lib/mobile/inbox-clean.js 的文件头：
              没有人在场时替你删盘，得是你明确打开过的开关。 */}
          <label className="mt-3 flex items-start justify-between gap-4 border-t border-border-muted pt-3">
            <span className="min-w-0">
              <span className="block text-sm text-foreground">{t('panel.inbox.auto')}</span>
              <span className="mt-0.5 block text-xs text-foreground-muted">
                {t('panel.inbox.autoHint', { hours: status.keepHours })}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {savingAuto ? <Spinner /> : null}
              <Switch
                size="md"
                checked={status.autoClear === true}
                disabled={busy || savingAuto}
                onCheckedChange={(next) => void flipAuto(next)}
                aria-label={t('panel.inbox.autoA11y')}
              />
            </span>
          </label>

          <div className="mt-3 flex justify-end">
            <Button variant={deletable > 0 ? 'primary' : 'outline'} size="md" disabled={busy} onClick={() => void clear()}>
              {busy ? t('panel.inbox.clearing') : t('panel.inbox.clear')}
            </Button>
          </div>
        </>
      ) : null}
    </Card>
  )
}

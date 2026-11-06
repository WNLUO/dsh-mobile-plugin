/**
 * Tailcat 隧道（手机直连隧道）的管理弹窗。
 *
 * 入口是「连接状态」卡里那行 Tailcat 右侧的「管理」。这扇窗只做三件事：
 *   1. 把隧道此刻通没通、地址是多少摆出来（只读，读数来自 `/api/relay/tailcat`）；
 *   2. 一颗总开关 —— 关掉就是停掉整条通道（已建立的连接一并断开），别的通道不受影响；
 *   3. 把某台手机从白名单里摘掉（隧道那一层只认 WireGuard 公钥，和移动端凭据是两套）。
 *
 * 它自己按 2 秒一轮刷新（与主页那份 3 秒状态同节奏）：开窗期间开了配对窗口、外面又有手机
 * 报名时，`paired` 会变，不刷新就会显示旧数。动作成功后立刻重拉一次，别等下一轮。
 */
import { Button } from '@appica/ui-react/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@appica/ui-react/dialog'
import { Spinner } from '@appica/ui-react/spinner'
import { Switch } from '@appica/ui-react/switch'
import { useCallback, useEffect, useState } from 'react'

import { apiGet, apiPost, errorText, type TailcatStatus, type TailcatView } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'
import { useNotify } from '../lib/notify.ts'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 动作之后通知外层刷新一次 `/api/relay/status`（右上角那颗连接卡也跟着变）。 */
  onChanged?: () => void
}

/** 状态 → 一行字的键（与连接卡那行同一套口径）。 */
function statusTextKey(status: TailcatStatus): string {
  if (!status.available) return 'panel.tailcat.unavailable'
  if (!status.enabled) return 'panel.tailcat.disabled'
  if (status.error) return 'panel.tailcat.error'
  if (status.ready) return 'panel.tailcat.ready'
  return 'panel.tailcat.starting'
}

/** 公钥只露前几位：它是密钥材料，整串铺在界面上没有意义，也容易被截图带走。 */
function shortKey(client: string): string {
  return client.length > 16 ? `${client.slice(0, 12)}…${client.slice(-4)}` : client
}

export function TailcatDialog({ open, onOpenChange, onChanged }: Props) {
  const notify = useNotify()
  const [view, setView] = useState<TailcatView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try {
      setView(await apiGet<TailcatView>('/api/relay/tailcat'))
      setError('')
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  useEffect(() => {
    if (!open) return undefined
    const tick = () => {
      if (document.hidden) return
      void load()
    }
    tick()
    const timer = window.setInterval(tick, 2000)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [open, load])

  const run = useCallback(
    async (label: string, action: () => Promise<TailcatView>, done: string) => {
      setBusy(label)
      try {
        setView(await action())
        notify('soft', done)
        onChanged?.()
      } catch (err) {
        notify('error', errorText(err))
      } finally {
        setBusy('')
      }
    },
    [notify, onChanged],
  )

  const toggle = (enabled: boolean) =>
    void run(
      'toggle',
      () => apiPost<TailcatView>('/api/relay/tailcat/enabled', { enabled }),
      t(enabled ? 'panel.tailcat.enabledToast' : 'panel.tailcat.disabledToast'),
    )

  const revoke = (client: string) => {
    if (!window.confirm(t('panel.tailcat.revokeConfirm'))) return
    void run(
      'revoke',
      () => apiPost<TailcatView>('/api/relay/tailcat/revoke', { client }),
      t('panel.tailcat.revokedToast'),
    )
  }

  const status = view?.status ?? null
  const allowed = view?.allowedClients ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('panel.tailcat.title')}</DialogTitle>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3">
          <p className="text-xs leading-5 text-foreground-muted">{t('panel.tailcat.hint')}</p>

          {error ? <p className="text-xs text-error">{error}</p> : null}

          {view === null ? (
            <div className="flex items-center gap-2 py-2 text-sm text-foreground-muted">
              <Spinner />
              {t('panel.shell.readingStatus')}
            </div>
          ) : status === null ? (
            <p className="text-sm text-foreground-muted">{t('panel.tailcat.unavailable')}</p>
          ) : (
            <>
              <div className="flex items-baseline justify-between gap-4 border-b border-border-muted py-2">
                <span className="shrink-0 text-sm text-foreground-muted">{t('panel.tailcat.title')}</span>
                <span className="min-w-0 text-right text-sm break-all">
                  {t(statusTextKey(status))}
                  {status.error ? <span className="ml-1 text-xs text-foreground-muted">{status.error}</span> : null}
                </span>
              </div>

              <div className="flex items-baseline justify-between gap-4 border-b border-border-muted py-2">
                <span className="shrink-0 text-sm text-foreground-muted">{t('panel.tailcat.addressLabel')}</span>
                <span className="min-w-0 text-right font-mono text-xs break-all text-foreground-strong">
                  {status.address || t('panel.tailcat.noAddress')}
                </span>
              </div>

              <label className="flex items-center justify-between gap-4 border-b border-border-muted py-2">
                <span className="text-sm text-foreground-muted">{t('panel.tailcat.enableLabel')}</span>
                <Switch
                  size="md"
                  checked={status.enabled}
                  disabled={!status.available || busy !== ''}
                  onCheckedChange={(next) => toggle(next)}
                  aria-label={t('panel.tailcat.enableLabel')}
                />
              </label>

              <div className="flex flex-col gap-1">
                <span className="text-sm text-foreground-muted">
                  {t('panel.tailcat.pairedLabel')} ({status.paired})
                </span>
                {allowed.length === 0 ? (
                  <span className="text-xs text-foreground-muted">{t('panel.tailcat.noClients')}</span>
                ) : (
                  <ul className="flex flex-col">
                    {allowed.map((client) => (
                      <li
                        key={client}
                        className="flex items-center justify-between gap-3 border-b border-border-muted py-1.5 last:border-b-0"
                      >
                        <span className="min-w-0 font-mono text-xs break-all text-foreground-strong">{shortKey(client)}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy !== ''}
                          onClick={() => revoke(client)}
                        >
                          {t('panel.tailcat.revoke')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </DialogBody>

        <DialogFooter className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy !== ''} onClick={() => onOpenChange(false)}>
            {t('panel.common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

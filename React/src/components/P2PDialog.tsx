/**
 * 点对点隧道（P2P）的管理弹窗。
 *
 * 入口是「连接状态」卡里那行 P2P 隧道右侧的「管理」。与 Tailcat 那扇窗刻意不同 ——
 * 这条通道**没有白名单、也没有总开关**：能连上的前提就是两端私钥对得上，比白名单更直接；
 * 开关那件事交给手机侧的档位（`channelMode`），电脑这边不替人做决定。所以这扇窗只有
 * 四件只读事实，没有任何动作按钮：
 *   1. 它起没起、**打通了没有**（`path` 只可能是 direct / failed / unknown）；
 *   2. 本机在隧道里的那个地址（手机进来的落点）；
 *   3. 电脑自己的打洞候选 —— 手机靠它知道往哪打，不通的时候第一眼就该看这一行；
 *   4. 电脑这把公钥（开码时给手机的就是它）。
 *
 * 「打不通」绝不改口成「已连通」：这条没有中继可以退，说通了就是真的通了。
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
import { useCallback, useEffect, useState } from 'react'

import { apiGet, errorText, type P2PStatus } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * 状态 → 一行字的键。
 *
 * 顺序有讲究：**先看通没通，再看起没起**。一条已经在跑、而且打洞真的打穿了的通道，
 * 这一行必须是「已打通」—— 这与 Tailcat 那扇窗按 `ready` 说话的次序不同，因为这条
 * 通道「起来了」并不等于「通了」（起来只代表本机这半边准备好了）。
 */
function statusTextKey(status: P2PStatus): string {
  if (!status.available) return 'panel.p2p.unavailable'
  if (!status.enabled) return 'panel.p2p.disabled'
  if (status.path === 'direct' && status.active) return 'panel.p2p.open'
  if (status.error) return 'panel.p2p.error'
  if (status.path === 'failed') return 'panel.p2p.blocked'
  // `ready:false` 有两种完全不同的含义，别混：
  //  · 从没被手机叫起来过 → 是「等待手机接入」（电脑这半边本来就是等人来打）；
  //  · 叫起来过、但还没打穿 → 才是真的「正在打洞」。
  if (!status.ready) return status.started ? 'panel.p2p.punching' : 'panel.p2p.waiting'
  // 起来了之后，按助手报的那一步说话 —— **它是唯一知道「在打」还是「在等」的地方**。
  if (status.path === 'waiting') return 'panel.p2p.waiting'
  return 'panel.p2p.punching'
}

/** 公钥只露前几位：它是密钥材料，整串铺在界面上没有意义，也容易被截图带走。 */
function shortKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 12)}…${key.slice(-4)}` : key
}

export function P2PDialog({ open, onOpenChange }: Props) {
  const [view, setView] = useState<P2PStatus | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const reply = await apiGet<{ ok: boolean; status: P2PStatus | null }>('/api/relay/p2p')
      setView(reply.status ?? null)
      setError('')
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  // 与 Tailcat 那扇窗同一个节奏（2 秒一轮）：打洞是异步的，不刷新就永远停在「正在打洞」。
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

  // 显式收窄：`view === null` 那一支已经画了「正在读取」，下面这一整块都按非空用。
  const status = view

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('panel.p2p.title')}</DialogTitle>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3">
          <p className="text-xs leading-5 text-foreground-muted">{t('panel.p2p.hint')}</p>

          {error ? <p className="text-xs text-error">{error}</p> : null}

          {status === null ? (
            <div className="flex items-center gap-2 py-2 text-sm text-foreground-muted">
              <Spinner />
              {t('panel.shell.readingStatus')}
            </div>
          ) : (
            <>
              <div className="flex items-baseline justify-between gap-4 border-b border-border-muted py-2">
                <span className="shrink-0 text-sm text-foreground-muted">{t('panel.p2p.stateLabel')}</span>
                <span className="min-w-0 text-right text-sm break-all">
                  {t(statusTextKey(status))}
                  {status.error ? <span className="ml-1 text-xs text-foreground-muted">{status.error}</span> : null}
                </span>
              </div>

              <div className="flex items-baseline justify-between gap-4 border-b border-border-muted py-2">
                <span className="shrink-0 text-sm text-foreground-muted">{t('panel.p2p.addressLabel')}</span>
                <span className="min-w-0 text-right font-mono text-xs break-all text-foreground-strong">
                  {status.url || t('panel.p2p.noAddress')}
                </span>
              </div>

              <div className="flex flex-col gap-1 border-b border-border-muted py-2">
                <span className="text-sm text-foreground-muted">
                  {t('panel.p2p.candidatesLabel')} ({status.candidates.length})
                </span>
                {status.candidates.length === 0 ? (
                  <span className="text-xs text-foreground-muted">{t('panel.p2p.noCandidates')}</span>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {status.candidates.map((candidate) => (
                      <li key={candidate} className="font-mono text-xs break-all text-foreground-strong">
                        {candidate}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="flex items-baseline justify-between gap-4 py-2">
                <span className="shrink-0 text-sm text-foreground-muted">{t('panel.p2p.keyLabel')}</span>
                <span className="min-w-0 text-right font-mono text-xs break-all text-foreground-strong">
                  {status.publicKey ? shortKey(status.publicKey) : t('panel.p2p.noKey')}
                </span>
              </div>
            </>
          )}
        </DialogBody>

        <DialogFooter className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('panel.common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 「连接自检」弹窗：四行明细（监听 / 隧道 / 防火墙 / 手机来过）+ 一颗「重新自检」。
 *
 * 开窗那一下才向宿主发请求（见 `lib/selfcheck.ts` 的文件头：查一次防火墙要在宿主上开一个
 * 子进程，绝不能跟着页面的状态轮询去拉）。弹窗里那颗按钮带 `?force=1`，让宿主跳过它自己的
 * 30 秒缓存重新问系统。
 *
 * 结论一句照宿主的 `verdict` 说；`unknown` 就是查不到 —— 这一行**不许**画成正常色。
 */
import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@appica/ui-react/alert'
import { Button } from '@appica/ui-react/button'
import { t } from '../lib/i18n/index.ts'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@appica/ui-react/dialog'
import { Spinner } from '@appica/ui-react/spinner'
import { useEffect } from 'react'

import { cn, timeText, toneText, tunnelText, tunnelTone } from '../lib/format.ts'
import {
  firewallRow,
  listeningText,
  mobileRow,
  verdictText,
  verdictTone,
  type SelfCheckView,
} from '../lib/selfcheck.ts'
import { InfoList, InfoRow, ToneValue } from './InfoRow.tsx'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  state: SelfCheckView
  /** 主页此刻报的「最近一次手机来过」：自检还没回来时这一行先用它，不至于空着。 */
  lastMobileAt?: number | undefined
}

export function SelfCheckDialog({ open, onOpenChange, state, lastMobileAt }: Props) {
  // 开窗 = 人主动要看，这时才发（缓存够新就直接用，不再开子进程）。
  // 只认 open 与那个稳定身份：`state` 这个对象每次渲染都是新的，挂上它会变成每渲染一次就查一次。
  useEffect(() => {
    if (open) state.ensure()
  }, [open, state.ensure])

  const check = state.data
  const firewall = firewallRow(check)
  const mobile = mobileRow(check, lastMobileAt)
  const tone = check ? verdictTone(check.verdict) : 'warn'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('panel.selfcheck.title')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {state.error ? (
            <Alert variant={state.missing ? 'warning' : 'error'}>
              <AlertIcon />
              <AlertTitle>
                {state.missing ? t('panel.selfcheck.unavailable') : t('panel.selfcheck.failed')}
              </AlertTitle>
              {state.missing ? null : <AlertDescription>{state.error}</AlertDescription>}
            </Alert>
          ) : null}

          {!check ? (
            state.checking ? (
              <div className="flex items-center gap-2 py-2 text-sm text-foreground-muted">
                <Spinner />
                {t('panel.selfcheck.checking')}
              </div>
            ) : null
          ) : (
            <>
              <p className={cn('text-sm', tone === 'ok' ? 'text-foreground' : toneText[tone])}>
                {verdictText(check.verdict)}
              </p>

              <InfoList>
                <InfoRow label={t('panel.connection.lan')}>
                  <ToneValue
                    tone={check.listening.state === 'listening' ? 'ok' : check.listening.state === 'error' ? 'error' : 'off'}
                    text={listeningText(check.listening.state)}
                    detail={t('panel.selfcheck.port', { port: check.listening.port })}
                  />
                </InfoRow>
                <InfoRow label={t('panel.connection.tunnel')}>
                  <ToneValue
                    tone={tunnelTone(check.tunnel.state)}
                    text={tunnelText(check.tunnel.state)}
                  />
                </InfoRow>
                <InfoRow label={t('panel.selfcheck.firewall')}>
                  <ToneValue tone={firewall.tone} text={firewall.text} detail={firewall.detail} />
                </InfoRow>
                <InfoRow label={t('panel.selfcheck.mobile')}>
                  <ToneValue tone={mobile.tone} text={mobile.text} detail={mobile.detail} />
                </InfoRow>
              </InfoList>

              <p className="text-xs text-foreground-muted">
                {t('panel.selfcheck.checkedAt', { time: timeText(check.checkedAt) })}
              </p>
            </>
          )}
        </DialogBody>
        <DialogFooter className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('panel.common.close')}
          </Button>
          <Button variant="primary" disabled={state.checking} onClick={state.refresh}>
            {state.checking ? t('panel.selfcheck.checking') : t('panel.selfcheck.recheck')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

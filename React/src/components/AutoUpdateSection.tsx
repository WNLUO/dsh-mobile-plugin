// 2026-11-20 用户要求：自动更新从「插件更新」卡挪到顶卡右列，做成带问号的标题段；关闭时二次确认。
/**
 * 顶卡右列的「自动更新」：标题 + 问号说明 + 一颗开关。
 *
 * 这一格原先长在「插件更新」卡里（2026-11-20 挪过来）：用户要它跟「自动上报网络地址」同列，
 * 说明收进问号弹窗，不再在卡里铺一句长话。
 *
 * 状态归宿主：`/api/relay/update/status` 报开关的现值，`/update/auto` 收这次改动。轮询与
 * 安装都在宿主里，这里只是把用户的选择递过去。**老宿主没有这两条路由时整块不画** —— 摆一颗
 * 点了没反应的开关比不摆更糟。
 *
 * **关掉要确认**（用户要求）：自动更新一关，新版本就不再自动装，页面也不会主动提醒，容易
 * 一停好几版。确认弹窗里说清这件事，并把「保持开启」摆在主位。
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

import { errorText } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'
import { useNotify } from '../lib/notify.ts'
import {
  DEFAULT_AUTO_INTERVAL_MS,
  updateAuto,
  updateStatus,
  type UpdateStatusView,
} from '../lib/relayUpdate.ts'
import { QuestionMark } from './QuestionMark.tsx'

export function AutoUpdateSection() {
  /** 宿主报的现值；null = 还没读到（老宿主没有这两条路由就一直是 null）。 */
  const [host, setHost] = useState<UpdateStatusView | null>(null)
  const [saving, setSaving] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [offOpen, setOffOpen] = useState(false)
  const notify = useNotify()

  useEffect(() => {
    let alive = true
    void updateStatus()
      .then((next) => {
        if (alive) setHost(next)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  /** 把这次改动交给宿主；失败就把开关拨回宿主那边的真实值，并且说清为什么。 */
  const commit = useCallback(async (next: boolean) => {
    setSaving(true)
    try {
      const result = await updateAuto(next)
      setHost((prev) => result.status ?? (prev ? { ...prev, autoUpdate: result.enabled } : prev))
      const minutes = Math.round((result.status?.autoIntervalMs ?? host?.autoIntervalMs ?? DEFAULT_AUTO_INTERVAL_MS) / 60000)
      notify('soft', result.enabled ? t('panel.update.autoOn', { minutes }) : t('panel.update.autoOff'))
    } catch (err) {
      notify('error', t('panel.update.autoToggleFailed', { message: errorText(err) }))
      try {
        setHost(await updateStatus())
      } catch {
        // 读不回来就先留着旧值，下次进页面重读。
      }
    } finally {
      setSaving(false)
    }
  }, [host?.autoIntervalMs, notify])

  if (!host) return null

  const enabled = host.autoUpdate === true
  const source = host.marketResult?.source ?? null
  // 本地来源（link: / file: / workspace:）装不动注册表版：开关照摆，但要说清它只记录选择。
  const localSource = source === 'linked' || source === 'file' || source === 'workspace'
  const minutes = Math.round((host.autoIntervalMs ?? DEFAULT_AUTO_INTERVAL_MS) / 60000)

  return (
    <div className="mt-1 border-t border-border-muted pt-3">
      <div className="flex items-center justify-between gap-4">
        <span className="flex min-w-0 items-center gap-1">
          <span className="text-sm text-foreground">{t('panel.update.autoUpdate')}</span>
          <button
            type="button"
            aria-label={t('panel.update.autoHelp')}
            title={t('panel.update.autoHelp')}
            className="shrink-0 cursor-pointer text-foreground-muted transition-colors duration-200 hover:text-foreground-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            onClick={() => setInfoOpen(true)}
          >
            <QuestionMark />
          </button>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {saving ? <Spinner /> : null}
          <Switch
            size="md"
            checked={enabled}
            disabled={saving}
            onCheckedChange={(next) => {
              if (next) void commit(true)
              else setOffOpen(true)
            }}
            aria-label={t('panel.update.autoUpdate')}
          />
        </span>
      </div>
      {localSource ? (
        <p className="mt-1 text-xs text-foreground-muted">{t('panel.update.autoLocalSource')}</p>
      ) : null}

      {/* 问号：这格到底怎么运转、以及它只对 npm 装的插件有效。 */}
      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="max-w-md" closeLabel={t('panel.common.close')}>
          <DialogHeader>
            <DialogTitle>{t('panel.update.autoUpdate')}</DialogTitle>
          </DialogHeader>
          <DialogBody className="whitespace-pre-line text-sm leading-6 text-foreground-muted">
            {t('panel.update.autoDetail', { minutes })}
          </DialogBody>
          <DialogFooter className="flex justify-end">
            <Button variant="outline" onClick={() => setInfoOpen(false)}>
              {t('panel.common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 关掉前的二次确认：主位给「保持开启」，别让人顺手把自动更新关了。 */}
      <Dialog open={offOpen} onOpenChange={setOffOpen}>
        <DialogContent className="max-w-md" closeLabel={t('panel.common.close')}>
          <DialogHeader>
            <DialogTitle>{t('panel.update.autoOffTitle')}</DialogTitle>
          </DialogHeader>
          <DialogBody className="text-sm leading-6 text-foreground-muted">
            {t('panel.update.autoOffBody')}
          </DialogBody>
          <DialogFooter className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setOffOpen(false)
                void commit(false)
              }}
            >
              {t('panel.update.autoOffConfirm')}
            </Button>
            <Button variant="primary" onClick={() => setOffOpen(false)}>
              {t('panel.update.autoOffKeep')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * 右栏「网页管理」卡：那两小时窗口现在还剩多久，以及随时关掉它。
 *
 * 这张卡是**开关唯一的收尾出口**（2026-11-02）：原先它在 DSH 设置菜单里那张薄卡上，设置
 * 那一项按用户要求去掉、改由侧边栏那颗手机图标开窗之后，人在面板里还得能看到「现在开着、
 * 什么时候到期、怎么立刻关」—— 否则一开就只能等两小时。
 *
 * 数据来自 `/api/relay/status` 的 `webAccess`（宿主每次轮询都会重算），开关打的是
 * `POST /api/relay/web-access`。窗口关着时远程读不到管理接口，这张卡自己也会跟着消失，
 * 这是预期的：那时候也没有东西可关。
 */
import { t } from '../lib/i18n/index.ts'
import { Button } from '@appica/ui-react/button'
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card'

import type { WebAccessState } from '../lib/api.ts'
import { timeText } from '../lib/format.ts'
import { InfoList, InfoRow } from './InfoRow.tsx'

type Props = {
  webAccess?: WebAccessState
  busy: string
  onToggle: (enabled: boolean) => void
}

export function WebAccessCard({ webAccess, busy, onToggle }: Props) {
  const enabled = webAccess?.enabled === true
  const expiresAt = typeof webAccess?.expiresAt === 'number' ? webAccess.expiresAt : 0

  return (
    <Card frame="solid">
      <CardHeader>
        <CardTitle>{t('panel.webAccess.title')}</CardTitle>
      </CardHeader>
      <InfoList>
        <InfoRow label={t('panel.webAccess.state')} tone={enabled ? 'ok' : 'off'}>
          {enabled ? t('panel.webAccess.expires', { time: timeText(expiresAt) }) : t('panel.webAccess.closed')}
        </InfoRow>
      </InfoList>
      <p className="mt-2 text-xs leading-5 text-foreground-muted">{t('panel.webAccess.hint')}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {enabled ? (
          <Button variant="outline" size="sm" disabled={busy === 'webAccess'} onClick={() => onToggle(false)}>
            {t('panel.webAccess.close')}
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled={busy === 'webAccess'} onClick={() => onToggle(true)}>
            {t('panel.webAccess.open')}
          </Button>
        )}
      </div>
    </Card>
  )
}

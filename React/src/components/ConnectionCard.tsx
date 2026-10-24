import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@appica/ui-react/alert'
import { t } from '../lib/i18n/index.ts'
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card'
import { Switch } from '@appica/ui-react/switch'
import * as React from 'react'

import type { StatusView } from '../lib/api.ts'
import { sidecarText, timeText, tunnelText, tunnelTone } from '../lib/format.ts'
import { InfoList, InfoRow, ToneValue } from './InfoRow.tsx'
import { RevealButton } from './RevealButton.tsx'

type Props = {
  status: StatusView
  busy: string
  onToggle: (enabled: boolean) => void
  onOpenLan: () => void
}

/**
 * 连接状态：把「远程控制」「概览」「连接状态」合成一张卡。
 *
 * 第一行就是总开关，后面全是此刻的只读事实（宿主给的字段，界面不改写）。
 * 隧道被中转拒绝时，把「为什么被拒、下一步做什么」摆在同一张卡里——
 * 那句英文原文（`1008 bad registration secret`）不指向任何可执行动作。
 *
 * 局域网那一行按用户要求退成一个「查看」按钮：地址可能有好几个（多网段），端口又是直连
 * 自己的配置，都塞进这一行的右半边只会把卡片挤变形，所以详情与配置一起放进
 * 「局域网直连」弹窗。这一行也不带状态点（用户要求）：点绿了点红了都只是告诉一半的话，
 * 通没通、为什么没通，都在弹窗里说。
 *
 * 「中转地址」这一行带眼睛、默认遮上：和配对卡里那一行是同一个值（都是中转服务器地址），
 * 配对卡上遮了、这里露着，遮了等于没遮。
 */
export function ConnectionCard({ status, busy, onToggle, onOpenLan }: Props) {
  const tunnel = status.tunnel
  const enabled = status.enabled
  const [showRelay, setShowRelay] = React.useState(false)

  return (
    <Card frame="solid">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span>{t('panel.connection.state')}</span>
          <Badge variant={enabled ? 'success' : 'secondary'} size="sm">
            {enabled ? t('panel.connection.enabled') : t('panel.connection.disabled')}
          </Badge>
        </CardTitle>
      </CardHeader>

      <label className="flex items-center justify-between gap-4 border-b border-border-muted py-3">
        <span className="text-sm text-foreground-muted">{t('panel.connection.remoteControl')}</span>
        <Switch
          size="md"
          checked={enabled}
          disabled={busy !== ''}
          onCheckedChange={(next) => onToggle(next)}
          aria-label={t('panel.connection.remoteControl')}
        />
      </label>

      <InfoList>
        <InfoRow label={t('panel.connection.pluginVersion')} mono>
          {status.appVersion || '—'}
        </InfoRow>
        <InfoRow label={t('panel.connection.deviceName')}>{status.name || '—'}</InfoRow>
        <InfoRow label={t('panel.connection.instanceId')} mono>
          {status.instanceId || '—'}
        </InfoRow>
        <InfoRow label={t('panel.connection.platform')}>
          {status.platform} {status.osVersion} · {status.arch}
        </InfoRow>
        <InfoRow label={t('panel.connection.relayUrl')}>
          <span className="inline-flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
            {showRelay ? (
              <span className="min-w-0 font-mono text-xs text-foreground-strong">{status.relayUrl || '—'}</span>
            ) : (
              <span className="text-xs text-foreground-subtle">{t('panel.common.hide')}</span>
            )}
            <RevealButton
              on={showRelay}
              what={t('panel.connection.relayUrl')}
              label={showRelay ? t('panel.common.hide') : t('panel.common.show')}
              onClick={() => setShowRelay((on) => !on)}
            />
          </span>
        </InfoRow>
        <InfoRow
          label={t('panel.connection.tunnel')}
          tone={tunnelTone(tunnel.state)}
          {...(tunnel.state === 'error' && tunnel.error ? { 'data-error': tunnel.error } : {})}
        >
          <ToneValue
            tone={tunnelTone(tunnel.state)}
            text={tunnelText(tunnel.state)}
            {...(tunnel.error ? { detail: tunnel.error } : {})}
          />
        </InfoRow>
        <InfoRow label={t('panel.connection.lan')}>
          {/* 用户要求：这一行不再带状态点，只看那个「查看」按钮；通没通在弹窗里看。 */}
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== ''}
            onClick={onOpenLan}
            aria-label={t('panel.connection.viewLan')}
          >
            查看
          </Button>
        </InfoRow>
        <InfoRow label={t('panel.connection.sidecar')}>
          <ToneValue
            tone={status.sidecar.state === 'healthy' ? 'ok' : 'warn'}
            text={sidecarText(status.sidecar.state)}
            {...(status.sidecar.restarts > 0 ? { detail: t('panel.connection.sidecarRestarts', { count: status.sidecar.restarts }) } : {})}
          />
        </InfoRow>
        <InfoRow label={t('panel.connection.mirror')}>
          <ToneValue
            tone={status.mirror.ok ? 'ok' : status.mirror.error ? 'error' : 'warn'}
            text={status.mirror.ok ? t('panel.connection.mirrorOk') : t('panel.connection.mirrorOff')}
            detail={timeText(status.mirror.pushedAt)}
          />
        </InfoRow>
      </InfoList>

      <AdmissionNotice status={status} />
    </Card>
  )
}

/**
 * 隧道被拒的两种原因，各自给出**下一步动作**。
 * 注册密钥只存在于中转的部署参数里，中转不会通过任何接口公开它，
 * 所以这里只能如实说「向部署者索取」，不假装有自助路径。
 */
function AdmissionNotice({ status }: { status: StatusView }) {
  const hint = status.tunnel.admissionHint
  if (!hint) return null

  if (hint === 'register-secret') {
    return (
      <Alert variant="warning" className="mt-3">
        <AlertIcon />
        <AlertTitle>{t('panel.connection.relayNeedsSecret')}</AlertTitle>
        <AlertDescription>
          中转服务器开了准入，当前连接被拒绝。向中转的部署者索取注册密钥，填进上面的「中转配置 → 注册密钥」并保存。
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <Alert variant="warning" className="mt-3">
      <AlertIcon />
      <AlertTitle>{t('panel.connection.relayRejected')}</AlertTitle>
      <AlertDescription>
        中转开了实例白名单，而上面的实例 ID 不在名单里。把这个实例 ID 交给中转的部署者，让他加进 instances.json。
      </AlertDescription>
    </Alert>
  )
}

/**
 * 主页右栏「连接状态」卡：两颗开关（准入、远程控制）+ 只读事实 + 最后一行连接自检结论。
 *
 * 这一页的所有数字都来自宿主（`/api/relay/*`），界面不改写；自检那一行刻意不跟 3 秒轮询，
 * 见文件末尾组件注释与 `lib/selfcheck.ts`。
 */
import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@appica/ui-react/alert'
import { t } from '../lib/i18n/index.ts'
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card'
import { Switch } from '@appica/ui-react/switch'

import type { PairingPolicy, StatusView } from '../lib/api.ts'
import { cn, sidecarText, timeText, toneText, tunnelText, tunnelTone } from '../lib/format.ts'
import { selfCheckRow, type SelfCheckView } from '../lib/selfcheck.ts'
import { InfoList, InfoRow, ToneValue } from './InfoRow.tsx'

type Props = {
  status: StatusView
  busy: string
  onToggle: (enabled: boolean) => void
  /** 准入总闸（`status.pairingPolicy`）：`'code'` 收新设备、`'deny'` 一律拒。 */
  onChangePolicy: (policy: PairingPolicy) => void
  onOpenLan: () => void
  /**
   * 连接自检（`GET /api/relay/selfcheck`）：卡片最后那一行读它。
   *
   * 这一行的数据**不跟着上面那 3 秒轮询走**（查一次防火墙要在宿主上开一个子进程）——
   * 只在开弹窗、或手机三十分钟没来过时后台补一次，见 `lib/selfcheck.ts`。
   */
  selfcheck: SelfCheckView
  onOpenSelfCheck: () => void
}

/**
 * 连接状态：把「准入开关」「远程控制」「概览」「连接状态」合成一张卡。
 *
 * 最上面两行是两颗开关：**允许新设备绑定**（这台电脑还收不收新手机）与**远程控制**
 * （这段隧道开不开）。准入那颗 2026-10-26 从「配对与二维码」上面搬进来（用户要求），
 * 形态与远程控制那颗一致 —— 一行标签 + 一颗开关，不带状态徽标、不带说明句：它读的就是
 * `status.pairingPolicy`，旁边再挂一句解释只会把面板撑长。
 *
 * 后面全是此刻的只读事实（宿主给的字段，界面不改写）。隧道被中转拒绝时，把「为什么被拒、
 * 下一步做什么」摆在同一张卡里 —— 那句英文原文（`1008 bad registration secret`）不指向
 * 任何可执行动作。
 *
 * 局域网那一行按用户要求退成一个「查看」按钮：地址可能有好几个（多网段），端口又是直连
 * 自己的配置，都塞进这一行的右半边只会把卡片挤变形，所以详情与配置一起放进
 * 「局域网直连」弹窗。这一行也不带状态点（用户要求）：点绿了点红了都只是告诉一半的话，
 * 通没通、为什么没通，都在弹窗里说。
 *
 * 卡片最后一行是**连接自检的结论**（`GET /api/relay/selfcheck`）：正常一行灰字、查不到黄、
 * 异常红，点开是四行明细与「重新自检」。它刻意不跟着上面那 3 秒轮询 —— 宿主查一次防火墙
 * 要开一个子进程，请求只在开弹窗或手机三十分钟没来过时发（见 `lib/selfcheck.ts`）。
 *
 * **中转地址不在这张卡里**（2026-10-26 用户要求删）：域名长的时候那一行会把「隐藏」那颗
 * 按钮顶下去，而左边的「配对与二维码」里本来就有同一个值 —— 两处摆同一个东西只是多一处
 * 会看错的地方。
 */
export function ConnectionCard({ status, busy, onToggle, onChangePolicy, onOpenLan, selfcheck, onOpenSelfCheck }: Props) {
  const tunnel = status.tunnel
  const enabled = status.enabled
  const pairingAllowed = status.pairingPolicy === 'code'
  const selfcheckRow = selfCheckRow(selfcheck)

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

      {/* 准入总闸：与下面那颗远程控制同形（一行标签 + 一颗开关），只是文案与取值不同。 */}
      <label className="flex items-center justify-between gap-4 border-b border-border-muted py-3">
        <span className="text-sm text-foreground-muted">{t('panel.devices.allowTitle')}</span>
        <Switch
          size="md"
          checked={pairingAllowed}
          disabled={busy !== ''}
          onCheckedChange={(next) => onChangePolicy(next ? 'code' : 'deny')}
          aria-label={t('panel.devices.allowTitle')}
        />
      </label>

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
            {t('panel.common.view')}
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
        {/* 最后一行就是「为什么连不上」的结论：正常一行灰字、查不到黄、异常红；
            点它看四行明细与重查。正常时也不藏起来 —— 连不上的人第一眼要能看见这一行。 */}
        <InfoRow label={t('panel.selfcheck.short')}>
          <button
            type="button"
            className={cn(
              'cursor-pointer text-xs underline-offset-2 hover:underline',
              toneText[selfcheckRow.tone],
            )}
            onClick={onOpenSelfCheck}
          >
            {selfcheckRow.text}
          </button>
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
          {t('panel.connection.relayNeedsSecretBody')}
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <Alert variant="warning" className="mt-3">
      <AlertIcon />
      <AlertTitle>{t('panel.connection.relayRejected')}</AlertTitle>
      <AlertDescription>
        {t('panel.connection.relayRejectedBody')}
      </AlertDescription>
    </Alert>
  )
}

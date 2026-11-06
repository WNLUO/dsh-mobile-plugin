/**
 * 主页右栏「连接状态」卡：远程控制一颗开关 + 只读事实。
 *
 * 这一页的所有数字都来自宿主（`/api/relay/*`），界面不改写；自检那一行刻意不跟 3 秒轮询，
 * 见文件末尾组件注释与 `lib/selfcheck.ts`。
 */
import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@appica/ui-react/alert'
import { t } from '../lib/i18n/index.ts'
import { Button } from '@appica/ui-react/button'
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card'
import { Switch } from '@appica/ui-react/switch'

import type { StatusView, TailcatStatus } from '../lib/api.ts'
import { sidecarText, timeText, tunnelText, tunnelTone, type Tone } from '../lib/format.ts'
import { InfoList, InfoRow, ToneValue } from './InfoRow.tsx'

type Props = {
  status: StatusView
  busy: string
  onToggle: (enabled: boolean) => void
  /** 「管理」那颗：打开 Tailcat 隧道的弹窗（查看 / 开关 / 移除手机）。 */
  onManageTailcat: () => void
}

/** 隧道此刻的状态 → 一行字的键。老宿主没有这一格时整行不画（见下面 `status.tailcat`）。 */
function tailcatTextKey(tailcat: TailcatStatus): string {
  if (!tailcat.available) return 'panel.tailcat.unavailable'
  if (!tailcat.enabled) return 'panel.tailcat.disabled'
  if (tailcat.error) return 'panel.tailcat.error'
  if (tailcat.ready) return 'panel.tailcat.ready'
  return 'panel.tailcat.starting'
}

function tailcatTone(tailcat: TailcatStatus): Tone {
  if (!tailcat.available || !tailcat.enabled) return 'off'
  if (tailcat.error) return 'error'
  if (tailcat.ready) return 'ok'
  return 'warn'
}

/**
 * 连接状态：把「远程控制」「概览」「连接状态」合成一张卡。
 *
 * 最上面那颗是**远程控制**（这段隧道开不开）：一行标签 + 一颗开关，不带状态徽标、不带说明句。
 * 「允许新设备绑定」（`status.pairingPolicy`）不在这儿 —— 它现在只留在「配对与二维码」的
 * 「配对策略」那行，同一件事一屏两颗开关只会让人猜该按哪颗。
 *
 * 后面全是此刻的只读事实（宿主给的字段，界面不改写）。隧道被中转拒绝时，把「为什么被拒、
 * 下一步做什么」摆在同一张卡里 —— 那句英文原文（`1008 bad registration secret`）不指向
 * 任何可执行动作。
 *
 * 「插件版本」与「局域网直连」两行**不在这张卡里**（2026-11-02 用户要求删）：版本号在上面的
 * 「插件更新」卡里已经有，「局域网直连」那行原本只是开弹窗的按钮，端口现在直接在「配对与
 * 二维码」里改（见 components/PortDialog.tsx），状态想看得去「连接自检」。
 *
 * 连接自检**不在这张卡里**（2026-11-02 用户要求）：那一行和配对卡右上角的「检查网络」是
 * 同一件事，一屏摆两处入口只会让人猜哪个才是真的。
 *
 * **中转地址不在这张卡里**（2026-10-26 用户要求删）：域名长的时候那一行会把「隐藏」那颗
 * 按钮顶下去，而左边的「配对与二维码」里本来就有同一个值 —— 两处摆同一个东西只是多一处
 * 会看错的地方。
 */
export function ConnectionCard({ status, busy, onToggle, onManageTailcat }: Props) {
  const tunnel = status.tunnel
  const enabled = status.enabled
  const tailcat = status.tailcat ?? null

  return (
    <Card frame="solid">
      <CardHeader>
        <CardTitle>{t('panel.connection.state')}</CardTitle>
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
        {tailcat ? (
          <InfoRow label={t('panel.tailcat.title')} tone={tailcatTone(tailcat)}>
            <span className="inline-flex flex-wrap items-center justify-end gap-x-2">
              <ToneValue
                tone={tailcatTone(tailcat)}
                text={t(tailcatTextKey(tailcat))}
                {...(tailcat.error ? { detail: tailcat.error } : {})}
              />
              <Button variant="ghost" size="sm" onClick={onManageTailcat}>
                {t('panel.tailcat.manage')}
              </Button>
            </span>
          </InfoRow>
        ) : null}
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

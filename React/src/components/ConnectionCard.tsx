// 2026-11-26 用户要求：撤掉局域网端口那行的编辑按钮；端口只读展示，逻辑与冲突修复入口不动。
// 复用现有状态行和按钮展示 FRP 运行、恢复与主动停用入口。
// 2026-11-20 用户要求：去掉「设备名」「实例 ID」两行与 TCP 直连的地址。
// 2026-11-22：会话镜像 ok=true 时带的「内容未变，跳过重复推送」是良性跳过，不再当错误挂感叹号。
// 2026-11-22：Cloudflare 兜底从网络配置弹窗挪到这里，在 TCP 直连行下新起一行，右侧挂「管理」开弹窗。
// 等待端口时带出局域网那头的真实错误，不把端口没起来说成 Cloudflare 不可用。
/**
 * 主页右栏「连接状态」卡：只读事实。
 *
 * 这一页的所有数字都来自宿主（`/api/relay/*`），界面不改写。
 */
import { t } from '../lib/i18n/index.ts'
import { Button } from '@appica/ui-react/button'
import { Card } from '@appica/ui-react/card'

import type { AddressBook, CloudflareStatus, P2PStatus, StatusView, TailcatStatus } from '../lib/api.ts'
import { sidecarText, timeText, tunnelText, tunnelTone, type Tone } from '../lib/format.ts'
import { InfoList, InfoRow, ToneValue } from './InfoRow.tsx'
import { IssueMark, type Issue } from './IssueMark.tsx'
import { connectionFeedbackFacts } from '../lib/feedback-diagnostics.ts'

type Props = {
  status: StatusView
  /** 地址库：TCP 直连这条要从里面读配置的 `manualTcp`（状态接口不带它）。 */
  addressBook: AddressBook | null
  /** 2026-11-23 从配对卡挪来：端口与版本，都是只读展示。 */
  port: number
  portAdjusted?: boolean
  version: string
  versionIssues: Issue[]
  busy: string
  onStopFrp: () => void
  /** 「管理」那颗：打开 Tailcat 隧道的弹窗（查看 / 开关 / 移除手机）。 */
  onManageTailcat: () => void
  /** 「管理」那颗：打开 P2P 隧道的弹窗（只读现场）。 */
  onManageP2P: () => void
  /** 「管理」那颗：打开 Cloudflare 兜底隧道的弹窗（查看 / 开关）。 */
  onManageCloudflare: () => void
  /** 上次重启 sidecar 的失败原因；并入「旁挂进程」那行显示，不单独铺一块告警。 */
  restartError: string | null
}

/** 隧道此刻的状态 → 一行字的键。老宿主没有这一格时整行不画（见下面 `status.tailcat`）。 */
function tailcatTextKey(tailcat: TailcatStatus): string {
  if (!tailcat.available) return 'panel.tailcat.unavailableShort'
  if (!tailcat.enabled) return 'panel.tailcat.disabled'
  if (tailcat.error) return 'panel.tailcat.error'
  if (tailcat.ready) return 'panel.tailcat.ready'
  return 'panel.tailcat.starting'
}

/**
 * P2P 那一行字。
 *
 * **先看通没通、再看起没起**：这条通道起来只代表本机这半边准备好了，通了才是通了。
 * 与上面 Tailcat 那条按 `ready` 说话的次序刻意不同 —— 那条起来了就基本等于能用。
 */
function p2pTextKey(p2p: P2PStatus): string {
  if (!p2p.available) return 'panel.p2p.unavailableShort'
  if (!p2p.enabled) return 'panel.p2p.disabled'
  if (p2p.path === 'direct' && p2p.active) return 'panel.p2p.open'
  if (p2p.error) return 'panel.p2p.error'
  if (p2p.path === 'failed') return 'panel.p2p.blocked'
  if (!p2p.ready) return p2p.started ? 'panel.p2p.punching' : 'panel.p2p.waiting'
  if (p2p.path === 'waiting') return 'panel.p2p.waiting'
  return 'panel.p2p.punching'
}

function p2pTone(p2p: P2PStatus): Tone {
  if (!p2p.available || !p2p.enabled) return 'off'
  if (p2p.path === 'direct' && p2p.active) return 'ok'
  if (p2p.error || p2p.path === 'failed') return 'error'
  return 'warn'
}

function tailcatTone(tailcat: TailcatStatus): Tone {
  if (!tailcat.available || !tailcat.enabled) return 'off'
  if (tailcat.error) return 'error'
  if (tailcat.ready) return 'ok'
  return 'warn'
}

/**
 * Cloudflare 兜底那一行字。
 *
 * 顺序：先看可不可用，再看错没错，再看跑没跑、起来中，最后才落到「未启用 / 可用」。
 * 这条兜底没有中间态可以含糊：cloudflared 没装就是整条不可用，跑了就是运行中。
 */
function cloudflareTextKey(cf: CloudflareStatus | null): string {
  if (!cf || !cf.available) return 'panel.cloudflare.unavailable'
  if (cf.error) return 'panel.cloudflare.error'
  if (cf.running) return 'panel.cloudflare.running'
  if (cf.starting || cf.retrying || cf.waitingForPort) return 'panel.cloudflare.starting'
  if (!cf.enabled) return 'panel.cloudflare.disabled'
  return 'panel.cloudflare.available'
}

function cloudflareTone(cf: CloudflareStatus | null): Tone {
  if (!cf || !cf.available) return 'off'
  if (cf.error) return 'error'
  if (cf.running) return 'ok'
  if (cf.starting || cf.retrying || cf.waitingForPort) return 'warn'
  return 'off'
}

/**
 * 连接状态：把「概览」「连接状态」合成一张卡。
 *
 * 「远程控制」那颗开关（这段隧道开不开）与「允许配对」都已搬到「配对与二维码」的右列，
 * 这里只剩此刻的只读事实（宿主给的字段，界面不改写）。隧道被中转拒绝时，把「为什么被拒、
 * 下一步做什么」摆在同一张卡里 —— 那句英文原文（`1008 bad registration secret`）不指向
 * 任何可执行动作。
 *
 * 「局域网端口」与「运行中版本」两行 2026-11-23 由用户从配对卡挪到这里：它们本来就是只读
 * 事实，和这张卡其余各行放一起更顺。端口那颗编辑按钮 2026-11-26 按用户要求撤掉，
 * 这里只报端口数；端口被占时的修复入口仍在端口冲突弹窗里。
 *
 * **中转地址不在这张卡里**（2026-10-26 用户要求删）：域名长的时候那一行会把「隐藏」那颗
 * 按钮顶下去，而左边的「配对与二维码」里本来就有同一个值 —— 两处摆同一个东西只是多一处
 * 会看错的地方。
 */
export function ConnectionCard({ status, addressBook, busy, port, portAdjusted, version, versionIssues, onStopFrp, onManageTailcat, onManageP2P, onManageCloudflare, restartError }: Props) {
  const tunnel = status.tunnel
  const tailcat = status.tailcat ?? null
  const p2p = status.p2p ?? null
  const cloudflare = status.cloudflare ?? null
  /** TCP 直连配没配、配的哪条：宿主把它放在地址库的 `manualTcp`（状态接口里没有这一格）。 */
  const tcpTarget = (addressBook?.manualTcp ?? '').trim()
  // 本地 frpc 进程跑没跑（宿主 status.frp）。配了地址不等于通了——只有进程真在跑才算这条活了。
  const frp = status.frp ?? null
  // FRP 的三种「有东西」：已启用（老宿主缺 enabled 时按 configPresent 认）、正在动、仅导入了配置。
  const frpEnabled = frp?.enabled === true || (frp?.enabled === undefined && frp?.configPresent === true)
  const frpConfigured = frp?.configPresent === true || frpEnabled || Boolean(frp?.running || frp?.starting || frp?.retrying)
  // 这一行不摆地址（2026-11-20 用户要求删）：公网 IP 与端口在面板上念一遍没有用途，要查去网络配置里看。
  // 「TCP 直连」与 FRP 是两条不同的线路（2026-11-23 用户口径）：前者的地址是用户手填的，
  // 后者是本机 frpc 分到的公网地址，各自一行，不再合在一格里。
  const tcpTone: Tone = tcpTarget ? 'ok' : 'off'
  const tcpText = tcpTarget ? t('panel.connection.tcpManual') : t('panel.connection.tcpOff')
  let frpTone: Tone
  let frpText: string
  if (frp?.running) {
    frpTone = 'ok'
    frpText = t('panel.connection.tcpRunning')
  } else if (frp?.starting || frp?.retrying) {
    frpTone = 'warn'
    frpText = t('panel.frp.retrying')
  } else if (frp?.error) {
    frpTone = 'error'
    frpText = t('panel.connection.tcpFailed')
  } else if (frpEnabled) {
    // 有 FRP、已启用，但这一刻没跑起来（既不在启动中也没报错）。
    frpTone = 'warn'
    frpText = t('panel.connection.tcpEnabledNotRunning')
  } else {
    // 只导入了 FRP 配置、还没启用：它没在跑，也没有「停止」可点。
    frpTone = 'off'
    frpText = t('panel.connection.tcpSet')
  }

  return (
    <Card frame="solid">
      <InfoList>
        <InfoRow label={t('panel.connection.platform')}>
          {status.platform} {status.osVersion} · {status.arch}
        </InfoRow>
        <InfoRow label={t('panel.pairing.port')} mono nowrap>
          <span className="inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
            <span>
              {port}
              {portAdjusted ? (
                <span className="ml-2 font-sans text-xs text-foreground-muted">{t('panel.pairing.portFallback')}</span>
              ) : null}
            </span>
          </span>
        </InfoRow>
        <InfoRow
          label={t('panel.update.runningVersion')}
          mono
          labelExtra={versionIssues.length > 0 ? <IssueMark issue={versionIssues[0]} /> : undefined}
        >
          {version || t('panel.update.unknownVersion')}
        </InfoRow>
        <InfoRow
          label={t('panel.connection.tunnel')}
          tone={tunnelTone(tunnel.state)}
          labelExtra={tunnel.error ? <IssueMark issue={{ facts: connectionFeedbackFacts(status), title: t('panel.connection.tunnel'), detail: tunnel.error }} /> : undefined}
        >
          <ToneValue tone={tunnelTone(tunnel.state)} text={tunnelText(tunnel.state)} />
        </InfoRow>
        {tailcat ? (
          <InfoRow
            label={t('panel.tailcat.title')}
            tone={tailcatTone(tailcat)}
            labelExtra={(!tailcat.available || tailcat.error)
              ? <IssueMark issue={{ facts: connectionFeedbackFacts(status), title: t('panel.tailcat.title'), detail: !tailcat.available ? t('panel.tailcat.unavailable') : (tailcat.error ?? '') }} />
              : undefined}
          >
            <span className="inline-flex flex-wrap items-center justify-end gap-x-2">
              <ToneValue tone={tailcatTone(tailcat)} text={t(tailcatTextKey(tailcat))} />
              <Button variant="ghost" size="sm" onClick={onManageTailcat}>
                {t('panel.tailcat.manage')}
              </Button>
            </span>
          </InfoRow>
        ) : null}
        {p2p ? (
          <InfoRow
            label={t('panel.p2p.title')}
            tone={p2pTone(p2p)}
            labelExtra={(!p2p.available || p2p.error)
              ? <IssueMark issue={{ facts: connectionFeedbackFacts(status), title: t('panel.p2p.title'), detail: !p2p.available ? t('panel.p2p.unavailable') : (p2p.error ?? '') }} />
              : undefined}
          >
            <span className="inline-flex flex-wrap items-center justify-end gap-x-2">
              <ToneValue tone={p2pTone(p2p)} text={t(p2pTextKey(p2p))} />
              <Button variant="ghost" size="sm" onClick={onManageP2P}>
                {t('panel.p2p.manage')}
              </Button>
            </span>
          </InfoRow>
        ) : null}
        <InfoRow label={t('panel.connection.tcp')} tone={tcpTone}>
          <ToneValue tone={tcpTone} text={tcpText} />
        </InfoRow>
        {frpConfigured ? (
          <InfoRow
            label={t('panel.connection.frp')}
            tone={frpTone}
            labelExtra={frp?.error ? <IssueMark issue={{ facts: connectionFeedbackFacts(status), title: t('panel.connection.frp'), detail: frp.error }} /> : undefined}
          >
            <span className="inline-flex flex-wrap items-center justify-end gap-x-2">
              <ToneValue tone={frpTone} text={frpText} />
              {frp && (frp.enabled || frp.running || frp.starting || frp.retrying || (frp.enabled === undefined && frp.configPresent)) ? (
                <Button variant="ghost" size="sm" disabled={busy !== ''} onClick={onStopFrp}>{t('panel.frp.stop')}</Button>
              ) : null}
            </span>
          </InfoRow>
        ) : null}
        <InfoRow
          label={t('panel.cloudflare.title')}
          tone={cloudflareTone(cloudflare)}
          labelExtra={cloudflare && (!cloudflare.available || cloudflare.error)
            ? <IssueMark issue={{ facts: connectionFeedbackFacts(status), title: t('panel.cloudflare.title'), detail: !cloudflare.available ? t('panel.cloudflare.unavailable') : (cloudflare.error ?? '') }} />
            : undefined}
        >
          <span className="inline-flex flex-wrap items-center justify-end gap-x-2">
            <ToneValue tone={cloudflareTone(cloudflare)} text={t(cloudflareTextKey(cloudflare))}
              {...(cloudflare?.waitingForPort && status.lan?.error ? { detail: status.lan.error } : {})} />
            <Button variant="ghost" size="sm" onClick={onManageCloudflare}>
              {t('panel.tailcat.manage')}
            </Button>
          </span>
        </InfoRow>
        <InfoRow
          label={t('panel.connection.sidecar')}
          labelExtra={restartError ? <IssueMark issue={{ facts: connectionFeedbackFacts(status), title: t('panel.connection.sidecar'), detail: restartError }} /> : undefined}
        >
          <ToneValue
            tone={restartError || status.sidecar.state !== 'healthy' ? 'error' : 'ok'}
            text={restartError ? t('panel.pairing.sidecarRestartFailed') : sidecarText(status.sidecar.state)}
            {...(!restartError && status.sidecar.restarts > 0 ? { detail: t('panel.connection.sidecarRestarts', { count: status.sidecar.restarts }) } : {})}
          />
        </InfoRow>
        <InfoRow
          label={t('panel.connection.mirror')}
          labelExtra={status.mirror.ok === false ? <IssueMark issue={{ facts: connectionFeedbackFacts(status), title: t('panel.connection.mirror'), detail: status.mirror.error || '' }} /> : undefined}
        >
          <ToneValue
            tone={status.mirror.ok ? 'ok' : status.mirror.error ? 'error' : 'warn'}
            text={status.mirror.ok ? t('panel.connection.mirrorOk') : t('panel.connection.mirrorOff')}
            detail={timeText(status.mirror.pushedAt)}
          />
        </InfoRow>
      </InfoList>

      {status.lan.recovery?.state === 'awaiting-device' ? (
        <InfoList><InfoRow label={t('panel.connection.lan')}><ToneValue tone="warn" text={t('panel.connection.lanWaiting')} /></InfoRow></InfoList>
      ) : status.lan.recovery?.state === 'verified' ? (
        <InfoList><InfoRow label={t('panel.connection.lan')}><ToneValue tone="ok" text={t('panel.connection.lanVerified')} /></InfoRow></InfoList>
      ) : null}
      {status.lan.enabled && (status.lan.error || status.lan.discovery?.error) ? (
        <InfoList>
          <InfoRow
            label={t('panel.connection.lan')}
            labelExtra={<IssueMark issue={{ facts: connectionFeedbackFacts(status), title: t('panel.connection.lan'), detail: (status.lan.error || status.lan.discovery?.error) ?? '' }} />}
          >
            <ToneValue tone="warn" text={t('panel.lan.error')} />
          </InfoRow>
        </InfoList>
      ) : null}
      <AdmissionNotice status={status} />
    </Card>
  )
}

/**
 * 隧道被拒的两种原因，各自给出**下一步动作**。
 * 注册密钥只存在于中转的部署参数里，中转不会通过任何接口公开它的值，
 * 所以这里说「向部署者索取，填进网络配置的自建中转那栏」——不假装有读出密钥的捷径。
 */
function AdmissionNotice({ status }: { status: StatusView }) {
  const hint = status.tunnel.admissionHint
  if (!hint) return null

  if (hint === 'register-secret') {
    return (
      <InfoList>
        <InfoRow label={t('panel.connection.relayNeedsSecret')}>
          <ToneValue tone="warn" text={t('panel.connection.relayNeedsSecret')} detail={t('panel.connection.relayNeedsSecretBody')} />
        </InfoRow>
      </InfoList>
    )
  }

  return (
    <InfoList>
      <InfoRow label={t('panel.connection.relayRejected')}>
        <ToneValue tone="warn" text={t('panel.connection.relayRejected')} detail={t('panel.connection.relayRejectedBody')} />
      </InfoRow>
    </InfoList>
  )
}

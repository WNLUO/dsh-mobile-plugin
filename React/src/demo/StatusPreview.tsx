/**
 * 演示页里的「通没通」对照稿：把引导页底部那块（直连 / 防火墙两行，加上出问题时那句总结）
 * 的几种留法摆在一起，用来定「哪几行留、哪句收走、句子怎么改」。
 *
 * 只活在开发服务器里（演示页带 `?scene=status`），不进正式产物、也不碰真宿主：数据是这里
 * 写死的一份 `SelfCheck`，切状态只是换这一个对象；下面几块用的仍是面板自己的组件与文案，
 * 所以看到的配色、字号、断行跟线上一致。
 */
import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@appica/ui-react/alert'
import { Button } from '@appica/ui-react/button'
import { useState } from 'react'

import { InfoList, InfoRow, ToneValue } from '../components/InfoRow.tsx'
import type { SelfCheck, SelfCheckVerdict } from '../lib/api.ts'
import { lanText, lanTone, toneText, tunnelText, tunnelTone } from '../lib/format.ts'
import { t } from '../lib/i18n/index.ts'
import { firewallRow, verdictBrief, verdictText, verdictTone } from '../lib/selfcheck.ts'

type Mode = 'lan' | 'relay'
type Variant = 'current' | 'brief' | 'green' | 'hidden'

const STATES: { value: SelfCheckVerdict; label: string }[] = [
  { value: 'ok', label: '一切正常' },
  { value: 'not-listening', label: '直连没监听' },
  { value: 'firewall-blocked', label: '防火墙挡住' },
  { value: 'unknown', label: '防火墙查不到' },
  { value: 'network', label: '手机没来过' },
]

const VARIANTS: { value: Variant; title: string; note: string }[] = [
  {
    value: 'current',
    title: 'A · 现状',
    note: '两行状态；出问题时下面补一句长句，正常时不出句子。线上现在就是这套。',
  },
  {
    value: 'brief',
    title: 'B · 换成短句',
    note: '两行不变，出问题时那句长句换成一行短句（主页那张连接卡用的就是短句）。',
  },
  {
    value: 'green',
    title: 'C · 正常时收成一行',
    note: '一切正常时整块只剩一行绿字「一切正常」；有问题才展开两行 + 长句。',
  },
  {
    value: 'hidden',
    title: 'D · 这块整个收走',
    note: '这里什么都不放，只剩底部两颗按钮；要看细节点开「连接自检」弹窗。',
  },
]

const CHECKED_AT = new Date('2026-10-20T10:30:00+08:00').getTime()

/** 一份假的自检结果：只改跟选中的状态有关的那几格，其余保持「正常」。 */
function fixture(verdict: SelfCheckVerdict): SelfCheck {
  const listening = verdict === 'not-listening' ? 'off' : 'listening'
  const blocked = verdict === 'firewall-blocked'
  const unknown = verdict === 'unknown'
  const idle = verdict === 'network'
  return {
    ok: true,
    checkedAt: CHECKED_AT,
    platform: 'darwin',
    verdict,
    listening: {
      state: listening,
      port: 18787,
      urls: listening === 'listening' ? ['http://192.0.2.40:18787'] : [],
      portAdjusted: false,
    },
    tunnel: { state: 'connected', relayUrl: 'https://relay.example.com' },
    firewall: {
      supported: !unknown,
      enabled: unknown ? null : true,
      allowsApp: unknown ? null : !blocked,
      appPath: '/opt/homebrew/Cellar/node/26.8.1/bin/node',
      reason: unknown ? 'unsupported' : null,
    },
    mobile: {
      lastMobileAt: idle ? 0 : CHECKED_AT - 4 * 60_000,
      idle,
    },
  }
}

/** 那两行清单；`mode` 决定第一行是「直连」还是「中转」。 */
function StatusRows({ check, mode }: { check: SelfCheck; mode: Mode }) {
  const firewall = firewallRow(check)
  return (
    <InfoList>
      {mode === 'lan' ? (
        <InfoRow label={t('panel.onboarding.direct')}>
          <ToneValue
            tone={lanTone(check.listening.state, true)}
            text={lanText(check.listening.state, true)}
          />
        </InfoRow>
      ) : (
        <InfoRow label={t('panel.connection.tunnel')}>
          <ToneValue tone={tunnelTone(check.tunnel.state)} text={tunnelText(check.tunnel.state)} />
        </InfoRow>
      )}
      <InfoRow label={t('panel.selfcheck.firewall')}>
        <ToneValue tone={firewall.tone} text={firewall.text} detail={firewall.detail} />
      </InfoRow>
    </InfoList>
  )
}

/** 出问题时那句结论：长句 / 短句。 */
function VerdictLine({ check, brief }: { check: SelfCheck; brief: boolean }) {
  return (
    <p
      className={`mt-2 text-sm leading-relaxed break-words ${toneText[verdictTone(check.verdict)]}`}
    >
      {brief ? verdictBrief(check.verdict) : verdictText(check.verdict)}
    </p>
  )
}

/** 直连起不来时那张红框（宿主把 `lan.state` 报成 error 才有，平时不出现）。 */
function ErrorAlert() {
  return (
    <Alert variant="error" className="mt-3">
      <AlertIcon />
      <AlertTitle>{t('panel.onboarding.lanFailed')}</AlertTitle>
      <AlertDescription>
        {t('panel.onboarding.lanErrorWithPort', { error: 'listen EADDRINUSE 127.0.0.1:18787' })}
      </AlertDescription>
    </Alert>
  )
}

/** 底部那两颗按钮：只摆样子，点了没反应（这一页不连真宿主）。 */
function ButtonRow() {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 pt-3">
      <Button variant="outline">下载 APP</Button>
      <Button variant="primary">{t('panel.onboarding.enterPlugin')}</Button>
    </div>
  )
}

function Block({
  variant,
  check,
  mode,
  showError,
}: {
  variant: Variant
  check: SelfCheck
  mode: Mode
  showError: boolean
}) {
  const ok = check.verdict === 'ok'
  const alert = showError ? <ErrorAlert /> : null

  if (variant === 'hidden') {
    return (
      <>
        {alert}
        <ButtonRow />
      </>
    )
  }

  if (variant === 'green') {
    return (
      <>
        {ok ? (
          <p className="py-1 text-sm text-success">一切正常</p>
        ) : (
          <>
            <StatusRows check={check} mode={mode} />
            <VerdictLine check={check} brief={false} />
          </>
        )}
        {alert}
        <ButtonRow />
      </>
    )
  }

  return (
    <>
      <StatusRows check={check} mode={mode} />
      {ok ? null : <VerdictLine check={check} brief={variant === 'brief'} />}
      {alert}
      <ButtonRow />
    </>
  )
}

export function StatusPreview() {
  const [verdict, setVerdict] = useState<SelfCheckVerdict>('firewall-blocked')
  const [mode, setMode] = useState<Mode>('lan')
  const [showError, setShowError] = useState(false)
  const check = fixture(verdict)

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold text-foreground-intense">
          引导页「通没通」这块怎么留
        </h1>
        <p className="text-sm text-foreground-muted">
          四种留法并排摆着，状态随便切。全是假数据，只调界面。
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-border-muted bg-background-muted px-3 py-2">
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-xs text-foreground-muted">状态</span>
          {STATES.map((item) => (
            <Button
              key={item.value}
              size="sm"
              variant={verdict === item.value ? 'primary' : 'outline'}
              onClick={() => setVerdict(item.value)}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-xs text-foreground-muted">报错框</span>
          <Button
            size="sm"
            variant={showError ? 'primary' : 'outline'}
            onClick={() => setShowError(!showError)}
          >
            {showError ? '显示中' : '不显示'}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-xs text-foreground-muted">怎么连</span>
          {(
            [
              { value: 'lan', label: '直连' },
              { value: 'relay', label: '中转' },
            ] as { value: Mode; label: string }[]
          ).map((item) => (
            <Button
              key={item.value}
              size="sm"
              variant={mode === item.value ? 'primary' : 'outline'}
              onClick={() => setMode(item.value)}
            >
              {item.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {VARIANTS.map((item) => (
          <section
            key={item.value}
            className="flex flex-col rounded-lg border border-border-muted bg-background-muted px-4 py-3"
          >
            <h2 className="text-sm font-semibold text-foreground-intense">{item.title}</h2>
            <p className="mt-1 text-xs leading-relaxed text-foreground-muted">{item.note}</p>
            <div className="mt-3 flex-1">
              <Block variant={item.value} check={check} mode={mode} showError={showError} />
            </div>
          </section>
        ))}
      </div>
    </main>
  )
}

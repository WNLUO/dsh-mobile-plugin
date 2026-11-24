// 用途：首次接入引导页；错误处可直接提交脱敏摘要与诊断附件，并回显反馈编号。
/**
 * 首次接入引导（一页）：宿主还没配过、或走 `/api/relay/panel/setup` 时进这一页。
 *
 * 2026-11-24 起不再默认把「公用中转」塞进配置：新用户得自己配一条能用的网络。这一页按地区
 * （默认看这台电脑的时区，可手动切）列出服务商，主推一家（国内 ZeroNews、国际 Cloudflare），
 * 点进去用各家自己的面板把它接好；**接好之后再放二维码**，手机扫了才能连。局域网直连照旧一起
 * 开着，在家同一 Wi-Fi 也能扫。兜底的隧道（Tailcat / Cloudflare / P2P）只当兜底，不再写公用中转。
 *
 * 服务商清单来自 `lib/onboarding-providers.tsx`，加一家只改那份注册表，不碰这一页。
 */
// 首次取码失败可重试，后台续码保留已有二维码；扫码绑定成功后进入插件主页。
import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@appica/ui-react/alert'
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { Card } from '@appica/ui-react/card'
import { CopyButton } from '@appica/ui-react/copy-button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@appica/ui-react/dialog'
import { Spinner } from '@appica/ui-react/spinner'
import { useEffect, useRef, useState } from 'react'

import { LanguageMenu } from './components/LanguageMenu.tsx'
import { PanelWindowActions } from './components/PanelWindowActions.tsx'
import { ConsoleThemeToggle } from './components/ThemeToggle.tsx'
import { connectionFeedbackFacts } from './lib/feedback-diagnostics.ts'
import { DownloadChannelsGrid } from './components/DownloadAppButton.tsx'
import { FirewallDialog } from './components/FirewallDialog.tsx'
import { InfoList, InfoRow, ToneValue } from './components/InfoRow.tsx'
import { PROVIDER_LOOK } from './components/ProviderLook.tsx'
import { QuestionMark } from './components/QuestionMark.tsx'
import { submitDirectFeedback } from './components/IssueMark.tsx'
import {
  apiGet,
  apiPost,
  cloudflareStart,
  errorText,
  jdxbStatus,
  pairingRenewIn,
  type AddressBook,
  type ConfigPatch,
  type PairingInfo,
  type StatusView,
} from './lib/api.ts'
import { cn, lanText, lanTone, toneText, tunnelText, tunnelTone, type Tone } from './lib/format.ts'
import {
  firewallRow,
  mobileLooksIdle,
  useSelfCheck,
  verdictText,
  verdictTone,
} from './lib/selfcheck.ts'
import { onboardingProvidersOf, regionHasReadyRoute, type OnboardingProvider } from './lib/onboarding-providers.tsx'
import type { NetworkRegion } from './lib/network-region.ts'
import { t } from './lib/i18n/index.ts'
import { pageVisible } from './lib/embed-visibility.ts'
import { usePairingCompletion } from './lib/usePairingCompletion.ts'

type Props = {
  /** 配好之后去哪。默认回插件主页。 */
  onDone?: () => void
}

/** 中国时区：这些时区默认按「国内」处理（只认 PRC 及港澳，别的一律当海外）。 */
const CN_TIMEZONES = /^Asia\/(Shanghai|Chongqing|Harbin|Urumqi|Kashgar|Hong_Kong|Macau)$/

/**
 * 这台电脑大概在哪个地区：按系统时区猜，猜错用户点一下就能切。
 * 只作为默认值 —— 页面上始终摆着「国内 / 国际」两颗，不靠它做任何不可逆的判断。
 */
function detectRegion(): NetworkRegion {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    return CN_TIMEZONES.test(tz) ? 'cn' : 'global'
  } catch {
    return 'global'
  }
}

/**
 * 二维码里用哪条局域网地址：宿主存过的还在清单里就用它，否则用宿主的第一条。
 */
function defaultPreferred(book: AddressBook): string {
  const saved = (book.preferred || '').trim()
  if (saved && book.lan.some((item) => item.address === saved)) return saved
  return book.lan[0]?.address ?? ''
}

/**
 * 接入引导。
 *
 * @param props.onDone 配好之后去哪
 */
export function Onboarding({ onDone }: Props) {
  const [status, setStatus] = useState<StatusView | null>(null)
  const [fatal, setFatal] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [connectionAttemptSettled, setConnectionAttemptSettled] = useState(false)
  const [addresses, setAddresses] = useState<AddressBook | null>(null)
  const [pairing, setPairing] = useState<PairingInfo | null>(null)
  const [pairingError, setPairingError] = useState('')
  const [preferred, setPreferred] = useState('')
  /** 当前地区：默认按系统时区猜，用户可切。 */
  const [region, setRegion] = useState<NetworkRegion>(detectRegion)
  /** 正在配置哪家服务商（null = 没开面板）；开了就把它自己那一页铺上来。 */
  const [providerOpen, setProviderOpen] = useState<OnboardingProvider['provider'] | null>(null)
  /** 节点小宝的外网地址：它不在 /status 里，只在国内时单独读，用来判「这条接好了没有」。 */
  const [jdxbUrl, setJdxbUrl] = useState('')
  const [firewallOpen, setFirewallOpen] = useState(false)
  const [qrZoomOpen, setQrZoomOpen] = useState(false)
  const [tailcatOpen, setTailcatOpen] = useState(false)
  const [copied, setCopied] = useState('')
  const [feedbackBusy, setFeedbackBusy] = useState<Record<string, boolean>>({})
  const [feedbackKeys, setFeedbackKeys] = useState<Record<string, string>>({})
  const [feedbackSummaries, setFeedbackSummaries] = useState<Record<string, string>>({})
  const [feedbackErrors, setFeedbackErrors] = useState<Record<string, string>>({})

  const selfcheck = useSelfCheck(
    mobileLooksIdle(status?.lastMobileAt),
    status ? `${status.enabled ? 1 : 0}|${status.lan.enabled ? 1 : 0}|${status.lan.state}|${status.tunnel.state}|${(status.lastMobileAt ?? 0) > 0 ? 1 : 0}` : '',
  )
  const firewallInfo = firewallRow(selfcheck.data)
  const selfcheckVerdict = selfcheck.data?.verdict ?? ''

  /** 轮询要能被卸载打断，否则关掉页面后它还在打接口。 */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // 与主页同样每三秒读状态；服务商接好、二维码可选之后就不再重取。
  useEffect(() => {
    let active = true
    const tick = async () => {
      if (!pageVisible()) return
      try {
        const current = await apiGet<StatusView>('/api/relay/status')
        if (active) setStatus(current)
      } catch {
        /* 临时读取失败不打断扫码，下一轮继续。 */
      }
    }
    const timer = window.setInterval(() => void tick(), 3000)
    document.addEventListener('visibilitychange', tick)
    return () => {
      active = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [])

  usePairingCompletion(status?.lastPairingAt, () => {
    setQrZoomOpen(false)
    enterNow()
  })

  /** 地址清单：决定二维码里哪条局域网排最前，所以它先到、并且取不到不挡路。 */
  useEffect(() => {
    void (async () => {
      try {
        const book = await apiGet<AddressBook>('/api/relay/addresses')
        setAddresses(book)
        setPreferred(defaultPreferred(book))
      } catch {
        setAddresses(null)
        setConnectionAttemptSettled(true)
      }
    })()
  }, [])

  /** 宿主状态：进页就取。 */
  useEffect(() => {
    void (async () => {
      try {
        const current = await apiGet<StatusView>('/api/relay/status')
        setStatus(current)
        if (current.enabled) setConnectionAttemptSettled(true)
      } catch (err) {
        setFatal(errorText(err))
      }
    })()
  }, [])

  /**
   * 进页把局域网直连打开、并把远程控制启用（不写公用中转）。
   *
   * `publicRelayDisabled` 只在「这台机器本来一条中转都没有」时置真：这样宿主启用时不会再把
   * 公用中转补回来（新装用户不该默认吃公用中转）；老用户已有中转的不动它，照旧能用。
   */
  const openedRef = useRef(false)
  useEffect(() => {
    if (openedRef.current) return
    if (addresses === null) return
    openedRef.current = true
    if (status && status.enabled) return
    void connect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只要第一次那一轮
  }, [addresses, status])

  /**
   * 国际：Cloudflare 快隧道自动开（用户点进引导页就该能扫）。
   * 国内不吃公用中转，要靠用户在服务商卡片里自己把 ZeroNews / 节点小宝接上。
   */
  const autoStartedCf = useRef(false)
  useEffect(() => {
    const cf = status?.cloudflare
    if (autoStartedCf.current || region !== 'global' || !cf || !cf.available) return
    if (cf.running || cf.starting || cf.retrying || cf.waitingForPort) {
      autoStartedCf.current = true
      return
    }
    autoStartedCf.current = true
    void cloudflareStart()
      .catch(() => undefined)
      .then(() => loadStatus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region, status?.cloudflare])

  /** 国内时读一次节点小宝那条地址，用来判它接好没有（它不在 /status 里）。 */
  useEffect(() => {
    if (region !== 'cn') {
      setJdxbUrl('')
      return undefined
    }
    let active = true
    const tick = async () => {
      if (!pageVisible()) return
      try {
        const next = await jdxbStatus()
        if (active) setJdxbUrl(next.url || '')
      } catch {
        /* 读不到就当没接，别打断。 */
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 5000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [region])

  async function loadStatus() {
    try {
      setStatus(await apiGet<StatusView>('/api/relay/status'))
    } catch {
      /* 临时读不到就等下一轮轮询。 */
    }
  }

  async function loadPairing() {
    setPairingError('')
    try {
      setPairing(await apiGet<PairingInfo>('/api/relay/pairing'))
    } catch (error) {
      setPairingError(errorText(error))
    }
  }

  /** 服务商清单（主推排最前）+ 当前地区是否已有能用的线路。 */
  const providers = onboardingProvidersOf(region)
  const readyCtx = { status: status as StatusView, jdxbUrl }
  const anyReady = status !== null && regionHasReadyRoute(region, readyCtx)
  const activeEntry = providers.find((entry) => entry.provider === providerOpen) ?? null

  /** 接好之后再去取二维码；没接好时码里没有可用的远程路，取了也是空的。 */
  useEffect(() => {
    if (anyReady && status?.enabled && !pairing?.svg) void loadPairing()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyReady, status?.enabled])

  useEffect(() => {
    const wait = pairingRenewIn(pairing)
    if (wait === null) return
    const timer = window.setTimeout(() => {
      if (alive.current) void loadPairing()
    }, wait)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 拿到新码才按它重排
  }, [pairing])

  /** 弹窗里点名用的端口。 */
  const lanPortText = String(status?.lan.port || addresses?.port || 18787)

  const showSelfcheckVerdict =
    status !== null &&
    connectionAttemptSettled &&
    !selfcheck.checking &&
    selfcheckVerdict !== 'ok' &&
    !(selfcheckVerdict === 'not-listening' && anyReady)

  async function applyAuto(toggle: boolean) {
    if (busy || connecting) return
    setBusy(true)
    if (toggle) {
      setConnecting(true)
      setConnectionAttemptSettled(false)
    }
    setError('')
    const patch: ConfigPatch = {
      lanEnabled: true,
      pairingPolicy: 'code',
    }
    if (preferred) patch.preferredLanAddress = preferred
    // 本来就没有中转的机器：明确停用公用中转，别让宿主在启用时把它补回来。
    if (status && !status.relayUrl && status.publicRelayDisabled !== true) patch.publicRelayDisabled = true
    try {
      setStatus(await apiPost<StatusView>('/api/relay/config', patch))
      if (toggle) {
        setStatus(await apiPost<StatusView>('/api/relay/toggle', { enabled: true }))
        await apiPost('/api/relay/onboarded', {}).catch(() => undefined)
      }
      if (toggle) {
        await watch()
        if (alive.current) setConnectionAttemptSettled(true)
      }
    } catch (err) {
      if (toggle && alive.current) setConnectionAttemptSettled(true)
      setError(errorText(err))
    } finally {
      setBusy(false)
      if (toggle) setConnecting(false)
    }
  }

  /** 按下去之后盯到「局域网在听」为止（远程那条由服务商自己接）。 */
  async function watch() {
    const startedAt = Date.now()
    while (alive.current && Date.now() - startedAt < 20_000) {
      await new Promise((resolve) => window.setTimeout(resolve, 1500))
      if (!alive.current) return
      let current: StatusView
      try {
        current = await apiGet<StatusView>('/api/relay/status')
      } catch {
        continue
      }
      setStatus(current)
      if (current.lan.state === 'listening' || current.lan.state === 'error') return
    }
  }

  async function connect() {
    await applyAuto(true)
  }

  /** 进插件：引导过了就直接去主页，没指定去向就跳根路径。 */
  function enterNow() {
    if (onDone) onDone()
    else window.location.assign('/')
  }

  async function copyTailcatPrompt() {
    const text = [
      t('panel.onboarding.tailcatPrompt.intro'),
      '',
      t('panel.onboarding.tailcatPrompt.situation'),
      t('panel.onboarding.tailcatPrompt.state', { state: tailcatText }),
      t('panel.onboarding.tailcatPrompt.guess'),
      '',
      t('panel.onboarding.tailcatPrompt.ask'),
      t('panel.onboarding.tailcatPrompt.ask1'),
      t('panel.onboarding.tailcatPrompt.ask2'),
      t('panel.onboarding.tailcatPrompt.ask3'),
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }

  async function sendFeedback(slot: string, title: string, message: string) {
    if (feedbackBusy[slot]) return
    setFeedbackBusy((prev) => ({ ...prev, [slot]: true }))
    setFeedbackSummaries((prev) => ({ ...prev, [slot]: `${title}\n${message}` }))
    setFeedbackKeys((prev) => ({ ...prev, [slot]: '' }))
    setFeedbackErrors((prev) => ({ ...prev, [slot]: '' }))
    const detail = [
      `title=${title}`,
      `error=${message}`,
      `lan=${status?.lan.state ?? ''}`,
      `tunnel=${status?.tunnel.state ?? ''}`,
      `tailcat=${tailcatText || ''}`,
      `firewall=${firewallInfo.text || ''}`,
      `verdict=${selfcheckVerdict || ''}`,
      ...Object.entries(connectionFeedbackFacts(status)).map(([key, value]) => `${key}=${value}`),
    ].join('\n')
    try {
      const result = await submitDirectFeedback({
        summary: `${title}\n${message}`,
        detail,
        context: {
          ...connectionFeedbackFacts(status),
          title,
          lan: status?.lan.state ?? '',
          tunnel: status?.tunnel.state ?? '',
          tailcat: tailcatText,
        },
        version: status?.appVersion,
      })
      setFeedbackKeys((prev) => ({ ...prev, [slot]: result.threadKey }))
    } catch (error) {
      setFeedbackErrors((prev) => ({ ...prev, [slot]: t('panel.feedback.failed', { error: (error as Error).message || String(error) }) }))
    } finally {
      setFeedbackBusy((prev) => ({ ...prev, [slot]: false }))
    }
  }

  function feedbackAction(slot: string, title: string, message: string) {
    const sameIssue = feedbackSummaries[slot] === `${title}\n${message}`
    const key = sameIssue ? feedbackKeys[slot] || '' : ''
    const failure = sameIssue ? feedbackErrors[slot] || '' : ''
    return (
      <div className="flex flex-col items-start gap-2">
        <Button variant="outline" size="sm" disabled={!!feedbackBusy[slot]} onClick={() => void sendFeedback(slot, title, message)}>
          {feedbackBusy[slot] ? t('panel.feedback.sending') : t('panel.onboarding.feedback')}
        </Button>
        {failure ? <p className="text-xs text-error">{failure}</p> : null}
        {key ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-foreground-muted">{t('panel.feedback.receipt', { key })}</p>
            <CopyButton value={key} label={t('panel.feedback.copyKey')} copiedLabel={t('panel.feedback.keyCopied')} size="sm" variant="outline">
              {t('panel.feedback.copyKey')}
            </CopyButton>
          </div>
        ) : null}
      </div>
    )
  }

  const qrSvg = pairing?.svg ?? ''

  const tailcat = status?.tailcat ?? null
  const tailcatState = !tailcat || !tailcat.available
    ? 'unavailable'
    : !tailcat.enabled
      ? 'disabled'
      : tailcat.error
        ? 'error'
        : tailcat.ready
          ? 'ready'
          : 'starting'
  const tailcatAsking = tailcatState !== 'ready' && tailcatState !== 'starting'
  const tailcatText = {
    ready: t('panel.tailcat.ready'),
    starting: t('panel.tailcat.starting'),
    disabled: t('panel.tailcat.disabled'),
    error: t('panel.tailcat.error'),
    unavailable: t('panel.tailcat.unavailable'),
  }[tailcatState]
  const tailcatToneValue: Tone = tailcatState === 'ready' ? 'ok' : tailcatState === 'starting' ? 'warn' : 'off'

  const statusFailure = status !== null && (status.lan.state === 'error' || status.tunnel.state === 'error')
    ? {
        title: status.lan.state === 'error' ? t('panel.onboarding.lanFailed') : t('panel.onboarding.relayFailed'),
        message: status.lan.state === 'error'
          ? status.lan.error
            ? t('panel.onboarding.lanErrorWithPort', { error: status.lan.error })
            : t('panel.onboarding.lanNoStart')
          : status.tunnel.error
            ? t('panel.onboarding.tunnelErrorHint', { error: status.tunnel.error })
            : t('panel.onboarding.tunnelNoStart'),
      }
    : null

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 pt-6 pb-24">
      <div className="flex w-full max-w-4xl flex-wrap items-center justify-end gap-1">
        <LanguageMenu />
        <ConsoleThemeToggle />
        <PanelWindowActions />
      </div>
      {fatal ? (
        <Alert className="w-full max-w-4xl" variant="error">
          <AlertIcon />
          <AlertTitle>{t('panel.onboarding.statusFailed')}</AlertTitle>
          <AlertDescription>{fatal}</AlertDescription>
          {feedbackAction('fatal', t('panel.onboarding.statusFailed'), fatal)}
        </Alert>
      ) : null}

      {error ? (
        <Alert className="w-full max-w-4xl" variant="error">
          <AlertIcon />
          <AlertTitle>{t('panel.onboarding.stepFailed')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
          {feedbackAction('step', t('panel.onboarding.stepFailed'), error)}
        </Alert>
      ) : null}

      {/* 选地区 + 服务商：先把网络配好，下面才放二维码。 */}
      <Card frame="solid" className="w-full max-w-4xl">
        <div className="flex flex-col gap-4 p-4">
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-foreground-strong">{t('panel.onboarding.setupTitle')}</span>
              <div className="ml-auto inline-flex rounded-md border border-border-muted p-0.5">
                {(['cn', 'global'] as NetworkRegion[]).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setRegion(value)}
                    className={cn(
                      'cursor-pointer rounded px-2.5 py-1 text-xs transition-colors',
                      region === value ? 'bg-primary text-white' : 'text-foreground-muted hover:text-foreground-strong',
                    )}
                  >
                    {t(value === 'cn' ? 'panel.region.china' : 'panel.region.global')}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-xs leading-5 text-foreground-muted">
              {t('panel.onboarding.setupHint')}
              <span className="ml-1">{t('panel.onboarding.regionAuto')}</span>
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {providers.map((entry) => {
              const look = PROVIDER_LOOK[entry.provider]
              const ready = status !== null && entry.ready(readyCtx)
              return (
                <div
                  key={entry.provider}
                  className={cn(
                    'flex flex-col gap-2 rounded-lg border p-3',
                    entry.primary ? 'border-primary/50 bg-primary/5' : 'border-border-muted',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="flex size-6 items-center justify-center">{look.icon}</span>
                    <span className="text-sm font-medium text-foreground-strong">{t(look.name)}</span>
                    {entry.primary ? <Badge variant="soft" size="xs">{t('panel.onboarding.providerRecommended')}</Badge> : null}
                    <span className={cn('ml-auto text-xs', ready ? 'text-foreground-strong' : 'text-foreground-muted')}>
                      {ready ? t('panel.onboarding.providerReady') : t('panel.onboarding.providerNotReady')}
                    </span>
                  </div>
                  <p className="text-xs leading-5 text-foreground-muted">{t(look.hint)}</p>
                  <div className="flex justify-end">
                    <Button
                      variant={entry.primary ? 'primary' : 'outline'}
                      size="sm"
                      disabled={!status}
                      onClick={() => setProviderOpen(entry.provider)}
                    >
                      {t('panel.onboarding.configure')}
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </Card>

      {/* 二维码 + 下载渠道 + 状态：接好之后二维码才出来。 */}
      <Card frame="solid" className="w-full max-w-4xl">
        <div className="grid items-center gap-6 px-4 pb-2 md:grid-cols-[minmax(320px,1fr)_minmax(0,1fr)]">
          <div className="flex flex-col items-center gap-2 md:col-start-1 md:row-start-1">
            <div className="flex h-5 w-full max-w-[320px] items-center justify-center gap-1.5">
              <p className="text-sm font-medium leading-5 text-foreground-strong">{t('panel.onboarding.pairingHint')}</p>
              {qrSvg ? (
                <button
                  type="button"
                  aria-label={`${t('panel.pairing.qrZoom')}：${t('panel.pairing.qr')}`}
                  title={t('panel.pairing.qrZoom')}
                  className="cursor-pointer text-foreground-muted hover:text-foreground-strong focus-visible:outline-none"
                  onClick={() => setQrZoomOpen(true)}
                >
                  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <circle cx="10.5" cy="10.5" r="6" />
                    <path d="m15 15 4.5 4.5M8.5 10.5h4M10.5 8.5v4" />
                  </svg>
                </button>
              ) : null}
            </div>
            {qrSvg ? (
              <button
                type="button"
                className="cursor-zoom-in rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onClick={() => setQrZoomOpen(true)}
                aria-label={`${t('panel.pairing.qrZoom')}：${t('panel.pairing.qr')}`}
              >
                <div className="size-[320px] max-w-full rounded-lg bg-white p-3 [&_svg]:h-full [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: qrSvg }} />
              </button>
            ) : (
              <div className="flex size-[320px] max-w-full items-center justify-center rounded-lg border border-border-muted p-4 text-center text-xs leading-5 text-foreground-muted">
                {pairingError && anyReady ? (
                  <div className="flex flex-col items-center gap-2">
                    <span role="alert">{pairingError}</span>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void loadPairing()}>
                      {t('panel.console.retryPairing')}
                    </Button>
                  </div>
                ) : busy ? <Spinner /> : t('panel.onboarding.qrPending')}
              </div>
            )}
            <p className="min-h-4 max-w-[320px] text-center text-xs leading-4 text-foreground-muted">
              {!anyReady ? t('panel.onboarding.waitNetwork') : ''}
            </p>
          </div>

          <div className="flex min-w-0 flex-col justify-center gap-3 md:col-start-2 md:row-start-1">
            <p className="text-center text-sm font-medium text-foreground-strong">{t('panel.download.title')}</p>
            <DownloadChannelsGrid />
          </div>

          <div className="w-full md:col-span-2 md:row-start-2 [&_dt]:text-foreground-strong">
            <InfoList>
              <InfoRow label={t('panel.onboarding.direct')}>
                <ToneValue tone={lanTone(status?.lan.state ?? 'off', true)} text={lanText(status?.lan.state ?? 'off', true)} />
              </InfoRow>
              <InfoRow label={t('panel.connection.tunnel')}>
                <ToneValue tone={tunnelTone(status?.tunnel.state ?? 'off')} text={tunnelText(status?.tunnel.state ?? 'off')} />
              </InfoRow>
              <InfoRow label={t('panel.tailcat.title')}>
                <span className="inline-flex items-center justify-end gap-1.5">
                  <ToneValue tone={tailcatToneValue} text={tailcatText} />
                  {tailcatAsking ? (
                    <button
                      type="button"
                      aria-label={t('panel.onboarding.tailcatWhy')}
                      title={t('panel.onboarding.tailcatWhy')}
                      className="cursor-pointer text-foreground-muted hover:text-foreground-strong focus-visible:outline-none"
                      onClick={() => setTailcatOpen(true)}
                    >
                      <QuestionMark />
                    </button>
                  ) : null}
                </span>
              </InfoRow>
              <InfoRow label={t('panel.selfcheck.firewall')}>
                <ToneValue tone={firewallInfo.tone} text={firewallInfo.text} detail={firewallInfo.detail} />
              </InfoRow>
            </InfoList>

            {showSelfcheckVerdict ? (
              <p className={`mt-2 text-sm leading-relaxed break-words ${toneText[verdictTone(selfcheckVerdict)]}`}>
                {verdictText(selfcheckVerdict)}
              </p>
            ) : null}

            {statusFailure ? (
              <Alert className="mt-2" variant="error">
                <AlertIcon />
                <AlertTitle>{statusFailure.title}</AlertTitle>
                <AlertDescription>{statusFailure.message}</AlertDescription>
                {feedbackAction('status', statusFailure.title, statusFailure.message)}
              </Alert>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-4">
          <button
            type="button"
            className="cursor-pointer text-sm text-foreground-intense underline underline-offset-2 hover:text-foreground-strong"
            onClick={() => setFirewallOpen(true)}
          >
            {t('panel.onboarding.checkFirewall')}
          </button>
          <Button variant="primary" disabled={!anyReady} onClick={enterNow}>
            {anyReady ? t('panel.onboarding.enterPlugin') : t('panel.onboarding.providerNotReady')}
          </Button>
        </div>
      </Card>

      {/* 服务商面板：复用各家自己的配置页铺满一屏，配完关掉即可。 */}
      {activeEntry && status ? (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-background p-4 sm:p-6">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
            <activeEntry.Page
              open
              onOpenChange={(next) => {
                if (!next) setProviderOpen(null)
              }}
              status={status}
              busy=""
              onChanged={() => void loadStatus()}
            />
          </div>
        </div>
      ) : null}

      <FirewallDialog open={firewallOpen} onOpenChange={setFirewallOpen} port={lanPortText} />

      <Dialog open={qrZoomOpen} onOpenChange={setQrZoomOpen}>
        <DialogContent className="w-[min(680px,94vw)] max-w-none" closeLabel={t('panel.common.close')}>
          <DialogHeader>
            <DialogTitle>{t('panel.pairing.qr')}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col items-center gap-3">
              <div className="flex items-center justify-center rounded-md bg-white p-4">
                {qrSvg ? <div className="size-[min(72vh,600px)] [&_svg]:h-full [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: qrSvg }} /> : null}
              </div>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <Dialog open={tailcatOpen} onOpenChange={setTailcatOpen}>
        <DialogContent className="max-w-md" closeLabel={t('panel.common.close')}>
          <DialogHeader>
            <DialogTitle>{t('panel.tailcat.title')}</DialogTitle>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-2.5">
            <p className="text-xs leading-5 text-foreground-muted">{t('panel.onboarding.tailcatWhat')}</p>
            <p className="text-sm text-foreground">{t(`panel.onboarding.tailcat.${tailcatState}`)}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void copyTailcatPrompt().then((ok) => setCopied(t(ok ? 'panel.onboarding.copiedOk' : 'panel.onboarding.copiedFailed')))
              }}
            >
              {t('panel.onboarding.copyPromptHint')}
            </Button>
            {copied ? <p className="text-xs text-foreground-muted">{copied}</p> : null}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </main>
  )
}

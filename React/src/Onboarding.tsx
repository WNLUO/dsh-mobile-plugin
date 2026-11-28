// 2026-11-28：宿主状态里的错误文案不再原样塞进提示，外文界面收成通用失败。
// 2026-11-27：修引导页第三页「下一步」误留在第三页（setStep(3)），小白走到配网络就再也到不了扫码页；改为进第四页。
// 2026-11-27：引导页加一页「选个方式」插在装 App 之后，原配网络/扫码顺延成第三/四页。
// 2026-11-27：国内服务商只留 ZeroNews，节点小宝的状态轮询与入口收掉（宿主能力保留）。
// 2026-11-27：第二页国内只露 ZeroNews 一家；服务商行固定下限高，切 tab 面板不跳。
// 2026-11-26：引导页拆成三页——下载 App / 配网络（可跳过，跳过直接进控制台）/ 扫码连接。
// 2026-11-26：第三页出码前先让宿主把码里的地址真拨一遍；全不通不出码，只有回环通要另说。
// 2026-11-26：第二页服务商改一行一家，接好之后不再给「去配置」；跳过与下一步并排靠右。
// 2026-11-25：兜底仍不可用时在引导页弹端口冲突指引，配服务商时也认这条状态。
// 2026-11-25：引导页加「跳过」出口——不想接服务商的人也能进控制台自己配线路。
// 2026-11-25：直连那一行复用错误档带回环 health 被抢的原因。
// 用途：首次接入引导页；错误处可直接提交脱敏摘要与诊断附件，并回显反馈编号。
/**
 * 首次接入引导（四步）：宿主还没配过、或走 `/api/relay/panel/setup` 时进这一页。
 *
 * 一屏一页，顺序照新用户真实的动作走：
 *   1. **下载 App** —— 手机还没装 App 的话，后面扫码也没处扫；
 *   2. **选个方式** —— 先看用户有没有网络基础：小白走引导，自己会配的直接进控制台；
 *   3. **配网络** —— 按地区（默认按界面语言，可手动切）列出服务商，主推一家；这一页可以
 *      **跳过**，跳过就直接进控制台（不接线路、也不去扫码页）；
 *   4. **扫码连接** —— 线路接好之后才放二维码，手机扫了才能连。
 *
 * 局域网直连照旧一起开着，在家同一 Wi-Fi 也能扫。兜底的隧道（Tailcat / Cloudflare / P2P）
 * 只当兜底，新装用户只靠局域网、自己配的线路和兜底隧道。
 *
 * 服务商清单来自 `lib/onboarding-providers.tsx`，加一家只改那份注册表，不碰这一页。
 */
// 首次取码失败可重试，后台续码保留已有二维码；扫码绑定成功后进入插件主页。
// 2026-11-24：配对码一变就重取二维码，显示前也认当前票 —— 旧码里的票据已作废，扫了只会被宿主判「电脑拒绝新设备」。
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
import { PortConflictDialog, portConflictReason } from './components/PortConflictDialog.tsx'
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
  apiMessageText,
  apiPost,
  cloudflareStart,
  errorText,
  lanFallbackReason,
  pairingRenewIn,
  type AddressBook,
  type ConfigPatch,
  type PairingCheck,
  type PairingCheckRow,
  type PairingInfo,
  type StatusView,
} from './lib/api.ts'
import { cn, lanText, lanTone, toneText, tunnelText, tunnelTone, type Tone } from './lib/format.ts'
import {
  firewallRow,
  mobileLooksIdle,
  useLoopbackProbe,
  useSelfCheck,
  verdictText,
  verdictTone,
} from './lib/selfcheck.ts'
import { onboardingProvidersOf, regionHasReadyRoute, type OnboardingProvider } from './lib/onboarding-providers.tsx'
import type { NetworkRegion } from './lib/network-region.ts'
import { defaultRegionOf } from './lib/network-region.ts'
import { usePanelLanguage } from './lib/i18n/use-language.ts'
import { t } from './lib/i18n/index.ts'
import { pageVisible } from './lib/embed-visibility.ts'
import { usePairingCompletion } from './lib/usePairingCompletion.ts'

type Props = {
  /** 配好之后去哪。默认回插件主页。 */
  onDone?: () => void
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
  /** 当前地区：没手动选过时跟界面语言走，用户可切。 */
  const [chosenRegion, setChosenRegion] = useState<NetworkRegion | null>(null)
  const language = usePanelLanguage()
  const region = chosenRegion ?? defaultRegionOf(language)
  /** 走到第几页：1 下载 App、2 选个方式、3 配网络、4 扫码连接。 */
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1)
  /** 第四页出码前的自检结果：码里的地址宿主真拨了一遍。 */
  const [check, setCheck] = useState<PairingCheck | null>(null)
  const [checkRunning, setCheckRunning] = useState(false)
  const [checkError, setCheckError] = useState('')
  /** 正在配置哪家服务商（null = 没开面板）；开了就把它自己那一页铺上来。 */
  const [providerOpen, setProviderOpen] = useState<OnboardingProvider['provider'] | null>(null)
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
  // verdict 的 ok 仍只说「手机从任意路径来过」，不改它的含义；端口被抢单独把直连那行标红，
  // 复用已有的错误档与 panel.lan.error 文案，原因塞进现成的 detail，不加新颜色 / 新行。
  const liveLoopback = useLoopbackProbe(Boolean(status?.enabled), status?.lan.port || 0)
  const loopbackInfo = liveLoopback || selfcheck.data?.listening?.loopback
  const lanState = loopbackInfo?.state === 'blocked' ? 'error' : (status?.lan.state ?? 'off')

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
   * 进页把局域网直连打开、并把远程控制启用；新装用户得自己配一条能用的网络。
   */
  const openedRef = useRef(false)
  useEffect(() => {
    if (openedRef.current) return
    if (addresses === null || status === null) return
    openedRef.current = true
    if (status.enabled) return
    void connect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只要第一次那一轮
  }, [addresses, status])

  /**
   * 国际：Cloudflare 快隧道自动开（用户点进引导页就该能扫）。
   * 国内：只露 ZeroNews 一家，由用户在卡片里自己接上。
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

  /**
   * 出码前先自检：让宿主把二维码里会带的那几条地址真拨一遍。
   *
   * 扫不上比扫得慢糟得多 —— 原来这一页把码一摆就不管了，码里那条地址其实早就拨不通（端口没
   * 听、防火墙拦、服务商断了），用户只能拿着手机反复扫。自检放在这里，全不通就不出码，先让
   * 人把路弄通。
   *
   * 这条请求**证明不了手机能连上**：拨的是本机网卡出去的请求，同一台电脑上永远不过防火墙与
   * 无线链路，所以结果分两档，界面照两档说话（本机回环可达 / 外部线路可达）。
   */
  async function startCheck() {
    if (checkRunning) return
    setCheckRunning(true)
    setCheckError('')
    try {
      const result = await apiGet<PairingCheck>('/api/relay/pairing-check')
      if (alive.current) setCheck(result)
    } catch (error) {
      if (alive.current) setCheckError(errorText(error))
    } finally {
      if (alive.current) setCheckRunning(false)
    }
  }

  /** 服务商清单（主推排最前）+ 当前地区是否已有能用的线路。 */
  const providers = onboardingProvidersOf(region)
  const readyCtx = { status: status as StatusView }
  const anyReady = status !== null && regionHasReadyRoute(region, readyCtx)
  const activeEntry = providers.find((entry) => entry.provider === providerOpen) ?? null

  /** 接好之后再去取二维码；没接好时码里没有可用的远程路，取了也是空的。 */
  useEffect(() => {
    if (anyReady && status?.enabled && !pairing?.svg) void loadPairing()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyReady, status?.enabled])

  /** 换了地区、或这家又没接好：把上一张码清掉，别让它跨地区残留（国际切回国内时最明显）。 */
  useEffect(() => {
    if (!anyReady) setPairing((prev) => (prev ? null : prev))
  }, [anyReady])

  useEffect(() => {
    const wait = pairingRenewIn(pairing)
    if (wait === null) return
    const timer = window.setTimeout(() => {
      if (alive.current) void loadPairing()
    }, wait)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 拿到新码才按它重排
  }, [pairing])

  /**
   * 配对码一变就重取二维码 —— 控制台早就有这条，引导页一直漏着。
   *
   * 宿主每配对成功一次（以及换身份、重启）就换 `pairingCode` + 票据，旧二维码当场作废。
   * 引导页若只在临期定时器到点才重取，这中间会一直挂着旧票：用户扫过去，宿主按当前票解不开，
   * 直接判「电脑拒绝新设备」——局域网通、允许配对开着也照样拒，跟用户说破了也查不出原因。
   * 每 3 秒那轮状态一读到新码就补一次取码，把旧票换掉。
   */
  useEffect(() => {
    if (!status?.enabled || !pairing) return
    if (status.pairingCode && pairing.pairingCode !== status.pairingCode) void loadPairing()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在 pairingCode 变了时重取，loadPairing 不该进依赖
  }, [status?.pairingCode, status?.enabled, pairing])

  /** 弹窗里点名用的端口。 */
  const lanPortText = String(status?.lan.port || addresses?.port || 51887)
  const portConflict = portConflictReason(lanFallbackReason(status) || status?.lan.routeIssue || '')

  /**
   * 进第四页就查一次。回第三页换了一家服务商再进来会重查 —— 码里的地址跟着变了，旧结论作废。
   * 「重新检查」那颗按钮另走 `startCheck`。
   */
  useEffect(() => {
    if (step !== 4 || !status?.enabled) return
    void startCheck()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在进出这一页时查一次，重查由按钮发起
  }, [step, status?.enabled])

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

  /**
   * 跳过服务商配置：不接线路也让人进控制台自己配（局域网直连进页时已开好）。
   * 2026-11-26 起这颗按钮常驻在配网络那页，跳过就直接进控制台，不再走扫码页。
   * 进页那一发 `connect()` 会写 onboarded，这里再补一次幂等写入 —— 万一点得比它快，
   * 下次打开 /panel 又会被判成「没配过」弹回引导页。
   */
  async function skipSetup() {
    await apiPost('/api/relay/onboarded', {}).catch(() => undefined)
    enterNow()
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
  /**
   * 这张码是不是「当前这张」。
   *
   * 配对成功换码、换身份、重启都会换 `pairingCode`，而旧码里的票据从换码那一刻起就作废了。
   * 旧票还摆在屏幕上让人扫，宿主用当前票去解就解不开，只会回一句「电脑拒绝新设备」——
   * 可现场看局域网是通的、允许配对也开着，人根本查不到原因。所以显示前先认票：
   * 只画当前这张，旧码当成「还没取到」，等下面那条 effect 把新码取回来。
   */
  const qrCurrent = pairing?.pairingCode !== undefined && pairing.pairingCode === status?.pairingCode
  const qrReady = qrCurrent && qrSvg !== ''

  /** 自检过一遍之后才谈出码：正在查、或一条地址都拨不通时，码先不摆出来。 */
  const checkRows = check?.targets ?? []
  const lanRows = checkRows.filter((row) => row.kind === 'lan' || row.kind === 'direct')
  const routeRows = checkRows.filter((row) => row.kind === 'route')
  const checkSettled = check !== null && !checkRunning && !checkError
  const checkSummary = checkSettled && check ? check.summary : null
  const qrBlocked = checkRunning || checkSummary?.allFailed === true

  /**
   * 一条自检结论并进原来那一行：通了说「可达」，没通说「拨不通」，地址与原因收进 detail。
   *
   * 局域网那几条就落在这台电脑自己的网卡上，通了也只说明本机回环好 —— 这一行的说法跟着
   * 走 `local`，不许把「拨自己通了」写成「局域网正常」。
   */
  function probeRow(rows: PairingCheckRow[], label: string) {
    const first = rows.find((row) => row.ok) ?? rows[0]
    const tone: Tone = checkRunning ? 'off' : first.ok ? 'ok' : 'error'
    const text = checkRunning
      ? t('panel.onboarding.check.running')
      : first.ok
        ? t('panel.onboarding.check.reachable')
        : t('panel.onboarding.check.unreachable')
    const detail = [
      first.local ? `${first.url}（${t('panel.onboarding.check.loopback')}）` : first.url,
      rows.length > 1 ? `+${rows.length - 1}` : '',
      first.ok ? '' : first.error || first.detail || '',
    ].filter(Boolean).join(' · ')
    return (
      <InfoRow key={label} label={label}>
        <ToneValue tone={tone} text={text} detail={detail} />
      </InfoRow>
    )
  }

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
            ? t('panel.onboarding.lanErrorWithPort', { error: apiMessageText(status.lan.error) })
            : t('panel.onboarding.lanNoStart')
          : status.tunnel.error
            ? t('panel.onboarding.tunnelErrorHint', { error: apiMessageText(status.tunnel.error) })
            : t('panel.onboarding.tunnelNoStart'),
      }
    : null

  /** 四步的标题都取自现成文案，不另起一套叫法。 */
  const steps: { value: 1 | 2 | 3 | 4; title: string }[] = [
    { value: 1, title: t('panel.download.title') },
    { value: 2, title: t('panel.onboarding.modeTitle') },
    { value: 3, title: t('panel.onboarding.setupTitle') },
    { value: 4, title: t('panel.onboarding.pairingHint') },
  ]

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

      {/* 步骤条：一屏一页，走过的页点得回去，没走到的点不动。 */}
      <div className="flex w-full max-w-4xl flex-wrap items-center gap-2">
        {steps.map((item) => {
          const reached = item.value <= step
          return (
            <button
              key={item.value}
              type="button"
              aria-current={item.value === step ? 'step' : undefined}
              disabled={!reached}
              onClick={() => setStep(item.value)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors',
                item.value === step
                  ? 'border-primary bg-primary-subtle text-foreground-strong'
                  : reached
                    ? 'cursor-pointer border-border-muted text-foreground-muted hover:text-foreground-strong'
                    : 'border-border-muted text-foreground-muted opacity-60',
              )}
            >
              <span className="font-medium">{item.value}</span>
              <span>{item.title}</span>
            </button>
          )
        })}
      </div>

      {/* 第一页：装 App。手机还没装 App 的话，后面扫码也没处扫。 */}
      {step === 1 ? (
        <Card frame="solid" className="w-full max-w-4xl">
          <div className="flex flex-col gap-3 p-4">
            <p className="text-center text-sm font-medium text-foreground-strong">{t('panel.download.title')}</p>
            <p className="text-center text-xs leading-5 text-foreground-muted">{t('panel.onboarding.installAppHint')}</p>
            <DownloadChannelsGrid />
          </div>
          <div className="flex items-center justify-end gap-2 px-4 pb-4">
            <Button variant="primary" onClick={() => setStep(2)}>
              {t('panel.onboarding.next')}
            </Button>
          </div>
        </Card>
      ) : null}

      {/* 第二页：先问网络基础。小白顺着引导走，自己会配的直接进控制台。 */}
      {step === 2 ? (
        <Card frame="solid" className="w-full max-w-4xl">
          <div className="flex flex-col gap-4 p-4">
            <p className="text-center text-sm font-medium text-foreground-strong">{t('panel.onboarding.modeTitle')}</p>
            <p className="text-center text-xs leading-5 text-foreground-muted">{t('panel.onboarding.modeHint')}</p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button variant="primary" onClick={() => setStep(3)}>
                {t('panel.onboarding.modeBeginner')}
              </Button>
              <Button variant="outline" onClick={() => void skipSetup()}>
                {t('panel.onboarding.modeExpert')}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {/* 第三页：选地区 + 服务商。接好了才放行到扫码页；不想接的人可以直接跳过进控制台。 */}
      {step === 3 ? (
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
                      onClick={() => setChosenRegion(value)}
                      className={cn(
                        'cursor-pointer rounded px-2.5 py-1 text-xs transition-colors',
                        region === value ? 'bg-primary text-primary-foreground' : 'text-foreground-muted hover:text-foreground-strong',
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

            {/* 一家一行：图标、名字、推荐标签、状态，没接好时右边再放一颗「去配置」。
                服务商以后只会越来越多，所以不做大卡片；接好之后这一行就是纯状态，改配置去控制台。 */}
            <div className="flex flex-col gap-2">
              {providers.map((entry) => {
                const look = PROVIDER_LOOK[entry.provider]
                const ready = status !== null && entry.ready(readyCtx)
                return (
                  <div
                    key={entry.provider}
                    className={cn(
                      'flex min-h-14 flex-wrap items-center gap-2 rounded-lg border border-border-muted p-3',
                      entry.primary ? 'bg-primary-subtle' : '',
                    )}
                  >
                    <span className="flex size-6 items-center justify-center">{look.icon}</span>
                    <span className="text-sm font-medium text-foreground-strong">{t(look.name)}</span>
                    {entry.primary ? <Badge variant="soft" size="xs">{t('panel.onboarding.providerRecommended')}</Badge> : null}
                    <span className={cn('ml-auto text-xs', ready ? 'text-foreground-strong' : 'text-foreground-muted')}>
                      {ready ? t('panel.onboarding.providerReady') : t('panel.onboarding.providerNotReady')}
                    </span>
                    {ready ? null : (
                      <Button
                        variant={entry.primary ? 'primary' : 'outline'}
                        size="sm"
                        disabled={!status}
                        onClick={() => setProviderOpen(entry.provider)}
                      >
                        {t('panel.onboarding.configure')}
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 px-4 pb-4">
            <Button variant="ghost" onClick={() => void skipSetup()}>
              {t('panel.onboarding.skipSetup')}
            </Button>
            <Button variant="primary" disabled={!anyReady} onClick={() => setStep(4)}>
              {t('panel.onboarding.next')}
            </Button>
          </div>
        </Card>
      ) : null}

      {/* 第四页：二维码 + 状态。接好了二维码才出来，扫完自动进控制台。 */}
      {step === 4 ? (
        <Card frame="solid" className="w-full max-w-4xl">
          <div className="flex flex-col items-center gap-2 px-4 pb-2">
            <div className="flex flex-col items-center gap-2 md:col-start-1 md:row-start-1">
              <div className="flex h-5 w-full max-w-[320px] items-center justify-center gap-1.5">
                <p className="text-sm font-medium leading-5 text-foreground-strong">{t('panel.onboarding.pairingHint')}</p>
                {qrReady ? (
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
              {qrReady && !qrBlocked ? (
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
                  {checkRunning ? (
                    <span className="flex flex-col items-center gap-2">
                      <Spinner />
                      {t('panel.onboarding.check.running')}
                    </span>
                  ) : checkSummary?.allFailed ? (
                    <span role="alert">{t('panel.onboarding.check.allFailed')}</span>
                  ) : pairingError && anyReady ? (
                    <div className="flex flex-col items-center gap-2">
                      <span role="alert">{pairingError}</span>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void loadPairing()}>
                        {t('panel.console.retryPairing')}
                      </Button>
                    </div>
                  ) : busy ? (
                    <Spinner />
                  ) : check === null ? (
                    t('panel.onboarding.check.pending')
                  ) : (
                    t('panel.onboarding.qrPending')
                  )}
                </div>
              )}
              <p className="min-h-4 max-w-[320px] text-center text-xs leading-4 text-foreground-muted">
                {!anyReady ? t(portConflict ? 'panel.onboarding.routeBlocked' : 'panel.onboarding.waitNetwork') : ''}
              </p>
            </div>

            <div className="w-full [&_dt]:text-foreground-strong">
              <InfoList>
                {/* 直连那一行换成自检结论：码里那条局域网地址到底通不通，比「在监听」这句话有用。 */}
                {lanRows.length > 0 ? (
                  probeRow(lanRows, t('panel.onboarding.direct'))
                ) : (
                  <InfoRow label={t('panel.onboarding.direct')}>
                    <ToneValue
                      tone={lanTone(lanState, true)}
                      text={lanText(lanState, true)}
                      detail={loopbackInfo?.state === 'blocked' ? loopbackInfo.reason : undefined}
                    />
                  </InfoRow>
                )}
                {routeRows.length > 0 ? probeRow(routeRows, t('panel.onboarding.check.provider')) : null}
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

              {/* 自检的结论单独说一句：只有外部线路通了才配得上「可以扫码了」，
                  只有拨自己通则必须说清「手机能不能连上还没验证」。 */}
              {checkSummary?.remoteOk ? (
                <p className={`mt-2 text-sm leading-relaxed break-words ${toneText.ok}`}>{t('panel.onboarding.check.ready')}</p>
              ) : null}
              {checkSummary && !checkSummary.remoteOk && checkSummary.localOk ? (
                <p className={`mt-2 text-sm leading-relaxed break-words ${toneText.warn}`}>{t('panel.onboarding.check.loopbackOnly')}</p>
              ) : null}
              {loopbackInfo ? (
                <p className={`mt-2 text-sm leading-relaxed break-words ${toneText[loopbackInfo.state === 'ok' ? 'ok' : loopbackInfo.state === 'blocked' ? 'error' : 'warn']}`}>
                  {t('panel.onboarding.check.loopback')}：{t(loopbackInfo.state === 'ok' ? 'panel.onboarding.check.reachable' : loopbackInfo.state === 'blocked' ? 'panel.onboarding.check.unreachable' : 'panel.selfcheck.notChecked')}{loopbackInfo.reason ? ` · ${loopbackInfo.reason}` : ''}
                </p>
              ) : null}

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
            <Button variant="ghost" size="sm" disabled={checkRunning} onClick={() => void startCheck()}>
              {t('panel.onboarding.check.retry')}
            </Button>
            <Button variant="primary" disabled={!anyReady} onClick={enterNow}>
              {anyReady ? t('panel.onboarding.enterPlugin') : t('panel.onboarding.providerNotReady')}
            </Button>
          </div>
        </Card>
      ) : null}

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
      <PortConflictDialog
        reason={portConflict}
        port={status?.lan.ingressPort || status?.lan.port || 51887}
      />

      <Dialog open={qrZoomOpen} onOpenChange={setQrZoomOpen}>
        <DialogContent className="w-[min(680px,94vw)] max-w-none" closeLabel={t('panel.common.close')}>
          <DialogHeader>
            <DialogTitle>{t('panel.pairing.qr')}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col items-center gap-3">
              <div className="flex items-center justify-center rounded-md bg-white p-4">
                {qrReady ? <div className="size-[min(72vh,600px)] [&_svg]:h-full [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: qrSvg }} /> : null}
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

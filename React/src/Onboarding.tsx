/**
 * 首次接入引导（一页）：宿主还没配过、或走 `/api/relay/panel/setup` 时进这一页，
 * 把两条路一起打开、把二维码摆出来让手机扫。
 *
 * **这一页不让用户选地址**：进页就把「局域网直连 + 公用中转」一并写进配置。二维码里本来就
 * 同时带着这两条（见 `lib/relay/pairing-payload.cjs` 的 `lanUrls` 与 `relayUrl`），手机扫一张码，
 * 在家走局域网、在外面走中转 —— 选哪条由 App 的自动档按实测往返决定，不需要人在这里挑。
 *
 * 公用中转只用清单第一条（`lib/links.ts` 的 `PUBLIC_RELAY_URL`）：公用入口本来就只有一个。
 * 想自建中转、或者用内网穿透域名的人，从二维码下面那两颗小入口进去配。
 *
 * 按钮那一下：`POST /api/relay/config` → `/api/relay/toggle {enabled:true}` →
 * `/api/relay/onboarded`，再轮询状态。页面不猜连接结果，也不假报成功。
 *
 * 码里的隧道段只活两分钟（宿主每取一次码就换一张），所以这一页在它临期前会自己重取一次，
 * 人装完 App 回来扫时屏幕上那张仍带一条能用的隧道。
 */
import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@appica/ui-react/alert'
import { Button } from '@appica/ui-react/button'
import { Card } from '@appica/ui-react/card'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@appica/ui-react/dialog'
import { Spinner } from '@appica/ui-react/spinner'
import { useEffect, useRef, useState } from 'react'

import { DownloadChannelsGrid } from './components/DownloadAppButton.tsx'
import { FirewallDialog } from './components/FirewallDialog.tsx'
import { InfoList, InfoRow, ToneValue } from './components/InfoRow.tsx'
import { QuestionMark } from './components/QuestionMark.tsx'
import {
  apiGet,
  apiPost,
  errorText,
  pairingRenewIn,
  type AddressBook,
  type ConfigPatch,
  type PairingInfo,
  type StatusView,
} from './lib/api.ts'
import { lanText, lanTone, toneText, tunnelText, tunnelTone, type Tone } from './lib/format.ts'
import {
  firewallRow,
  mobileLooksIdle,
  useSelfCheck,
  verdictText,
  verdictTone,
} from './lib/selfcheck.ts'
import { PUBLIC_RELAY_URL } from './lib/links.ts'
import { t } from './lib/i18n/index.ts'

type Props = {
  /** 配好之后去哪。默认回插件主页。 */
  onDone?: () => void
}

/**
 * 二维码里用哪条局域网地址：宿主存过的还在清单里就用它，否则用宿主的第一条。
 *
 * 「存过的还在不在」得自己判：换了网段、拔了网卡之后那个 IP 就不在清单里了，
 * 这时必须退回宿主的第一条（宿主那边的排序同样会退回，见 `orderCandidates`）。
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
  const [connectionAttemptSettled, setConnectionAttemptSettled] = useState(false)
  const [addresses, setAddresses] = useState<AddressBook | null>(null)
  const [pairing, setPairing] = useState<PairingInfo | null>(null)
  /**
   * 二维码里把哪条局域网地址排在最前。空串 = 地址清单还没回来，或者这台机器一条都没有。
   * 它随 `/api/relay/config` 落成设置项，宿主拿它排候选（见 `lib/relay/lan-network.cjs`）。
   */
  const [preferred, setPreferred] = useState('')
  /** 「检查防火墙」弹窗开着没有。里面按系统分三栏给排查步骤，不读本机状态。 */
  const [firewallOpen, setFirewallOpen] = useState(false)
  /** 「看大图」：同一张二维码的放大版。屏幕缩放或手机离得远时，卡片里那颗不够大。 */
  const [qrZoomOpen, setQrZoomOpen] = useState(false)
  /** Tailcat 那一行那颗问号开的弹窗：只讲「这台机器上是什么情况、下一步怎么办」。 */
  const [tailcatOpen, setTailcatOpen] = useState(false)
  /** 复制给 AI 之后的回执：照防火墙弹窗那套挨着按钮说，不走右上角胶囊。 */
  const [copied, setCopied] = useState('')
  /**
   * 连接自检：防火墙状态与总结句读它。
   *
   * 首次进页会自动开两条路，先等连接尝试结束再显示结论，避免把启动过程中的
   * `not-listening` 当成最终结果。后台补查仍按 `status.lastMobileAt` 判手机三十分钟没来过，
   * 节流在 `useSelfCheck` 里面，既不跟轮询，也不每次渲染都发。
   */
  const selfcheck = useSelfCheck(
    mobileLooksIdle(status?.lastMobileAt),
    // 连接状态一变（隧道握上手、局域网在听）自检结论就过期了，见 `useSelfCheck` 的文件头。
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

  /** 宿主状态与二维码：进页就取，不等地址清单。 */
  useEffect(() => {
    void (async () => {
      try {
        const current = await apiGet<StatusView>('/api/relay/status')
        setStatus(current)
        if (current.enabled) setConnectionAttemptSettled(true)
      } catch (err) {
        setFatal(errorText(err))
      }
      await loadPairing()
    })()
    // 初次挂载跑一次即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上
  }, [])

  /**
   * 进页把两条路一起打开：局域网直连 + 公用中转。
   *
   * 这是这一页唯一的动作，也是「不让人选地址」的实现方式 —— 二维码里本来就同时带着局域网
   * 与中转地址，两条都配上之后，人在家里扫到的是局域网那条、在外面扫到的是中转那条，
   * 手机自己择优（App 的自动档按实测往返排候选）。
   *
   * 等地址清单回来再发，是为了把「二维码里哪条局域网排最前」一起写进去。已经开着
   * （`enabled === true`）就不写：这一页每打开一次都重写一遍配置没有必要。
   */
  const openedRef = useRef(false)
  useEffect(() => {
    if (openedRef.current) return
    if (addresses === null) return
    openedRef.current = true
    if (status && status.enabled) return
    void connect()
    // `connect` 每次渲染都是新函数，这里只要「地址清单回来那一轮」，别跟它。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上
  }, [addresses, status])

  async function loadPairing() {
    try {
      setPairing(await apiGet<PairingInfo>('/api/relay/pairing'))
    } catch {
      /* 拿不到二维码不挡结论：二维码那块自己会说「没取到」。 */
    }
  }

  /**
   * 隧道段临期前续一次码。
   *
   * 码里那三段只有隧道会过期：宿主每取一次码就现开一个两分钟的一次性窗口，并作废上一张。
   * 用户装完 App 回来扫时，屏幕上那张要是取早了，隧道段就没了，App 静默丢掉它、只剩局域网
   * 与中转 —— 手机不在同一网、中转又不通时，表现成「扫不上但码看着正常」。
   *
   * 所以只在临期前那一拍重取一次，重取之后按新的 `expiresAt` 再排下一拍；不是一秒一轮的
   * 轮询（那会每两分钟白白开一堆没人扫的窗口）。这一版码里没有隧道段（助手不可用 / 出错）
   * 就不排 —— 剩下两条路不会过期，排下去只是白发请求。
   *
   * 重取失败也留着屏幕上那张：它的局域网与中转两段还能扫，换成一句报错反而更像码坏了。
   * 这一拍之后不重排（下一拍的前提是拿到新码），等下一次改配置或重连再取。
   */
  useEffect(() => {
    const wait = pairingRenewIn(pairing)
    if (wait === null) return
    const timer = window.setTimeout(() => {
      if (alive.current) void loadPairing()
    }, wait)
    return () => window.clearTimeout(timer)
    // 每次拿到新码就按它的 `expiresAt` 重排，别把定时器挂到别的状态上。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上
  }, [pairing])

  /** 弹窗里点名用的端口：宿主实际在用的那个（首选端口被占时会退到别的，别写死 18787）。 */
  const lanPortText = String(status?.lan.port || addresses?.port || 18787)

  /** 两条路都试过了没有：局域网在听、或者中转隧道握上手，就算能扫能用了。 */
  const readyNow =
    status !== null && (status.lan.state === 'listening' || status.tunnel.state === 'connected')
  const showSelfcheckVerdict =
    status !== null &&
    connectionAttemptSettled &&
    !selfcheck.checking &&
    // 一切正常时不再补一句「这条链路是通的」—— 上面几行已经全绿了。
    selfcheckVerdict !== 'ok' &&
    !(selfcheckVerdict === 'not-listening' && readyNow)

  /**
   * 按下去之后盯到连接真的起来为止：20 秒还没起来就如实说「还没起来」，不装成成功。
   * 好了不存标记 —— 渲染那边直接看 `status`（`readyNow`），存两份就会飘开。
   */
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
      if (current.lan.state === 'listening' || current.tunnel.state === 'connected') return
      if (current.lan.state === 'error' && current.tunnel.state === 'error') return
    }
  }

  /**
   * 把这台机器的两条路一起配上：局域网直连 + 公用中转。
   *
   * 写的就是 `relayUrl` + `lanEnabled: true` 这一对 —— 宿主据此既开局域网代理、又连中转，
   * 二维码里于是同时有两条路。设备名与端口都不写，宿主自己会填宿主机名和默认端口。
   */
  async function applyAuto(toggle: boolean) {
    if (busy) return
    setBusy(true)
    if (toggle) setConnectionAttemptSettled(false)
    setError('')
    const patch: ConfigPatch = {
      relayUrl: PUBLIC_RELAY_URL,
      lanEnabled: true,
      pairingPolicy: 'code',
    }
    if (preferred) patch.preferredLanAddress = preferred
    try {
      setStatus(await apiPost<StatusView>('/api/relay/config', patch))
      if (toggle) {
        setStatus(await apiPost<StatusView>('/api/relay/toggle', { enabled: true }))
        // 告诉宿主「这台机器走过引导了」，下次打开直接进主页。失败不算这一步失败：
        // 老宿主没有这条路由，二维码照样出得来，只是下次还会再引导一遍。
        await apiPost('/api/relay/onboarded', {}).catch(() => undefined)
      }
      await loadPairing()
      if (toggle) {
        void watch().finally(() => {
          if (alive.current) setConnectionAttemptSettled(true)
        })
      }
    } catch (err) {
      if (toggle && alive.current) setConnectionAttemptSettled(true)
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  /** 底部那颗按钮与进页那一下走同一份。 */
  async function connect() {
    await applyAuto(true)
  }

  /** 进插件：引导过了就直接去主页，没指定去向就跳根路径。 */
  function enterNow() {
    if (onDone) onDone()
    else window.location.assign('/')
  }

  /**
   * 给 AI 的那段话（Tailcat 不可用时复制出去）。
   *
   * 与防火墙那封委托信同一个套路：**不由面板给步骤**。这条通道的助手是按平台随插件装的
   * （`dsh-mobile-tailcat-<平台>` 可选依赖），装没装、这个系统怎么补，得看用户手上有什么；
   * 写死一套命令只会对不上他的机器。所以只交代「在做什么、卡在哪、请先问清楚再动手」。
   */
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

  const qrSvg = pairing?.svg ?? ''

  /**
   * Tailcat 隧道那一行：状态词与 `TailcatDialog` 同一套口径（那里已经有一份
   * `statusTextKey`，这里只要显示、不要管理）。
   *
   * **不拦扫码**：隧道只是二维码里那三条路中的一条，助手还没起来（或压根没有）时，
   * 局域网与公用中转照旧能用，所以这一行只报状态，不挡任何按钮。
   */
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
  /** 「正在启动」是过渡态，问号没用（再等一两秒就好）；其余不顺利的几档才给问号。 */
  const tailcatAsking = tailcatState !== 'ready' && tailcatState !== 'starting'
  const tailcatText = {
    ready: t('panel.tailcat.ready'),
    starting: t('panel.tailcat.starting'),
    disabled: t('panel.tailcat.disabled'),
    error: t('panel.tailcat.error'),
    unavailable: t('panel.tailcat.unavailable'),
  }[tailcatState]
  const tailcatToneValue: Tone = tailcatState === 'ready' ? 'ok' : tailcatState === 'starting' ? 'warn' : 'off'

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 pt-6 pb-24">
      {fatal ? (
        <Alert className="w-full max-w-4xl" variant="error">
          <AlertIcon />
          <AlertTitle>{t('panel.onboarding.statusFailed')}</AlertTitle>
          <AlertDescription>{fatal}</AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert className="w-full max-w-4xl" variant="error">
          <AlertIcon />
          <AlertTitle>{t('panel.onboarding.stepFailed')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card frame="solid" className="w-full max-w-4xl">
        <div className="grid items-center gap-6 px-4 pb-2 md:grid-cols-[minmax(320px,1fr)_minmax(0,1fr)]">
          <div className="flex flex-col items-center gap-2 md:col-start-1 md:row-start-1">
            {/* 标题这一行常驻（有没有码都占着），放大那颗小图标就挂在它右边 ——
                既不另外占一行，也让「这块是扫码用的」在两种状态下说的是同一句话。 */}
            <div className="flex h-5 w-full max-w-[320px] items-center justify-center gap-1.5">
            <p className="text-sm font-medium leading-5 text-foreground-strong">
              {t('panel.onboarding.pairingHint')}
            </p>
            {qrSvg ? (
              <button
                type="button"
                aria-label={`${t('panel.pairing.qrZoom')}：${t('panel.pairing.qr')}`}
                title={t('panel.pairing.qrZoom')}
                className="cursor-pointer text-foreground-muted hover:text-foreground-strong focus-visible:outline-none"
                onClick={() => setQrZoomOpen(true)}
              >
                <svg
                  viewBox="0 0 24 24"
                  className="size-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                >
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
              <div
                className="size-[320px] max-w-full rounded-lg bg-white p-3 [&_svg]:h-full [&_svg]:w-full"
                // 宿主自己吐的 SVG，不是用户输入。
                dangerouslySetInnerHTML={{ __html: qrSvg }}
              />
            </button>
          ) : (
            <div className="flex size-[320px] max-w-full items-center justify-center rounded-lg border border-border-muted text-xs text-foreground-muted">
              {busy ? <Spinner /> : t('panel.onboarding.noQr')}
            </div>
          )}
          {/* 一行固定高度的提示位：中转还没连上时在这一格说；空着也占位，左栏不会跟着抽动。 */}
          <p className="min-h-4 max-w-[320px] text-center text-xs leading-4 text-foreground-muted">
            {!readyNow && qrSvg ? t('panel.onboarding.relayNotConnected') : ''}
          </p>
          </div>

          {/* 右栏：把「下载 APP 弹窗」里那四条渠道直接铺在这儿 —— 手机还没装 App 的人
              一进来就能看到怎么装，不必先点开一颗按钮再挑。组件与主页那个弹窗共用同一份。
              标题居中、整块 `justify-center` 上下居中，与左栏二维码那一块对齐。 */}
          <div className="flex min-w-0 flex-col justify-center gap-3 md:col-start-2 md:row-start-1">
            <p className="text-center text-sm font-medium text-foreground-strong">{t('panel.download.title')}</p>
            <DownloadChannelsGrid />
          </div>

          {/* 状态结论跨满底部，避免只挤在二维码下方。 */}
          <div className="w-full md:col-span-2 md:row-start-2 [&_dt]:text-foreground-strong">
            <InfoList>
              <InfoRow label={t('panel.onboarding.direct')}>
                <ToneValue tone={lanTone(status?.lan.state ?? 'off', true)} text={lanText(status?.lan.state ?? 'off', true)} />
              </InfoRow>
              <InfoRow label={t('panel.connection.tunnel')}>
                <ToneValue tone={tunnelTone(status?.tunnel.state ?? 'off')} text={tunnelText(status?.tunnel.state ?? 'off')} />
              </InfoRow>
              {/* Tailcat 隧道：二维码里第三条路。只管报状态，不挡扫码 —— 它起不来时
                  局域网与中转照旧能连。不顺利的几档挂一颗问号，点开说清是什么情况。 */}
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
              {/* 防火墙放没放行；查不到就写查不到。 */}
              <InfoRow label={t('panel.selfcheck.firewall')}>
                <ToneValue tone={firewallInfo.tone} text={firewallInfo.text} detail={firewallInfo.detail} />
              </InfoRow>
            </InfoList>

            {/* 清单下面那一句是宿主的 `verdict` 里**出问题的那几种**：没在监听、防火墙挡了、
                手机这三十分钟没来过、以及查不到。正常时不显示（上面几行已经全绿）。
                它跟着清单走而不是单开一张卡 —— 它是上面那几行的落款。 */}
            {showSelfcheckVerdict ? (
              <p
                className={`mt-2 text-sm leading-relaxed break-words ${toneText[verdictTone(selfcheckVerdict)]}`}
              >
                {verdictText(selfcheckVerdict)}
              </p>
            ) : null}

            {/*
              结论只由能观测到的事实决定：宿主这边起没起来，直接看同一份 `status`。
              报错就如实说报错，不装成成功。
            */}
            {status !== null && (status.lan.state === 'error' || status.tunnel.state === 'error') ? (
              <Alert className="mt-2" variant="error">
                <AlertIcon />
                <AlertTitle>
                  {status.lan.state === 'error' ? t('panel.onboarding.lanFailed') : t('panel.onboarding.relayFailed')}
                </AlertTitle>
                <AlertDescription>
                  {status.lan.state === 'error'
                    ? status.lan.error
                      ? t('panel.onboarding.lanErrorWithPort', { error: status.lan.error })
                      : t('panel.onboarding.lanNoStart')
                    : status.tunnel.error
                      ? t('panel.onboarding.tunnelErrorHint', { error: status.tunnel.error })
                      : t('panel.onboarding.tunnelNoStart')}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-4">
          {/* 手机连不上时最常见的原因是防火墙，入口就摆在底部一行。 */}
          <button
            type="button"
            className="cursor-pointer text-sm text-foreground-intense underline underline-offset-2 hover:text-foreground-strong"
            onClick={() => setFirewallOpen(true)}
          >
            {t('panel.onboarding.checkFirewall')}
          </button>
          {readyNow ? (
            <Button variant="primary" onClick={enterNow}>
              {t('panel.onboarding.enterPlugin')}
            </Button>
          ) : (
            <Button variant="primary" disabled={busy || fatal !== ''} onClick={() => void connect()}>
              {busy ? t('panel.onboarding.opening') : t('panel.onboarding.connectRelay')}
            </Button>
          )}
        </div>
      </Card>

      {/*
        「检查防火墙」弹窗：手机连不上局域网地址时最常见的原因就是这一步。
        三栏按系统并排（Linux / Mac / Windows），各给一段能直接照抄的排查命令 ——
        这里只讲「怎么确认它确实在放行」，页面自己不去跑这些命令（本机运维界面没有、
        也不该有执行 shell 的能力面，见移动 API 的能力面约定）。
      */}
      <FirewallDialog open={firewallOpen} onOpenChange={setFirewallOpen} port={lanPortText} />

      {/* 放大二维码：与卡片里那颗是同一份 SVG，只是给到能凑近扫的尺寸。 */}
      <Dialog open={qrZoomOpen} onOpenChange={setQrZoomOpen}>
        <DialogContent className="w-[min(680px,94vw)] max-w-none" closeLabel={t('panel.common.close')}>
          <DialogHeader>
            <DialogTitle>{t('panel.pairing.qr')}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col items-center gap-3">
              <div className="flex items-center justify-center rounded-md bg-white p-4">
                {qrSvg ? (
                  <div
                    className="size-[min(72vh,600px)] [&_svg]:h-full [&_svg]:w-full"
                    dangerouslySetInnerHTML={{ __html: qrSvg }}
                  />
                ) : null}
              </div>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>

      {/*
        Tailcat 隧道那一行问号点开的弹窗：**只说三件事** —— 这条通道是干嘛的、你现在是什么情况、
        下一步怎么办。怎么办不写步骤（装助手要看系统与安装方式），照搭建教程与防火墙那套
        交一段话给用户自己的 AI，让他去问清楚再动手。
      */}
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
                void copyTailcatPrompt().then((ok) =>
                  setCopied(t(ok ? 'panel.onboarding.copiedOk' : 'panel.onboarding.copiedFailed')),
                )
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

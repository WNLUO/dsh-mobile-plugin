// 网络配置与立即更新共用主按钮样式。
// 2026-11-22：网络配置由弹窗改为独立一页，Console 打开它时把首页内容收起。
// 固定端口与端口号通过同一次配置保存。
// Cloudflare 兜底的管理弹窗在这里挂载，连接卡那行「管理」打开它。
/**
 * 面板控制台（`/api/relay/panel/console`，也是面板主页）：桌面端那颗手机图标点开的那一窗。
 *
 * 定位：**面板唯一的主页**（2026-11-15 起取代了原先的网页设置页，老版 `App.tsx` 已下线）。
 * 它不另画一套控件，而是把那些功能块（配对二维码、连接状态、已绑定设备、插件更新、收件
 * 目录、公告、网页管理窗口）与它们全部弹窗都接进来，只把**页面编排**重做一遍：没有大标题、
 * 没有说明段，顶上一条紧凑的状态栏，下面内容按屏幕宽度自己铺开、整页可以滚动。重要的事
 * （扫码、连没连上）排最前。
 *
 * 这一页最常出现的地方是 DSH 里嵌的那一窗（`lib/client.js` 的 `openConsole`），而那一窗
 * **收起时不销毁**、下次直接亮回来 —— 所以这一页的轮询由 `pageVisible()` 统一判「现在该不该
 * 跑」（父窗口收起时会通知，见 `lib/embed-visibility.ts`），别写回裸的 `document.hidden`。
 *
 * 设备卡按连接卡高度封顶，多出来的在卡内滚动。
 */
// 控制台按实际状态报告就绪，FRP 随父窗保存，地址读取错误可独立重试。
// 2026-11-20 用户要求：顶栏不再写设备名，只留状态点与版本徽标。
import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@appica/ui-react/alert'
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { Card } from '@appica/ui-react/card'
import { Spinner } from '@appica/ui-react/spinner'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@appica/ui-react/dialog'
import { useCallback, useEffect, useRef, useState } from 'react'

import { ChinaLinesPage } from './components/ChinaLinesPage.tsx'
import { CloudflareDialog } from './components/CloudflareDialog.tsx'
import { CloudflarePage } from './components/CloudflarePage.tsx'
import { GlobalLinesPage } from './components/GlobalLinesPage.tsx'
import { JdxbPage } from './components/JdxbPage.tsx'
import { ZeroNewsPage } from './components/ZeroNewsPage.tsx'
import { ConnectionCard } from './components/ConnectionCard.tsx'
import { LanguageMenu } from './components/LanguageMenu.tsx'
import { PanelWindowActions } from './components/PanelWindowActions.tsx'
import { ConsoleThemeToggle } from './components/ThemeToggle.tsx'
import { DevicesCard } from './components/DevicesCard.tsx'
import { FloatingActions } from './components/FloatingActions.tsx'
import { InboxCard } from './components/InboxCard.tsx'
import type { Issue } from './components/IssueMark.tsx'
import { PairingCard } from './components/PairingCard.tsx'
import { P2PDialog } from './components/P2PDialog.tsx'
import { PortDialog } from './components/PortDialog.tsx'
import { PublicRelayNoticeDialog } from './components/PublicRelayNoticeDialog.tsx'
import { RelayConfigDialog } from './components/RelayConfigDialog.tsx'
import { TailcatDialog } from './components/TailcatDialog.tsx'
import { UpdateCard } from './components/UpdateCard.tsx'
import {
  apiGet,
  apiPost,
  errorText,
  stopFrp,
  pairingRenewIn,
  type AddressBook,
  type ConfigPatch,
  type PairingInfo,
  type PairingPolicy,
  type StatusView,
} from './lib/api.ts'
import { Dot } from './components/InfoRow.tsx'
import { type Tone } from './lib/format.ts'
import { isPublicRelayUrl } from './lib/links.ts'
import { pageVisible } from './lib/embed-visibility.ts'
import { hashOfPage, pageFromHash, PROVIDERS, type NetworkPage, type NetworkProvider, type NetworkRegion, type ProviderPage } from './lib/network-region.ts'
import { reportPanelState } from './lib/panel-load.ts'
import { t } from './lib/i18n/index.ts'
import { useNotify } from './lib/notify.ts'

/**
 * 这一页轮询的相位偏移。
 *
 * 设备卡（`DevicesCard`）自己有一条 3 秒轮询，两条都从挂载那一刻起算就会永远同拍：每 3 秒
 * 两发请求一起到宿主、回来又一起触发重画，慢机器上就是隔一会儿顿一下。晚 1.5 秒起跑，
 * 两条就落在彼此的间隙里。**不追求精确**，只要不重合。
 */
const STATUS_PHASE_OFFSET_MS = 1500;

/**
 * 首屏落地之后再补次要请求的等待。
 *
 * 这一窗打开那一刻，七条接口原先是一起发的；其中 `/api/relay/pairing` 要在宿主里现开一次
 * 隧道配对窗口（实测 0.8～3 秒，偶尔更久），而它换来的二维码本来就遮在「显示」按钮后面。
 * 让它排到首屏出来之后，打开那一下就不会被它拖住。
 */
const AFTER_FIRST_PAINT_MS = 600;

/** 收件文件入口的垃圾桶图标：带盖的中性描边图标，不摆成红色/删除动作那一类。 */
function TrashIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7h16" />
      <path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7" />
      <path d="M6 7l1 12.5A2 2 0 0 0 9 21h6a2 2 0 0 0 2-1.5L18 7" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}

export function Console() {
  const [status, setStatus] = useState<StatusView | null>(null)
  const [fatal, setFatal] = useState('')
  const [busy, setBusy] = useState('')
  const [pairing, setPairing] = useState<PairingInfo | null>(null)
  const [pairingError, setPairingError] = useState('')
  const [addresses, setAddresses] = useState<AddressBook | null>(null)
  const [addressError, setAddressError] = useState('')
  /** 更新卡报上来的版本对不上详情，挂到左列「运行中版本」那行。 */
  const [versionIssues, setVersionIssues] = useState<Issue[]>([])
  /**
   * 网络配置是一组独立页：主配置页 `#network`，国内 / 国际线路各一页（`#network/cn`、
   * `#network/global`）。地址进 hash，刷新与前进后退都停在同一页。
   */
  const pageFromLocation = (): NetworkPage => (typeof window !== 'undefined' && window.location
    ? pageFromHash(window.location.hash)
    : 'home')
  const [page, setPage] = useState<NetworkPage>(pageFromLocation)
  // 浏览器前进 / 后退或手改 hash 时，让视图跟着地址走。
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
    const sync = () => setPage(pageFromLocation())
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])
  /** 换页只写 hash 一处，地址栏与视图不会各说各的。`replace` 用于「返回上一层」，别堆历史。 */
  const showPage = (next: NetworkPage, replace = false) => {
    setPage(next)
    if (typeof window === 'undefined' || !window.location) return
    const hash = hashOfPage(next)
    const base = window.location.pathname + window.location.search
    const url = hash ? `${base}#${hash}` : base
    if (replace && typeof history !== 'undefined' && typeof history.replaceState === 'function') history.replaceState(null, '', url)
    else if (hash) window.location.hash = hash
    else window.location.hash = ''
  }
  const openNetwork = () => showPage('network')
  const closeNetwork = () => showPage('home', true)
  /** 进地区子页：地址栏留一层历史，浏览器返回键就回主配置页。 */
  const openRegion = (region: NetworkRegion) => showPage(region)
  const backToNetwork = () => showPage('network', true)
  /** 进服务商页：地址栏留一层历史，浏览器返回键回地区页。 */
  const openProvider = (provider: NetworkProvider) => showPage(`${PROVIDERS[provider].region}/${provider}` as ProviderPage)
  /** 从服务商页退回它所属的地区页（不堆历史）。 */
  const backToRegion = (region: NetworkRegion) => showPage(region, true)
  const [portOpen, setPortOpen] = useState(false)
  const [tailcatOpen, setTailcatOpen] = useState(false)
  const [p2pOpen, setP2POpen] = useState(false)
  const [cloudflareOpen, setCloudflareOpen] = useState(false)
  const [inboxOpen, setInboxOpen] = useState(false)
  const notify = useNotify()
  useEffect(() => {
    if (status) reportPanelState('ready')
    else if (fatal) reportPanelState('error', fatal)
  }, [status, fatal])

  /**
   * 连接状态卡与「已绑定设备」并排：设备区高度跟左边连接卡一致，设备少时也撑着、不缩。
   * 连接卡内容较稳，量它的实际高度套给设备卡；设备多了在卡内滚动，不再把整列撑长。
   */
  const connectionRef = useRef<HTMLDivElement | null>(null)
  const [connectionHeight, setConnectionHeight] = useState(0)
  useEffect(() => {
    const el = connectionRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const measure = () => setConnectionHeight(el.getBoundingClientRect().height)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [status])

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await apiGet<StatusView>('/api/relay/status'))
      setFatal('')
    } catch (err) {
      setFatal(errorText(err))
    }
  }, [])

  const loadPairing = useCallback(async () => {
    setPairingError('')
    try {
      setPairing(await apiGet<PairingInfo>('/api/relay/pairing'))
      setPairingError('')
    } catch (err) {
      setPairing(null)
      setPairingError(errorText(err))
    }
  }, [])

  const loadAddresses = useCallback(async () => {
    try {
      setAddresses(await apiGet<AddressBook>('/api/relay/addresses'))
      setAddressError('')
    } catch (err) {
      setAddresses(null)
      setAddressError(errorText(err))
    }
  }, [])

  // 3 秒一轮，页面切到后台就停。
  //
  // 首拍必须**当场**发（整页在拿到状态之前只有一圈转圈），但此后那一串要跟设备卡自己的
  // 3 秒轮询**错开相位**（2026-11-13）：两条都从挂载那一刻起算，于是每 3 秒两发请求永远
  // 同时到达，宿主一起排队、主线程一起重画。这里补一次 1.5 秒的起跑偏移，两条就落在彼此
  // 的间隙里；差值不用精确，错开一拍就够。
  useEffect(() => {
    const tick = () => {
      if (!pageVisible()) return
      void loadStatus()
    }
    tick()
    let timer = 0;
    const offset = window.setTimeout(() => {
      timer = window.setInterval(tick, 3000)
    }, STATUS_PHASE_OFFSET_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearTimeout(offset)
      if (timer) window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [loadStatus])

  /**
   * 打开这一窗时**先让首屏落地，再补次要的那几发**。
   *
   * 原先挂载那一刻七条接口是并发的（状态 / 配对 / 地址 / 更新 / 收件 …），其中
   * `/api/relay/pairing` 要在宿主里现开一次隧道配对窗口，实测 0.8～3 秒、偶尔更久 ——
   * 它跟首屏那一屏无关（二维码本来就在「显示」按钮后面），却和另外几发抢同一个线程与同一条
   * 连接，用户看到的就是「点开先卡一两秒」。现在把它排到首屏出来之后单独跑。
   */
  useEffect(() => {
    if (!status?.enabled) return undefined
    const timer = window.setTimeout(() => void loadPairing(), AFTER_FIRST_PAINT_MS)
    return () => window.clearTimeout(timer)
  }, [status?.enabled, loadPairing])

  // 配对成功那一刻宿主换掉码：`pairingCode` 一变就重取。
  useEffect(() => {
    if (!status?.enabled || !pairing) return
    if (status.pairingCode && pairing.pairingCode !== status.pairingCode) void loadPairing()
  }, [status?.pairingCode, status?.enabled, pairing, loadPairing])

  // 隧道段临期前续一次；失败留着屏幕上那张（与主页同一条口径）。
  const renewPairing = useCallback(async () => {
    try {
      setPairing(await apiGet<PairingInfo>('/api/relay/pairing'))
      setPairingError('')
    } catch {
      /* 留着原来那张。 */
    }
  }, [])

  useEffect(() => {
    if (!status?.enabled) return
    const wait = pairingRenewIn(pairing)
    if (wait === null) return
    const timer = window.setTimeout(() => void renewPairing(), wait)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 按每一版新码的 expiresAt 重排
  }, [pairing, status?.enabled, renewPairing])

  useEffect(() => {
    if (!status?.enabled) return undefined
    // 地址库只喂「本地识别地址」那个弹窗与网络配置，同样不必跟首屏抢。挂在 `pairing` 上是因为
    // 换码 / 改端口之后候选地址可能跟着变（与主页那条同一个口径）。
    const timer = window.setTimeout(() => void loadAddresses(), AFTER_FIRST_PAINT_MS)
    return () => window.clearTimeout(timer)
  }, [status?.enabled, pairing, loadAddresses])

  useEffect(() => {
    if (page !== 'network' || !status?.enabled) return
    void loadPairing()
    void loadAddresses()
  }, [page, status?.enabled, loadPairing, loadAddresses])

  /**
   * 全局 busy 的真相放在 ref 里：`busy` 状态给界面渲染用，但并发进来的第二个 `act`
   * 读不到还没生效的 `busy`，会把手上的操作覆盖掉、再提前清空。用 `busyRef` 挡住并发，
   * 并保证只有发起的那一次才把 busy 清回空串。
   */
  const busyRef = useRef('')
  const act = useCallback(async (label: string, run: () => Promise<void>) => {
    if (busyRef.current !== '') return
    busyRef.current = label
    setBusy(label)
    try {
      await run()
    } catch (err) {
      notify('error', errorText(err))
    } finally {
      busyRef.current = ''
      setBusy('')
    }
  }, [notify])

  const toggle = (enabled: boolean) =>
    act('toggle', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/toggle', { enabled }))
      if (enabled) {
        await loadPairing()
      } else {
        setPairing(null)
        setPairingError('')
      }
      notify('soft', enabled ? t('panel.shell.remoteEnabled') : t('panel.shell.remoteDisabled'))
    })

  const restartSidecar = () =>
    act('restart', async () => {
      const payload = await apiPost<{ status: StatusView }>('/api/relay/restart-sidecar')
      setStatus(payload.status)
      notify('soft', t('panel.shell.sidecarRestarted'))
    })

  /**
   * 保存网络配置。
   *
   * FRP 的导入在它自己那一栏里完成（导入即启动 frpc、地址写进独立的 `frpUrl`），不再借保存
   * 这一步捎带：那条隧道现在是一条独立线路，和用户手填的「TCP 直连」互不相干。
   */
  const saveConfig = (patch: ConfigPatch) =>
    act('config', async () => {
      try {
        setStatus(await apiPost<StatusView>('/api/relay/config', patch, { timeoutMs: 60_000 }))
      } catch (error) {
        throw error
      }
      closeNetwork()
      await Promise.all([loadPairing(), loadAddresses()])
      notify('soft', t('panel.shell.configSaved'))
    })

  const stopFrpTunnel = () => {
    if (!window.confirm(t('panel.frp.stopConfirm'))) return
    void act('frp', async () => {
      await stopFrp()
      await Promise.all([loadStatus(), loadAddresses(), loadPairing()])
    })
  }

  /**
   * 改配置：宿主回包带 applyError 时配置也已经落盘。把新状态照常写回，开关当场生效；
   * 下发失败仍按原口径报错，不说成「保存成功」。
   */
  const postConfig = (patch: ConfigPatch, okKey: string) =>
    act('config', async () => {
      const payload = await apiPost<StatusView & { applyError?: string }>('/api/relay/config', patch, { keepApplyError: true, timeoutMs: 60_000 })
      setStatus(payload)
      if (payload.applyError) {
        notify('error', t('panel.shell.applyFailed', { message: payload.applyError }))
      } else {
        notify('soft', t(okKey))
      }
    })

  const savePolicy = (pairingPolicy: PairingPolicy) =>
    postConfig({ pairingPolicy }, pairingPolicy === 'code' ? 'panel.shell.deviceAllowed' : 'panel.shell.deviceDenied')

  const saveControlReport = (enabled: boolean) =>
    postConfig({ controlReportEnabled: enabled }, 'panel.shell.configSaved')

  const saveLanPort = (port: number, lanPortFixed: boolean) =>
    act('lan', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/config', { lanPort: port, lanPortFixed }))
      setPortOpen(false)
      await loadPairing()
      notify('soft', t('panel.shell.lanSaved'))
    })

  const savePreferredLanAddress = (address: string) =>
    act('lan', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/config', { preferredLanAddress: address }))
      await Promise.all([loadPairing(), loadAddresses()])
      notify('soft', address ? t('panel.shell.preferredAddress', { address }) : t('panel.shell.preferredAuto'))
    })

  /**
   * 刷新二维码：作废当前这张码、换一张新的（放大弹窗底部那颗）。
   *
   * 新码与状态**同一拍落**：先拿到新码再一起 set，弹窗里的图不会经历「先清空再重画」
   * 的那一帧。旧码/旧截图的票据随 `rotatePairing` 一并作废。
   */
  const refreshQr = () =>
    act('pairing', async () => {
      const next = await apiPost<StatusView>('/api/relay/regenerate')
      const info = await apiGet<PairingInfo>('/api/relay/pairing')
      setPairing(info)
      setPairingError('')
      setStatus(next)
      notify('soft', t('panel.pairing.qrRefreshed'))
    })

  /** 顶栏那枚点：中转通了或局域网在听 = 正常；开着但都没通 = 琥珀；远程没开 = 灰。 */
  const tone: Tone | null = status
    ? status.tunnel.state === 'connected' || status.lan.state === 'listening'
      ? 'ok'
      : status.enabled
        ? 'warn'
        : 'off'
    : null

  if (!status) {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-3 p-5">
        {fatal ? (
          <p className="text-sm text-error">{fatal}</p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-foreground-muted">
            <Spinner />
            {t('panel.shell.readingStatus')}
          </p>
        )}
      </main>
    )
  }

  return (
    <main className="mx-auto flex w-full max-w-[1200px] flex-col gap-3 p-4 sm:p-5">
      {/* 顶上一条窄栏：只剩「现在怎么样」与两个出口。没有大标题、没有说明段 ——
          那一屏的空间要留给二维码和设备。 */}
      {page !== 'home' ? null : (
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {tone ? <Dot tone={tone} /> : null}
          <Badge variant="soft" size="sm">
            {status.appVersion || t('panel.shell.unknownVersion')}
          </Badge>
          {/* 2026-11-17 用户要求：Star / 赞助 / 交流群从页面悬浮挪进顶栏、挨着左侧设备名。 */}
          <FloatingActions compact />
        </div>
        {busy ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-foreground-muted">
            <Spinner />
            {t('panel.shell.busy')}
          </span>
        ) : null}
        <div className="flex flex-wrap items-center gap-1">
          {/* 2026-11-17：原先这里有「报错调试」与「重新连接」两颗——调试页整体删掉；
              重新连接与「插件更新」卡的重启是同一件事，只留卡里那颗，不重复摆。
              2026-11-20 用户要求：公告按钮与它的弹窗一并删掉。 */}
          {/* 2026-11-17 用户要求：语言、日夜、收件三颗与窗口操作排在顶栏最右，成整齐一排。
              语言与日夜是「这一页怎么显示」；昼夜拧的是这一窗的主题（默认跟随 DSH，按下
              之后改手动，见 `lib/shell-theme.ts`）。收件文件是弹窗入口（中性色垃圾桶，不
              摆成删除动作），点开才拉取与清理。 */}
          <LanguageMenu />
          <ConsoleThemeToggle />
          <Button
            variant="ghost"
            size="icon-md"
            aria-label={t('panel.inbox.title')}
            title={t('panel.inbox.title')}
            onClick={() => setInboxOpen(true)}
          >
            <TrashIcon />
          </Button>
          {/* 内嵌窗的窗口操作（浏览器打开 / 关闭）画在页面里，动作交回外壳执行。 */}
          <PanelWindowActions />
        </div>
      </header>
      )}

      {fatal ? (
        <Alert variant="error">
          <AlertIcon />
          <AlertTitle>{t('panel.shell.statusFailed')}</AlertTitle>
          <AlertDescription>{fatal}</AlertDescription>
        </Alert>
      ) : null}

      {/*
        内容区自上而下：
        1. 顶栏是一张无标题整卡（2026-11-20 用户要求合并）：左边 6 成放二维码与只读信息
           （含运行中版本），右边 4 成全放控件；窄屏整卡收成单列。
           原先这一行的「远程电脑」已抽到独立页（桌面侧边栏那颗电脑图标点开）。
        2. 「连接状态 + 已绑定设备」并排：设备区高度对齐左边连接卡（见上面那个 ResizeObserver），
           设备再多也在卡内滚动。
        3. 其余维护类卡片按瀑布式几列铺开。
        整页滚动，不做单栏 sticky、也不套内滚动条。
      */}
      {/* 「网络配置」现在是一整页（见 RelayConfigDialog）：打开时把首页内容收起，只留它那一页。 */}
      <div className={page !== 'home' ? 'hidden' : 'grid grid-cols-1 gap-3'}>
        <Card frame="solid">
          <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-10 lg:gap-6">
            <div className="lg:col-span-6">
              <PairingCard
                bare
                status={status}
                pairing={pairing}
                busy={busy}
                error={pairingError}
                onRetryPairing={() => void loadPairing()}
                onRefreshQr={() => void refreshQr()}
                onChangePolicy={(policy) => void savePolicy(policy)}
                onToggleRemote={(enabled) => void toggle(enabled)}
                onChangeControlReport={(enabled) => void saveControlReport(enabled)}
              />
            </div>
            {/* 右列先留空：2026-11-23 起四个控件挪到二维码旁边，这里等后续加新东西。 */}
            <div className="lg:col-span-4" />
          </div>

          {/* 更新区独占一排：上面两列内容再怎么变，都不推动这一排按钮。
              版本对不上的详情交给连接状态卡「运行中版本」那行的感叹号。 */}
          <div className="mt-4 flex h-12 items-center justify-end border-t border-border-muted">
            <UpdateCard
              bare
              version={status.appVersion || ''}
              busy={busy}
              onRestartSidecar={() => void restartSidecar()}
              onIssues={setVersionIssues}
              extraActions={
                <>
                  <Button variant="primary" size="sm" onClick={openNetwork}>
                    {t('panel.pairing.openConfig')}
                  </Button>
                </>
              }
            />
          </div>
        </Card>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div ref={connectionRef}>
            <ConnectionCard
              status={status}
              addressBook={addresses}
              busy={busy}
              port={pairing?.lanPort ?? status.lan.port}
              portAdjusted={pairing?.lanPortAdjusted}
              version={status.appVersion || ''}
              versionIssues={versionIssues}
              onEditPort={() => setPortOpen(true)}
              onStopFrp={stopFrpTunnel}
              onManageTailcat={() => setTailcatOpen(true)}
              onManageP2P={() => setP2POpen(true)}
              onManageCloudflare={() => setCloudflareOpen(true)}
              restartError={status.sidecar.restartError}
            />
          </div>
          <div className="min-h-0" style={connectionHeight > 0 ? { height: `${connectionHeight}px` } : undefined}>
            <DevicesCard busy={busy} fill />
          </div>
        </div>

        {/*
          其余卡片用**瀑布式几列**（CSS `columns`）：每张卡都往下接，窄屏自动收到一列。
          `break-inside-avoid` 保证一张卡不会被劈到两列里。
        */}
        <div className="columns-1 gap-3 md:columns-2 xl:columns-3 [&>*]:mb-3 [&>*]:break-inside-avoid">
        </div>
      </div>

      <RelayConfigDialog
        open={page === 'network'}
        onOpenChange={(next) => (next ? openNetwork() : closeNetwork())}
        status={status}
        addressBook={addresses}
        addressError={addressError}
        onRetryAddresses={() => void loadAddresses()}
        lanUrls={pairing?.lanUrls ?? []}
        busy={busy}
        onSave={(patch) => void saveConfig(patch)}
        onSavePreferred={(address) => void savePreferredLanAddress(address)}
        onOpenRegion={openRegion}
      />

      <ChinaLinesPage
        open={page === 'cn'}
        onOpenChange={(next) => (next ? openRegion('cn') : backToNetwork())}
        onOpenProvider={openProvider}
      />

      <ZeroNewsPage
        open={page === 'cn/zeronews'}
        onOpenChange={(next) => (next ? openProvider('zeronews') : backToRegion('cn'))}
        status={status}
        busy={busy}
      />

      <JdxbPage
        open={page === 'cn/jdxb'}
        onOpenChange={(next) => (next ? openProvider('jdxb') : backToRegion('cn'))}
        status={status}
      />

      <GlobalLinesPage
        open={page === 'global'}
        onOpenChange={(next) => (next ? openRegion('global') : backToNetwork())}
        onOpenProvider={openProvider}
      />

      <CloudflarePage
        open={page === 'global/cloudflare'}
        onOpenChange={(next) => (next ? openProvider('cloudflare') : backToRegion('global'))}
        status={status}
        onChanged={() => void loadStatus()}
      />

      <TailcatDialog open={tailcatOpen} onOpenChange={setTailcatOpen} onChanged={() => void loadStatus()} />

      <P2PDialog open={p2pOpen} onOpenChange={setP2POpen} onChanged={() => void loadStatus()} />

      <CloudflareDialog open={cloudflareOpen} onOpenChange={setCloudflareOpen} status={status} onChanged={() => void loadStatus()} />

      <PortDialog
        open={portOpen}
        onOpenChange={setPortOpen}
        port={pairing?.lanPort ?? status.lan.requestedPort ?? status.lan.port}
        busy={busy}
        fixed={status.lanPortFixed === true}
        forwarding={status.lanPortLockReason === 'forwarding'}
        onSave={(port, fixed) => void saveLanPort(port, fixed)}
      />

      {/* 收件文件：原先常驻的那张卡，现在收进这扇弹窗，由顶栏那颗垃圾桶图标打开。 */}
      <Dialog open={inboxOpen} onOpenChange={setInboxOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('panel.inbox.title')}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <InboxCard framed={false} busy={busy} />
          </DialogBody>
        </DialogContent>
      </Dialog>

      {/* 公用中转体验提示：只在公用中转启用时弹（relayUrl 命中内置清单），停用时整扇不渲染。
          「网络配置」按钮直接把上面那扇配置窗打开。 */}
      <PublicRelayNoticeDialog
        visible={isPublicRelayUrl(status.relayUrl)}
        onOpenConfig={openNetwork}
      />
    </main>
  )
}

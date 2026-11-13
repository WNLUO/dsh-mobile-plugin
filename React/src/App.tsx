/**
 * 网页版设置页的主页（`dsh-mobile-plugin/lib/panel/index.html` 的产物源）。
 *
 * 只做展示与转发：每张卡片的信息都来自 `/api/relay/*`（宿主是唯一事实来源），页面自己
 * 不留状态副本。这一页由浏览器加载，改完刷新即生效；插件设置页签那一半要完整安装 +
 * 重启 DSH 才换得掉。
 *
 * 配对二维码在隧道段临期前会自己重取一次（见下面 `renewPairing` 那段），所以一直开着这一页
 * 也扫得动 —— 手机装完 App 回来扫的往往就是它。
 */
import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@appica/ui-react/alert'
import { pageVisible } from './lib/embed-visibility.ts'
import { t } from './lib/i18n/index.ts'
import { Badge } from '@appica/ui-react/badge'
import { Spinner } from '@appica/ui-react/spinner'
import { useCallback, useEffect, useState } from 'react'

import { ConnectionCard } from './components/ConnectionCard.tsx'
import { DevicesCard } from './components/DevicesCard.tsx'
import { NoticeBoard } from './components/NoticeBoard.tsx'
import { PortDialog } from './components/PortDialog.tsx'
import { PairingCard } from './components/PairingCard.tsx'
import { RelayConfigDialog } from './components/RelayConfigDialog.tsx'
import { SelfCheckDialog } from './components/SelfCheckDialog.tsx'
import { TailcatDialog } from './components/TailcatDialog.tsx'
import { P2PDialog } from './components/P2PDialog.tsx'
import { UpdateCard } from './components/UpdateCard.tsx'
import { InboxCard } from './components/InboxCard.tsx'
import { WebAccessCard } from './components/WebAccessCard.tsx'
import {
  apiGet,
  apiPost,
  errorText,
  pairingRenewIn,
  type AddressBook,
  type ConfigPatch,
  type PairingInfo,
  type PairingPolicy,
  type RevokeResult,
  type StatusView,
  type Tier,
  type WebAccessState,
} from './lib/api.ts'
import { useNotify } from './lib/notify.ts'
import { mobileLooksIdle, useSelfCheck } from './lib/selfcheck.ts'

/**
 * 移动端插件的设置页（网页版）。
 *
 * 为什么是网页而不是插件里的设置页签：这一半代码由浏览器加载，改完刷新即生效，
 * 不用把整个插件重装一遍、也不用重启 DSH（插件里的客户端半边是启动时就被缓存住的，
 * 换不掉）。所以这里只做**展示与转发**：每个动作都直接打到宿主已有的控制面接口，
 * 页面自己不留状态副本——宿主才是唯一事实来源。
 */
export function App() {
  const [status, setStatus] = useState<StatusView | null>(null)
  /** 读不到状态：整页只剩这一条错误，因为没有状态就没法渲染任何卡片。 */
  const [fatal, setFatal] = useState('')
  /**
   * 「某次动作的结果」一律走右上角的胶囊，不在页面里铺长条。
   * 页面里只留 `fatal` —— 那是「整页读不到状态」，不是一个动作的结果。
   */
  const notify = useNotify()
  const [busy, setBusy] = useState('')
  const [pairing, setPairing] = useState<PairingInfo | null>(null)
  const [pairingError, setPairingError] = useState('')
  const [configOpen, setConfigOpen] = useState(false)
  /** 「修改局域网端口」那个弹窗：入口是配对卡端口行右边的「修改」。 */
  const [portOpen, setPortOpen] = useState(false)
  /**
   * 宿主枚举的地址库：局域网直连弹窗里那个「手机优先用」要它（带网卡名与当前选中的那条）。
   * 只在开窗时取一次，和老宿主兼容（那条路由不存在就保持 null，选择器不摆）。
   */
  const [addresses, setAddresses] = useState<AddressBook | null>(null)
  /** 「连接自检」弹窗：地址那一行下面那张卡的最后一行点开的就是它。 */
  const [selfCheckOpen, setSelfCheckOpen] = useState(false)
  /** 「Tailcat 隧道」管理弹窗：连接状态卡里那行 Tailcat 右侧的「管理」。 */
  const [tailcatOpen, setTailcatOpen] = useState(false)
  /** 「P2P 隧道」管理弹窗：连接状态卡里那行 P2P 右侧的「管理」。 */
  const [p2pOpen, setP2POpen] = useState(false)
  /**
   * 自检**不跟上面那 3 秒轮询**：宿主每答一次都要开子进程查防火墙。
   * 只有两种时候发请求 —— 人点开弹窗（`SelfCheckDialog` 开窗时调 `ensure`），
   * 以及手机三十分钟没来过时的后台补一次（`useSelfCheck` 内部按 5 分钟节流）。
   */
  const selfcheck = useSelfCheck(
    mobileLooksIdle(status?.lastMobileAt),
    // 与引导页同一条：连接状态变了，上一发的自检结论就过期了。
    status ? `${status.enabled ? 1 : 0}|${status.lan.enabled ? 1 : 0}|${status.lan.state}|${status.tunnel.state}|${(status.lastMobileAt ?? 0) > 0 ? 1 : 0}` : '',
  )

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await apiGet<StatusView>('/api/relay/status'))
      setFatal('')
    } catch (err) {
      setFatal(errorText(err))
    }
  }, [])

  const loadPairing = useCallback(async () => {
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
    } catch {
      // 老宿主没有这条路由：那就不摆选择器，地址照旧只在「局域网地址」那一行列出来。
      setAddresses(null)
    }
  }, [])

  // 3 秒一轮，页面切到后台就停。
  useEffect(() => {
    const tick = () => {
      if (!pageVisible()) return
      void loadStatus()
    }
    tick()
    const timer = window.setInterval(tick, 3000)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [loadStatus])

  // 二维码只在远程控制开着时才取：关着的时候宿主回 409，没必要一进页面就亮个警告。
  useEffect(() => {
    if (!status?.enabled || pairing || pairingError) return
    void loadPairing()
  }, [status?.enabled, pairing, pairingError, loadPairing])

  /**
   * 配对成功那一刻宿主会把码与票据一起换掉（`rotatePairing`），状态里那个 `pairingCode`
   * 一变就把这一版配对信息（含二维码 SVG）重取一次 —— 用户不用再按「重新生成」。
   */
  useEffect(() => {
    if (!status?.enabled || !pairing) return
    if (status.pairingCode && pairing.pairingCode !== status.pairingCode) void loadPairing()
  }, [status?.pairingCode, status?.enabled, pairing, loadPairing])

  /**
   * 续码用的重取：**失败就留着屏幕上那张**。
   *
   * `loadPairing` 失败会把码清掉、换一句报错 —— 那适合「一进页面就没取到」。续码是背景动作，
   * 宿主重启或网络抖一下时，屏幕上那张的局域网与中转两段仍能扫，把它换成一句报错反而更糟。
   */
  const renewPairing = useCallback(async () => {
    try {
      setPairing(await apiGet<PairingInfo>('/api/relay/pairing'))
      setPairingError('')
    } catch {
      /* 见上：留着原来那张。下一次改配置、重连、或者重新进这一页再取。 */
    }
  }, [])

  /**
   * 隧道段临期前续一次码（与引导页同一条规矩，见 `Onboarding.tsx` 那段注释）。
   *
   * 码里只有隧道那一段会过期：宿主每取一次码就现开一个两分钟的一次性窗口、并作废上一张。
   * 面板这一页常常一直开着（手机装完 App 回来扫的就是它），不续的话屏幕上那张的隧道段早
   * 就没了，App 静默丢掉它、只剩局域网与中转。
   *
   * **切到后台也照样续**：人正是去装 App 了，回来还要扫这张，停掉续期等于把这一页变成
   * 一打开就过期的码。只续这一版码里的隧道段：没拿到隧道（助手不可用 / 出错）就不排下一拍，
   * 剩下两条路本来就不会过期。
   */
  useEffect(() => {
    if (!status?.enabled) return
    const wait = pairingRenewIn(pairing)
    if (wait === null) return
    const timer = window.setTimeout(() => void renewPairing(), wait)
    return () => window.clearTimeout(timer)
    // 按每一版新码的 `expiresAt` 重排，别跟其它状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上
  }, [pairing, status?.enabled, renewPairing])

  // 地址库在打开「网络配置」时补取一次（地址选择与两条手填地址都读它）。
  useEffect(() => {
    if (!configOpen || !status?.enabled) return
    void loadPairing()
    void loadAddresses()
  }, [configOpen, status?.enabled, loadPairing, loadAddresses])

  // 配对卡上「手机该填的地址」那一行也要地址库（分类型 + 就地选优先）：它跟着配对信息一起走，
  // 重新生成配对码、改配置、重连之后地址可能就变了，所以挂在 pairing 上重取一次。
  // 这条路由只读快照、不解析端口（与 `/api/relay/pairing` 不同），多取一次没有副作用。
  useEffect(() => {
    if (!status?.enabled) return
    void loadAddresses()
  }, [status?.enabled, pairing, loadAddresses])

  const act = useCallback(async (label: string, run: () => Promise<void>) => {
    setBusy(label)
    try {
      await run()
    } catch (err) {
      notify('error', errorText(err))
    } finally {
      setBusy('')
    }
  }, [])

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

  const reconnect = () =>
    act('reconnect', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/reconnect'))
      notify('soft', t('panel.shell.reconnecting'))
    })

  const restartSidecar = () =>
    act('restart', async () => {
      const payload = await apiPost<{ status: StatusView }>('/api/relay/restart-sidecar')
      setStatus(payload.status)
      notify('soft', t('panel.shell.sidecarRestarted'))
    })

  const revokeAll = () => {
    if (!window.confirm(t('panel.shell.revokeConfirm'))) return
    void act('revoke', async () => {
      const payload = await apiPost<RevokeResult>('/api/relay/revoke-all')
      await loadStatus()
      await loadPairing()
      notify('soft', 
        `${t('panel.shell.revoked', { count: payload.revoked })}${payload.revokedRelay ? t('panel.shell.revokedRelay', { count: payload.revokedRelay }) : ''}`,
      )
    })
  }

  /**
   * 「网页管理」那两小时的窗口。
   *
   * 侧边栏那颗手机图标是开它的入口（公网地址先确认），这张卡是**关它**的出口：开过之后
   * 人还得能看见到期时间、随时收回去，否则一开就只能等它自己到点。
   */
  const toggleWebAccess = (enabled: boolean) =>
    act('webAccess', async () => {
      const payload = await apiPost<{ ok: boolean; webAccess: WebAccessState }>('/api/relay/web-access', { enabled })
      setStatus((current) => (current ? { ...current, webAccess: payload.webAccess } : current))
      notify('soft', t(enabled ? 'panel.webAccess.opened' : 'panel.webAccess.closedNotice'))
    })

  const saveConfig = (patch: ConfigPatch) =>
    act('config', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/config', patch))
      setConfigOpen(false)
      await loadPairing()
      notify('soft', t('panel.shell.configSaved'))
    })

  /**
   * 面板上那个「允许新设备绑定」开关。
   *
   * 它写的是**同一份配置**（`pairingPolicy`），所以回来的 `status` 直接顶掉旧的 ——
   * 弹窗里那对单选项、配对卡上「配对策略」那行读的都是这一个字段，三处不会各说各的。
   * 不写乐观值：宿主真要拒绝时（老宿主不认这个字段），开关就该原地弹回去，而不是装作关上了。
   */
  const savePolicy = (pairingPolicy: PairingPolicy) =>
    act('policy', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/config', { pairingPolicy }))
      notify('soft', t(pairingPolicy === 'code' ? 'panel.shell.deviceAllowed' : 'panel.shell.deviceDenied'))
    })

  /**
   * 新配对设备的权限档位（只读 / 可答审批 / 全权）。
   *
   * 它也是同一份配置（`pairingTier`），所以同样从 `/api/relay/config` 写、拿回来的 `status`
   * 直接顶掉旧的 —— 配对卡那一行读的就是这个字段，不会各说各的。真正的档位校验在宿主侧。
   */
  const savePairingTier = (pairingTier: Tier) =>
    act('tier', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/config', { pairingTier }))
      notify('soft', t('panel.shell.configSaved'))
    })

  /**
   * 审批「自动审阅档」（默认关）。
   *
   * 同一份配置、同一条写入路径；拿回来的 `status` 顶掉旧的，配对卡那颗开关读的就是这个字段。
   * **不写乐观值**：老宿主不认这一格时开关必须原样弹回去 —— 它管的是「要不要替你放行」，
   * 显示成开着的而实际没开，比多一次往返糟得多。
   */
  const saveAutoReview = (enabled: boolean) =>
    act('autoReview', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/config', { approvalAutoReview: enabled }))
      notify('soft', t(enabled ? 'panel.shell.autoReviewOn' : 'panel.shell.autoReviewOff'))
    })

  // 局域网端口走同一个 /api/relay/config，只是从它自己的弹窗提交：改完端口、监听会重绑，
  // 手机那边的地址跟着变，所以顺手把配对信息重取一次。
  const saveLanPort = (port: number) =>
    act('lan', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/config', { lanPort: port }))
      setPortOpen(false)
      await loadPairing()
      notify('soft', t('panel.shell.lanSaved'))
    })

  // 「手机优先用这条」是即时生效的：点了就存，**不关窗**（那是看地址的窗，关掉反而碍事）。
  // 存完把配对信息重取一遍，让上面那串地址当场按新顺序排出来；宿主那边二维码里的顺序
  // 也在同一时刻跟着变（`pairingPayload` 按这个设置把选中的排到最前）。
  const savePreferredLanAddress = (address: string) =>
    act('lan', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/config', { preferredLanAddress: address }))
      await Promise.all([loadPairing(), loadAddresses()])
      notify('soft', address ? t('panel.shell.preferredAddress', { address }) : t('panel.shell.preferredAuto'))
    })

  if (!status) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
        {fatal ? (
          <Alert variant="error">
            <AlertIcon />
            <AlertTitle>{t('panel.shell.statusFailed')}</AlertTitle>
            <AlertDescription>{fatal}</AlertDescription>
          </Alert>
        ) : (
          <div className="flex items-center gap-2 text-sm text-foreground-muted">
            <Spinner />
            {t('panel.shell.readingStatus')}
          </div>
        )}
      </main>
    )
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-foreground-intense">{t('panel.shell.title')}</h1>
        <Badge variant="soft" size="sm">
          {status.appVersion || t('panel.shell.unknownVersion')}
        </Badge>
        {busy ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-foreground-muted">
            <Spinner />
            {t('panel.shell.busy')}
          </span>
        ) : null}
      </header>

      {fatal ? (
        <Alert variant="error">
          <AlertIcon />
          <AlertTitle>{t('panel.shell.statusFailed')}</AlertTitle>
          <AlertDescription>{fatal}</AlertDescription>
        </Alert>
      ) : null}

      {/* 动作成功 / 失败的结论走右上角的胶囊（见 lib/notify.ts），这里不再铺长条。 */}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <PairingCard
            status={status}
            pairing={pairing}
            addressBook={addresses}
            busy={busy}
            error={pairingError}
            restartError={status.sidecar.restartError}
            onOpenConfig={() => setConfigOpen(true)}
            onChangePolicy={(policy) => void savePolicy(policy)}
            onChangeTier={(tier) => void savePairingTier(tier)}
            onChangeAutoReview={(enabled) => void saveAutoReview(enabled)}
            onOpenSelfCheck={() => setSelfCheckOpen(true)}
            onReconnect={() => void reconnect()}
            onSavePreferred={(address) => void savePreferredLanAddress(address)}
            onEditPort={() => setPortOpen(true)}
          />

          {/* 「谁被这台机器放进来过」：设备清单自己轮询（`/api/relay/devices`），
              一台设备都没有时整卡不出现。更新在前，设备清单在后。 */}

          <UpdateCard
            version={status.appVersion || ''}
            busy={busy}
            onRestartSidecar={() => void restartSidecar()}
          />

          <DevicesCard onRevokeAll={revokeAll} busy={busy} />
        </div>

        {/*
          右栏是「这台电脑现在怎么样」的一列：公告在最上（公用中转的版本门槛），
          连接状态其次，收件目录紧挨着它下面。
          三块都不跟随滚动、也不套内滚动 —— 挂 `lg:sticky` 会让页面「还得滑到底部才可以」，
          加 `max-h` + `overflow-y-auto` 会在这一列里长出第二条滚动条，看着像两个独立小窗。

          窄屏放不下两列时它排到最前 —— 先看状态，再做事。
        */}
        <aside className="flex flex-col gap-4 max-lg:order-first lg:w-[340px] lg:shrink-0">
          {/* 公用中转的插件版本门槛（2026-10-30 从屏幕边上那块悬浮件挪进来，见
              components/NoticeBoard.tsx 文件头）。 */}
          <NoticeBoard lanPort={status.lan.port} />

          <ConnectionCard status={status} busy={busy} onToggle={toggle} onManageTailcat={() => setTailcatOpen(true)} onManageP2P={() => setP2POpen(true)} />

          {/* 网页管理那两小时窗口的到期时间与「立即关闭」。
              窗口关着时宿主不给远程读管理接口，这张卡也就跟着不出现。
              **从本机回环地址打开这一页时不摆**：这个窗口是给「别人从公网 / 局域网打开这
              一页」用的，回环地址本来就是自己这台机器，摆着它只多一条看得见却用不上的读数
              （用户 2026-11-02）。关掉它的出口留在需要它的那一页上——那一页的地址就是当初
              开窗的理由。宿主不上报 `panelScope` 的老版本按「照旧摆」处理。 */}
          {status.webAccess?.enabled && status.panelScope !== 'loopback' ? (
            <WebAccessCard webAccess={status.webAccess} busy={busy} onToggle={(on) => void toggleWebAccess(on)} />
          ) : null}

          {/* 手机传上来的文件落在宿主的收件目录里，只在「删掉对话」时带不走它们 ——
              这张卡是那个目录唯一的出口（见 components/InboxCard.tsx）。 */}
          <InboxCard />
        </aside>
      </div>

      <RelayConfigDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        status={status}
        addressBook={addresses}
        lanUrls={pairing?.lanUrls ?? []}
        busy={busy}
        onSave={(patch) => void saveConfig(patch)}
        onSavePreferred={(address) => void savePreferredLanAddress(address)}
      />

      <SelfCheckDialog
        open={selfCheckOpen}
        onOpenChange={setSelfCheckOpen}
        state={selfcheck}
        lastMobileAt={status.lastMobileAt}
      />

      <TailcatDialog
        open={tailcatOpen}
        onOpenChange={setTailcatOpen}
        onChanged={() => void loadStatus()}
      />

      <P2PDialog open={p2pOpen} onOpenChange={setP2POpen} />

      <PortDialog
        open={portOpen}
        onOpenChange={setPortOpen}
        port={pairing?.lanPort ?? status.lan.requestedPort ?? status.lan.port}
        busy={busy}
        onSave={(port) => void saveLanPort(port)}
      />

    </main>
  )
}

/**
 * 面板控制台（`/api/relay/panel/console`）：桌面端那颗手机图标点开的那一窗。
 *
 * 定位：**将来要取代网页面板的那个面板**。所以它不另画一套控件，而是把网页版那些功能块
 * （配对二维码、连接状态、已绑定设备、插件更新、收件目录、公告、网页管理窗口）与它们
 * 全部弹窗都接进来，只把**页面编排**重做一遍：没有大标题、没有说明段，顶上一条紧凑的状态
 * 栏，下面内容按屏幕宽度自己铺开、整页可以滚动。重要的事（扫码、连没连上）排最前。
 *
 * 与 `App.tsx` 的关系：数据与动作逐条对应（同一批 `/api/relay/*`、同一套 handler 语义），
 * 区别在版式与「什么东西值得占第一屏」。改动作逻辑时两边都要看；改版式只动这里。
 */
import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@appica/ui-react/alert'
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { Spinner } from '@appica/ui-react/spinner'
import { useCallback, useEffect, useState } from 'react'

import { ConnectionCard } from './components/ConnectionCard.tsx'
import { DevicesCard } from './components/DevicesCard.tsx'
import { InboxCard } from './components/InboxCard.tsx'
import { NoticeBoard } from './components/NoticeBoard.tsx'
import { PairingCard } from './components/PairingCard.tsx'
import { P2PDialog } from './components/P2PDialog.tsx'
import { PortDialog } from './components/PortDialog.tsx'
import { RelayConfigDialog } from './components/RelayConfigDialog.tsx'
import { SelfCheckDialog } from './components/SelfCheckDialog.tsx'
import { TailcatDialog } from './components/TailcatDialog.tsx'
import { UpdateCard } from './components/UpdateCard.tsx'
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
import { Dot } from './components/InfoRow.tsx'
import { lanText, tunnelText, type Tone } from './lib/format.ts'
import { t } from './lib/i18n/index.ts'
import { useNotify } from './lib/notify.ts'
import { mobileLooksIdle, useSelfCheck } from './lib/selfcheck.ts'

/**
 * 从这一页的地址推另外两页的地址。
 *
 * 一律**文档相对**（`new URL(..., document.baseURI)`）：这一页可能挂在反代给的子路径下，
 * 也可能被嵌在桌面壳的 `dsh-app://app/` 里，绝对地址在两种环境里只有一种能用。
 */
function pageUrlOf(mode: 'panel' | 'debug'): string {
  try {
    const base = new URL(document.baseURI)
    const root = base.pathname.replace(/\/console\/?$/, '')
    base.pathname = mode === 'debug' ? `${root}/debug` : root
    base.search = ''
    base.hash = ''
    return base.href
  } catch {
    return ''
  }
}

export function Console() {
  const [status, setStatus] = useState<StatusView | null>(null)
  const [fatal, setFatal] = useState('')
  const [busy, setBusy] = useState('')
  const [pairing, setPairing] = useState<PairingInfo | null>(null)
  const [pairingError, setPairingError] = useState('')
  const [addresses, setAddresses] = useState<AddressBook | null>(null)
  const [configOpen, setConfigOpen] = useState(false)
  const [portOpen, setPortOpen] = useState(false)
  const [selfCheckOpen, setSelfCheckOpen] = useState(false)
  const [tailcatOpen, setTailcatOpen] = useState(false)
  const [p2pOpen, setP2POpen] = useState(false)
  const notify = useNotify()

  const selfcheck = useSelfCheck(
    mobileLooksIdle(status?.lastMobileAt),
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
      setAddresses(null)
    }
  }, [])

  // 3 秒一轮，页面切到后台就停。
  useEffect(() => {
    const tick = () => {
      if (document.hidden) return
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

  // 二维码只在远程控制开着时才取（关着时宿主回 409）。
  useEffect(() => {
    if (!status?.enabled || pairing || pairingError) return
    void loadPairing()
  }, [status?.enabled, pairing, pairingError, loadPairing])

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
    if (!status?.enabled) return
    void loadAddresses()
  }, [status?.enabled, pairing, loadAddresses])

  useEffect(() => {
    if (!configOpen || !status?.enabled) return
    void loadPairing()
    void loadAddresses()
  }, [configOpen, status?.enabled, loadPairing, loadAddresses])

  const act = useCallback(async (label: string, run: () => Promise<void>) => {
    setBusy(label)
    try {
      await run()
    } catch (err) {
      notify('error', errorText(err))
    } finally {
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
      notify('soft', `${t('panel.shell.revoked', { count: payload.revoked })}${payload.revokedRelay ? t('panel.shell.revokedRelay', { count: payload.revokedRelay }) : ''}`)
    })
  }

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

  const savePolicy = (pairingPolicy: PairingPolicy) =>
    act('policy', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/config', { pairingPolicy }))
      notify('soft', t(pairingPolicy === 'code' ? 'panel.shell.deviceAllowed' : 'panel.shell.deviceDenied'))
    })

  const savePairingTier = (pairingTier: Tier) =>
    act('tier', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/config', { pairingTier }))
      notify('soft', t('panel.shell.configSaved'))
    })

  const saveAutoReview = (enabled: boolean) =>
    act('autoReview', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/config', { approvalAutoReview: enabled }))
      notify('soft', t(enabled ? 'panel.shell.autoReviewOn' : 'panel.shell.autoReviewOff'))
    })

  const saveLanPort = (port: number) =>
    act('lan', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/config', { lanPort: port }))
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

  const openPage = (mode: 'panel' | 'debug') => {
    const url = pageUrlOf(mode)
    if (url) window.open(url, '_blank', 'noreferrer')
  }

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
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {tone ? <Dot tone={tone} /> : null}
          <span className="truncate text-sm font-medium text-foreground">{status.name || status.instanceId}</span>
          <Badge variant="soft" size="sm">
            {status.appVersion || t('panel.shell.unknownVersion')}
          </Badge>
          <span className="hidden text-xs text-foreground-muted sm:inline">
            {t('panel.connection.tunnel')} {tunnelText(status.tunnel.state)} · {t('panel.connection.lan')} {lanText(status.lan.state, status.lan.enabled)}
          </span>
        </div>
        {busy ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-foreground-muted">
            <Spinner />
            {t('panel.shell.busy')}
          </span>
        ) : null}
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => openPage('panel')}>
            {t('panel.console.openBrowser')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => openPage('debug')}>
            {t('panel.console.troubleshoot')}
          </Button>
        </div>
      </header>

      {fatal ? (
        <Alert variant="error">
          <AlertIcon />
          <AlertTitle>{t('panel.shell.statusFailed')}</AlertTitle>
          <AlertDescription>{fatal}</AlertDescription>
        </Alert>
      ) : null}

      {/*
        内容区：二维码那张卡**横贯整行**（它天生就宽：左边 360 的码、右边一串信息行；
        塞进三分之一宽的列里只会把标签挤成竖排），下面三列按宽度自己从 1 → 2 → 3 收放。
        顺序就是「重要的先在上面」：扫码 → 连接 / 公告 → 设备 / 维护（更新 / 收件）。
        整页滚动，不做单栏 sticky、也不套内滚动条。
      */}
      <div className="grid grid-cols-1 gap-3">
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

        {/*
          下面的卡片用**瀑布式几列**（CSS `columns`）而不是网格：设备那张卡天生比别的长，
          网格按行排会在一侧留下半屏空白。这一列排法让每张卡都往下接，窄屏自动收到一列。
          `break-inside-avoid` 保证一张卡不会被劈到两列里。
        */}
        <div className="columns-1 gap-3 md:columns-2 xl:columns-3 [&>*]:mb-3 [&>*]:break-inside-avoid">
          <ConnectionCard
            status={status}
            busy={busy}
            onToggle={toggle}
            onManageTailcat={() => setTailcatOpen(true)}
            onManageP2P={() => setP2POpen(true)}
          />
          <DevicesCard onRevokeAll={revokeAll} busy={busy} />
          {status.webAccess?.enabled && status.panelScope !== 'loopback' ? (
            <WebAccessCard webAccess={status.webAccess} busy={busy} onToggle={(on) => void toggleWebAccess(on)} />
          ) : null}
          <UpdateCard version={status.appVersion || ''} busy={busy} onRestartSidecar={() => void restartSidecar()} />
          <NoticeBoard lanPort={status.lan.port} />
          <InboxCard />
        </div>
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

      <TailcatDialog open={tailcatOpen} onOpenChange={setTailcatOpen} onChanged={() => void loadStatus()} />

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

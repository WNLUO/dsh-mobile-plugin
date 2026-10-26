/**
 * 网页版设置页的主页（`dsh-mobile-plugin/lib/panel/index.html` 的产物源）。
 *
 * 只做展示与转发：每张卡片的信息都来自 `/api/relay/*`（宿主是唯一事实来源），页面自己
 * 不留状态副本。这一页由浏览器加载，改完刷新即生效；插件设置页签那一半要完整安装 +
 * 重启 DSH 才换得掉。
 */
import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@appica/ui-react/alert'
import { t } from './lib/i18n/index.ts'
import { Badge } from '@appica/ui-react/badge'
import { Spinner } from '@appica/ui-react/spinner'
import { useCallback, useEffect, useState } from 'react'

import { ConnectionCard } from './components/ConnectionCard.tsx'
import { DevicesCard } from './components/DevicesCard.tsx'
import { LanDialog } from './components/LanDialog.tsx'
import { PairingCard } from './components/PairingCard.tsx'
import { RelayConfigDialog } from './components/RelayConfigDialog.tsx'
import { UpdateCard } from './components/UpdateCard.tsx'
import { InboxCard } from './components/InboxCard.tsx'
import {
  apiGet,
  apiPost,
  errorText,
  type AddressBook,
  type ConfigPatch,
  type PairingInfo,
  type PairingPolicy,
  type RevokeResult,
  type StatusView,
} from './lib/api.ts'
import { useNotify } from './lib/notify.ts'

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
  const [lanOpen, setLanOpen] = useState(false)
  /**
   * 宿主枚举的地址库：局域网直连弹窗里那个「手机优先用」要它（带网卡名与当前选中的那条）。
   * 只在开窗时取一次，和老宿主兼容（那条路由不存在就保持 null，选择器不摆）。
   */
  const [addresses, setAddresses] = useState<AddressBook | null>(null)

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

  // 二维码只在远程控制开着时才取：关着的时候宿主回 409，没必要一进页面就亮个警告。
  useEffect(() => {
    if (!status?.enabled || pairing || pairingError) return
    void loadPairing()
  }, [status?.enabled, pairing, pairingError, loadPairing])

  // 局域网地址靠打开「局域网直连」弹窗时补取一次。
  useEffect(() => {
    if (!lanOpen || !status?.enabled) return
    void loadPairing()
    void loadAddresses()
  }, [lanOpen, status?.enabled, loadPairing, loadAddresses])

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

  const regenerate = () =>
    act('pairing', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/regenerate'))
      await loadPairing()
      notify('soft', t('panel.shell.pairingRegenerated'))
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

  // 局域网端口走同一个 /api/relay/config，只是从它自己的弹窗提交：改完端口地址可能就变了，
  // 所以顺手把配对信息重取一次，别让弹窗里留着一串过期的地址。
  const saveLanPort = (patch: ConfigPatch) =>
    act('lan', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/config', patch))
      setLanOpen(false)
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
          {/* 准入总闸摆在右边「连接状态」里：它和远程控制是同一种东西 —— 两颗决定
              「收不收」的开关，同一张卡里才不用来回找。 */}

          <PairingCard
            status={status}
            pairing={pairing}
            addressBook={addresses}
            busy={busy}
            error={pairingError}
            restartError={status.sidecar.restartError}
            onOpenConfig={() => setConfigOpen(true)}
            onRegenerate={() => void regenerate()}
            onReconnect={() => void reconnect()}
            onRevokeAll={revokeAll}
            onSavePreferred={(address) => void savePreferredLanAddress(address)}
          />

          {/* 「谁被这台机器放进来过」：设备清单自己轮询（`/api/relay/devices`），
              一台设备都没有时整卡不出现。更新在前，设备清单在后。 */}

          <UpdateCard
            version={status.appVersion || ''}
            busy={busy}
            onRestartSidecar={() => void restartSidecar()}
          />

          <DevicesCard />
        </div>

        {/*
          右栏是「这台电脑现在怎么样」的一列：连接状态在上，收件目录紧挨着它下面。
          两块都不跟随滚动、也不套内滚动 —— 挂 `lg:sticky` 会让页面「还得滑到底部才可以」，
          加 `max-h` + `overflow-y-auto` 会在这一列里长出第二条滚动条，看着像两个独立小窗。

          窄屏放不下两列时它排到最前 —— 先看状态，再做事。
        */}
        <aside className="flex flex-col gap-4 max-lg:order-first lg:w-[340px] lg:shrink-0">
          <ConnectionCard
            status={status}
            busy={busy}
            onToggle={toggle}
            onChangePolicy={(policy) => void savePolicy(policy)}
            onOpenLan={() => setLanOpen(true)}
          />

          {/* 手机传上来的文件落在宿主的收件目录里，只在「删掉对话」时带不走它们 ——
              这张卡是那个目录唯一的出口（见 components/InboxCard.tsx）。 */}
          <InboxCard />
        </aside>
      </div>

      <RelayConfigDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        status={status}
        busy={busy}
        onSave={(patch) => void saveConfig(patch)}
      />

      <LanDialog
        open={lanOpen}
        onOpenChange={setLanOpen}
        status={status}
        lanUrls={pairing?.lanUrls ?? []}
        addressBook={addresses}
        busy={busy}
        onSave={(patch) => void saveLanPort(patch)}
        onSavePreferred={(address) => void savePreferredLanAddress(address)}
      />

    </main>
  )
}

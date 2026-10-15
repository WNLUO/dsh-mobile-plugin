/**
 * 网页版设置页的主页（`dsh-mobile-plugin/lib/panel/index.html` 的产物源）。
 *
 * 只做展示与转发：每张卡片的信息都来自 `/api/relay/*`（宿主是唯一事实来源），页面自己
 * 不留状态副本。为什么这半块界面住在这里而不是插件设置页签里：**这一页热更即生效**，
 * 而设置页签那一半（`lib/client.js`）由渲染器从安装目录加载、改一次要完整安装 + 重启
 * （见 `dsh-mobile-plugin/lib/client-half.cjs` 的文件头）。
 */
import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@appica/ui-react/alert'
import { Badge } from '@appica/ui-react/badge'
import { Spinner } from '@appica/ui-react/spinner'
import { useCallback, useEffect, useState } from 'react'

import { ConnectionCard } from './components/ConnectionCard.tsx'
import { JoinGroupButton } from './components/JoinGroupButton.tsx'
import { LanDialog } from './components/LanDialog.tsx'
import { PairingCard } from './components/PairingCard.tsx'
import { RelayConfigDialog } from './components/RelayConfigDialog.tsx'
import { UpdateCard } from './components/UpdateCard.tsx'
import {
  apiGet,
  apiPost,
  errorText,
  type AddressBook,
  type ConfigPatch,
  type PairingInfo,
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
   * 「某次动作的结果」一律走右上角的胶囊，不在页面里铺长条（2026-10-11 用户要求统一）。
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

  // 「刷新」按钮按用户要求删了，局域网地址就靠打开「局域网直连」弹窗时补取一次。
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
      notify('soft', enabled ? '已启用远程控制。' : '已停用远程控制，手机将断开。')
    })

  const regenerate = () =>
    act('pairing', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/regenerate'))
      await loadPairing()
      notify('soft', '配对码已重新生成，之前截图的二维码作废。')
    })

  const reconnect = () =>
    act('reconnect', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/reconnect'))
      notify('soft', '已发起重连。')
    })

  const restartSidecar = () =>
    act('restart', async () => {
      const payload = await apiPost<{ status: StatusView }>('/api/relay/restart-sidecar')
      setStatus(payload.status)
      notify('soft', '旁挂进程已重启。')
    })

  const revokeAll = () => {
    if (!window.confirm('吊销全部设备授权？所有手机都要重新配对，这一步不能撤销。')) return
    void act('revoke', async () => {
      const payload = await apiPost<RevokeResult>('/api/relay/revoke-all')
      await loadStatus()
      await loadPairing()
      notify('soft', 
        `已吊销 ${payload.revoked} 个授权${payload.revokedRelay ? `（中转侧 ${payload.revokedRelay} 个）` : ''}。`,
      )
    })
  }

  const saveConfig = (patch: ConfigPatch) =>
    act('config', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/config', patch))
      setConfigOpen(false)
      await loadPairing()
      notify('soft', '配置已保存。')
    })

  // 局域网端口走同一个 /api/relay/config，只是从它自己的弹窗提交：改完端口地址可能就变了，
  // 所以顺手把配对信息重取一次，别让弹窗里留着一串过期的地址。
  const saveLanPort = (patch: ConfigPatch) =>
    act('lan', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/config', patch))
      setLanOpen(false)
      await loadPairing()
      notify('soft', '局域网配置已保存。')
    })

  // 「手机优先用这条」是即时生效的：点了就存，**不关窗**（那是看地址的窗，关掉反而碍事）。
  // 存完把配对信息重取一遍，让上面那串地址当场按新顺序排出来；宿主那边二维码里的顺序
  // 也在同一时刻跟着变（`pairingPayload` 按这个设置把选中的排到最前）。
  const savePreferredLanAddress = (address: string) =>
    act('lan', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/config', { preferredLanAddress: address }))
      await Promise.all([loadPairing(), loadAddresses()])
      notify('soft', address ? `手机优先使用 ${address}。` : '已改回按网卡顺序自动选。')
    })

  if (!status) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
        {fatal ? (
          <Alert variant="error">
            <AlertIcon />
            <AlertTitle>读不到插件状态</AlertTitle>
            <AlertDescription>{fatal}</AlertDescription>
          </Alert>
        ) : (
          <div className="flex items-center gap-2 text-sm text-foreground-muted">
            <Spinner />
            正在读取状态…
          </div>
        )}
      </main>
    )
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-foreground-intense">移动端</h1>
        <Badge variant="soft" size="sm">
          {status.appVersion || '未知版本'}
        </Badge>
        {busy ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-foreground-muted">
            <Spinner />
            处理中…
          </span>
        ) : null}
      </header>

      {fatal ? (
        <Alert variant="error">
          <AlertIcon />
          <AlertTitle>读不到插件状态</AlertTitle>
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
            onRegenerate={() => void regenerate()}
            onReconnect={() => void reconnect()}
            onRevokeAll={revokeAll}
            onSavePreferred={(address) => void savePreferredLanAddress(address)}
          />

          <UpdateCard
            version={status.appVersion || ''}
            busy={busy}
            onRestartSidecar={() => void restartSidecar()}
          />
        </div>

        {/* 连接状态是只读的观察窗：挂在右侧，滚动时跟着走，不跟下面这些操作抢位置。
            窄屏放不下两列时它排到最前 —— 先看状态，再做事。 */}
        <aside className="max-lg:order-first lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:w-[340px] lg:shrink-0 lg:overflow-y-auto">
          <ConnectionCard
            status={status}
            busy={busy}
            onToggle={toggle}
            onOpenLan={() => setLanOpen(true)}
          />
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

      {/* 悬浮在页面右下角，不占两列的位置（见组件文件头）。点开之后是什么还没定，
          现在只把按钮摆上。 */}
      <JoinGroupButton />
    </main>
  )
}

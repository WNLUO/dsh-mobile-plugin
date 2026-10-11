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
import { LanDialog } from './components/LanDialog.tsx'
import { PairingCard } from './components/PairingCard.tsx'
import { RelayConfigDialog } from './components/RelayConfigDialog.tsx'
import { UpdateCard } from './components/UpdateCard.tsx'
import {
  apiGet,
  apiPost,
  errorText,
  type ConfigPatch,
  type PairingInfo,
  type RevokeResult,
  type StatusView,
} from './lib/api.ts'

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
  /** 某个动作失败（红框）与中性提示（不是故障）分开，别把预期内的拒绝当故障报。 */
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [pairing, setPairing] = useState<PairingInfo | null>(null)
  const [pairingError, setPairingError] = useState('')
  const [configOpen, setConfigOpen] = useState(false)
  const [lanOpen, setLanOpen] = useState(false)

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
  }, [lanOpen, status?.enabled, loadPairing])

  const act = useCallback(async (label: string, run: () => Promise<void>) => {
    setBusy(label)
    setError('')
    setNotice('')
    try {
      await run()
    } catch (err) {
      setError(errorText(err))
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
      setNotice(enabled ? '已启用远程控制。' : '已停用远程控制，手机将断开。')
    })

  const regenerate = () =>
    act('pairing', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/regenerate'))
      await loadPairing()
      setNotice('配对码已重新生成，之前截图的二维码作废。')
    })

  const reconnect = () =>
    act('reconnect', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/reconnect'))
      setNotice('已发起重连。')
    })

  const restartSidecar = () =>
    act('restart', async () => {
      const payload = await apiPost<{ status: StatusView }>('/api/relay/restart-sidecar')
      setStatus(payload.status)
      setNotice('旁挂进程已重启。')
    })

  const revokeAll = () => {
    if (!window.confirm('吊销全部设备授权？所有手机都要重新配对，这一步不能撤销。')) return
    void act('revoke', async () => {
      const payload = await apiPost<RevokeResult>('/api/relay/revoke-all')
      await loadStatus()
      await loadPairing()
      setNotice(
        `已吊销 ${payload.revoked} 个授权${payload.revokedRelay ? `（中转侧 ${payload.revokedRelay} 个）` : ''}。`,
      )
    })
  }

  const saveConfig = (patch: ConfigPatch) =>
    act('config', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/config', patch))
      setConfigOpen(false)
      await loadPairing()
      setNotice('配置已保存。')
    })

  // 局域网端口走同一个 /api/relay/config，只是从它自己的弹窗提交：改完端口地址可能就变了，
  // 所以顺手把配对信息重取一次，别让弹窗里留着一串过期的地址。
  const saveLanPort = (patch: ConfigPatch) =>
    act('lan', async () => {
      setStatus(await apiPost<StatusView>('/api/relay/config', patch))
      setLanOpen(false)
      await loadPairing()
      setNotice('局域网配置已保存。')
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

      {error ? (
        <Alert variant="error">
          <AlertIcon />
          <AlertTitle>操作没成功</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {notice ? (
        <Alert variant="info">
          <AlertIcon />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <PairingCard
            status={status}
            pairing={pairing}
            busy={busy}
            error={pairingError}
            restartError={status.sidecar.restartError}
            onOpenConfig={() => setConfigOpen(true)}
            onRegenerate={() => void regenerate()}
            onReconnect={() => void reconnect()}
            onRevokeAll={revokeAll}
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
        busy={busy}
        onSave={(patch) => void saveLanPort(patch)}
      />
    </main>
  )
}

/**
 * 「调试」页：桌面端那颗手机图标点下去弹出来的就是这一页（嵌在同源 iframe 里）。
 *
 * 这一页只回答一件事：**这台机器上的移动端插件，从装载到链路，现在断在哪一环**。用户报
 * 「打不开」时，缺的从来不是一句报错，而是「哪一段没起来、它自己怎么说、我能按哪个按钮
 * 再试一次」。所以从上到下按固定的顺序摆：
 *
 *   1. 一句结论 + 一条建议（绿 / 黄 / 红）；
 *   2. 装载：外壳还在、实现装没装上 —— 版本、来源、装载时刻、后台重试、宿主侧原话；
 *   3. 链路：中转隧道 / 局域网直连 / 旁挂进程 / 会话镜像 / 手机最近来过；
 *   4. 网络与地址：本机端口、面板地址与类别、手机该填的候选地址（局域网 / 公网 / IPv6）；
 *   5. 手机与设备：绑了几台、最近连的是哪台；
 *   6. 资源：两个进程的内存、活着的流、镜像缓存、凭据库（口径写在卡里）；
 *   7. 连接自检：按需点一次（宿主那一下要 fork 子进程，不跟轮询）；
 *   8. 版本与更新：运行中 / 盘上；
 *   9. 故障账本：进程级未捕获异常；
 *  10. 桌面半边自检：两条同步各来敲过几次门。
 *
 * 所有数字都来自宿主既有接口，这一页不新增端点、不缓存、不改写：读不到就如实说读不到，
 * 不拿 0 顶替「不知道」。排版是两列（宽屏）／一列（窄屏），弹窗里一行放得下两张卡。
 */
import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@appica/ui-react/alert'
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card'
import { Spinner } from '@appica/ui-react/spinner'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { InfoList, InfoRow, ToneValue } from './components/InfoRow.tsx'
import { apiGet, apiPost, errorText, type AddressBook, type DeviceList, type SelfCheck, type StatusView } from './lib/api.ts'
import { cn, lanText, lanTone, sidecarText, timeText, tunnelText, tunnelTone, type Tone } from './lib/format.ts'
import { t } from './lib/i18n/index.ts'
import { verdictText, verdictTone } from './lib/selfcheck.ts'

/** `/api/relay/host-half`：由外壳回答的那份装载自检（实现挂了它还在）。 */
type HostHalf = {
  version?: string | null
  source?: string | null
  previousVersion?: string | null
  activatedAt?: string | null
  lastError?: string | null
  retrying?: boolean
  retryAttempts?: number
  nextRetryAt?: string | null
  installedVersion?: string | null
  shellChanged?: boolean
}

/** `/api/relay/status` 上那几个只给本机看的补充块。 */
type StatusExtras = StatusView & {
  selfCheck?: MemorySnapshot | null
  desktopHalf?: DesktopHalf | null
}

/** 内存与连接数（`lib/mobile/self-check.cjs` 的 snapshot）。拿不到的格子是 null。 */
type MemorySnapshot = {
  hostProcess?: {
    rss?: number | null
    heapUsed?: number | null
    heapTotal?: number | null
    heapSizeLimit?: number | null
    startedAt?: number | null
  } | null
  sidecarProcess?: { memory?: { rss?: number | null; heapUsed?: number | null } | null } | null
  streams?: {
    relaySseOpen?: number | null
    lanUpstreamOpen?: number | null
    lanSseOpen?: number | null
  } | null
  mirror?: {
    cachedSessions?: number | null
    cachedMessages?: number | null
    cachedBytes?: number | null
    pushFailures?: number | null
  } | null
  credentials?: { active?: number | null } | null
  unavailable?: string[]
}

/** 客户端半边的活体计数：两条同步各来敲过几次门。 */
type DesktopHalf = {
  since?: number
  readReceiptGets?: number
  readReceiptLastAt?: number
  desktopReadPosts?: number
  desktopReadLastAt?: number
  desktopViewPosts?: number
  desktopViewLastAt?: number
  clientReports?: number
  clientLastAt?: number
  clientSeenAt?: number
  client?: Record<string, unknown> | null
}

/** `/api/relay/faults`：进程级故障台账。 */
type Faults = {
  ok?: boolean
  installed?: boolean
  faults?: { at: number; kind: string; message: string; fatal?: boolean }[]
  stats?: { consecutive?: number; total?: number; fatalEver?: boolean } | null
}

/** 字节数按人读的方式折一下：这一页是给人看的，不是给机器对的。 */
function bytesText(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`
}

/**
 * 候选地址列表折成一行：只列前两条、其余折成「+N」，每条再折一下长度。
 *
 * 地址是给人「确认手机该填哪个」用的，不是全文展示：IPv6 一条就有四十来个字符，四条摊开
 * 会把整张卡撑成半屏高，把右边的卡推下去。完整清单在配置页的地址选择里。
 */
function listText(entries: { url: string }[] | undefined, empty: string): string {
  const list = Array.isArray(entries) ? entries : []
  if (!list.length) return empty
  const clip = (url: string) => (url.length > 34 ? `${url.slice(0, 31)}…` : url)
  const head = list.slice(0, 2).map((entry) => clip(entry.url)).join('　')
  return list.length > 2 ? `${head}　+${list.length - 2}` : head
}

/** 一句结论：tone + 说人话的键（文案里就带「该做什么」）。 */
type Verdict = { tone: Tone; key: string }

/**
 * 把几份读数压成一句「现在能不能用、卡在哪」。
 *
 * 顺序就是排查顺序：**控制面读不到** → 装载失败 → 重试中 → 远程控制没开 → 旁挂进程 →
 * 隧道 → 局域网 → 手机没来过 → 都好。第一个命中的就是结论；后面那些不重复报。
 */
function verdictOf(input: {
  status: StatusExtras | null
  statusError: string
  half: HostHalf | null
  halfError: string
}): Verdict {
  const { status, statusError, half, halfError } = input
  if (!status) {
    return statusError ? { tone: 'error', key: 'panel.debug.verdict.controlDown' } : { tone: 'warn', key: 'panel.debug.verdict.reading' }
  }
  if (half?.lastError) return { tone: 'error', key: 'panel.debug.verdict.loadFailed' }
  if (halfError && !half) return { tone: 'warn', key: 'panel.debug.verdict.halfDown' }
  if (half?.retrying) return { tone: 'warn', key: 'panel.debug.verdict.retrying' }
  if (!status.enabled) return { tone: 'warn', key: 'panel.debug.verdict.disabled' }
  if (status.sidecar.state !== 'healthy') return { tone: 'error', key: 'panel.debug.verdict.sidecarBad' }
  if (status.tunnel.state === 'error') {
    return {
      tone: 'error',
      key: status.tunnel.admissionHint ? 'panel.debug.verdict.tunnelRejected' : 'panel.debug.verdict.tunnelBad',
    }
  }
  if (status.lan.enabled && status.lan.state === 'error') return { tone: 'error', key: 'panel.debug.verdict.lanBad' }
  if (!status.lastMobileAt) return { tone: 'warn', key: 'panel.debug.verdict.phoneNever' }
  return { tone: 'ok', key: 'panel.debug.verdict.ok' }
}

/** 一段小标题（卡头里的那行灰字，用来分组）。 */
function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <Card frame="solid" className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      {children}
    </Card>
  )
}

export function Debug() {
  const [status, setStatus] = useState<StatusExtras | null>(null)
  const [half, setHalf] = useState<HostHalf | null>(null)
  const [faults, setFaults] = useState<Faults | null>(null)
  const [addresses, setAddresses] = useState<AddressBook | null>(null)
  const [devices, setDevices] = useState<DeviceList | null>(null)
  const [update, setUpdate] = useState<{ runningVersion?: string | null; installedVersion?: string | null } | null>(null)
  const [selfcheck, setSelfcheck] = useState<SelfCheck | null>(null)
  const [statusError, setStatusError] = useState('')
  const [halfError, setHalfError] = useState('')
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    // 四份各自独立失败：装载自检（外壳）与状态（实现）本来就可能只有一个在，合并成一个
    // try 会让「外壳活着、实现没起来」这种最该看清的现场变成一片空白。
    try {
      setStatus(await apiGet<StatusExtras>('/api/relay/status'))
      setStatusError('')
    } catch (error) {
      setStatus(null)
      setStatusError(errorText(error))
    }
    try {
      const picture = await apiGet<{ ok?: boolean; half?: HostHalf }>('/api/relay/host-half')
      setHalf(picture?.half && typeof picture.half === 'object' ? picture.half : null)
      setHalfError('')
    } catch (error) {
      setHalf(null)
      setHalfError(errorText(error))
    }
    try {
      setFaults(await apiGet<Faults>('/api/relay/faults'))
    } catch {
      setFaults(null)
    }
    try {
      const payload = await apiGet<{ ok?: boolean; data?: { runningVersion?: string | null; installedVersion?: string | null } }>('/api/relay/update/status')
      setUpdate(payload?.data ?? null)
    } catch {
      setUpdate(null)
    }
    try {
      setAddresses(await apiGet<AddressBook>('/api/relay/addresses'))
    } catch {
      setAddresses(null)
    }
    try {
      setDevices(await apiGet<DeviceList>('/api/relay/devices'))
    } catch {
      setDevices(null)
    }
  }, [])

  useEffect(() => {
    void load()
    // 这一页开着的时候每 5 秒跟着刷新：用户多半正在「点一下、等一等、再看一眼」。
    // 切到后台就停，和主页那条轮询同一个口径。
    const tick = () => {
      if (document.hidden) return
      void load()
    }
    const timer = window.setInterval(tick, 5000)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [load])

  const act = useCallback(async (label: string, run: () => Promise<string>) => {
    setBusy(label)
    setNote('')
    try {
      setNote(await run())
    } catch (error) {
      setNote(errorText(error))
    } finally {
      setBusy('')
      await load()
    }
  }, [load])

  const reloadHost = () =>
    act('host', async () => {
      await apiPost('/api/relay/host-half/reload', {})
      return t('panel.debug.reloaded')
    })

  const restartSidecar = () =>
    act('sidecar', async () => {
      await apiPost('/api/relay/restart-sidecar', {})
      return t('panel.debug.sidecarRestarted')
    })

  // 连接自检要宿主 fork 一个子进程问系统防火墙，**只在人按的时候发**，不跟轮询。
  const runSelfcheck = () =>
    act('selfcheck', async () => {
      const next = await apiGet<SelfCheck>('/api/relay/selfcheck?force=1')
      setSelfcheck(next)
      return t('panel.debug.selfcheckDone')
    })

  const memory = status?.selfCheck ?? null
  const client = status?.desktopHalf ?? null
  const ledger = Array.isArray(faults?.faults) ? faults.faults : []
  const unavailable = Array.isArray(memory?.unavailable) ? memory.unavailable : []
  const verdict = useMemo(
    () => verdictOf({ status, statusError, half, halfError }),
    [status, statusError, half, halfError],
  )
  const lanCandidates = Array.isArray(addresses?.lan) ? addresses.lan : []
  const publicCandidates = Array.isArray(addresses?.public) ? addresses.public : []
  const ipv6Candidates = Array.isArray(addresses?.ipv6) ? addresses.ipv6 : []
  const deviceRows = Array.isArray(devices?.devices) ? devices.devices : []

  /** 剪贴板里那一段：ASCII 记号，贴给维护者就能对日志。 */
  const copyText = useMemo(() => {
    const lines = ['dsh-mobile-plugin debug']
    if (half) {
      lines.push(`plugin_version=${half.version ?? ''}`)
      lines.push(`plugin_source=${half.source ?? ''}`)
      lines.push(`activated_at=${half.activatedAt ?? ''}`)
      lines.push(`installed_version=${half.installedVersion ?? half.version ?? ''}`)
      lines.push(`shell_changed=${half.shellChanged ? 'true' : 'false'}`)
      lines.push(`retrying=${half.retrying ? 'true' : 'false'}`)
      lines.push(`retry_attempts=${half.retryAttempts ?? 0}`)
      lines.push(`host_last_error=${half.lastError ?? ''}`)
    } else {
      lines.push(`host_half=unavailable ${halfError}`)
    }
    if (status) {
      lines.push(`enabled=${status.enabled ? 'true' : 'false'}`)
      lines.push(`tunnel=${status.tunnel.state} ${status.tunnel.error ?? ''}`)
      lines.push(`lan=${status.lan.state} enabled=${status.lan.enabled ? 'true' : 'false'} port=${status.lan.port}`)
      lines.push(`sidecar=${status.sidecar.state} restarts=${status.sidecar.restarts}`)
      lines.push(`mirror_ok=${status.mirror.ok ? 'true' : 'false'} ${status.mirror.error ?? ''}`)
      lines.push(`panel_scope=${status.panelScope ?? ''}`)
      lines.push(`panel_url=${status.panelUrl ?? ''}`)
      lines.push(`last_mobile_at=${status.lastMobileAt ?? 0}`)
      lines.push(`local_port=${status.localPort ?? 0}`)
    } else {
      lines.push(`status=unavailable ${statusError}`)
    }
    if (memory) {
      lines.push(`host_rss=${memory.hostProcess?.rss ?? ''}`)
      lines.push(`host_heap_used=${memory.hostProcess?.heapUsed ?? ''}`)
      lines.push(`streams_relay_sse=${memory.streams?.relaySseOpen ?? ''}`)
      lines.push(`streams_lan=${memory.streams?.lanSseOpen ?? ''}`)
    }
    if (client) {
      lines.push(`client_reports=${client.clientReports ?? 0}`)
      lines.push(`client_last_at=${client.clientLastAt ?? 0}`)
    }
    if (devices) lines.push(`devices=${deviceRows.length}`)
    if (selfcheck) lines.push(`selfcheck_verdict=${selfcheck.verdict} at=${selfcheck.checkedAt}`)
    if (faults?.installed === false) lines.push('faults=not-installed')
    for (const fault of ledger.slice(-5)) lines.push(`fault=${fault.kind} ${new Date(fault.at).toISOString()} ${fault.message}`)
    return lines.join('\n')
  }, [half, halfError, status, statusError, memory, client, faults, ledger, devices, deviceRows.length, selfcheck])

  const copy = () =>
    act('copy', async () => {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(copyText)
        return t('panel.debug.copied')
      }
      return t('panel.debug.copyFailed')
    })

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-5">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-foreground-intense">{t('panel.debug.title')}</h1>
        {half?.version ? (
          <Badge variant="soft" size="sm">
            {half.version}
          </Badge>
        ) : null}
        {busy ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-foreground-muted">
            <Spinner />
            {t('panel.debug.working')}
          </span>
        ) : null}
        <span className="ml-auto flex flex-wrap gap-2">
          <Button variant="soft" size="sm" onClick={() => void load()}>
            {t('panel.debug.refresh')}
          </Button>
          <Button variant="soft" size="sm" onClick={() => void reloadHost()}>
            {t('panel.debug.reloadHost')}
          </Button>
          <Button variant="soft" size="sm" onClick={() => void restartSidecar()}>
            {t('panel.debug.restartSidecar')}
          </Button>
          <Button variant="soft" size="sm" onClick={() => void copy()}>
            {t('panel.debug.copy')}
          </Button>
        </span>
      </header>

      {/* 一句结论 + 一条建议：出问题时先看这里，不用自己去拼十行读数。 */}
      <div
        className={cn(
          'flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm',
          verdict.tone === 'ok' && 'border-success/30 bg-success/10 text-success',
          verdict.tone === 'warn' && 'border-warning/30 bg-warning/10 text-warning',
          verdict.tone === 'error' && 'border-error/30 bg-error/10 text-error',
        )}
      >
        <span
          className={cn(
            'mt-1.5 inline-block size-2 shrink-0 rounded-full',
            verdict.tone === 'ok' && 'bg-success',
            verdict.tone === 'warn' && 'bg-warning',
            verdict.tone === 'error' && 'bg-error',
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{t(verdict.key)}</span>
          <span className="mt-1 block text-xs text-foreground-muted">{t('panel.debug.lead')}</span>
        </span>
      </div>

      {note ? (
        <Alert variant="info">
          <AlertIcon />
          <AlertDescription>{note}</AlertDescription>
        </Alert>
      ) : null}

      {/* 卡自己按内容定高（`items-start`）：同一行两张谁也不许被拉成另一张的高度。 */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Section title={t('panel.debug.sectionStartup')}>
          <InfoList>
            <InfoRow label={t('panel.debug.pluginVersion')}>
              <ToneValue tone={half?.version ? 'ok' : 'error'} text={half?.version ? String(half.version) : t('panel.debug.unknown')} />
            </InfoRow>
            <InfoRow label={t('panel.debug.source')}>{half?.source || t('panel.debug.unknown')}</InfoRow>
            <InfoRow label={t('panel.debug.activatedAt')}>{timeText(half?.activatedAt)}</InfoRow>
            <InfoRow label={t('panel.debug.onDisk')}>{half?.installedVersion || update?.installedVersion || t('panel.debug.unknown')}</InfoRow>
            <InfoRow label={t('panel.debug.shellChanged')} tone={half?.shellChanged ? 'warn' : 'ok'}>
              {half?.shellChanged ? t('panel.debug.shellChangedYes') : t('panel.debug.shellChangedNo')}
            </InfoRow>
            <InfoRow label={t('panel.debug.retrying')} tone={half?.retrying ? 'warn' : 'ok'}>
              {half?.retrying
                ? `${t('panel.debug.retryingYes')} · ${String(half.retryAttempts ?? 0)}${half.nextRetryAt ? ` → ${half.nextRetryAt}` : ''}`
                : t('panel.debug.retryingNo')}
            </InfoRow>
            <InfoRow label={t('panel.debug.runningVersion')}>{update?.runningVersion || half?.version || t('panel.debug.unknown')}</InfoRow>
            <InfoRow label={t('panel.debug.lastError')} tone={half?.lastError ? 'error' : 'ok'}>
              {half?.lastError || t('panel.debug.noError')}
            </InfoRow>
          </InfoList>
        </Section>

        <Section title={t('panel.debug.sectionLink')}>
          {status ? (
            <InfoList>
              <InfoRow label={t('panel.connection.remoteControl')} tone={status.enabled ? 'ok' : 'warn'}>
                {status.enabled ? t('panel.debug.on') : t('panel.debug.off')}
              </InfoRow>
              <InfoRow label={t('panel.connection.tunnel')} tone={tunnelTone(status.tunnel.state)}>
                <ToneValue
                  tone={tunnelTone(status.tunnel.state)}
                  text={tunnelText(status.tunnel.state)}
                  {...(status.tunnel.error ? { detail: status.tunnel.error } : {})}
                />
              </InfoRow>
              <InfoRow label={t('panel.connection.lan')} tone={lanTone(status.lan.state, status.lan.enabled)}>
                <ToneValue
                  tone={lanTone(status.lan.state, status.lan.enabled)}
                  text={lanText(status.lan.state, status.lan.enabled)}
                  {...(status.lan.port ? { detail: String(status.lan.port) } : {})}
                />
              </InfoRow>
              <InfoRow label={t('panel.connection.sidecar')}>
                <ToneValue
                  tone={status.sidecar.state === 'healthy' ? 'ok' : 'warn'}
                  text={sidecarText(status.sidecar.state)}
                  {...(status.sidecar.restarts > 0 ? { detail: t('panel.connection.sidecarRestarts', { count: status.sidecar.restarts }) } : {})}
                />
              </InfoRow>
              {status.sidecar.restartError ? (
                <InfoRow label={t('panel.debug.sidecarError')} tone="error">
                  {status.sidecar.restartError}
                </InfoRow>
              ) : null}
              <InfoRow label={t('panel.connection.mirror')}>
                <ToneValue
                  tone={status.mirror.ok ? 'ok' : status.mirror.error ? 'error' : 'warn'}
                  text={status.mirror.ok ? t('panel.connection.mirrorOk') : t('panel.connection.mirrorOff')}
                  detail={timeText(status.mirror.pushedAt)}
                />
              </InfoRow>
              <InfoRow label={t('panel.debug.lastMobile')}>
                <ToneValue tone={status.lastMobileAt ? 'ok' : 'warn'} text={status.lastMobileAt ? timeText(status.lastMobileAt) : t('panel.debug.mobileNever')} />
              </InfoRow>
            </InfoList>
          ) : (
            <p className="text-sm text-foreground-muted">{t('panel.debug.statusUnavailable')}</p>
          )}
        </Section>

        <Section title={t('panel.debug.sectionAddress')}>
          <InfoList>
            <InfoRow label={t('panel.debug.localPort')} mono>
              {status?.localPort ? String(status.localPort) : t('panel.debug.unknown')}
            </InfoRow>
            <InfoRow label={t('panel.debug.panelScope')}>{status?.panelScope || t('panel.debug.unknown')}</InfoRow>
            <InfoRow label={t('panel.debug.panelUrl')} mono>
              {status?.panelUrl || t('panel.debug.unknown')}
            </InfoRow>
            <InfoRow label={t('panel.debug.webAccess')}>
              {status?.webAccess?.enabled
                ? t('panel.debug.webAccessOpen', { time: timeText(status.webAccess.expiresAt) })
                : t('panel.debug.webAccessClosed')}
            </InfoRow>
            <InfoRow label={t('panel.debug.addressLan')} mono>
              {listText(lanCandidates, t('panel.debug.addressNone'))}
            </InfoRow>
            <InfoRow label={t('panel.debug.addressPublic')} mono>
              {listText(publicCandidates, t('panel.debug.addressNone'))}
            </InfoRow>
            <InfoRow label={t('panel.debug.addressIpv6')} mono>
              {listText(ipv6Candidates, t('panel.debug.addressNone'))}
            </InfoRow>
          </InfoList>
        </Section>

        <Section title={t('panel.debug.sectionDevices')}>
          <InfoList>
            <InfoRow label={t('panel.debug.deviceCount')}>{devices ? String(deviceRows.length) : t('panel.debug.unknown')}</InfoRow>
            {deviceRows.length === 0 ? (
              <InfoRow label={t('panel.debug.deviceRecent')}>{t('panel.debug.deviceNone')}</InfoRow>
            ) : (
              deviceRows.slice(0, 5).map((device) => (
                <InfoRow
                  key={device.deviceId}
                  label={`${device.model || device.name || device.deviceId.slice(0, 8)}${device.suffix ? ` #${device.suffix}` : ''}`}
                >
                  <ToneValue
                    tone={device.lastSeenAt ? 'ok' : 'warn'}
                    text={device.lastSeenAt ? timeText(device.lastSeenAt) : t('panel.debug.mobileNever')}
                    detail={[device.platform, device.appVersion].filter(Boolean).join(' · ')}
                  />
                </InfoRow>
              ))
            )}
          </InfoList>
        </Section>

        <Section title={t('panel.debug.sectionMemory')}>
          {memory ? (
            <>
              <InfoList>
                <InfoRow label={t('panel.debug.hostRss')} mono>
                  {bytesText(memory.hostProcess?.rss)}
                </InfoRow>
                <InfoRow label={t('panel.debug.hostHeap')} mono>
                  {`${bytesText(memory.hostProcess?.heapUsed)} / ${bytesText(memory.hostProcess?.heapSizeLimit)}`}
                </InfoRow>
                <InfoRow label={t('panel.debug.sidecarRss')} mono>
                  {bytesText(memory.sidecarProcess?.memory?.rss)}
                </InfoRow>
                <InfoRow label={t('panel.debug.streams')}>
                  {`${t('panel.debug.streamRelay')} ${memory.streams?.relaySseOpen ?? '—'} · ${t('panel.debug.streamLan')} ${memory.streams?.lanSseOpen ?? '—'} · ${t('panel.debug.streamUpstream')} ${memory.streams?.lanUpstreamOpen ?? '—'}`}
                </InfoRow>
                <InfoRow label={t('panel.debug.mirrorCache')}>
                  {`${memory.mirror?.cachedSessions ?? '—'} / ${memory.mirror?.cachedMessages ?? '—'} · ${bytesText(memory.mirror?.cachedBytes)}`}
                </InfoRow>
                <InfoRow label={t('panel.debug.pushFailures')}>{String(memory.mirror?.pushFailures ?? '—')}</InfoRow>
                <InfoRow label={t('panel.debug.credentials')}>{String(memory.credentials?.active ?? '—')}</InfoRow>
              </InfoList>
              <p className="mt-2 text-xs text-foreground-muted">{t('panel.debug.memoryCaveat')}</p>
              {unavailable.length ? (
                <ul className="mt-2 flex flex-col gap-1 text-xs text-foreground-muted">
                  {unavailable.map((item) => (
                    <li key={item} className="break-all font-mono">
                      {item}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-foreground-muted">{t('panel.debug.statusUnavailable')}</p>
          )}
        </Section>

        <Section title={t('panel.debug.sectionSelfcheck')}>
          <div className="mb-2 flex items-center gap-2">
            <Button variant="soft" size="sm" onClick={() => void runSelfcheck()}>
              {t('panel.selfcheck.recheck')}
            </Button>
            {selfcheck ? <span className="text-xs text-foreground-muted">{t('panel.selfcheck.checkedAt', { time: timeText(selfcheck.checkedAt) })}</span> : null}
          </div>
          {selfcheck ? (
            <InfoList>
              <InfoRow label={t('panel.selfcheck.title')} tone={verdictTone(selfcheck.verdict)}>
                {verdictText(selfcheck.verdict)}
              </InfoRow>
              <InfoRow label={t('panel.selfcheck.firewall')}>
                {selfcheck.firewall.supported
                  ? `${selfcheck.firewall.enabled === null ? t('panel.selfcheck.unknown') : (selfcheck.firewall.enabled ? t('panel.debug.on') : t('panel.debug.off'))} · ${selfcheck.firewall.allowsApp === null ? t('panel.selfcheck.unknown') : (selfcheck.firewall.allowsApp ? t('panel.selfcheck.allowed') : t('panel.selfcheck.blocked'))}`
                  : t('panel.selfcheck.unknown')}
              </InfoRow>
              <InfoRow label={t('panel.selfcheck.mobile')}>{timeText(selfcheck.mobile.lastMobileAt)}</InfoRow>
              <InfoRow label={t('panel.selfcheck.port', { port: selfcheck.listening.port })}>{tunnelText(selfcheck.tunnel.state)}</InfoRow>
            </InfoList>
          ) : (
            <p className="text-sm text-foreground-muted">{t('panel.debug.selfcheckHint')}</p>
          )}
        </Section>
      </div>

      <Section title={t('panel.debug.sectionFaults')}>
        {faults?.installed === false ? (
          <p className="text-sm text-foreground-muted">{t('panel.debug.faultsNotInstalled')}</p>
        ) : ledger.length === 0 ? (
          <p className="text-sm text-foreground-muted">{t('panel.debug.faultsEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {ledger
              .slice()
              .reverse()
              .map((fault, index) => (
                <li key={`${fault.at}-${index}`} className="flex flex-col gap-1 border-b border-border-muted pb-2 last:border-b-0">
                  <span className="flex flex-wrap items-baseline gap-2 text-sm">
                    <Badge variant={fault.fatal ? 'error' : 'warning'} size="sm">
                      {fault.kind}
                    </Badge>
                    <span className="text-xs text-foreground-muted">{timeText(fault.at)}</span>
                    {fault.fatal ? <Badge variant="error" size="sm">{t('panel.debug.faultFatal')}</Badge> : null}
                  </span>
                  <span className="break-all font-mono text-xs text-foreground-muted">{fault.message}</span>
                </li>
              ))}
          </ul>
        )}
      </Section>

      {client ? (
        <Section title={t('panel.debug.sectionClient')}>
          <InfoList>
            <InfoRow label={t('panel.debug.clientReports')}>{String(client.clientReports ?? 0)}</InfoRow>
            <InfoRow label={t('panel.debug.clientLastAt')}>{timeText(client.clientLastAt)}</InfoRow>
            <InfoRow label={t('panel.debug.receiptGets')}>{`${client.readReceiptGets ?? 0} · ${timeText(client.readReceiptLastAt)}`}</InfoRow>
            <InfoRow label={t('panel.debug.readPosts')}>{`${client.desktopReadPosts ?? 0} · ${timeText(client.desktopReadLastAt)}`}</InfoRow>
            <InfoRow label={t('panel.debug.viewPosts')}>{`${client.desktopViewPosts ?? 0} · ${timeText(client.desktopViewLastAt)}`}</InfoRow>
            <InfoRow label={t('panel.debug.clientReport')}>{client.client ? JSON.stringify(client.client) : t('panel.debug.unknown')}</InfoRow>
          </InfoList>
        </Section>
      ) : null}

      {statusError ? (
        <Alert variant="error">
          <AlertIcon />
          <AlertTitle>{t('panel.debug.statusUnavailable')}</AlertTitle>
          <AlertDescription>{statusError}</AlertDescription>
        </Alert>
      ) : null}
    </main>
  )
}

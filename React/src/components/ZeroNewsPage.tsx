// 2026-11-24：概览卡加「彻底清理」入口，二次确认后把本机登录、配置与缓存一次清掉。
// 2026-11-28：错误提示按错误码/原文取词，外文界面不再显示宿主给的中文。
// ZeroNews 服务商主页：账号概览 + 隧道 / 设备左右两栏。进入即看，数据本地留底。
/**
 * ZeroNews 的配置页（2026-11-23 第二次重做）。
 *
 * 不论新老用户，进这页都是同一张概览：套餐、脱敏账号、连接状态、四个已用数量（隧道 / 设备 /
 * 在线设备 / 域名），下面隧道与设备左右两栏并排。没有数据就是 0，不再摆多步引导与截图 —— 老用户
 * 身份早就在本机客户端里，新用户靠一颗「连接」按钮把「装客户端 → 浏览器确认登录 → 建隧道」一次做完。
 *
 * 数据来自宿主的只读账号快照（`/api/relay/zeronews/account`，跑官方 CLI 的 status + show 四张清单）。
 * 这份数据基本不变，所以**读到就落本地**：下次进页面先用留底直接铺满，再在后台悄悄刷新一次；
 * 不做定时轮询（只有正在等浏览器确认登录的那一小段才轮询）。官方 CLI 没有隧道 / 设备的配额上限，
 * 这两项只显示套餐名 + 已用数量，不编 X/Y；流量那行反过来是官方直接给的总量与已用量，
 * 客户端太旧读不到就不显示这一行。
 *
 * 返回按钮回「中国」页（`#network/cn`），地址由外层 Console 换。
 */
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { Card } from '@appica/ui-react/card'
import { Input } from '@appica/ui-react/input'
import { Spinner } from '@appica/ui-react/spinner'
import { useEffect, useState } from 'react'

import type { StatusView, ZeroNewsAccount } from '../lib/api.ts'
import { errorText, replyErrorText, zeroNewsAccount, zeroNewsConnect, zeroNewsDisconnect, zeroNewsPrepare, zeroNewsPurge } from '../lib/api.ts'
import { cn, timeText, toneText, type Tone } from '../lib/format.ts'
import { t } from '../lib/i18n/index.ts'
import { Dot } from './InfoRow.tsx'

type Props = {
  open: boolean
  /** 返回（false）回地区页；换页由外层按 hash 处理。 */
  onOpenChange: (open: boolean) => void
  status: StatusView
  busy: string
}

/** ZeroNews 控制台地址：概览卡右上角「打开控制台」用。 */
const CONSOLE_URL = 'https://user.zeronews.cc/'
/** 账号快照的本地留底：数据基本不变，进来先铺旧的，别每次都空着等网络。 */
const CACHE_KEY = 'dsh-mobile-plugin:zeronews-account'

function readCache(): ZeroNewsAccount | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? (value as ZeroNewsAccount) : null
  } catch {
    return null
  }
}

/** 只留「真的读到账号」那一次：没登录 / 读取失败的空壳不覆盖已有留底。 */
function writeCache(value: ZeroNewsAccount | null) {
  try {
    if (value && value.ok && value.login) localStorage.setItem(CACHE_KEY, JSON.stringify(value))
  } catch {
    /* 存不下不影响展示 */
  }
}

/** 概览里的一格数字：上面大数字、下面小标签。 */
function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border-muted bg-background-muted px-3 py-2">
      <span className="text-lg font-semibold leading-none text-foreground-strong">{value}</span>
      <span className="text-xs text-foreground-muted">{label}</span>
    </div>
  )
}

/** 一条键值行：左标签右值，短信息用。 */
function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border-muted py-1.5 last:border-b-0">
      <span className="shrink-0 text-xs text-foreground-muted">{label}</span>
      <span className={cn('min-w-0 break-all text-right text-xs text-foreground-strong', mono && 'font-mono')}>{value || '—'}</span>
    </div>
  )
}

export function ZeroNewsPage({ open, onOpenChange, status, busy }: Props) {
  /** 账号快照：先用本地留底，后台再用接口刷新覆盖。 */
  const [snapshot, setSnapshot] = useState<ZeroNewsAccount | null>(() => readCache())
  /** 第一次真正去拉（还没留底时转圈）。 */
  const [loading, setLoading] = useState(false)
  /** 页面里的提示（连接结果 / 失败原因 / 打开浏览器失败时的地址）。 */
  const [note, setNote] = useState('')
  /** 提示是清理成功还是失败：成功用普通色，失败才用错误色。 */
  const [noteOk, setNoteOk] = useState(false)
  /** 连接 / 安装 / 断开进行中。 */
  const [linkBusy, setLinkBusy] = useState(false)
  /** 已点「连接」，正在等浏览器里点确认登录。 */
  const [waiting, setWaiting] = useState(false)
  /** 等确认期间展示、重开的确认地址：浏览器没弹出来时能手动打开。 */
  const [loginUrl, setLoginUrl] = useState('')
  /** 手动粘贴的 AuthToken：浏览器这条路弹不出来时，官方最稳的绑定兜底。 */
  const [token, setToken] = useState('')
  const canSave = busy === ''

  const phase = status.zeroNews?.phase
  const connected = phase === 'connected'
  const busyPhase = Boolean(phase && phase !== 'off' && phase !== 'error' && phase !== 'connected')
  // 身份以「本机客户端的实际登录态」为准：快照说没登录就当新用户（哪怕落盘标记是旧的），
  // 这样即使以前粘过 token、后来客户端被重置，也还能看到显眼的一键接入，而不是一个点了没反应的连接。
  const loggedIn = snapshot ? (snapshot.login === true || connected) : (status.zeroNews?.configured === true || connected)
  const client = snapshot?.client || null
  const account = snapshot?.account || { planName: '', userId: '', userTel: '' }
  const counts = snapshot?.counts || { tunnels: 0, devices: 0, domains: 0 }
  /** 流量用量：老客户端读不到就没有这一行。 */
  const traffic = snapshot?.traffic || null
  const tunnels = snapshot?.tunnels || []
  const devices = snapshot?.devices || []
  const onlineCount = devices.filter((device) => device.online).length
  const statusText = connected
    ? t('panel.zeronews.linkOn', { url: status.zeroNews?.url || '' })
    : phase === 'error'
      ? t('panel.zeronews.linkError')
      : busyPhase
        ? t('panel.zeronews.linkBusy')
        : t('panel.zeronews.linkOff')
  const linkTone: Tone = connected ? 'ok' : phase === 'error' ? 'error' : busyPhase ? 'warn' : 'off'
  /** 还没接入过（本机没有身份）：给一颗显眼的一键接入按钮，别让新用户找不到入口。 */
  const firstTime = !loggedIn

  /** 关页时把提示与等待态清掉（留底本身不动）。 */
  useEffect(() => {
    if (!open) {
      setNote('')
      setWaiting(false)
      setLoginUrl('')
      setToken('')
      setLoading(false)
    }
  }, [open])

  /** 进页面：有留底就直接铺，后台悄悄刷一次；没留底才转圈去拉。不做定时轮询。 */
  useEffect(() => {
    if (!open) return
    void refresh(readCache() === null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /** 等浏览器确认登录期间每 1.5 秒看一次；登录变真就自动接着连接。 */
  useEffect(() => {
    if (!open || !waiting) return undefined
    const timer = setInterval(() => { void refresh(false) }, 1500)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, waiting])

  /** 等太久还没确认就停下转圈，给出地址与兜底，别一直卡在「检测登录中」。 */
  useEffect(() => {
    if (!open || !waiting) return undefined
    const timer = setTimeout(() => {
      setWaiting(false)
      setNote(t('panel.zeronews.loginTimeout'))
    }, 120_000)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, waiting])

  useEffect(() => {
    if (!open || !waiting || snapshot?.login !== true) return
    setWaiting(false)
    setLoginUrl('')
    void connect(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, waiting, snapshot])

  /** 等确认收口之后仍持续留意登录是否完成：用户可能过一会儿才在浏览器或控制台确认，
   *  不能因为一开始那两分钟没等到就永远当没登录。 */
  useEffect(() => {
    if (!open || waiting || loggedIn) return undefined
    const timer = setInterval(() => { void refresh(false) }, 5000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, waiting, loggedIn])

  /** 明确登录失败（配额满 / 被拒 / 过期）：停止转圈，把原因原样摆出来。 */
  useEffect(() => {
    if (!open || !snapshot?.loginError) return
    setWaiting(false)
    setLoginUrl('')
    setNote(snapshot.loginError)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, snapshot?.loginError])

  /** 还没连上时，一轮刷新里读到已登录就自动接一次（覆盖超时后补确认、以及在控制台先登录的情况）。 */
  useEffect(() => {
    if (!open || waiting || connected) return
    if (snapshot?.login === true) void connect(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, waiting, connected, snapshot?.login])

  async function refresh(showSpinner: boolean) {
    if (showSpinner) setLoading(true)
    try {
      const next = await zeroNewsAccount()
      if (next && next.ok === false) {
        if (showSpinner) setNote(replyErrorText(next, t('panel.zeronews.loadFailed')))
        return
      }
      setSnapshot(next)
      writeCache(next)
    } catch (error) {
      if (showSpinner) setNote(error instanceof Error ? error.message : String(error))
    } finally {
      if (showSpinner) setLoading(false)
    }
  }

  /** 连接：宿主起客户端、建隧道、拿域名。auto=true 表示是登录成功后自动触发的。 */
  async function connect(auto = false, force = false) {
    if (linkBusy && !force) return
    setLinkBusy(true)
    setNote(auto ? t('panel.zeronews.loginDetected') : '')
    setNoteOk(false)
    let needSetup = false
    try {
      const res = await zeroNewsConnect()
      const error = replyErrorText(res)
      if (res.phase === 'login') {
        // 这台机器还没登录：别再干等，转去会打开浏览器确认页的接入流程。
        needSetup = true
        setNote(error || '')
      } else if (!res.ok && error) setNote(error)
      else if (res.phase === 'connected') setNote('')
      else if (error) setNote(error)
      await refresh(false)
    } catch (error) {
      setNote(errorText(error))
    } finally {
      setLinkBusy(false)
    }
    if (needSetup) void startSetup()
  }

  /** 手动粘贴 AuthToken 绑定并连接：浏览器确认弹不出来时的官方兜底。 */
  async function saveToken() {
    const value = token.trim()
    if (linkBusy || !value) return
    setLinkBusy(true)
    setNote('')
    setNoteOk(false)
    try {
      const res = await zeroNewsConnect(value)
      const error = replyErrorText(res)
      if (!res.ok && error) setNote(error)
      else if (error) setNote(error)
      else {
        setToken('')
        setWaiting(false)
        setLoginUrl('')
      }
      await refresh(false)
    } catch (error) {
      setNote(errorText(error))
    } finally {
      setLinkBusy(false)
    }
  }

  /** 没登录时的第一次接入：装客户端 + 跑官方 login 拉起浏览器确认。老用户 already 就直接连。 */
  async function startSetup() {
    if (linkBusy) return
    setLinkBusy(true)
    setNote('')
    setNoteOk(false)
    let autoConnect = false
    try {
      const res = await zeroNewsPrepare()
      if (!res.ok) {
        setNote(replyErrorText(res, t('panel.zeronews.loadFailed')))
        return
      }
      if (res.already) {
        autoConnect = true
        setWaiting(false)
        setLoginUrl('')
      } else {
        setWaiting(true)
        setLoginUrl(res.url || '')
        setNote(!res.opened && res.url ? t('panel.zeronews.openFailed', { url: res.url }) : t('panel.zeronews.loginWaiting'))
      }
      await refresh(false)
    } catch (error) {
      setNote(errorText(error))
    } finally {
      setLinkBusy(false)
      if (autoConnect) void connect(true, true)
    }
  }

  /** 断开：停客户端、撤域名。 */
  async function disconnect() {
    if (linkBusy) return
    setLinkBusy(true)
    setNote('')
    setNoteOk(false)
    try {
      const res = await zeroNewsDisconnect()
      const error = replyErrorText(res)
      if (!res.ok && error) setNote(error)
      await refresh(false)
    } catch (error) {
      setNote(errorText(error))
    } finally {
      setLinkBusy(false)
    }
  }

  /** 彻底清理：与「断开」分开的破坏性入口，二次确认后才动本机的登录身份与配置。 */
  async function purge() {
    if (linkBusy || !window.confirm(t('panel.zeronews.purgeConfirm'))) return
    setLinkBusy(true)
    setNote('')
    setNoteOk(false)
    try {
      const res = await zeroNewsPurge()
      const error = replyErrorText(res)
      if (!res.ok && error) setNote(error)
      else { setNote(t('panel.zeronews.purgeDone')); setNoteOk(true) }
      await refresh(false)
      if (res.ok) {
        try { localStorage.removeItem(CACHE_KEY) } catch { /* 留底删不掉不影响清理本身 */ }
      }
    } catch (error) {
      setNote(errorText(error))
    } finally {
      setLinkBusy(false)
    }
  }

  /** 主按钮一个入口：已连接就断开；有身份就连接；没身份就把首次接入一步做完。 */
  function onPrimary() {
    if (connected) return disconnect()
    if (loggedIn) return connect(false)
    return startSetup()
  }

  if (!open) return null

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            ← {t('panel.region.china')}
          </Button>
          <h2 className="text-base font-medium text-foreground-strong">{t('panel.provider.zeronews')}</h2>
        </div>
        <div className="flex items-center gap-1">
          <a
            href={CONSOLE_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded px-2 py-1 text-xs text-foreground-muted transition-colors hover:text-foreground-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('panel.zeronews.console')}
          </a>
          <Button variant="ghost" size="sm" disabled={loading || linkBusy} onClick={() => refresh(true)}>
            {loading ? <Spinner /> : t('panel.zeronews.refresh')}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {/* 概览：套餐 + 账号 + 连接状态，四个已用数量，再列机器的接入信息与主操作。 */}
        <Card frame="solid">
          <div className="flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Badge variant="soft" size="sm">{account.planName || '—'}</Badge>
                <span className="truncate text-xs text-foreground-muted">{account.userTel || account.userId || '—'}</span>
              </div>
              <span className={cn('inline-flex shrink-0 items-center gap-1.5 text-xs', toneText[linkTone])}>
                <Dot tone={linkTone} />
                {statusText}
              </span>
            </div>

            {firstTime ? (
              <div className="flex flex-col gap-2 rounded-md border border-border-muted bg-primary-subtle p-3">
                <span className="text-sm font-medium text-foreground-strong">{t('panel.zeronews.linkTitle')}</span>
                <p className="text-xs leading-5 text-foreground-muted">{t('panel.zeronews.linkHint')}</p>
                {snapshot && snapshot.available === false ? (
                  <p className="text-xs text-foreground-muted">{t('panel.zeronews.notInstalled')}</p>
                ) : null}
                <Button variant="primary" size="sm" className="w-full" disabled={!canSave || linkBusy || waiting} onClick={onPrimary}>
                  {linkBusy ? t('panel.zeronews.preparing') : waiting ? t('panel.zeronews.linkConnecting') : t('panel.zeronews.prepare')}
                </Button>
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat value={counts.tunnels} label={t('panel.zeronews.overview.tunnels')} />
              <Stat value={counts.devices} label={t('panel.zeronews.overview.devices')} />
              <Stat value={onlineCount} label={t('panel.zeronews.overview.online')} />
              <Stat value={counts.domains} label={t('panel.zeronews.overview.domains')} />
            </div>

            <div className="flex flex-col">
              {traffic ? (
                <Row
                  label={t('panel.zeronews.overview.traffic')}
                  value={`${traffic.used || '—'} / ${traffic.total || '—'}${traffic.over ? ` · ${t('panel.zeronews.overview.trafficOver')}` : ''}`}
                />
              ) : null}
              <Row label={t('panel.zeronews.overview.node')} value={client?.node || ''} mono />
              <Row
                label={t('panel.zeronews.overview.host')}
                value={client ? [client.os, client.arch].filter(Boolean).join(' / ') : ''}
              />
              <Row label={t('panel.zeronews.overview.clientVersion')} value={client?.version || ''} />
              <Row label={t('panel.zeronews.overview.lastPong')} value={timeText(client?.lastPongAt)} />
            </div>

            {waiting ? (
              <div className="flex flex-col gap-2 rounded-md border border-border-muted bg-background-muted p-3">
                <div className="flex items-center gap-2 text-xs leading-5 text-foreground-muted">
                  <Spinner />
                  <span>{note || t('panel.zeronews.loginWaiting')}</span>
                </div>
                {loginUrl ? (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-xs leading-5 text-foreground-muted">{t('panel.zeronews.loginUrlHint')}</p>
                    <span className="select-all break-all font-mono text-xs text-foreground-strong">{loginUrl}</span>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="ghost" size="sm" disabled={linkBusy} onClick={() => void startSetup()}>
                        {t('panel.zeronews.reopen')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={linkBusy}
                        onClick={() => { setWaiting(false); setLoginUrl(''); void connect(true) }}
                      >
                        {t('panel.zeronews.loginRetry')}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            {!waiting && note ? <p className={cn('text-xs', noteOk ? 'text-foreground-muted' : 'text-error')}>{note}</p> : null}

            {!loggedIn ? (
              <div className="flex flex-col gap-2 rounded-md border border-border-muted p-3">
                <span className="text-sm font-medium text-foreground-strong">{t('panel.zeronews.tokenLabel')}</span>
                <Input
                  value={token}
                  placeholder={t('panel.zeronews.tokenPlaceholder')}
                  onChange={(event) => setToken(event.target.value)}
                />
                <p className="text-xs leading-5 text-foreground-muted">{t('panel.zeronews.tokenHint')}</p>
                <div className="flex justify-end">
                  <Button variant="primary" size="sm" disabled={!canSave || linkBusy || !token.trim()} onClick={() => void saveToken()}>
                    {t('panel.zeronews.tokenSave')}
                  </Button>
                </div>
              </div>
            ) : null}

            {!firstTime ? (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="ghost" size="sm" disabled={!canSave || linkBusy || waiting} onClick={() => void purge()}>
                  {t('panel.zeronews.purge')}
                </Button>
                <Button
                  variant={connected ? 'ghost' : 'primary'}
                  size="sm"
                  disabled={!canSave || linkBusy || waiting}
                  onClick={onPrimary}
                >
                  {linkBusy
                    ? t('panel.zeronews.linkConnecting')
                    : connected
                      ? t('panel.zeronews.linkDisconnect')
                      : t('panel.zeronews.linkConnect')}
                </Button>
              </div>
            ) : null}
          </div>
        </Card>

        {/* 隧道与设备左右两栏并排，把横向空间用起来；内容多了各自滚动。 */}
        <div className="grid gap-3 md:grid-cols-2">
          <Card frame="solid">
            <div className="flex max-h-96 flex-col gap-2 overflow-y-auto p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-foreground-strong">{t('panel.zeronews.tunnels.title')}</h3>
                <Badge variant="secondary" size="xs">{counts.tunnels}</Badge>
              </div>
              {tunnels.length === 0 ? (
                <p className="text-xs text-foreground-muted">{t('panel.zeronews.tunnels.empty')}</p>
              ) : (
                <div className="flex flex-col">
                  {tunnels.map((tunnel) => (
                    <div key={tunnel.id} className="flex items-start justify-between gap-3 border-b border-border-muted py-2 last:border-b-0">
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="truncate font-mono text-xs text-foreground-strong">{tunnel.domain || '—'}</span>
                        <span className="flex flex-wrap items-center gap-1.5 text-xs text-foreground-muted">
                          {tunnel.type ? <Badge variant="secondary" size="xs">{tunnel.type}</Badge> : null}
                          {tunnel.bw > 0 ? <span>{t('panel.zeronews.tunnels.bw', { bw: tunnel.bw })}</span> : null}
                          {tunnel.local ? <span className="font-mono">{t('panel.zeronews.tunnels.local', { target: tunnel.local })}</span> : null}
                        </span>
                      </div>
                      <Badge variant={tunnel.enabled ? 'soft' : 'secondary'} size="xs">
                        {tunnel.enabled ? t('panel.zeronews.state.enabled') : t('panel.zeronews.state.disabled')}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>

          <Card frame="solid">
            <div className="flex max-h-96 flex-col gap-2 overflow-y-auto p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-foreground-strong">{t('panel.zeronews.devices.title')}</h3>
                <Badge variant="secondary" size="xs">{counts.devices}</Badge>
              </div>
              {devices.length === 0 ? (
                <p className="text-xs text-foreground-muted">{t('panel.zeronews.devices.empty')}</p>
              ) : (
                <div className="flex flex-col">
                  {devices.map((device) => (
                    <div key={device.id} className="flex items-start justify-between gap-3 border-b border-border-muted py-2 last:border-b-0">
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="truncate text-xs text-foreground-strong">{device.name || device.hostname || '—'}</span>
                        <span className="flex flex-wrap items-center gap-1.5 text-xs text-foreground-muted">
                          <span>{[device.os, device.arch].filter(Boolean).join(' / ')}</span>
                          {device.version ? <span>v{device.version}</span> : null}
                          {device.ip ? <span className="font-mono">{device.ip}</span> : null}
                        </span>
                      </div>
                      <span className={cn('inline-flex shrink-0 items-center gap-1 text-xs', device.online ? toneText.ok : toneText.off)}>
                        <Dot tone={device.online ? 'ok' : 'off'} />
                        {device.online ? t('panel.zeronews.state.online') : t('panel.zeronews.state.offline')}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>
    </>
  )
}

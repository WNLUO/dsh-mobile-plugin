// ZeroNews 服务商主页：账号套餐概览 + 隧道 / 设备列表 + 一键接入（浏览器确认，不再粘 token）。
/**
 * ZeroNews 的配置页（2026-11-23 重做：从「一张引导卡」做成一个能看账号全貌的主页）。
 *
 * 数据来自宿主的只读账号快照（`/api/relay/zeronews/account`，走官方 CLI 的 status + show 三张清单）：
 * 套餐名、脱敏账号、这台机器的运行态、账号下隧道 / 设备 / 域名。官方 CLI 没有「套餐配额上限」，
 * 所以概览只显示「套餐名 + 已用数量」，不编造 X/Y。
 *
 * 首次接入全自动：点「开始接入」→ 宿主装好客户端并跑 `zeronews login`，把确认链接丢给系统浏览器；
 * 用户只在浏览器点一次「确认登录」，面板轮询到登录成功就自动起客户端、建隧道。全程不需要复制 token。
 *
 * 老用户（以前走「粘 token」那套）无感：他们的身份早就写进本机客户端配置，`login` 直接为真，
 * 打开这一页即是完整概览，不会让他们重来一遍。token 只在一次请求里经过、面板不留、不存、不显示。
 *
 * 返回按钮回「中国」页（`#network/cn`），地址由外层 Console 换。
 */
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { Card } from '@appica/ui-react/card'
import { Spinner } from '@appica/ui-react/spinner'
import { useEffect, useState } from 'react'

import type { StatusView, ZeroNewsAccount } from '../lib/api.ts'
import { zeroNewsAccount, zeroNewsConnect, zeroNewsDisconnect, zeroNewsPrepare } from '../lib/api.ts'
import { cn, timeText, toneText, type Tone } from '../lib/format.ts'
import { t } from '../lib/i18n/index.ts'
import { Dot } from './InfoRow.tsx'
import { LineGuide } from './LineGuide.tsx'

type Props = {
  open: boolean
  /** 返回（false）回地区页；换页由外层按 hash 处理。 */
  onOpenChange: (open: boolean) => void
  status: StatusView
  busy: string
}

/** ZeroNews 控制台地址：概览卡右上角「打开控制台」用。 */
const CONSOLE_URL = 'https://user.zeronews.cc/'

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
  /** 账号快照：套餐、运行态、隧道 / 设备 / 域名。null = 还没读到。 */
  const [snapshot, setSnapshot] = useState<ZeroNewsAccount | null>(null)
  /** 读取中（刷新按钮转圈）。 */
  const [loading, setLoading] = useState(false)
  /** 页面里的提示（连接结果 / 失败原因 / 打开浏览器失败时的地址）。 */
  const [note, setNote] = useState('')
  /** 连接 / 安装 / 断开进行中。 */
  const [linkBusy, setLinkBusy] = useState(false)
  /** 已点「开始接入」，正在等浏览器里点确认登录。 */
  const [waiting, setWaiting] = useState(false)
  const canSave = busy === ''

  const phase = status.zeroNews?.phase
  const connected = phase === 'connected'
  const busyPhase = Boolean(phase && phase !== 'off' && phase !== 'error' && phase !== 'connected')
  const loggedIn = snapshot?.login === true || status.zeroNews?.configured === true || connected
  const client = snapshot?.client || null
  const account = snapshot?.account || { planName: '', userId: '', userTel: '' }
  const counts = snapshot?.counts || { tunnels: 0, devices: 0, domains: 0 }
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

  /** 关页时把上一轮的提示、等待态一起清掉。 */
  useEffect(() => {
    if (!open) {
      setNote('')
      setWaiting(false)
      setLoading(false)
    }
  }, [open])

  /** 打开页面时拉一次账号快照（失败也不弹错，保留上一份）。 */
  useEffect(() => {
    if (open) void refresh(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /** 等登录确认期间每 2 秒轮询：一旦 login 变真就自动接着连接（起客户端 + 建隧道）。 */
  useEffect(() => {
    if (!open || !waiting) return undefined
    const timer = setInterval(() => { void refresh(false) }, 2000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, waiting])

  /** 登录一成功，立刻自动往下走，不用用户再点。 */
  useEffect(() => {
    if (!open || !waiting || snapshot?.login !== true) return
    setWaiting(false)
    void connect(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, waiting, snapshot])

  async function refresh(showSpinner: boolean) {
    if (showSpinner) setLoading(true)
    try {
      const next = await zeroNewsAccount()
      setSnapshot(next)
      if (next && next.ok === false) setNote(next.error || t('panel.zeronews.loadFailed'))
    } catch (error) {
      if (showSpinner) setNote(error instanceof Error ? error.message : String(error))
    } finally {
      if (showSpinner) setLoading(false)
    }
  }

  /** 连接：宿主起客户端、建隧道、拿域名。auto=true 表示是登录成功后自动触发的。 */
  async function connect(auto = false) {
    if (linkBusy) return
    setLinkBusy(true)
    setNote(auto ? t('panel.zeronews.loginDetected') : '')
    try {
      const res = await zeroNewsConnect()
      const error = typeof res.error === 'string' ? res.error : res.error?.message
      if (!res.ok && error) setNote(error)
      else if (res.phase === 'connected') setNote(t('panel.zeronews.linkOn', { url: res.url || '' }))
      else if (error) setNote(error)
      await refresh(false)
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    } finally {
      setLinkBusy(false)
    }
  }

  /** 第一步：装客户端 + 跑官方 login 拉起浏览器确认。老用户 already 就直接连。 */
  async function startSetup() {
    if (linkBusy) return
    setLinkBusy(true)
    setNote('')
    let autoConnect = false
    try {
      const res = await zeroNewsPrepare()
      if (!res.ok) {
        setNote(res.error || t('panel.zeronews.loadFailed'))
        return
      }
      if (res.already) {
        autoConnect = true
        setWaiting(false)
      } else {
        setWaiting(true)
        if (!res.opened && res.url) setNote(t('panel.zeronews.openFailed', { url: res.url }))
        else setNote(t('panel.zeronews.loginWaiting'))
      }
      await refresh(false)
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    } finally {
      setLinkBusy(false)
      if (autoConnect) void connect(true)
    }
  }

  /** 断开：停客户端、撤域名。 */
  async function disconnect() {
    if (linkBusy) return
    setLinkBusy(true)
    setNote('')
    try {
      const res = await zeroNewsDisconnect()
      const error = typeof res.error === 'string' ? res.error : res.error?.message
      if (!res.ok && error) setNote(error)
      await refresh(false)
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    } finally {
      setLinkBusy(false)
    }
  }

  if (!open) return null

  const steps = [
    { title: t('panel.guide.zeronews.step1'), body: t('panel.guide.zeronews.step1Body') },
    { title: t('panel.guide.zeronews.step2'), body: t('panel.guide.zeronews.step2Body') },
    { title: t('panel.guide.zeronews.step3'), body: t('panel.guide.zeronews.step3Body') },
  ]

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

      {loggedIn ? (
        <div className="flex flex-col gap-3">
          {/* 概览：套餐 + 账号 + 连接状态，再排四个已用数量。 */}
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

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat value={counts.tunnels} label={t('panel.zeronews.overview.tunnels')} />
                <Stat value={counts.devices} label={t('panel.zeronews.overview.devices')} />
                <Stat value={onlineCount} label={t('panel.zeronews.overview.online')} />
                <Stat value={counts.domains} label={t('panel.zeronews.overview.domains')} />
              </div>

              <div className="flex flex-col">
                <Row label={t('panel.zeronews.overview.node')} value={client?.node || ''} mono />
                <Row
                  label={t('panel.zeronews.overview.host')}
                  value={client ? [client.os, client.arch].filter(Boolean).join(' / ') : ''}
                />
                <Row label={t('panel.zeronews.overview.clientVersion')} value={client?.version || ''} />
                <Row label={t('panel.zeronews.overview.lastPong')} value={timeText(client?.lastPongAt)} />
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="ghost" size="sm" disabled={!canSave || linkBusy || !connected} onClick={disconnect}>
                  {t('panel.zeronews.linkDisconnect')}
                </Button>
                <Button variant="outline" size="sm" disabled={!canSave || linkBusy || connected} onClick={() => connect(false)}>
                  {linkBusy ? t('panel.zeronews.linkConnecting') : t('panel.zeronews.linkConnect')}
                </Button>
              </div>
              {note ? <p className="text-xs text-error">{note}</p> : null}
            </div>
          </Card>

          {/* 账号隧道：域名 / 协议 / 带宽 / 转发到本机哪个端口。 */}
          <Card frame="solid">
            <div className="flex flex-col gap-2 p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-foreground-strong">{t('panel.zeronews.tunnels.title')}</h3>
                <Badge variant="secondary" size="xs">{counts.tunnels}</Badge>
              </div>
              {tunnels.length === 0 ? (
                <p className="text-xs text-foreground-muted">{t('panel.zeronews.tunnels.empty')}</p>
              ) : (
                <div className="flex flex-col gap-2">
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

          {/* 账号设备：名称 / 系统 / 版本 / IP / 在线。 */}
          <Card frame="solid">
            <div className="flex flex-col gap-2 p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-foreground-strong">{t('panel.zeronews.devices.title')}</h3>
                <Badge variant="secondary" size="xs">{counts.devices}</Badge>
              </div>
              {devices.length === 0 ? (
                <p className="text-xs text-foreground-muted">{t('panel.zeronews.devices.empty')}</p>
              ) : (
                <div className="flex flex-col gap-2">
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
      ) : (
        <Card frame="solid">
          <div className="flex flex-col gap-3 p-4">
            <LineGuide steps={steps} />
            <p className="text-xs leading-5 text-foreground-muted">{t('panel.zeronews.linkHint')}</p>

            {waiting ? (
              <div className="flex items-center gap-2 text-xs leading-5 text-foreground-muted">
                <Spinner />
                <span>{note || t('panel.zeronews.loginWaiting')}</span>
              </div>
            ) : null}

            {snapshot && snapshot.available === false ? (
              <p className="text-xs text-foreground-muted">{t('panel.zeronews.notInstalled')}</p>
            ) : null}

            {status.zeroNews?.error ? <p className="text-xs text-error">{status.zeroNews.error}</p> : null}
            {!waiting && note ? <p className="text-xs text-error">{note}</p> : null}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="primary" size="sm" disabled={!canSave || linkBusy || waiting} onClick={startSetup}>
                {linkBusy ? t('panel.zeronews.preparing') : t('panel.zeronews.prepare')}
              </Button>
            </div>
          </div>
        </Card>
      )}
    </>
  )
}

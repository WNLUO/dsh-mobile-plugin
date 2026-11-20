/** 远程电脑：本机生成绑定信息、添加电脑、按设备打开与管理线路。 */
// 2026-11-19：顶部渲染窗口自动续期 / 关掉后保留一小时的提示；页面连上之前禁用同一设备的打开按钮；
// 线路检测每行带上 host:port 区分同通道的两条；窗口开着时改挡位单独说明重新打开后生效。
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { Card } from '@appica/ui-react/card'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@appica/ui-react/dialog'
import { Field, FieldLabel } from '@appica/ui-react/field'
import { Radio } from '@appica/ui-react/radio'
import { RadioGroup } from '@appica/ui-react/radio-group'
import { Spinner } from '@appica/ui-react/spinner'
import { Textarea } from '@appica/ui-react/textarea'
import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError } from '../lib/api.ts'
import { pageVisible } from '../lib/embed-visibility.ts'
import { PanelWindowActions } from './PanelWindowActions.tsx'
import { t } from '../lib/i18n/index.ts'
import { isPublicRelayUrl } from '../lib/links.ts'
import { useNotify } from '../lib/notify.ts'
import {
  openRemoteComputer,
  remoteComputers,
  remoteErrorText,
  remoteModes,
  type RemoteComputer,
  type RemoteComputerDiagnoseRoute,
  type RemoteComputerInvite,
  type RemoteComputerList,
} from '../lib/remote-computers.ts'

/** 在桌面端打开：显示器窗口图标。 */
function DesktopIcon() {
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
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  )
}

/** 删除绑定：垃圾桶图标。 */
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

function channelText(channel: string | null, url?: string | null): string {
  const keys: Record<string, string> = {
    auto: 'auto', lan: 'lan', direct: 'direct', ipv6: 'ipv6', relay: 'relay', tunnel: 'tailcat', tailcat: 'tailcat', p2p: 'p2p', tcp: 'tcp',
  }
  if (!channel) return t('panel.common.none')
  // 中转分「自建 / 公用」：公用中转只是没自建时的便利通道，配了任一公网可达的自建后公用会被停用。
  // 按地址判，判据与网络配置那栏同源（公用清单）。
  if (channel === 'relay' && url && isPublicRelayUrl(url)) return t('panel.remote.channel.publicRelay')
  return keys[channel] ? t(`panel.remote.channel.${keys[channel]}`) : channel
}

/** 线路地址的 host:port：同一条通道有两台/两条候选时，靠它分清一好一坏的是哪条。 */
function endpointText(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.host
  } catch {
    return url
  }
}

export function RemoteComputersCard() {
  const notify = useNotify()
  const [list, setList] = useState<RemoteComputerList | null>(null)
  const [settled, setSettled] = useState(false)
  const [localOnly, setLocalOnly] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState<string[]>([])
  const [dialog, setDialog] = useState<'invite' | 'add' | null>(null)
  const [invitation, setInvitation] = useState<RemoteComputerInvite | null>(null)
  const [inviteText, setInviteText] = useState('')
  const [manualCopy, setManualCopy] = useState(false)
  const [modeDevice, setModeDevice] = useState<RemoteComputer | null>(null)
  const [mode, setMode] = useState('auto')
  const [diagnoseRoutes, setDiagnoseRoutes] = useState<RemoteComputerDiagnoseRoute[] | null>(null)
  const [diagnosing, setDiagnosing] = useState(false)
  const [now, setNow] = useState(0)
  const clockOffset = useRef(0)
  const loading = useRef(false)
  const mounted = useRef(false)

  const load = useCallback(async () => {
    if (loading.current) return
    loading.current = true
    try {
      const next = await remoteComputers.list()
      if (!mounted.current) return
      clockOffset.current = next.serverNow - Date.now()
      setNow(next.serverNow)
      setList(next)
      setLocalOnly(false)
      setLoadError('')
    } catch (error) {
      if (!mounted.current) return
      const denied = error instanceof ApiError && error.status === 403
      setLocalOnly(denied)
      setLoadError(denied ? '' : remoteErrorText(error))
      if (denied) setList(null)
    } finally {
      loading.current = false
      if (mounted.current) setSettled(true)
    }
  }, [])

  // 与设备卡相同：只在可见、挂载期间轮询；宿主时间校准剩余租期。
  useEffect(() => {
    mounted.current = true
    const tick = () => {
      if (!pageVisible()) return
      setNow(Date.now() + clockOffset.current)
      void load()
    }
    tick()
    const timer = window.setInterval(tick, 3000)
    document.addEventListener('visibilitychange', tick)
    return () => {
      mounted.current = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [load])

  /** 每个操作只锁自己那条：一台设备在忙，不影响别的设备与顶栏按钮。 */
  const isBusy = (key: string) => busy.includes(key)
  const deviceBusy = (id: string) => busy.some((key) => key.endsWith(`:${id}`))

  async function act(key: string, work: () => Promise<unknown>, done?: string) {
    if (busy.includes(key)) return
    setBusy((keys) => [...keys, key])
    try {
      await work()
      if (done) notify('ok', t(done))
      await load()
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setLocalOnly(true)
        setList(null)
        setDialog(null)
        setModeDevice(null)
        setInvitation(null)
      }
      notify('error', error instanceof ApiError && error.status === 403
        ? t('panel.remote.localOnly')
        : remoteErrorText(error))
    } finally {
      setBusy((keys) => keys.filter((item) => item !== key))
    }
  }

  /** 逐条探活当前设备的线路；只读探测，不改选中状态。 */
  async function diagnose(device: RemoteComputer) {
    if (diagnosing) return
    setDiagnosing(true)
    try {
      setDiagnoseRoutes((await remoteComputers.diagnose(device.id)).routes)
    } catch (error) {
      notify('error', remoteErrorText(error))
    } finally {
      setDiagnosing(false)
    }
  }

  function generateInvite() {
    setInvitation(null)
    setManualCopy(false)
    setDialog('invite')
    void act('invite', async () => { setInvitation(await remoteComputers.invite()) })
  }

  async function copyInvite() {
    if (!invitation || invitation.expiresAt <= now) return
    try {
      await navigator.clipboard.writeText(invitation.invite)
      setManualCopy(false)
      notify('ok', t('panel.remote.copied'))
    } catch {
      setManualCopy(true)
    }
  }

  function open(device: RemoteComputer) {
    void act(`open:${device.id}`, async () => {
      const result = await openRemoteComputer(device.id)
      // 桌面端回退到浏览器有两种原因：本机没装桌面端、或壳没起来——分开说清，不是出错。
      if (result.shellMissing) notify('ok', t('panel.remote.shellUnavailable'))
      else if (result.shellOpened === false) notify('ok', t('panel.remote.shellFellBack'))
    })
  }

  function remove(device: RemoteComputer) {
    if (!window.confirm(t('panel.remote.removeConfirm', { name: device.name || device.instanceId }))) return
    void act(`remove:${device.id}`, () => remoteComputers.remove(device.id), 'panel.remote.removed')
  }

  const devices = list?.devices ?? []
  const authorizedComputers = list?.authorizedComputers ?? []
  const available = settled && !localOnly && list !== null
  const inviteExpired = invitation !== null && invitation.expiresAt <= now
  const dialogBusy = dialog === 'invite' ? isBusy('invite') : dialog === 'add' ? isBusy('add') : false
  const modeBusy = modeDevice !== null && isBusy(`mode:${modeDevice.id}`)

  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-foreground-strong">{t('panel.remote.title')}</h1>
        <div className="flex flex-wrap items-center gap-1">
          {available ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <Button variant="ghost" size="sm" className="px-2 text-xs xl:px-4 xl:text-sm xl:before:border xl:before:border-border xl:before:bg-background" disabled={isBusy('invite')} onClick={generateInvite}>
                {t('panel.remote.createInvite')}
              </Button>
              <Button variant="ghost" size="sm" className="px-2 text-xs xl:px-4 xl:text-sm xl:before:border xl:before:border-border xl:before:bg-background" disabled={isBusy('add')} onClick={() => { setInviteText(''); setDialog('add') }}>
                {t('panel.remote.add')}
              </Button>
            </span>
          ) : null}
          <PanelWindowActions />
        </div>
      </header>
      <Card frame="solid" className="flex h-full min-h-0 flex-col">
        {available ? <p className="mt-2 text-xs leading-5 text-foreground-muted">{t('panel.remote.hint')}</p> : null}
      {!settled ? (
        <div className="flex items-center gap-2 py-2 text-sm text-foreground-muted">
          <Spinner />{t('panel.shell.readingStatus')}
        </div>
      ) : null}
      {localOnly ? <p className="mt-2 text-sm text-foreground-muted">{t('panel.remote.localOnly')}</p> : null}
      {loadError ? <p className="mt-2 text-xs text-error">{loadError}</p> : null}
      {available ? (
        <>
          {devices.length === 0 ? <p className="mt-3 text-xs text-foreground-muted">{t('panel.remote.empty')}</p> : null}
          <div className="mt-1 flex min-h-0 flex-1 flex-col">
            {devices.map((device) => {
              const expiresAt = device.expiresAt ?? 0
              const expired = device.state === 'expired' || (expiresAt > 0 && expiresAt <= now)
              const state = device.state === 'revoked' ? 'revoked' : expired ? 'expired' : device.state
              // 桌面窗口连着才算「已打开」；关掉窗口后这里会回到未打开，打开图标重新出现。
              const opened = device.attached && device.state !== 'revoked'
              const rowBusy = deviceBusy(device.id)
              return (
                <div key={device.id} className="flex min-h-0 flex-1 flex-col justify-between gap-2 border-b border-border-muted py-2 last:border-b-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm text-foreground-strong">{device.name || device.instanceId}</span>
                      <Badge variant="secondary" size="xs">{t(`panel.remote.state.${state}`)}</Badge>
                    </div>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <Button variant="ghost" size="sm" className="px-2 text-xs xl:px-2 xl:text-sm" disabled={rowBusy} onClick={() => { setMode(device.mode); setDiagnoseRoutes(null); setModeDevice(device) }}>
                        {t('panel.remote.route')}
                      </Button>
                      {opened ? (
                        <span className="whitespace-nowrap px-1 text-xs text-foreground-muted">
                          {channelText(device.mode, device.url)} · {channelText(device.channel, device.url)}
                          {device.latencyMs !== null && Number.isFinite(device.latencyMs) ? ` · ${Math.round(device.latencyMs)} ms` : ''}
                        </span>
                      ) : (
                        <Button variant="ghost" size="sm" className="px-2" aria-label={t('panel.remote.open')} disabled={rowBusy || device.state === 'revoked' || device.state === 'connecting'} onClick={() => open(device)}>
                          <DesktopIcon />
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" className="px-2" aria-label={t('panel.remote.remove')} disabled={rowBusy} onClick={() => remove(device)}>
                        <TrashIcon />
                      </Button>
                      {rowBusy ? <Spinner /> : null}
                    </span>
                  </div>
                  {expired && device.state !== 'revoked'
                    ? <p className="text-xs text-foreground-muted">{t('panel.remote.expiredHint')}</p> : null}
                  {device.lastError || device.lastErrorCode ? <p className="text-xs break-all text-error">{remoteErrorText(device.lastErrorCode)}</p> : null}
                </div>
              )
            })}
          </div>
          {authorizedComputers.length > 0 ? (
            <div className="mt-1 border-t border-border-muted pt-2">
              <p className="text-xs text-foreground-muted">{t('panel.remote.authorizedTitle')}</p>
              {authorizedComputers.map((computer) => (
                <div key={computer.deviceId} className="flex items-center justify-between gap-2 border-b border-border-muted py-3 last:border-b-0">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-foreground-strong">{computer.name || t('panel.remote.unknownComputer')}</p>
                  </div>
                  <Button variant="ghost" size="sm" className="px-2" aria-label={t('panel.remote.revoke')} disabled={isBusy(`revoke:${computer.deviceId}`)} onClick={() => {
                    if (window.confirm(t('panel.remote.revokeConfirm', { name: computer.name || t('panel.remote.unknownComputer') }))) {
                      void act(`revoke:${computer.deviceId}`, () => remoteComputers.revoke(computer.deviceId), 'panel.remote.revoked')
                    }
                  }}><TrashIcon /></Button>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open && !dialogBusy) { setDialog(null); setInvitation(null) } }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t(dialog === 'invite' ? 'panel.remote.createInvite' : 'panel.remote.add')}</DialogTitle></DialogHeader>
          <DialogBody className="flex flex-col gap-3">
            {dialog === 'invite' || dialog === 'add' ? (
              <p className="text-xs leading-5 text-foreground-muted">{t(dialog === 'invite' ? 'panel.remote.inviteHint' : 'panel.remote.addHint')}</p>
            ) : null}
            {dialog === 'invite' ? (
              invitation ? (
                <>
                  <Field>
                    <FieldLabel htmlFor="remote-computer-invite">{t('panel.remote.inviteLabel')}</FieldLabel>
                    <Textarea id="remote-computer-invite" rows={4} readOnly value={invitation.invite} onFocus={(event) => event.target.select()} />
                  </Field>
                  <p className="text-xs text-foreground-muted">{t(inviteExpired ? 'panel.remote.inviteExpired' : 'panel.remote.inviteRemaining', { minutes: Math.max(0, Math.ceil((invitation.expiresAt - now) / 60_000)) })}</p>
                  {manualCopy ? <p role="status" className="text-xs text-foreground-muted">{t('panel.remote.manualCopy')}</p> : null}
                </>
              ) : dialogBusy ? <Spinner /> : null
            ) : (
              <Field>
                <FieldLabel htmlFor="remote-computer-add">{t('panel.remote.inviteLabel')}</FieldLabel>
                <Textarea id="remote-computer-add" rows={4} value={inviteText} onChange={(event) => setInviteText(event.target.value)} autoComplete="off" spellCheck={false} />
              </Field>
            )}
          </DialogBody>
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="outline" disabled={dialogBusy} onClick={() => { setDialog(null); setInvitation(null) }}>{t('panel.common.close')}</Button>
            {dialog === 'invite' ? (
              <Button variant="primary" disabled={dialogBusy || !invitation || inviteExpired} onClick={() => void copyInvite()}>{t('panel.remote.copy')}</Button>
            ) : (
              <Button variant="primary" disabled={dialogBusy || !inviteText.trim()} onClick={() => void act('add', async () => {
                await remoteComputers.add(inviteText.trim())
                setInviteText('')
                setDialog(null)
              }, 'panel.remote.added')}>{t('panel.remote.add')}</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={modeDevice !== null} onOpenChange={(open) => { if (!open && !modeBusy) { setModeDevice(null); setDiagnoseRoutes(null) } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t('panel.remote.route')}</DialogTitle></DialogHeader>
          <DialogBody className="flex flex-col gap-3 text-sm">
            <p className="text-xs leading-5 text-foreground-muted">{t('panel.remote.routeHint')}</p>
            {modeDevice?.attached ? <p className="text-xs leading-5 text-foreground-muted">{t('panel.remote.routeReopenNote')}</p> : null}
            <RadioGroup className="flex flex-col gap-2" value={mode} onValueChange={(next) => { if (typeof next === 'string') setMode(next) }}>
              {remoteModes(modeDevice?.routes ?? []).map((channel) => {
                const sampleUrl = (modeDevice?.routes ?? []).find((route) => route.channel === channel)?.url
                return (
                  <label key={channel} className="flex cursor-pointer items-center gap-2"><Radio value={channel} /><span>{channelText(channel, sampleUrl)}</span></label>
                )
              })}
            </RadioGroup>
            <div className="border-t border-border-muted pt-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-foreground-muted">{t('panel.remote.diagnoseHint')}</span>
                <Button variant="ghost" size="sm" className="px-2 text-xs" disabled={diagnosing} onClick={() => { if (modeDevice) void diagnose(modeDevice) }}>
                  {t('panel.remote.diagnose')}
                </Button>
              </div>
              {diagnosing ? <Spinner /> : null}
              {diagnoseRoutes ? (
                <ul className="mt-1 flex flex-col gap-1">
                  {diagnoseRoutes.map((route) => (
                    <li key={`${route.channel}:${route.url}`} className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate">{channelText(route.channel, route.url)} · {endpointText(route.url)}</span>
                      <span className="shrink-0 whitespace-nowrap text-foreground-muted">
                        {route.ok ? t('panel.remote.diagnoseOk') : t('panel.remote.diagnoseFail')}
                        {route.ok && route.latencyMs !== null ? ` · ${route.latencyMs} ms` : ''}
                        {!route.ok && route.errorCode ? ` · ${remoteErrorText(route.errorCode)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </DialogBody>
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="outline" disabled={modeBusy} onClick={() => setModeDevice(null)}>{t('panel.common.cancel')}</Button>
            <Button variant="primary" disabled={modeBusy || !remoteModes(modeDevice?.routes ?? []).includes(mode)} onClick={() => {
              if (modeDevice) void act(`mode:${modeDevice.id}`, async () => {
                await remoteComputers.mode(modeDevice.id, mode)
                setModeDevice(null)
              }, 'panel.remote.modeSaved')
            }}>{t('panel.common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </Card>
    </>
  )
}

/** 远程电脑：本机生成绑定信息、添加电脑和管理一小时浏览器访问。 */
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@appica/ui-react/dialog'
import { Field, FieldLabel } from '@appica/ui-react/field'
import { Radio } from '@appica/ui-react/radio'
import { RadioGroup } from '@appica/ui-react/radio-group'
import { Spinner } from '@appica/ui-react/spinner'
import { Textarea } from '@appica/ui-react/textarea'
import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError } from '../lib/api.ts'
import { pageVisible } from '../lib/embed-visibility.ts'
import { t } from '../lib/i18n/index.ts'
import { useNotify } from '../lib/notify.ts'
import {
  openRemoteComputer,
  remoteComputers,
  remoteErrorText,
  remoteLease,
  remoteModes,
  type RemoteComputer,
  type RemoteComputerInvite,
  type RemoteComputerList,
} from '../lib/remote-computers.ts'

function channelText(channel: string | null): string {
  const keys: Record<string, string> = {
    auto: 'auto', lan: 'lan', direct: 'direct', ipv6: 'ipv6', relay: 'relay', tunnel: 'tailcat', tailcat: 'tailcat', p2p: 'p2p',
  }
  if (!channel) return t('panel.common.none')
  return keys[channel] ? t(`panel.remote.channel.${keys[channel]}`) : channel
}

export function RemoteComputersCard() {
  const notify = useNotify()
  const [list, setList] = useState<RemoteComputerList | null>(null)
  const [settled, setSettled] = useState(false)
  const [localOnly, setLocalOnly] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState('')
  const [dialog, setDialog] = useState<'invite' | 'add' | null>(null)
  const [invitation, setInvitation] = useState<RemoteComputerInvite | null>(null)
  const [inviteText, setInviteText] = useState('')
  const [manualCopy, setManualCopy] = useState(false)
  const [modeDevice, setModeDevice] = useState<RemoteComputer | null>(null)
  const [mode, setMode] = useState('auto')
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

  async function act(key: string, work: () => Promise<unknown>, done?: string) {
    if (busy) return
    setBusy(key)
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
      setBusy('')
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
    void act(`open:${device.id}`, () => openRemoteComputer(device.id))
  }

  function renew(device: RemoteComputer) {
    if (!remoteLease(device, Date.now() + clockOffset.current).active) return
    void act(`renew:${device.id}`, () => remoteComputers.renew(device.id), 'panel.remote.renewed')
  }

  function remove(device: RemoteComputer) {
    if (!window.confirm(t('panel.remote.removeConfirm', { name: device.name || device.instanceId }))) return
    void act(`remove:${device.id}`, () => remoteComputers.remove(device.id), 'panel.remote.removed')
  }

  const disabled = busy !== ''
  const devices = list?.devices ?? []
  const authorizedComputers = list?.authorizedComputers ?? []
  const available = settled && !localOnly && list !== null
  const inviteExpired = invitation !== null && invitation.expiresAt <= now

  return (
    <Card frame="solid">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <span className="flex items-center gap-2">
            {t('panel.remote.title')}
            {devices.length > 0 ? <Badge variant="secondary" size="sm">{devices.length}</Badge> : null}
          </span>
        </CardTitle>
      </CardHeader>
      <p className="text-xs leading-5 text-foreground-muted">{t('panel.remote.hint')}</p>
      {!settled ? (
        <div className="flex items-center gap-2 py-2 text-sm text-foreground-muted">
          <Spinner />{t('panel.shell.readingStatus')}
        </div>
      ) : null}
      {localOnly ? <p className="mt-2 text-sm text-foreground-muted">{t('panel.remote.localOnly')}</p> : null}
      {loadError ? <p className="mt-2 text-xs text-error">{loadError}</p> : null}
      {available ? (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={disabled} onClick={generateInvite}>
              {t('panel.remote.createInvite')}
            </Button>
            <Button variant="outline" size="sm" disabled={disabled} onClick={() => { setInviteText(''); setDialog('add') }}>
              {t('panel.remote.add')}
            </Button>
          </div>
          {devices.length === 0 ? <p className="mt-3 text-xs text-foreground-muted">{t('panel.remote.empty')}</p> : null}
          <div className="mt-1">
            {devices.map((device) => {
              const lease = remoteLease(device, now)
              const expiresAt = device.expiresAt ?? 0
              const expired = device.state === 'expired' || (expiresAt > 0 && expiresAt <= now)
              const state = device.state === 'revoked' ? 'revoked' : expired ? 'expired' : device.state
              return (
                <div key={device.id} className="flex flex-col gap-2 border-b border-border-muted py-3 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate text-sm text-foreground-strong">{device.name || device.instanceId}</span>
                    <Badge variant="secondary" size="xs">{t(`panel.remote.state.${state}`)}</Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground-muted">
                    <span>{channelText(device.mode)}</span>
                    <span>· {channelText(device.channel)}</span>
                    {device.latencyMs !== null && Number.isFinite(device.latencyMs)
                      ? <span>· {Math.round(device.latencyMs)} ms</span> : null}
                    {lease.active ? <span>· {t('panel.remote.remaining', { minutes: Math.ceil(lease.remainingMs / 60_000) })}</span> : null}
                  </div>
                  {device.url ? <p className="font-mono text-xs break-all text-foreground-muted">{device.url}</p> : null}
                  {lease.warning ? <p role="status" className="text-xs text-foreground-muted">{t('panel.remote.expiring')}</p> : null}
                  {expired && device.state !== 'revoked'
                    ? <p className="text-xs text-foreground-muted">{t('panel.remote.expiredHint')}</p> : null}
                  {device.lastError || device.lastErrorCode ? <p className="text-xs break-all text-error">{remoteErrorText(device.lastErrorCode)}</p> : null}
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="outline" size="sm" disabled={disabled || device.state === 'revoked'} onClick={() => open(device)}>
                      {t(expired ? 'panel.remote.reopen' : 'panel.remote.open')}
                    </Button>
                    {lease.active ? (
                      <>
                        <Button variant="outline" size="sm" disabled={disabled} onClick={() => renew(device)}>{t('panel.remote.renew')}</Button>
                        <Button variant="outline" size="sm" disabled={disabled} onClick={() => void act(`stop:${device.id}`, () => remoteComputers.stop(device.id), 'panel.remote.stopped')}>
                          {t('panel.remote.stop')}
                        </Button>
                      </>
                    ) : null}
                    <Button variant="outline" size="sm" disabled={disabled} onClick={() => { setMode(device.mode); setModeDevice(device) }}>
                      {t('panel.remote.route')}
                    </Button>
                    <Button variant="outline" size="sm" disabled={disabled} onClick={() => void act(`probe:${device.id}`, () => remoteComputers.probe(device.id), 'panel.remote.probed')}>
                      {t('panel.remote.probe')}
                    </Button>
                    <Button variant="outline" size="sm" disabled={disabled} onClick={() => remove(device)}>{t('panel.remote.remove')}</Button>
                    {busy.endsWith(`:${device.id}`) ? <Spinner /> : null}
                  </div>
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
                    {computer.platform ? <p className="mt-1 text-xs text-foreground-muted">{computer.platform}</p> : null}
                  </div>
                  <Button variant="outline" size="sm" disabled={disabled} onClick={() => {
                    if (window.confirm(t('panel.remote.revokeConfirm', { name: computer.name || t('panel.remote.unknownComputer') }))) {
                      void act(`revoke:${computer.deviceId}`, () => remoteComputers.revoke(computer.deviceId), 'panel.remote.revoked')
                    }
                  }}>{t('panel.remote.revoke')}</Button>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open && !disabled) { setDialog(null); setInvitation(null) } }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t(dialog === 'invite' ? 'panel.remote.createInvite' : 'panel.remote.add')}</DialogTitle></DialogHeader>
          <DialogBody className="flex flex-col gap-3">
            <p className="text-xs leading-5 text-foreground-muted">{t(dialog === 'invite' ? 'panel.remote.inviteHint' : 'panel.remote.addHint')}</p>
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
              ) : disabled ? <Spinner /> : null
            ) : (
              <Field>
                <FieldLabel htmlFor="remote-computer-add">{t('panel.remote.inviteLabel')}</FieldLabel>
                <Textarea id="remote-computer-add" rows={4} value={inviteText} onChange={(event) => setInviteText(event.target.value)} autoComplete="off" spellCheck={false} />
              </Field>
            )}
          </DialogBody>
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="outline" disabled={disabled} onClick={() => { setDialog(null); setInvitation(null) }}>{t('panel.common.close')}</Button>
            {dialog === 'invite' ? (
              <Button variant="primary" disabled={disabled || !invitation || inviteExpired} onClick={() => void copyInvite()}>{t('panel.remote.copy')}</Button>
            ) : (
              <Button variant="primary" disabled={disabled || !inviteText.trim()} onClick={() => void act('add', async () => {
                await remoteComputers.add(inviteText.trim())
                setInviteText('')
                setDialog(null)
              }, 'panel.remote.added')}>{t('panel.remote.add')}</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={modeDevice !== null} onOpenChange={(open) => { if (!open && !disabled) setModeDevice(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t('panel.remote.route')}</DialogTitle></DialogHeader>
          <DialogBody className="flex flex-col gap-3 text-sm">
            <p className="text-xs leading-5 text-foreground-muted">{t('panel.remote.routeHint')}</p>
            <RadioGroup className="flex flex-col gap-2" value={mode} onValueChange={(next) => { if (typeof next === 'string') setMode(next) }}>
              {remoteModes(modeDevice?.routes ?? []).map((channel) => (
                <label key={channel} className="flex cursor-pointer items-center gap-2"><Radio value={channel} /><span>{channelText(channel)}</span></label>
              ))}
            </RadioGroup>
          </DialogBody>
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="outline" disabled={disabled} onClick={() => setModeDevice(null)}>{t('panel.common.cancel')}</Button>
            <Button variant="primary" disabled={disabled || !remoteModes(modeDevice?.routes ?? []).includes(mode)} onClick={() => {
              if (modeDevice) void act(`mode:${modeDevice.id}`, async () => {
                await remoteComputers.mode(modeDevice.id, mode)
                setModeDevice(null)
              }, 'panel.remote.modeSaved')
            }}>{t('panel.common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

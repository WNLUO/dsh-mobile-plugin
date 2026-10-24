/**
 * 「已绑定的设备」卡片：谁被这台机器放进来过、最近一次什么时候来的、走哪条路、能不能踢。
 *
 * ## 为什么这张卡要自己轮询
 *
 * 别的卡片读的都是页面已经拿到的 `/api/relay/status`，而设备清单是另一条路由
 * （`/api/relay/devices`）：一台手机刚连上来、刚从局域网切到中转，`status` 里没有任何字段
 * 会变，只有这条路由会变。所以它自己按 3 秒一轮拉一次，节奏与页面上那份状态一致；
 * 页面切到后台就停，别让一个看不见的标签页一直在问宿主。
 *
 * ## 为什么整卡会消失
 *
 * 一台设备都没有时不摆空卡：这张卡回答的是「有哪些设备」，空的时候它只占掉左栏一屏。
 * 老宿主没有这条路由（404）时同样不摆 —— 那时该说的是「更新插件」，但那句提示已经有
 * 更新卡在讲，再摆一张空卡只是重复。
 *
 * ## 吊销文案为什么必须分两种
 *
 * `legacy` 为真的设备名下还有不带设备密钥的旧记录：那种凭据里没有设备身份，单台吊销
 * 只清掉本机这一份，**旧通行证在到期前仍然能用来连**。所以那一行的确认框不能说
 * 「立即失效」—— 说了就是骗人。要立即失效只有「吊销全部设备授权」（配对卡右下角那颗），
 * 它连中转侧一起清。这条文案是硬要求，别为了统一样式合并成一句。
 */
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@appica/ui-react/alert-dialog'
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card'
import { Spinner } from '@appica/ui-react/spinner'
import { useCallback, useEffect, useState } from 'react'

import { apiGet, apiPost, errorText, type DeviceList, type DeviceRevokeResult, type RelayDevice } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'
import { Dot } from './InfoRow.tsx'
import { useNotify } from '../lib/notify.ts'

/** 多久没连过就不算在线了。 */
export const ONLINE_WINDOW_MS = 5 * 60 * 1000

/**
 * 毫秒时刻 → 「刚刚 / N 分钟前 / N 小时前 / N 天前」。
 *
 * `now` 一律由调用方给（用宿主回的 `serverNow`）：手机与宿主的时钟可能差得多，但这一页
 * 只关心「相对这台机器多久以前」，拿本机的 `Date.now()` 和宿主的时间戳相减反而是错的。
 */
export function relativeText(at: number, now: number): string {
  if (!at) return ''
  // 时钟回拨、或宿主的 `serverNow` 比记录还早时，别冒出「-3 分钟前」。
  const delta = Math.max(0, now - at)
  if (delta < 60_000) return t('panel.devices.justNow')
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) return t('panel.devices.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('panel.devices.hoursAgo', { count: hours })
  return t('panel.devices.daysAgo', { count: Math.floor(hours / 24) })
}

/** 最近连接那一格：0 是从没连过，5 分钟内算在线，其余走相对时间。 */
export function seenText(lastSeenAt: number, now: number): string {
  if (!lastSeenAt) return t('panel.devices.noRecord')
  if (isOnline(lastSeenAt, now)) return t('panel.devices.online')
  return relativeText(lastSeenAt, now)
}

export function isOnline(lastSeenAt: number, now: number): boolean {
  return lastSeenAt > 0 && now - lastSeenAt <= ONLINE_WINDOW_MS
}

/** 平台码 → 人说得出名字的那个系统。认不出的原样透出（宿主报什么就是什么）。 */
export function platformText(platform: string): string {
  const map: Record<string, string> = {
    ios: 'iOS',
    android: 'Android',
    linux: 'Linux',
    darwin: 'macOS',
    win32: 'Windows',
  }
  return map[platform] ?? (platform || t('panel.devices.unknownPlatform'))
}

/** 通道码 → 「经中转 / 局域网」。空串是宿主没记，给一个破折号而不是编一条路。 */
function channelText(channel: string): string {
  if (channel === 'relay') return t('panel.devices.channelRelay')
  if (channel === 'lan') return t('panel.devices.channelLan')
  return t('panel.devices.channelUnknown')
}

export function DevicesCard() {
  const notify = useNotify()
  const [list, setList] = useState<DeviceList | null>(null)
  /** 正在等确认的那台设备：null = 确认框关着。 */
  const [pending, setPending] = useState<RelayDevice | null>(null)
  const [revoking, setRevoking] = useState(false)

  const load = useCallback(async () => {
    try {
      setList(await apiGet<DeviceList>('/api/relay/devices'))
    } catch {
      // 老宿主没有这条路由，或者这一下打空了：留着上一次那份，别把行清空。
      // 从没取到过就一直是 null —— 整卡不摆。
    }
  }, [])

  // 3 秒一轮，页面切到后台就停（与 App 里那份状态的节奏一致）。
  useEffect(() => {
    const tick = () => {
      if (document.hidden) return
      void load()
    }
    tick()
    const timer = window.setInterval(tick, 3000)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [load])

  const devices = list?.devices ?? []
  const now = list?.serverNow ?? 0
  /** 设备名：空串是旧记录没存名字，不是「这台不存在」。 */
  const nameOf = (device: RelayDevice | null) => device?.name || t('panel.devices.unknown')

  async function revoke(device: RelayDevice) {
    setRevoking(true)
    try {
      const result = await apiPost<DeviceRevokeResult>('/api/relay/devices/revoke', { deviceId: device.deviceId })
      setPending(null)
      // 吊销之后立刻重拉：等下一轮 3 秒会让「点了没反应」多停留一会儿。
      await load()
      notify(
        'soft',
        t(result.closed > 0 ? 'panel.devices.unbindDoneClosed' : 'panel.devices.unbindDone', {
          name: nameOf(device),
          count: result.revoked,
          closed: result.closed,
        }),
      )
    } catch (error) {
      notify('error', t('panel.devices.unbindFailed', { message: errorText(error) }))
    } finally {
      setRevoking(false)
    }
  }

  // 没有设备（或还没读到）：整卡不摆。见文件头「为什么整卡会消失」。
  if (devices.length === 0) return null

  return (
    <Card frame="solid">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span>{t('panel.devices.title')}</span>
          <Badge variant="secondary" size="sm">
            {devices.length}
          </Badge>
        </CardTitle>
      </CardHeader>

      <div className="mt-1">
        {devices.map((device) => {
          const online = isOnline(device.lastSeenAt, now)
          return (
            <div
              key={device.deviceId}
              className="flex items-start justify-between gap-3 border-b border-border-muted py-3 last:border-b-0"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm text-foreground-strong">{nameOf(device)}</span>
                  {/* 旧式：这台名下有不带设备密钥的记录，吊销文案与别的行不一样（见文件头）。 */}
                  {device.legacy ? (
                    <Badge variant="warning" size="xs">
                      {t('panel.devices.legacy')}
                    </Badge>
                  ) : null}
                  <span className="text-xs text-foreground-muted">
                    {platformText(device.platform)}
                    {device.osVersion ? ` ${device.osVersion}` : ''}
                    {device.appVersion ? t('panel.devices.appVersion', { version: device.appVersion }) : ''}
                  </span>
                </div>

                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground-muted">
                  <span>{t('panel.devices.boundAt', { time: relativeText(device.boundAt, now) || '—' })}</span>
                  {/* 在线才带绿点；不在线就只报相对时间，别让一枚灰点在那儿装作状态。 */}
                  <span className="inline-flex items-center gap-1">
                    {online ? <Dot tone="ok" /> : null}
                    {seenText(device.lastSeenAt, now)}
                  </span>
                  <span>{channelText(device.lastChannel)}</span>
                  <span>{device.encrypted ? t('panel.devices.encrypted') : t('panel.devices.plain')}</span>
                </div>
              </div>

              <Button variant="outline" size="sm" onClick={() => setPending(device)}>
                {t('panel.devices.unbind')}
              </Button>
            </div>
          )
        })}
      </div>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          // 正在发请求时不许靠点遮罩 / Esc 关掉：关了一半再打开会看到两条文案混在一起。
          if (!open && !revoking) setPending(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('panel.devices.unbindTitle')}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogBody className="flex flex-col gap-2 text-sm">
            <AlertDialogDescription>
              {t('panel.devices.unbindConfirm', { name: nameOf(pending) })}
            </AlertDialogDescription>
            {/* 两句按 legacy 分叉：旧记录没有设备身份，单台吊销杀不掉那本旧通行证。 */}
            <p className="text-foreground-muted">
              {t(pending?.legacy ? 'panel.devices.effectLegacy' : 'panel.devices.effectIdentity')}
            </p>
          </AlertDialogBody>
          <AlertDialogFooter className="flex justify-end gap-2">
            <Button variant="outline" disabled={revoking} onClick={() => setPending(null)}>
              {t('panel.devices.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={revoking}
              onClick={() => {
                if (pending) void revoke(pending)
              }}
            >
              {revoking ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner />
                  {t('panel.devices.unbinding')}
                </span>
              ) : (
                t('panel.devices.unbind')
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

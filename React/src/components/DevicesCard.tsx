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
 * 判据是**活设备与历史同时为空**（`devices.length === 0 && revokedCount === 0`）：踢掉最后
 * 一台手机之后，那张卡还得在，否则「我上周从一台陌生设备上撤过权」这件事就永远看不见。
 * 老宿主没有这条路由（404）时同样不摆 —— 那时该说的是「更新插件」，但那句提示已经有
 * 更新卡在讲，再摆一张空卡只是重复。
 *
 * ## 吊销文案为什么必须分两种
 *
 * `legacy` 为真的设备名下还有不带设备密钥的旧记录：那种凭据里没有设备身份，单台吊销
 * 只清掉本机这一份，**旧通行证在到期前仍然能用来连**。所以那一行的确认框不能说
 * 「立即失效」—— 说了就是骗人。要立即失效只有「吊销全部设备授权」（卡片标题行右侧那颗），
 * 它连中转侧一起清。这条文案是硬要求，别为了统一样式合并成一句。
 *
 * ## 历史为什么是折叠的、而且收起时不问宿主
 *
 * 「我上周是不是从一台陌生设备上撤过权」是偶发的一问，不是每秒都在变的活数据。所以它默认
 * 收起，**展开那一下才打一发** `/api/relay/devices?history=1`，收起时一个请求都不发；也不
 * 给它单开一个 interval —— 历史只在吊销的那一瞬间变，而那次吊销本来就会重拉设备清单、把
 * 折叠行上的台数刷新掉。展开中的那份列表停在打开那一刻，用户收起再打开就自然更新。
 *
 * 整卡不消失的判据因此也跟着变了：踢掉最后一台手机之后，那条记录正是这一段要回答的事。
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
import { Radio } from '@appica/ui-react/radio'
import { RadioGroup } from '@appica/ui-react/radio-group'
import { Spinner } from '@appica/ui-react/spinner'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  apiGet,
  apiPost,
  errorText,
  tierOfPermissions,
  updateDevicePermission,
  type DeviceHistoryList,
  type DeviceList,
  type DeviceRevokeResult,
  type RelayDevice,
  type RelayHistoryDevice,
  type Tier,
  type TierView,
} from '../lib/api.ts'
import { pageVisible } from '../lib/embed-visibility.ts'
import { t } from '../lib/i18n/index.ts'
import { Dot } from './InfoRow.tsx'
import { tierLabel, TIER_OPTIONS } from './PairingCard.tsx'
import { useNotify } from '../lib/notify.ts'

/**
 * 档位（或展示态）→ 这一行上摆的文案。
 *
 * `'none'` 是这台设备拿到的是**显式空数组**（连 view 都没有），跟「只读」不是一回事，
 * 所以说「什么都不允许」而不是「只读」。它只出现在显示处：改档对话框永远只列三档。
 */
function tierViewLabel(tier: TierView): string {
  return tier === 'none' ? t('panel.devices.tierNone') : tierLabel(tier)
}

/**
 * 改档对话框里预选哪一档。
 *
 * 对话框只有三档（服务端也只认三档）：设备现在是「什么都不允许」时预选最窄的那一档，
 * 别预选全权 —— 那样一按「应用」就等于凭空提权。
 */
function tierForDialog(tier: TierView): Tier {
  return tier === 'none' ? 'readonly' : tier
}

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

/**
 * 历史保留多久：与宿主 `HISTORY_RETENTION_MS`（凭据库的 30 天清理窗口）是同一个数。
 *
 * 这里写死的是**天数**而不是那串毫秒：这句话只是告诉人「翻不到更早的」，不该跟着宿主
 * 的清理实现走。宿主那个窗口变了，这个数跟着改，别让它悄悄说成 29 或 31 天。
 */
export const HISTORY_RETENTION_DAYS = 30

/** 一行设备的标题要用的那几格：活设备与历史行都有，别的字段不掺进来。 */
type NameParts = {
  model?: string
  name?: string
  suffix?: string
}

/**
 * 一行设备的标题：机型 → 名字 → 「未知设备」。
 *
 * **机型排在前面**：它是手机自己报的，稳定且说得清是哪种机器；名字那一格的历史要乱得多
 * ——它来自 App 里给**这台电脑**起的备注（`session.name`），被当成手机自己的名字写了进来，
 * 于是书房那台 Mac 的面板上会出现一台叫「书房的 Mac」的手机。所以只在机型还空着时
 * 才拿名字兜底（这一格出生之前配的老记录就是这种）。
 *
 * 撞名时宿主会配一个序号（`device.suffix`）——早绑的是 1 ——不再拿 `deviceId` 后几位当
 * 尾巴：那串机器号人认不出来，也没法和手上的手机对上号。
 *
 * 只收 `model` / `name` / `suffix` 三格而不是整个设备：活设备与历史行都摆这一行标题，
 * 判据只能有一份，两个类型各写一遍迟早会分叉。历史行没有序号（已解绑的那些不再互相撞名）。
 */
function nameOf(device: NameParts | null): string {
  const title = device?.model || device?.name || t('panel.devices.unknown')
  return device?.suffix ? `${title} · ${device.suffix}` : title
}

type Props = {
  /**
   * 「吊销全部设备授权」：连中转侧一起清，是 `legacy` 那些旧通行证唯一能立刻作废的入口。
   * 它本来挂在配对卡右下角，2026-11-02 用户要求挪到这张卡的标题行右侧 —— 它作用的对象
   * 就是这张卡里这些人。
   */
  onRevokeAll: () => void
  /** 有动作在飞（与页面其他地方共用同一份 busy）。 */
  busy: string
}

export function DevicesCard({ onRevokeAll, busy }: Props) {
  const notify = useNotify()
  const [list, setList] = useState<DeviceList | null>(null)
  /** 正在等确认的那台设备：null = 确认框关着。 */
  const [pending, setPending] = useState<RelayDevice | null>(null)
  const [revoking, setRevoking] = useState(false)
  /** 正在调权限的那台设备：null = 权限框关着。 */
  const [permPending, setPermPending] = useState<RelayDevice | null>(null)
  /** 权限框里临时选中的档位（还没提交）。 */
  const [permTier, setPermTier] = useState<Tier>('full')
  const [savingPerm, setSavingPerm] = useState(false)

  /**
   * 展开态与上一次看到的台数。
   *
   * 轮询那一发（`load`）的闭包读不到当下这两个值，而把 `historyOpen` 放进它的依赖数组就等于
   * 每展开 / 收起一次都重建轮询、重起 interval。所以走 ref：它只回答「现在展开着吗、台数跟
   * 上一发比变了没有」，不进任何依赖数组。`null` = 还没取到过，第一发只记基线不比对。
   */
  const historyOpenRef = useRef(false)
  const revokedCountRef = useRef<number | null>(null)

  /**
   * 折叠着的「历史 · 已解绑」。
   *
   * `history === null` 且 `historyOpen` 为真 = 那一发还在路上；`historyError` 只让折叠行
   * 下面多一句「读不到历史」，卡片其余部分照常。
   */
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<DeviceHistoryList | null>(null)
  const [historyError, setHistoryError] = useState(false)

  /** 最近一次历史请求的序号：晚到的旧回答不许盖掉新的那一份。 */
  const historySeq = useRef(0)

  /**
   * 取一次历史。**三个调用点**：展开那一下、本卡片吊销成功之后、轮询发现台数变了的时候。
   *
   * 不挂 interval：历史只在台数变的那一瞬间变。台数有两条路会自己变 —— 本卡片里踢掉一台
   * （`revoke` 当场补发，否则折叠行写着 1 台、下面却空着），和别处点的「吊销全部设备授权」
   * （走 App，本卡片看不到那一下，只能在 `load` 里按台数变化发现）。
   */
  const loadHistory = useCallback(async () => {
    const seq = ++historySeq.current
    setHistoryError(false)
    try {
      const next = await apiGet<DeviceHistoryList>('/api/relay/devices?history=1')
      if (seq === historySeq.current) setHistory(next)
    } catch {
      // 老宿主没有这个分支：说一句「读不到历史」就够了，别把整张卡变成错误态。
      if (seq === historySeq.current) setHistoryError(true)
    }
  }, [])

  const load = useCallback(async () => {
    try {
      const next = await apiGet<DeviceList>('/api/relay/devices')
      const nextCount = next.revokedCount ?? 0
      const changed = revokedCountRef.current !== null && revokedCountRef.current !== nextCount
      revokedCountRef.current = nextCount
      setList(next)
      // 台数变了、而这一块正展开着：折叠行说的是新台数，下面那份列表还停在打开那一刻，
      // 两边会一直对不上（写着 6 台、摊开 3 行）。补一发把两边拉齐，别等用户收起再展开。
      // 「吊销全部」走的是 App，本卡片看不到那一下，只能在这儿发现；自然到期与保留窗口
      // 清理也顺带覆盖到。台数没变就不补 —— 否则每 3 秒白打一发。
      if (changed && historyOpenRef.current) void loadHistory()
    } catch {
      // 老宿主没有这条路由，或者这一下打空了：留着上一次那份，别把行清空。
      // 从没取到过就一直是 null —— 整卡不摆。
    }
  }, [loadHistory])

  // 3 秒一轮，页面切到后台就停（与 App 里那份状态的节奏一致）。
  useEffect(() => {
    const tick = () => {
      if (!pageVisible()) return
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
  /** 历史里有几台；老宿主没有这一格。 */
  const revokedCount = list?.revokedCount ?? 0

  // 展开态给 ref 留一份：轮询那一发读它（见上面 `historyOpenRef` 的注释）。
  useEffect(() => {
    historyOpenRef.current = historyOpen
  }, [historyOpen])

  /**
   * 展开才取一次。收起时不发请求，也不清掉已经拿到的结果：再展开先看到上次那份，同时补一发新的。
   */
  useEffect(() => {
    if (!historyOpen) return
    void loadHistory()
  }, [historyOpen, loadHistory])

  /** 历史那一行的结局：吊销与自然过期是两件事，绝不合并成一句。 */
  function endingText(device: RelayHistoryDevice): string {
    const time = relativeText(device.revokedAt || device.expiresAt, now) || '—'
    return t(device.kind === 'revoked' ? 'panel.devices.historyRevoked' : 'panel.devices.historyExpired', { time })
  }

  /**
   * 只认带结局的行。
   *
   * 老宿主没有 `?history=1` 这个分支：它会把这一发当普通设备清单答掉，回来的正是**活着的
   * 手机**。那些行没有 `kind`，照渲染就会把正在连着的设备列进「已解绑」里 —— 比不显示更糟。
   * 整份都对不上时按「读不到历史」处理，宁可说一句读不到，也不摆一份看着像历史的活设备清单。
   */
  const historyRows = (history?.devices ?? []).filter(
    (device) => device.kind === 'revoked' || device.kind === 'expired',
  )
  const historyUnreadable = historyError || ((history?.devices.length ?? 0) > 0 && historyRows.length === 0)

  async function revoke(device: RelayDevice) {
    setRevoking(true)
    try {
      const result = await apiPost<DeviceRevokeResult>('/api/relay/devices/revoke', { deviceId: device.deviceId })
      setPending(null)
      // 吊销之后立刻重拉：等下一轮 3 秒会让「点了没反应」多停留一会儿。
      await load()
      // 展开着就把历史也补上：否则台数变了、列表还停在打开那一刻那份（少一条，甚至空着）。
      if (historyOpen) void loadHistory()
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

  /** 提交权限档位：成功后立刻重拉（别等下一轮 3 秒），并把结果说清楚。 */
  async function savePermissions(device: RelayDevice, tier: Tier) {
    setSavingPerm(true)
    try {
      await updateDevicePermission(device.deviceId, tier)
      setPermPending(null)
      await load()
      notify('soft', t('panel.devices.permissionsDone', { name: nameOf(device), tier: tierLabel(tier) }))
    } catch (error) {
      notify('error', t('panel.devices.permissionsFailed', { message: errorText(error) }))
    } finally {
      setSavingPerm(false)
    }
  }

  // 一台活设备都没有、历史里也空着（或还没读到）：整卡不摆。见文件头「为什么整卡会消失」。
  // 只要历史里有记录就得摆：踢掉最后一台手机之后，那条记录正是这一段要回答的事。
  if (devices.length === 0 && revokedCount === 0) return null

  return (
    <Card frame="solid">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <span className="flex items-center gap-2">
            {t('panel.devices.title')}
            {/* 台数只数活着的那些。一台都不剩时这一格不画：标题写着「已绑定的设备」、
                旁边挂个 0，底下却还摆着一串已解绑的记录，那个组合自相矛盾。历史有几台
                由下面的折叠行自己说。 */}
            {devices.length > 0 ? (
              <Badge variant="secondary" size="sm">
                {devices.length}
              </Badge>
            ) : null}
          </span>
          <Button variant="outline" size="sm" disabled={busy !== ''} onClick={onRevokeAll}>
            {t('panel.pairing.revokeAll')}
          </Button>
        </CardTitle>
      </CardHeader>

      <div className="mt-1">
        {devices.map((device) => {
          const online = isOnline(device.lastSeenAt, now)
          return (
            <div
              key={device.deviceId}
              className="flex flex-col gap-2 border-b border-border-muted py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
            >
              {/*
                两行就说完，不再堆四项：第一行是机型 + 档位 + 平台；第二行是「什么时候、走的哪条路」。
                **绑定时间与加密状态不摆**（2026-11-13 用户嫌挤）：绑定时刻是这台设备的历史，
                真要查在「历史」里；加密与否对「这台手机还能不能用」没有影响。它们仍在数据里，
                只是不再占这一行 —— 别为了「信息齐全」把它们加回来。
              */}
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="truncate text-sm text-foreground-strong">{nameOf(device)}</span>
                  {/* 旧式：这台名下有不带设备密钥的记录，吊销文案与别的行不一样（见文件头）。 */}
                  {device.legacy ? (
                    <Badge variant="warning" size="xs">
                      {t('panel.devices.legacy')}
                    </Badge>
                  ) : null}
                  {/* 同一台手机重配过几次就会有好几条活凭据：不摆出来，人只在解除绑定那一下
                      看到「2 条凭据」，之前一直以为只有一份。 */}
                  {device.bindings > 1 ? (
                    <Badge variant="secondary" size="xs">
                      {t('panel.devices.extraBindings', { count: device.bindings - 1 })}
                    </Badge>
                  ) : null}
                  {/* 这台设备当前的权限档位：由实际权限位反推，不是另存一份档位。
                      老凭据（permissions 为 null）就是全权；显式空数组是「什么都不允许」。 */}
                  <Badge variant="secondary" size="xs">
                    {tierViewLabel(tierOfPermissions(device.permissions))}
                  </Badge>
                </div>

                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground-muted">
                  <span>
                    {platformText(device.platform)}
                    {device.osVersion ? ` ${device.osVersion}` : ''}
                  </span>
                  {/* 在线才带绿点；不在线就只报相对时间，别让一枚灰点在那儿装作状态。 */}
                  <span className="inline-flex items-center gap-1">
                    <span aria-hidden>·</span>
                    {online ? <Dot tone="ok" /> : null}
                    {seenText(device.lastSeenAt, now)}
                  </span>
                  <span>· {channelText(device.lastChannel)}</span>
                  <span>· {device.encrypted ? t('panel.devices.encrypted') : t('panel.devices.plain')}</span>
                </div>
              </div>

              {/*
                两颗按钮**另起一行靠右**，不跟设备名挤在同一行：窄窗里设备名一长，
                原来那一排按钮会把名字压成省略号，而按钮本身也挤成一坨。
                宽屏时它们仍然回到右侧同一行（`sm:` 起），窄屏在下面自成一行。
              */}
              <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setPermTier(tierForDialog(tierOfPermissions(device.permissions)))
                    setPermPending(device)
                  }}
                >
                  {t('panel.devices.permissions')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setPending(device)}>
                  {t('panel.devices.unbind')}
                </Button>
              </div>
            </div>
          )
        })}
      </div>

      {/* 历史 · 已解绑：次要信息，摆在这张卡最下面、默认收起，字号与颜色跟主列表第二行同一档。
          它是「谁连过、后来怎么没的」，不是当前设备，所以行上没有按钮。 */}
      <div className="mt-1 border-t border-border-muted pt-2">
        <button
          type="button"
          aria-expanded={historyOpen}
          className="flex w-full cursor-pointer items-center justify-between gap-2 text-xs text-foreground-muted focus-visible:outline-none"
          onClick={() => setHistoryOpen((open) => !open)}
        >
          <span className="flex items-center gap-2">
            {t('panel.devices.historyTitle')}
            <Badge variant="secondary" size="xs">
              {t('panel.devices.historyCount', { count: revokedCount })}
            </Badge>
          </span>
          {/* 箭头只表示「这边能点开」，跟着展开状态转 90 度。 */}
          <svg
            viewBox="0 0 12 12"
            className={`size-3 shrink-0 transition-transform ${historyOpen ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m4.5 2.5 3.5 3.5-3.5 3.5" />
          </svg>
        </button>

        {historyOpen ? (
          <div className="mt-2">
            {historyRows.map((device) => (
              <div key={device.deviceId} className="flex flex-col gap-1 py-2">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {/* 比上面那些活设备行低一档：这一段的标题是 text-xs + 常规前景色，
                      不跟主列表抢注意力。 */}
                  <span className="text-xs text-foreground">{nameOf(device)}</span>
                  {device.bindings > 1 ? (
                    <Badge variant="secondary" size="xs">
                      {t('panel.devices.extraBindings', { count: device.bindings - 1 })}
                    </Badge>
                  ) : null}
                  <span className="text-xs text-foreground-muted">
                    {platformText(device.platform)}
                    {device.osVersion ? ` ${device.osVersion}` : ''}
                    {device.appVersion ? t('panel.devices.appVersion', { version: device.appVersion }) : ''}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground-muted">
                  <span>{t('panel.devices.historyBoundAt', { time: relativeText(device.boundAt, now) || '—' })}</span>
                  {/* 从没连过就如实说「无记录」，别拿绑定时刻顶上。 */}
                  <span>
                    {t('panel.devices.historyLastSeen', {
                      time: device.lastSeenAt ? relativeText(device.lastSeenAt, now) : t('panel.devices.noRecord'),
                    })}
                  </span>
                  {/* 结局按 kind 分叉：一种是你亲手踢的，一种是自然到期，两种绝不合并成一句。 */}
                  <span>{endingText(device)}</span>
                </div>
              </div>
            ))}
            {/* 读不到（老宿主没有这个分支，或回来的不是历史）：一句安静的提示，卡片其余部分照常。 */}
            {historyUnreadable ? (
              <p className="py-2 text-xs text-foreground-muted">{t('panel.devices.historyFailed')}</p>
            ) : null}
            <p className="py-2 text-xs text-foreground-muted">
              {t('panel.devices.historyRetention', { days: HISTORY_RETENTION_DAYS })}
            </p>
          </div>
        ) : null}
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

      {/* 调权限：电脑侧给这台设备换档位（授予 / 提权 / 降权）。选中后按「应用」才提交，
          不会点一下就地改 —— 权限收放都留一次确认。 */}
      <AlertDialog
        open={permPending !== null}
        onOpenChange={(open) => {
          if (!open && !savingPerm) setPermPending(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('panel.devices.permissionsTitle')}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogBody className="flex flex-col gap-3 text-sm">
            <AlertDialogDescription>{t('panel.devices.permissionsHint')}</AlertDialogDescription>
            <RadioGroup
              className="flex flex-col gap-2"
              value={permTier}
              onValueChange={(next) => {
                if (typeof next === 'string') setPermTier(next as Tier)
              }}
            >
              {TIER_OPTIONS.map((tier) => (
                <label key={tier} className="flex cursor-pointer items-center gap-2">
                  <Radio value={tier} />
                  <span>{tierLabel(tier)}</span>
                </label>
              ))}
            </RadioGroup>
          </AlertDialogBody>
          <AlertDialogFooter className="flex justify-end gap-2">
            <Button variant="outline" disabled={savingPerm} onClick={() => setPermPending(null)}>
              {t('panel.devices.cancel')}
            </Button>
            <Button
              variant="secondary"
              disabled={savingPerm}
              onClick={() => {
                if (permPending) void savePermissions(permPending, permTier)
              }}
            >
              {savingPerm ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner />
                  {t('panel.devices.permissionsApply')}
                </span>
              ) : (
                t('panel.devices.permissionsApply')
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

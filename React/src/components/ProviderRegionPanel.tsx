// 2026-11-27：服务商线路专属面板——按标签展示 zeronews 账号概览或 Cloudflare 状态。
/**
 * 「中国 / 国际」标签下的专属面板（2026-11-27 用户要求）。
 *
 * 两块面板结构对齐：服务商身份 + 使用情况 + 控制台入口。内容分两类，绝不混：
 *   · 已用数量（设备 / 在线设备）与套餐名 —— 读宿主账号快照，是真实事实；
 *   · 套餐权益（带宽 / 设备名额 / 并发） —— 公开的套餐信息，写死在下方一处常量表，
 *     只按精确识别到的套餐显示，认不出就不显示，绝不拿免费数字套付费用户。
 * 流量已用量是云端数据、CLI 拿不到，只给额度与控制台入口，不编已用数字。
 *
 * 账号快照自己读一次（读宿主只读接口 `/api/relay/zeronews/account`），与配置页共用同一份
 * 接口与留底键。退出登录 / 彻底清理是破坏性动作，沿用配置页同款接口与二次确认文案。
 */
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { Card } from '@appica/ui-react/card'
import { useEffect, useState, type ReactNode } from 'react'

import {
  zeroNewsAccount, zeroNewsDisconnect, zeroNewsPurge,
  type StatusView, type ZeroNewsAccount,
} from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'
import { CloudflarePanel } from './CloudflarePanel.tsx'
import { CloudflareIcon, ZeroNewsIcon } from './ProviderIcons.tsx'

const ZN_CONSOLE_URL = 'https://user.zeronews.cc/'
const ZN_ACCOUNT_CACHE_KEY = 'dsh-mobile-plugin:zeronews-account'

/**
 * 各套餐权益（2026-11-27 核对官方定价页 https://zeronews.cc/pricing，当前三档：免费 / 个人 Pro / 个人 Pro+）。
 * 只列面板要用的四格：单隧道带宽、认证客户端数、单隧道并发、月流量额度。
 * 官方曾发升级公告说免费版 2Mbps / 2 条，当前定价页是 1Mbps / 1 条，以定价页为准；
 * 套餐权益若再变，只改这一处表。仅作套餐上限展示，不是实时用量。
 */
type Quota = { bandwidthMbps: number; devices: number; concurrency: number; trafficGb: number | null }
const ZN_QUOTAS: Record<'free' | 'pro' | 'proPlus', Quota> = {
  free: { bandwidthMbps: 1, devices: 1, concurrency: 5, trafficGb: 1 },
  pro: { bandwidthMbps: 5, devices: 4, concurrency: 30, trafficGb: null },
  proPlus: { bandwidthMbps: 10, devices: 8, concurrency: 50, trafficGb: null },
}

/**
 * 套餐名 → 权益档：官方原始名字没有实测样本（付费档可能中英文混用），只精确认三档，
 * 认不出返回 null —— 宁可少显示，也不给付费用户套错数字。中文用码点写，避免界面文件
 * 出现钉死的中文字面量触发 i18n 守卫。
 */
function quotaOf(planName: string): Quota | null {
  const free = '\u514d\u8d39'
  const pro = '\u4e2a\u4eba'
  const key = planName.trim().toLowerCase()
  if (key === free || key === 'free') return ZN_QUOTAS.free
  if (key === `${pro} pro` || key === 'pro') return ZN_QUOTAS.pro
  if (key === `${pro} pro+` || key === 'pro+') return ZN_QUOTAS.proPlus
  return null
}

function readZnCache(): ZeroNewsAccount | null {
  try {
    const raw = localStorage.getItem(ZN_ACCOUNT_CACHE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? (value as ZeroNewsAccount) : null
  } catch {
    return null
  }
}

/** 使用情况里的一格：大内容 + 小标签。 */
function Stat({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border-muted bg-background-muted px-3 py-2">
      <span className="text-lg font-semibold leading-none text-foreground-strong">{value}</span>
      <span className="text-xs text-foreground-muted">{label}</span>
    </div>
  )
}

/** 头部一行：图标 + 名字 + 副标题（可文字或套餐/账号），右侧可选带一条状态。 */
function ProviderHeading({ icon, name, subtitle, statusText }: {
  icon: ReactNode
  name: string
  subtitle?: ReactNode
  statusText?: string
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center">{icon}</span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm text-foreground-strong">{name}</span>
          {subtitle ? <div className="flex min-w-0 flex-wrap items-center gap-1.5">{subtitle}</div> : null}
        </span>
      </div>
      {statusText ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-success">
          <span className="size-1.5 rounded-full bg-success" />
          {statusText}
        </span>
      ) : null}
    </div>
  )
}

/** 底部一行：控制台入口 + 已接入时的断开 / 彻底清理。 */
function PanelActions({ connected, busy, onDisconnect, onPurge }: {
  connected: boolean
  busy: boolean
  onDisconnect: () => void
  onPurge: () => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <a
        href={ZN_CONSOLE_URL}
        target="_blank"
        rel="noreferrer"
        className="rounded px-2 py-1 text-xs text-foreground-muted underline transition-colors hover:text-foreground-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {t('panel.zeronews.console')}
      </a>
      {connected ? (
        <>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onDisconnect}>
            {t('panel.zeronews.linkDisconnect')}
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onPurge}>
            {t('panel.zeronews.purge')}
          </Button>
        </>
      ) : null}
    </div>
  )
}

function ChinaProviderPanel({ status }: { status: StatusView }) {
  /** 先用本地留底铺上，再悄悄刷一次；面板只读，不轮询。 */
  const [account, setAccount] = useState<ZeroNewsAccount | null>(() => readZnCache())
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  useEffect(() => {
    let active = true
    void zeroNewsAccount()
      .then((next) => {
        if (!active || !next || next.ok === false) return
        setAccount(next)
        try {
          if (next.login) localStorage.setItem(ZN_ACCOUNT_CACHE_KEY, JSON.stringify(next))
        } catch { /* 存不下不影响展示 */ }
      })
      .catch(() => { /* 读不到就保留留底 */ })
    return () => { active = false }
  }, [])

  const connected = status.zeroNews?.phase === 'connected'
  const devices = (account?.devices || []).length
  const online = (account?.devices || []).filter((device) => device.online).length
  const plan = account?.account?.planName || ''
  const identity = account?.account?.userTel || account?.account?.userId || ''
  const quota = quotaOf(plan)
  const statusText = connected
    ? t('panel.zeronews.linkOn', { url: status.zeroNews?.url || '' })
    : t('panel.providerRegion.notConnected')

  /** 断开：停客户端、撤域名；成功后重读账号让界面跟上。 */
  async function disconnect() {
    if (busy) return
    setBusy(true)
    setNote('')
    try {
      const res = await zeroNewsDisconnect()
      const error = typeof res.error === 'string' ? res.error : res.error?.message
      if (!res.ok && error) setNote(error)
      setAccount(await zeroNewsAccount())
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  /** 彻底清理：与断开分开的破坏性入口，沿用配置页的二次确认文案。 */
  async function purge() {
    if (busy || !window.confirm(t('panel.zeronews.purgeConfirm'))) return
    setBusy(true)
    setNote('')
    try {
      const res = await zeroNewsPurge()
      if (!res.ok && res.error) setNote(res.error)
      else {
        setNote(t('panel.zeronews.purgeDone'))
        setAccount(null)
        try { localStorage.removeItem(ZN_ACCOUNT_CACHE_KEY) } catch { /* 留底删不掉不影响清理本身 */ }
      }
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card frame="solid">
      <div className="flex flex-col gap-3 p-4">
        <ProviderHeading
          icon={<ZeroNewsIcon />}
          name={t('panel.provider.zeronews')}
          subtitle={(
            <>
              {plan ? <Badge variant="soft" size="sm">{plan}</Badge> : null}
              {identity ? <span className="truncate text-xs text-foreground-muted">{identity}</span> : null}
            </>
          )}
          statusText={statusText}
        />

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-foreground-strong">{t('panel.providerRegion.usage')}</span>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              value={quota ? t('panel.providerRegion.bandwidthValue', { bw: quota.bandwidthMbps }) : '—'}
              label={t('panel.providerRegion.bandwidth')}
            />
            <Stat
              value={quota ? `${devices} / ${quota.devices}` : devices}
              label={t('panel.zeronews.overview.devices')}
            />
            <Stat value={online} label={t('panel.zeronews.overview.online')} />
            <Stat
              value={quota ? quota.concurrency : '—'}
              label={t('panel.providerRegion.concurrency')}
            />
          </div>
          {quota ? (
            <p className="text-xs leading-5 text-foreground-muted">
              {quota.trafficGb !== null
                ? t('panel.providerRegion.quotaTraffic', { traffic: quota.trafficGb })
                : t('panel.providerRegion.quotaUnlimited')}
            </p>
          ) : null}
        </div>

        {note ? <p className="text-xs leading-5 text-foreground-muted">{note}</p> : null}

        <PanelActions connected={connected} busy={busy} onDisconnect={() => void disconnect()} onPurge={() => void purge()} />
      </div>
    </Card>
  )
}

function GlobalProviderPanel({ status }: { status: StatusView }) {
  return (
    <Card frame="solid">
      <div className="flex flex-col gap-3 p-4">
        <ProviderHeading
          icon={<CloudflareIcon />}
          name={t('panel.provider.cloudflare')}
          subtitle={<span className="text-xs text-foreground-muted">{t('panel.providerRegion.globalHint')}</span>}
        />
        <CloudflarePanel status={status} />
      </div>
    </Card>
  )
}

/** 按地区选面板：中国给 zeronews 概览，国际给 Cloudflare。 */
export function ProviderRegionPanel({ region, status }: {
  region: 'cn' | 'global'
  status: StatusView
}) {
  return region === 'cn'
    ? <ChinaProviderPanel status={status} />
    : <GlobalProviderPanel status={status} />
}

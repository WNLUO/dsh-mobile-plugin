// 2026-11-27：服务商线路专属面板——按标签展示 zeronews 账号概览或 Cloudflare 状态。
/**
 * 「中国 / 国际」标签下的专属面板（2026-11-27 用户要求）。
 *
 * 中国面板从上到下四段：① 服务商 + 套餐 + 连接状态；② 当前公网地址（单独一行，可复制）；
 * ③ 四个关键指标（带宽 / 设备 / 在线 / 并发，不带「使用情况」标题，里面并不全是用量）；
 * ④ 三档套餐对照（当前档高亮，每档可点进官方定价页直接订阅）。操作按钮放在同一张卡里：
 * 「停止连接」是轻操作，「重置本机设置」是破坏性动作、带二次确认；不再单列「打开控制台」——
 * 想看用量 / 升级都在套餐入口里完成。
 *
 * 数据分两类绝不混：设备数 / 在线数 / 套餐名 / 地址来自宿主账号快照与 status，是真实事实；
 * 套餐权益是公开固定信息，写死在下方一处常量表，只按精确识别到的套餐显示，认不出不显示。
 * 流量已用量是云端数据、CLI 拿不到，只给额度，不编已用数字。
 *
 * 断开 / 重置完成后调 onChanged 让外层立刻重读 status —— 其他面板组件早有这个回调，
 * 这个面板之前漏了，导致地址与「已连接」最多挂着旧值 3 秒。
 */
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { Card } from '@appica/ui-react/card'
import { useEffect, useState, type ReactNode } from 'react'

import {
  zeroNewsAccount, zeroNewsDisconnect, zeroNewsPurge,
  type StatusView, type ZeroNewsAccount,
} from '../lib/api.ts'
import { cn, toneText, type Tone } from '../lib/format.ts'
import { t } from '../lib/i18n/index.ts'
import { CloudflarePanel } from './CloudflarePanel.tsx'
import { CloudflareIcon, ZeroNewsIcon } from './ProviderIcons.tsx'

const ZN_PRICING_URL = 'https://zeronews.cc/pricing'
const ZN_ACCOUNT_CACHE_KEY = 'dsh-mobile-plugin:zeronews-account'

/**
 * 各套餐权益（2026-11-27 核对官方定价页 https://zeronews.cc/pricing，当前三档：免费 / 个人 Pro / 个人 Pro+）。
 * 只列面板要用的关键参数：单隧道带宽、认证客户端数、单隧道并发、月流量额度、隧道名额、域名名额。
 * 官方曾发升级公告说免费版 2Mbps / 2 条，当前定价页是 1Mbps / 1 条，以定价页为准；
 * 套餐权益若再变，只改这一处表。仅作套餐说明，不是实时用量。
 */
type PlanTier = 'free' | 'pro' | 'proPlus'
type Quota = {
  bandwidthMbps: number
  devices: number
  concurrency: number
  trafficGb: number | null
  tunnels: number
  domains: number
}
const ZN_QUOTAS: Record<PlanTier, Quota> = {
  free: { bandwidthMbps: 1, devices: 1, concurrency: 5, trafficGb: 1, tunnels: 1, domains: 1 },
  pro: { bandwidthMbps: 5, devices: 4, concurrency: 30, trafficGb: null, tunnels: 4, domains: 4 },
  proPlus: { bandwidthMbps: 10, devices: 8, concurrency: 50, trafficGb: null, tunnels: 8, domains: 8 },
}
/**
 * 当前公开价（2026-11-27 官方定价页）：个人 Pro ¥22 月 / 个人 Pro+ ¥69 月；免费档显示套餐名即可。
 * ¥ 与数字是通用符号，不进文案表；改价只动这里。
 */
const ZN_PRICE_MONTHLY: Record<'pro' | 'proPlus', string> = {
  pro: '\u00a522',
  proPlus: '\u00a569',
}
/** 对照表的展示顺序：当前档排最前，其余按从低到高。 */
const ZN_TIERS: PlanTier[] = ['free', 'pro', 'proPlus']

/**
 * 套餐名 → 权益档：官方原始名字没有实测样本（付费档可能中英文混用），只精确认三档，
 * 认不出返回 null —— 宁可少显示，也不给付费用户套错数字。中文用码点写，避免界面文件
 * 出现钉死的中文字面量触发 i18n 守卫。
 */
function tierOf(planName: string): PlanTier | null {
  const free = '\u514d\u8d39'
  const pro = '\u4e2a\u4eba'
  const key = planName.trim().toLowerCase()
  if (key === free || key === 'free') return 'free'
  if (key === `${pro} pro` || key === 'pro') return 'pro'
  if (key === `${pro} pro+` || key === 'pro+') return 'proPlus'
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

/** 一个指标格：大内容 + 小标签。 */
function Stat({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border-muted bg-background-muted px-3 py-2">
      <span className="text-lg font-semibold leading-none text-foreground-strong">{value}</span>
      <span className="text-xs text-foreground-muted">{label}</span>
    </div>
  )
}

/** 服务商头部：图标 + 名字 + 套餐与账号副标题 + 右侧连接状态。 */
function ProviderHeading({ icon, name, subtitle, statusText, tone }: {
  icon: ReactNode
  name: string
  subtitle?: ReactNode
  statusText?: string
  tone?: Tone
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
        <span className={cn('inline-flex shrink-0 items-center gap-1.5 text-xs', toneText[tone ?? 'off'])}>
          <span className={cn('size-1.5 rounded-full', tone === 'ok' ? 'bg-success' : 'bg-foreground-muted')} />
          {statusText}
        </span>
      ) : null}
    </div>
  )
}

/** 套餐对照里的参数：label 名 + value 值 + 是否重点（带宽/流量/设备名额标亮）。 */
type TierFact = { label: string; value: string; strong?: boolean }

/** 一组参数小标签，一行铺不下自动换行；重点项加粗标亮。 */
function TierFacts({ facts }: { facts: TierFact[] }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {facts.map((fact) => (
        <span key={fact.label} className="text-xs text-foreground-muted">
          {fact.label}{' '}
          <span className={cn('text-foreground-strong', fact.strong ? 'font-semibold' : 'font-medium')}>{fact.value}</span>
        </span>
      ))}
    </div>
  )
}

/** 三档套餐对照：当前档排最前并用边框高亮、按钮显示「正在使用」；其余档按钮直达官方定价页订阅。 */
function PlanCompare({ current }: { current: PlanTier | null }) {
  const ordered = current ? [current, ...ZN_TIERS.filter((tier) => tier !== current)] : ZN_TIERS
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-foreground-strong">{t('panel.providerRegion.plansTitle')}</span>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {ordered.map((tier) => {
          const quota = ZN_QUOTAS[tier]
          const active = tier === current
          const price = tier === 'free'
            ? t(`panel.providerRegion.tier.${tier}`)
            : t('panel.providerRegion.priceMonthly', { price: ZN_PRICE_MONTHLY[tier] })
          return (
            <div
              key={tier}
              className={cn(
                'flex flex-col gap-2 rounded-md border p-3',
                active ? 'border-primary bg-primary-subtle' : 'border-border-muted bg-background-muted',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground-strong">
                  {t(`panel.providerRegion.tier.${tier}`)}
                  <span className="ms-1.5 text-xs font-normal text-foreground-muted">{price}</span>
                </span>
                {active ? (
                  <span className="shrink-0 rounded-full border border-primary bg-primary px-2.5 py-0.5 text-xs text-primary-foreground">
                    {t('panel.providerRegion.planInUse')}
                  </span>
                ) : (
                  <a
                    href={ZN_PRICING_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 rounded-full border border-border-muted bg-background px-2.5 py-0.5 text-xs text-foreground-strong transition-colors hover:bg-background-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    {t('panel.providerRegion.planAction')}
                  </a>
                )}
              </div>
              <TierFacts facts={[
                { label: t('panel.providerRegion.bandwidth'), value: t('panel.providerRegion.bandwidthValue', { bw: quota.bandwidthMbps }), strong: true },
                {
                  label: t('panel.providerRegion.traffic'),
                  value: quota.trafficGb !== null
                    ? t('panel.providerRegion.trafficValue', { traffic: quota.trafficGb })
                    : t('panel.providerRegion.unlimited'),
                  strong: true,
                },
                { label: t('panel.providerRegion.devices'), value: String(quota.devices), strong: true },
                { label: t('panel.providerRegion.tunnels'), value: String(quota.tunnels) },
                { label: t('panel.providerRegion.domains'), value: String(quota.domains) },
                { label: t('panel.providerRegion.concurrency'), value: String(quota.concurrency) },
              ]} />
            </div>
          )
        })}
      </div>
      <p className="text-xs leading-5 text-foreground-muted">{t('panel.providerRegion.planHint')}</p>
    </div>
  )
}

function ChinaProviderPanel({ status, onChanged }: { status: StatusView; onChanged?: () => void }) {
  /** 先用本地留底铺上，再悄悄刷一次；面板不轮询。 */
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
  const address = status.zeroNews?.url || ''
  const devices = (account?.devices || []).length
  const online = (account?.devices || []).filter((device) => device.online).length
  const plan = account?.account?.planName || ''
  const identity = account?.account?.userTel || account?.account?.userId || ''
  const tier = tierOf(plan)
  const quota = tier ? ZN_QUOTAS[tier] : null
  const statusText = connected ? t('panel.providerRegion.connected') : t('panel.providerRegion.notConnected')
  const tone: Tone = connected ? 'ok' : 'off'

  /** 断开：停客户端、撤域名；成功后重读账号并让外层刷新 status，地址与状态立刻更新。 */
  async function disconnect() {
    if (busy) return
    setBusy(true)
    setNote('')
    try {
      const res = await zeroNewsDisconnect()
      const error = typeof res.error === 'string' ? res.error : res.error?.message
      if (!res.ok && error) setNote(error)
      setAccount(await zeroNewsAccount())
      onChanged?.()
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  /** 重置：破坏性动作，二次确认后清本机登录 / 配置 / 缓存，再让外层刷新 status。 */
  async function reset() {
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
        onChanged?.()
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
          tone={tone}
        />

        {address ? (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md border border-border-muted bg-background-muted px-3 py-2">
            <span className="shrink-0 text-xs text-foreground-muted">{t('panel.providerRegion.address')}</span>
            <span className="min-w-0 break-all font-mono text-xs text-foreground-strong">{address}</span>
          </div>
        ) : null}

        {/* 两格够用：带宽是套餐上限，设备带「已用 / 名额 + 在线」；并发与流量在下面套餐卡里按档对照。 */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Stat
            value={quota ? t('panel.providerRegion.bandwidthValue', { bw: quota.bandwidthMbps }) : '—'}
            label={t('panel.providerRegion.bandwidth')}
          />
          <Stat
            value={quota ? `${devices} / ${quota.devices}` : devices}
            label={t('panel.providerRegion.devicesWithOnline', { online })}
          />
        </div>

        <PlanCompare current={tier} />

        {note ? <p className="text-xs leading-5 text-foreground-muted">{note}</p> : null}

        {connected ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border-muted pt-3">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void disconnect()}>
              {t('panel.providerRegion.stopConnection')}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void reset()}>
              {t('panel.providerRegion.resetLocal')}
            </Button>
          </div>
        ) : null}
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
export function ProviderRegionPanel({ region, status, onChanged }: {
  region: 'cn' | 'global'
  status: StatusView
  onChanged?: () => void
}) {
  return region === 'cn'
    ? <ChinaProviderPanel status={status} onChanged={onChanged} />
    : <GlobalProviderPanel status={status} />
}

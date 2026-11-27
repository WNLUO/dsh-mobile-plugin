// 2026-11-27：服务商线路专属面板——按标签展示 zeronews 账号概览或 Cloudflare 状态。
/**
 * 「中国 / 国际」标签下的专属面板（2026-11-27 用户要求）。
 *
 * 两块面板结构对齐：服务商身份 + 使用情况 + 控制台入口。内容分两类，绝不混：
 *   · 已用数量（隧道 / 设备 / 域名）与套餐名 —— 读宿主账号快照，是真实事实；
 *   · 免费版权益上限 —— 公开的套餐信息，写死在下方一处常量，不代表实时用量。
 * 只有确认是免费套餐时才把上限套到「已用」上；付费套餐不套，免得拿免费数字误导。
 * 流量已用量是云端数据、CLI 拿不到，只给额度与控制台入口，不编已用数字。
 *
 * 账号快照自己读一次（读宿主只读接口 `/api/relay/zeronews/account`），与配置页共用同一份
 * 接口与留底键；面板是只读视图，登录 / 连接 / 清理这些动作都在宿主侧已有入口里做。
 */
import { Badge } from '@appica/ui-react/badge'
import { Card } from '@appica/ui-react/card'
import { useEffect, useState, type ReactNode } from 'react'

import { zeroNewsAccount, type StatusView, type ZeroNewsAccount } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'
import { CloudflarePanel } from './CloudflarePanel.tsx'
import { CloudflareIcon, ZeroNewsIcon } from './ProviderIcons.tsx'

const ZN_CONSOLE_URL = 'https://user.zeronews.cc/'
const ZN_ACCOUNT_CACHE_KEY = 'dsh-mobile-plugin:zeronews-account'

/**
 * 免费版权益上限（2026-11-27 核对官方定价页 https://zeronews.cc/pricing 与 FAQ 计划与配额，
 * 两处都写：1 Mbps 总带宽 / 单隧道、1 GB 月流量、1 条在线隧道、1 个域名、1 个端口、
 * 并发 5、1 个认证客户端、HTTPS、标准隧道）。官方曾发升级公告说 2Mbps / 2 条，
 * 以当前定价页为准；权益若再变只改这一处。仅作套餐上限展示，不是实时用量。
 */
const ZN_FREE_QUOTA = {
  bandwidthMbps: 1,
  monthlyTrafficGb: 1,
  tunnels: 1,
  devices: 1,
  domains: 1,
  concurrency: 5,
} as const

/** 套餐名是否免费：官方给的名字是中文「免费」，兼容英文 Free；用码点写中文避免界面文件里出现钉死的字面量。 */
function isFreePlan(planName: string): boolean {
  const zhFree = '\u514d\u8d39'
  return new RegExp(`^\\s*(${zhFree}|free)\\s*$`, 'i').test(planName)
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

/** 使用情况里的一格：大数字 + 小标签；免费套餐时在数字后带出「/ 上限」。 */
function Stat({ value, label, limit }: { value: number | string; label: string; limit?: number }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border-muted bg-background-muted px-3 py-2">
      <span className="text-lg font-semibold leading-none text-foreground-strong">
        {value}{limit !== undefined ? <span className="text-xs font-normal text-foreground-muted"> / {limit}</span> : null}
      </span>
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

/** 底部一行：服务商控制台入口。 */
function PanelActions({ consoleUrl }: { consoleUrl: string }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <a
        href={consoleUrl}
        target="_blank"
        rel="noreferrer"
        className="rounded px-2 py-1 text-xs text-foreground-muted underline transition-colors hover:text-foreground-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {t('panel.zeronews.console')}
      </a>
    </div>
  )
}

function ChinaProviderPanel({ status }: { status: StatusView }) {
  /** 先用本地留底铺上，再悄悄刷一次；面板只读，不轮询。 */
  const [account, setAccount] = useState<ZeroNewsAccount | null>(() => readZnCache())
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
  const counts = account?.counts || { tunnels: 0, devices: 0, domains: 0 }
  const online = (account?.devices || []).filter((device) => device.online).length
  const plan = account?.account?.planName || ''
  const identity = account?.account?.userTel || account?.account?.userId || ''
  const free = isFreePlan(plan)
  const statusText = connected
    ? t('panel.zeronews.linkOn', { url: status.zeroNews?.url || '' })
    : t('panel.providerRegion.notConnected')

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
            <Stat value={counts.tunnels} label={t('panel.zeronews.overview.tunnels')} limit={free ? ZN_FREE_QUOTA.tunnels : undefined} />
            <Stat value={counts.devices} label={t('panel.zeronews.overview.devices')} limit={free ? ZN_FREE_QUOTA.devices : undefined} />
            <Stat value={online} label={t('panel.zeronews.overview.online')} />
            <Stat value={counts.domains} label={t('panel.zeronews.overview.domains')} limit={free ? ZN_FREE_QUOTA.domains : undefined} />
          </div>
          {free ? (
            <p className="text-xs leading-5 text-foreground-muted">
              {t('panel.providerRegion.freeQuota', {
                bw: ZN_FREE_QUOTA.bandwidthMbps,
                traffic: ZN_FREE_QUOTA.monthlyTrafficGb,
                concurrency: ZN_FREE_QUOTA.concurrency,
              })}
            </p>
          ) : null}
        </div>

        <PanelActions consoleUrl={ZN_CONSOLE_URL} />
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

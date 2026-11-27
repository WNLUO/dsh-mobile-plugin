// 2026-11-27：服务商线路专属面板——按标签展示 zeronews 账号概览或 Cloudflare 状态。
/**
 * 「中国 / 国际」标签下的专属面板（2026-11-27 用户要求）。
 *
 * 两块面板结构对齐：都是「服务商身份 + 连接状态 + 使用情况 + 详细配置入口」。
 * 内容只展示宿主已经给出的事实：zeronews 有套餐名、脱敏账号、已用数量、隧道带宽；
 * Cloudflare 有开关与地址。流量用量这类官方 CLI 没暴露的，**不编数字**，只给入口去控制台看。
 *
 * 账号快照自己读一次（读宿主只读接口 `/api/relay/zeronews/account`），与配置页共用同一份
 * 接口与留底键；面板是只读视图，登录 / 连接 / 清理这些动作都在「详细配置」页里做。
 */
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { Card } from '@appica/ui-react/card'
import { useEffect, useState, type ReactNode } from 'react'

import { zeroNewsAccount, type StatusView, type ZeroNewsAccount } from '../lib/api.ts'
import { cn, toneText, type Tone } from '../lib/format.ts'
import { t } from '../lib/i18n/index.ts'
import type { NetworkProvider } from '../lib/network-region.ts'
import { CloudflarePanel } from './CloudflarePanel.tsx'
import { CloudflareIcon, ZeroNewsIcon } from './ProviderIcons.tsx'

const ZN_CONSOLE_URL = 'https://user.zeronews.cc/'
const ZN_ACCOUNT_CACHE_KEY = 'dsh-mobile-plugin:zeronews-account'

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

/** 使用情况里的一格：大数字 + 小标签。 */
function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border-muted bg-background-muted px-3 py-2">
      <span className="text-lg font-semibold leading-none text-foreground-strong">{value}</span>
      <span className="text-xs text-foreground-muted">{label}</span>
    </div>
  )
}

/** 头部一行：图标 + 名字 + 地区说明 + 连接状态点。 */
function ProviderHeading({ icon, name, hint, tone, statusText }: {
  icon: ReactNode
  name: string
  hint: string
  tone: Tone
  statusText: string
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center">{icon}</span>
        <span className="flex min-w-0 flex-col">
          <span className="text-sm text-foreground-strong">{name}</span>
          <span className="text-xs text-foreground-muted">{hint}</span>
        </span>
      </div>
      <span className={cn('inline-flex shrink-0 items-center gap-1.5 text-xs', toneText[tone])}>
        <span className={cn('size-1.5 rounded-full', tone === 'ok' ? 'bg-success' : 'bg-foreground-muted')} />
        {statusText}
      </span>
    </div>
  )
}

/** 底部一行：控制台入口 + 详细配置。两面板同款。 */
function PanelActions({ consoleUrl, onOpenDetail }: { consoleUrl?: string; onOpenDetail: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {consoleUrl ? (
        <a
          href={consoleUrl}
          target="_blank"
          rel="noreferrer"
          className="rounded px-2 py-1 text-xs text-foreground-muted underline transition-colors hover:text-foreground-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {t('panel.zeronews.console')}
        </a>
      ) : null}
      <Button variant="ghost" size="sm" onClick={onOpenDetail}>
        {t('panel.providerRegion.openDetail')}
      </Button>
    </div>
  )
}

function ChinaProviderPanel({ status, onOpenDetail }: { status: StatusView; onOpenDetail: () => void }) {
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
  const tunnels = account?.tunnels || []
  const statusText = connected
    ? t('panel.zeronews.linkOn', { url: status.zeroNews?.url || '' })
    : t('panel.providerRegion.notConnected')
  const tone: Tone = connected ? 'ok' : 'off'

  return (
    <Card frame="solid">
      <div className="flex flex-col gap-3 p-4">
        <ProviderHeading
          icon={<ZeroNewsIcon />}
          name={t('panel.provider.zeronews')}
          hint={t('panel.providerRegion.chinaHint')}
          tone={tone}
          statusText={statusText}
        />

        {plan || identity ? (
          <div className="flex flex-wrap items-center gap-2">
            {plan ? <Badge variant="soft" size="sm">{plan}</Badge> : null}
            {identity ? <span className="truncate text-xs text-foreground-muted">{identity}</span> : null}
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-foreground-strong">{t('panel.providerRegion.usage')}</span>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat value={counts.tunnels} label={t('panel.zeronews.overview.tunnels')} />
            <Stat value={counts.devices} label={t('panel.zeronews.overview.devices')} />
            <Stat value={online} label={t('panel.zeronews.overview.online')} />
            <Stat value={counts.domains} label={t('panel.zeronews.overview.domains')} />
          </div>
          {tunnels.length > 0 ? (
            <div className="flex flex-col">
              {tunnels.slice(0, 3).map((tunnel) => (
                <div key={tunnel.id} className="flex items-center justify-between gap-3 border-b border-border-muted py-1.5 last:border-b-0">
                  <span className="truncate font-mono text-xs text-foreground-strong">{tunnel.domain || '—'}</span>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-foreground-muted">
                    {tunnel.bw > 0 ? <span>{t('panel.zeronews.tunnels.bw', { bw: tunnel.bw })}</span> : null}
                    <Badge variant={tunnel.enabled ? 'soft' : 'secondary'} size="xs">
                      {tunnel.enabled ? t('panel.zeronews.state.enabled') : t('panel.zeronews.state.disabled')}
                    </Badge>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <p className="text-xs leading-5 text-foreground-muted">{t('panel.providerRegion.consoleHint')}</p>
        </div>

        <PanelActions consoleUrl={ZN_CONSOLE_URL} onOpenDetail={onOpenDetail} />
      </div>
    </Card>
  )
}

function GlobalProviderPanel({ status, onOpenDetail }: { status: StatusView; onOpenDetail: () => void }) {
  const cf = status.cloudflare ?? null
  const running = Boolean(cf?.running)
  const statusText = running
    ? t('panel.cloudflare.running')
    : t('panel.cloudflare.available')
  const tone: Tone = running ? 'ok' : 'off'

  return (
    <Card frame="solid">
      <div className="flex flex-col gap-3 p-4">
        <ProviderHeading
          icon={<CloudflareIcon />}
          name={t('panel.provider.cloudflare')}
          hint={t('panel.providerRegion.globalHint')}
          tone={tone}
          statusText={statusText}
        />
        <CloudflarePanel status={status} />
        <PanelActions onOpenDetail={onOpenDetail} />
      </div>
    </Card>
  )
}

/** 按地区选面板：中国给 zeronews 概览，国际给 Cloudflare。 */
export function ProviderRegionPanel({ region, status, onOpenDetail }: {
  region: 'cn' | 'global'
  status: StatusView
  onOpenDetail: (provider: NetworkProvider) => void
}) {
  return region === 'cn'
    ? <ChinaProviderPanel status={status} onOpenDetail={() => onOpenDetail('zeronews')} />
    : <GlobalProviderPanel status={status} onOpenDetail={() => onOpenDetail('cloudflare')} />
}

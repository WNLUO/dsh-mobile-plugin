// 2026-11-27：国内服务商只留 ZeroNews，节点小宝与 FRP 的入口与就绪判定收掉。
// 2026-11-27：引导页国内只列 ZeroNews，可见范围由 onboardingProviderKeys 收口。
// 2026-11-25：服务商「已接好」还要求线路真能用（端口已绕开 / 没有未解决的兜底原因）。
// 引导页的服务商注册表：地区、是否主推、就绪判定、点开时挂载哪个配置面板。
/**
 * 首次接入引导页要按地区列出服务商、主推一家、接好之后再放二维码。这套信息集中在这里，
 * 引导页只按地区读这份清单渲染，不写死任何一家。
 *
 * 新增一家服务商：在 `network-region.ts` 的 `PROVIDERS` 里加一项（决定它在哪个地区、哪一页），
 * 再在这里补一条（主推与否、怎么判就绪、点开挂哪个面板）。这里用的是
 * `Record<NetworkProvider, ...>` —— 少补一条，TypeScript 当场编译不过，引导页本身一个字都不用改。
 *
 * 引导页可见哪些家由 `onboardingProviderKeys` 单独定：国内这一轮只放 ZeroNews，
 * 节点小宝与 FRP 的宿主能力照旧，只是入口不在这里；国际不变。
 */
import type { ComponentType } from 'react'

import type { StatusView } from './api.ts'
import { PROVIDERS, providersOfRegion, type NetworkProvider, type NetworkRegion } from './network-region.ts'
import { CloudflarePage } from '../components/CloudflarePage.tsx'
import { ZeroNewsPage } from '../components/ZeroNewsPage.tsx'

/** 各服务商配置面板共用的入参：都复用它们自己那一页，引导页不另写一套连接逻辑。 */
export type ProviderPanelProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: StatusView
  /** ZeroNews 那页要它来禁按钮；引导页不跑全局 busy，传空串即可。 */
  busy?: string
  /** 面板里做过动作后让引导页重读一次宿主状态。 */
  onChanged?: () => void
}

/** 判「这家接好了没有」要看的现场：状态。 */
export type ReadyContext = {
  status: StatusView
}

type SetupEntry = {
  /** 该地区里当主推、排在最前那一家。每个地区恰好一家。 */
  primary: boolean
  /** 这条线路此刻是不是已经能用（能写进二维码、手机能连）。 */
  ready: (ctx: ReadyContext) => boolean
  /** 点开时挂载的配置面板。 */
  Page: ComponentType<ProviderPanelProps>
}

/**
 * 服务商报「连上了」还不等于这条线路能用：端口被占而且没绕开、或者兜底还有未解决的
 * 原因码时，隧道落点仍可能指向被遮蔽的旧端口，二维码扫出去也连不上。
 *
 * 这一格按状态字段算，不认厂商名，也不替用户改配置；老宿主缺字段时按「没有冲突」
 * 处理，免得老用户被一扇不存在的弹窗挡在门外。
 */
export function lanRouteUsable(status: StatusView | null): boolean {
  if (!status) return false
  const reason = status.lan.fallbackReason ?? ''
  if (reason === 'port-locked' || reason === 'external-target' || reason === 'cloudflare-unavailable' || reason === 'zeronews-stale') return false
  const conflict = status.lan.conflict ?? ''
  return conflict === '' || (status.lan.bypassing ?? false)
}

const PROVIDER_SETUP: Record<NetworkProvider, SetupEntry> = {
  zeronews: {
    primary: true,
    ready: ({ status }) => lanRouteUsable(status) && status.zeroNews?.phase === 'connected' && Boolean(status.zeroNews?.url),
    Page: (props) => (
      <ZeroNewsPage open={props.open} onOpenChange={props.onOpenChange} status={props.status} busy={props.busy ?? ''} />
    ),
  },
  cloudflare: {
    primary: true,
    ready: ({ status }) => Boolean(status.cloudflare?.running && status.cloudflare?.url),
    Page: (props) => (
      <CloudflarePage open={props.open} onOpenChange={props.onOpenChange} status={props.status} onChanged={props.onChanged ?? (() => {})} />
    ),
  },
}

export type OnboardingProvider = {
  provider: NetworkProvider
  region: NetworkRegion
  primary: boolean
  ready: (ctx: ReadyContext) => boolean
  Page: ComponentType<ProviderPanelProps>
}

/**
 * 引导页这一步露出哪几家公司，跟注册表同源：国内只剩 ZeroNews，国际只有 Cloudflare，
 * 切 tab 时两边各一家、行结构一致，面板宽高不跳。
 */
export function onboardingProvidersOf(region: NetworkRegion): OnboardingProvider[] {
  return providersOfRegion(region)
    .map((provider) => ({ provider, region: PROVIDERS[provider].region, ...PROVIDER_SETUP[provider] }))
    .sort((a, b) => Number(b.primary) - Number(a.primary))
}

/** 这个地区有没有任意一家已经配好 —— 决定引导页放不放二维码。 */
export function regionHasReadyRoute(region: NetworkRegion, ctx: ReadyContext): boolean {
  return providersOfRegion(region).some((provider) => PROVIDER_SETUP[provider].ready(ctx))
}

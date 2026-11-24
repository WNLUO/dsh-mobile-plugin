// 2026-11-24 用户要求：自动更新已够用，面板上手动「立即更新 / 强制更新」撤掉，后端接口不动。
// 2026-11-24：重启 sidecar / 检查更新挪到控制台顶栏，按钮只留这一份、借落脚点渲染过去。
// 2026-11-24：顶栏那颗「网络配置」按钮撤了，extraActions 扩展位随之删掉。
// 主状态版本变化时重读外壳，磁盘版本与外壳当前实现比较。
/**
 * 「插件更新」卡片：正式 npm 更新状态与手动更新。**自动更新开关不在这张卡里**：2026-11-20
 * 起它挪到顶卡右列（`AutoUpdateSection`），与「自动上报网络地址」同列。
 *
 * **查**归插件自己（直接问 npm 注册表，见 `lib/update-registry.cjs`），**装**由宿主里的
 * 自动更新走 `/update/apply`，**换代码**由外壳就地换代（见 `lib/shell/runtime.js`）。对应
 * 四条接口是 `/api/relay/update/{status,check,apply,auto}`；页面只读状态与查询，不主动装。
 *
 * 紧急 OTA 的入口从前端撤掉了，**后端与客户端都不动**：`lib/relayUpdate.ts` 里那三个
 * `ota*` 函数与宿主那三条路由都留着，别顺手删掉接口或路由。
 *
 * 这里没有「重启 DSH」：**不许重启 DSH** 是硬约束，桌面端一重启就会掐掉用户正在跑的对话。
 * 自动更新因此必须做在宿主里，靠外壳就地换代生效。「重启 sidecar」是子进程层面的事，保留。
 *
 * 文案**不走字典，直接写中文**：这一页整体是中文语境，为一张卡维护两份字典只让改一句话要
 * 动两处。要再国际化就整页一起做，别只做这一张。
 *
 * 老宿主没有那四条接口（404）时走降级那一半：只剩「线上最新是几」这一行，页面不再给手动
 * 安装入口；装由宿主里的自动更新负责。
 *
 * **某次动作的结果**一律走右上角的胶囊（`../lib/notify.ts`）；**一直如此的事实**（没有可
 * 换代的外壳、没有市场）留在卡片里。
 *
 * 正文与标题外壳分开：控制台把它与配对卡合成一张无标题整卡时只取正文，标题外壳仍保留给
 * 单独用的场合。维护按钮借 portal 画到控制台顶栏，卡片自身不放动作按钮。
 * 2026-11-20 用户要求：版本信息挪到整卡左列，这张卡只留检查结果与提示。
 */
// 2026-11-20 用户要求：自动更新开关不再按安装来源隐藏，开发台上也摆出来（配一句实情）。
import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@appica/ui-react/alert'
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card'
import { Spinner } from '@appica/ui-react/spinner'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { errorText } from '../lib/api.ts'
import { useNotify } from '../lib/notify.ts'
import {
  MarketError,
  marketCapabilities,
  marketCheckUpdate,
  type MarketCapabilities,
  type MarketUpdate,
} from '../lib/market.ts'
import {
  updateCheck,
  updateEndpointMissing,
  updateStatus,
  updateUnavailable,
  type UpdateStatusView,
} from '../lib/relayUpdate.ts'
import { EVEN_ROWS, InfoList, InfoRow } from './InfoRow.tsx'
import type { Issue } from './IssueMark.tsx'
import { t } from '../lib/i18n/index.ts'

type Props = {
  /** 主状态回报的插件版本（`/api/relay/status` 的 appVersion，该代实现加载时读取）。 */
  version: string
  busy: string
  onRestartSidecar: () => void
  /**
   * 顶栏那两颗维护按钮的落脚点（控制台在 header 里给）。2026-11-24 用户要求把它们从卡片
   * 挪到顶栏：按钮的 JSX 仍只在这一份文件里，靠 portal 画到顶栏，busy / 模式分支 / 结果
   * 胶囊全归这张卡，避免出现第二份检查逻辑。不传（单独用这张卡、SSR）就不画。
   */
  actionsSlot?: HTMLElement | null
  /** 版本对不上的详情交给上层，挂到「运行中版本」那行的感叹号上。 */
  onIssues?: (issues: Issue[]) => void
  /** 只输出正文，外壳由控制台那张合并卡提供。 */
  bare?: boolean
}

/** 回转箭头：重启 sidecar。手画，跟顶栏其它图标同一套描边。 */
function RestartIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  )
}

/** 放大镜：检查有没有新版本，跟「装」和「重启」的图标都不重。 */
function CheckUpdateIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 4.5 4.5" />
    </svg>
  )
}

/** 市场查询里这几个 code 不是「坏了」，是「这次没查成、可以再试」——走琥珀提示。 */
const SOFT_CODES = new Set(['OPERATION_BUSY', 'RELEASE_TOO_FRESH', 'VERSION_UNCHANGED', 'PLUGIN_NOT_INSTALLED', 'AGENTS_RUNNING'])

/**
 * 这张卡显示的「最近一次检查结果」。
 *
 * 两条来源共用一个形状：宿主那条（插件自己问 npm，见 `lib/relayUpdate.ts`，带 `checkedAt`）
 * 优先；老宿主上退回市场那份客户端（`lib/market.ts`，不带时间）。
 */
type UpdateView = MarketUpdate & { checkedAt?: string | null }

export function UpdateCard({ version, busy, onRestartSidecar, onIssues, actionsSlot = null, bare = false }: Props) {
  /** 宿主那四条接口的状态；null = 还没读到（或老宿主压根没有）。 */
  const [host, setHost] = useState<UpdateStatusView | null>(null)
  /** 第一次读宿主状态已经落地：这之前别显示降级那一半，否则会先闪一下再变。 */
  const [settled, setSettled] = useState(false)
  /** 宿主说「这一版没有可换代的外壳」（409 + update_unavailable）。 */
  const [noShell, setNoShell] = useState(false)
  const [caps, setCaps] = useState<MarketCapabilities | null>(null)
  const [update, setUpdate] = useState<UpdateView | null>(null)
  const [working, setWorking] = useState('')
  const hostRead = useRef(0)
  /**
   * 「某次动作的结果」一律走右上角的胶囊，**不在卡片里铺长条**：卡片里那条 `Alert` 会一直
   * 占着版面，还把「刚才成没成」和「这块的长期状态」混成一种东西。长期状态（没有可换代的
   * 外壳 / 没有市场）仍旧写在卡片里——弹一次就消失等于让人再也看不到。
   */
  const notify = useNotify()

  /**
   * 把宿主给的 status 并进当前状态。
   *
   * **为什么要并而不是直接覆盖**：只有 `update/status` 那条会把外壳服务的在场标志
   * `available` 补在状态上，`update/check` 回的 status 里没有这个字段（宿主那边已补齐，
   * 但 0.1.64 及以前的宿主仍旧不带）。直接 `setHost(next)` 会把它抹成 undefined，
   * 卡片当场从「宿主模式」掉进取降级那一半 —— 用户看到的现象就是「查不到更新」。
   */
  const mergeHost = useCallback((next: UpdateStatusView | null) => {
    if (!next) return
    hostRead.current += 1
    setHost((prev) => ({ ...next, available: next.available === true || prev?.available === true }))
  }, [])

  const hostMode = host !== null && host.available && !noShell
  const idle = busy !== '' || working !== ''

  /** 读一次宿主状态：能读就进宿主模式；读不到（老宿主没有这四条）就走降级那一半。 */
  const loadHost = useCallback(async () => {
    const read = ++hostRead.current
    try {
      const next = await updateStatus()
      if (read !== hostRead.current) return
      setHost(next)
      // 宿主回 `available: false` = 它自己说「这份实现是直接被挂载的，装完没法就地换代」。
      // **这时绝不能把用户往插件市场带**：服务器那台是无头 / 源码同步部署，更新走「同步源码
      // + 重启宿主服务」，插件市场在那台机器上根本不存在。从前只认 409 那条错误码，于是这个
      // 分支永远进不来，界面上剩下的是「去插件市场更新」。
      setNoShell(next.available !== true)
    } catch (err) {
      if (read !== hostRead.current) return
      setHost(null)
      // 还剩一种要单独说的情况：宿主明说「这一版没有可换代的外壳」。其余读失败
      // （老宿主 404 / 读到别的错误页）都走降级那一半 —— 那一半自己能查到线上最新是几，
      // 不再需要把读失败的原因摊在界面上。
      setNoShell(updateUnavailable(err))
    } finally {
      if (read === hostRead.current) setSettled(true)
    }
  }, [])

  // 主状态由上层轮询；版本变了也要重读外壳，避免错过后台已经完成的换代。
  useEffect(() => {
    void loadHost()
    return () => { hostRead.current += 1 }
  }, [loadHost, version])

  // 再静默问一次「线上最新是几」。这一格归插件自己（宿主直接问 npm 注册表），所以不管走
  // 哪一半都能填上，不再等外壳去问市场。**静默**：打开页面就弹红框太吵 —— 失败什么都不说，
  // 人自己点「检查更新」时才如实报。
  useEffect(() => {
    if (!settled) return undefined
    let alive = true
    const read = hostRead.current
    void updateCheck()
      .then((result) => {
        if (!alive) return
        if (result.update) setUpdate(result.update)
        if (result.status && read === hostRead.current) mergeHost(result.status)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [settled])

  // 正在换代就每 1.5 秒问一次（换代本身在宿主里做，页面只是看结果）。
  const swapping = host?.swapping === true
  useEffect(() => {
    if (!swapping) return undefined
    const timer = window.setInterval(() => void loadHost(), 1500)
    return () => window.clearInterval(timer)
  }, [swapping, loadHost])

  // 退化成市场那条路时才去探市场（能力不会中途变，重启页面会重新探）。
  useEffect(() => {
    if (hostMode || !settled) return undefined
    let alive = true
    void marketCapabilities().then((next) => {
      if (alive) setCaps(next)
    })
    return () => {
      alive = false
    }
  }, [hostMode, settled])

  /** 市场那份失败分两种：能再试的走中性提示，真故障才红框。 */
  const reportMarketError = useCallback((err: unknown) => {
    if (err instanceof MarketError && SOFT_CODES.has(err.code)) {
      notify('soft', `${err.message}（${err.code}）`)
      return
    }
    notify('error', errorText(err))
  }, [])

  const check = useCallback(async () => {
    setWorking('check')
    const read = hostRead.current
    try {
      const result = await updateCheck()
      if (result.status && read === hostRead.current) mergeHost(result.status)
      // 这一格归插件自己：拿不到就是拿不到（宿主那条会把原因带在 500 的 message 里，
      // 上面 catch 会如实显示）。**不再**借宿主的 marketLastError 说事 —— 那是市场的事。
      if (result.update) setUpdate(result.update)
    } catch (err) {
      if (updateEndpointMissing(err) || updateUnavailable(err)) {
        await loadHost()
      } else {
        notify('error', errorText(err))
      }
    } finally {
      setWorking('')
    }
  }, [loadHost])

  /**
   * 降级那一半的「检查更新」。
   *
   * 先走宿主那条 `/api/relay/update/check`：它现在**不要求外壳在场**（查归插件自己，问的是
   * npm 注册表），所以无头部署、没有可换代外壳的那一版上照样答得出来。只有宿主连这条都没有
   * 时（真老版本，404）才退回页面直连市场那份老客户端 —— 那条路只报数、不装东西。
   */
  const marketOnlyCheck = useCallback(async () => {
    setWorking('check')
    const read = hostRead.current
    try {
      const result = await updateCheck()
      if (result.status && read === hostRead.current) mergeHost(result.status)
      setUpdate(result.update)
    } catch (err) {
      if (!updateEndpointMissing(err)) {
        setUpdate(null)
        notify('error', errorText(err))
      } else {
        try {
          setUpdate(await marketCheckUpdate(undefined, true))
        } catch (marketErr) {
          setUpdate(null)
          reportMarketError(marketErr)
        }
      }
    } finally {
      setWorking('')
    }
  }, [reportMarketError])

  const hasUpdate = update?.updateAvailable ?? host?.marketResult?.updateAvailable ?? false
  const shellVersion = host?.version ?? null
  // 主状态与外壳分别读取，两份快照可能暂时处在换代的两侧。
  const versionsDisagree = hostMode && !!shellVersion && !!version && shellVersion !== version
  // 盘上版本只与外壳实际装载的实现比较，主状态快照落后不代表安装未完成。
  const diskVersion = host?.installedVersion ?? null
  const diskDisagree = hostMode && !!diskVersion && !!shellVersion && diskVersion !== shellVersion

  // 版本对不上不在正文里铺段落：报给上层，挂到「运行中版本」那行的感叹号上。
  useEffect(() => {
    if (!onIssues) return
    const issues: Issue[] = []
    if (versionsDisagree) {
      issues.push({
        title: t('panel.update.runningVersion'),
        detail: t('panel.update.versionDrift', { version: version ?? '', shell: shellVersion ?? '' }),
      })
    }
    if (diskDisagree) {
      issues.push({
        title: t('panel.update.diskVersion'),
        detail: t('panel.update.diskDrift', { disk: diskVersion ?? '', running: shellVersion ?? '' }),
      })
    }
    onIssues(issues)
  }, [onIssues, versionsDisagree, diskDisagree, version, shellVersion, diskVersion])

  const body = (
    <>
      {/*
        2026-11-24：重启与检查更新挪到控制台顶栏。按钮的 JSX 只在这一份文件里，借
        `actionsSlot` portal 过去；busy、宿主 / 降级分支、结果提示全归这张卡，不写第二套
        检查逻辑。显示条件与原先卡片里那两处一一对应。
      */}
      {actionsSlot && settled && (hostMode || (!noShell && caps?.available === true))
        ? createPortal(
            <>
              <Button
                variant="ghost"
                size="icon-md"
                aria-label={t('panel.update.restartSidecar')}
                title={t('panel.update.restartSidecar')}
                disabled={idle}
                onClick={onRestartSidecar}
              >
                <RestartIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-md"
                aria-label={t('panel.update.check')}
                title={working === 'check' ? t('panel.update.checking') : t('panel.update.check')}
                disabled={idle}
                onClick={() => void (hostMode ? check() : marketOnlyCheck())}
              >
                <CheckUpdateIcon />
              </Button>
            </>,
            actionsSlot,
          )
        : null}
      {!settled ? (
        <div className="flex items-center gap-2 py-2 text-sm text-foreground-muted">
          <Spinner />
          {t('panel.update.reading')}
        </div>
      ) : null}

      {/*
        宿主说「这份实现是直接被挂载的」时，这一页**不摆警告框**：那台机器（无头 / 源码同步
        部署）照样答得出「线上最新是几」——查更新本来就不需要外壳（见宿主 control-plane 那条
        路由的注释）。所以这里跟正常卡片一样只报版本，再用一行灰字说清这台是怎么更新的：
        把无头那台往插件市场上带是错的（那儿没有市场），而铺一个大黄框只是把「没有故障」
        说成故障。
      */}
      {noShell ? (
        <>
          <p className="mt-3 text-xs text-foreground-muted">
            {hasUpdate ? t('panel.update.hasNew') : ''}
            {t('panel.update.nothingToInstall')}
          </p>
        </>
      ) : null}

      {/* 市场那条路：市场不在或没装市场时，只剩「去设置里更新」这一条。 */}
      {settled && !hostMode && !noShell && caps !== null && !caps.available ? (
        <Alert variant="info" className="mt-3">
          <AlertIcon />
          <AlertTitle>{t('panel.update.noMarketTitle')}</AlertTitle>
          <AlertDescription>{t('panel.update.noMarketBody')}</AlertDescription>
        </Alert>
      ) : null}

      {hostMode && host ? (
        <>
          {/*
            自动更新那颗开关 2026-11-20 挪到顶卡右列（`AutoUpdateSection`）：它跟「自动上报
            网络地址」同列，说明与关闭确认都在那边。这里不再摆开关，只剩版本与动作。
          */}
          {/* 版本对不上已收进「运行中版本」那行的感叹号，这里不再铺段落。 */}

          {/* 宿主自己记下来的最近一次失败（自动更新失败也落在这里）。 */}
          {host.lastError ? (
            <p className="mt-2 text-xs text-foreground-muted">
              {t('panel.update.lastErrorLine', { message: host.lastError })}
            </p>
          ) : null}
        </>
      ) : null}

      {/* 降级那一半：这张卡没能进「宿主模式」（读不到那四条接口的状态，或者宿主说它没有
          可换代的外壳）。查更新不要求外壳在场，所以这一半照样报得出「线上最新是几」；
          装由宿主里的自动更新负责，页面上不再给手动入口。 */}
      {settled && !hostMode && !noShell && caps?.available ? (
        <>
          <InfoList className={EVEN_ROWS}>
            <InfoRow label={t('panel.update.checkResult')}>
              {hasUpdate ? t('panel.update.resultHasNew') : t('panel.update.resultUpToDate')}
            </InfoRow>
          </InfoList>
        </>
      ) : null}

    </>
  )

  if (bare) return body
  return (
    <Card frame="solid">
      <CardHeader className="px-4 py-3">
        <CardTitle className="flex items-center gap-2 text-base lg:text-lg">
          <span>{t('panel.update.title')}</span>
          <Badge variant="soft" size="sm">{version || t('panel.update.unknownVersion')}</Badge>
        </CardTitle>
      </CardHeader>
      {body}
    </Card>
  )
}

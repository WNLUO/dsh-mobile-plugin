/**
 * 「插件更新」卡片：自动更新开关、运行中 / 盘上 / 线上的版本对照、手动更新。
 *
 * ## 更新怎么走
 *
 * **查**归插件自己（直接问 npm 注册表，见 `lib/update-registry.cjs`）—— 所以这张卡在任何
 * 宿主上都答得出「线上最新是几」。**装**与**换代码**在宿主里：装走 `/update/apply`，
 * 换代码由外壳就地换代（见 `lib/shell/runtime.js`）。页面只负责「说清现在什么情况」和
 * 「给一个开关」，四条接口是 `/api/relay/update/{status,check,apply,auto}`。
 *
 * ## 为什么这张卡里没有「重启 DSH」
 *
 * 有过，去掉了。本项目的硬约束是**不许重启 DSH**：桌面端一重启就会在用户不知情时掐掉
 * 他正在跑的对话。那条路正是「自动更新」必须做在宿主里的原因——没人看着的时候也得生效，
 * 而生效靠的是外壳就地换代，不是重启。子进程层面的「重启 sidecar」是另一件事（不涉及
 * 宿主进程），保留。
 *
 * ## 文案
 *
 * **不走字典，直接写中文。** 2026-10-11 按用户要求把中英字典（`lib/i18n.ts`）删掉：
 * 这一页整体是中文语境（`index.html` 是 `zh-CN`，另外三张卡也是写死中文），为一张卡维护
 * 两份字典只让改一句话要动两处。要再国际化就整页一起做，别只做这一张。
 *
 * ## 降级那一半
 *
 * 老宿主没有那四条接口（404）时，卡片只剩「运行中 / 线上最新 / 来源 / 检查结果」四行加
 * 一颗「检查更新」——那几行仍然填得上（查是插件自己的事）。**「装」给不给看 `host` 在不在**：
 * 2026-10-11 起装归插件自己（在 profile 里跑它自己的包管理器，见 `lib/update-install.cjs`），
 * 不要求外壳在场，所以只要宿主答过状态就照样给「立即更新」；真老宿主（路由不存在）才只剩
 * 「去设置里更新」。新版宿主但这一版装的是**没有外壳**的实现（`available: false`）是另一种
 * 情形，单独说。
 *
 * ## 提示住哪里
 *
 * **某次动作的结果**（检查出了什么、装成功没有、报了什么错）一律走右上角的胶囊
 * （`../lib/notify.ts`）；**一直如此的事实**（没有可换代的外壳、没有市场、`link:` 装的、
 * 外壳也换了）留在卡片里。2026-10-11 用户要求：卡片里别再铺长条——那个「上一次更新的结果」
 * 大绿条尤其没必要，宿主记得的 `lastApply` 每次开页面都会重放，而那句结论上面那行
 * 「最近一次更新」已经说了。
 */
import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@appica/ui-react/alert'
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card'
import { Spinner } from '@appica/ui-react/spinner'
import { Switch } from '@appica/ui-react/switch'
import { useCallback, useEffect, useState } from 'react'

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
  DEFAULT_AUTO_INTERVAL_MS,
  busyTextOf,
  updateApply,
  updateAuto,
  updateCheck,
  updateEndpointMissing,
  updateStatus,
  updateUnavailable,
  type ApplyOutcomeView,
  type UpdateStatusView,
} from '../lib/relayUpdate.ts'
import { InfoList, InfoRow } from './InfoRow.tsx'

type Props = {
  /** 正在跑的插件版本（`/api/relay/status` 的 appVersion，进程启动时读进内存的）。 */
  version: string
  busy: string
  onRestartSidecar: () => void
}

/** 这几个 code 不是「坏了」，是「这次没动、可以再试」——走琥珀提示而不是红框。 */
const SOFT_CODES = new Set(['OPERATION_BUSY', 'RELEASE_TOO_FRESH', 'VERSION_UNCHANGED', 'PLUGIN_NOT_INSTALLED', 'AGENTS_RUNNING'])

/**
 * 这张卡显示的「最近一次检查结果」。
 *
 * 两条来源共用一个形状：宿主那条（插件自己问 npm，见 `lib/relayUpdate.ts`，带 `checkedAt`）
 * 优先；老宿主上退回市场那份客户端（`lib/market.ts`，不带时间）。
 */
type UpdateView = MarketUpdate & { checkedAt?: string | null }

/** 时间戳（宿主给的是 ISO 串）→ 本机可读；给不出就直说「还没」。 */
function timeText(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return value
  return at.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** 把「装完了」这件事说成一句人话。 */
function applyText(outcome: ApplyOutcomeView): { text: string; ok: boolean } {
  const installed = outcome.installedVersion ?? outcome.beforeVersion
  if (outcome.failure) return { text: `这次更新没成：${outcome.failure.message}`, ok: false }
  if (outcome.installed === false) {
    if (outcome.skipped) {
      return { text: installed ? `已经是最新版（${installed}），没有改动任何文件。` : '已经是最新版，没有改动任何文件。', ok: true }
    }
    return { text: installed ? `装了但盘上的版本没变（还是 ${installed}），这次不算数，可以再点一次。` : '这次更新没成，可以再点一次。', ok: false }
  }
  return {
    text: installed ? `已就地切到 ${installed}，无需重启。` : '已就地切到新版本，无需重启。',
    ok: true,
  }
}

export function UpdateCard({ version, busy, onRestartSidecar }: Props) {
  /** 宿主那四条接口的状态；null = 还没读到（或老宿主压根没有）。 */
  const [host, setHost] = useState<UpdateStatusView | null>(null)
  /** 第一次读宿主状态已经落地：这之前别显示降级那一半，否则会先闪一下再变。 */
  const [settled, setSettled] = useState(false)
  /** 宿主说「这一版没有可换代的外壳」（409 + update_unavailable）。 */
  const [noShell, setNoShell] = useState(false)
  const [caps, setCaps] = useState<MarketCapabilities | null>(null)
  const [update, setUpdate] = useState<UpdateView | null>(null)
  const [working, setWorking] = useState('')
  /**
   * 「某次动作的结果」一律走右上角的胶囊，**不在卡片里铺长条**（2026-10-11 用户要求）：
   * 卡片里那条 `Alert` 会一直占着版面，还把「刚才成没成」和「这块的长期状态」混成一种东西。
   * 长期状态（没有可换代的外壳 / 没有市场 / `link:` 装的）仍旧写在卡片里——那是「一直如此」，
   * 弹一次就消失等于让人再也看不到。
   */
  const notify = useNotify()
  /** 开关正在提交：提交期间把它按住，免得连点出两个相反的请求。 */
  const [savingAuto, setSavingAuto] = useState(false)

  /**
   * 把宿主给的 status 并进当前状态。
   *
   * **为什么要并而不是直接覆盖**：只有 `update/status` 那条会把外壳服务的在场标志
   * `available` 补在状态上，`update/check` 回的 status 里没有这个字段（宿主那边已补齐，
   * 但 0.1.64 及以前的宿主仍旧不带）。直接 `setHost(next)` 会把它抹成 undefined，
   * 卡片当场从「宿主模式」掉进取降级那一半 —— 用户看到的现象就是
   * 「有新版本，却没有『立即更新』」（2026-10-11 真机复现）。
   */
  const mergeHost = useCallback((next: UpdateStatusView | null) => {
    if (!next) return
    setHost((prev) => ({ ...next, available: next.available === true || prev?.available === true }))
  }, [])

  const hostMode = host !== null && host.available && !noShell
  const idle = busy !== '' || working !== ''

  /** 读一次宿主状态：能读就进宿主模式；读不到（老宿主没有这四条）就走降级那一半。 */
  const loadHost = useCallback(async () => {
    try {
      const next = await updateStatus()
      setHost(next)
      // 宿主回 `available: false` = 它自己说「这份实现是直接被挂载的，装完没法就地换代」。
      // **这时绝不能把用户往插件市场带**（2026-10-11 用户报的原文）：服务器那台是无头 / 源码
      // 同步部署，更新走「同步源码 + 重启宿主服务」，插件市场在那台机器上根本不存在。
      // 从前只认 409 那条错误码，于是这个分支永远进不来，界面上剩下的是「去插件市场更新」。
      setNoShell(next.available !== true)
    } catch (err) {
      setHost(null)
      // 还剩一种要单独说的情况：宿主明说「这一版没有可换代的外壳」。其余读失败
      // （老宿主 404 / 读到别的错误页）都走降级那一半 —— 那一半自己能查到线上最新是几，
      // 不再需要把读失败的原因摊在界面上。
      setNoShell(updateUnavailable(err))
    } finally {
      setSettled(true)
    }
  }, [])

  // 进页面读一次；之后换代期间靠轮询（见下）。
  useEffect(() => {
    void loadHost()
  }, [loadHost])

  // 再静默问一次「线上最新是几」。这一格归插件自己（宿主直接问 npm 注册表），所以不管走
  // 哪一半都能填上，不再等外壳去问市场。**静默**：打开页面就弹红框太吵 —— 失败什么都不说，
  // 人自己点「检查更新」时才如实报。
  useEffect(() => {
    if (!settled) return undefined
    let alive = true
    void updateCheck()
      .then((result) => {
        if (!alive) return
        if (result.update) setUpdate(result.update)
        if (result.status) mergeHost(result.status)
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
    try {
      const result = await updateCheck()
      if (result.status) mergeHost(result.status)
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

  const apply = useCallback(
    async (force: boolean) => {
      setWorking('apply')
      try {
        const outcome = await updateApply(force)
        if (outcome.status) mergeHost(outcome.status)
        const said = applyText(outcome)
        // 「这次没动、可以再试」这一类（有人正在干活、刚发布还不能装、盘上版本没变）走琥珀
        // 提示，不是红框：它们不是故障，用户要的是「等下再来」而不是「哪里坏了」。
        const soft = outcome.failure !== null && SOFT_CODES.has(outcome.failure.code)
        if (said.ok || soft) notify('soft', said.text)
        else notify('error', said.text)
      } catch (err) {
        if (updateEndpointMissing(err) || updateUnavailable(err)) {
          await loadHost()
        } else {
          notify('error', errorText(err))
        }
      } finally {
        setWorking('')
      }
    },
    [loadHost],
  )

  /**
   * 降级那一半的「检查更新」。
   *
   * 先走宿主那条 `/api/relay/update/check`：它现在**不要求外壳在场**（查归插件自己，问的是
   * npm 注册表），所以无头部署、没有可换代外壳的那一版上照样答得出来。只有宿主连这条都没有
   * 时（真老版本，404）才退回页面直连市场那份老客户端 —— 那条路只报数、不装东西。
   */
  const marketOnlyCheck = useCallback(async () => {
    setWorking('check')
    try {
      const result = await updateCheck()
      if (result.status) mergeHost(result.status)
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

  /** 自动更新开关：失败必须把开关拨回去，并且说清为什么。 */
  const flipAuto = useCallback(async (next: boolean) => {
    setSavingAuto(true)
    try {
      const result = await updateAuto(next)
      if (result.status) mergeHost(result.status)
      const minutes = Math.round((result.status?.autoIntervalMs ?? host?.autoIntervalMs ?? DEFAULT_AUTO_INTERVAL_MS) / 60000)
      notify('soft', result.enabled ? `自动更新已开启：每 ${minutes} 分钟查一次，有新版会直接装好并就地生效。` : '自动更新已关闭，之后只在点「检查更新」时才问市场。')
    } catch (err) {
      notify('error', `自动更新开关没保存成功：${errorText(err)}`)
      await loadHost() // 拨回宿主那边的真实值
    } finally {
      setSavingAuto(false)
    }
  }, [host?.autoIntervalMs, loadHost])

  // 「线上最新」优先用这一格自己查到的（插件问 npm）；外壳上次问市场的结果只当兜底，
  // 免得刚好赶上静默那一次没查成时整行空着。
  const latestOnline = update?.latestVersion ?? host?.marketResult?.latestVersion ?? null
  const marketSource = update?.source ?? host?.marketResult?.source ?? null
  const hasUpdate = update?.updateAvailable ?? host?.marketResult?.updateAvailable ?? false
  const installedOnDisk = host?.installedVersion ?? null
  const summary = host?.lastApply ? applyText(host.lastApply) : null
  // 宿主自己报的「此刻在忙什么」：换代 / 在飞请求收尾。
  const hostBusy = busyTextOf(host)
  const panelVersion = version || '—'
  const shellVersion = host?.version ?? null
  // 面板报的是进程启动时读进内存的版本，外壳报的是它实际装载的那一代。
  const versionsDisagree = hostMode && !!shellVersion && !!version && shellVersion !== version

  return (
    <Card frame="solid">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span>{'插件更新'}</span>
          <Badge variant="soft" size="sm">{version || '未知版本'}</Badge>
        </CardTitle>
      </CardHeader>

      {!settled ? (
        <div className="flex items-center gap-2 py-2 text-sm text-foreground-muted">
          <Spinner />
          {'正在读更新状态…'}
        </div>
      ) : null}

      {/*
        宿主说「这份实现是直接被挂载的」时，这一页**不摆警告框**：那台机器（无头 / 源码同步
        部署）照样答得出「线上最新是几」——查更新本来就不需要外壳（见宿主 control-plane 那条
        路由的注释）。所以这里跟正常卡片一样只报版本，再用一行灰字说清这台是怎么更新的：
        把无头那台往插件市场上带是错的（那儿没有市场），而铺一个大黄框只是把「没有故障」
        说成故障（2026-10-11 用户看完截图的原话：为什么显示一个这么大的提示框）。
      */}
      {noShell ? (
        <>
          <InfoList>
            <InfoRow label={'运行中版本'} mono>
              {panelVersion}
            </InfoRow>
            <InfoRow label={'线上最新'} mono>
              {latestOnline ?? '还没查过'}
            </InfoRow>
          </InfoList>
          <p className="mt-3 text-xs text-foreground-muted">
            {hasUpdate ? '线上有新版本。' : ''}
            {'这台宿主的面板里不装新代码（当前这份实现是直接被挂载的）：无头 / 源码同步部署到服务器上同步源码 + 重启宿主服务；桌面端旧版到「设置 → 插件 → 本插件」里更新一版。'}
          </p>
        </>
      ) : null}

      {/* 市场那条路：市场不在或没装市场时，只剩「去设置里更新」这一条。 */}
      {settled && !hostMode && !noShell && caps !== null && !caps.available ? (
        <Alert variant="info" className="mt-3">
          <AlertIcon />
          <AlertTitle>{'这台机器上没有可用的插件市场'}</AlertTitle>
          <AlertDescription>{'插件从 npm 分发，更新由 DSH 的插件市场负责：到「设置 → 插件」里更新本插件（或装上插件市场）。'}</AlertDescription>
        </Alert>
      ) : null}

      {hostMode && host ? (
        <>
          {/* 开关。放在信息行上面：它是这张卡唯一会被改的东西，先说清楚它在干什么。 */}
          <label className="mt-1 flex items-start justify-between gap-4 border-b border-border-muted py-3">
            <span className="min-w-0">
              <span className="block text-sm text-foreground">{'自动更新'}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {savingAuto ? <Spinner /> : null}
              <Switch
                size="md"
                checked={host.autoUpdate}
                disabled={idle || savingAuto}
                onCheckedChange={(next) => void flipAuto(next)}
                aria-label={'自动更新'}
              />
            </span>
          </label>

          <InfoList>
            <InfoRow label={'运行中版本'} mono>
              {panelVersion}
            </InfoRow>
            <InfoRow label={'盘上的版本'} mono>
              {installedOnDisk ?? '—'}
            </InfoRow>
            <InfoRow label={'线上最新'} mono>
              {latestOnline ?? '还没查过'}
            </InfoRow>
            <InfoRow label={'安装来源'}>{marketSource ?? '—'}</InfoRow>
            <InfoRow label={'更新操作'}>
              {hostBusy === 'swapping'
                ? '正在切换…'
                : hostBusy === 'in-flight'
                  ? `正在收尾在飞请求（${host.inFlight} 个）…`
                  : '空闲'}
            </InfoRow>
            <InfoRow label={'最近一次检查'}>
              {timeText(update?.checkedAt ?? host.marketLastCheckedAt, '还没查过')}
            </InfoRow>
            <InfoRow label={'最近一次更新'}>
              {host.lastApply ? timeText(host.appliedAt, '还没更新过') : '还没更新过'}
            </InfoRow>
          </InfoList>

          {/* 两处「运行中版本」对不上：面板那份是进程启动时读进内存的，外壳那份是实际装载的。 */}
          {versionsDisagree ? (
            <p className="mt-2 text-xs text-foreground-muted">
              {`这两个版本对不上：面板报的 ${version} 是进程启动时读进内存的，外壳实际装载的是 ${shellVersion ?? ''}。一般是外壳刚换过代、页面还没重新读取；刷新一下这一页就一致了。`}
            </p>
          ) : null}

          {/*
            「上一次更新的结果」不再在这里铺一条长条（原先是绿/红 `Alert`）：宿主记得的
            `lastApply` 每次打开页面都会重放一遍，那条大绿条就是这么来的；它要说的
            「最近一次更新」上面那行 `InfoRow` 已经说了。**这次动作**的结论走胶囊。
          */}

          {host.shellChanged ? (
            <Alert variant="info" className="mt-3">
              <AlertIcon />
              <AlertTitle>{'这次更新里外壳也换了'}</AlertTitle>
              <AlertDescription>{'它有极少数改动要等下次启动 DSH 才生效（更新本身已经生效，不用管）。'}</AlertDescription>
            </Alert>
          ) : null}

          {/* 只有 `link:` 要说一句：`file:` 的 tgz 与版号一样都能自己装（装上就换成注册表
              来源，那正是想要的）。 */}
          {marketSource === 'linked' ? (
            <Alert variant="warning" className="mt-3">
              <AlertIcon />
              <AlertTitle>{'这个插件指向一个本地目录'}</AlertTitle>
              <AlertDescription>{'profile 里它是 link: 装的（多半是开发时故意指过去的）。自己装会把那个指向改掉，所以更新不动它：要换回按版号安装，先在 设置 → 插件 里按包名重装一次。'}</AlertDescription>
            </Alert>
          ) : null}

          {/* 宿主自己记下来的最近一次失败（自动更新失败也落在这里）。 */}
          {host.lastError ? (
            <p className="mt-2 text-xs text-foreground-muted">
              {`最近一次出过错：${host.lastError}`}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {/* 「重启 sidecar」和更新讲的是同一件事的另一半：让磁盘上的新代码在**子进程**层
                立刻生效。它不重启宿主，所以留在这里。 */}
            <Button variant="outline" size="md" disabled={idle} onClick={onRestartSidecar}>
              {'重启 sidecar'}
            </Button>
            <Button variant="outline" size="md" disabled={idle} onClick={() => void check()}>
              {working === 'check' ? '正在检查…' : '检查更新'}
            </Button>
            <Button variant="primary" size="md" disabled={idle} onClick={() => void apply(false)}>
              {working === 'apply' ? '正在更新…' : '立即更新'}
            </Button>
          </div>

          {/* 市场对「刚发布、还没过 release-age 门槛」的版本会先拒一次。这时才轮到 force：
              平时不给这个选项，免得不小心绕过供应链策略。 */}
          {hasUpdate || (summary !== null && !summary.ok) ? (
            <div className="mt-2 flex justify-end">
              <Button variant="ghost" size="sm" disabled={idle} onClick={() => void apply(true)}>
                {'强制更新（有对话在跑、或刚发布的，也照装）'}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {/*
        降级那一半：这张卡没能进「宿主模式」（读不到那四条接口的状态，或者宿主说它没有
        可换代的外壳）。**装不一定做不了**：2026-10-11 起「装」归插件自己（在 profile 里
        跑它自己的包管理器，见 `lib/update-install.cjs`），不要求外壳在场。所以只要宿主
        答过状态（`host !== null`，说明那几条路由在），这里就照样给「立即更新」；
        真老宿主（路由压根不存在）才只剩「去设置里更新」。
      */}
      {settled && !hostMode && !noShell && caps?.available ? (
        <>
          <InfoList>
            <InfoRow label={'运行中版本'} mono>
              {panelVersion}
            </InfoRow>
            <InfoRow label={'线上最新'} mono>
              {latestOnline ?? '还没查过'}
            </InfoRow>
            <InfoRow label={'安装来源'}>{marketSource ?? '—'}</InfoRow>
            <InfoRow label={'检查结果'}>
              {hasUpdate ? '有新版可以装' : '已经是最新版'}
            </InfoRow>
          </InfoList>

          {/* 只有 `link:` 要说一句：`file:` 的 tgz 与版号一样都能自己装（装上就换成注册表
              来源，那正是想要的）。 */}
          {marketSource === 'linked' ? (
            <Alert variant="warning" className="mt-3">
              <AlertIcon />
              <AlertTitle>{'这个插件指向一个本地目录'}</AlertTitle>
              <AlertDescription>{'profile 里它是 link: 装的（多半是开发时故意指过去的）。自己装会把那个指向改掉，所以更新不动它：要换回按版号安装，先在 设置 → 插件 里按包名重装一次。'}</AlertDescription>
            </Alert>
          ) : null}

          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="md" disabled={idle} onClick={onRestartSidecar}>
              {'重启 sidecar'}
            </Button>
            <Button variant="outline" size="md" disabled={idle} onClick={() => void marketOnlyCheck()}>
              {working === 'check' ? '正在检查…' : '检查更新'}
            </Button>
            {host !== null ? (
              <Button variant="primary" size="md" disabled={idle} onClick={() => void apply(false)}>
                {working === 'apply' ? '正在更新…' : '立即更新'}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </Card>
  )
}

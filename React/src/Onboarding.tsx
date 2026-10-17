/**
 * 首次接入引导（一页）。
 *
 * 宿主还没配过、或者走 `/api/relay/panel/setup` 时进这一页。整页只做一件事：
 * 把直连打开，把二维码摆出来让手机扫。
 *
 * 2026-10-10 用户要求「只留一页：局域网/公网不用选，设备名和端口不用填」，于是原来的
 * 四页（欢迎 / 使用场景 / 配置 / 完成）合成一屏：
 * - 「使用场景」整页删掉 —— 手机直连、自建中转、一键部署三条路里，第一次装的人只有
 *   直连答得上来。中转那几条留在主页的「中转配置」弹窗里，那里本来就有一整套字段；
 * - 「配置」页的设备名与端口不再问 —— 设备名取宿主机名，端口用宿主自己的默认值；
 * - 「完成」页并进来 —— 二维码与配对码就在按钮下面，扫不扫、什么时候扫都由人自己决定。
 *
 * **进页就把直连打开**（2026-10-10 用户截图里二维码是空的，因为原来要先点一颗按钮）：
 * 那一串配置写入与「打开直连」按钮做的是同一件事，挪到挂载时跑一遍；已经开着就不再写，
 * 免得每次打开 `/setup` 都把这台机器的配置重写一次。
 *
 * **二维码里带哪条局域网地址由人自己选**：机器上只有一条就是它，有两条以上时列出来让人选，
 * 选中的那条随 `/api/relay/config` 的 `preferredLanAddress` 落盘，宿主把它排在二维码候选的
 * 最前（见 `lib/relay/lan-network.cjs` 的 `orderCandidates`），选完立刻重取二维码。
 *
 * **「公用中转」是地址组里的一条选项**（2026-10-10 用户要求）：一行四个字，不摆地址、也不问
 * 地址 —— 选局域网地址就是手机直连，选它就是「手机不在这台电脑的网络里，走中转」。这一版
 * **只有前端**：真正要写进 `relayUrl` 的东西先用 `status.relayUrl`（存过的）或
 * `DEFAULT_RELAY_URL`（占位）顶着；公用中转地址的优选（多个入口里挑最快的一条）是后面
 * 单独一件事，别在这儿假装做完了。
 *
 * 按钮那一下真正做的事：`POST /api/relay/config`（直连开着、中转地址清空、配对策略按
 * 配对码）→ `POST /api/relay/toggle {enabled:true}` → `POST /api/relay/onboarded`，
 * 然后轮询 `/api/relay/status` 把真实状态说出来。页面自己不猜连接结果，也不假报成功。
 */
import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@appica/ui-react/alert'
import { Button, buttonVariants } from '@appica/ui-react/button'
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@appica/ui-react/dialog'
import { Field, FieldLabel } from '@appica/ui-react/field'
import { Input } from '@appica/ui-react/input'
import { Radio } from '@appica/ui-react/radio'
import { RadioGroup } from '@appica/ui-react/radio-group'
import { Spinner } from '@appica/ui-react/spinner'
import { useEffect, useRef, useState } from 'react'

import { InfoList, InfoRow, ToneValue } from './components/InfoRow.tsx'
import {
  apiGet,
  apiPost,
  errorText,
  type AddressBook,
  type ConfigPatch,
  type PairingInfo,
  type StatusView,
} from './lib/api.ts'
import { lanText, lanTone, tunnelText, tunnelTone } from './lib/format.ts'
import { APP_DOWNLOAD_URL, PUBLIC_RELAYS } from './lib/links.ts'

/** 地址组里「公用中转」那一条的哨兵值：它不是地址，选它等于选「走中转」。 */
const PUBLIC_RELAY = 'public-relay'
/** 「自建中转」同理：选它之后由用户在下面填自己的域名。 */
const OWN_RELAY = 'own-relay'

/** 自建中转那一栏右边那颗按钮指向的仓库（用户给的地址）。 */
const RELAY_REPO_URL = 'https://github.com/WNLUO/dsh-mobile-server'

/**
 * 公用中转的候选入口。清单本身在 `lib/links.ts`（中转配置弹窗也要用同一份）。
 *
 * 这些是**真的能用的**地址：用户选中哪条，就真的走那条配对、走那条转发。
 * 测速由宿主代测（`POST /api/relay/probe-relays`）—— 浏览器直连这些域名会被 CORS
 * 挡住，测出来的不是真实耗时，还会把可用入口误判成不通。
 */
const PUBLIC_RELAY_CANDIDATES = PUBLIC_RELAYS

/** 一条候选的测速结果。`null` = 还在测；`Infinity` = 测不通。 */
type RelayProbe = { name: string; url: string; ms: number | null }

type Props = {
  /** 配好之后去哪。默认回插件主页。 */
  onDone?: () => void
}

/**
 * 这一步该选哪条地址：用户上次存过的还在清单里就用它，否则宿主的第一条。
 *
 * 「存过的还在不在」得自己判：换了网段、拔了网卡之后那个 IP 就不在清单里了，
 * 这时必须退回宿主的第一条（宿主那边的排序同样会退回，见 `orderCandidates`）。
 */
function defaultPreferred(book: AddressBook): string {
  const saved = (book.preferred || '').trim()
  if (saved && book.lan.some((item) => item.address === saved)) return saved
  return book.lan[0]?.address ?? ''
}

/**
 * 接入引导。
 *
 * @param props.onDone 配好之后去哪
 */
export function Onboarding({ onDone }: Props) {
  const [status, setStatus] = useState<StatusView | null>(null)
  const [fatal, setFatal] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [addresses, setAddresses] = useState<AddressBook | null>(null)
  const [pairing, setPairing] = useState<PairingInfo | null>(null)
  /**
   * 二维码里用哪条局域网地址。空串 = 还没选（宿主的地址清单还没回来，或者这台机器一条都没有）。
   * 它最后随 `/api/relay/config` 落成设置项，宿主拿它把二维码里的候选排在最前。
   */
  const [preferred, setPreferred] = useState('')
  /**
   * 这一组里选中的那一条。局域网地址就是它的字面量；另外两个哨兵值：
   * `PUBLIC_RELAY`（走公用中转）与 `OWN_RELAY`（走自建中转，域名在下面填）。
   */
  const [selected, setSelected] = useState('')
  /**
   * 公用中转选中后用哪一条：空串 = 「自动优选」（取测速最快的那条），否则是某条候选的 url。
   */
  const [relayPick, setRelayPick] = useState('')
  /** 公用中转候选的测速结果，按耗时从短到长排（`null` 还在测、`Infinity` 测不通，都排在后面）。 */
  const [probes, setProbes] = useState<RelayProbe[]>([])
  /** 自建中转那栏填的域名。 */
  const [ownRelayUrl, setOwnRelayUrl] = useState('')
  /** 「检查防火墙」弹窗开着没有。里面按系统分三栏给排查步骤，不读本机状态。 */
  const [firewallOpen, setFirewallOpen] = useState(false)
  /** 自建中转「检测」那颗按钮的结论。 */
  const [ownProbe, setOwnProbe] = useState<'idle' | 'busy' | 'ok' | 'failed'>('idle')

  /** 轮询要能被卸载打断，否则关掉页面后它还在打接口。 */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /** 地址清单：决定二维码带哪条，所以它先到、并且取不到不挡路。 */
  useEffect(() => {
    void (async () => {
      try {
        const book = await apiGet<AddressBook>('/api/relay/addresses')
        setAddresses(book)
        const pick = defaultPreferred(book)
        setPreferred(pick)
        // 默认选中本地那条地址；这台机器已经配了中转（relayUrl 非空）就默认落在公用中转上，
        // 否则重开一次引导会把人家正在用的中转悄悄换掉。
        setSelected((current) => current || (status?.relayUrl ? PUBLIC_RELAY : pick))
      } catch {
        setAddresses(null)
      }
    })()
  }, [])

  /** 宿主状态与二维码：进页就取，不等地址清单。 */
  useEffect(() => {
    void (async () => {
      try {
        setStatus(await apiGet<StatusView>('/api/relay/status'))
      } catch (err) {
        setFatal(errorText(err))
      }
      await loadPairing()
    })()
    // 初次挂载跑一次即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上
  }, [])

  /**
   * 进页自动把直连打开一次。等地址清单回来再发，是为了把「二维码里用哪条」一起写进去。
   *
   * 已经开着（`enabled === true`）就不写：这一页每打开一次都重写一遍配置没有必要，
   * 而且用户可能刚在「局域网直连」弹窗里改过什么东西。
   */
  const openedRef = useRef(false)
  useEffect(() => {
    if (openedRef.current) return
    if (addresses === null) return
    openedRef.current = true
    // 全局只自动打开一次，而且只替「局域网直连」做：选了公用中转之后要不要写隧道，
    // 得等用户把地址填完再按按钮，别替他做决定。
    if (status && status.enabled) return
    void connect()
    // `connect` 每次渲染都是新函数，这里只要「地址清单回来那一轮」，别跟它。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上
  }, [addresses, status])

  async function loadPairing() {
    try {
      setPairing(await apiGet<PairingInfo>('/api/relay/pairing'))
    } catch {
      /* 拿不到二维码不挡结论：二维码那块自己会说「没取到」。 */
    }
  }

  /**
   * 公用中转候选的测速：交给宿主去测。
   *
   * 浏览器直连那些域名会被 CORS 挡住 —— `fetch` 抛的是「跨域被拦」，跟「那台不通」长得
   * 一模一样，早先那版就是靠随机数糊过去，用户选到的可能是根本没部署的地址。宿主是本机
   * 进程，出站没有 CORS 问题，它测出来的才是用户实际能连的那条。
   *
   * 测不通的照实报（`ms: null`），排在最后；一条都不通时由下面的 `bestRelayUrl` 兜底成
   * 列表第一条，用户仍可手选——不因为测速失败就把「公用中转」这条路堵死。
   */
  useEffect(() => {
    if (selected !== PUBLIC_RELAY) return
    let cancelled = false
    setProbes(PUBLIC_RELAY_CANDIDATES.map((item) => ({ ...item, ms: null })))
    void (async () => {
      try {
        const result = await apiPost<{ ok: boolean; results: { url: string; ms: number | null }[] }>(
          '/api/relay/probe-relays',
          { urls: PUBLIC_RELAY_CANDIDATES.map((item) => item.url) },
        )
        if (cancelled) return
        const byUrl = new Map(result.results.map((row) => [row.url, row.ms]))
        setProbes((previous) =>
          previous
            .map((row) => ({ ...row, ms: byUrl.get(row.url) ?? null }))
            .sort((a, b) => (a.ms ?? Number.POSITIVE_INFINITY) - (b.ms ?? Number.POSITIVE_INFINITY)),
        )
      } catch {
        if (cancelled) return
        // 探测接口本身没应答：全部标成测不通。这接口是宿主的标配，请求失败就说明
        // 那条链路有问题，照实报比假装「还在测」有用。
        setProbes((previous) => previous.map((row) => ({ ...row, ms: Number.POSITIVE_INFINITY })))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selected])

  /** 这条公用中转实际会用哪一条：自动优选 = 测速最快的那条。 */
  const bestRelayUrl =
    relayPick || probes.find((row) => row.ms !== null && Number.isFinite(row.ms))?.url || probes[0]?.url || ''

  /**
   * 自建中转的「检测」：同样交给宿主去探。
   *
   * 早先这里是 `fetch(value, { mode: 'no-cors' })` —— no-cors 下响应是不透明对象，
   * **不管对面回什么都不会抛**，只要网络层连得上就判「通」。于是用户填错域名、或者
   * 那台根本没部署中转，检测照样亮绿，一直到配对那一步才失败。现在让宿主真去打
   * `/healthz`，并按它回的 service 字段确认对面确实是中转（不是随便一台 web 服务器）。
   */
  async function probeOwnRelay() {
    const value = ownRelayUrl.trim().replace(/\/+$/, '')
    if (!/^https?:\/\/[^\s]+$/i.test(value)) {
      setOwnProbe('failed')
      return
    }
    setOwnProbe('busy')
    try {
      const result = await apiPost<{ ok: boolean; results: { url: string; ms: number | null }[] }>(
        '/api/relay/probe-relays',
        { urls: [value] },
      )
      if (!result.results[0] || result.results[0].ms === null) throw new Error('unreachable')
      setOwnProbe('ok')
    } catch {
      setOwnProbe('failed')
    }
  }

  /** 弹窗里点名用的端口：宿主实际在用的那个（首选端口被占时会退到别的，别写死 18787）。 */
  const lanPortText = String(status?.lan.port || addresses?.port || 18787)
  /**
   * 复制完的回执**放在弹窗里**，不走右上角的胶囊。
   *
   * 胶囊挂在弹窗外那一层，从弹窗里弹出来时会被遮罩糊掉（层级与半透明底两道都试过，
   * 实测仍是一团模糊，见 `docs/decisions.md` 2026-10-10 那两条）。回执本来就该挨着
   * 按下按钮的地方说，所以改成弹窗底部一行字。
   */
  const [copied, setCopied] = useState<'' | 'ok' | 'failed'>('')
  const onCopied = (ok: boolean) => setCopied(ok ? 'ok' : 'failed')

  /** 选的是不是中转那两种（公用 / 自建）：两者的配置写入与状态判据完全一样。 */
  const isRelayMode = selected === PUBLIC_RELAY || selected === OWN_RELAY
  /**
   * 真正要写进 `relayUrl` 的那条：自建中转用用户填的域名，公用中转用选中的候选
   * （自动优选就是测速最快的那条）。公用中转这一版还是 mock，见 `PUBLIC_RELAY_CANDIDATES`。
   */
  const relayUrl = (selected === OWN_RELAY ? ownRelayUrl : bestRelayUrl).trim()

  /** 选中的那条到底通没通：局域网看 lan，中转看隧道。 */
  const readyNow =
    status !== null &&
    (isRelayMode ? status.tunnel.state === 'connected' : status.lan.state === 'listening')

  /**
   * 按下去之后盯到直连真的起来为止：20 秒还没起来就如实说「还没起来」，不装成成功。
   * 好了不存标记 —— 渲染那边直接看 `status`（`readyNow`），存两份就会飘开。
   */
  async function watch() {
    const startedAt = Date.now()
    while (alive.current && Date.now() - startedAt < 20_000) {
      await new Promise((resolve) => window.setTimeout(resolve, 1500))
      if (!alive.current) return
      let current: StatusView
      try {
        current = await apiGet<StatusView>('/api/relay/status')
      } catch {
        continue
      }
      setStatus(current)
      const state = isRelayMode ? current.tunnel.state : current.lan.state
      if (state === 'listening' || state === 'connected' || state === 'error') return
    }
  }

  async function connect() {
    if (busy) return
    setBusy(true)
    setError('')
    // 选了中转就把中转地址写下去，隧道连出去；选局域网地址时留空，隧道压根不启动。
    // 设备名与端口都不写 —— 宿主自己会填宿主机名和默认端口，别把没问过的值写回去。
    const patch: ConfigPatch = {
      relayUrl: isRelayMode ? relayUrl : '',
      lanEnabled: true,
      pairingPolicy: 'code',
    }
    if (preferred) patch.preferredLanAddress = preferred
    try {
      setStatus(await apiPost<StatusView>('/api/relay/config', patch))
      setStatus(await apiPost<StatusView>('/api/relay/toggle', { enabled: true }))
      // 告诉宿主「这台机器走过引导了」，下次打开直接进主页。失败不算这一步失败：
      // 老宿主没有这条路由，二维码照样出得来，只是下次还会再引导一遍。
      await apiPost('/api/relay/onboarded', {}).catch(() => undefined)
      await loadPairing()
      void watch()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 换一条局域网地址：存下去，然后**重取二维码** —— 二维码里带的是地址，不重取就还是旧的。
   * 存失败也照样重取一次，密码学上的选择没落地时至少让屏幕上的是宿主真实吐出来的东西。
   */
  async function pickAddress(address: string) {
    setSelected(address)
    setError('')
    // 两个中转选项都不是网卡地址：它们只改接入方式，不写 `preferredLanAddress`。
    if (address === PUBLIC_RELAY || address === OWN_RELAY) {
      await loadPairing()
      return
    }
    const patch = { preferredLanAddress: address }
    setPreferred(address)
    try {
      await apiPost('/api/relay/config', patch)
    } catch (err) {
      setError(errorText(err))
    }
    await loadPairing()
  }

  const choice = addresses?.lan ?? []
  const publicChoice = addresses?.public ?? []

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
      {fatal ? (
        <Alert className="w-full max-w-2xl" variant="error">
          <AlertIcon />
          <AlertTitle>读不到插件状态</AlertTitle>
          <AlertDescription>{fatal}</AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert className="w-full max-w-2xl" variant="error">
          <AlertIcon />
          <AlertTitle>这一步没成功</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card frame="solid" className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle>用移动设备连上这台 DSH</CardTitle>
        </CardHeader>

        <div className="flex flex-col gap-5 px-4 py-2">
          <div className="flex flex-col items-center gap-3">
            {pairing?.svg ? (
              <div
                className="size-[200px] rounded-lg bg-white p-2 [&_svg]:h-full [&_svg]:w-full"
                // 宿主自己吐的 SVG，不是用户输入。
                dangerouslySetInnerHTML={{ __html: pairing.svg }}
              />
            ) : (
              <div className="flex size-[200px] items-center justify-center rounded-lg border border-border-muted text-xs text-foreground-muted">
                {busy ? <Spinner /> : '没取到二维码'}
              </div>
            )}
            <p className="font-mono text-lg tracking-[0.25em] text-foreground-intense">
              {pairing?.pairingCode ?? status?.pairingCode ?? '—'}
            </p>
          </div>

          {/*
            这一段**一条地址也要出现**（2026-10-10 用户要求）：那一条就是默认选中的，
            用户得先在屏幕上看见二维码里带的是哪个地址。

            两份地址摆在同一块里、分两行（版式照 2026-10 用户给的那张截图）：
              · 局域网那几条**可选** —— 二维码里带的就是选中的那条，其余继续当兜底；
              · 公网那几条**只列不可选**：二维码这一版只带局域网地址，做成可选的只会让人
                以为选了有用（手机不在同一个网络时，它是给人往 App 里手填的参考）。
          */}
          {/* 这一块一直在：公用中转那一条永远可选，哪怕这台机器一条局域网地址都没检测到。 */}
          <div className="rounded-md bg-background-muted px-3 py-2">
              <div className="flex flex-wrap items-baseline gap-1 text-xs text-foreground-muted">
                <span>请选择可访问地址（若 App 无法访问局域网，请</span>
                <button
                  type="button"
                  className="cursor-pointer text-xs text-foreground-intense underline underline-offset-2 hover:text-foreground-strong"
                  onClick={() => {
                    setCopied('')
                    setFirewallOpen(true)
                  }}
                >
                  检查防火墙
                </button>
                <span>）：</span>
              </div>
              <RadioGroup
                className="mt-1.5 gap-1"
                value={selected}
                onValueChange={(value) => void pickAddress(String(value))}
              >
                {choice.map((item) => (
                  <label key={item.address} className="flex cursor-pointer flex-wrap items-baseline justify-between gap-x-3">
                    <span className="flex items-baseline gap-1.5">
                      <Radio value={item.address} aria-label={item.url} />
                      <span className="font-mono text-xs text-foreground">{item.url}</span>
                    </span>
                    <span className="shrink-0 text-xs text-foreground-muted">
                      {item.interface ? `局域网地址 · ${item.interface}` : '局域网地址'}
                    </span>
                  </label>
                ))}
                {/* 公用中转：行里只说「是什么 + 建议临时用」，具体用哪条在下面的列表里。 */}
                <label className="flex cursor-pointer flex-wrap items-baseline justify-between gap-x-3">
                  <span className="flex items-baseline gap-1.5">
                    <Radio value={PUBLIC_RELAY} aria-label="公用中转" />
                    <span className="text-sm text-foreground">公用中转</span>
                  </span>
                  <span className="shrink-0 text-xs text-foreground-muted">公用中转服务·建议临时使用</span>
                </label>
                {/* 自建中转：右侧那颗按钮开仓库的新标签页，点它不该顺手把这一行选中。 */}
                <label className="flex cursor-pointer flex-wrap items-baseline justify-between gap-x-3">
                  <span className="flex items-baseline gap-1.5">
                    <Radio value={OWN_RELAY} aria-label="自建中转" />
                    <span className="text-sm text-foreground">自建中转</span>
                  </span>
                  <a
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                    href={RELAY_REPO_URL}
                    target="_blank"
                    rel="noreferrer noopener"
                    onClick={(event) => event.stopPropagation()}
                  >
                    GitHub 仓库
                  </a>
                </label>
              </RadioGroup>
              {publicChoice.length > 0 ? (
                <ul className="mt-1.5 flex flex-col gap-1">
                  {publicChoice.map((item) => (
                    <li key={item.address} className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="font-mono text-xs text-foreground-muted">{item.url}</span>
                      <span className="shrink-0 text-xs text-foreground-muted">
                        {item.interface ? `公网地址 · ${item.interface}` : '公网地址'}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

          {/*
            公用中转选中之后的地址列表。
            **这一版是 mock**：候选来自 `PUBLIC_RELAY_CANDIDATES`，测速是本地随机延迟，
            真实现时换成宿主吐的入口清单与实测耗时，界面不用动。
            第一项「自动优选」= 取测速最快的那条；后面按耗时从短到长排，测不通的垫底。
          */}
          {selected === PUBLIC_RELAY ? (
            <div className="rounded-md bg-background-muted px-3 py-2">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-xs text-foreground-muted">公用中转地址（按实测耗时排）</p>
                {probes.some((row) => row.ms === null) ? <span className="text-xs text-foreground-muted">测速中…</span> : null}
              </div>
              {/* 高度上限 168px（约四行半）：候选多的时候在框里滚，别把整张卡片顶长。 */}
              <div className="mt-1.5 max-h-[168px] overflow-y-auto">
                <RadioGroup className="gap-1" value={relayPick} onValueChange={(value) => setRelayPick(String(value))}>
                  <label className="flex cursor-pointer flex-wrap items-baseline justify-between gap-x-3">
                    <span className="flex items-baseline gap-1.5">
                      <Radio value="" aria-label="自动优选" />
                      <span className="text-xs text-foreground">自动优选</span>
                    </span>
                    <span className="shrink-0 text-xs text-foreground-muted">取最快的那条</span>
                  </label>
                  {probes.map((row) => (
                    <label key={row.url} className="flex cursor-pointer flex-wrap items-baseline justify-between gap-x-3">
                      <span className="flex items-baseline gap-1.5">
                        <Radio value={row.url} aria-label={row.url} />
                        <span className="font-mono text-xs text-foreground">{row.url}</span>
                      </span>
                      <span className="shrink-0 text-xs text-foreground-muted">
                        {row.ms === null ? '测速中…' : Number.isFinite(row.ms) ? `${row.ms} ms` : '测不通'}
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              </div>
            </div>
          ) : null}

          {/* 自建中转：填自己的域名，右边一颗「检测」。 */}
          {selected === OWN_RELAY ? (
            <Field>
              <FieldLabel htmlFor="ob-own-relay">中转地址</FieldLabel>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <Input
                    inputProps={{ id: 'ob-own-relay', className: 'font-mono' }}
                    value={ownRelayUrl}
                    placeholder="https://你的中转域名"
                    onChange={(event) => {
                      setOwnRelayUrl(event.target.value)
                      setOwnProbe('idle')
                    }}
                  />
                </div>
                <Button className="shrink-0" variant="outline" disabled={ownProbe === 'busy'} onClick={() => void probeOwnRelay()}>
                  {ownProbe === 'busy' ? '检测中' : '检测'}
                </Button>
              </div>
              {ownProbe === 'ok' ? <p className="text-xs text-success">这个地址连得通。</p> : null}
              {ownProbe === 'failed' ? <p className="text-xs text-error">填一个 http:// 或 https:// 开头的地址，并确认那台中转在跑。</p> : null}
            </Field>
          ) : null}

          <InfoList>
            {!isRelayMode ? (
              <InfoRow label="直连">
                <ToneValue tone={lanTone(status?.lan.state ?? 'off', true)} text={lanText(status?.lan.state ?? 'off', true)} />
              </InfoRow>
            ) : (
              <InfoRow label="中转隧道">
                <ToneValue tone={tunnelTone(status?.tunnel.state ?? 'off')} text={tunnelText(status?.tunnel.state ?? 'off')} />
              </InfoRow>
            )}
          </InfoList>

          {/*
            结论只由能观测到的事实决定：宿主这边起没起来，直接看同一份 `status`。
            报错就如实说报错，不装成成功。
          */}
          {status !== null && (!isRelayMode ? status.lan.state === 'error' : status.tunnel.state === 'error') ? (
            <Alert variant="error">
              <AlertIcon />
              <AlertTitle>{!isRelayMode ? '没能开始直连' : '中转没连上'}</AlertTitle>
              <AlertDescription>
                {!isRelayMode
                  ? status.lan.error
                    ? `${status.lan.error}（端口可能被占用，到主页的「局域网直连」里换一个。）`
                    : '直连没起来，端口可能被别的程序占了。'
                  : status.tunnel.error
                    ? `${status.tunnel.error}（检查中转地址填对没有、那台中转是不是在跑。）`
                    : '隧道没建起来，检查中转地址。'}
              </AlertDescription>
            </Alert>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-4">
          {/* 第一次装的人手里还没 App，下载入口摆在这儿，不是等他扫不出来的码才想起来。 */}
          <a
            className={buttonVariants({ variant: 'outline' })}
            href={APP_DOWNLOAD_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            下载 APP
          </a>
          {readyNow ? (
            <Button variant="primary" onClick={() => (onDone ? onDone() : window.location.assign('/'))}>
              进入插件
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={busy || fatal !== '' || (selected === OWN_RELAY && relayUrl === '')}
              onClick={() => void connect()}
            >
              {busy ? '正在打开…' : !isRelayMode ? '打开直连' : '连接中转'}
            </Button>
          )}
        </div>
      </Card>

      {/*
        「检查防火墙」弹窗：手机连不上局域网地址时最常见的原因就是这一步。
        三栏按系统并排（Linux / Mac / Windows），各给一段能直接照抄的排查命令 ——
        这里只讲「怎么确认它确实在放行」，页面自己不去跑这些命令（本机运维界面没有、
        也不该有执行 shell 的能力面，见移动 API 的能力面约定）。
      */}
      <Dialog open={firewallOpen} onOpenChange={setFirewallOpen}>
        <DialogContent className="w-[min(1200px,92vw)] max-w-none" backdropProps={{ className: 'z-[80]' }} viewportProps={{ className: 'z-[80]' }}>
          <DialogHeader>
            <DialogTitle>检查防火墙</DialogTitle>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            <p className="text-sm text-foreground-muted">
              手机连不上这台电脑的直连端口时，多半是电脑这边把端口挡了。直连默认端口{' '}
              <span className="font-mono">18787</span>（首页「局域网直连」里可以改），下面按系统查。
            </p>
            <div className="grid gap-4 md:grid-cols-3">
              <FirewallPane title="Linux" steps={FIREWALL_LINUX} port={lanPortText} onCopied={onCopied} />
              <FirewallPane title="Mac" steps={FIREWALL_MAC} port={lanPortText} onCopied={onCopied} />
              <FirewallPane title="Windows" steps={FIREWALL_WINDOWS} port={lanPortText} onCopied={onCopied} />
            </div>
          </DialogBody>
          <DialogFooter className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-foreground-muted">
              {copied === 'ok' ? '已复制，粘贴给你的 AI 就行。' : null}
              {copied === 'failed' ? '复制失败，可以手动选中内容复制。' : null}
            </span>
            <Button variant="primary" onClick={() => setFirewallOpen(false)}>
              知道了
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}


/** 三栏排查步骤。命令照抄就能用；`cmd` 为真时按等宽字体摆。 */
const FIREWALL_LINUX: { text: string; cmd?: boolean }[] = [
  { text: '1. 看防火墙状态（firewalld 或 ufw，装哪个查哪个）：' },
  { text: 'systemctl status firewalld', cmd: true },
  { text: 'sudo ufw status', cmd: true },
  { text: '2. 放行直连端口：' },
  { text: 'sudo firewall-cmd --permanent --add-port={port}/tcp\nsudo firewall-cmd --reload', cmd: true },
  { text: 'sudo ufw allow {port}/tcp', cmd: true },
  { text: '3. 云服务器还要去服务商控制台的安全组里放行同一个端口 —— 这台机器上查不到。' },
]

const FIREWALL_MAC: { text: string; cmd?: boolean }[] = [
  { text: '1. 看应用防火墙是不是开着：' },
  { text: '/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate', cmd: true },
  { text: '2. 开着的话，在「系统设置 → 网络 → 防火墙 → 选项」里把 DSH / node 设成「允许传入连接」；排查时可以整个关掉：' },
  { text: 'sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate off', cmd: true },
  { text: '3. 同一 Wi-Fi 还连不上：确认手机和电脑真在同一个网段，别连到访客网络。' },
]

const FIREWALL_WINDOWS: { text: string; cmd?: boolean }[] = [
  { text: '1. 在 PowerShell（管理员）里看防火墙配置文件：' },
  { text: 'Get-NetFirewallProfile | Select-Object Name, Enabled', cmd: true },
  { text: '2. 放行直连端口：' },
  { text: 'New-NetFirewallRule -DisplayName "DSH Mobile {port}" -Direction Inbound -LocalPort {port} -Protocol TCP -Action Allow', cmd: true },
  { text: '3. 如果以前给 node 配过拒绝规则，记得把那条 Block 删掉；网络类型选「专用」而不是「公用」。' },
]

/**
 * 「点我复制」复制出去的那段话。**三栏复制的是同一份**：它不是哪一栏的内容，
 * 而是一封给 AI 的委托信 —— 先说清在做什么、卡在哪、要 AI 回答什么问题。
 *
 * 这里**不写具体地址和端口**（2026-10-10 用户要求）：地址每台机器都不同、端口被占时还会
 * 自动换，写死在文案里比不写更容易误导；改成让 AI 去引导页看，并强调「是局域网地址」。
 */
function aiCheckPrompt(): string {
  return [
    '帮我排查一个问题。',
    '',
    '我的情况：电脑上装了 DSH（DeepSeek Harness）的移动端插件，手机 App 通过局域网直连连不上这台电脑。',
    '手机上填的地址是这台电脑的局域网地址加端口（具体的地址和端口你需要到移动端插件的那个网页里看，注意是局域网地址）。',
    '电脑这边显示插件已经在监听，但手机连不上。我判断是电脑的防火墙（或者云服务器的安全组）把这个端口挡了。',
    '',
    '请你：',
    '1. 先确认我的系统是 Linux、macOS 还是 Windows（不确定就问我，或者告诉我怎么确认）。',
    '2. 按属于我这一套的步骤逐条检查，告诉我那个端口现在通不通、卡在哪一步。',
    '3. 给出具体该执行的命令或点击路径，把端口放行；需要管理员权限的地方明确说明。',
    '4. 最后告诉我怎么验证已经通了（比如用哪条命令从本机、从手机分别确认）。',
    '',
    '补充：如果这台电脑是云服务器，服务商控制台里的安全组/防火墙也要放行同一个端口，这一项在本机查不到。',
  ].join('\n')
}

/**
 * 弹窗里的一栏：标题居中 + 若干条步骤（命令按等宽块摆）+ 底部一颗「复制给 AI」的按钮。
 *
 * 三栏的按钮复制的是**同一份** `aiCheckPrompt()`：它是一封给 AI 的委托信，不是这一栏的
 * 内容（见那个函数的注释）。这三个按钮是「同一件事的三个入口」，谁按都一样。
 */
function FirewallPane({
  title,
  steps,
  port,
  onCopied,
}: {
  title: string
  steps: { text: string; cmd?: boolean }[]
  port: string
  onCopied: (ok: boolean) => void
}) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(aiCheckPrompt())
      onCopied(true)
    } catch {
      onCopied(false)
    }
  }

  return (
    <section className="flex flex-col gap-1.5 rounded-lg border border-border-muted bg-background-muted p-3">
      <h3 className="text-center text-sm font-semibold text-foreground-intense">{title}</h3>
      {steps.map((step) =>
        step.cmd ? (
          <pre
            key={step.text}
            className="overflow-x-auto rounded bg-background-subtle px-2 py-1.5 font-mono text-[11px] leading-5 whitespace-pre text-foreground-strong"
          >
            {step.text.replace(/\{port\}/g, port)}
          </pre>
        ) : (
          <p key={step.text} className="text-xs leading-5 text-foreground-muted">
            {step.text.replace(/\{port\}/g, port)}
          </p>
        ),
      )}
      {/* 底部对齐：三栏步骤长短不一，按钮仍落在同一水平线上。 */}
      <Button className="mt-auto" variant="outline" size="sm" onClick={() => void copy()}>
        点我复制内容，让自己的 AI 去检查
      </Button>
    </section>
  )
}

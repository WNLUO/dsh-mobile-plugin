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

import { DownloadAppButton } from './components/DownloadAppButton.tsx'
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
import { PUBLIC_RELAYS } from './lib/links.ts'
import { t } from './lib/i18n/index.ts'

/** 地址组里「公用中转」那一条的哨兵值：它不是地址，选它等于选「走中转」。 */
const PUBLIC_RELAY = 'public-relay'
/** 「自建中转」同理：选它之后由用户在下面填自己的域名。 */
const OWN_RELAY = 'own-relay'
/**
 * 「局域网直连」那一行：具体走哪条网卡地址在旁边的弹窗里选，这个值本身不是地址。
 * 以前它是地址字面量（一行一条网卡地址），机器有四五条地址时那一组全是 IP，
 * 光看也分不出哪个是「现在要用的那条」。
 */
const LAN_DIRECT = 'lan-direct'

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
type RelayProbe = { nameKey: string; url: string; ms: number | null }

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
  /** IPv6 那几条默认收起：它们只是「手机自己会比」，几条长地址摊开会把整块地址区淹掉。 */
  const [ipv6Open, setIpv6Open] = useState(false)
  /** 「选择地址」那颗按钮开的弹窗：机器有好几条网卡地址时，只有在这能看清并换掉走哪条。 */
  const [lanDialogOpen, setLanDialogOpen] = useState(false)
  /**
   * 进页自动体检这台机器正在用的那个中转：`null` 还没查完、`true` 通、`false` 不通。
   * 不通要把底部那颗按钮拦掉 —— 带着一条死路往下走，用户到手机那一步才发现白配一场。
   */
  const [inheritedRelayOk, setInheritedRelayOk] = useState<boolean | null>(null)
  /**
   * 自建中转地址的**预览**二维码：按这个候选生成，但一个字都不落盘。
   * 这一栏既不预填插件里已有的地址，也不在打字时写配置 —— 写配置只有「进入插件」那一处
   * （2026-10-24 用户要求：输入框别读已有配置、也别动它）。
   */
  const [previewSvg, setPreviewSvg] = useState('')

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
        setSelected((current) => current || (status?.relayUrl ? PUBLIC_RELAY : LAN_DIRECT))
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

  /**
   * 自建中转地址：停手 600ms 自动探一次，探通了就把二维码按它生成出来（只是预览）。
   * 写配置不在这里 —— 打字不动配置，落盘只发生在按「进入插件」时。
   */
  useEffect(() => {
    if (selected !== OWN_RELAY) return
    const value = ownRelayUrl.trim().replace(/\/+$/, '')
    if (!value) {
      setOwnProbe('idle')
      return
    }
    if (!/^https?:\/\/[^\s]+$/i.test(value)) return
    const applied = (status?.relayUrl ?? '').trim().replace(/\/+$/, '')
    if (value === applied && status?.tunnel.state === 'connected') {
      setOwnProbe('ok')
      return
    }
    const timer = window.setTimeout(() => {
      void previewOwnRelay(value)
    }, 600)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只认输入停顿
  }, [ownRelayUrl, selected])

  /**
   * 进页自动体检这台机器正在用的中转（用户 2026-10-24 要求：进插件就先查一次，有问题拦下来）。
   *
   * 只探「不是公用候选」的那条：公用入口有自己那套测速，重复探没有意义。
   * **不**把这条地址填进「自建中转」那栏 —— 那一栏归用户自己填，不替他从配置里抄。
   */
  useEffect(() => {
    const saved = (status?.relayUrl ?? '').trim()
    if (!saved) return
    if (inheritedRelayOk !== null) return
    let cancelled = false
    void (async () => {
      const ok = await probeRelayAddress(saved.replace(/\/+$/, ''))
      if (cancelled) return
      setInheritedRelayOk(ok)
      if (!ok) setError(t('panel.onboarding.recheckSaved', { url: saved }))
    })()
    return () => {
      cancelled = true
    }
    // 只在「本机已配中转」时体检一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上
  }, [status?.relayUrl])

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
  /**
   * 探一个中转地址通不通：交给宿主真去打它的 `/healthz`。
   *
   * 自设 8 秒上限：域名打错时 DNS 要磨很久，接口不回就一直「检测中」，
   * 按钮永远点不动。超时按「不通」算，比无限等更接近用户想知道的答案。
   */
  async function probeRelayAddress(value: string): Promise<boolean> {
    try {
      const result = await Promise.race([
        apiPost<{ ok: boolean; results: { url: string; ms: number | null }[] }>('/api/relay/probe-relays', {
          urls: [value],
        }),
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 8000)),
      ])
      if (!result) return false
      return Boolean(result.results[0] && result.results[0].ms !== null)
    } catch {
      return false
    }
  }

  /** 「检测」那颗按钮：想点就点，只更新结论，不写配置。 */
  async function probeOwnRelay() {
    const value = ownRelayUrl.trim().replace(/\/+$/, '')
    if (!/^https?:\/\/[^\s]+$/i.test(value)) {
      setOwnProbe('failed')
      return
    }
    setOwnProbe('busy')
    setOwnProbe((await probeRelayAddress(value)) ? 'ok' : 'failed')
  }

  /** 输入框一改，上一次的检测结论立即作废。 */
  function onOwnRelayChange(next: string) {
    setOwnRelayUrl(next)
    setOwnProbe('idle')
  }

  /**
   * 自建中转「填完就出二维码」：地址停手 600ms 探一次，探通了按它生成一张**预览**码。
   *
   * 为什么必须先探通：这张码指向哪台中转，用户扫下去就是真的连过去。探不通就不出码，
   * 免得把一张指向死路的码摆在那儿。
   * 为什么一个字都不写盘：这个页面直接操作正在用的插件，随手敲一个半截域名就落进配置的话，
   * 等于把用户正在跑的隧道改成一条死路（2026-10-24 用户踩到）。落盘只有按「进入插件」那一处。
   * 为什么等 600ms：逐字发请求既拖慢输入，也会把敲到一半的域名报成「连不通」。
   */
  async function previewOwnRelay(value: string) {
    setOwnProbe('busy')
    setError('')
    const reachable = await probeRelayAddress(value)
    if (ownRelayUrl.trim().replace(/\/+$/, '') !== value) return // 探测期间又改了，丢弃这次结论
    if (!reachable) {
      setPreviewSvg('')
      setOwnProbe('failed')
      setError(t('panel.onboarding.relayNoAnswer', { value }))
      return
    }
    setOwnProbe('ok')
    // 只取预览：`?relayUrl=` 让宿主按这个候选生成一次二维码，不改任何配置。
    try {
      const info = await apiGet<PairingInfo>(`/api/relay/pairing?relayUrl=${encodeURIComponent(value)}`)
      setPreviewSvg(info.svg ?? '')
    } catch {
      setPreviewSvg('')
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
   * 有没有必须先解决的问题：进页体检发现本机正在用的那条中转连不上。
   * 只有在走公用中转时才拦 —— 那时用户是要接着用那条死路；选自建中转不受影响，
   * 因为「进入插件」会按新填的地址重探、重写，旧的那条本来就要被换掉。
   */
  const blocked = selected === PUBLIC_RELAY && inheritedRelayOk === false

  /** 选中的那条到底通没通：局域网看 lan，中转看隧道。 */
  const readyNow =
    status !== null &&
    (isRelayMode ? status.tunnel.state === 'connected' : status.lan.state === 'listening')

  /**
   * 按下去之后盯到直连真的起来为止：20 秒还没起来就如实说「还没起来」，不装成成功。
   * 好了不存标记 —— 渲染那边直接看 `status`（`readyNow`），存两份就会飘开。
   */
  async function watch(relayMode: boolean = isRelayMode) {
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
      const state = relayMode ? current.tunnel.state : current.lan.state
      if (state === 'listening' || state === 'connected' || state === 'error') return
    }
  }

  /**
   * 把「局域网直连 / 公网候选 / 公用中转」这几种选择落到宿主上：写配置 → 打开远程控制 → 重取二维码。
   *
   * 底部那颗按钮和「切换接入方式」走的是同一份：以前只有按钮会写配置，切单选只换界面，
   * 于是用户切到中转时二维码还是老样子（2026-10-24 用户报的就是这个）。现在两边都走这里，
   * 切一下等于按一下。**自建中转不走这里** —— 那一栏的地址要等按「进入插件」时才探、才写。
   */
  async function applySelection(mode: string, toggle: boolean) {
    if (busy) return
    setBusy(true)
    setError('')
    const relayMode = mode === PUBLIC_RELAY
    // 测速还没回来时 `bestRelayUrl` 是空串：不能就这样写下去，否则配置里的中转地址被清掉、
    // 隧道永远起不来（表现就是「切了中转，二维码一点没变」）。退回清单第一条。
    const target = (relayMode ? bestRelayUrl || PUBLIC_RELAYS[0]?.url || '' : '').trim()
    // 设备名与端口都不写 —— 宿主自己会填宿主机名和默认端口，别把没问过的值写回去。
    const patch: ConfigPatch = {
      // 局域网直连 = 清掉中转地址，隧道压根不启动；中转 = 把选中的那条写下去。
      relayUrl: target,
      lanEnabled: true,
      pairingPolicy: 'code',
    }
    if (preferred) patch.preferredLanAddress = preferred
    try {
      setStatus(await apiPost<StatusView>('/api/relay/config', patch))
      if (toggle) {
        setStatus(await apiPost<StatusView>('/api/relay/toggle', { enabled: true }))
        // 告诉宿主「这台机器走过引导了」，下次打开直接进主页。失败不算这一步失败：
        // 老宿主没有这条路由，二维码照样出得来，只是下次还会再引导一遍。
        await apiPost('/api/relay/onboarded', {}).catch(() => undefined)
      }
      setSelected(mode)
      await loadPairing()
      if (toggle) void watch(relayMode)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  /** 底部那颗按钮：按当前选择连一次。 */
  async function connect() {
    await applySelection(selected, true)
  }

  /** 进插件：引导过了就直接去主页，没指定去向就跳根路径。 */
  function enterNow() {
    if (onDone) onDone()
    else window.location.assign('/')
  }

  /**
   * 「进入插件」：自建中转这一栏只有这一处会写配置。
   *
   * 顺序是「先探、再写、最后进」——
   *   · 探不通就停在这儿报错，插件里正在用的配置一个字都不动；
   *   · 探通了才把这条域名写进配置、开隧道、记下「走过引导」，然后进插件。
   * 已经是配置里那条且隧道连着，就没什么可写的，直接进。
   */
  async function enterPlugin() {
    const value = ownRelayUrl.trim().replace(/\/+$/, '')
    if (!value) return
    const applied = (status?.relayUrl ?? '').trim().replace(/\/+$/, '')
    if (selected === OWN_RELAY && value === applied && status?.tunnel.state === 'connected') {
      enterNow()
      return
    }
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const ok = await probeRelayAddress(value)
      if (!ok) {
        setOwnProbe('failed')
        setPreviewSvg('')
        setError(t('panel.onboarding.relayNoAnswerUnsaved', { value }))
        return
      }
      setOwnProbe('ok')
      const patch: ConfigPatch = { relayUrl: value, lanEnabled: true, pairingPolicy: 'code' }
      if (preferred) patch.preferredLanAddress = preferred
      setStatus(await apiPost<StatusView>('/api/relay/config', patch))
      setStatus(await apiPost<StatusView>('/api/relay/toggle', { enabled: true }))
      await apiPost('/api/relay/onboarded', {}).catch(() => undefined)
      setSelected(OWN_RELAY)
      await loadPairing()
      enterNow()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 切换接入方式即生效：写配置、需要的话把远程控制打开、重取二维码。
   *
   * 自建中转例外：切过去只记住选择，**一个字都不写** —— 那一栏填什么由用户定，
   * 要等到按「进入插件」、地址探通了才落盘。
   */
  async function pickAddress(value: string) {
    if (value === OWN_RELAY) {
      setSelected(value)
      setError('')
      return
    }
    await applySelection(value, true)
  }

  /**
   * 换一条具体的局域网地址：存下去，然后**重取二维码** —— 二维码里带的是地址，不重取就还是旧的。
   * 存失败也照样重取一次：选择没落地时，至少让屏幕上的是宿主真实吐出来的东西。
   */
  async function pickLanAddress(address: string) {
    const patch: ConfigPatch = { preferredLanAddress: address }
    // 从这里选地址等于「就走局域网直连」：原先在中转模式上就把中转地址清掉，
    // 否则二维码里还挂着那条中转，界面说直连、码里却不是。
    if (isRelayMode) patch.relayUrl = ''
    setPreferred(address)
    setSelected(LAN_DIRECT)
    setError('')
    try {
      await apiPost('/api/relay/config', patch)
    } catch (err) {
      setError(errorText(err))
    }
    setLanDialogOpen(false)
    await loadPairing()
  }

  const choice = addresses?.lan ?? []
  /** 现在生效的那条：用户选过的优先，没有就用宿主给的第一条（与 `defaultPreferred` 同口径）。 */
  const currentLanAddress = (() => {
    const address = preferred || choice[0]?.address || ''
    return choice.find((item) => item.address === address)?.url ?? address
  })()
  /**
   * 自建中转还没填地址：这时压根没有能写进二维码的中转地址。
   * 屏幕上那张码是上一次配置（多半是局域网）留下的，摆着就会让人以为现在能扫 —— 宁可不画。
   */
  const needsOwnRelayAddress = selected === OWN_RELAY && ownRelayUrl.trim() === ''
  /**
   * 自建中转的地址改过但还没连：这时屏幕上的码是**上一次**那条中转生成的，扫了只会连到旧地址。
   * 与「还没填」分开，因为要说的下一步不一样（一个去填、一个去按按钮）。
   */
  const relayAddressNotApplied =
    selected === OWN_RELAY &&
    ownRelayUrl.trim() !== '' &&
    ownRelayUrl.trim().replace(/\/+$/, '') !== (status?.relayUrl ?? '').trim().replace(/\/+$/, '')
  /** 二维码现在能不能信：不能的话换成一句说明，别摆一张指向旧配置的码。 */
  const qrBlocked = needsOwnRelayAddress || (relayAddressNotApplied && !previewSvg)
  /** 自建中转里「探通了但还没写入配置」：这时显示的是预览码，要标出来。 */
  const showingPreview = selected === OWN_RELAY && relayAddressNotApplied && previewSvg !== ''
  const qrSvg = showingPreview ? previewSvg : pairing?.svg ?? ''
  /**
   * 选了自建中转时，左栏那一行说的是**你填的这个地址**，不是本机正在跑的那条隧道。
   *
   * 早先这里直接报宿主 `status.tunnel`，于是刚打开页面、输入框还空着就写着「已连接」——
   * 那个「已连接」跟这一栏毫无关系，是上一次配置里那条中转在跑（2026-10-24 用户截图报的）。
   * 只有「填的这条正好就是配置里那条」时，隧道状态才是这一栏的实话。
   */
  const ownRelayRow = (() => {
    const value = ownRelayUrl.trim().replace(/\/+$/, '')
    if (value === '') return { tone: 'off' as const, text: t('panel.onboarding.probe.empty') }
    if (ownProbe === 'busy') return { tone: 'warn' as const, text: t('panel.onboarding.probe.busy') }
    const applied = (status?.relayUrl ?? '').trim().replace(/\/+$/, '')
    if (value === applied) {
      const state = status?.tunnel.state ?? 'off'
      return { tone: tunnelTone(state), text: tunnelText(state) }
    }
    if (ownProbe === 'ok') return { tone: 'ok' as const, text: t('panel.onboarding.probe.ok') }
    if (ownProbe === 'failed') return { tone: 'error' as const, text: t('panel.onboarding.probe.failed') }
    return { tone: 'off' as const, text: t('panel.onboarding.probe.idle') }
  })()
  const publicChoice = addresses?.public ?? []
  // 第三份：IPv6 全球单播。只能看 —— 谁快由手机侧实测决定（见 AddressPicker 的文件头）。
  const ipv6Choice = addresses?.ipv6 ?? []

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
      {fatal ? (
        <Alert className="w-full max-w-2xl" variant="error">
          <AlertIcon />
          <AlertTitle>{t('panel.onboarding.statusFailed')}</AlertTitle>
          <AlertDescription>{fatal}</AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert className="w-full max-w-2xl" variant="error">
          <AlertIcon />
          <AlertTitle>{t('panel.onboarding.stepFailed')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card frame="solid" className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle>{t('panel.onboarding.title')}</CardTitle>
        </CardHeader>

        {/* 面板宽的时候二维码和地址分两栏：左边是「要扫的东西 + 现在通没通」，右边只剩
            「手机连哪条」。夹在侧栏里（窄屏）自动叠回一列，从上到下顺序不变。 */}
        <div className="grid gap-6 px-4 pb-2 md:grid-cols-[212px_1fr]">
          <div className="flex flex-col items-center gap-3">
            {qrBlocked ? (
              <div className="flex size-[200px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-muted px-5 text-center">
                {needsOwnRelayAddress ? (
                  <>
                    <span className="text-xs text-foreground-muted">{t('panel.onboarding.qrAfterRelay')}</span>
                    <span className="text-xs text-foreground-muted">{t('panel.onboarding.qrAfterRelayLine2')}</span>
                  </>
                ) : (
                  <span className="text-xs text-foreground-muted">{t('panel.onboarding.qrAfterAddress')}</span>
                )}
              </div>
            ) : qrSvg ? (
              <div
                className="size-[200px] rounded-lg bg-white p-2 [&_svg]:h-full [&_svg]:w-full"
                // 宿主自己吐的 SVG，不是用户输入。
                dangerouslySetInnerHTML={{ __html: qrSvg }}
              />
            ) : (
              <div className="flex size-[200px] items-center justify-center rounded-lg border border-border-muted text-xs text-foreground-muted">
                {busy ? <Spinner /> : t('panel.onboarding.noQr')}
              </div>
            )}
            {qrBlocked ? null : (
              <p className="font-mono text-lg tracking-[0.25em] text-foreground-intense">
                {pairing?.pairingCode ?? status?.pairingCode ?? '—'}
              </p>
            )}

            {/* 中转还没连上时二维码里只有局域网地址：中转地址要隧道真连出去才写进码里，
                不然手机扫到的是一条通不了的路。 */}
            {showingPreview ? (
              <p className="text-center text-xs text-foreground-muted">
                {t('panel.onboarding.preview')}
              </p>
            ) : isRelayMode && !readyNow && !qrBlocked ? (
              <p className="text-center text-xs text-foreground-muted">{t('panel.onboarding.relayNotConnected')}</p>
            ) : null}

            {/* 连接结论贴着二维码放：左边这一栏回答的是「现在能不能连」，右边回答「连哪条」。 */}
            <div className="w-full">
              <InfoList>
                {!isRelayMode ? (
                  <InfoRow label={t('panel.onboarding.direct')}>
                    <ToneValue tone={lanTone(status?.lan.state ?? 'off', true)} text={lanText(status?.lan.state ?? 'off', true)} />
                  </InfoRow>
                ) : selected === OWN_RELAY ? (
                  <InfoRow label={t('panel.onboarding.thisAddress')}>
                    <ToneValue tone={ownRelayRow.tone} text={ownRelayRow.text} />
                  </InfoRow>
                ) : (
                  <InfoRow label={t('panel.connection.tunnel')}>
                    <ToneValue tone={tunnelTone(status?.tunnel.state ?? 'off')} text={tunnelText(status?.tunnel.state ?? 'off')} />
                  </InfoRow>
                )}
              </InfoList>
            </div>

            {/*
              结论只由能观测到的事实决定：宿主这边起没起来，直接看同一份 `status`。
              报错就如实说报错，不装成成功。
            */}
            {status !== null && (!isRelayMode ? status.lan.state === 'error' : status.tunnel.state === 'error') ? (
              <Alert variant="error">
                <AlertIcon />
                <AlertTitle>{!isRelayMode ? t('panel.onboarding.lanFailed') : t('panel.onboarding.relayFailed')}</AlertTitle>
                <AlertDescription>
                  {!isRelayMode
                    ? status.lan.error
                      ? t('panel.onboarding.lanErrorWithPort', { error: status.lan.error })
                      : t('panel.onboarding.lanNoStart')
                    : status.tunnel.error
                      ? t('panel.onboarding.tunnelErrorHint', { error: status.tunnel.error })
                      : t('panel.onboarding.tunnelNoStart')}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>

          {/*
            这一段**一条地址也要出现**（2026-10-10 用户要求）：那一条就是默认选中的，
            用户得先在屏幕上看见二维码里带的是哪个地址。

            地址分两层（2026-10-24 重排）：
              · 上格「手机连哪条」= 真会写进配置的那几条，可选 —— 局域网、公用中转、自建中转；
              · 下格「仅供参考」= 公网与 IPv6，只列不可选：前者是手机不在同一网络时手填的参考，
                后者谁更快由手机侧实测决定。两层之间用一条分隔线断开，不再靠行尾那串小字区分。
            行尾只留网卡名，不再每行重复「局域网地址」「IPv6 直连」这些前缀。
          */}
          <div className="flex min-w-0 flex-col gap-3">
            <div className="rounded-lg border border-border-muted">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border-muted px-3 py-2">
                <p className="text-xs text-foreground-muted">{t('panel.onboarding.pickAddress')}</p>
                <button
                  type="button"
                  className="cursor-pointer text-xs text-foreground-intense underline underline-offset-2 hover:text-foreground-strong"
                  onClick={() => {
                    setCopied('')
                    setFirewallOpen(true)
                  }}
                >
                  {t('panel.onboarding.checkFirewall')}
                </button>
              </div>

              <div className="px-3 py-2.5">
                <RadioGroup
                  className="gap-1"
                  value={selected}
                  onValueChange={(value) => void pickAddress(String(value))}
                >
                  {/* 局域网直连：这一行只说「走局域网」，具体哪张网卡在右边那颗按钮里挑 ——
                      机器有好几条地址时，组里一排 IP 只会让人分不清哪条是现在生效的。 */}
                  <div className="flex flex-wrap items-center justify-between gap-x-3">
                    <label className="flex cursor-pointer items-center gap-1.5">
                      <Radio value={LAN_DIRECT} aria-label={t('panel.onboarding.lanDirect')} />
                      <span className="text-sm text-foreground">{t('panel.onboarding.lanDirect')}</span>
                    </label>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={choice.length === 0}
                      onClick={() => setLanDialogOpen(true)}
                    >
                      {t('panel.onboarding.chooseAddress')}
                    </Button>
                  </div>
                  {/* 公用中转：行里只说「是什么 + 建议临时用」，具体用哪条在下面的列表里。 */}
                  <label className="flex cursor-pointer flex-wrap items-baseline justify-between gap-x-3">
                    <span className="flex items-baseline gap-1.5">
                      <Radio value={PUBLIC_RELAY} aria-label={t('panel.onboarding.publicRelay')} />
                      <span className="text-sm text-foreground">{t('panel.onboarding.publicRelay')}</span>
                    </span>
                    <span className="shrink-0 text-xs text-foreground-muted">{t('panel.onboarding.publicRelayTemporary')}</span>
                  </label>
                  {/* 自建中转：右侧那颗按钮开仓库的新标签页，点它不该顺手把这一行选中。 */}
                  <label className="flex cursor-pointer flex-wrap items-baseline justify-between gap-x-3">
                    <span className="flex items-baseline gap-1.5">
                      <Radio value={OWN_RELAY} aria-label={t('panel.onboarding.ownRelay')} />
                      <span className="text-sm text-foreground">{t('panel.onboarding.ownRelay')}</span>
                    </span>
                    <a
                      className={buttonVariants({ variant: 'outline', size: 'sm' })}
                      href={RELAY_REPO_URL}
                      target="_blank"
                      rel="noreferrer noopener"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {t('panel.onboarding.githubRepo')}
                    </a>
                  </label>
                </RadioGroup>

                {/*
                  下面这一块只在「局域网直连」下出现：走中转时局域网哪条根本没参与，
                  摆一个「当前选择的局域网地址」只会让人以为中转也要挑网卡。
                */}
                {selected === LAN_DIRECT ? (
                <div className="mt-3 border-t border-border-muted pt-2.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-xs text-foreground-muted">{t('panel.onboarding.currentLan')}</span>
                    <span className="min-w-0 text-right font-mono text-xs break-all text-foreground">
                      {currentLanAddress || '—'}
                    </span>
                  </div>

                {publicChoice.length > 0 || ipv6Choice.length > 0 ? (
                  <div className="mt-2">
                    {publicChoice.length > 0 ? (
                      <ul className="mt-1 flex flex-col gap-1">
                        {publicChoice.map((item) => (
                          <li key={item.address} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3">
                            <span className="min-w-0 font-mono text-xs break-all text-foreground-muted">{item.url}</span>
                            <span className="shrink-0 text-xs text-foreground-muted">{item.interface ?? t('panel.onboarding.public')}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {/*
                      IPv6 那份默认收起：几条长地址摊开就是把这块淹掉，而这里想说的只有一句
                      「这台机器有，手机自己会比」。展开仍按原样列出，照旧不给单选圈。
                    */}
                    {ipv6Choice.length > 0 ? (
                      <div className="mt-1">
                        <button
                          type="button"
                          className="flex w-full cursor-pointer items-baseline justify-between gap-3 rounded px-1 py-1 text-left hover:bg-background-muted"
                          aria-expanded={ipv6Open}
                          onClick={() => setIpv6Open((value) => !value)}
                        >
                          <span className="text-xs text-foreground-muted">
                            {t('panel.onboarding.ipv6More', { count: ipv6Choice.length })}
                          </span>
                          <span className="shrink-0 text-xs text-foreground-intense">{ipv6Open ? t('panel.onboarding.collapse') : t('panel.onboarding.expand')}</span>
                        </button>
                        {ipv6Open ? (
                          <ul className="mt-1 flex flex-col gap-1">
                            {ipv6Choice.map((item) => (
                              <li key={item.address} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3">
                                <span className="min-w-0 font-mono text-xs break-all text-foreground-muted">{item.url}</span>
                                <span className="shrink-0 text-xs text-foreground-muted">{item.interface ?? 'IPv6'}</span>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                </div>
                ) : null}
              </div>
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
                  <p className="text-xs text-foreground-muted">{t('panel.onboarding.relayListTitle')}</p>
                  {probes.some((row) => row.ms === null) ? <span className="text-xs text-foreground-muted">{t('panel.onboarding.probing')}</span> : null}
                </div>
                {/* 高度上限 168px（约四行半）：候选多的时候在框里滚，别把整张卡片顶长。 */}
                <div className="mt-1.5 max-h-[168px] overflow-y-auto">
                  <RadioGroup className="gap-1" value={relayPick} onValueChange={(value) => setRelayPick(String(value))}>
                    <label className="flex cursor-pointer flex-wrap items-baseline justify-between gap-x-3">
                      <span className="flex items-baseline gap-1.5">
                        <Radio value="" aria-label={t('panel.onboarding.autoBest')} />
                        <span className="text-xs text-foreground">{t('panel.onboarding.autoBest')}</span>
                      </span>
                      <span className="shrink-0 text-xs text-foreground-muted">{t('panel.onboarding.autoBestHint')}</span>
                    </label>
                    {probes.map((row) => (
                      <label key={row.url} className="flex cursor-pointer flex-wrap items-baseline justify-between gap-x-3">
                        <span className="flex items-baseline gap-1.5">
                          <Radio value={row.url} aria-label={row.url} />
                          <span className="font-mono text-xs text-foreground">{row.url}</span>
                        </span>
                        <span className="shrink-0 text-xs text-foreground-muted">
                          {row.ms === null ? t('panel.onboarding.probing') : Number.isFinite(row.ms) ? `${row.ms} ms` : t('panel.onboarding.probeUnreachable')}
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
                <FieldLabel htmlFor="ob-own-relay">{t('panel.onboarding.relayAddressHint')}</FieldLabel>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <Input
                      inputProps={{ id: 'ob-own-relay', className: 'font-mono' }}
                      value={ownRelayUrl}
                      placeholder={t('panel.onboarding.relayPlaceholder')}
                      onChange={(event) => onOwnRelayChange(event.target.value)}
                    />
                  </div>
                  <Button className="shrink-0" variant="outline" disabled={ownProbe === 'busy'} onClick={() => void probeOwnRelay()}>
                    {ownProbe === 'busy' ? t('panel.onboarding.probe.busy') : t('panel.onboarding.check')}
                  </Button>
                </div>
                {ownProbe === 'ok' ? <p className="text-xs text-success">{t('panel.onboarding.probe.okWithHint')}</p> : null}
                {ownProbe === 'failed' ? (
                  <p className="text-xs text-error">
                    这个地址连不上，二维码不会生成。确认它是 http:// 或 https:// 开头、那台中转在运行、域名解析到它。
                  </p>
                ) : null}
              </Field>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-4">
          {/* 第一次装的人手里还没 App，下载入口摆在这儿，不是等他扫不出来的码才想起来。 */}
          <DownloadAppButton />
          {/* 自建中转这一栏只有这颗按钮会写配置：点下去先探一遍，通了才落盘、才进插件。 */}
          {selected === OWN_RELAY ? (
            <Button
              variant="primary"
              disabled={busy || fatal !== '' || blocked || ownRelayUrl.trim() === ''}
              onClick={() => void enterPlugin()}
            >
              {busy
                ? t('panel.onboarding.connecting')
                : blocked
                  ? t('panel.onboarding.fixFirst')
                  : needsOwnRelayAddress
                    ? t('panel.onboarding.fillRelayFirst')
                    : t('panel.onboarding.enterPlugin')}
            </Button>
          ) : readyNow && !blocked ? (
            <Button variant="primary" onClick={enterNow}>
              {t('panel.onboarding.enterPlugin')}
            </Button>
          ) : (
            // 有必须先解决的问题时不给点：隧道可能还连着上一次的配置，放着不管会让人带着一条死路往下走。
            <Button variant="primary" disabled={busy || fatal !== '' || blocked} onClick={() => void connect()}>
              {busy
                ? t('panel.onboarding.opening')
                : blocked
                  ? t('panel.onboarding.fixFirst')
                  : !isRelayMode
                    ? t('panel.onboarding.openDirect')
                    : t('panel.onboarding.connectRelay')}
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
            <DialogTitle>{t('panel.onboarding.firewallTitle')}</DialogTitle>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            <p className="text-sm text-foreground-muted">
              {t('panel.onboarding.firewallIntro')}{' '}
              <span className="font-mono">18787</span>{t('panel.onboarding.firewallIntroTail')}
            </p>
            <div className="grid gap-4 md:grid-cols-3">
              <FirewallPane title="Linux" steps={FIREWALL_LINUX} port={lanPortText} onCopied={onCopied} />
              <FirewallPane title="Mac" steps={FIREWALL_MAC} port={lanPortText} onCopied={onCopied} />
              <FirewallPane title="Windows" steps={FIREWALL_WINDOWS} port={lanPortText} onCopied={onCopied} />
            </div>
          </DialogBody>
          <DialogFooter className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-foreground-muted">
              {copied === 'ok' ? t('panel.onboarding.copiedOk') : null}
              {copied === 'failed' ? t('panel.onboarding.copiedFailed') : null}
            </span>
            <Button variant="primary" onClick={() => setFirewallOpen(false)}>
              {t('panel.onboarding.gotIt')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={lanDialogOpen} onOpenChange={setLanDialogOpen}>
        <DialogContent className="max-w-md" closeLabel={t('panel.common.close')}>
          <DialogHeader>
            <DialogTitle>{t('panel.onboarding.lanDialogTitle')}</DialogTitle>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-2">
            <p className="text-xs text-foreground-muted">{t('panel.onboarding.lanDialogHint')}</p>
            {/* 一行一个按钮而不是 RadioGroup：点当前这一条也要能「确认并关窗」，
                单选控件在值没变时不会回调，点了看着像没反应。 */}
            <div role="radiogroup" aria-label={t('panel.onboarding.lanGroupA11y')} className="flex flex-col gap-1">
              {choice.map((item) => {
                const picked = item.address === (preferred || choice[0]?.address)
                return (
                  <button
                    key={item.address}
                    type="button"
                    role="radio"
                    aria-checked={picked}
                    onClick={() => void pickLanAddress(item.address)}
                    className={`flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-background-muted ${
                      picked ? 'bg-background-muted' : ''
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${
                        picked ? 'border-primary bg-primary text-primary-foreground' : 'border-border-muted'
                      }`}
                      aria-hidden="true"
                    >
                      {picked ? <CheckMark /> : null}
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="min-w-0 font-mono text-xs break-all text-foreground">{item.url}</span>
                      <span className="text-xs text-foreground-muted">{item.interface ?? t('panel.onboarding.lan')}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </main>
  )
}


/** 三栏排查步骤。命令照抄就能用；`cmd` 为真时按等宽字体摆。 */
const FIREWALL_LINUX: { text?: string; textKey?: string; cmd?: boolean }[] = [
  { textKey: 'panel.onboarding.linuxStep1' },
  { text: 'systemctl status firewalld', cmd: true },
  { text: 'sudo ufw status', cmd: true },
  { textKey: 'panel.onboarding.linuxStep2' },
  { text: 'sudo firewall-cmd --permanent --add-port={port}/tcp\nsudo firewall-cmd --reload', cmd: true },
  { text: 'sudo ufw allow {port}/tcp', cmd: true },
  { textKey: 'panel.onboarding.linuxStep3' },
]

const FIREWALL_MAC: { text?: string; textKey?: string; cmd?: boolean }[] = [
  { textKey: 'panel.onboarding.macStep1' },
  { text: '/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate', cmd: true },
  { textKey: 'panel.onboarding.macStep2' },
  { text: 'sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate off', cmd: true },
  { textKey: 'panel.onboarding.macStep3' },
]

const FIREWALL_WINDOWS: { text?: string; textKey?: string; cmd?: boolean }[] = [
  { textKey: 'panel.onboarding.winStep1' },
  { text: 'Get-NetFirewallProfile | Select-Object Name, Enabled', cmd: true },
  { textKey: 'panel.onboarding.winStep2' },
  { text: 'New-NetFirewallRule -DisplayName "DSH Mobile {port}" -Direction Inbound -LocalPort {port} -Protocol TCP -Action Allow', cmd: true },
  { textKey: 'panel.onboarding.winStep3' },
]

/**
 * 「点我复制」复制出去的那段话。**三栏复制的是同一份**：它不是哪一栏的内容，
 * 而是一封给 AI 的委托信 —— 先说清在做什么、卡在哪、要 AI 回答什么问题。
 *
 * 这里**不写具体地址和端口**（2026-10-10 用户要求）：地址每台机器都不同、端口被占时还会
 * 自动换，写死在文案里比不写更容易误导；改成让 AI 去引导页看，并强调「是局域网地址」。
 */
function aiCheckPrompt(): string {
  // 每一门语言都是一段**能直接粘给 AI 的完整提示词**，不是逐字直译的碎句。
  return [
    t('panel.onboarding.prompt.intro'),
    '',
    t('panel.onboarding.prompt.situation'),
    t('panel.onboarding.prompt.address'),
    t('panel.onboarding.prompt.guess'),
    '',
    t('panel.onboarding.prompt.ask'),
    t('panel.onboarding.prompt.ask1'),
    t('panel.onboarding.prompt.ask2'),
    t('panel.onboarding.prompt.ask3'),
    t('panel.onboarding.prompt.ask4'),
    '',
    t('panel.onboarding.prompt.extra'),
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
  steps: { text?: string; textKey?: string; cmd?: boolean }[]
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
      {steps.map((step) => {
        // 命令是原样的（不翻译），说明文字走字典键。
        const body = (step.text ?? (step.textKey ? t(step.textKey) : '')).replace(/\{port\}/g, port)
        return step.cmd ? (
          <pre
            key={body}
            className="overflow-x-auto rounded bg-background-subtle px-2 py-1.5 font-mono text-[11px] leading-5 whitespace-pre text-foreground-strong"
          >
            {body}
          </pre>
        ) : (
          <p key={body} className="text-xs leading-5 text-foreground-muted">
            {body}
          </p>
        )
      })}
      {/* 底部对齐：三栏步骤长短不一，按钮仍落在同一水平线上。 */}
      <Button className="mt-auto" variant="outline" size="sm" onClick={() => void copy()}>
        {t('panel.onboarding.copyPromptHint')}
      </Button>
    </section>
  )
}

/** 弹窗里那条「就是它」的小勾：16px 方块内的一笔，跟着文字色走。 */
function CheckMark() {
  return (
    <svg viewBox="0 0 12 12" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m2.5 6.2 2.2 2.3L9.5 3.7" />
    </svg>
  )
}


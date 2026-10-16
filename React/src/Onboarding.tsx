/**
 * 首次接入引导（四页：欢迎 / 使用场景 / 配置 / 完成）。
 *
 * 宿主还没配过、或者走 `/api/relay/panel/setup` 时进这一页。第三页把宿主检测到的地址摆出来，
 * 让用户选「手机优先用哪条」（一台机器好几个网段时，只有他知道哪条对着手机）。整页只做展示与
 * 转发：配置全交给宿主已有的 `/api/relay/*`。
 */
import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@appica/ui-react/alert'
import { Badge } from '@appica/ui-react/badge'
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
import { Progress } from '@appica/ui-react/progress'
import { Radio } from '@appica/ui-react/radio'
import { RadioGroup } from '@appica/ui-react/radio-group'
import { Spinner } from '@appica/ui-react/spinner'
import { Switch } from '@appica/ui-react/switch'
import { useEffect, useRef, useState } from 'react'

import { InfoList, InfoRow, ToneValue } from './components/InfoRow.tsx'
import {
  ApiError,
  apiGet,
  apiPost,
  errorText,
  type AddressBook,
  type ConfigPatch,
  type PairingInfo,
  type PortCheck,
  type StatusView,
} from './lib/api.ts'
import { cn, lanText, lanTone, tunnelText, tunnelTone } from './lib/format.ts'
import { APP_DOWNLOAD_URL } from './lib/links.ts'

/**
 * 首次安装后的接入引导：四页走完，插件就接得上手机。
 *
 * 为什么要有引导：这个插件有好几条不同的接入路，第一次装的人不会知道自己该走哪条。
 * 第二页先把人分开——
 * - 手机直连的人（不管是同一个 Wi-Fi 还是连到公网上的服务器）：不经中转，只差手机该填
 *   哪一个地址，界面上直接列出检测到的局域网 / 公网地址，不用先选一次（2026-10-11 起
 *   原本的「在局域网内使用」与「DSH 装在服务器上」合成这一条）；
 * - 自己有中转服务器的人：填自己那台的地址，走它转发；
 * - 想要中转、但不想自己维护服务器的人：点「一键部署」把仓库里带的那个 Worker 部署到自己的
 *   Cloudflare 账号，部署完那个 Worker 的首页就把中转地址摆出来了，复制回来填在同一个框里
 *   ——第三页与上一条完全一样，两条只在「地址从哪来」上有别。
 * 官方中转的配置分支保留在实现中，但当前不作为可选场景展示。
 *
 * 第四页不是一句干巴巴的「完成」：这里摆出二维码与配对码，再把人送进插件主页。
 * 连接结果靠轮询宿主状态得出，引导页不自己猜，也不假报成功——「手机来没来」也是
 * 宿主的真实记录（`status.lastMobileAt`），不是页面自己数的秒。
 *
 * 这一页只做展示与转发：配置全交给宿主已有的 `/api/relay/*`（和 App.tsx 同一批接口）。
 * 两个地址由宿主吐同一份 HTML：`.../api/relay/panel` 自己分流（看宿主记的 `onboarded`），
 * `.../api/relay/panel/setup` 强制走这一趟（也就是下面 `replay` 那个开关的用途）。
 */

type Scenario = 'direct' | 'self' | 'worker' | 'official'

type Props = {
  /** 走完流程后去哪。默认回插件主页。 */
  onDone?: () => void
  /** 强制引导的那条地址（`.../panel/setup`）下多给一个「重新走一遍」。 */
  replay?: boolean
}

/** 官方中转的地址。手机端一份域名都不预置，这里是这台电脑连出去用的地址。 */
const OFFICIAL_RELAY_URL = 'https://dsh-hub.wnluo.com'

/** 自建中转的方向指引（怎么自己弄一台公网服务器、反代和证书）。 */
const RELAY_SETUP_URL = 'https://github.com/WNLUO/dsh-mobile-plugin/blob/main/RELAY-SETUP.md'

/**
 * Cloudflare 的一键部署入口。
 *
 * `?url=` 指到公开仓库里的那个目录，Cloudflare 会把它复制成用户自己账号下的一份并部署；
 * 用户不用装 wrangler、不用买服务器、也不用有自己的域名（默认给 `workers.dev` 地址）。
 * `?url=` 指向独立公开仓库的根目录，改仓库或改目录都得跟着改这里。
 */
const RELAY_DEPLOY_URL =
  'https://deploy.workers.cloudflare.com/?url=https://github.com/WNLUO/dsh-cloudflare-relay'

/** 直连端口的默认值，取宿主自己的默认端口（`lib/relay/core.js` 的 `defaultState()`）。 */
const DEFAULT_DIRECT_PORT = '18787'

/**
 * 「检查端口」那颗按钮的结果。
 *
 * `unsupported` 是给老宿主的：这条路由是新加的，装 0.1.63 及以前的宿主上会回 401
 * （老宿主对没注册的 `/api/*` 统一回 unauthorized，不是 404）。那种情况下要如实说
 * 「这台宿主还没这个检查」，不能把它说成「端口有问题」。
 */
type PortProbe =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; result: PortCheck }
  | { kind: 'failed'; message: string }
  | { kind: 'unsupported' }

type ScenarioItem = {
  id: Scenario
  title: string
  detail: string
  /**
   * 这一条右边那颗按钮（开新标签页）。
   *
   * `selectOnClick` 为真时，点它顺带把这一条选中——「一键部署」就是这个意思：点下去
   * 等于在说「我要走这条路」，不该让人家部署完回来发现自己还没选中。
   */
  action?: { label: string; url: string; selectOnClick?: boolean }
  /**
   * 这一条的「附属教程」：一颗按钮，点开是弹窗。
   *
   * 只给「一键部署」那条用——它按下去就跳到我们管不着的 Cloudflare 部署页，而那页会问
   * 什么、哪一栏要自己决定，得在他按之前讲清楚。这些话平铺在行里会把一条选项撑成一大段，
   * 所以收进弹窗，外面只留一颗按钮。
   */
  tutorial?: { label: string; steps: string[] }
}

const SCENARIOS: ScenarioItem[] = [
  {
    id: 'direct',
    // 「局域网」与「装在服务器上」原本是两条，2026-10-11 按用户要求合成一条：
    // 两者都是**手机直连宿主**、都要一个端口、后续页一模一样，差别只在手机该填哪个地址
    // ——而那件事由下面的地址清单自己说清楚，不需要用户先选一次（选错还会看到对不上的地址）。
    title: '直接连上这台 DSH',
    detail: '不经过中转，手机直连。同一个 Wi-Fi 填局域网地址，不在同一个网络填公网地址。',
  },
  {
    id: 'self',
    title: '自己搭建了服务器后端',
    detail: '你已经有自己的中转服务器，把它填进来，由它转发。',
    action: { label: '搭建教程', url: RELAY_SETUP_URL },
  },
  {
    id: 'worker',
    // 原来只有「自己有服务器」这一条路，没有服务器的人看完只能放弃。这条路与上一条
    // 填的东西一模一样，差别只在地址是点出来的、不是自己搭出来的。
    title: '用 Cloudflare 一键部署一个中转',
    detail: '不想自己维护服务器就走这条：点一下，把中转部署到你自己的 Cloudflare 账号。',
    // 教程放在按之前能点开的地方：`window.open` 会把新标签页推到前台，按完再弹的任何
    // 提示，在他最需要看的那一刻都是看不见的。
    tutorial: {
      label: '部署教程',
      steps: [
        '点「一键部署」会新开一个标签页，那就是 Cloudflare 的部署页（标题是「创建应用」）。',
        '那一页只有 RELAY_SECRET 一栏要你自己决定：框里已经预填了一串，但那是公开的示例值，请换成一串只有你自己知道的随机字符（至少 32 位，越长越好）。',
        '其余几栏都不用动：构建命令留空，部署命令是 npm run deploy，预览命令是 npx wrangler preview。',
        '点右下角的「部署」，第一次跑要等一两分钟。',
        '部署成功后，在这个 Worker 页面点上方「域」；也可以点「设置」→「域和路由」，找到 workers.dev 项并复制完整网址。网址通常是 https://<Worker名称>.<账号子域>.workers.dev；不要复制当前的构建日志页地址。',
        '把刚复制的网址在浏览器打开，Worker 首页会显示中转地址，点旁边的复制按钮。回到这里填在下一步的「中转地址」里，手机那边也填同一个地址。',
      ],
    },
    action: { label: '一键部署', url: RELAY_DEPLOY_URL, selectOnClick: true },
  },
]

const STEPS = ['欢迎', '使用场景', '配置', '完成']

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim())
}

/**
 * 这一步默认选哪条地址：用户上次存过的还在清单里就用它，否则宿主的头一条。
 *
 * 「存过的还在不在」得自己判：换了网段、拔了网卡之后那个 IP 就不在清单里了，
 * 这时界面必须退回宿主的第一条（宿主那边的排序同样会退回，见 `orderCandidates`）。
 */
function defaultPreferred(book: AddressBook): string {
  const list = book.lan.length > 0 ? book.lan : book.public
  const saved = (book.preferred || '').trim()
  if (saved && list.some((item) => item.address === saved)) return saved
  return list[0]?.address ?? ''
}

/** 「局域网地址 · en0」：一台机器好几块网卡时，光看 IP 分不出哪条对着手机。 */
function addressLabel(kind: string, nic?: string): string {
  return nic ? `${kind} · ${nic}` : kind
}

/**
 * 接入引导。
 *
 * @param props.onDone 走完之后去哪
 * @param props.replay 走的是 `.../panel/setup`，多一个「重新走一遍」
 */
export function Onboarding({ onDone, replay = false }: Props) {
  const [step, setStep] = useState(0)
  const [scenario, setScenario] = useState<Scenario | null>(null)
  const [status, setStatus] = useState<StatusView | null>(null)
  const [fatal, setFatal] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [relayUrl, setRelayUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [lanEnabled, setLanEnabled] = useState(true)
  const [lanPort, setLanPort] = useState(DEFAULT_DIRECT_PORT)
  const [pairing, setPairing] = useState<PairingInfo | null>(null)
  /**
   * 最后一页那块的结论。**只有「坏了」和「超时」两种是状态**——「好了」不存标记，
   * 由渲染直接看 `status` 现算（见 `readyNow`），否则两份东西一飘就会出现
   * 「上面写着正在监听、下面还在等它连上」这种自相矛盾。
   */
  const [outcome, setOutcome] = useState<'waiting' | 'bad' | 'timeout'>('waiting')
  /**
   * 手机那一步走到哪了。`unsupported` = 这台宿主还没有那个信号（老版本），
   * 此时界面不能装成「正在等手机」，只能如实说「已经就绪」。
   */
  const [phone, setPhone] = useState<'waiting' | 'unsupported' | 'connected'>('waiting')
  /** 检测到的局域网 / 公网地址。老宿主没有这条路由，取不到就是 null（界面整块不显示）。 */
  const [addresses, setAddresses] = useState<AddressBook | null>(null)
  /**
   * 用户选中的「手机优先用这条」（地址字面量）。空串 = 一条都没得选（没检测到地址）。
   * 它最后随 `/api/relay/config` 落成设置项，宿主拿它把二维码里的候选排在最前。
   */
  const [preferred, setPreferred] = useState('')
  /** 「检查端口」的结果。idle 时一个字都不显示，别让刚进这一步的人先看到一屏提示。 */
  const [portProbe, setPortProbe] = useState<PortProbe>({ kind: 'idle' })
  // 当前摊开的「附属教程」（null = 弹窗关着）。
  const [tutorialDoc, setTutorialDoc] = useState<{ title: string; steps: string[] } | null>(null)

  /** 轮询要能被卸载打断，否则关掉页面后它还在打接口。 */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // 拿一个默认设备名（宿主机名）和这台机器当前的直连端口。读不到也不挡路：两个都能自己填。
  useEffect(() => {
    void (async () => {
      try {
        const current = await apiGet<StatusView>('/api/relay/status')
        setStatus(current)
        setName((value) => value || current.name)
        // 这台机器已经有直连端口了（重跑引导、或者之前配过）：按它填。
        // 否则「完成并启用」会把人家原来的端口改成默认值。用户自己改过就不动。
        if (current.lan.port) {
          setLanPort((value) => (value === DEFAULT_DIRECT_PORT ? String(current.lan.port) : value))
        }
      } catch (err) {
        setFatal(errorText(err))
      }
    })()
  }, [])

  // 检测到的局域网 / 公网地址。单开一个 effect，而且**取不到不算致命**：老宿主没有这条
  // 路由（404），那时整块地址提示不显示就行，引导本身照样走得完。
  useEffect(() => {
    void (async () => {
      try {
        const book = await apiGet<AddressBook>('/api/relay/addresses')
        setAddresses(book)
        // 用户还没自己点过就按默认选（重走一遍引导时，上次的选择要被回显出来）。
        setPreferred((value) => value || defaultPreferred(book))
      } catch {
        setAddresses(null)
      }
    })()
  }, [])

  function pick(next: Scenario) {
    setScenario(next)
    setRelayUrl(next === 'official' ? OFFICIAL_RELAY_URL : '')
    setPortProbe({ kind: 'idle' })
    setError('')
  }

  function restart() {
    setStep(0)
    setScenario(null)
    setRelayUrl('')
    setSecret('')
    setLanPort(DEFAULT_DIRECT_PORT)
    setPairing(null)
    setOutcome('waiting')
    // 「手机来过了」也要清：不清的话重走一遍引导会一进最后一页就说「已经连上了」。
    setPhone('waiting')
    setPortProbe({ kind: 'idle' })
    // 地址的选择也退回默认：不退回的话「重新走一遍」会带着上一次点的那个继续走。
    setPreferred(addresses ? defaultPreferred(addresses) : '')
    setError('')
  }

  /** 端口一改，上一次的检查结论就过期了——留着会让人以为新端口也查过了。 */
  function changePort(value: string) {
    setLanPort(value)
    setPortProbe({ kind: 'idle' })
  }

  /**
   * 「检查端口」：问宿主这个端口现在能不能监听。
   *
   * 真逻辑在宿主那边（`/api/relay/check-port`，拿局域网代理同一把探针真 bind 一次），
   * 这里只做两件事：本地先挡格式，以及把 404 如实说成「这台宿主还没这个检查」——
   * 老宿主上那条路由不存在，不能说成「端口有问题」。
   */
  async function checkPort() {
    const value = lanPort.trim()
    if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) {
      setPortProbe({ kind: 'done', result: { port: null, available: false, reason: 'out-of-range' } })
      return
    }
    setPortProbe({ kind: 'busy' })
    try {
      const result = await apiPost<PortCheck>('/api/relay/check-port', { port: Number(value) })
      setPortProbe({ kind: 'done', result })
    } catch (err) {
      // 老宿主对没注册的 `/api/*` 路径统一回 401 `unauthorized`（实测 0.1.63 就是，
      // 不是 404）。两种都按「这台宿主还没有这条路由」处理——那时说「端口有问题」
      // 或把 `unauthorized` 的原话摆给用户看，都是在骗人。
      setPortProbe(
        err instanceof ApiError && (err.status === 401 || err.status === 404)
          ? { kind: 'unsupported' }
          : { kind: 'failed', message: errorText(err) },
      )
    }
  }

  /**
   * 检查的结论。它只回答得了「宿主在本机能不能在这个端口上起来」，外网那半句
   * （防火墙放没放行）它不知道，得靠用户自己去放行——所以文案不替它吹。
   */
  function portProbeLine(result: PortCheck) {
    if (result.port === null) return <p className="text-xs text-error">端口要填 1024–65535 之间的整数。</p>
    if (result.reason === 'host-web-port') {
      return <p className="text-xs text-error">{result.port} 是 DSH 自己的网页端口，不能拿它当直连端口。</p>
    }
    if (result.available) {
      return (
        <p className="text-xs text-success">
          {result.ours
            ? `${result.port} 就是本机现在在用的直连端口。`
            : `${result.port} 可以用，宿主能在这个端口上起来。`}
        </p>
      )
    }
    return <p className="text-xs text-error">{result.port} 用不了：宿主在本机起不来，换一个。</p>
  }

  /**
   * 「手机里要填的地址」那几行。
   *
   * 优先用宿主检测到的地址（局域网在前、公网在后——同一个 Wi-Fi 是最常见的情形）；
   * 拿不到清单（老宿主没有那条路由）就退回宿主给的候选 URL。端口用传进来的那个：
   * 配置页用输入框里的现值（改端口它跟着变），最后一页用真正绑定的那个。
   */
  function addressRows(port: number | string, fallback: string[]): { url: string; label: string }[] {
    const text = String(port || '')
    if (addresses && (addresses.lan.length > 0 || addresses.public.length > 0)) {
      return [
        ...addresses.lan.map((item) => ({ url: `http://${item.address}:${text}`, label: '局域网地址' })),
        ...addresses.public.map((item) => ({ url: `http://${item.address}:${text}`, label: '公网地址' })),
      ]
    }
    return fallback.map((url) => ({ url, label: '局域网地址' }))
  }

  /**
   * 第三步那块地址清单，分两份摆：
   *  - `pickable`：二维码 / 连接信息里**真的会带**的那一份（有私网就只带私网，一个私网都没有才退公网），
   *    所以只有它能选；
   *  - `readOnly`：另一份。摆出来只为「手机不在同一个网络时，知道该往 App 里手填什么」——
   *    它进不了二维码，做成可选的只会让人以为选了有用。
   */
  const addressText = String(lanPort || '')
  const pickable = addresses
    ? (addresses.lan.length > 0 ? addresses.lan : addresses.public).map((item) => ({
        address: item.address,
        url: `http://${item.address}:${addressText}`,
        label: addressLabel(addresses.lan.length > 0 ? '局域网地址' : '公网地址', item.interface),
      }))
    : []
  const readOnly =
    addresses && addresses.lan.length > 0
      ? addresses.public.map((item) => ({
          address: item.address,
          url: `http://${item.address}:${addressText}`,
          label: addressLabel('公网地址', item.interface),
        }))
      : []

  const nameMissing = name.trim() === ''
  const urlMissing = isRelay() && !isHttpUrl(relayUrl)
  const secretMissing = scenario === 'official' && secret.trim() === ''
  // 直连的两条端口必填：留空宿主虽然会自己挑一个，但那个号用户不知道，也就无从去放行。
  // 默认给宿主自己的默认端口，一般人不用改。
  const portMissing = isDirect() && lanPort.trim() === ''
  const portInvalid =
    lanPort.trim() !== '' && !(/^\d+$/.test(lanPort.trim()) && Number(lanPort) >= 1024 && Number(lanPort) <= 65535)
  const canNext = scenario !== null && !busy
  /**
   * 端口那一关过了没有。**只认那个端口本身的那一次检查**：`changePort()` 会把结论清掉，
   * 所以「查完 18787 又把框改成 18888」不会因为留着上一次的绿字就放行。
   *
   * 直连的两条都要过这一关，但它们「过」的含义不完全一样（见 `portProbeLine` 与下面
   * 那句提示）：局域网那条查通了就够——同一个 Wi-Fi，不经防火墙；服务器那条本机查通了
   * 只是必要条件，外网能不能进来还得看服务器防火墙放没放行，那件事**本机验不了**
   * （宿主没法验证自己的入站规则，也不能拿自己去打自己），所以只能如实写在界面上，
   * 不能假装它包含在「检查通过」里。
   *
   * `unsupported`（老宿主没有这条路由）**算过**：那条路由是新加的，正在用的 0.1.63
   * 及以前都没有它，卡死在这里等于让所有已发布的机器都走不完引导。界面会如实说
   * 「这台宿主还没有这个检查」，用户点一次就能继续。
   */
  const portChecked =
    portProbe.kind === 'unsupported' || (portProbe.kind === 'done' && portProbe.result.available === true)
  const canFinish =
    !busy &&
    !nameMissing &&
    !urlMissing &&
    !secretMissing &&
    !portMissing &&
    !portInvalid &&
    // 中转那两条不走这个端口（它们是隧道），别拿这一关去卡它们。
    (!isDirect() || portChecked)

  /**
   * 手机那边现在能不能连过来。直接拿当前 `status` 算，和上面那一行状态读的是同一份东西，
   * 所以两处不可能各说各话。还没问到状态时按「没好」算，先转圈。
   */
  const readyNow = status !== null && readyOf(status)

  /** 直连那条看直连代理在不在听，中转的看隧道有没有握上手。 */
  function isDirect(): boolean {
    return scenario === 'direct'
  }

  /**
   * 要用户自己弄一个中转的那两条（自己搭的、一键部署的）。
   *
   * 它们只差「地址从哪来」，填的东西、校验、标题都该按这一条判——分成两个场景各写一遍
   * 迟早只改一处，出现「这条填了没反应、那条没填却能过」。
   */
  function isRelay(): boolean {
    return scenario === 'self' || scenario === 'worker'
  }

  function readyOf(current: StatusView): boolean {
    return isDirect() ? current.lan.state === 'listening' : current.tunnel.state === 'connected'
  }

  function failedOf(current: StatusView): boolean {
    return isDirect() ? current.lan.state === 'error' : current.tunnel.state === 'error'
  }

  /**
   * 配置写下去之后盯到最后一页有人真的扫上码为止。
   *
   * 盯的是两件**都能观测到**的事，别的一概不盯：
   *  1. 宿主这边起没起来（`readyOf`）——没起来就转圈，20 秒还没起来就如实说「还没起来」；
   *  2. 手机有没有来过（`status.lastMobileAt`）——它比我们开始盯的时刻新，就是真来过。
   * 第 2 件在宿主那边记（移动端守卫里，见 `lib/http/routing.js` 的 `createGuarded`），
   * 局域网与中转两条路都算，所以不用分场景。老宿主没有这个字段 → 界面说「已经就绪」，
   * 不装成在等一个永远等不到的信号。
   */
  async function watch() {
    const startedAt = Date.now()
    try {
      setPairing(await apiGet<PairingInfo>('/api/relay/pairing'))
    } catch {
      /* 拿不到二维码不挡后面的结论，二维码那块自己会说 */
    }
    // 三分钟：再没人扫就别一直打接口了（页面还开着，用户重新走一遍就会重新盯）。
    const giveUpAt = Date.now() + 3 * 60_000
    while (alive.current && Date.now() < giveUpAt) {
      await sleep(1500)
      if (!alive.current) return
      let current: StatusView
      try {
        current = await apiGet<StatusView>('/api/relay/status')
      } catch {
        continue
      }
      setStatus(current)
      if (typeof current.lastMobileAt === 'number') {
        if (current.lastMobileAt > startedAt) {
          setPhone('connected')
          return
        }
      } else {
        // 老宿主：没有这个信号，别装成在等。
        setPhone('unsupported')
      }
      // 好了不在这里存标记：渲染那边直接看 status（`readyNow`），存两份就会飘开。
      if (readyOf(current)) continue
      if (failedOf(current)) {
        setOutcome('bad')
        return
      }
      if (Date.now() - startedAt > 20_000) {
        setOutcome('timeout')
        return
      }
    }
  }

  async function finish() {
    if (!canFinish) return
    setBusy(true)
    setError('')
    const patch: ConfigPatch = {
      name: name.trim(),
      // 直连的两条必须让直连监听开着，否则手机上根本连不上（这两页也不给关）。
      lanEnabled: isDirect() ? true : lanEnabled,
      pairingPolicy: 'code',
    }
    // 直连的两条不该被「中转连不上」的红字吓到：地址留空，隧道压根不启动。
    patch.relayUrl = isDirect() ? '' : relayUrl.trim()
    // 密钥留空＝不动它，绝不把空串写回去（那等于把注册密钥关掉）。
    if (secret.trim()) patch.registerSecret = secret.trim()
    if (lanPort.trim()) patch.lanPort = Number(lanPort.trim())
    // 「手机优先用这条」。只在这条路上写：中转那两条页面上根本不摆这份清单。
    // 空串表示这次没得选（没检测到地址），那就不写，别把人家之前的选择清掉。
    if (isDirect() && preferred) patch.preferredLanAddress = preferred
    try {
      setStatus(await apiPost<StatusView>('/api/relay/config', patch))
      setStatus(await apiPost<StatusView>('/api/relay/toggle', { enabled: true }))
      // 告诉宿主「这台机器走过引导了」，下次打开直接进主页。
      // 失败不算这一步失败：老宿主没有这条路由，引导照样走完，只是下次还会再引导一遍。
      await apiPost('/api/relay/onboarded', {}).catch(() => undefined)
      setOutcome('waiting')
      // 重走一遍时要从「还没连上」开始盯，否则上一次的结论会直接被沿用。
      setPhone('waiting')
      setStep(3)
      void watch()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const stepTitle =
    step === 0
      ? '先把这个插件接到手机上'
      : step === 1
        ? '你打算怎么用？'
        : step === 2
          ? isDirect()
            ? '手机怎么连过来'
            : scenario === 'self'
              ? '填你服务器那台的信息'
              : scenario === 'worker'
                ? '把部署好的地址填进来'
                : '填官方中转的接入信息'
          // 标题只说这一页要**做什么**，不说「已经连上了」——手机还没扫呢，
          // 说连上了就是在骗人（2026-10-11 用户报的原文）。
          : '用手机扫这个码'

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
      <header className="flex w-full max-w-2xl flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-foreground-intense">接入引导</h1>
        <Badge variant="soft" size="sm">
          {`第 ${step + 1} / ${STEPS.length} 步 · ${STEPS[step]}`}
        </Badge>
        <Progress className="w-32" value={((step + 1) / STEPS.length) * 100} min={0} max={100} />
        {replay ? (
          <Button className="ml-auto" variant="ghost" size="sm" disabled={busy} onClick={restart}>
            重新走一遍
          </Button>
        ) : null}
      </header>

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
        {step === 0 ? null : (
          <CardHeader>
            <CardTitle>{stepTitle}</CardTitle>
          </CardHeader>
        )}

        <div className={cn('flex flex-col gap-5 px-4', step === 2 ? 'py-2' : 'min-h-[320px] justify-center py-6')}>
          {step === 0 ? (
            <div className="flex flex-col items-center gap-4 text-center">
              <h2 className="text-2xl font-semibold text-foreground-intense">把 DSH 接到手机上</h2>
              <p className="max-w-md text-sm text-foreground-muted">
                手机连上你的 DSH，跑在本机还是服务器上都行。之后在外面也能看进度、发指令、接手要你点头的事；DSH 照常跑，手机替你盯着。
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Badge variant="soft" size="sm">
                  手机上收发消息
                </Badge>
                <Badge variant="soft" size="sm">
                  随时看进度
                </Badge>
                <Badge variant="soft" size="sm">
                  局域网直连或中转
                </Badge>
              </div>
            </div>
          ) : null}

          {step === 1 ? (
            <RadioGroup value={scenario ?? ''} onValueChange={(value) => pick(value as Scenario)} className="gap-3">
              {SCENARIOS.map((item) => {
                // 取成本地常量：TS 不会把 `item.action` / `item.tutorial` 的非空收窄带进
                // 下面那两个回调里。
                const action = item.action
                const tutorial = item.tutorial
                return (
                  <label
                    key={item.id}
                    className={cn(
                      'flex items-start gap-3 rounded-lg border p-4 transition-colors',
                      scenario === item.id
                        ? 'cursor-pointer border-border-emphasis bg-background-subtle'
                        : 'cursor-pointer border-border-muted bg-background-muted hover:border-border-strong',
                    )}
                  >
                    <Radio value={item.id} className="mt-0.5" aria-label={item.title} />
                    <span className="flex flex-1 flex-col gap-1">
                      <span className="text-sm font-medium text-foreground-intense">{item.title}</span>
                      <span className="text-xs text-foreground-muted">{item.detail}</span>
                    </span>
                    {tutorial || action ? (
                      <span className="flex shrink-0 items-center gap-2 self-center">
                        {tutorial ? (
                          <Button
                            variant="outline"
                            size="sm"
                            type="button"
                            onClick={(event) => {
                              // 跟 `action` 一样先拦一道：这是颗「看说明」的按钮，不该顺手
                              // 改掉用户已经选好的那条。
                              event.preventDefault()
                              event.stopPropagation()
                              setTutorialDoc({ title: item.title, steps: tutorial.steps })
                            }}
                          >
                            {tutorial.label}
                          </Button>
                        ) : null}
                        {action ? (
                          <Button
                            variant="outline"
                            size="sm"
                            type="button"
                            onClick={(event) => {
                              // 这颗按钮在 `<label>` 里，不拦一下的话点它会连带把这一行选中——
                              // 「搭建教程」只是去看文档，不该顺手改掉用户已经选好的那条。
                              event.preventDefault()
                              event.stopPropagation()
                              // 反过来「一键部署」要的就是这个连带：点它就是在说「我要走这条路」。
                              if (action.selectOnClick) pick(item.id)
                              window.open(action.url, '_blank', 'noopener,noreferrer')
                            }}
                          >
                            {action.label}
                          </Button>
                        ) : null}
                      </span>
                    ) : null}
                  </label>
                )
              })}
            </RadioGroup>
          ) : null}

          {step === 2 ? (
            <>
              {scenario === 'self' ? (
                <p className="text-sm text-foreground-muted">
                  中转服务器负责在手机和 DSH 之间转发，地址填你自己那台。它得先跑起来，手机那边也要填同一个地址。
                </p>
              ) : null}

              {scenario === 'worker' ? (
                <p className="text-sm text-foreground-muted">
                  部署完成后打开 Cloudflare 给你的那个 Worker 地址，页面上会显示你的中转地址、旁边还有一颗复制按钮，把那一串填到这里。手机那边也要填同一个地址。
                </p>
              ) : null}

              {scenario === 'official' ? (
                <p className="text-sm text-foreground-muted">
                  用现成的中转，手机在任何网络下都能连回来。地址固定，缺的只有那把授权密钥——拿到授权后它才会通过中转的准入。
                </p>
              ) : null}

              {scenario === 'official' ? (
                <InfoList>
                  <InfoRow label="中转地址" mono>
                    {OFFICIAL_RELAY_URL}
                  </InfoRow>
                </InfoList>
              ) : null}

              {isRelay() ? (
                <Field>
                  <FieldLabel htmlFor="ob-relay-url">中转地址</FieldLabel>
                  <Input
                    inputProps={{ id: 'ob-relay-url', className: 'font-mono' }}
                    value={relayUrl}
                    placeholder="https://example.com"
                    onChange={(event) => setRelayUrl(event.target.value)}
                  />
                  {urlMissing ? <p className="text-xs text-error">要填一个 http:// 或 https:// 开头的地址。</p> : null}
                </Field>
              ) : null}

              {scenario === 'official' ? (
                <Field>
                  <FieldLabel htmlFor="ob-secret">注册密钥</FieldLabel>
                  <Input
                    type="password"
                    inputProps={{ id: 'ob-secret' }}
                    value={secret}
                    placeholder="粘贴发你的那串密钥"
                    onChange={(event) => setSecret(event.target.value)}
                    clearable
                    onClear={() => setSecret('')}
                  />
                  {secretMissing ? <p className="text-xs text-error">官方中转要凭这把密钥准入，不能空着。</p> : null}
                </Field>
              ) : null}

              <Field>
                <FieldLabel htmlFor="ob-name">设备名</FieldLabel>
                <Input
                  inputProps={{ id: 'ob-name' }}
                  value={name}
                  placeholder="手机里显示的名字"
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>

              {/* 直连的两条不需要这个开关（finish 里强制开着）；它只对中转那两条有意义。 */}
              {isDirect() ? null : (
                <div className="flex items-center justify-between gap-4 rounded-md bg-background-muted px-3 py-2">
                  <span className="flex flex-col">
                    <span className="text-sm text-foreground">局域网直连</span>
                    <span className="text-xs text-foreground-muted">同一个 Wi-Fi 时可以直接连，不经服务器。</span>
                  </span>
                  <Switch size="md" checked={lanEnabled} onCheckedChange={setLanEnabled} aria-label="局域网直连" />
                </div>
              )}

              <Field>
                <FieldLabel htmlFor="ob-lan-port">{isDirect() ? '直连端口' : '局域网端口'}</FieldLabel>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <Input
                      inputProps={{ id: 'ob-lan-port', inputMode: 'numeric' }}
                      value={lanPort}
                      placeholder={isDirect() ? '比如 18787' : '留空就自动选一个'}
                      onChange={(event) => changePort(event.target.value)}
                    />
                  </div>
                  <Button
                    className="shrink-0"
                    variant="outline"
                    disabled={busy || portProbe.kind === 'busy'}
                    onClick={() => void checkPort()}
                  >
                    检查端口
                  </Button>
                </div>
                {portProbe.kind === 'busy' ? <p className="text-xs text-foreground-muted">正在检查…</p> : null}
                {portProbe.kind === 'unsupported' ? (
                  <p className="text-xs text-foreground-muted">这台宿主还没有这个检查（插件版本旧），先跳过。</p>
                ) : null}
                {portProbe.kind === 'failed' ? <p className="text-xs text-error">{portProbe.message}</p> : null}
                {portProbe.kind === 'done' ? portProbeLine(portProbe.result) : null}
                {isDirect() ? (
                  <p className="text-xs text-foreground-muted">
                    点「检查端口」确认它可用；走公网时还要在服务器/路由器的防火墙上放行它。
                  </p>
                ) : null}
                {portMissing ? <p className="text-xs text-error">要填一个端口：手机直连的就是它。</p> : null}
                {portInvalid ? (
                  <p className="text-xs text-error">
                    {isDirect() ? '端口要填 1024–65535 之间的整数。' : '端口要么留空，要么填 1024–65535 之间的整数。'}
                  </p>
                ) : null}
              </Field>

              {/*
                手机会填哪个地址：宿主把检测到的地址按局域网 / 公网分开报过来（`/api/relay/addresses`），
                这里摆出来，用户不用自己去 `ipconfig`。端口用输入框里的现值，改端口它跟着变。

                **能选的和只能看的分开摆**：二维码/连接信息里真的会带的是 `advertisedCandidates`
                那一份（有私网就只带私网），所以机器上有局域网地址时，公网那几条只能看——它进不了
                二维码，给了选择反而让人以为选了有用（手机不在同一个网络时它要手填进 App，
                下面那句话就是这么说的）。只有一条可选时不摆单选：没得选。
              */}
              {isDirect() ? (
                <div className="rounded-md bg-background-muted px-3 py-2">
                  <p className="text-xs text-foreground-muted">
                    手机里要填的地址：同一个 Wi-Fi 填局域网那条，不在同一个网络填公网那条。
                  </p>
                  {pickable.length > 0 ? (
                    <>
                      {pickable.length > 1 ? (
                        <p className="mt-1 text-xs text-foreground-muted">
                          这台机器有不止一条：选手机优先用哪条。二维码里它排最前，其余几条留着当兜底。
                        </p>
                      ) : null}
                      <RadioGroup
                        className="mt-1.5 gap-1"
                        value={preferred}
                        onValueChange={(value) => setPreferred(typeof value === 'string' ? value : '')}
                      >
                        {pickable.map((row) => (
                          <label
                            key={row.url}
                            className="flex cursor-pointer flex-wrap items-baseline justify-between gap-x-3"
                          >
                            <span className="flex items-baseline gap-1.5">
                              <Radio value={row.address} aria-label={row.url} />
                              <span className="font-mono text-xs text-foreground">{row.url}</span>
                            </span>
                            <span className="shrink-0 text-xs text-foreground-muted">{row.label}</span>
                          </label>
                        ))}
                      </RadioGroup>
                    </>
                  ) : (
                    <p className="mt-1.5 text-xs text-foreground-muted">
                      这台机器上没检测到可用的地址（网卡都没带可用的 IPv4），手机那边就填不到东西。
                    </p>
                  )}
                  {readOnly.length > 0 ? (
                    <ul className="mt-1.5 flex flex-col gap-1">
                      {readOnly.map((row) => (
                        <li key={row.url} className="flex flex-wrap items-baseline justify-between gap-x-3">
                          <span className="font-mono text-xs text-foreground-muted">{row.url}</span>
                          <span className="shrink-0 text-xs text-foreground-muted">{row.label}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {addresses && addresses.public.length === 0 ? (
                    <p className="mt-1.5 text-xs text-foreground-muted">
                      没检测到公网地址：不在同一个网络时，要填路由器/防火墙映射到这台机器的那个公网 IP 或域名。
                    </p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}

          {step === 3 ? (
            <>
              <p className="text-sm text-foreground-muted">
                接下来打开手机 App，用「添加设备」扫下面的码，或者手输配对码。
              </p>

              {/*
                二维码：宿主已经把 `dshpair://` 那份深链画成 SVG 了（`/api/relay/pairing`
                的 `svg`，用的是宿主自己的 `qrcode`）。这里只管把它居中摆出来——不自己画码，
                也不自己拼那份 payload，否则手机扫出来的东西和配对码对不上。
              */}
              <div className="flex flex-col items-center gap-3">
                {pairing?.svg ? (
                  <div
                    className="size-[200px] rounded-lg bg-white p-2 [&_svg]:h-full [&_svg]:w-full"
                    // 宿主自己吐的 SVG，不是用户输入。
                    dangerouslySetInnerHTML={{ __html: pairing.svg }}
                  />
                ) : (
                  <div className="flex size-[200px] items-center justify-center rounded-lg border border-border-muted text-xs text-foreground-muted">
                    {outcome === 'bad' || outcome === 'timeout' ? '没取到二维码' : <Spinner />}
                  </div>
                )}
                <p className="font-mono text-lg tracking-[0.25em] text-foreground-intense">
                  {pairing?.pairingCode ?? status?.pairingCode ?? '—'}
                </p>
              </div>

              <InfoList>
                <InfoRow label={isDirect() ? '直连' : '中转隧道'}>
                  <ToneValue
                    tone={
                      isDirect()
                        ? lanTone(status?.lan.state ?? 'off', lanEnabled)
                        : tunnelTone(status?.tunnel.state ?? 'off')
                    }
                    text={
                      isDirect()
                        ? lanText(status?.lan.state ?? 'off', lanEnabled)
                        : tunnelText(status?.tunnel.state ?? 'off')
                    }
                  />
                </InfoRow>
                <InfoRow label="设备名">{name.trim() || status?.name || '—'}</InfoRow>
                {isDirect() ? null : (
                  <InfoRow label="中转地址" mono>
                    {relayUrl.trim() || OFFICIAL_RELAY_URL}
                  </InfoRow>
                )}
                {/*
                  地址按检测到的那两份分开列，服务器那条把公网排前面：不再一律叫「局域网地址」
                  ——选了服务器却看到一个局域网地址，正是 2026-10-11 用户报的问题。
                */}
                {addressRows(pairing?.lanPort ?? status?.lan.port ?? addresses?.port ?? '', pairing?.lanUrls ?? []).map(
                  (row) => (
                    <InfoRow key={row.url} label={row.label} mono>
                      {row.url}
                    </InfoRow>
                  ),
                )}
              </InfoList>

              {/*
                结论只由**能观测到的事实**决定：
                  · 宿主起没起来 —— 和上面那一行读的是同一份 `status`（`readyNow`），所以不可能
                    出现「上面写着正在监听、下面还在等它连上」这种自相矛盾（那正是用户截图报的）；
                  · 手机来没来 —— `status.lastMobileAt`（宿主在移动端守卫里记的）。
                等不到就如实说等不到：起不来 20 秒后转成红框，老宿主没有手机信号就说「已经就绪」。
              */}
              {!readyNow ? (
                outcome === 'bad' || outcome === 'timeout' ? (
                  <Alert variant="error">
                    <AlertIcon />
                    <AlertTitle>
                      {outcome === 'timeout' ? '还没起来' : isDirect() ? '没能开始直连' : '中转没连上'}
                    </AlertTitle>
                    <AlertDescription>{failureReason()}</AlertDescription>
                  </Alert>
                ) : (
                  <div className="flex items-center justify-center gap-2 text-sm text-foreground-muted">
                    <Spinner />
                    {isDirect() ? '正在把直连准备好…' : '正在连中转…'}
                  </div>
                )
              ) : phone === 'connected' ? (
                <p className="text-center text-sm text-success">手机已经连上了。</p>
              ) : phone === 'unsupported' ? (
                <p className="text-center text-sm text-success">已经就绪，手机扫上面的码就能连上。</p>
              ) : (
                <div className="flex items-center justify-center gap-2 text-sm text-foreground-muted">
                  <Spinner />
                  等你用手机扫上面的码…
                </div>
              )}
            </>
          ) : null}
        </div>

        <div
          className={cn(
            'flex flex-wrap items-center gap-2 px-4 py-4',
            // 欢迎页只有一颗按钮，居中才像一页欢迎页；后面几步右对齐，跟表单对齐更稳。
            step === 0 ? 'justify-center' : 'justify-end',
          )}
        >
          {step > 0 && step < 3 ? (
            <Button variant="outline" disabled={busy} onClick={() => setStep(step - 1)}>
              上一步
            </Button>
          ) : null}

          {step === 0 ? (
            // 下载页在上、下一步在下：第一次装的人手里还没 App，得先让他拿到 App。
            // 外链按钮按 Appica 的规矩用 `buttonVariants` 贴在 `<a>` 上，
            // 不是 `<Button render={<a/>}>`（那条在 ui-react 的 agent-rules 里被明确否掉）。
            <div className="flex flex-col items-center gap-2">
              <a
                className={buttonVariants({ variant: 'outline' })}
                href={APP_DOWNLOAD_URL}
                target="_blank"
                rel="noreferrer noopener"
              >
                下载 APP
              </a>
              <Button variant="primary" onClick={() => setStep(1)}>
                下一步
              </Button>
            </div>
          ) : null}

          {step === 1 ? (
            <Button variant="primary" disabled={!canNext} onClick={() => setStep(2)}>
              下一步
            </Button>
          ) : null}

          {step === 2 ? (
            <Button variant="primary" disabled={!canFinish} onClick={() => void finish()}>
              {busy ? '正在写入…' : '完成并启用'}
            </Button>
          ) : null}

          {step === 3 ? (
            <Button variant="primary" onClick={() => (onDone ? onDone() : window.location.assign('/'))}>
              进入插件
            </Button>
          ) : null}
        </div>
      </Card>

      {/*
        教程弹窗挂在最外层：`tutorialDoc` 是这一页的状态，不属于某一步——挂进第二步里，
        用户翻页就会把它连人带窗一起卸掉。
      */}
      <Dialog
        open={tutorialDoc !== null}
        onOpenChange={(open) => {
          if (!open) setTutorialDoc(null)
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{tutorialDoc?.title ?? ''}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm leading-6 text-foreground">
              {(tutorialDoc?.steps ?? []).map((text, index) => (
                // 步骤是静态文案，顺序就是身份。
                // eslint-disable-next-line react/no-array-index-key -- 见上
                <li key={index}>{text}</li>
              ))}
            </ol>
          </DialogBody>
          <DialogFooter className="flex justify-end">
            <Button variant="primary" onClick={() => setTutorialDoc(null)}>
              知道了
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )

  /** 连不上的原因：先把宿主给的准入线索翻成人话，再兜底到原始错误。 */
  function failureReason(): string {
    if (isDirect()) {
      const lanError = status?.lan.error
      if (lanError) return `${lanError}（端口可能被占用，换一个 1024–65535 的端口再试。）`
      return '直连没起来。端口可能被别的程序占了，走外网的话也可能没在服务器上放行——回上一步换一个端口再试。'
    }
    const tunnel = status?.tunnel
    if (tunnel?.registerSecretRequired) {
      return '中转拒绝了这次连接：注册密钥不对，或者没填。这把密钥由中转的部署者给出，官方中转就是拿到授权时发给你的那一串。'
    }
    if (tunnel?.instanceNotAllowed) {
      return '这台机器的实例 ID 不在中转的白名单里，需要部署者把它加进中转的 instances.json。'
    }
    return tunnel?.error
      ? `${tunnel.error}（检查中转地址填对没有、服务器是不是在跑。）`
      : '隧道没建起来。检查中转地址和服务器状态，改完回上一步重试。'
  }
}

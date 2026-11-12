/**
 * 控制面客户端：只碰 `/api/relay/*` 这一组本机接口。
 *
 * 这页读的是宿主已有的那份契约（`../lib/routes/control-plane.js`），不新增任何端点：
 * 所有接口只放行本机来源，所以浏览器直接打开也能用，不需要 token。
 * 开发时靠 Vite 的 `/api` 代理打到 DSH 网页端口；打包后由宿主自己把这页发出来，
 * 同源，路径一个字都不用改。
 */

import { t } from './i18n/index.ts'

export type PairingPolicy = 'code' | 'deny'

/**
 * 按设备发放的权限档位（见宿主 `lib/mobile/permissions.js` 的 TIERS）：
 * `readonly` 只看 / 读文件，`approve` 再加上答审批，`full` 全权（缺省）。
 * 新配对设备用哪一档在电脑侧选（`/api/relay/config` 的 `pairingTier`），
 * 已绑定设备的档位可逐台改（`/api/relay/devices/permissions`）。
 */
export type Tier = 'readonly' | 'approve' | 'full'

/**
 * 面板上「这台设备现在拿到的是什么档」——三档之外再加一个展示态 `none`。
 *
 * `none` 由**显式空数组**推出来：设备行的权限位是 `[]` 意味着明确什么都不给（连 view 都没有），
 * 跟「只读」不是一回事。它**只是显示态**，不是可下发的档位：面板改档只发下面那三档
 * （电脑侧本来就能提权 / 降权），所以别把 `TierView` 塞进接口参数。
 */
export type TierView = Tier | 'none'

/**
 * 一组权限位反推回档位 / 展示态，给设备清单显示用。
 *
 * 判据与宿主 TIERS 逐项对齐：`null`（老凭据没这一格）= 全权；**空数组 = 什么都不给（`none`）**；
 * 含 `input` 等全权才有的位 = 全权；有 `approve` 但不含全权位 = 可答审批；
 * 其余（只有 view + files.read）= 只读。
 */
export function tierOfPermissions(permissions: string[] | null | undefined): TierView {
  if (!Array.isArray(permissions)) return 'full'
  if (permissions.length === 0) return 'none'
  const set = new Set(permissions)
  if (['input', 'dispatch', 'operate', 'files.write', 'transfer', 'manage', 'config'].some((p) => set.has(p))) {
    return 'full'
  }
  if (set.has('approve')) return 'approve'
  return 'readonly'
}

/**
 * 手机直连隧道（Tailcat）此刻的状态（宿主 `lib/tailcat/session.cjs` 的 `status()`）。
 *
 * `available` = 这台机器上有没有隧道助手；没有它这条通道整条不可用（别的通道照旧）。
 * `paired` 是白名单里的手机把数，具体公钥由 `/api/relay/tailcat` 那份快照给。
 */
export type TailcatStatus = {
  available: boolean
  enabled: boolean
  running: boolean
  ready: boolean
  address: string
  paired: number
  error: string
}

/** `GET/POST /api/relay/tailcat*` 的回答：状态 + 当前允许的手机公钥。 */
export type TailcatView = {
  ok: boolean
  status: TailcatStatus | null
  allowedClients: string[]
}

/**
 * 点对点隧道（P2P）此刻的状态（宿主 `lib/p2p/session.cjs` 的 `status()`）。
 *
 * 与直连隧道那条形状相近，但**没有白名单也没有总开关那一套**：能连上的前提就是两端
 * 私钥对得上。所以这里只有「起没起、通没通」这一档事实。
 *
 * `path` 只可能是 `direct` / `failed` / `unknown` —— 这条通道没有中继兜底，打不通就是
 * 打不通，不会像直连隧道那样报「经中继」。
 */
export type P2PStatus = {
  available: boolean
  enabled: boolean
  ready: boolean
  /** 这一进程里隧道有没有被手机叫起来过：false + ready:false 是「还没有手机来会合」。 */
  started: boolean
  url: string
  /** direct / failed 是终态；punching 在打、waiting 等人来打，都不是终态。 */
  path: 'direct' | 'failed' | 'punching' | 'waiting' | 'unknown'
  active: boolean
  detail: string
  /** 电脑自己探到的打洞候选（私网 + 公网出口）。手机靠它知道往哪打。 */
  candidates: string[]
  /** 电脑这把公钥：二维码里给手机的就是它。 */
  publicKey: string
  error: string
}

export type TunnelSnapshot = {
  state: string
  error: string | null
  /** 命中中转的拒绝文案时才出现，见 ../lib/relay/status.js 的 TUNNEL_ADMISSION。 */
  instanceNotAllowed?: boolean
  admissionHint?: 'register-secret' | 'instance-allowlist'
}

export type StatusView = {
  enabled: boolean
  instanceId: string
  pairingCode: string
  relayUrl: string
  name: string
  pairingPolicy: PairingPolicy
  /**
   * 新配对设备的权限档位（缺省 `full`）。老宿主没有这个字段，读成 undefined 时按全权处理。
   */
  pairingTier?: Tier
  /**
   * 审批「自动审阅档」开着没有（默认关，见宿主 `lib/mobile/auto-review.js`）。
   * 老宿主不回这一格，读成 undefined 时按关处理 —— 那正是它的默认值。
   */
  approvalAutoReview?: boolean
  os: string
  platform: string
  osVersion: string
  arch: string
  appVersion: string
  localPort: number
  tunnel: TunnelSnapshot
  /** 手机直连隧道（Tailcat）的状态；老宿主没有这个字段时按「不可用」处理。 */
  tailcat?: TailcatStatus | null
  /** 点对点隧道（P2P）的状态；老宿主没有这个字段时按「不可用」处理。 */
  p2p?: P2PStatus | null
  lan: {
    enabled: boolean
    port: number
    requestedPort: number
    state: string
    error: string | null
    adjusted: boolean
  }
  sidecar: {
    state: string
    scope: { worker: string; facade: string; host: string }
    restarts: number
    restartedAt: number
    restartError: string | null
  }
  mirror: { pushedAt: number; ok: boolean; error: string | null }
  /** 这台机器走过首次接入引导了没有（落盘在 relay.json 里，见 ../lib/relay/core.js）。 */
  onboarded?: boolean
  /**
   * 面板页自己的绝对地址，宿主在 `/api/relay/status` 上补的（只有这条本机路由带它）。
   * 侧边栏那颗手机图标拿它当入口：必须是绝对 http(s)，相对地址在桌面版里会被解析成
   * `dsh-app://` 而点不开。
   */
  panelUrl?: string
  /**
   * 面板地址落在哪类网络上（宿主按请求的 Host 算的）：本机回环 / 局域网 / 公网。
   *
   * 客户端半边据此决定点下去要不要先开那两小时窗口：回环不用开（控制面本来就认它），
   * 局域网静默开，公网先弹一句确认。老宿主没有这个字段。
   */
  panelScope?: 'loopback' | 'private' | 'public'
  /**
   * 网页管理那两小时的临时窗口（进程内，DSH 重启即关）。只有 `/api/relay/status` 带它。
   */
  webAccess?: WebAccessState
  /**
   * 最近一次「手机上真的来过」的时刻（毫秒，0 = 从来没来过）。宿主在移动端守卫里记的，
   * 也只有本机这条状态路由带它。引导最后一页靠它把「等手机扫码」变成真结论。
   * **老宿主没有这个字段**：那时它是 `undefined`，界面不能假装自己在等一个永远等不到的信号。
   */
  lastMobileAt?: number
}

/**
 * `POST /api/relay/web-access` 与 `/api/relay/status` 里那份窗口状态。
 *
 * `expiresAt` 是墙钟毫秒（0 = 没开）；窗口到点自己关，访问不会延长它。
 */
export type WebAccessState = {
  enabled: boolean
  expiresAt: number
}

/** `/api/relay/addresses` 里一条地址。 */
export type AddressEntry = {
  address: string
  url: string
  interface?: string
  family?: string
}

/**
 * `/api/relay/addresses` 的回答：这台机器检测到的地址，按**局域网 / 公网 / IPv6**分开。
 *
 * 宿主刻意分成三份（见插件侧 `lib/relay/lan-network.cjs` 的三个函数）：局域网那份是
 * RFC1918，公网那份排掉了回环、链路本地、CGNAT、基准测试这些拨不通的段，IPv6 那份是
 * **全球单播**（`2000::/3`，排掉 6to4 / Teredo / 文档段）—— 手机不在同一个网络时唯一
 * 可能拨到的那一类。界面据此告诉用户「手机里该填哪个」，而不是把一份混在一起的列表丢给他。
 */
export type AddressBook = {
  ok?: boolean
  /** 宿主当前在用的直连端口（界面上被用户改过时以输入框为准）。 */
  port: number
  /**
   * 用户选中的「手机优先用这条」（设置项 `preferredLanAddress`，空串 = 没选过）。
   *
   * 它只是**回显**：选择真正生效的地方是二维码与 `/connection-info` 里那份候选顺序
   * （宿主按它把选中的排到最前，其余继续当兜底）。老宿主没有这个字段。
   */
  preferred?: string
  /**
   * 用户手填的直连地址（设置项 `manualLanUrl`，通常是内网穿透域名，空串 = 没填）。
   *
   * 与 `preferred` 同一套口径：它只是**多一条候选**，不顶掉网卡扫出来的那些 —— 穿透域名
   * 拨不通时手机还得能顺着局域网地址摸回来。老宿主没有这个字段。
   */
  manual?: string
  /**
   * 用户手填的 IPv6 直连地址（设置项 `manualIpv6Url`，空串 = 没填）。
   *
   * 与 `manual` 并列的一条候选：它是用户自己填的 IPv6 入口（手机在同一个 IPv6 网络里时用），
   * 不参与 `preferred`。老宿主没有这个字段，读成空串。
   */
  manualIpv6?: string
  lan: AddressEntry[]
  public: AddressEntry[]
  /**
   * IPv6 全球单播候选（老宿主没有这个字段，读成空数组）。
   *
   * **只显示、不能选**：这一份由手机侧拿它和公网中转**实测比速度**来择优，宿主不替它排，
   * 所以它不参与 `preferred`（那个选择只作用于上面两份）。`address` 是裸地址，`url`
   * 才带方括号 —— 拼 URL 的地方别自己拿 `address` 去拼（见 `AddressPicker` 的 `urlOf`）。
   */
  ipv6?: AddressEntry[]
}

/**
 * 二维码里那条隧道段（Tailcat）到什么时候失效。
 *
 * 宿主每取一次 `/api/relay/pairing` 就现开一个两分钟的一次性窗口、并作废上一张
 * （`lib/routes/control-plane.js` 的 `openPairingWindow(120)`），所以它比码里的局域网与
 * 中转两段先过期。过期之后 App 会静默丢掉这一段，手机上只剩另外两条路。
 */
export type PairingTailcat = {
  address: string
  port: number
  /** unix 秒，宿主原样转发助手报的那个。 */
  expiresAt: number
}

export type PairingInfo = {
  ok: true
  name: string
  relayUrl: string
  lanUrls: string[]
  pairingCode: string
  lanPort: number
  lanPortAdjusted: boolean
  /** 这次配对会用的权限档位；老宿主没有这个字段。 */
  pairingTier?: Tier
  /** 这次取码有没有顺带开出一条隧道段；老宿主没有这个字段。 */
  tailcat?: PairingTailcat | null
  svg: string
}

/**
 * 隧道段临期前多久重取一次码：留 30 秒，够人把手机举起来扫，也够那次请求跑一个来回。
 *
 * 宿主那个窗口是两分钟，所以正常节奏是「取一次码、九十秒后再取一次」，不是轮询。
 */
export const PAIRING_RENEW_LEAD_MS = 30_000

/**
 * 两次续码之间至少隔一秒。
 *
 * 留给「刚取到就只剩几秒」那种情况：别当场连着发，一秒之后再取。
 */
const PAIRING_RENEW_MIN_MS = 1_000

/**
 * 距下一次该续码还有多少毫秒；`null` = 这一版码不用排下一拍。
 *
 * 三种情况不排：码里没有隧道段（助手不可用 / 出错 / 老宿主没有这个字段，剩下两条路本来
 * 就不会过期）；拿到手隧道段就已经过期（这一页的钟和宿主对不上，远程打开面板时常见，倒计时
 * 算不出来，排下去只会变成「每秒重取一次、每次都白开一个配对窗口」）；`expiresAt` 不是个数。
 *
 * 其余按「剩余寿命减去 30 秒」排，取到码九十秒后正好再取一次。
 */
export function pairingRenewIn(info: PairingInfo | null, now = Date.now()): number | null {
  const expiresAt = info?.tailcat?.expiresAt ?? 0
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null
  const left = expiresAt * 1000 - now
  if (left <= 0) return null
  return Math.max(left - PAIRING_RENEW_LEAD_MS, PAIRING_RENEW_MIN_MS)
}

export type RevokeResult = {
  ok: boolean
  revoked: number
  revokedRelay: number
  revokedLocal: number
}

/**
 * `/api/relay/devices` 里的一台设备：同一台手机重配几次，宿主按 `deviceId` 聚成一行
 * （见 `dsh-mobile-credentials/lib/credentials.js` 的 `listDevices`）。
 *
 * 这里**没有** `hash` / `hostToken` / `deviceKey`：那些是凭据与密钥材料，宿主刻意不往面板回。
 */
export type RelayDevice = {
  deviceId: string
  /**
   * 设备名。历史来源很乱：早期 App 把「App 里给这台**电脑**起的备注」当成手机自己的名字
   * 报了进来，所以它排在机型后面当兜底（机型空着的老记录才会显示它）。
   */
  name: string
  /**
   * 机型（「iPhone 15 Pro」/「Xiaomi 9」）。手机自己报的，跟名字不一样：它不随用户改。
   * 空串 = 这台手机还没报过（老 App、或这一格出生前配的对）。
   */
  model: string
  /** `ios` / `android` / `linux` / `darwin` / `win32` 这类，宿主报什么就是什么。 */
  platform: string
  osVersion: string
  appVersion: string
  /** 毫秒时间戳；取这台设备名下最早那条记录。 */
  boundAt: number
  /** 毫秒时间戳；0 = 从没连过。 */
  lastSeenAt: number
  /** `relay` / `lan` / 空串（最近那条记录没记通道）。 */
  lastChannel: string
  /** 这台名下**还有几条活凭据**：同一台手机重配一次就多一条，旧的仍然能用。 */
  bindings: number
  /**
   * 标题会撞时才有的序号（`1`、`2`…），其余是空串。
   *
   * 两台都叫「iPhone 15 Pro」时靠它分得开；按绑定时间编，早绑的是 1。序号是显示用的，
   * 宿主不存它、也不回给手机。
   */
  suffix: string
  /**
   * 这台设备名下还有**不带设备密钥**的活记录。
   *
   * 那种凭据没有设备身份，单台吊销杀不掉它（旧的通行证在到期前仍可用），所以这一位
   * 决定解除绑定的确认文案能不能写「立即失效」。
   */
  legacy: boolean
  /** 这条会话走加密（带设备密钥的记录才走逐请求签名）。 */
  encrypted: boolean
  /**
   * 这台设备实际拿到的权限位；`null` = 全权（老凭据、或升级前没写这一格的记录），
   * 空数组 = 明确什么都不给。
   * 面板据此反推显示的档位 / 展示态（见 `tierOfPermissions`），不是再存一份档位。
   */
  permissions: string[] | null
  expiresAt: number
}

/**
 * `GET /api/relay/devices?history=1` 里的一行：**已经结束**的绑定，不是当前设备。
 *
 * 它回答的是「谁连过这台机器、后来怎么没的」。与 `RelayDevice` 是两个用途：那边每行都还
 * 能用、能改权限、能踢，这边一行都不能动（已解绑的再解绑一次没有意义，过期的那本通行证
 * 已经进不来了）。所以单独一个类型，别把两种状态塞进一个签名里。
 *
 * 同样**没有** `hash` / `hostToken` / `deviceKey`：宿主连历史也不往面板回凭据材料。
 */
export type RelayHistoryDevice = {
  deviceId: string
  /** 设备名。历史来源与 `RelayDevice.name` 一样乱，只在机型空着时兜底。 */
  name: string
  /** 机型；空串 = 那台手机当时没报过。 */
  model: string
  platform: string
  osVersion: string
  appVersion: string
  /** 毫秒时间戳；这组记录里最早那条的绑定时刻。 */
  boundAt: number
  /** 毫秒时间戳；最后一次来过；0 = 从没连过。 */
  lastSeenAt: number
  /** `relay` / `lan` / 空串（最近那条记录没记通道）。 */
  lastChannel: string
  /** 毫秒时间戳；0 = 这组不是被吊销掉的（自然过期那种）。 */
  revokedAt: number
  /** 毫秒时间戳；0 = 没有到期时间。 */
  expiresAt: number
  /**
   * 这组是怎么结束的：`revoked` = 有人亲手解除过绑定，`expired` = 通行证自然到期。
   *
   * 两种绝不合并成一句：一种是你踢的，一种是它自己到点，用户要知道是哪一种。
   */
  kind: 'revoked' | 'expired'
  /** 这组里有几条已结束的凭据（同一台手机重配过几次就多几条）。 */
  bindings: number
}

/** `GET /api/relay/devices?history=1` 的回答。`serverNow` 与设备清单同一台机器基准。 */
export type DeviceHistoryList = {
  ok: true
  serverNow: number
  devices: RelayHistoryDevice[]
}

/** `GET /api/relay/devices` 的回答。`serverNow` 是算「几分钟前」的同一台机器基准。 */
export type DeviceList = {
  ok: true
  serverNow: number
  devices: RelayDevice[]
  /**
   * 历史里有几台（`?history=1` 那份的行数）。老宿主没有这一格，读的地方按 0 处理。
   *
   * 它只用来决定两件事：折叠行上那个台数、以及「一台活设备都没有时这张卡还摆不摆」——
   * 踢掉最后一台手机之后，那条记录正是这一段要回答的事。
   */
  revokedCount: number
}

/** `POST /api/relay/devices/revoke` 的回答：吊销了几条凭据、断开了几条已建立的流。 */
export type DeviceRevokeResult = {
  ok: boolean
  revoked: number
  closed: number
}

/** `POST /api/relay/devices/permissions` 的回答：落定的档位、展开后的权限位、改了几条记录。 */
export type DevicePermissionResult = {
  ok: boolean
  tier: Tier
  permissions: string[]
  updated: number
}

/**
 * `/api/relay/check-port` 的回答：本机现在能不能监听这个端口。
 *
 * 宿主侧是真去 bind 一次（和局域网代理挑端口用同一把探针），所以 `available: true`
 * 就意味着「完成并启用」时不会 EADDRINUSE。它**只回答本机**：外网能不能连、
 * 防火墙放没放行，它不知道，界面别替它说。
 */
export type PortCheck = {
  ok?: boolean
  /** 问的那个端口；输入不在 1024–65535 里时是 null。 */
  port: number | null
  available: boolean
  /** true = 这个端口正是本机当前在监听的直连端口（是我们自己占着，不是被别的程序占）。 */
  ours?: boolean
  /** 本机的直连监听现在开着没有。 */
  listening?: boolean
  /** 本机的直连端口（已解析过的实际值）。 */
  currentPort?: number
  /**
   * 为什么不能用。`out-of-range` = 不在 1024–65535；`host-web-port` = 这是 DSH 自己的
   * 网页端口（不能拿它当直连端口，否则等于把桌面 GUI 挂到手机上）。
   */
  reason?: 'out-of-range' | 'host-web-port' | string
}

/** `/api/relay/config` 只认这几个字段，其余一律忽略（宿主侧白名单）。 */
export type ConfigPatch = {
  relayUrl?: string
  lanEnabled?: boolean
  lanPort?: number
  name?: string
  pairingPolicy?: PairingPolicy
  /** 新配对设备的权限档位（只在电脑侧设定）。 */
  pairingTier?: Tier
  /**
   * 审批「自动审阅档」（默认关）。只认布尔值：老宿主不认这一格，写进去也读不回来，
   * 界面上的开关就会原样弹回去，而不是假装开了。
   */
  approvalAutoReview?: boolean
  /**
   * 手机优先用哪条地址（IPv4 字面量）。空串是合法值，表示「不指定，按宿主自己的排序」——
   * 所以它跟 `name` 不一样，不会被宿主当成「没填」丢掉。
   */
  preferredLanAddress?: string
  /**
   * 手填的直连地址（内网穿透域名 / 公网 IP）。空串是合法值，表示「清掉这一条」——
   * 理由与 `preferredLanAddress` 同。
   */
  manualLanUrl?: string
  /**
   * 手填的 IPv6 直连地址（公网 IPv6 域名或字面量）。空串同样合法，表示「清掉这一条」。
   */
  manualIpv6Url?: string
}

/**
 * 自检结论。五种取值与宿主一一对应，界面**照它说**、不自己另判一套：
 *   · `not-listening` —— 直连端口没在监听，手机拨不进来；
 *   · `firewall-blocked` —— 系统防火墙明确挡住了这个程序；
 *   · `unknown` —— 防火墙状态读不到（Linux、或被系统策略限制），**不能算正常**；
 *   · `network` —— 电脑这侧没问题，但手机三十分钟没来过；
 *   · `ok` —— 最近连上过。
 */
export type SelfCheckVerdict = 'ok' | 'not-listening' | 'firewall-blocked' | 'unknown' | 'network'

/**
 * `/api/relay/selfcheck` 的回答。
 *
 * 这条路是**只读**的，代价却不在读上：宿主每答一次都要开子进程去问系统防火墙，
 * 所以调用侧必须节流 —— 见 `lib/selfcheck.ts` 的文件头。`?force=1` 让宿主跳过它自己
 * 那 30 秒缓存重新问一次，只有人主动按「重新自检」时才带。
 */
export type SelfCheck = {
  ok: boolean
  /** 这次自检的毫秒时刻。 */
  checkedAt: number
  /** 宿主所在系统。防火墙那一段怎么读，四种结果都跟它有关。 */
  platform: string
  verdict: SelfCheckVerdict
  listening: {
    state: 'listening' | 'off' | 'error'
    port: number
    /** 手机该拨的那几条地址（宿主按当前网卡算的）。 */
    urls: string[]
    /** 首选端口被占用时退到了别的端口。 */
    portAdjusted: boolean
  }
  tunnel: {
    state: 'connected' | 'off' | 'error'
    relayUrl: string | null
  }
  firewall: {
    /** false = 这台系统上压根没有可查的防火墙（Linux 常见）。 */
    supported: boolean
    /** null = 问系统时没拿到；不是「没开」。 */
    enabled: boolean | null
    /** null = 不知道有没有放行这个程序。 */
    allowsApp: boolean | null
    /**
     * 宿主进程自己的可执行文件路径（nvm / Homebrew 那种带版本号的长路径）。
     * **只拿来给人看**：界面上取文件名，别整条铺上去。
     */
    appPath: string
    /** 读不到时的原因；`null` = 读到了。 */
    reason: null | 'unsupported' | 'no-command' | 'timeout' | 'no-permission' | 'parse-failed'
  }
  mobile: {
    /** 最近一次手机上真的来过（毫秒，0 = 从来没来过）。 */
    lastMobileAt: number
    /** 三十分钟内没来过。 */
    idle: boolean
  }
}

export class ApiError extends Error {
  code: string
  status: number

  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

/**
 * 控制面的错误有两种形状：对象（`{code, message}`，如 `update_needs_restart`）
 * 与字符串（`/api/relay/pairing` 的 409 给的就是一句中文）。两种都要认出来。
 */
async function toApiError(response: Response): Promise<ApiError> {
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  const raw = (payload as { error?: unknown } | null)?.error
  if (typeof raw === 'string' && raw) return new ApiError(raw, `http_${response.status}`, response.status)
  if (raw && typeof raw === 'object') {
    const detail = raw as { code?: unknown; message?: unknown }
    const code = typeof detail.code === 'string' && detail.code ? detail.code : `http_${response.status}`
    const message =
      typeof detail.message === 'string' && detail.message ? detail.message : t('panel.net.requestFailed', { status: response.status })
    return new ApiError(message, code, response.status)
  }
  return new ApiError(t('panel.net.requestFailed', { status: response.status }), `http_${response.status}`, response.status)
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  if (!response.ok) throw await toApiError(response)
  return (await response.json()) as T
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (!response.ok) throw await toApiError(response)
  const payload = await response.json()
  throwIfApplyFailed(payload)
  return payload as T
}

/**
 * 200 里带了 `applyError` 的那一发其实**失败了**，当场翻成错误。
 *
 * `/api/relay/config` 是先落盘、再重启 sidecar，所以 200 只说明存上了；隧道没注册上时宿主
 * 把原因放在这一格（见插件 `lib/routes/control-plane.js` 那条路由 —— 注释写明这一发是用户填完
 * 地址之后唯一的反馈）。面板从前不读它，于是「改坏了、手机当场连不上」被说成「配置已保存」
 * 还顺手关了窗，用户找不到是自己刚改的那一项干的。
 *
 * 收在这一层而不是四个调用点：中转地址 / 局域网端口 / 配对策略 / 优先地址都从 `apiPost` 走，
 * 各写一遍判据迟早漏一处。抛出也正好对上 `act` 的收口 —— 关窗、重取配对、报成功全在 await
 * 之后，失败时一步都不做，窗还开着、用户填的值还在，能就地改回去。
 *
 * 网络本身失败（`fetch` 抛错）走的是另一条路，口径不变。
 */
function throwIfApplyFailed(payload: unknown): void {
  const applyError = (payload as { applyError?: unknown } | null)?.applyError
  if (typeof applyError !== 'string' || !applyError) return
  throw new ApiError(t('panel.shell.applyFailed', { message: applyError }), 'apply_failed', 200)
}

/**
 * 改「新配对设备的权限档位」。写的是 `/api/relay/config`，回来的整份 `StatusView` 直接顶掉旧的
 * （与改配对策略同一条路）。档位校验在宿主侧，枚举外会被 400 拒掉。
 */
export function updatePairingTier(tier: Tier): Promise<StatusView> {
  return apiPost<StatusView>('/api/relay/config', { pairingTier: tier })
}

/**
 * 改「审批自动审阅档」。写的是 `/api/relay/config`，回来的整份 `StatusView` 直接顶掉旧的
 * （与改配对策略同一条路）。开关真值由宿主落进 relay.json，默认关。
 */
export function updateApprovalAutoReview(enabled: boolean): Promise<StatusView> {
  return apiPost<StatusView>('/api/relay/config', { approvalAutoReview: enabled })
}

/**
 * 改某台已绑定设备的权限档位（电脑侧授予 / 提权 / 降权）。
 * 成功回 `{ ok, tier, permissions, updated }`；设备不在了是 404。
 */
export function updateDevicePermission(deviceId: string, tier: Tier): Promise<DevicePermissionResult> {
  return apiPost<DevicePermissionResult>('/api/relay/devices/permissions', { deviceId, tier })
}

/** 界面上的错误一律走这里：网络层自己抛的 TypeError 也得变成一句人话。 */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message || t('panel.net.requestFailedNoStatus')
  return String(error)
}

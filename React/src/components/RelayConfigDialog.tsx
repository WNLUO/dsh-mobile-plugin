// 2026-11-28：网络配置加「出站协议族」三档单选（auto / ipv4-first / ipv4-only），变了才进 patch。
// 2026-11-27：FRP 导入保存要有可见反馈——成功关窗并刷新状态、等待给进度，晚到的配置回填不盖用户粘贴。
// 2026-11-27：服务商面板未接入时给「登录」按钮，透传进服务商页的回调。
// 2026-11-27：服务商线路标题右边加中国/国际标签，下面铺对应专属面板（详细配置进服务商页）。
// 2026-11-22：网络配置页去掉「中转 / 直连 / 局域网与 IPv6 / FRP」大标题，字段平铺；各栏统一一颗
// 「检测」按钮（回环命中本机才算通，http 与 主机:端口 两种目标都验 instanceId）；FRP 改「导入」弹窗；
// ZeroNews 压缩成一行标题 + 右侧提示。地址错误可重取，健康探测包含当前自建中转。
// FRP 配置在弹窗里粘贴后直接「保存并启动」，不再暂存到父窗保存。
// 2026-11-22：网络配置由弹窗改为独立一页（用户要求）；TCP 那格只收「主机:端口」，填了 scheme 提示去「直连地址」并拦下保存。
// Cloudflare 兜底的开关与状态行已挪到 ConnectionCard + CloudflareDialog，这里不再重复一份。
// 2026-11-23：线路按地区分页（国内 / 国际入口卡在本页底部）；IPv4 那栏补自动识别与候选下拉；
// 各栏的检测结论挪进标题行、不再另占一行；自建中转那颗仓库按钮靠右。
// 2026-11-23：网络配置改回铺在首页（用户要求），不再单开一页；去掉页面标题与「关闭返回」，只留保存。
// 2026-11-26：网络配置卡顶部加公告刘海，文案走字典、字重加粗；字段区加「自定义网络」标题；卡内页头标题撤掉。
// 用途：网络配置——自建中转、直连、IPv4/IPv6、TCP、FRP 与局域网地址都在这一页改。
// 2026-11-26：七栏按用户指定顺序重排为一段自然流（局域网 / 自建中转 / IPv4 / IPv6 / TCP 直连 / 直连 / FRP），空位留末尾。
// 2026-11-26：服务商线路入口挪到字段上方、紧跟标题，让不自建网络的用户先看到可选线路；分隔线改在它下方。
import { Button, buttonVariants } from '@appica/ui-react/button'
import { Card } from '@appica/ui-react/card'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@appica/ui-react/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@appica/ui-react/dropdown-menu'
import { Field, FieldLabel } from '@appica/ui-react/field'
import { Input } from '@appica/ui-react/input'
import { Radio } from '@appica/ui-react/radio'
import { RadioGroup } from '@appica/ui-react/radio-group'
import { Spinner } from '@appica/ui-react/spinner'
import { useEffect, useRef, useState } from 'react'

import { frpConfig, importFrp, probeDirect, probeRelays, publicIp, stopFrp, type AddressBook, type ConfigPatch, type StatusView } from '../lib/api.ts'
import { RELAY_REPO_URL } from '../lib/links.ts'
import { t } from '../lib/i18n/index.ts'
import type { NetworkProvider } from '../lib/network-region.ts'
import { AddressPicker } from './AddressPicker.tsx'
import { NetworkRegions } from './NetworkRegions.tsx'

type ComboOption = { value: string; label: string }
/** 一颗「检测」按钮（回环命中本机）的结果状态。 */
type ProbeState = { state: 'idle' | 'checking' | 'ok' | 'other' | 'fail' }

/**
 * 带候选下拉的地址输入框。
 *
 * 浏览器自带的 `datalist` 箭头要鼠标移上去才冒出来，看着像「这栏没有可选项」；这里改成
 * 输入框右侧常驻一颗箭头，点它列出候选、点一条就填进去 —— 同时还能照常手敲。候选为空时
 * 只显示一句说明，不致于开出一个空菜单。
 */
function AddressCombo({
  id,
  value,
  placeholder,
  ariaLabel,
  options,
  emptyText,
  onChange,
  readOnly = false,
}: {
  id: string
  value: string
  placeholder: string
  ariaLabel: string
  options: ComboOption[]
  emptyText: string
  onChange: (value: string) => void
  readOnly?: boolean
}) {
  return (
    <Input
      inputProps={{ id, className: 'font-mono', readOnly }}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      endSlot={
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={ariaLabel}
            className="-mr-1 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded text-foreground-muted hover:text-foreground-strong focus-visible:outline-none"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" style={{ width: 'auto', minWidth: '18rem', maxWidth: '32rem' }}>
            {options.length === 0 ? (
              <div className="px-3 py-2 text-xs text-foreground-muted">{emptyText}</div>
            ) : (
              options.map((item) => (
                <DropdownMenuItem key={item.value} onClick={() => onChange(item.value)}>
                  <span className="font-mono text-xs break-all">{item.label}</span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      }
    />
  )
}

type Props = {
  /** 首页显示网络配置时为真；离开首页（进地区 / 服务商页）置假，字段随之复位。 */
  open: boolean
  status: StatusView
  /** 宿主枚举的地址库（`/api/relay/addresses`）：局域网选择与手填那两条都从它预填。 */
  addressBook: AddressBook | null
  addressError?: string
  onRetryAddresses?: (() => void) | undefined
  /** 宿主在二维码里给的那串地址：拿不到地址库（老宿主）时退回它，只显示不能选。 */
  lanUrls: string[]
  busy: string
  onSave: (patch: ConfigPatch) => void
  /** 「手机优先用这条」：点了就存、不关窗，所以和上面那个带保存按钮的 `onSave` 分开。 */
  onSavePreferred: (address: string) => void
  /** 面板做过断开 / 重置后让外层重读宿主状态，连接卡那行跟着变。 */
  onProviderChanged?: () => void
  /** 面板「登录」按钮：跳到服务商配置页走一键接入。 */
  onOpenProvider?: (provider: NetworkProvider) => void
}

/**
 * 网络配置（铺在首页，2026-11-23）：这台宿主能被手机摸到的几条地址都在这里改。
 *
 *   ① 中转地址（`relayUrl`）—— 自建中转，可编辑，右侧给中转仓库与「检测」；
 *   ② 局域网地址（`preferredLanAddress`）—— 网卡候选里「手机优先用哪条」，右上角一颗
 *      「选择地址」开选择弹窗（地址可能好几条，摊在本窗里会把版面撑变形）；
 *   ③ 直连地址（`manualLanUrl`）—— 自己把端口暴露到公网域名 / 公网 IP 时填的那一条；
 *   ④ IPv6 地址（`manualIpv6Url`）—— 手填 / 探测预填的公网 IPv6 入口；
 *   ⑤ TCP 直连地址（`manualTcpUrl`）—— 手机用裸 TCP 拨的 `主机:端口`（iOS 经本机回环、安卓直连）。
 *
 * 后四条都是「直连」的一套候选，彼此并存：拨不通的那条手机自己会换下一条，所以界面不强制
 * 只留一个。地址那一块原来分散在两个弹窗里（局域网直连 / 中转配置），用户要求并到一处，
 * 两个入口各改一半迟早对不上。
 *
 * **一屏两列**（2026-11-01 用户要求）：左列是「经公网的那几条」（设备名 / 中转 / 直连），
 * 右列是「局域网这一侧」（局域网地址 / IPv6 / 允许配对）。默认窗口高度下不出现滚动条 ——
 * 矮窗口留 `max-h` 只是兜底。网卡地址清单收进同级弹窗，主窗的尺寸不再随地址条数变。
 *
 * **局域网直连开关已撤**（2026-11-01 用户口径：它是基本能力，不该是个可关的选项）：
 * 宿主那份 `lanEnabled` 配置项原样留着，面板不再改它。
 * **「配对策略」改成「允许配对」开关**：开 = 凭配对码允许（`code`），关 = 一律拒绝（`deny`）。
 * 注册密钥那栏已下线（运营版中转不做了），宿主侧配置项原样留给自建中转。
 *
 * 提交只带**真的变过的字段**：宿主每收一个字段都会走一次下发，把没动的值原样发回去等于
 * 每次都触发一轮隧道 / 监听的重建。
 */
export function RelayConfigDialog({
  open,
  status,
  addressBook,
  addressError = '',
  onRetryAddresses,
  lanUrls,
  busy,
  onSave,
  onSavePreferred,
  onProviderChanged,
  onOpenProvider,
}: Props) {
  const [relayUrl, setRelayUrl] = useState(status.relayUrl)
  /** 直连地址（`manualLanUrl`）：用户手填的穿透域名 / 公网 IP。 */
  const [manualLanUrl, setManualLanUrl] = useState('')
  /** IPv6 直连地址（`manualIpv6Url`）：手填的公网 IPv6 入口；没填过时先显示探测到的那条。 */
  const [manualIpv6Url, setManualIpv6Url] = useState('')
  /** 公网 IPv4 地址（`manualIpv4Url`）：只认 IPv4 字面量，与直连地址分栏。 */
  const [manualIpv4Url, setManualIpv4Url] = useState('')
  /** TCP 直连地址（`manualTcpUrl`）：用户手填的 `主机:端口`，手机用裸 TCP 拨它。 */
  const [manualTcpUrl, setManualTcpUrl] = useState('')
  /** 出站协议族策略（`ipVersionPolicy`）：auto / ipv4-first / ipv4-only，默认跟随系统。 */
  const [ipVersionPolicy, setIpVersionPolicy] = useState<'auto' | 'ipv4-first' | 'ipv4-only'>(status.ipVersionPolicy ?? 'auto')
  /** 出站协议族设置弹窗：正文只摆一个文字按钮点开，三档在弹窗里选，保存直接落盘。 */
  const [ipVersionDialogOpen, setIpVersionDialogOpen] = useState(false)
  /** 弹窗里的草稿值，开窗时灌入当前落盘值，保存才写回，取消不碰主窗。 */
  const [ipVersionDraft, setIpVersionDraft] = useState<'auto' | 'ipv4-first' | 'ipv4-only'>(status.ipVersionPolicy ?? 'auto')
  /** 自建中转的注册密钥弹窗：地址框里一个文字按钮点开，密钥只写不回显，留空=不改动。 */
  const [registerSecretDialogOpen, setRegisterSecretDialogOpen] = useState(false)
  /** 弹窗里的密钥草稿，开窗清空（不回显已存的），填了才写下去。 */
  const [registerSecretDraft, setRegisterSecretDraft] = useState('')
  /** TCP 那栏的填写提示：这格只收「主机:端口」，填了带 scheme 的地址就提示去「直连地址」。 */
  const [tcpHint, setTcpHint] = useState('')
  /** 自建中转的检测结果：用宿主已有的 /api/relay/probe-relays 确认「是不是我们的中转」并取版本、延迟。 */
  const [selfProbe, setSelfProbe] = useState<{ state: 'idle' | 'checking' | 'ok' | 'not-relay' | 'fail'; ms?: number; version?: string }>({ state: 'idle' })
  /** 直连地址的回环检测：打回 service=dsh-mobile-plugin 且 instanceId 与本机一致才算「绕回本机」。 */
  const [directProbe, setDirectProbe] = useState<ProbeState>({ state: 'idle' })
  /** TCP 直连 / 局域网 / IPv4 / IPv6 / FRP 各自的回环检测结果（同一套判据）。 */
  const [tcpProbe, setTcpProbe] = useState<ProbeState>({ state: 'idle' })
  const [lanProbe, setLanProbe] = useState<ProbeState>({ state: 'idle' })
  const [ipv4Probe, setIpv4Probe] = useState<ProbeState>({ state: 'idle' })
  const [ipv6Probe, setIpv6Probe] = useState<ProbeState>({ state: 'idle' })
  const [frpProbe, setFrpProbe] = useState<ProbeState>({ state: 'idle' })
  /** 宿主识别到的公网 IPv4（`/api/relay/public-ip`），空串 = 没识别到。 */
  const [detectedIpv4, setDetectedIpv4] = useState('')
  /** 用户「添加地址」自己加进来的局域网候选（网卡没扫到时用）。 */
  const [extraLan, setExtraLan] = useState<string[]>([])
  /** 用户自己加进来的 IPv4 候选（运营商给的不是网卡上挂着的那条时用）。 */
  const [extraIpv4, setExtraIpv4] = useState<string[]>([])
  /** 添加地址弹窗：lan / ipv6 / ipv4 / null。 */
  const [addOpen, setAddOpen] = useState<'lan' | 'ipv6' | 'ipv4' | null>(null)
  const [addDraft, setAddDraft] = useState('')
  const [addError, setAddError] = useState('')
  /** FRP 管理：配置文本、忙、反馈，以及「导入配置」弹窗开关。 */
  const [frpText, setFrpText] = useState('')
  const [frpBusy, setFrpBusy] = useState('')
  const [frpNote, setFrpNote] = useState('')
  const [frpDialogOpen, setFrpDialogOpen] = useState(false)
  /**
   * 局域网地址（`preferredLanAddress`）：**可手填**，不再只让用户从检测到的那几条里挑。
   * 机器有好几块网卡、想直接敲一条地址时用得上；填错了拦在保存那儿（见 `unknownLan`）。
   */
  const [preferredLan, setPreferredLan] = useState('')
  /** 这一次开窗里用户动过局域网地址那一栏没有：动过就不再拿地址库去盖。 */
  const [lanHint, setLanHint] = useState('')
  /** 「选择局域网地址」弹窗开着没有。 */
  const [lanPickerOpen, setLanPickerOpen] = useState(false)
  /** 子弹窗的落焦目标：清单让焦点落在容器上，别一开窗就圈住第一行。 */
  const lanPickerRef = useRef<HTMLDivElement | null>(null)
  /** 这一次开窗里用户动过手填那两栏没有：动过就不再拿地址库去盖。 */
  const editedLanRef = useRef(false)
  const editedIpv6Ref = useRef(false)
  const editedIpv4Ref = useRef(false)
  const editedTcpRef = useRef(false)
  const editedPreferredRef = useRef(false)
  /** FRP 弹窗里用户粘过配置没有：异步读回的落盘配置不能盖掉正在编辑的内容。 */
  const frpEditedRef = useRef(false)

  /** 能用的局域网地址（与宿主 `advertisedCandidates` 同口径：有私网就只带私网）。 */
  const pickableAddresses = addressBook ? (addressBook.lan.length > 0 ? addressBook.lan : addressBook.public) : []

  // 只在开窗那一刻灌一次当前值：status 每 3 秒换一个对象，
  // 把它当依赖会让正在敲的字被轮询覆盖掉。
  useEffect(() => {
    if (!open) return
    setRelayUrl(status.relayUrl)
    setRegisterSecretDraft('')
    setRegisterSecretDialogOpen(false)
    setIpVersionPolicy(status.ipVersionPolicy ?? 'auto')
    setIpVersionDraft(status.ipVersionPolicy ?? 'auto')
    void loadFrpConfig()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上：只认 open
  }, [open])

  // 主窗关掉时把子弹窗一起收掉：下次开窗不能带着上一轮的清单挡在主窗前面。
  useEffect(() => {
    if (open) return
    setLanPickerOpen(false)
    setFrpDialogOpen(false)
    setIpVersionDialogOpen(false)
    setRegisterSecretDialogOpen(false)
    frpEditedRef.current = false
  }, [open])

  // 地址库是开窗之后才取回来的（App 那边是异步的），所以手填的两条单独跟它走：
  // 没动过就一直按地址库回显（关窗后重开也回到落盘的那份），动过就一律以输入框为准，
  // 免得用户正在敲的字被后来补上的地址库冲掉。
  useEffect(() => {
    if (!open) {
      editedLanRef.current = false
      editedIpv6Ref.current = false
      editedIpv4Ref.current = false
      editedTcpRef.current = false
      editedPreferredRef.current = false
      setLanHint('')
      setTcpHint('')
      setSelfProbe({ state: 'idle' })
      setDirectProbe({ state: 'idle' })
      setTcpProbe({ state: 'idle' })
      setLanProbe({ state: 'idle' })
      setIpv4Probe({ state: 'idle' })
      setIpv6Probe({ state: 'idle' })
      setFrpProbe({ state: 'idle' })
      setExtraLan([])
      setExtraIpv4([])
      setAddOpen(null)
      setAddDraft('')
      setAddError('')
      return
    }
    if (!editedLanRef.current) setManualLanUrl(addressBook?.manual ?? '')
    // 探测到的 IPv6 全球单播先填进框里，别让这栏空着像没识别到；有手填过的以手填为准。
    // 只是显示，`submit` 那边会把「还是这条探测地址」当成没改，不偷偷落成手填。
    if (!editedIpv6Ref.current) {
      setManualIpv6Url(addressBook?.manualIpv6 || addressBook?.ipv6?.[0]?.url || '')
    }
    if (!editedIpv4Ref.current) setManualIpv4Url(addressBook?.manualIpv4 ?? '')
    if (!editedTcpRef.current) setManualTcpUrl(addressBook?.manualTcp ?? '')
    if (!editedPreferredRef.current) {
      const candidates = addressBook ? (addressBook.lan.length > 0 ? addressBook.lan : addressBook.public) : []
      setPreferredLan((addressBook?.preferred || '').trim() || (candidates[0]?.address ?? ''))
    }
    // 只认 open 与地址库：`pickableAddresses` 每次渲染都是新数组，拿它当依赖会让这个 effect 每帧跑。
  }, [open, addressBook])

  // 公网 IPv4 自动识别：开页问一次宿主，识别不到就只留网卡候选 + 手填，不挡别的栏。
  // 宿主那边有缓存（成功 5 分钟、失败 1 分钟），所以反复开关这一页不会反复打外网。
  useEffect(() => {
    if (!open) return undefined
    let alive = true
    publicIp()
      .then((res) => { if (alive && typeof res.ip === 'string') setDetectedIpv4(res.ip) })
      .catch(() => { /* 识别不出来就当没有，界面照常可填 */ })
    return () => { alive = false }
  }, [open])

  const canSave = busy === ''

  /** 直连那两条按宿主口径去掉尾部斜杠：它拼出来的是一条候选 URL，多一个 `/` 就多一条重复项。 */
  const trimUrl = (value: string) => value.trim().replace(/\/+$/, '')

  /** 探一下自建中转：确认它是我们这套中转程序、取回版本与延迟；不是 / 连不上都如实说。 */
  async function checkSelfRelay() {
    const url = trimUrl(relayUrl)
    if (!/^https?:\/\//i.test(url)) { setSelfProbe({ state: 'fail' }); return }
    setSelfProbe({ state: 'checking' })
    try {
      const res = await probeRelays([url])
      const hit = res?.results?.[0]
      if (hit && typeof hit.ms === 'number' && hit.service === 'dsh-mobile-relay') setSelfProbe({ state: 'ok', ms: hit.ms, version: hit.version })
      else if (hit && typeof hit.ms === 'number') setSelfProbe({ state: 'not-relay' })
      else setSelfProbe({ state: 'fail' })
    } catch {
      setSelfProbe({ state: 'fail' })
    }
  }

  /** 回环探测：把地址打到「本机插件」上，只有 service=dsh-mobile-plugin 且 instanceId 一致才算通。 */
  async function probeLoop(target: string, setter: (next: ProbeState) => void) {
    const url = trimUrl(target)
    if (!url) { setter({ state: 'fail' }); return }
    setter({ state: 'checking' })
    try {
      const hit = await probeDirect(url)
      if (hit && typeof hit.ms === 'number' && hit.service === 'dsh-mobile-plugin') {
        setter({ state: hit.instanceId && hit.instanceId === status.instanceId ? 'ok' : 'other' })
      } else {
        setter({ state: 'fail' })
      }
    } catch {
      setter({ state: 'fail' })
    }
  }

  /** 局域网那栏存的是裸地址（如 192.168.1.20），探测前补成可拨的 URL。 */
  function lanProbeTarget(value: string): string {
    const v = value.trim()
    if (!v) return ''
    if (/^https?:\/\//i.test(v)) return v
    const entry = pickableAddresses.find((item) => item.address === v)
    if (entry?.url) return entry.url
    if (/^\[?[0-9a-fA-F:.]+\]?:\d+$/.test(v)) return `http://${v}`
    return `http://${v}:${status.lan.port}`
  }

  /**
   * 一颗「检测」的结论（回环命中本机 / 连得上不是本机 / 连不上）。
   *
   * 渲染成行内的一段小字，放在标题那一行里：它另起一行会把整页撑出几道空档，而结论本身
   * 只有几个字（2026-11-23 用户要求）。
   */
  function probeNote(probe: ProbeState) {
    if (probe.state === 'idle') return null
    const text = probe.state === 'checking'
      ? t('panel.relay.detecting')
      : probe.state === 'ok'
        ? t('panel.address.detectLoopOk')
        : probe.state === 'other'
          ? t('panel.address.detectLoopOther')
          : t('panel.address.detectLoopFail')
    const tone = probe.state === 'ok' ? 'text-success' : probe.state === 'checking' ? 'text-foreground-muted' : 'text-warning'
    return <span className={`text-xs ${tone}`}>{text}</span>
  }

  /** 关掉 FRP 弹窗：下次开窗照当前落盘配置回显，上一轮的错误也不带进来。 */
  function closeFrpDialog() {
    setFrpDialogOpen(false)
    setFrpNote('')
    frpEditedRef.current = false
  }

  /** 读当前 frpc 配置，填进管理框（没接 frpc 能力就留空并提示）。 */
  async function loadFrpConfig() {
    try {
      const res = await frpConfig()
      // 粘贴可能发生在请求在途时：晚到的落盘配置不能盖掉正在编辑的内容，
      // 否则输入框被清空、保存按钮变灰，看着就像「点保存没反应」。
      if (!frpEditedRef.current) setFrpText(res?.config || '')
    } catch {
      if (!frpEditedRef.current) setFrpText('')
    }
  }

  /** 保存并启动 frpc：导入接口会落盘并把 localPort 对齐到插件端口后起进程。 */
  async function saveFrp() {
    if (!frpText.trim()) return
    setFrpBusy('save')
    setFrpNote('')
    try {
      const res = await importFrp(frpText)
      if (!res.ok) {
        setFrpNote(res.status?.error || t('panel.frp.statusStop'))
        return
      }
      // 成功要看得见：关窗并立刻重读宿主状态，地址栏不用等下一次轮询。
      closeFrpDialog()
      onProviderChanged?.()
    } catch (error) {
      setFrpNote(error instanceof Error ? error.message : String(error))
    } finally {
      setFrpBusy('')
    }
  }

  /** 停掉 frpc。 */
  async function stopFrpNow() {
    setFrpBusy('stop')
    setFrpNote('')
    try {
      await stopFrp()
    } catch (error) {
      setFrpNote(error instanceof Error ? error.message : String(error))
    } finally {
      setFrpBusy('')
    }
  }

  /** 「添加地址」：校验形状后并入候选（IPv6 / IPv4 直接写进各自那一格）。 */
  function submitAdd() {
    const value = addDraft.trim().replace(/\/+$/, '')
    // 公网 IPv4 只收字面量（可带 scheme、端口与反代路径）：域名归「直连」那格，别在这里混。
    const ipv4Shape = /^(?:https?:\/\/)?(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:\/[^\s]*)?$/i.test(value)
    if (addOpen === 'ipv4') {
      if (!ipv4Shape) { setAddError(t('panel.address.addInvalid')); return }
      editedIpv4Ref.current = true
      setManualIpv4Url(value)
      setExtraIpv4((prev) => (prev.includes(value) ? prev : [...prev, value]))
      setAddOpen(null)
      setAddDraft('')
      setAddError('')
      return
    }
    if (!/^(?:https?:\/\/[^\s]+|[^\s/:?#]+:\d+)$/i.test(value)) { setAddError(t('panel.address.addInvalid')); return }
    if (addOpen === 'ipv6') {
      editedIpv6Ref.current = true
      setManualIpv6Url(value)
    } else {
      setExtraLan((prev) => (prev.includes(value) ? prev : [...prev, value]))
      editedPreferredRef.current = true
      setPreferredLan(value)
    }
    setAddOpen(null)
    setAddDraft('')
    setAddError('')
  }

  function submit() {
    if (!canSave) return
    // TCP 那格只收「主机:端口」的明文目标：填了带 scheme 的地址（尤其 https://）就别偷偷当明文存，
    // 当场提示去「直连地址」那栏，并拦下这次保存。
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(manualTcpUrl.trim())) {
      setTcpHint(t('panel.address.tcpSchemeHint'))
      return
    }
    const patch: ConfigPatch = {}
    if (relayUrl.trim() !== status.relayUrl) patch.relayUrl = relayUrl.trim()
    // 注册密钥不在这里带：它在地址框的「注册密钥」按钮弹窗里单独保存（status 不回明文，
    // 主窗无从判断动没动过；空串进 patch 会被宿主当成「清空」）。
    // 出站协议族：跟落盘的现值比，真的变了才带，别每次都触发一轮隧道重建。
    if (ipVersionPolicy !== (status.ipVersionPolicy ?? 'auto')) patch.ipVersionPolicy = ipVersionPolicy
    // 手填地址：空串是合法值（= 清掉这一条），所以这里跟 `name` 不一样，只在**真的变了**时带上，
    // 而不是「非空才带」。
    const direct = trimUrl(manualLanUrl)
    if (direct !== trimUrl(addressBook?.manual ?? '')) patch.manualLanUrl = direct
    const ipv6 = trimUrl(manualIpv6Url)
    // 基线是「真落盘过的手填」或「探测到的那条」：用户没动过、框里还是探测地址时不算改，
    // 免得保存一次就把当前探测结果钉成手填（IPv6 前缀会变，钉死了反而多一条陈旧候选）。
    const ipv6Baseline = trimUrl(addressBook?.manualIpv6 || addressBook?.ipv6?.[0]?.url || '')
    if (ipv6 !== ipv6Baseline) patch.manualIpv6Url = ipv6
    // 公网 IPv4：同样只在真的变了才带上（空串 = 清掉这条）。
    const ipv4 = trimUrl(manualIpv4Url)
    if (ipv4 !== trimUrl(addressBook?.manualIpv4 ?? '')) patch.manualIpv4Url = ipv4
    // TCP 直连目标是 `主机:端口`（可带 http:// 前缀），空串合法（= 清掉这一条）。格式由宿主的
    // `tcpDirectTarget` 判，这里只去尾部斜杠，免得同一条存成两种写法。
    const tcp = trimUrl(manualTcpUrl)
    if (tcp !== trimUrl(addressBook?.manualTcp ?? '')) patch.manualTcpUrl = tcp
    // 局域网地址：空串是合法值（= 不指定优先哪条）。填了一个本机根本没有的地址就当场拦下 ——
    // 宿主只按「候选里有没有这条」排序，敲错等于白填，界面不能装作存上了。
    const wantedLan = preferredLan.trim()
    if (editedPreferredRef.current && wantedLan !== (addressBook?.preferred ?? '').trim()) {
      if (wantedLan && !pickableAddresses.some((item) => item.address === wantedLan) && !extraLan.includes(wantedLan)) {
        setLanHint(t('panel.address.lanUnknown'))
        return
      }
      patch.preferredLanAddress = wantedLan
    }
    onSave(patch)
  }

  /**
   * IPv4 那栏的候选：网卡上的公网 IPv4、宿主识别到的出口地址、用户自己加的。
   *
   * 出口地址按当前局域网端口拼成 URL —— 家庭宽带多半要自己把端口映射出去，所以这里给的
   * 是一条候选而不是「已经可用」的承诺，点「检测」才知道通不通。
   */
  const ipv4Options: ComboOption[] = (() => {
    const list: ComboOption[] = []
    for (const item of addressBook?.public ?? []) {
      if (!list.some((option) => option.value === item.url)) list.push({ value: item.url, label: item.interface ? `${item.url} · ${item.interface}` : item.url })
    }
    if (detectedIpv4) {
      const url = `http://${detectedIpv4}:${status.lan.port}`
      const label = `${url} · ${t('panel.address.ipv4Auto')}`
      const hit = list.findIndex((option) => option.value === url)
      if (hit >= 0) list[hit] = { value: url, label }
      else list.unshift({ value: url, label })
    }
    for (const url of extraIpv4) {
      if (!list.some((option) => option.value === url)) list.push({ value: url, label: url })
    }
    return list
  })()

  if (!open) return null

  return (
    <>
      {/* 网络配置铺在首页（2026-11-23 用户要求）：同一套字段与控制台组件，不再单开一页、
          也没有「关闭返回」。字段的初始化仍挂 `open`（首页为真、离开首页为假），离开再回来自动复位。 */}
      {/* 公告刘海贴在卡片上沿：卡片内层 overflow-hidden，所以交给外面这层 relative 定位。 */}
      <div className="relative">
        <div className="absolute start-1/2 top-0 z-10 min-w-[30rem] max-w-[80%] -translate-x-1/2 rounded-b-2xl border-x border-b border-border-muted bg-background px-8 py-1 text-center text-sm font-semibold text-foreground-muted">
          {t('panel.notice.text')}
        </div>
        <Card frame="solid">
          {/* 一屏两列（宽够时）：7 个 Field 交同一段 grid 按行自动填，从左到右、从上到下依次是
              局域网地址 / 自建中转 / IPv4 / IPv6 / TCP 直连 / 直连 / FRP（2026-11-26 用户定的顺序）。
              新方式顺着往下加即可，空位留在最后；窄窗口自动收成一列。 */}
          <div className="flex flex-col gap-5 px-4 pb-4 pt-8">
            {/* 国内 / 国际线路入口放到最上面（2026-11-26 用户要求）：绝大多数用户不自建网络，
                先给服务商线路更醒目。点开是独立一页，线路越加越多也不会把这一页撑长。 */}
            <section className="flex flex-col gap-3">
              <div className="border-b border-border-muted pb-3">
                <NetworkRegions status={status} onChanged={onProviderChanged} onOpenProvider={onOpenProvider} />
              </div>
            </section>
            <section className="flex flex-col gap-3">
              {/* 自定义网络：用户自己填地址的那一组，标题跟服务商线路同款。 */}
              <span className="text-sm font-medium text-foreground-strong">{t('panel.network.customTitle')}</span>
              <div className="grid grid-cols-1 items-start gap-x-8 gap-y-4 lg:grid-cols-2">
                  {/* 局域网地址：下拉直接选（不手填），网卡取不到时可「添加地址」；可点「检测」回环验证。 */}
                  <Field>
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <FieldLabel htmlFor="relay-preferred-lan">{t('panel.address.lan')}</FieldLabel>
                        {probeNote(lanProbe)}
                      </div>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => { setAddDraft(''); setAddError(''); setAddOpen('lan') }}>
                          {t('panel.address.add')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canSave || lanProbe.state === 'checking'}
                          onClick={() => probeLoop(lanProbeTarget(preferredLan), setLanProbe)}
                        >
                          {t(lanProbe.state === 'checking' ? 'panel.relay.detecting' : 'panel.relay.detect')}
                        </Button>
                      </div>
                    </div>
                    <AddressCombo
                      id="relay-preferred-lan"
                      value={preferredLan}
                      placeholder={t('panel.address.lanPlaceholder')}
                      ariaLabel={t('panel.address.lan')}
                      readOnly
                      options={[
                        ...pickableAddresses.map((item) => ({ value: item.address, label: item.url })),
                        ...extraLan.map((address) => ({ value: address, label: address })),
                      ]}
                      emptyText={t('panel.address.empty')}
                      onChange={(value) => {
                        editedPreferredRef.current = true
                        setLanHint('')
                        setPreferredLan(value)
                      }}
                    />
                    {lanHint ? <p className="text-xs text-error">{lanHint}</p> : null}
                    {addressError ? (
                      <p className="text-xs text-error">
                        {t('panel.address.loadFailed')}
                        <Button variant="ghost" size="sm" onClick={onRetryAddresses}>{t('panel.address.retry')}</Button>
                      </p>
                    ) : null}
                  </Field>

                {/* 自建中转。右侧那颗「中转仓库」跳去中转本体与部署说明的仓库：想自己搭的人不用再去
                    别处找地址。外链用 `<a>` 而不是 `window.open` —— 桌面壳只把 http(s) 交给
                    系统浏览器，新标签页由浏览器自己开，脚本被拦也不影响（同 StarButton）。 */}
                  <Field>
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <FieldLabel htmlFor="relay-url">{t('panel.relay.selfKind')}</FieldLabel>
                        {selfProbe.state === 'idle' ? null : (
                          <span className={`text-xs ${selfProbe.state === 'ok' ? 'text-success' : selfProbe.state === 'checking' ? 'text-foreground-muted' : 'text-warning'}`}>
                            {selfProbe.state === 'checking'
                              ? t('panel.relay.detecting')
                              : selfProbe.state === 'ok'
                                ? `${t('panel.relay.detectOk')}${selfProbe.version ? ` · v${selfProbe.version}` : ''}${typeof selfProbe.ms === 'number' ? ` · ${selfProbe.ms} ms` : ''}`
                                : selfProbe.state === 'not-relay'
                                  ? t('panel.relay.detectNotOurs')
                                  : t('panel.relay.detectFail')}
                          </span>
                        )}
                      </div>
                      {/* 仓库链接与「检测」一起贴右边：三颗散在中间会看不出哪边是标题、哪边是动作。 */}
                      <div className="ml-auto flex items-center gap-1">
                        <a
                          href={RELAY_REPO_URL}
                          target="_blank"
                          rel="noreferrer noopener"
                          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                        >
                          {t('panel.relay.selfRepo')}
                        </a>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canSave || selfProbe.state === 'checking'}
                          onClick={checkSelfRelay}
                        >
                          {t(selfProbe.state === 'checking' ? 'panel.relay.detecting' : 'panel.relay.detect')}
                        </Button>
                      </div>
                    </div>
                    <Input
                      inputProps={{ id: 'relay-url', className: 'font-mono' }}
                      value={relayUrl}
                      placeholder="https://example.com"
                      onChange={(event) => setRelayUrl(event.target.value)}
                      endSlot={
                        <button
                          type="button"
                          className="-mr-1 shrink-0 cursor-pointer whitespace-nowrap px-1 text-xs text-foreground-muted hover:text-foreground-strong focus-visible:outline-none"
                          onClick={() => { setRegisterSecretDraft(''); setRegisterSecretDialogOpen(true) }}
                        >
                          {t('panel.relay.registerSecret')}
                        </button>
                      }
                    />
                    {/^http:\/\//i.test(trimUrl(relayUrl)) ? (
                      <p className="text-xs text-warning">{t('panel.address.plainHttpWarn')}</p>
                    ) : null}
                  </Field>

                  <Field>
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <FieldLabel htmlFor="relay-manual-ipv4">{t('panel.address.ipv4Url')}</FieldLabel>
                        {probeNote(ipv4Probe)}
                      </div>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => { setAddDraft(''); setAddError(''); setAddOpen('ipv4') }}>
                          {t('panel.address.add')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canSave || ipv4Probe.state === 'checking'}
                          onClick={() => probeLoop(manualIpv4Url, setIpv4Probe)}
                        >
                          {t(ipv4Probe.state === 'checking' ? 'panel.relay.detecting' : 'panel.relay.detect')}
                        </Button>
                      </div>
                    </div>
                    {/* 与局域网、IPv6 同一套：候选点箭头挑，手写的走「添加地址」。 */}
                    <AddressCombo
                      id="relay-manual-ipv4"
                      value={manualIpv4Url}
                      placeholder={t('panel.address.ipv4Placeholder')}
                      ariaLabel={t('panel.address.ipv4Url')}
                      readOnly
                      options={ipv4Options}
                      emptyText={t('panel.address.empty')}
                      onChange={(value) => {
                        editedIpv4Ref.current = true
                        setManualIpv4Url(value)
                        setIpv4Probe({ state: 'idle' })
                      }}
                    />
                    {/^http:\/\//i.test(trimUrl(manualIpv4Url)) ? (
                      <p className="text-xs text-warning">{t('panel.address.plainHttpWarn')}</p>
                    ) : null}
                  </Field>

                  <Field>
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <FieldLabel htmlFor="relay-manual-ipv6">{t('panel.address.ipv6Url')}</FieldLabel>
                        {probeNote(ipv6Probe)}
                      </div>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => { setAddDraft(''); setAddError(''); setAddOpen('ipv6') }}>
                          {t('panel.address.add')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canSave || ipv6Probe.state === 'checking'}
                          onClick={() => probeLoop(manualIpv6Url, setIpv6Probe)}
                        >
                          {t(ipv6Probe.state === 'checking' ? 'panel.relay.detecting' : 'panel.relay.detect')}
                        </Button>
                      </div>
                    </div>
                    {/* 探测到的 IPv6 挂成候选：点箭头挑一条，不能手敲；没有时用「添加地址」。 */}
                    <AddressCombo
                      id="relay-manual-ipv6"
                      value={manualIpv6Url}
                      placeholder={t('panel.address.ipv6Placeholder')}
                      ariaLabel={t('panel.address.ipv6Url')}
                      readOnly
                      options={(addressBook?.ipv6 ?? []).map((item) => ({
                        value: item.url,
                        label: item.interface ? `${item.url} · ${item.interface}` : item.url,
                      }))}
                      emptyText={t('panel.address.empty')}
                      onChange={(value) => {
                        editedIpv6Ref.current = true
                        setManualIpv6Url(value)
                        setIpv6Probe({ state: 'idle' })
                      }}
                    />
                  </Field>

                  <Field>
                    {/* TCP 直连：手机用裸 TCP 拨的目标（iOS 经本机回环绕 ATS、安卓直连）。
                        与上面的直连地址是两条独立入口，互不覆盖。 */}
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <FieldLabel htmlFor="relay-manual-tcp">{t('panel.address.tcp')}</FieldLabel>
                        {probeNote(tcpProbe)}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!canSave || tcpProbe.state === 'checking'}
                        onClick={() => probeLoop(manualTcpUrl, setTcpProbe)}
                      >
                        {t(tcpProbe.state === 'checking' ? 'panel.relay.detecting' : 'panel.relay.detect')}
                      </Button>
                    </div>
                    <Input
                      inputProps={{ id: 'relay-manual-tcp', className: 'font-mono' }}
                      value={manualTcpUrl}
                      placeholder={t('panel.address.tcpPlaceholder')}
                      onChange={(event) => {
                        editedTcpRef.current = true
                        setManualTcpUrl(event.target.value)
                        setTcpProbe({ state: 'idle' })
                        // 填了带 scheme 的地址（尤其 https://）就当场提示：这格是明文通道，
                        // 要走 TLS 得填到上面的「直连」。保存时还会再拦一次。
                        setTcpHint(/^[a-z][a-z0-9+.-]*:\/\//i.test(event.target.value.trim())
                          ? t('panel.address.tcpSchemeHint')
                          : '')
                      }}
                    />
                    {tcpHint ? <p className="text-xs text-error">{tcpHint}</p> : null}
                  </Field>

                  <Field>
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <FieldLabel htmlFor="relay-manual-lan">{t('panel.address.direct')}</FieldLabel>
                        {probeNote(directProbe)}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!canSave || directProbe.state === 'checking'}
                        onClick={() => probeLoop(manualLanUrl, setDirectProbe)}
                      >
                        {t(directProbe.state === 'checking' ? 'panel.relay.detecting' : 'panel.relay.detect')}
                      </Button>
                    </div>
                    <Input
                      inputProps={{ id: 'relay-manual-lan', className: 'font-mono' }}
                      value={manualLanUrl}
                      placeholder={t('panel.address.directPlaceholder')}
                      onChange={(event) => {
                        editedLanRef.current = true
                        setManualLanUrl(event.target.value)
                        setDirectProbe({ state: 'idle' })
                      }}
                    />
                    {/^http:\/\//i.test(trimUrl(manualLanUrl)) ? (
                      <p className="text-xs text-warning">{t('panel.address.plainHttpWarn')}</p>
                    ) : null}
                  </Field>

                  <Field>
                    {/* FRP 与局域网 / IPv6 / IPv4 同一套：地址来自导入的配置，只读挑候选，
                        手敲没有意义（敲了也不改 frpc 里的映射）。配置本身走「导入」弹窗。 */}
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <FieldLabel htmlFor="relay-frp">{t('panel.frp.manageTitle')}</FieldLabel>
                        {probeNote(frpProbe)}
                      </div>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => { void loadFrpConfig(); setFrpDialogOpen(true) }}>
                          {t('panel.frp.import')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canSave || frpProbe.state === 'checking' || !status.frp?.remoteAddress}
                          onClick={() => probeLoop(status.frp?.remoteAddress || '', setFrpProbe)}
                        >
                          {t(frpProbe.state === 'checking' ? 'panel.relay.detecting' : 'panel.relay.detect')}
                        </Button>
                      </div>
                    </div>
                    <AddressCombo
                      id="relay-frp"
                      value={status.frp?.remoteAddress ?? ''}
                      placeholder={t('panel.frp.remotePlaceholder')}
                      ariaLabel={t('panel.frp.manageTitle')}
                      readOnly
                      options={status.frp?.remoteAddress ? [{ value: status.frp.remoteAddress, label: status.frp.remoteAddress }] : []}
                      emptyText={t('panel.address.empty')}
                      onChange={() => { /* 只读：地址由导入的配置决定，点候选只是回显同一条 */ }}
                    />
                    {frpNote ? <p className="text-xs text-error">{frpNote}</p> : null}
                  </Field>
              </div>
            </section>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border-muted p-3">
            {/* 出站协议族：文字按钮带出设置弹窗，紧挨「保存配置」靠右，不占正文行。 */}
            <button
              type="button"
              className="text-sm text-foreground-muted hover:text-foreground"
              onClick={() => { setIpVersionDraft(ipVersionPolicy); setIpVersionDialogOpen(true) }}
            >
              {t('panel.network.ipVersionTitle')}
            </button>
            {/* 保存期间给一条进度（含 FRP 导入最多等 8 秒），并可随时取消。 */}
            {busy === 'config' ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-foreground-muted">
                <Spinner />
                {t('panel.shell.busy')}
              </span>
            ) : null}
            <Button variant="primary" disabled={!canSave} onClick={submit}>
              {t('panel.relay.saveConfig')}
            </Button>
          </div>
        </Card>
      </div>

      {/* 局域网地址：清单放在弹窗里，几条都不影响主窗。选中即存（与配对卡同一份口径）。 */}
      <Dialog open={lanPickerOpen} onOpenChange={setLanPickerOpen}>
        <DialogContent className="w-[min(560px,92vw)]" initialFocus={lanPickerRef}>
          <DialogHeader>
            <DialogTitle>{t('panel.address.lan')}</DialogTitle>
          </DialogHeader>
          <div ref={lanPickerRef} tabIndex={-1} className="outline-none">
            <DialogBody className="max-h-[60vh] overflow-y-auto px-1 py-2">
              <AddressPicker
                align="start"
                book={addressBook}
                error={addressError}
                onRetry={onRetryAddresses}
                port={status.lan.port}
                value={addressBook?.preferred ?? ''}
                busy={busy !== ''}
                fallbackUrls={lanUrls}
                onChange={(address) => {
                  onSavePreferred(address)
                  setLanPickerOpen(false)
                }}
              />
            </DialogBody>
          </div>
          <DialogFooter className="flex justify-end">
            <Button variant="outline" onClick={() => setLanPickerOpen(false)}>
              {t('panel.common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 添加地址：网卡扫不到局域网 / IPv6 地址时，手动补一条（保存前校验形状）。 */}
      <Dialog open={addOpen !== null} onOpenChange={(next) => { if (!next) { setAddOpen(null); setAddDraft(''); setAddError('') } }}>
        <DialogContent className="w-[min(520px,92vw)]">
          <DialogHeader>
            <DialogTitle>{addOpen === 'ipv6' ? t('panel.address.ipv6Url') : addOpen === 'ipv4' ? t('panel.address.ipv4Url') : t('panel.address.lan')}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <Input
              inputProps={{ className: 'font-mono' }}
              value={addDraft}
              placeholder={addOpen === 'ipv6'
                ? t('panel.address.ipv6Placeholder')
                : addOpen === 'ipv4'
                  ? t('panel.address.ipv4Placeholder')
                  : t('panel.address.lanPlaceholder')}
              onChange={(event) => { setAddDraft(event.target.value); setAddError('') }}
            />
            {addError ? <p className="mt-1 text-xs text-error">{addError}</p> : null}
          </DialogBody>
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setAddOpen(null); setAddDraft(''); setAddError('') }}>
              {t('panel.common.cancel')}
            </Button>
            <Button variant="primary" onClick={submitAdd}>{t('panel.common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* FRP 配置：粘贴 frpc 配置，保存并启动本地 frpc（2026-11-22：从主窗挪进弹窗，少占版面）。 */}
      <Dialog open={frpDialogOpen} onOpenChange={(next) => { if (next) setFrpDialogOpen(true); else closeFrpDialog() }}>
        <DialogContent className="w-[min(560px,92vw)]">
          <DialogHeader>
            <DialogTitle>{t('panel.frp.manageTitle')}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <textarea
              className="min-h-40 w-full rounded-md border border-border bg-background p-2 font-mono text-xs text-foreground focus-visible:outline-none"
              value={frpText}
              placeholder={t('panel.frp.configLabel')}
              onChange={(event) => { frpEditedRef.current = true; setFrpText(event.target.value) }}
            />
            {status.frp?.running && status.frp?.remoteAddress ? (
              <p className="mt-1 text-xs text-foreground-muted">{status.frp.remoteAddress}</p>
            ) : null}
            {status.frp?.error ? <p className="mt-1 text-xs text-error">{status.frp.error}</p> : null}
            {frpNote ? <p className="mt-1 text-xs text-error">{frpNote}</p> : null}
          </DialogBody>
          <DialogFooter className="flex justify-end gap-2">
            {frpBusy !== '' ? (
              <span className="mr-auto inline-flex items-center gap-1.5 text-xs text-foreground-muted">
                <Spinner />
                {t('panel.shell.busy')}
              </span>
            ) : null}
            <Button variant="ghost" size="sm" disabled={frpBusy !== ''} onClick={stopFrpNow}>
              {t('panel.frp.stop')}
            </Button>
            <Button variant="outline" onClick={closeFrpDialog}>
              {t('panel.common.cancel')}
            </Button>
            <Button variant="primary" disabled={frpBusy !== '' || !frpText.trim()} onClick={() => { void saveFrp() }}>
              {t('panel.frp.saveStart')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 出站协议族：三档在弹窗里选，保存直接落盘（走 onSave 的配置补丁，与其余字段同一条路径）。 */}
      <Dialog open={ipVersionDialogOpen} onOpenChange={setIpVersionDialogOpen}>
        <DialogContent className="w-[min(440px,92vw)]">
          <DialogHeader>
            <DialogTitle>{t('panel.network.ipVersionTitle')}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <RadioGroup
              className="flex flex-col gap-3"
              value={ipVersionDraft}
              onValueChange={(next) => {
                if (next === 'auto' || next === 'ipv4-first' || next === 'ipv4-only') setIpVersionDraft(next)
              }}
            >
              <label className="flex cursor-pointer items-center gap-2">
                <Radio value="auto" />
                <span className="text-sm text-foreground">{t('panel.network.ipVersionAuto')}</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <Radio value="ipv4-first" />
                <span className="text-sm text-foreground">{t('panel.network.ipVersionV4First')}</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <Radio value="ipv4-only" />
                <span className="text-sm text-foreground">{t('panel.network.ipVersionV4Only')}</span>
              </label>
            </RadioGroup>
          </DialogBody>
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setIpVersionDialogOpen(false)}>
              {t('panel.common.cancel')}
            </Button>
            <Button variant="primary" disabled={!canSave} onClick={() => {
              if (ipVersionDraft !== ipVersionPolicy) {
                setIpVersionPolicy(ipVersionDraft)
                onSave({ ipVersionPolicy: ipVersionDraft })
              }
              setIpVersionDialogOpen(false)
            }}>
            {t('panel.common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 注册密钥：地址框里那颗文字按钮点开，在这里填。只写不回显，留空=不改动。 */}
      <Dialog open={registerSecretDialogOpen} onOpenChange={setRegisterSecretDialogOpen}>
        <DialogContent className="w-[min(440px,92vw)]">
          <DialogHeader>
            <DialogTitle>{t('panel.relay.registerSecret')}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <Input
              inputProps={{ id: 'relay-register-secret', type: 'password', autoComplete: 'off', className: 'font-mono' }}
              value={registerSecretDraft}
              placeholder={t('panel.relay.registerSecretPlaceholder')}
              onChange={(event) => setRegisterSecretDraft(event.target.value)}
            />
            <p className="text-xs text-foreground-muted">{t('panel.relay.registerSecretHint')}</p>
          </DialogBody>
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setRegisterSecretDialogOpen(false)}>
              {t('panel.common.cancel')}
            </Button>
            <Button variant="primary" disabled={!canSave} onClick={() => {
              // 留空 = 不改动（空串进 patch 会被宿主当成「清空密钥」）；填了才写下去。
              if (registerSecretDraft !== '') onSave({ registerSecret: registerSecretDraft })
              setRegisterSecretDialogOpen(false)
            }}>
              {t('panel.common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

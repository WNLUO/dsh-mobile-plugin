// FRP 子窗结果暂存到父窗保存，地址错误可重取，健康探测包含当前自建中转。
import { Button, buttonVariants } from '@appica/ui-react/button'
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
import { Spinner } from '@appica/ui-react/spinner'
import { useEffect, useRef, useState } from 'react'

import type { AddressBook, ConfigPatch, StatusView } from '../lib/api.ts'
import { PUBLIC_RELAYS, RELAY_REPO_URL } from '../lib/links.ts'
import { t } from '../lib/i18n/index.ts'
import { AddressPicker } from './AddressPicker.tsx'
import { FrpImportDialog } from './FrpImportDialog.tsx'
import { PublicRelayPanelDialog } from './PublicRelayPanelDialog.tsx'

type ComboOption = { value: string; label: string }

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
}: {
  id: string
  value: string
  placeholder: string
  ariaLabel: string
  options: ComboOption[]
  emptyText: string
  onChange: (value: string) => void
}) {
  return (
    <Input
      inputProps={{ id, className: 'font-mono' }}
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
  open: boolean
  onOpenChange: (open: boolean) => void
  status: StatusView
  /** 宿主枚举的地址库（`/api/relay/addresses`）：局域网选择与手填那两条都从它预填。 */
  addressBook: AddressBook | null
  addressError?: string
  onRetryAddresses?: (() => void) | undefined
  /** 宿主在二维码里给的那串地址：拿不到地址库（老宿主）时退回它，只显示不能选。 */
  lanUrls: string[]
  busy: string
  onSave: (patch: ConfigPatch, frpConfig?: { config: string; field: 'tcp' | 'direct'; value: string }) => void
  /** 「手机优先用这条」：点了就存、不关窗，所以和上面那个带保存按钮的 `onSave` 分开。 */
  onSavePreferred: (address: string) => void
}

/**
 * 「网络配置」弹窗：这台宿主能被手机摸到的四条地址都在这里改。
 *
 *   ① 中转地址（`relayUrl`）—— 拆成两栏：第一栏「公用中转」是内置地址（只读展示，标题右侧
 *      一颗「启用 / 停用」切换），第二栏「自建中转」可编辑。2026-11-18 用户要求把公用中转
 *      内置进来、排在第一个，原「选择公用中转」清单弹窗随之撤掉；
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
 * **中转两栏**（2026-11-18 用户要求）：公用内置、排在第一个、只读展示；自建在它下面、可编辑。
 * 公用走整份 `relayUrls`、自建走单条 `relayUrl`：标题右侧「启用」把整份内置清单写进去、「停用」清空
 * 交回局域网直连，自建栏照旧敲。清单弹窗撤掉后，这两颗按钮就是公用的唯一开关。
 *
 * **一屏两列**（2026-11-01 用户要求）：左列是「经公网的那几条」（设备名 / 中转 / 直连），
 * 右列是「局域网这一侧」（局域网地址 / IPv6 / 允许配对）。默认窗口高度下不出现滚动条 ——
 * 矮窗口留 `max-h` 只是兜底。两条会长短不一的东西（公用中转清单、网卡地址清单）都收进
 * 同级弹窗，主窗的尺寸不再随地址条数变。
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
  onOpenChange,
  status,
  addressBook,
  addressError = '',
  onRetryAddresses,
  lanUrls,
  busy,
  onSave,
  onSavePreferred,
}: Props) {
  const [relayUrl, setRelayUrl] = useState(status.relayUrl)
  /** 用户显式停用了公用中转（issue #27）：开窗时按宿主 status 灌，保存时把意图发回去。 */
  const [publicDisabled, setPublicDisabled] = useState(status.publicRelayDisabled === true)
  /** 直连地址（`manualLanUrl`）：用户手填的穿透域名 / 公网 IP。 */
  const [manualLanUrl, setManualLanUrl] = useState('')
  /** IPv6 直连地址（`manualIpv6Url`）：手填的公网 IPv6 入口；没填过时先显示探测到的那条。 */
  const [manualIpv6Url, setManualIpv6Url] = useState('')
  /** TCP 直连地址（`manualTcpUrl`）：用户手填的 `主机:端口`，手机用裸 TCP 拨它。 */
  const [manualTcpUrl, setManualTcpUrl] = useState('')
  /**
   * 局域网地址（`preferredLanAddress`）：**可手填**，不再只让用户从检测到的那几条里挑。
   * 机器有好几块网卡、想直接敲一条地址时用得上；填错了拦在保存那儿（见 `unknownLan`）。
   */
  const [preferredLan, setPreferredLan] = useState('')
  /** 这一次开窗里用户动过局域网地址那一栏没有：动过就不再拿地址库去盖。 */
  const [lanHint, setLanHint] = useState('')
  /** 「选择局域网地址」弹窗开着没有。 */
  const [lanPickerOpen, setLanPickerOpen] = useState(false)
  /** 「FRP 导入」弹窗开着没有。 */
  const [frpImportOpen, setFrpImportOpen] = useState(false)
  const [pendingFrp, setPendingFrp] = useState<{ config: string; field: 'tcp' | 'direct'; value: string } | undefined>()
  /** 「公用中转面板」弹窗开着没有：查看各条入口的延迟与心电图。 */
  const [publicPanelOpen, setPublicPanelOpen] = useState(false)
  /** 子弹窗的落焦目标：清单让焦点落在容器上，别一开窗就圈住第一行。 */
  const lanPickerRef = useRef<HTMLDivElement | null>(null)
  /** 弹窗打开时的落焦目标：容器自己，不是第一个输入框（见下面 `initialFocus`）。 */
  const dialogRef = useRef<HTMLDivElement | null>(null)
  /** 这一次开窗里用户动过手填那两栏没有：动过就不再拿地址库去盖。 */
  const editedLanRef = useRef(false)
  const editedIpv6Ref = useRef(false)
  const editedTcpRef = useRef(false)
  const editedPreferredRef = useRef(false)

  /** 能用的局域网地址（与宿主 `advertisedCandidates` 同口径：有私网就只带私网）。 */
  const pickableAddresses = addressBook ? (addressBook.lan.length > 0 ? addressBook.lan : addressBook.public) : []

  // 只在开窗那一刻灌一次当前值：status 每 3 秒换一个对象，
  // 把它当依赖会让正在敲的字被轮询覆盖掉。
  useEffect(() => {
    if (!open) return
    setRelayUrl(status.relayUrl)
    setPublicDisabled(status.publicRelayDisabled === true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上：只认 open
  }, [open])

  // 主窗关掉时把两个子弹窗一起收掉：下次开窗不能带着上一轮的清单挡在主窗前面。
  useEffect(() => {
    if (open) return
    setLanPickerOpen(false)
    setFrpImportOpen(false)
    setPendingFrp(undefined)
  }, [open])

  // 地址库是开窗之后才取回来的（App 那边是异步的），所以手填的两条单独跟它走：
  // 没动过就一直按地址库回显（关窗后重开也回到落盘的那份），动过就一律以输入框为准，
  // 免得用户正在敲的字被后来补上的地址库冲掉。
  useEffect(() => {
    if (!open) {
      editedLanRef.current = false
      editedIpv6Ref.current = false
      editedTcpRef.current = false
      editedPreferredRef.current = false
      setLanHint('')
      return
    }
    if (!editedLanRef.current) setManualLanUrl(addressBook?.manual ?? '')
    // 探测到的 IPv6 全球单播先填进框里，别让这栏空着像没识别到；有手填过的以手填为准。
    // 只是显示，`submit` 那边会把「还是这条探测地址」当成没改，不偷偷落成手填。
    if (!editedIpv6Ref.current) {
      setManualIpv6Url(addressBook?.manualIpv6 || addressBook?.ipv6?.[0]?.url || '')
    }
    if (!editedTcpRef.current) setManualTcpUrl(addressBook?.manualTcp ?? '')
    if (!editedPreferredRef.current) {
      const candidates = addressBook ? (addressBook.lan.length > 0 ? addressBook.lan : addressBook.public) : []
      setPreferredLan((addressBook?.preferred || '').trim() || (candidates[0]?.address ?? ''))
    }
    // 只认 open 与地址库：`pickableAddresses` 每次渲染都是新数组，拿它当依赖会让这个 effect 每帧跑。
  }, [open, addressBook])

  const canSave = busy === ''
  /**
   * 当前中转地址用的是哪条内置公用地址（命中清单的那条，没命中就是 null）。
   *
   * 公用走整份 `relayUrls`、自建走单条 `relayUrl`，没有独立的类型位，所以从地址本身判。
   * 命中内置清单 = 正在用公用：那一栏只读展示、标「使用中」，自建栏留空；
   * 没命中 = 正在用自建（或都没用）：自建栏照旧可编辑。
   */
  const activePublicRelay = PUBLIC_RELAYS.find((item) => item.url === relayUrl.trim()) ?? null
  /** 宿主判定公用被强制停用（用户配了公网自建）：地址划删除线、禁用「启用」，只如实展示。 */
  const publicRelayBlocked = status.publicRelayBlocked === true
  /** 当前公用是否正被使用：可显示为「停用」按钮（被强制停用或用户已显式停用则否）。 */
  const publicActive = !!activePublicRelay && !publicDisabled && !publicRelayBlocked
  /** 公用整栏是否处于「已禁用」展示态：自建强制停用，或用户显式停用（issue #27）。 */
  const publicOff = publicRelayBlocked || publicDisabled
  /** 直连那两条按宿主口径去掉尾部斜杠：它拼出来的是一条候选 URL，多一个 `/` 就多一条重复项。 */
  const trimUrl = (value: string) => value.trim().replace(/\/+$/, '')

  function submit() {
    if (!canSave) return
    const patch: ConfigPatch = {}
    // 公用走整份 `relayUrls`（电脑在几台内置中转之间选择 / 失败切换）；自建走单条 `relayUrl`。
    if (activePublicRelay) {
      patch.relayUrls = PUBLIC_RELAYS.map((r) => r.url)
    } else if (relayUrl.trim() !== status.relayUrl) {
      patch.relayUrl = relayUrl.trim()
    }
    // 「停用 / 启用公用中转」显式沿用用户的意图（issue #27）：只在这次和落盘的不一致时带上，
    // 避免每次保存都写一遍。停用时宿主据此不再补回公用地址，跨重启生效。
    if (publicDisabled !== (status.publicRelayDisabled === true)) {
      patch.publicRelayDisabled = publicDisabled
    }
    // 手填地址：空串是合法值（= 清掉这一条），所以这里跟 `name` 不一样，只在**真的变了**时带上，
    // 而不是「非空才带」。
    const direct = trimUrl(manualLanUrl)
    if (direct !== trimUrl(addressBook?.manual ?? '')) patch.manualLanUrl = direct
    const ipv6 = trimUrl(manualIpv6Url)
    // 基线是「真落盘过的手填」或「探测到的那条」：用户没动过、框里还是探测地址时不算改，
    // 免得保存一次就把当前探测结果钉成手填（IPv6 前缀会变，钉死了反而多一条陈旧候选）。
    const ipv6Baseline = trimUrl(addressBook?.manualIpv6 || addressBook?.ipv6?.[0]?.url || '')
    if (ipv6 !== ipv6Baseline) patch.manualIpv6Url = ipv6
    // TCP 直连目标是 `主机:端口`（可带 http:// 前缀），空串合法（= 清掉这一条）。格式由宿主的
    // `tcpDirectTarget` 判，这里只去尾部斜杠，免得同一条存成两种写法。
    const tcp = trimUrl(manualTcpUrl)
    if (tcp !== trimUrl(addressBook?.manualTcp ?? '')) patch.manualTcpUrl = tcp
    // 局域网地址：空串是合法值（= 不指定优先哪条）。填了一个本机根本没有的地址就当场拦下 ——
    // 宿主只按「候选里有没有这条」排序，敲错等于白填，界面不能装作存上了。
    const wantedLan = preferredLan.trim()
    if (editedPreferredRef.current && wantedLan !== (addressBook?.preferred ?? '').trim()) {
      if (wantedLan && !pickableAddresses.some((item) => item.address === wantedLan)) {
        setLanHint(t('panel.address.lanUnknown'))
        return
      }
      patch.preferredLanAddress = wantedLan
    }
    onSave(patch, pendingFrp)
  }

  return (
    <>
      {/* 保存中也可以关窗：请求本身会跑完（失败时回滚已拉起的 frpc，见 Console.saveConfig），
          用户不必被锁在弹窗里等宿主。落盘成功后 Console 那边也会把窗关掉。 */}
      <Dialog open={open} onOpenChange={onOpenChange}>
        {/* `initialFocus` 指向弹窗容器本身：Base UI 默认会把焦点放到第一个可聚焦元素上，
            这里就是「设备名」那个输入框——一打开就选中了、光标在闪，用户想先点别的地方
            还得先把它点掉。焦点仍旧进到弹窗里（读屏与 Esc 都靠它），只是不落在输入框。 */}
        <DialogContent className="w-[min(1100px,92vw)]" initialFocus={dialogRef}>
          <DialogHeader>
            <DialogTitle>{t('panel.pairing.openConfig')}</DialogTitle>
          </DialogHeader>

          {/* `tabIndex={-1}` 让容器可以被程序聚焦（且不进 Tab 顺序）。
              套一层 div 是因为 `DialogBody` 不接受 ref。
              两列一屏：6 个 Field 不手动分左右列，交给 grid 按行自动填（grid-auto-flow: row），
              这样每项增减都会自动重排、两列行数均衡，不会再出现左边 4 行右边 2 行。
              `max-h` 只是给很矮的窗口兜底。 */}
          <div ref={dialogRef} tabIndex={-1} className="outline-none">
            <DialogBody className="grid max-h-[calc(100vh-13rem)] grid-cols-2 items-start gap-x-8 gap-y-4 overflow-y-auto">
              {/* 第一栏：公用中转（内置、只读）。排在第一个；由我们维护，用户改不了地址。
                  标题右侧两颗文字按钮：「查看面板」在左、「启用 / 停用」在右（2026-11-19 用户要求）。
                  配了公网自建时宿主会把公用强制停用（status.publicRelayBlocked）：这一栏直接显示
                  一句「已禁用」，不再列地址、也不划删除线（2026-11-19 用户口径）——判据在宿主那一处，
                  这里只如实展示。 */}
                <Field>
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <FieldLabel>{t('panel.relay.publicKind')}</FieldLabel>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setPublicPanelOpen(true)}>
                        {t('panel.relay.viewPanel')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!canSave || publicRelayBlocked}
                        onClick={() => {
                          if (publicActive) {
                            setPublicDisabled(true)
                            setRelayUrl('')
                          } else {
                            setPublicDisabled(false)
                            setRelayUrl(PUBLIC_RELAYS[0].url)
                          }
                        }}
                      >
                        {t(publicActive ? 'panel.relay.disablePublic' : 'panel.relay.enablePublic')}
                      </Button>
                    </div>
                  </div>
                  {/* 停用时只摆一句「已禁用」，不列链接（2026-11-19 用户要求）。 */}
                  {publicOff ? (
                    <Input
                      inputProps={{
                        className: 'text-foreground-muted',
                        readOnly: true,
                        'aria-label': t('panel.relay.publicKind'),
                      }}
                      value={t('panel.relay.publicDisabled')}
                    />
                  ) : (
                    <div className="flex flex-col gap-1">
                      {PUBLIC_RELAYS.map((item) => (
                        <Input
                          key={item.url}
                          inputProps={{
                            className: 'font-mono',
                            readOnly: true,
                            'aria-label': t('panel.relay.publicKind'),
                          }}
                          value={item.url}
                        />
                      ))}
                    </div>
                  )}
                </Field>

                {/* 第二栏：自建中转。用公用时这里留空；敲入任意非内置地址即视为自建。
                    右侧那颗「中转仓库」跳去中转本体与部署说明的仓库：想自己搭的人不用再去
                    别处找地址。外链用 `<a>` 而不是 `window.open` —— 桌面壳只把 http(s) 交给
                    系统浏览器，新标签页由浏览器自己开，脚本被拦也不影响（同 StarButton）。 */}
                <Field>
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <FieldLabel htmlFor="relay-url">{t('panel.relay.selfKind')}</FieldLabel>
                    <a
                      href={RELAY_REPO_URL}
                      target="_blank"
                      rel="noreferrer noopener"
                      className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                    >
                      {t('panel.relay.selfRepo')}
                    </a>
                  </div>
                  <Input
                    inputProps={{ id: 'relay-url', className: 'font-mono' }}
                    value={activePublicRelay ? '' : relayUrl}
                    placeholder="https://example.com"
                    onChange={(event) => setRelayUrl(event.target.value)}
                  />
                </Field>

                <Field>
                  <FieldLabel htmlFor="relay-manual-lan">{t('panel.address.direct')}</FieldLabel>
                  <Input
                    inputProps={{ id: 'relay-manual-lan', className: 'font-mono' }}
                    value={manualLanUrl}
                    placeholder={t('panel.address.directPlaceholder')}
                    onChange={(event) => {
                      editedLanRef.current = true
                      setManualLanUrl(event.target.value)
                    }}
                  />
                </Field>

                <Field>
                  {/* TCP 直连：手机用裸 TCP 拨的目标（iOS 经本机回环绕 ATS、安卓直连）。
                      与上面的直连地址是两条独立入口，互不覆盖。右侧「FRP 导入」把 frpc 配置里的
                      公网入口解析出来直接填进来，省得用户自己算。 */}
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <FieldLabel htmlFor="relay-manual-tcp">{t('panel.address.tcp')}</FieldLabel>
                    <Button variant="ghost" size="sm" onClick={() => setFrpImportOpen(true)}>
                      {t('panel.address.frpImport')}
                    </Button>
                  </div>
                  <Input
                    inputProps={{ id: 'relay-manual-tcp', className: 'font-mono' }}
                    value={manualTcpUrl}
                    placeholder={t('panel.address.tcpPlaceholder')}
                    onChange={(event) => {
                      editedTcpRef.current = true
                      setManualTcpUrl(event.target.value)
                    }}
                  />
                </Field>

                {/* 局域网地址：地址可能好几条，可以从清单里挑，也可以直接敲一条。 */}
                <Field>
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <FieldLabel htmlFor="relay-preferred-lan">{t('panel.address.lan')}</FieldLabel>
                    <Button variant="ghost" size="sm" onClick={() => setLanPickerOpen(true)}>
                      {t('panel.onboarding.chooseAddress')}
                    </Button>
                  </div>
                  {/* 检测到的那几条挂成右侧常驻候选：想挑就点箭头挑，也可以直接手敲。 */}
                  <AddressCombo
                    id="relay-preferred-lan"
                    value={preferredLan}
                    placeholder={t('panel.address.lanPlaceholder')}
                    ariaLabel={t('panel.address.lan')}
                    options={pickableAddresses.map((item) => ({ value: item.address, label: item.url }))}
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

                <Field>
                  <FieldLabel htmlFor="relay-manual-ipv6">{t('panel.address.ipv6Url')}</FieldLabel>
                  {/* 探测到的 IPv6 挂成右侧常驻候选：点箭头挑一条填进来，也可以直接手敲。
                      框里默认先填探测到的那条（见上面回显那段），不会再空着。 */}
                  <AddressCombo
                    id="relay-manual-ipv6"
                    value={manualIpv6Url}
                    placeholder={t('panel.address.ipv6Placeholder')}
                    ariaLabel={t('panel.address.ipv6Url')}
                    options={(addressBook?.ipv6 ?? []).map((item) => ({
                      value: item.url,
                      label: item.interface ? `${item.url} · ${item.interface}` : item.url,
                    }))}
                    emptyText={t('panel.address.empty')}
                    onChange={(value) => {
                      editedIpv6Ref.current = true
                      setManualIpv6Url(value)
                    }}
                  />
                </Field>
            </DialogBody>
          </div>

          <DialogFooter className="flex items-center justify-end gap-2">
            {/* 保存期间给一条进度（含 FRP 导入最多等 8 秒），并可随时取消 / 关窗。 */}
            {busy === 'config' ? (
              <span className="mr-auto inline-flex items-center gap-1.5 text-xs text-foreground-muted">
                <Spinner />
                {t('panel.shell.busy')}
              </span>
            ) : null}
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('panel.common.cancel')}
            </Button>
            <Button variant="primary" disabled={!canSave} onClick={submit}>
              {t('panel.relay.saveConfig')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      {/* FRP 导入：粘一段 frpc 配置，解析出公网入口填回地址栏（tcp 进 TCP 栏、https 进直连栏）。 */}
      <FrpImportDialog
        open={frpImportOpen}
        onOpenChange={setFrpImportOpen}
        onImport={(result) => {
          setPendingFrp(result.config ? { config: result.config, field: result.field, value: result.value } : undefined)
          if (result.field === 'tcp') {
            editedTcpRef.current = true
            setManualTcpUrl(result.value)
          } else {
            editedLanRef.current = true
            setManualLanUrl(result.value)
          }
        }}
      />
      {/* 公用中转面板：查看各条内置地址的延迟与心电图，定时重测。 */}
      <PublicRelayPanelDialog
        open={publicPanelOpen}
        onOpenChange={setPublicPanelOpen}
        activeUrl={status.relayUrl}
      />
    </>
  )
}

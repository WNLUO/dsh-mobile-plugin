import { Button } from '@appica/ui-react/button'
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
import { useEffect, useRef, useState } from 'react'

import type { AddressBook, ConfigPatch, StatusView } from '../lib/api.ts'
import { PUBLIC_RELAYS } from '../lib/links.ts'
import { t } from '../lib/i18n/index.ts'
import { AddressPicker } from './AddressPicker.tsx'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: StatusView
  /** 宿主枚举的地址库（`/api/relay/addresses`）：局域网选择与手填那两条都从它预填。 */
  addressBook: AddressBook | null
  /** 宿主在二维码里给的那串地址：拿不到地址库（老宿主）时退回它，只显示不能选。 */
  lanUrls: string[]
  busy: string
  onSave: (patch: ConfigPatch) => void
  /** 「手机优先用这条」：点了就存、不关窗，所以和上面那个带保存按钮的 `onSave` 分开。 */
  onSavePreferred: (address: string) => void
}

/**
 * 「网络配置」弹窗：这台宿主能被手机摸到的四条地址都在这里改。
 *
 *   ① 中转地址（`relayUrl`）—— 走中转隧道的那一条，右上角一颗「公用中转」开清单；
 *   ② 局域网地址（`preferredLanAddress`）—— 网卡候选里「手机优先用哪条」，右上角一颗
 *      「选择地址」开选择弹窗（地址可能好几条，摊在本窗里会把版面撑变形）；
 *   ③ 直连地址（`manualLanUrl`）—— 自己把端口暴露到公网域名 / 公网 IP 时填的那一条；
 *   ④ IPv6 地址（`manualIpv6Url`）—— 手填的公网 IPv6 入口。
 *
 * 后三条都是「直连」的一套候选，彼此并存：拨不通的那条手机自己会换下一条，所以界面不强制
 * 只留一个。地址那一块原来分散在两个弹窗里（局域网直连 / 中转配置），用户要求并到一处，
 * 两个入口各改一半迟早对不上。
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
  lanUrls,
  busy,
  onSave,
  onSavePreferred,
}: Props) {
  const [relayUrl, setRelayUrl] = useState(status.relayUrl)
  /** 直连地址（`manualLanUrl`）：用户手填的穿透域名 / 公网 IP。 */
  const [manualLanUrl, setManualLanUrl] = useState('')
  /** IPv6 直连地址（`manualIpv6Url`）：用户手填的公网 IPv6 入口。 */
  const [manualIpv6Url, setManualIpv6Url] = useState('')
  /**
   * 局域网地址（`preferredLanAddress`）：**可手填**，不再只让用户从检测到的那几条里挑。
   * 机器有好几块网卡、想直接敲一条地址时用得上；填错了拦在保存那儿（见 `unknownLan`）。
   */
  const [preferredLan, setPreferredLan] = useState('')
  /** 这一次开窗里用户动过局域网地址那一栏没有：动过就不再拿地址库去盖。 */
  const [lanHint, setLanHint] = useState('')
  /** 「公用中转」清单弹窗开着没有。 */
  const [relayPickerOpen, setRelayPickerOpen] = useState(false)
  /** 「选择局域网地址」弹窗开着没有。 */
  const [lanPickerOpen, setLanPickerOpen] = useState(false)
  /** 子弹窗的落焦目标：两个清单都让焦点落在容器上，别一开窗就圈住第一行。 */
  const relayPickerRef = useRef<HTMLDivElement | null>(null)
  const lanPickerRef = useRef<HTMLDivElement | null>(null)
  /** 弹窗打开时的落焦目标：容器自己，不是第一个输入框（见下面 `initialFocus`）。 */
  const dialogRef = useRef<HTMLDivElement | null>(null)
  /** 这一次开窗里用户动过手填那两栏没有：动过就不再拿地址库去盖。 */
  const editedLanRef = useRef(false)
  const editedIpv6Ref = useRef(false)
  const editedPreferredRef = useRef(false)

  /** 能用的局域网地址（与宿主 `advertisedCandidates` 同口径：有私网就只带私网）。 */
  const pickableAddresses = addressBook ? (addressBook.lan.length > 0 ? addressBook.lan : addressBook.public) : []

  // 只在开窗那一刻灌一次当前值：status 每 3 秒换一个对象，
  // 把它当依赖会让正在敲的字被轮询覆盖掉。
  useEffect(() => {
    if (!open) return
    setRelayUrl(status.relayUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上：只认 open
  }, [open])

  // 主窗关掉时把两个子弹窗一起收掉：下次开窗不能带着上一轮的清单挡在主窗前面。
  useEffect(() => {
    if (open) return
    setRelayPickerOpen(false)
    setLanPickerOpen(false)
  }, [open])

  // 地址库是开窗之后才取回来的（App 那边是异步的），所以手填的两条单独跟它走：
  // 没动过就一直按地址库回显（关窗后重开也回到落盘的那份），动过就一律以输入框为准，
  // 免得用户正在敲的字被后来补上的地址库冲掉。
  useEffect(() => {
    if (!open) {
      editedLanRef.current = false
      editedIpv6Ref.current = false
      editedPreferredRef.current = false
      setLanHint('')
      return
    }
    if (!editedLanRef.current) setManualLanUrl(addressBook?.manual ?? '')
    if (!editedIpv6Ref.current) setManualIpv6Url(addressBook?.manualIpv6 ?? '')
    if (!editedPreferredRef.current) {
      const candidates = addressBook ? (addressBook.lan.length > 0 ? addressBook.lan : addressBook.public) : []
      setPreferredLan((addressBook?.preferred || '').trim() || (candidates[0]?.address ?? ''))
    }
    // 只认 open 与地址库：`pickableAddresses` 每次渲染都是新数组，拿它当依赖会让这个 effect 每帧跑。
  }, [open, addressBook])

  const canSave = busy === ''
  /** 直连那两条按宿主口径去掉尾部斜杠：它拼出来的是一条候选 URL，多一个 `/` 就多一条重复项。 */
  const trimUrl = (value: string) => value.trim().replace(/\/+$/, '')

  function submit() {
    if (!canSave) return
    const patch: ConfigPatch = {}
    if (relayUrl.trim() !== status.relayUrl) patch.relayUrl = relayUrl.trim()
    // 手填地址：空串是合法值（= 清掉这一条），所以这里跟 `name` 不一样，只在**真的变了**时带上，
    // 而不是「非空才带」。
    const direct = trimUrl(manualLanUrl)
    if (direct !== trimUrl(addressBook?.manual ?? '')) patch.manualLanUrl = direct
    const ipv6 = trimUrl(manualIpv6Url)
    if (ipv6 !== trimUrl(addressBook?.manualIpv6 ?? '')) patch.manualIpv6Url = ipv6
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
    onSave(patch)
  }

  return (
    <>
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
              两列、一屏排完：左列经公网、右列局域网这一侧；`max-h` 只是给很矮的窗口兜底。 */}
          <div ref={dialogRef} tabIndex={-1} className="outline-none">
            <DialogBody className="grid max-h-[calc(100vh-13rem)] grid-cols-2 items-start gap-x-8 overflow-y-auto">
              {/* 左列：经公网的那几条 */}
              <div className="flex flex-col gap-4">
                <Field>
                  {/* 清单收进弹窗：公用中转以后会变多，摊在主窗里会把整页撑长。 */}
                  {/* 允许折行：手机宽度下这行标签是三五个词（葡语 "Endereço do relay"），
                      按钮那边也是整句，并排一行会顶出弹窗右沿、和旁边的字叠在一起。 */}
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <FieldLabel htmlFor="relay-url">{t('panel.connection.relayUrl')}</FieldLabel>
                    {/* 光写「公用中转」看着像标题；带上动词才知道它是颗按钮。 */}
                    <Button variant="ghost" size="sm" onClick={() => setRelayPickerOpen(true)}>
                      {t('panel.relay.choosePublicRelay')}
                    </Button>
                  </div>
                  <Input
                    inputProps={{ id: 'relay-url', className: 'font-mono' }}
                    value={relayUrl}
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
              </div>

              {/* 右列：局域网这一侧 */}
              <div className="flex flex-col gap-4">
                <Field>
                  {/* 地址可能好几条：可以从清单里挑，也可以直接敲一条（机器多网卡时用得上）。 */}
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <FieldLabel htmlFor="relay-preferred-lan">{t('panel.address.lan')}</FieldLabel>
                    <Button variant="ghost" size="sm" onClick={() => setLanPickerOpen(true)}>
                      {t('panel.onboarding.chooseAddress')}
                    </Button>
                  </div>
                  <Input
                    inputProps={{ id: 'relay-preferred-lan', className: 'font-mono', list: 'relay-lan-candidates' }}
                    value={preferredLan}
                    placeholder={t('panel.address.lanPlaceholder')}
                    onChange={(event) => {
                      editedPreferredRef.current = true
                      setLanHint('')
                      setPreferredLan(event.target.value)
                    }}
                  />
                  {/* 检测到的那几条挂成候选：想挑就在这儿挑，不必再开一次弹窗。 */}
                  <datalist id="relay-lan-candidates">
                    {pickableAddresses.map((item) => (
                      <option key={item.address} value={item.address}>
                        {item.url}
                      </option>
                    ))}
                  </datalist>
                  {lanHint ? <p className="text-xs text-error">{lanHint}</p> : null}
                </Field>

                <Field>
                  <FieldLabel htmlFor="relay-manual-ipv6">{t('panel.address.ipv6Url')}</FieldLabel>
                  <Input
                    inputProps={{ id: 'relay-manual-ipv6', className: 'font-mono' }}
                    value={manualIpv6Url}
                    placeholder={t('panel.address.ipv6Placeholder')}
                    onChange={(event) => {
                      editedIpv6Ref.current = true
                      setManualIpv6Url(event.target.value)
                    }}
                  />
                </Field>
              </div>
            </DialogBody>
          </div>

          <DialogFooter className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy === 'config'} onClick={() => onOpenChange(false)}>
              {t('panel.common.cancel')}
            </Button>
            <Button variant="primary" disabled={!canSave} onClick={submit}>
              {t('panel.relay.saveConfig')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 公用中转清单：点一条就填进输入框并关窗，落盘仍由「保存配置」负责。 */}
      <Dialog open={relayPickerOpen} onOpenChange={setRelayPickerOpen}>
        <DialogContent className="w-[min(560px,92vw)]" initialFocus={relayPickerRef}>
          <DialogHeader>
            <DialogTitle>{t('panel.onboarding.publicRelay')}</DialogTitle>
          </DialogHeader>
          <div ref={relayPickerRef} tabIndex={-1} className="outline-none">
          <DialogBody className="flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto">
            {PUBLIC_RELAYS.map((item) => {
              const picked = relayUrl.trim() === item.url
              return (
                <button
                  key={item.url}
                  type="button"
                  onClick={() => {
                    setRelayUrl(item.url)
                    setRelayPickerOpen(false)
                  }}
                  className={`flex w-full items-baseline justify-between gap-3 rounded px-2 py-1.5 text-left ${
                    picked ? 'bg-background-muted' : 'hover:bg-background-muted'
                  }`}
                >
                  <span className="font-mono text-xs text-foreground">{item.url}</span>
                  <span className="shrink-0 text-xs text-foreground-muted">
                    {picked ? t('panel.relay.selected') : t(item.nameKey)}
                  </span>
                </button>
              )
            })}
          </DialogBody>
          </div>
          <DialogFooter className="flex justify-between gap-2">
            <Button
              variant="ghost"
              disabled={relayUrl.trim() === ''}
              onClick={() => {
                setRelayUrl('')
                setRelayPickerOpen(false)
              }}
            >
              {t('panel.relay.clear')}
            </Button>
            <Button variant="outline" onClick={() => setRelayPickerOpen(false)}>
              {t('panel.common.close')}
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
    </>
  )
}

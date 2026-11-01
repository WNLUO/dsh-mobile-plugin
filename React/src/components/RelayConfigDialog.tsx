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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@appica/ui-react/select'
import { Switch } from '@appica/ui-react/switch'
import { useEffect, useRef, useState } from 'react'

import type { AddressBook, ConfigPatch, PairingPolicy, StatusView } from '../lib/api.ts'
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

// Base UI 的 Select.Value 拿不到 items 就只肯显示原始值（会显示成 code），
// 所以这里必须把「值 → 标签」再写一遍给它。
const PAIRING_POLICY_ITEMS: { value: PairingPolicy; labelKey: string }[] = [
  { value: 'code', labelKey: 'panel.pairing.policyCode' },
  { value: 'deny', labelKey: 'panel.pairing.policyDeny' },
]

/**
 * 「网络配置」弹窗：这台宿主能被手机摸到的四条地址都在这里改。
 *
 *   ① 中转地址（`relayUrl`）—— 走中转隧道的那一条，附公用中转清单；
 *   ② 局域网地址（`preferredLanAddress`）—— 网卡候选里「手机优先用哪条」，选中即存；
 *   ③ 直连地址（`manualLanUrl`）—— 自己把端口暴露到公网域名 / 公网 IP 时填的那一条；
 *   ④ IPv6 地址（`manualIpv6Url`）—— 手填的公网 IPv6 入口。
 *
 * 后三条都是「直连」的一套候选，彼此并存：拨不通的那条手机自己会换下一条，所以界面不强制
 * 只留一个。地址那一块原来分散在两个弹窗里（局域网直连 / 中转配置），用户要求并到一处，
 * 两个入口各改一半迟早对不上。
 *
 * 设备名 / 局域网直连开关 / 配对策略 / 注册密钥原本也在这扇窗里，继续保留在后面。
 * 按用户要求，窗里只留标签和控件，一句说明文字都不留；唯一的例外是注册密钥的 placeholder
 * （「留空表示不改动」属于控件本身）。
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
  const [name, setName] = useState(status.name)
  const [relayUrl, setRelayUrl] = useState(status.relayUrl)
  const [lanEnabled, setLanEnabled] = useState(status.lan.enabled)
  const [pairingPolicy, setPairingPolicy] = useState<PairingPolicy>(status.pairingPolicy)
  const [registerSecret, setRegisterSecret] = useState('')
  /** 直连地址（`manualLanUrl`）：用户手填的穿透域名 / 公网 IP。 */
  const [manualLanUrl, setManualLanUrl] = useState('')
  /** IPv6 直连地址（`manualIpv6Url`）：用户手填的公网 IPv6 入口。 */
  const [manualIpv6Url, setManualIpv6Url] = useState('')
  /** 弹窗打开时的落焦目标：容器自己，不是第一个输入框（见下面 `initialFocus`）。 */
  const dialogRef = useRef<HTMLDivElement | null>(null)
  /** 这一次开窗里用户动过手填那两栏没有：动过就不再拿地址库去盖。 */
  const editedLanRef = useRef(false)
  const editedIpv6Ref = useRef(false)

  // 只在开窗那一刻灌一次当前值：status 每 3 秒换一个对象，
  // 把它当依赖会让正在敲的字被轮询覆盖掉。
  useEffect(() => {
    if (!open) return
    setName(status.name)
    setRelayUrl(status.relayUrl)
    setLanEnabled(status.lan.enabled)
    setPairingPolicy(status.pairingPolicy)
    setRegisterSecret('')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上：只认 open
  }, [open])

  // 地址库是开窗之后才取回来的（App 那边是异步的），所以手填的两条单独跟它走：
  // 没动过就一直按地址库回显（关窗后重开也回到落盘的那份），动过就一律以输入框为准，
  // 免得用户正在敲的字被后来补上的地址库冲掉。
  useEffect(() => {
    if (!open) {
      editedLanRef.current = false
      editedIpv6Ref.current = false
      return
    }
    if (!editedLanRef.current) setManualLanUrl(addressBook?.manual ?? '')
    if (!editedIpv6Ref.current) setManualIpv6Url(addressBook?.manualIpv6 ?? '')
  }, [open, addressBook])

  const secretDirty = registerSecret.trim() !== ''
  const canSave = name.trim() !== '' && busy === ''

  /** 直连那两条按宿主口径去掉尾部斜杠：它拼出来的是一条候选 URL，多一个 `/` 就多一条重复项。 */
  const trimUrl = (value: string) => value.trim().replace(/\/+$/, '')

  function submit() {
    if (!canSave) return
    const patch: ConfigPatch = {}
    if (name.trim() !== status.name) patch.name = name.trim()
    if (relayUrl.trim() !== status.relayUrl) patch.relayUrl = relayUrl.trim()
    if (lanEnabled !== status.lan.enabled) patch.lanEnabled = lanEnabled
    if (pairingPolicy !== status.pairingPolicy) patch.pairingPolicy = pairingPolicy
    // 手填地址：空串是合法值（= 清掉这一条），所以这里跟 `name` 不一样，只在**真的变了**时带上，
    // 而不是「非空才带」。
    const direct = trimUrl(manualLanUrl)
    if (direct !== trimUrl(addressBook?.manual ?? '')) patch.manualLanUrl = direct
    const ipv6 = trimUrl(manualIpv6Url)
    if (ipv6 !== trimUrl(addressBook?.manualIpv6 ?? '')) patch.manualIpv6Url = ipv6
    // 密钥是敏感值：留空表示「不动它」，绝不把空串写回去（那等于关掉注册密钥）。
    if (secretDirty) patch.registerSecret = registerSecret.trim()
    onSave(patch)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `initialFocus` 指向弹窗容器本身：Base UI 默认会把焦点放到第一个可聚焦元素上，
          这里就是「设备名」那个输入框——一打开就选中了、光标在闪，用户想先点别的地方
          还得先把它点掉。焦点仍旧进到弹窗里（读屏与 Esc 都靠它），只是不落在输入框。 */}
      <DialogContent className="max-w-xl" initialFocus={dialogRef}>
        <DialogHeader>
          <DialogTitle>{t('panel.pairing.openConfig')}</DialogTitle>
        </DialogHeader>

        {/* `tabIndex={-1}` 让容器可以被程序聚焦（且不进 Tab 顺序）。
            套一层 div 是因为 `DialogBody` 不接受 ref。
            四栏地址加原有四项后比原来高，`max-h` + 内滚动保证窄屏 / 矮窗口也能按到保存。 */}
        <div ref={dialogRef} tabIndex={-1} className="outline-none">
        <DialogBody className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
          <Field>
            <FieldLabel htmlFor="relay-name">{t('panel.connection.deviceName')}</FieldLabel>
            <Input
              inputProps={{ id: 'relay-name' }}
              value={name}
              placeholder={t('panel.relay.namePlaceholder')}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          {/* ① 中转地址 */}
          <Field>
            <FieldLabel htmlFor="relay-url">{t('panel.connection.relayUrl')}</FieldLabel>
            <Input
              inputProps={{ id: 'relay-url', className: 'font-mono' }}
              value={relayUrl}
              placeholder="https://example.com"
              onChange={(event) => setRelayUrl(event.target.value)}
            />
            {/* 公用中转的入口清单。引导页里那条是自动填好的，用户从没记过地址，
                进了主界面想换回来只能凭记忆敲——所以这里把清单摆出来点选。
                清单与引导页共用 `PUBLIC_RELAYS`，加一台两边自动跟上；
                数量会涨，所以定高滚动，别把弹窗顶长。
                点一下只填地址，不改其它字段——「保存配置」才真正落盘。 */}
            <div className="mt-1.5 rounded-md bg-background-muted px-3 py-2">
              <p className="text-xs text-foreground-muted">{t('panel.links.publicRelay')}</p>
              <div className="mt-1 max-h-[112px] overflow-y-auto">
                <div className="flex flex-col gap-0.5">
                  {PUBLIC_RELAYS.map((item) => {
                    const picked = relayUrl.trim() === item.url
                    return (
                      <button
                        key={item.url}
                        type="button"
                        onClick={() => setRelayUrl(item.url)}
                        className={`flex w-full items-baseline justify-between gap-3 rounded px-1.5 py-1 text-left ${
                          picked ? 'bg-background' : 'hover:bg-background'
                        }`}
                      >
                        <span className="font-mono text-xs text-foreground">{item.url}</span>
                        <span className="shrink-0 text-xs text-foreground-muted">
                          {picked ? t('panel.relay.selected') : t(item.nameKey)}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setRelayUrl('')}
                disabled={relayUrl.trim() === ''}
                className="mt-1.5 text-xs text-foreground-muted underline-offset-2 hover:underline disabled:opacity-40"
              >
                {t('panel.relay.clear')}
              </button>
            </div>
          </Field>

          {/* ② 局域网地址：「手机优先用这条」，选中即存（`preferredLanAddress`）。
              直连关着时不摆：那时的地址是残留，选它没有意义。 */}
          <Field>
            <FieldLabel>{t('panel.address.lan')}</FieldLabel>
            {status.lan.enabled ? (
              <AddressPicker
                book={addressBook}
                port={status.lan.port}
                value={addressBook?.preferred ?? ''}
                busy={busy !== ''}
                onChange={onSavePreferred}
                fallbackUrls={lanUrls}
              />
            ) : (
              <span className="font-sans text-sm text-foreground-muted">{t('panel.onboarding.lanOff')}</span>
            )}
          </Field>

          {/* ③ 直连地址：内网穿透域名 / 公网 IP（`manualLanUrl`）。与上面那份网卡候选并存。 */}
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

          {/* ④ IPv6 直连地址：手填的公网 IPv6 入口（`manualIpv6Url`）。 */}
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

          <div className="flex items-center justify-between gap-4 rounded-md bg-background-muted px-3 py-2">
            <div className="text-sm text-foreground">{t('panel.connection.lan')}</div>
            <Switch
              size="md"
              checked={lanEnabled}
              onCheckedChange={setLanEnabled}
              aria-label={t('panel.connection.lan')}
            />
          </div>

          <Field>
            <FieldLabel>{t('panel.pairing.policy')}</FieldLabel>
            <Select
              items={PAIRING_POLICY_ITEMS.map((item) => ({ value: item.value, label: t(item.labelKey) }))}
              value={pairingPolicy}
              onValueChange={(value) => setPairingPolicy(value as PairingPolicy)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="code">{t('panel.pairing.policyCode')}</SelectItem>
                <SelectItem value="deny">{t('panel.pairing.policyDeny')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="relay-register-secret">{t('panel.connection.registerSecret')}</FieldLabel>
            <Input
              type="password"
              inputProps={{ id: 'relay-register-secret' }}
              value={registerSecret}
              placeholder={t('panel.lanDialog.unchanged')}
              onChange={(event) => setRegisterSecret(event.target.value)}
              clearable
              onClear={() => setRegisterSecret('')}
            />
          </Field>
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
  )
}

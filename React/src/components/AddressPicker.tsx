/**
 * 「手机该填哪个地址」的选择器。
 *
 * 一台机器常常不止一条地址（好几个网段、好几块网卡），而手机拿到候选之后是**按顺序挨个试**的，
 * 所以「用哪一条」这件事在宿主那边只能表达成「把选中的排到最前」。这个组件就是那个选择的界面：
 * 配对卡、局域网直连弹窗共用同一份口径（引导页那份自己带一个输入框里的端口，见 Onboarding）。
 *
 * 三条口径别搞反：
 *  - **能选的** = 二维码 / 连接信息里真的会带的那一份（有私网就只带私网，一个私网都没有才退公网）；
 *  - **只能看的** = 公网那份，机器上有私网时它进不了二维码。摆出来只为「手机不在同一个网络时，
 *    知道该往 App 里手填什么」——做成可选的只会让人以为选了有用；
 *  - **只能看的（第三份）** = IPv6 全球单播。它由**手机侧拿它和公网中转实测比速度**来择优，
 *    宿主不替它排，所以同样不进那个选择（2026-10 加，见插件侧 `ipv6Candidates`）。
 *
 * 标签按**检测出来的那一份**给（局域网 / 公网 / IPv6 直连）：服务器上只有公网地址，一律写
 * 「局域网地址」正是用户 2026-10-11 截图报的那个错。网卡名也带上，好几条同类的地址光看 IP
 * 分不出哪条对着手机。
 */
import { Radio } from '@appica/ui-react/radio'
import { t } from '../lib/i18n/index.ts'
import { RadioGroup } from '@appica/ui-react/radio-group'

import type { AddressBook, AddressEntry } from '../lib/api.ts'
import { cn } from '../lib/format.ts'

/** 能选的那一份：有私网就只带私网，一个私网都没有才退公网（与宿主 `advertisedCandidates` 同口径）。 */
export function pickableAddresses(book: AddressBook | null): AddressEntry[] {
  if (!book) return []
  return book.lan.length > 0 ? book.lan : book.public
}

/** 只能看的那一份：机器上有私网时，公网那几条进不了二维码。 */
export function otherAddresses(book: AddressBook | null): AddressEntry[] {
  if (!book || book.lan.length === 0) return []
  return book.public
}

/** 第三份（只能看）：IPv6 全球单播，手机侧实测择优。老宿主没有这个字段。 */
export function ipv6Addresses(book: AddressBook | null): AddressEntry[] {
  return book?.ipv6 ?? []
}

/** 「局域网地址 · en0」。网卡名拿不到就只说类型。 */
export function addressKindLabel(kind: 'lan' | 'public' | 'ipv6', nic?: string): string {
  const base = kind === 'lan' ? t('panel.address.lan') : kind === 'ipv6' ? t('panel.address.ipv6') : t('panel.address.public')
  return nic ? `${base} · ${nic}` : base
}

/**
 * 地址 → 手机该拨的 URL。**IPv6 字面量必须套方括号**：裸着拼出来是
 * `http://240e::1:18787`，一个解析不出来的坏地址。判据是「带冒号」而不是「像不像 IPv6」，
 * 因为进到这里的东西要么是 IPv4 点分、要么是宿主给的那条裸 IPv6。
 */
function urlOf(address: string, port: number | string): string {
  const host = address.includes(':') ? `[${address}]` : address
  return `http://${host}:${String(port ?? '')}`
}

type Props = {
  book: AddressBook | null
  /** 拼 URL 用的端口：界面上正在显示的那个（不是地址库里那份，两者一般同值）。 */
  port: number | string
  /** 宿主记着的选择（`book.preferred`）。它不在清单里时（换网段了）自动退回第一条。 */
  value: string
  busy?: boolean
  onChange: (address: string) => void
  /** 拿不到地址库（老宿主没有那条路由）时退回这一串：只显示、不能选。 */
  fallbackUrls?: string[]
}

export function AddressPicker({ book, port, value, busy = false, onChange, fallbackUrls = [] }: Props) {
  const text = String(port ?? '')
  const pickable = pickableAddresses(book)
  const others = otherAddresses(book)
  const ipv6 = ipv6Addresses(book)
  const kind: 'lan' | 'public' = book && book.lan.length > 0 ? 'lan' : 'public'
  // 存过的那条已经不在清单里（换网段、拔了网卡）就退回第一条：宿主那边同样会退回，
  // 两边显示的才是同一个顺序。
  const chosen = pickable.some((item) => item.address === value) ? value : (pickable[0]?.address ?? '')

  if (pickable.length === 0) {
    // 只有 IPv6 的机器：一条可选的都没有，但那个地址正是这台机器在公网上的唯一入口，
    // 不能退成一句「还没取到地址」。
    if (ipv6.length === 0 && fallbackUrls.length > 0) {
      return (
        <span className="flex flex-col items-end gap-0.5">
          {fallbackUrls.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </span>
      )
    }
    if (ipv6.length === 0) return <span className="font-sans text-foreground-muted">{t('panel.address.empty')}</span>
    return (
      <span className="flex w-full flex-col items-end gap-1">
        {ipv6.map((item) => (
          <span key={item.address} className="inline-flex flex-wrap items-baseline justify-end gap-x-2">
            <span className="font-mono text-xs text-foreground-muted">{urlOf(item.address, text)}</span>
            <span className="shrink-0 font-sans text-xs text-foreground-subtle">
              {`${addressKindLabel('ipv6', item.interface)}${t('panel.address.ipv6Hint')}`}
            </span>
          </span>
        ))}
      </span>
    )
  }

  return (
    <span className="flex w-full flex-col items-end gap-1">
      {pickable.length > 1 ? (
        <RadioGroup
          className={cn('w-full items-end gap-1', busy && 'pointer-events-none opacity-60')}
          value={chosen}
          onValueChange={(next) => {
            if (typeof next === 'string' && next !== chosen) onChange(next)
          }}
        >
          {pickable.map((item) => (
            <label
              key={item.address}
              className="flex w-full cursor-pointer flex-wrap items-baseline justify-end gap-x-2"
            >
              <Radio value={item.address} aria-label={urlOf(item.address, text)} />
              <span className="font-mono text-xs text-foreground">{urlOf(item.address, text)}</span>
              <span className="shrink-0 font-sans text-xs text-foreground-muted">
                {addressKindLabel(kind, item.interface)}
              </span>
            </label>
          ))}
        </RadioGroup>
      ) : (
        <span className="inline-flex flex-wrap items-baseline justify-end gap-x-2">
          <span className="font-mono">{urlOf(pickable[0].address, text)}</span>
          <span className="shrink-0 font-sans text-xs text-foreground-muted">
            {addressKindLabel(kind, pickable[0].interface)}
          </span>
        </span>
      )}

      {/* 另一份只摆出来：它进不了二维码，手机不在同一个网络时得手填进 App。 */}
      {others.map((item) => (
        <span key={item.address} className="inline-flex flex-wrap items-baseline justify-end gap-x-2">
          <span className="font-mono text-xs text-foreground-muted">{urlOf(item.address, text)}</span>
          <span className="shrink-0 font-sans text-xs text-foreground-subtle">
            {`${addressKindLabel('public', item.interface)}${t('panel.address.publicHint')}`}
          </span>
        </span>
      ))}

      {/* 第三份同样只摆出来：这一条谁快由手机实测决定，宿主替它排只会撒谎。 */}
      {ipv6.map((item) => (
        <span key={item.address} className="inline-flex flex-wrap items-baseline justify-end gap-x-2">
          <span className="font-mono text-xs text-foreground-muted">{urlOf(item.address, text)}</span>
          <span className="shrink-0 font-sans text-xs text-foreground-subtle">
            {`${addressKindLabel('ipv6', item.interface)}（手机按实测择优）`}
          </span>
        </span>
      ))}

      {pickable.length > 1 ? (
        <span className="text-end font-sans text-xs text-foreground-muted">
          {t('panel.address.hint')}
        </span>
      ) : null}
    </span>
  )
}

/**
 * 「配对与二维码」卡片：宿主的二维码 SVG、准入开关，以及手机该拨的地址与端口。
 *
 * 地址那串是宿主给的候选顺序（用户选过的排最前），手机也是按这个顺序挨个试的。
 *
 * 卡片上**不摆配对码**：普通用户拿 APP 扫一下码就配上了，码值在这儿只是多一处会被旁边的人
 * 看走眼的东西。「重新生成」那颗也一并去了 —— 宿主在配对成功那一刻就会换码换票据
 * （`rotatePairing`），二维码自己会变，不需要人来按。
 */
import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@appica/ui-react/alert'
import { t } from '../lib/i18n/index.ts'
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
import { Spinner } from '@appica/ui-react/spinner'
import { Switch } from '@appica/ui-react/switch'
import * as React from 'react'

import type { AddressBook, PairingInfo, PairingPolicy, StatusView } from '../lib/api.ts'
import { RELAY_REPO_URL } from '../lib/links.ts'
import { AddressPicker } from './AddressPicker.tsx'
import { DownloadAppButton } from './DownloadAppButton.tsx'
import { InfoList, InfoRow } from './InfoRow.tsx'
import { RevealButton } from './RevealButton.tsx'

type Props = {
  status: StatusView
  pairing: PairingInfo | null
  /** 宿主枚举的地址库：地址那行靠它分「局域网 / 公网」并在原地选优先地址。 */
  addressBook: AddressBook | null
  busy: string
  error: string
  /** 上一次重启 sidecar 的失败原因；成功时是 null。 */
  restartError: string | null
  onOpenConfig: () => void
  /** 准入总闸（`status.pairingPolicy`）：`'code'` 收新设备、`'deny'` 一律拒。 */
  onChangePolicy: (policy: PairingPolicy) => void
  /** 「检查网络」：开的是「连接自检」那个弹窗（与卡片里那行「自检」是同一件事）。 */
  onOpenSelfCheck: () => void
  onReconnect: () => void
  onSavePreferred: (address: string) => void
}

/**
 * 配对与二维码。
 *
 * 二维码 SVG 由宿主生成（`QRCode.toString`，280px、纠错 M），这里只负责摆放：网页端自己画
 * 要多带一个依赖，而且会和手机端拿到的图不一致。未启用远程控制时宿主回 409 并给一句中文，
 * 这里照原样显示。
 *
 * 二维码与中转地址默认遮着，揭开之后不再给「隐藏」（状态不落盘，刷新即回到遮着）；地址那行的
 * 「显示」点开是弹窗，内容多，摊在卡片里会把下面的东西顶下去。
 *
 * 维护动作（重新连接 / 吊销全部设备授权 / 网络配置）都挂这张卡：它们属于「连不上时怎么办」。
 * 吊销不可逆，走一次 window.confirm，这类确认不该藏在拖拽或长按里。
 * 「重启 sidecar」在「插件更新」卡（它跟更新是同一件事），这里只留「上次重启失败」的红字。
 * 「刷新」不设：配对信息在进页面、改配置、换码（配对成功）时刷新。
 */
export function PairingCard({
  status,
  pairing,
  addressBook,
  busy,
  error,
  restartError,
  onOpenConfig,
  onChangePolicy,
  onOpenSelfCheck,
  onReconnect,
  onSavePreferred,
}: Props) {
  const idle = busy !== ''
  const pairingAllowed = status.pairingPolicy === 'code'
  /** 「中转地址」那行的明文：默认遮上。 */
  const relayUrl = pairing?.relayUrl || status.relayUrl || '—'
  /**
   * 「手机该填的地址」那行的明文：默认遮上。它是这台机器**此刻真的在用的网卡地址**
   * （设备名与内网网段都写在里面），比中转地址更值得别摆着。
   */
  const phoneAddress = phoneHintAddress(addressBook, pairing)
  // 两个「明文摆着、可当场遮上」的值：二维码与中转地址。都只当页面里的一次开关，不落盘 ——
  // 默认值才是那个谨慎的选项，记住了反而把「默认隐藏」抵消掉。
  // 地址那一行不在这里：它点开的是弹窗（`addressOpen`），关掉弹窗就等于又遮上了。
  const [shown, setShown] = React.useState({ qr: false, relay: false })
  const [addressOpen, setAddressOpen] = React.useState(false)
  // 放大二维码：屏幕缩放、手机离得远时，卡片里那颗太小。它只是同一张码的另一个尺寸，
  // 揭开状态另算 —— 关掉弹窗回到卡片里的样子，不改变「默认遮着」那条。
  const [qrZoom, setQrZoom] = React.useState(false)
  const toggle = (key: keyof typeof shown) => setShown((current) => ({ ...current, [key]: !current[key] }))

  return (
    <Card frame="solid">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <span>{t('panel.pairing.cardTitle')}</span>
          {/* 连不上时先看自检结论：它就是「连接自检」那个弹窗（与「自检」是同一件事，
              只是入口换了地方）。做成文字按钮，别再多一颗胶囊抢标题那一行。 */}
          <button
            type="button"
            className="cursor-pointer text-sm text-foreground-intense underline underline-offset-2 hover:text-foreground-strong"
            onClick={onOpenSelfCheck}
          >
            {t('panel.pairing.checkNetwork')}
          </button>
        </CardTitle>
      </CardHeader>

      {error ? (
        <Alert variant="warning" className="mt-3">
          <AlertIcon />
          <AlertTitle>{t('panel.pairing.qrFailed')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-3 flex flex-col gap-4 sm:flex-row">
        {/* 二维码这一格**尺寸固定**：遮着是 280 的占位、揭开是同一块白底，两种状态上下都不动。
            白底用 `size-full` + `p-2` 撑满这一格，里面再 `size-full` 缩放 —— 别给内层写死
            256px，那样白底会比占位高出边框加内边距那一圈，整张卡跟着长两像素。 */}
        <div className="flex shrink-0 flex-col items-center">
          <div className="relative size-[280px]">
            {/*
              白底是必须的：二维码是黑白的，暗色主题下要保证扫得出来。
              遮上时**整块换成一个占位**，不是把里面的 SVG 用样式盖住：隐藏态的页面里
              根本不存在那张图，截屏工具、开发者工具、页面另存为都拿不到它。
            */}
            {!shown.qr && pairing?.svg ? (
              <div className="flex size-[280px] flex-col items-center justify-center gap-1 rounded-md border border-border-muted bg-background-muted text-foreground-subtle">
                <span className="text-xs">{t('panel.pairing.qrHidden')}</span>
                <RevealButton what={t('panel.pairing.qr')} label={t('panel.common.show')} onClick={() => toggle('qr')} />
              </div>
            ) : (<div className="flex size-[280px] items-center justify-center overflow-hidden rounded-md border border-border-muted bg-white p-2">
                {pairing?.svg ? (
                  // 点码本身就能放大：手指落在图上的人不会先去找一颗按钮。
                  <button
                    type="button"
                    className="size-full cursor-zoom-in rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    onClick={() => setQrZoom(true)}
                    aria-label={`${t('panel.pairing.qrZoom')}：${t('panel.pairing.qr')}`}
                  >
                    {/* 宿主生成的 SVG（带 280px 固定宽高），内嵌后必须被这里压到方框大小；
                        不是用户输入，没有注入面。 */}
                    <div
                      className="size-full [&_svg]:h-full [&_svg]:w-full"
                      dangerouslySetInnerHTML={{ __html: pairing.svg }}
                    />
                  </button>
                ) : (
                  <div className="flex size-full items-center justify-center text-foreground-subtle">
                    {busy === 'pairing' ? <Spinner /> : t('panel.pairing.noQr')}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <InfoList>
            {/*
              配对策略就是一个开关：开 = 允许新设备凭配对码绑定，关 = 一律拒绝。
              它以前在「连接状态」和「网络配置」里各有一颗，同一件事一屏两颗开关只会让人猜
              「改哪颗才算」—— 现在只留这一处。
            */}
            <InfoRow label={t('panel.pairing.policy')}>
              <Switch
                size="md"
                checked={pairingAllowed}
                disabled={idle}
                onCheckedChange={(next) => onChangePolicy(next ? 'code' : 'deny')}
                aria-label={t('panel.devices.allowTitle')}
              />
            </InfoRow>
            <InfoRow label={t('panel.connection.relayUrl')}>
              <span className="inline-flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
                {shown.relay ? (
                  <span className="min-w-0 font-mono text-xs text-foreground-strong">{relayUrl}</span>
                ) : (
                  <span className="text-xs text-foreground-subtle">{t('panel.pairing.hidden')}</span>
                )}
                <RevealButton
                  on={shown.relay}
                  what={t('panel.connection.relayUrl')}
                  label={shown.relay ? t('panel.common.hide') : t('panel.common.show')}
                  onClick={() => toggle('relay')}
                />
              </span>
            </InfoRow>
            <InfoRow label={t('panel.pairing.port')} mono>
              {pairing?.lanPort ?? status.lan.port}
              {pairing?.lanPortAdjusted ? (
                <span className="ml-2 font-sans text-xs text-foreground-muted">{t('panel.pairing.portFallback')}</span>
              ) : null}
            </InfoRow>
            {/*
              地址按**检测出来的那一份**分类型给标签（局域网 / 公网），并在原地就能选「手机优先用
              哪条」：手机是按候选顺序挨个试的，所以这个选择在宿主那边就表现为「把选中的排最前」。
              别退回一律写「局域网地址」的写法 —— 服务器上只有公网地址时那就是错的。
            */}
            {/*
              本地识别地址：只留一颗「显示」，点开是弹窗。就地摊开时地址一多（局域网几条 + 公网 +
              IPv6）会把整张卡拉高、把下面的卡顶下去，所以内容挪进弹窗，这一行永远只有一行高。
              **不给「隐藏」**：关掉弹窗就是遮上了；刷新页面也回到遮着。
            */}
            <InfoRow label={t('panel.pairing.phoneAddress')}>
              <span className="inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
                {phoneAddress ? null : (
                  <span className="text-xs text-foreground-subtle">{t('panel.pairing.noAddress')}</span>
                )}
                <RevealButton
                  on={false}
                  what={t('panel.pairing.phoneAddress')}
                  label={t('panel.common.show')}
                  onClick={() => setAddressOpen(true)}
                />
              </span>
            </InfoRow>
          </InfoList>

        </div>
      </div>

      {restartError ? (
        <Alert variant="error" className="mt-3">
          <AlertIcon />
          <AlertTitle>{t('panel.pairing.sidecarRestartFailed')}</AlertTitle>
          <AlertDescription>{restartError}</AlertDescription>
        </Alert>
      ) : null}

      {/* 「下载 APP」跟维护那两颗一起靠右收齐：一排放三颗，都是「接下来要做的动作」。
          「重启 sidecar」按用户要求搬到「插件更新」卡片里 —— 它和更新讲的是同一件事：
          让磁盘上的新代码立刻生效（sidecar 层不用重启宿主，宿主层才需要）。 */}
      {/* 这一排都是「接下来要做的动作」，网络配置也算一颗，跟它们排在一起更顺。 */}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" size="md" disabled={idle} onClick={onOpenConfig}>
          {t('panel.pairing.openConfig')}
        </Button>
        {/* 想自己搭一台中转的人要走的那条路：与引导页「GitHub 仓库」同一个地址。 */}
        <a
          className={buttonVariants({ variant: 'outline', size: 'md' })}
          href={RELAY_REPO_URL}
          target="_blank"
          rel="noreferrer noopener"
        >
          {t('panel.pairing.selfHosted')}
        </a>
        {/* 下载入口点开是渠道弹窗（安卓两条 / 苹果两条），尺寸走默认的 md，
            与旁边两颗 h-10 对齐。 */}
        <DownloadAppButton />
        <Button variant="secondary" size="md" disabled={idle} onClick={onReconnect}>
          {t('panel.pairing.reconnect')}
        </Button>
      </div>

      {/*
        放大二维码：与卡片里那颗是同一份 SVG，只是给到能凑近扫的尺寸。
        屏幕缩放、显示器离得远、手机举着不方便时，这块比把卡片撑大管用。
      */}
      <Dialog open={qrZoom} onOpenChange={setQrZoom}>
        <DialogContent className="w-[min(560px,92vw)] max-w-none" closeLabel={t('panel.common.close')}>
          <DialogHeader>
            <DialogTitle>{t('panel.pairing.qr')}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="flex items-center justify-center rounded-md bg-white p-4">
              {pairing?.svg ? (
                <div
                  className="size-[min(70vh,440px)] [&_svg]:h-full [&_svg]:w-full"
                  dangerouslySetInnerHTML={{ __html: pairing.svg }}
                />
              ) : null}
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>

      {/*
        「本地识别地址」弹窗：地址清单与「手机优先用这条」都摆在这里。
        内容可能五六行（局域网几条 + 公网 + IPv6），摊在卡片里会把下面的东西全顶下去，
        所以点「显示」开这一层。关掉就是遮上，不再有「隐藏」那颗按钮。
      */}
      <Dialog open={addressOpen} onOpenChange={setAddressOpen}>
        <DialogContent className="max-w-xl" closeLabel={t('panel.common.close')}>
          <DialogHeader>
            <DialogTitle>{t('panel.pairing.phoneAddress')}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <AddressPicker
              book={addressBook}
              port={pairing?.lanPort ?? status.lan.port}
              value={addressBook?.preferred ?? ''}
              busy={idle}
              onChange={onSavePreferred}
              fallbackUrls={pairing?.lanUrls ?? []}
            />
          </DialogBody>
          <DialogFooter className="flex justify-end">
            <Button variant="outline" onClick={() => setAddressOpen(false)}>
              {t('panel.common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/** 这一行现在有没有值可揭：一眼能看出来的「还没取到地址」就别给一颗点了没反应的按钮。 */
function phoneHintAddress(book: AddressBook | null, pairing: PairingInfo | null): string {
  if (book && book.lan.length + book.public.length > 0) return 'book'
  return pairing?.lanUrls?.[0] ?? ''
}

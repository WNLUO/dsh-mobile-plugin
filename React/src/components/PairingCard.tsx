/**
 * 「配对与二维码」卡片：宿主的二维码 SVG、配对码，以及手机该拨的地址与端口。
 *
 * 地址那串是宿主给的候选顺序（用户选过的排最前），手机也是按这个顺序挨个试的。
 */
import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@appica/ui-react/alert'
import { Button } from '@appica/ui-react/button'
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card'
import { CopyButton } from '@appica/ui-react/copy-button'
import { Spinner } from '@appica/ui-react/spinner'
import * as React from 'react'

import type { AddressBook, PairingInfo, StatusView } from '../lib/api.ts'
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
  onRegenerate: () => void
  onReconnect: () => void
  onRevokeAll: () => void
  onSavePreferred: (address: string) => void
}

/**
 * 配对与二维码。
 *
 * 二维码的 SVG 由宿主生成（`QRCode.toString`，280px、纠错 M），这里只负责摆放：
 * 网页端自己画二维码要多带一个依赖，而且会和手机端拿到的图不一致。
 * 未启用远程控制时宿主回 409 并给一句中文，这里照原样显示。
 *
 * 「下载 APP」按用户要求加在卡片最下面那一排的最左端：刚配对的人下一步就是装 App，而下载入口
 * 原先只在引导页第一页（第二次打开引导想再下一份就找不着了）。
 *
 * 二维码按用户要求**默认隐藏**，右上角一颗眼睛按钮现场揭开 / 再遮上：配对码还明文摆在旁边，
 * 防的不是这台电脑上的人，而是屏幕在共享 / 投屏 / 身后有人时替对方省下那一眼。只当页面里的
 * 一次开关，不落盘 —— 默认值才是那个谨慎的选项，记住了反而把「默认隐藏」抵消掉。
 *
 * 维护那两个动作（重新连接 / 吊销全部设备授权）按用户要求并到这张卡的
 * 右下角：它们都属于「连不上时怎么办」，跟配对是同一件事。其中「吊销全部设备授权」
 * 不可逆，走一次 window.confirm —— 这类确认不该藏在拖拽或长按里。
 * 「重启 sidecar」原先也在这排，后来按用户要求搬到「插件更新」卡片（它跟更新是同一件事：
 * 让磁盘上的新代码立刻生效）；这里只留「上次重启失败」的红字提示，跟状态绑在一起。
 * 「重新生成配对码」按用户要求贴到二维码下面、以二维码为参照居中（它换的就是那张图）；
 * 「中转配置」放在地址那行值下方靠右。
 * 「刷新」按用户要求删掉了：配对信息本身是进页面、改配置、重新生成时刷新，
 * 单留一颗按钮只让人以为这页会自己过期；地址没取到时靠打开「局域网直连」重取一次。
 */
export function PairingCard({
  status,
  pairing,
  addressBook,
  busy,
  error,
  restartError,
  onOpenConfig,
  onRegenerate,
  onReconnect,
  onRevokeAll,
  onSavePreferred,
}: Props) {
  const idle = busy !== ''
  const policyText = status.pairingPolicy === 'deny' ? '一律拒绝新设备' : '凭配对码允许'
  /** 「中转地址」那行的明文：默认遮上。 */
  const relayUrl = pairing?.relayUrl || status.relayUrl || '—'
  /**
   * 「手机该填的地址」那行的明文：默认遮上。它是这台机器**此刻真的在用的网卡地址**
   * （设备名与内网网段都写在里面），比中转地址更值得别摆着。
   */
  const phoneAddress = phoneHintAddress(addressBook, pairing)
  // 三个「明文摆着、可当场遮上」的值：二维码、中转地址、手机该填的地址。
  // 都只当页面里的一次开关，不落盘 —— 默认值才是那个谨慎的选项，记住了反而把「默认隐藏」抵消掉。
  const [shown, setShown] = React.useState({ qr: false, relay: false, phone: false })
  const toggle = (key: keyof typeof shown) => setShown((current) => ({ ...current, [key]: !current[key] }))

  return (
    <Card frame="solid">
      <CardHeader>
        <CardTitle>配对与二维码</CardTitle>
      </CardHeader>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-background-muted px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-sm text-foreground-muted">配对码</span>
          <span className="font-mono text-xl tracking-[0.2em] text-foreground-intense">
            {pairing?.pairingCode || status.pairingCode || '—'}
          </span>
        </div>
        <CopyButton
          value={pairing?.pairingCode || status.pairingCode || ''}
          variant="secondary"
          size="sm"
          label="复制配对码"
          copiedLabel="已复制"
        />
      </div>

      {error ? (
        <Alert variant="warning" className="mt-3">
          <AlertIcon />
          <AlertTitle>拿不到二维码</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-3 flex flex-col gap-4 sm:flex-row">
        {/* 二维码这一列下面挂「重新生成配对码」：它换的就是这张图，按用户要求贴着二维码、
            以二维码为参照居中，而不是跟别的按钮挤在卡片右下。 */}
        <div className="flex shrink-0 flex-col items-center gap-3">
          <div className="relative">
            {/*
              白底是必须的：二维码是黑白的，暗色主题下要保证扫得出来。
              遮上时**整块换成一个占位**，不是把里面的 SVG 用样式盖住：隐藏态的页面里
              根本不存在那张图，截屏工具、开发者工具、页面另存为都拿不到它。
            */}
            {!shown.qr && pairing?.svg ? (
              <div className="flex size-[224px] flex-col items-center justify-center gap-1 rounded-md border border-border-muted bg-background-muted text-foreground-subtle">
                <span className="text-xs">二维码已隐藏</span>
                <RevealButton what="二维码" label="显示" onClick={() => toggle('qr')} />
              </div>
            ) : (
              <div className="flex items-start justify-center overflow-hidden rounded-md border border-border-muted bg-white p-3">
                {pairing?.svg ? (
                  // 宿主生成的 SVG（带 280px 固定宽高），内嵌后必须被这里压到方框大小；
                  // 不是用户输入，没有注入面。
                  <div
                    className="size-[200px] [&_svg]:h-full [&_svg]:w-full"
                    dangerouslySetInnerHTML={{ __html: pairing.svg }}
                  />
                ) : (
                  <div className="flex size-[200px] items-center justify-center text-foreground-subtle">
                    {busy === 'pairing' ? <Spinner /> : '还没取到二维码'}
                  </div>
                )}
              </div>
            )}

            {!shown.qr && pairing?.svg ? null : (
              <RevealButton
                on
                what="二维码"
                label="隐藏二维码"
                className="absolute end-2 top-2"
                disabled={!pairing?.svg}
                onClick={() => toggle('qr')}
              />
            )}
          </div>

          <Button variant="outline" size="md" disabled={idle} onClick={onRegenerate}>
            重新生成配对码
          </Button>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <InfoList>
            <InfoRow label="配对策略">{policyText}</InfoRow>
            <InfoRow label="中转地址">
              <span className="inline-flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
                {shown.relay ? (
                  <span className="min-w-0 font-mono text-xs text-foreground-strong">{relayUrl}</span>
                ) : (
                  <span className="text-xs text-foreground-subtle">已隐藏</span>
                )}
                <RevealButton
                  on={shown.relay}
                  what="中转地址"
                  label={shown.relay ? '隐藏' : '显示'}
                  onClick={() => toggle('relay')}
                />
              </span>
            </InfoRow>
            <InfoRow label="局域网端口" mono>
              {pairing?.lanPort ?? status.lan.port}
              {pairing?.lanPortAdjusted ? (
                <span className="ml-2 font-sans text-xs text-foreground-muted">（首选端口被占用，已自动改用）</span>
              ) : null}
            </InfoRow>
            {/*
              地址按**检测出来的那一份**分类型给标签（局域网 / 公网），并在原地就能选「手机优先用
              哪条」：手机是按候选顺序挨个试的，所以这个选择在宿主那边就表现为「把选中的排最前」。
              从前这里一律写「局域网地址」——服务器上只有公网地址，那句话正是用户 2026-10-11 报的错。
            */}
            <InfoRow label="手机该填的地址">
              {shown.phone ? (
                // 整块揭开的是一行**和别的行同一形状**的值，不是只有几颗字符：
                // 「手机该填的地址」这句话本身就该读到，遮的是后面那个 IP。
                <span className="inline-flex min-w-0 flex-col items-end gap-1">
                  <AddressPicker
                    book={addressBook}
                    port={pairing?.lanPort ?? status.lan.port}
                    value={addressBook?.preferred ?? ''}
                    busy={idle}
                    onChange={onSavePreferred}
                    fallbackUrls={pairing?.lanUrls ?? []}
                  />
                  <RevealButton on what="手机该填的地址" label="隐藏" onClick={() => toggle('phone')} />
                </span>
              ) : (
                <span className="inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
                  <span className="text-xs text-foreground-subtle">{phoneAddress ? '已隐藏' : '还没取到地址'}</span>
                  <RevealButton on={false} what="手机该填的地址" label="显示" onClick={() => toggle('phone')} />
                </span>
              )}
            </InfoRow>
          </InfoList>

          {/* 用户要求：中转配置紧贴在「局域网地址」那行值下面，跟二维码下面那颗同样的样式。 */}
          <div className="mt-3 flex justify-end">
            <Button variant="outline" size="md" disabled={idle} onClick={onOpenConfig}>
              中转配置
            </Button>
          </div>
        </div>
      </div>

      {restartError ? (
        <Alert variant="error" className="mt-3">
          <AlertIcon />
          <AlertTitle>上次重启 sidecar 失败</AlertTitle>
          <AlertDescription>{restartError}</AlertDescription>
        </Alert>
      ) : null}

      {/* 「下载 APP」跟维护那两颗一起靠右收齐：一排放三颗，都是「接下来要做的动作」。
          「重启 sidecar」按用户要求搬到「插件更新」卡片里 —— 它和更新讲的是同一件事：
          让磁盘上的新代码立刻生效（sidecar 层不用重启宿主，宿主层才需要）。 */}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {/* 下载入口点开是渠道弹窗（安卓两条 / 苹果两条），尺寸走默认的 md，
            与旁边两颗 h-10 对齐。 */}
        <DownloadAppButton />
        <Button variant="secondary" size="md" disabled={idle} onClick={onReconnect}>
          重新连接
        </Button>
        <Button variant="outline" size="md" disabled={idle} onClick={onRevokeAll}>
          吊销全部设备授权
        </Button>
      </div>
    </Card>
  )
}

/** 这一行现在有没有值可揭：一眼能看出来的「还没取到地址」就别给一颗点了没反应的按钮。 */
function phoneHintAddress(book: AddressBook | null, pairing: PairingInfo | null): string {
  if (book && book.lan.length + book.public.length > 0) return 'book'
  return pairing?.lanUrls?.[0] ?? ''
}

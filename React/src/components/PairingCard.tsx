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

import type { AddressBook, PairingInfo, StatusView } from '../lib/api.ts'
import { AddressPicker } from './AddressPicker.tsx'
import { InfoList, InfoRow } from './InfoRow.tsx'

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
          {/* 白底是必须的：二维码是黑白的，暗色主题下要保证扫得出来。 */}
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
          <Button variant="outline" size="md" disabled={idle} onClick={onRegenerate}>
            重新生成配对码
          </Button>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <InfoList>
            <InfoRow label="配对策略">{policyText}</InfoRow>
            <InfoRow label="中转地址" mono>
              {pairing?.relayUrl || status.relayUrl || '—'}
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
              <AddressPicker
                book={addressBook}
                port={pairing?.lanPort ?? status.lan.port}
                value={addressBook?.preferred ?? ''}
                busy={idle}
                onChange={onSavePreferred}
                fallbackUrls={pairing?.lanUrls ?? []}
              />
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

      {/* 维护这两个动作属于「连不上时怎么办」，跟配对是同一件事，靠右收齐。
          「重启 sidecar」按用户要求搬到「插件更新」卡片里 —— 它和更新讲的是同一件事：
          让磁盘上的新代码立刻生效（sidecar 层不用重启宿主，宿主层才需要）。 */}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
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

// 配对地址操作使用小号图标按钮，悬停提示保留完整操作名称。
/**
 * 配对与二维码卡片：区分取码等待与失败，失败时可单独重试，SVG 默认遮挡。
 *
 * 地址那串是宿主给的候选顺序（用户选过的排最前），手机也是按这个顺序挨个试的。
 *
 * 卡片上**不摆配对码**：普通用户拿 APP 扫一下码就配上了，码值在这儿只是多一处会被旁边的人
 * 看走眼的东西。「重新生成」那颗也一并去了 —— 宿主在配对成功那一刻就会换码换票据
 * （`rotatePairing`），二维码自己会变，不需要人来按。
 *
 * 地址行操作是小号图标按钮：不加胶囊边框和底色，颜色走主题 token，日夜间自动适配。
 * 2026-11-20 用户要求：整卡按「左显示、右控件」重排——左列放连接信息与运行中版本，
 * 右列放权限档位（三按钮切换）、配对策略、自动上报网络地址。
 */
import { t } from '../lib/i18n/index.ts'
import { Button } from '@appica/ui-react/button'
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
import { isPublicRelayUrl } from '../lib/links.ts'
import { AddressPicker } from './AddressPicker.tsx'
import { ALIGNED_ROWS, InfoList, InfoRow } from './InfoRow.tsx'
import { IssueMark, type Issue } from './IssueMark.tsx'
import { InfoMark } from './InfoMark.tsx'
import { RevealButton } from './RevealButton.tsx'

type Props = {
  status: StatusView
  pairing: PairingInfo | null
  /** 宿主枚举的地址库：地址那行靠它分「局域网 / 公网」并在原地选优先地址。 */
  addressBook: AddressBook | null
  addressError?: string
  onRetryAddresses?: () => void
  /** 运行中版本：左列最后一行的只读展示。 */
  version: string
  /** 版本对不上的详情，挂在版本号那行的感叹号上。 */
  versionIssues?: Issue[]
  busy: string
  error: string
  /** 上一次重启 sidecar 的失败原因；成功时是 null。 */
  onRetryPairing: () => void
  onSavePreferred: (address: string) => void
  /** 「修改」：开「局域网端口」那个弹窗（改的是配置里的首选端口）。 */
  onEditPort: () => void
  /** 只输出正文与动作，外壳由控制台那张合并卡提供。 */
  bare?: boolean
}

/**
 * 配对与二维码。
 *
 * 二维码 SVG 由宿主生成（`QRCode.toString`，512px、纠错 M），这里只负责摆放：网页端自己画
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
/** 二维码入口上的小图标。 */
function QrGlyph() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className="size-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3M21 14v.01M14 21h.01M17 21h4v-4" />
    </svg>
  )
}

export function PairingCard({
  status,
  pairing,
  addressBook,
  addressError = '',
  onRetryAddresses,
  version,
  versionIssues = [],
  busy,
  error,
  onRetryPairing,
  onSavePreferred,
  onEditPort,
  bare = false,
}: Props) {
  const idle = busy !== ''
  /** 「中转地址」那行的明文：默认遮上。 */
  const relayUrl = pairing?.relayUrl || status.relayUrl || '—'
  /**
   * 「手机该填的地址」那行的明文：默认遮上。它是这台机器**此刻真的在用的网卡地址**
   * （设备名与内网网段都写在里面），比中转地址更值得别摆着。
   */
  const phoneAddress = addressError ? 'error' : phoneHintAddress(addressBook, pairing)
  // 「中转地址」这一行明文摆着、可当场遮上：只当页面里的一次开关，不落盘 ——
  // 默认值才是那个谨慎的选项，记住了反而把「默认隐藏」抵消掉。
  // 二维码不在这里：它整块就是个入口，点一下直接开放大弹窗（见下面的二维码格）。
  const [shown, setShown] = React.useState({ relay: false })
  const [addressOpen, setAddressOpen] = React.useState(false)
  // 放大二维码：屏幕缩放、手机离得远时，卡片里那颗太小。它只是同一张码的另一个尺寸，
  // 揭开状态另算 —— 关掉弹窗回到卡片里的样子，不改变「默认遮着」那条。
  const [qrZoom, setQrZoom] = React.useState(false)
  // 二维码占位的尺寸跟随右邻信息行：量它的实际高度，宽高都取这个值才是正方形。
  // 不靠 aspect-ratio 从高度反推宽度——高度由内容撑开时会塌成竖条，把文字挤成竖排。
  const infoRef = React.useRef<HTMLDivElement | null>(null)
  const [qrSize, setQrSize] = React.useState(0)
  React.useEffect(() => {
    const el = infoRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const measure = () => setQrSize(Math.round(el.getBoundingClientRect().height))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const toggle = (key: keyof typeof shown) => setShown((current) => ({ ...current, [key]: !current[key] }))

  const body = (
    <>
      <div className={`${bare ? '' : 'mt-3'} flex flex-col gap-4 sm:flex-row sm:items-stretch`}>
        {/* 二维码只用一块方形的入口：点它直接开放大弹窗——「显示」与「放大」合成一下，
            卡片里不再摆真正的码图（也更好防窥屏）。
            宽屏尺寸由右邻信息行的实测高度驱动：宽高都取这个值，既是正方形又与最后一行齐平。
            窄屏单列没有可参照的高度，退回限宽 200 的正方形并居中。 */}
        <div
          className="relative mx-auto aspect-square w-full max-w-[200px] shrink-0 self-center sm:mx-0 sm:h-[var(--qr-size)] sm:w-[var(--qr-size)] sm:max-w-none sm:self-start"
          style={qrSize > 0 ? { '--qr-size': `${qrSize}px` } as React.CSSProperties : undefined}
        >
          {!pairing?.svg ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-md border border-border-muted bg-background-muted p-3 text-foreground-subtle">
              {error ? (
                <>
                  <span className="text-xs">{t('panel.pairing.qrFailed')}</span>
                  <Button variant="ghost" size="sm" disabled={idle} onClick={onRetryPairing}>
                    {t('panel.console.retryPairing')}
                  </Button>
                </>
              ) : (
                <>
                  <Spinner />
                  <span className="text-xs">{t('panel.pairing.noQr')}</span>
                </>
              )}
            </div>
          ) : (
            <button
              type="button"
              className="absolute inset-0 flex cursor-zoom-in flex-col items-center justify-center gap-2 rounded-md border border-border-muted bg-background-muted p-3 text-foreground-subtle transition-colors hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setQrZoom(true)}
              aria-label={`${t('panel.pairing.qrZoom')}：${t('panel.pairing.qr')}`}
            >
              <QrGlyph />
              <span className="text-xs">{t('panel.pairing.qrHidden')}</span>
              <span className="text-xs">{t('panel.common.show')}</span>
            </button>
          )}
        </div>

        <div ref={infoRef} className="flex min-w-0 flex-1 flex-col">
          <InfoList className={ALIGNED_ROWS}>
            <InfoRow label={t('panel.connection.relayUrl')} nowrap>
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
            <InfoRow label={t('panel.pairing.port')} mono nowrap>
              <span className="inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
                <span>
                  {pairing?.lanPort ?? status.lan.port}
                  {pairing?.lanPortAdjusted ? (
                    <span className="ml-2 font-sans text-xs text-foreground-muted">{t('panel.pairing.portFallback')}</span>
                  ) : null}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('panel.pairing.portTitle')}
                  title={t('panel.pairing.portTitle')}
                  disabled={idle}
                  onClick={onEditPort}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m16 3 5 5M4 15 16 3a3.54 3.54 0 0 1 5 5L9 20l-6 1 1-6Z" />
                  </svg>
                </Button>
              </span>
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
            <InfoRow label={t('panel.pairing.phoneAddress')} nowrap>
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
            {/* 运行中版本：只读展示，控件都在右列。 */}
            <InfoRow
              label={t('panel.update.runningVersion')}
              mono
              labelExtra={versionIssues.length > 0 ? <IssueMark issue={versionIssues[0]} /> : undefined}
            >
              {version || t('panel.update.unknownVersion')}
            </InfoRow>
          </InfoList>
        </div>
      </div>

      {/* 重启失败与取码失败都不在这里铺告警块：前者在连接卡「旁挂进程」行，后者就在二维码占位里。 */}

      {/* 「下载 APP」「网络配置」「重新连接」都搬到标题右侧了，这里不再摆一排动作。 */}

      {/*
        放大二维码：与卡片里那颗是同一份 SVG，只是给到能凑近扫的尺寸。
        屏幕缩放、显示器离得远、手机举着不方便时，这块比把卡片撑大管用。
      */}
      <Dialog open={qrZoom} onOpenChange={setQrZoom}>
        <DialogContent className="w-[min(680px,94vw)] max-h-[90vh] max-w-none" closeLabel={t('panel.common.close')}>
          <DialogHeader>
            <DialogTitle>{t('panel.pairing.qr')}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="flex items-center justify-center overflow-auto rounded-md bg-white p-2 sm:p-4">
              {pairing?.svg ? (
                <div
                  className="aspect-square h-[min(64vh,560px)] w-auto max-w-full [&_svg]:h-full [&_svg]:w-full"
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
              error={addressError}
              onRetry={onRetryAddresses}
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

    </>
  )

  if (bare) return body
  return (
    <Card frame="solid">
      <CardHeader className="flex-none px-4 py-3">
        <CardTitle className="text-base lg:text-lg">{t('panel.pairing.cardTitle')}</CardTitle>
      </CardHeader>
      {body}
    </Card>
  )
}

/**
 * 整卡右列的控件：按用户要求自上而下是配对策略、自动上报网络地址。
 * 自动上报的说明弹窗也跟着搬到这里，两项改的都是 `/api/relay/config` 上各自的字段。
 */
export function PairingPolicyRows({
  status,
  busy,
  onChangePolicy,
  onToggleRemote,
  onChangeControlReport,
}: {
  status: StatusView
  busy: string
  onChangePolicy: (policy: PairingPolicy) => void
  onToggleRemote: (enabled: boolean) => void
  onChangeControlReport: (enabled: boolean) => void
}) {
  const idle = busy !== ''
  const pairingAllowed = status.pairingPolicy === 'code'
  // 老宿主没这个字段时按开（与宿主历史行为一致）。
  const controlReport = status.controlReportEnabled !== false
  const [controlReportInfoOpen, setControlReportInfoOpen] = React.useState(false)
  return (
    <>
      <InfoRow label={t('panel.pairing.policy')}>
        <Switch
          size="md"
          checked={pairingAllowed}
          disabled={idle}
          onCheckedChange={(next) => onChangePolicy(next ? 'code' : 'deny')}
          aria-label={t('panel.devices.allowTitle')}
        />
      </InfoRow>
      <InfoRow label={t('panel.connection.remoteControl')}>
        <Switch
          size="md"
          checked={status.enabled}
          disabled={idle}
          onCheckedChange={(next) => onToggleRemote(next)}
          aria-label={t('panel.connection.remoteControl')}
        />
      </InfoRow>
      <InfoRow
        label={t('panel.pairing.controlReport')}
        nowrap
        labelExtra={
          <button
            type="button"
            aria-label={t('panel.pairing.controlReportInfo')}
            title={t('panel.pairing.controlReportInfo')}
            className="shrink-0 cursor-pointer rounded text-foreground-muted transition-colors duration-200 hover:text-foreground-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            onClick={() => setControlReportInfoOpen(true)}
          >
            <InfoMark />
          </button>
        }
      >
        <Switch
          size="md"
          checked={controlReport}
          disabled={idle}
          aria-label={t('panel.pairing.controlReport')}
          onCheckedChange={(next) => {
            if (next !== controlReport) onChangeControlReport(next)
          }}
        />
      </InfoRow>
      {/* 「总控」说明：点标签旁那颗感叹号才开，平时不占地方。 */}
      <Dialog open={controlReportInfoOpen} onOpenChange={setControlReportInfoOpen}>
        <DialogContent className="max-w-md" closeLabel={t('panel.common.close')}>
          <DialogHeader>
            <DialogTitle>{t('panel.pairing.controlReport')}</DialogTitle>
          </DialogHeader>
          <DialogBody className="whitespace-pre-line text-sm leading-6 text-foreground-muted">
            {t('panel.pairing.controlReportDetail')}
            {'\n\n'}{t('panel.pairing.controlReportTarget', { target: status.controlReportTargetUrl || t('panel.pairing.controlReportUnknown') })}
            {status.relayUrl && !isPublicRelayUrl(status.relayUrl) ? `\n\n${t('panel.pairing.controlReportSelfHosted')}` : ''}
          </DialogBody>
          <DialogFooter className="flex justify-end">
            <Button variant="outline" onClick={() => setControlReportInfoOpen(false)}>
              {t('panel.common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 这一行现在有没有值可揭：一眼能看出来的「还没取到地址」就别给一颗点了没反应的按钮。 */
function phoneHintAddress(book: AddressBook | null, pairing: PairingInfo | null): string {
  if (book && book.lan.length + book.public.length > 0) return 'book'
  return pairing?.lanUrls?.[0] ?? ''
}

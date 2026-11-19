/**
 * 配对与二维码卡片：区分取码等待与失败，失败时可单独重试，SVG 默认遮挡。
 *
 * 地址那串是宿主给的候选顺序（用户选过的排最前），手机也是按这个顺序挨个试的。
 *
 * 卡片上**不摆配对码**：普通用户拿 APP 扫一下码就配上了，码值在这儿只是多一处会被旁边的人
 * 看走眼的东西。「重新生成」那颗也一并去了 —— 宿主在配对成功那一刻就会换码换票据
 * （`rotatePairing`），二维码自己会变，不需要人来按。
 *
 * 标题栏那几颗是纯文字按钮：不加胶囊边框和底色，颜色走主题 token，日夜间自动适配。
 * 2026-11-20 用户要求：原「其他」弹窗里的策略、档位、自动审阅挂到整卡右列（PairingPolicyRows），
 * 网络配置与检查网络并到右下动作行，下载 APP 去顶栏；左列只留连接信息。
 */
import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@appica/ui-react/alert'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@appica/ui-react/select'
import { Switch } from '@appica/ui-react/switch'
import * as React from 'react'

import type { AddressBook, PairingInfo, PairingPolicy, StatusView, Tier } from '../lib/api.ts'
import { AddressPicker } from './AddressPicker.tsx'
import { EVEN_ROWS, InfoList, InfoRow } from './InfoRow.tsx'
import { InfoMark } from './InfoMark.tsx'
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
  /** 「自动上报网络地址」（`status.controlReportEnabled`，总控上报）：改的是同一个 `/api/relay/config`。 */
  onChangeControlReport: (enabled: boolean) => void
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
  busy,
  error,
  restartError,
  onChangeControlReport,
  onRetryPairing,
  onSavePreferred,
  onEditPort,
  bare = false,
}: Props) {
  const idle = busy !== ''
  /** 「自动上报网络地址」（总控上报）：老宿主没这个字段时按开（与宿主历史行为一致）。 */
  const controlReport = status.controlReportEnabled !== false
  /** 「中转地址」那行的明文：默认遮上。 */
  const relayUrl = pairing?.relayUrl || status.relayUrl || '—'
  /**
   * 「手机该填的地址」那行的明文：默认遮上。它是这台机器**此刻真的在用的网卡地址**
   * （设备名与内网网段都写在里面），比中转地址更值得别摆着。
   */
  const phoneAddress = phoneHintAddress(addressBook, pairing)
  // 「中转地址」这一行明文摆着、可当场遮上：只当页面里的一次开关，不落盘 ——
  // 默认值才是那个谨慎的选项，记住了反而把「默认隐藏」抵消掉。
  // 二维码不在这里：它整块就是个入口，点一下直接开放大弹窗（见下面的二维码格）。
  const [shown, setShown] = React.useState({ relay: false })
  const [addressOpen, setAddressOpen] = React.useState(false)
  // 放大二维码：屏幕缩放、手机离得远时，卡片里那颗太小。它只是同一张码的另一个尺寸，
  // 揭开状态另算 —— 关掉弹窗回到卡片里的样子，不改变「默认遮着」那条。
  const [qrZoom, setQrZoom] = React.useState(false)
  // 「自动上报网络地址」那行的说明弹窗：讲清楚总控是什么、开了之后能干什么。
  const [controlReportInfoOpen, setControlReportInfoOpen] = React.useState(false)
  const toggle = (key: keyof typeof shown) => setShown((current) => ({ ...current, [key]: !current[key] }))

  const body = (
    <>
      {error ? (
        <Alert variant="warning" className={bare ? undefined : 'mt-3'}>
          <AlertIcon />
          <AlertTitle>{t('panel.pairing.qrFailed')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className={`${bare ? '' : 'mt-3'} flex flex-col gap-4 sm:flex-row sm:items-stretch`}>
        {/* 二维码只用一块方形的入口：点它直接开放大弹窗——「显示」与「放大」合成一下，
            卡片里不再摆真正的码图（也更好防窥屏）。
            宽度固定 150（sm 起）、方形不拉伸：原先按大屏视口断点把宽度交给内容反推，
            卡片挪进窄栏后视口仍宽、卡片却窄了，反推出一条竖条。现在宽度定死、始终方形；
            等高时它顶部对齐，不跟着右侧拉高。 */}
        <div className="relative mx-auto aspect-square w-full max-w-[200px] shrink-0 self-center sm:mx-0 sm:w-[150px] sm:max-w-none sm:self-start">
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

        <div className="flex min-w-0 flex-1 flex-col">
          <InfoList className={EVEN_ROWS}>
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
                {/* 用户要求：文字按钮，不要胶囊 —— 形状与旁边行里的「显示」一致（ghost + sm），
                    手搓一颗会让字号、行高与同一张卡里别的按钮对不齐。 */}
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('panel.pairing.portTitle')}
                  disabled={idle}
                  onClick={onEditPort}
                >
                  {t('panel.common.edit')}
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
            {/*
              「自动上报网络地址」（总控上报）：这功能一直都是开着的，这里把它摆成一颗默认开的
              开关，让不想要的人能关。标题右边那颗感叹号点开是说明弹窗 —— 比悬浮提示能放下更多字，
              也正好把「总控」这个东西讲给用户听。开关取值直接来自 `status.controlReportEnabled`，
              写回走同一个 `/api/relay/config`，不另存一份状态。
            */}
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
            {/* 配对策略、权限档位、自动审阅在整卡右列（PairingPolicyRows），左列只留连接信息。 */}
          </InfoList>
        </div>
      </div>

      {restartError ? (
        <Alert variant="error" className={bare ? undefined : 'mt-3'}>
          <AlertIcon />
          <AlertTitle>{t('panel.pairing.sidecarRestartFailed')}</AlertTitle>
          <AlertDescription>{restartError}</AlertDescription>
        </Alert>
      ) : null}

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

      {/*
        「自动上报网络地址」说明弹窗：讲清楚「总控」是什么、这台电脑上报了什么、关掉会怎样。
        用户点标题右边那颗感叹号才有，平时不占地方。
      */}
      <Dialog open={controlReportInfoOpen} onOpenChange={setControlReportInfoOpen}>
        <DialogContent className="max-w-md" closeLabel={t('panel.common.close')}>
          <DialogHeader>
            <DialogTitle>{t('panel.pairing.controlReport')}</DialogTitle>
          </DialogHeader>
          <DialogBody className="whitespace-pre-line text-sm leading-6 text-foreground-muted">
            {t('panel.pairing.controlReportDetail')}
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
 * 配对策略那组设置行：搬出「其他」弹窗后挂在整卡右列，与版本信息并排。
 * 取自同一份 status，改的仍是那三条 `/api/relay/config` 字段。
 */
export function PairingPolicyRows({
  status,
  busy,
  onChangePolicy,
  onChangeTier,
  onChangeAutoReview,
}: {
  status: StatusView
  busy: string
  onChangePolicy: (policy: PairingPolicy) => void
  onChangeTier: (tier: Tier) => void
  onChangeAutoReview: (enabled: boolean) => void
}) {
  const idle = busy !== ''
  const pairingAllowed = status.pairingPolicy === 'code'
  const pairingTier: Tier = status.pairingTier ?? 'full'
  const autoReview = status.approvalAutoReview === true
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
      <InfoRow label={t('panel.pairing.tier')} hint={t('panel.pairing.tierHint')}>
        <Select
          size="sm"
          value={pairingTier}
          disabled={idle}
          itemToStringLabel={(next) => tierLabel(next as Tier)}
          onValueChange={(next) => {
            if (typeof next === 'string' && next !== pairingTier) onChangeTier(next as Tier)
          }}
        >
          <SelectTrigger className="w-24 min-w-0" aria-label={t('panel.pairing.tier')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIER_OPTIONS.map((tier) => (
              <SelectItem key={tier} value={tier}>
                {tierLabel(tier)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </InfoRow>
      <InfoRow label={t('panel.pairing.autoReview')} hint={t('panel.pairing.autoReviewHint')}>
        <Switch
          size="md"
          checked={autoReview}
          disabled={idle}
          aria-label={t('panel.pairing.autoReview')}
          onCheckedChange={(next) => {
            if (next !== autoReview) onChangeAutoReview(next)
          }}
        />
      </InfoRow>
    </>
  )
}

/** 这一行现在有没有值可揭：一眼能看出来的「还没取到地址」就别给一颗点了没反应的按钮。 */
function phoneHintAddress(book: AddressBook | null, pairing: PairingInfo | null): string {
  if (book && book.lan.length + book.public.length > 0) return 'book'
  return pairing?.lanUrls?.[0] ?? ''
}

/** 三档的显示顺序：从最窄到最宽，与「收紧往左、放开往右」的直觉一致。 */
export const TIER_OPTIONS: readonly Tier[] = ['readonly', 'approve', 'full']

/** 档位 → 人说得出名字的那一档（走字典）。 */
export function tierLabel(tier: Tier): string {
  if (tier === 'readonly') return t('panel.pairing.tierReadonly')
  if (tier === 'approve') return t('panel.pairing.tierApprove')
  return t('panel.pairing.tierFull')
}

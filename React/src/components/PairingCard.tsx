// 扫码绑定成功后收起二维码弹窗，收起那一刻不让二维码闪成空白或旧码；放大弹窗左侧放大码、右侧同框摆已绑定设备列表（含解绑与清空历史）。
/**
 * 配对与二维码卡片：区分取码等待与失败，失败时可单独重试，SVG 默认遮挡。
 *
 * 地址那串是宿主给的候选顺序（用户选过的排最前），手机也是按这个顺序挨个试的。
 *
 * 卡片上**不摆配对码**：普通用户拿 APP 扫一下码就配上了，码值在这儿只是多一处会被旁边的人
 * 看走眼的东西。二维码默认自己会变（配对成功那一刻宿主换码换票据，`rotatePairing`），
 * 但用户仍可在放大弹窗里手动「刷新」换一张新码——那颗按钮跟着大图走，卡片入口不再多摆控件。
 *
 * 2026-11-23 用户要求：端口与运行中版本两行搬到下方连接状态卡；原来在 Console 右列的
 * 四个控件（允许配对 / 远程控制 / 自动上报 / 自动更新）挪到二维码旁边，右列留空。
 * 二维码尺寸继续量右邻那一列的实测高度（见下面的 ResizeObserver）。
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

import type { PairingInfo, PairingPolicy, StatusView } from '../lib/api.ts'
import { usePairingCompletion } from '../lib/usePairingCompletion.ts'
import { AutoUpdateSection } from './AutoUpdateSection.tsx'
import { DevicesCard } from './DevicesCard.tsx'
import { ALIGNED_ROWS, InfoList, InfoRow } from './InfoRow.tsx'
import { InfoMark } from './InfoMark.tsx'

type Props = {
  status: StatusView
  pairing: PairingInfo | null
  busy: string
  error: string
  /** 上一次重启 sidecar 的失败原因；成功时是 null。 */
  onRetryPairing: () => void
  /** 「刷新二维码」：作废当前这张码、换一张新的（放大弹窗底部那颗）。 */
  onRefreshQr: () => void
  /** 三个开关从 Console 右列挪来，紧挨二维码：允许配对、远程控制、自动上报。 */
  onChangePolicy: (policy: PairingPolicy) => void
  onToggleRemote: (enabled: boolean) => void
  onChangeControlReport: (enabled: boolean) => void
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
 * 二维码默认遮着；中转地址与本地识别地址两行按用户要求删掉，地址只在「网络配置」里看和改。
 *
 * 维护动作（重新连接 / 吊销全部设备授权 / 网络配置）都挂这张卡：它们属于「连不上时怎么办」。
 * 吊销不可逆，走一次 window.confirm，这类确认不该藏在拖拽或长按里。
 * 「重启 sidecar」在「插件更新」卡（它跟更新是同一件事），这里只留「上次重启失败」的红字。
 * 「刷新二维码」放在放大弹窗底部：作废当前码、换一张新的，与手机端「重新生成配对码」同一件事。
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
  busy,
  error,
  onRetryPairing,
  onRefreshQr,
  onChangePolicy,
  onToggleRemote,
  onChangeControlReport,
  bare = false,
}: Props) {
  const idle = busy !== ''
  /**
   * 远程控制整条关掉了（`status.enabled === false`）。这时宿主不会回二维码，也不会有配对 /
   * 地址可以取 —— 卡片要显示明确的「已关闭」空态，而不是一直转圈的「还没取到二维码」。
   */
  const remoteOff = status.enabled === false
  // 放大二维码：屏幕缩放、手机离得远时，卡片里那颗太小。它只是同一张码的另一个尺寸，
  // 揭开状态另算 —— 关掉弹窗回到卡片里的样子，不改变「默认遮着」那条。
  const [qrZoom, setQrZoom] = React.useState(false)
  /**
   * 配对成功那一刻宿主同时换码、写绑定成功时间。面板这边的表现原本是三步：
   * status 里的新码一上来，`qrCurrent` 先变 false —— 弹窗里的二维码被清空；Console 重取
   * 新码回来又把它画出来；`usePairingCompletion` 的 effect 最后才关窗。用户看到的就是
   * 「码消失 → 冒出新码 → 才关窗」。把关窗判定提到渲染期：开弹窗时记下当时的绑定时间，
   * 只要它变大，弹窗当次渲染就关闭，二维码来不及闪。effect 那条路保留做状态兜底。
   */
  const [zoomBaseline, setZoomBaseline] = React.useState<number | undefined>(status.lastPairingAt)
  const openQrZoom = () => {
    setZoomBaseline(status.lastPairingAt)
    setQrZoom(true)
  }
  usePairingCompletion(status.lastPairingAt, () => setQrZoom(false))
  const pairingDone = (status.lastPairingAt ?? 0) > (zoomBaseline ?? 0)
  const qrCurrent = pairing?.pairingCode === status.pairingCode
  // 二维码占位的尺寸跟随右邻信息行：量它的实际高度，宽高都取这个值才是正方形。
  // 不靠 aspect-ratio 从高度反推宽度——高度由内容撑开时会塌成竖条，把文字挤成竖排。
  const infoRef = React.useRef<HTMLDivElement | null>(null)
  const qrRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    const el = infoRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    // 直接把量到的高度写成二维码方块上的 CSS 变量，不 setState：拖窗口时高度每帧都变，
    // 走 state 会让配对卡整棵子树每帧重渲染，是拖拽卡顿的一部分。
    const measure = () => {
      const height = Math.round(el.getBoundingClientRect().height)
      const target = qrRef.current
      if (target) {
        if (height > 0) target.style.setProperty('--qr-size', `${height}px`)
        else target.style.removeProperty('--qr-size')
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const body = (
    <>
      <div className={`${bare ? '' : 'mt-3'} flex flex-col gap-4 sm:flex-row sm:items-stretch`}>
        {/* 二维码只用一块方形的入口：点它直接开放大弹窗——「显示」与「放大」合成一下，
            卡片里不再摆真正的码图（也更好防窥屏）。
            宽屏尺寸由右邻信息行的实测高度驱动：宽高都取这个值，既是正方形又与最后一行齐平。
            窄屏单列没有可参照的高度，退回限宽 200 的正方形并居中。 */}
        <div
          ref={qrRef}
          className="relative mx-auto aspect-square w-full max-w-[200px] shrink-0 self-center sm:mx-0 sm:h-[var(--qr-size)] sm:w-[var(--qr-size)] sm:max-w-none sm:self-start"
        >
          {!pairing?.svg || !qrCurrent ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-md border border-border-muted bg-background-muted p-3 text-foreground-subtle">
              {remoteOff ? (
                <span className="px-2 text-center text-xs leading-5">{t('panel.pairing.remoteOffHint')}</span>
              ) : error ? (
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
              onClick={openQrZoom}
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
            <PairingPolicyRows
              status={status}
              busy={busy}
              onChangePolicy={onChangePolicy}
              onToggleRemote={onToggleRemote}
              onChangeControlReport={onChangeControlReport}
            />
          </InfoList>
          <AutoUpdateSection />
        </div>
      </div>

      {/* 重启失败与取码失败都不在这里铺告警块：前者在连接卡「旁挂进程」行，后者就在二维码占位里。 */}

      {/* 「下载 APP」「网络配置」「重新连接」都搬到标题右侧了，这里不再摆一排动作。 */}

      {/*
        放大二维码：与卡片里那颗是同一份 SVG，只是给到能凑近扫的尺寸。
        屏幕缩放、显示器离得远、手机举着不方便时，这块比把卡片撑大管用。
      */}
      <Dialog open={qrZoom && !pairingDone} onOpenChange={setQrZoom}>
        <DialogContent className="w-[min(1040px,94vw)] max-h-[90vh] max-w-none" closeLabel={t('panel.common.close')}>
          <DialogHeader>
            <DialogTitle>{t('panel.pairing.qr')}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {/* 扫码这一刻顺手能看「这台电脑上还连着哪些手机」：码放左边，设备列表放右边；
                窄屏收成上下两段。列表复用设备卡本身（同一份数据、同一套解绑 / 清空历史），
                没有设备时它自己不渲染，这里就只剩居中的码。 */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-stretch">
              <div className="flex flex-1 items-center justify-center overflow-auto rounded-md bg-white p-2 sm:p-4">
                {pairing?.svg && qrCurrent ? (
                  <div
                    className="aspect-square h-[min(64vh,560px)] w-auto max-w-full [&_svg]:h-full [&_svg]:w-full"
                    dangerouslySetInnerHTML={{ __html: pairing.svg }}
                  />
                ) : null}
              </div>
              <DevicesCard busy={busy} bare />
            </div>
          </DialogBody>
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setQrZoom(false)}>
              {t('panel.common.close')}
            </Button>
            <Button variant="primary" disabled={idle} onClick={onRefreshQr}>
              {t('panel.pairing.refreshQr')}
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
            className="-m-1 inline-flex shrink-0 cursor-pointer items-center justify-center rounded p-1 text-foreground-muted transition-colors duration-200 hover:text-foreground-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
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
            {status.relayUrl ? `\n\n${t('panel.pairing.controlReportSelfHosted')}` : ''}
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

/**
 * 「赞助」按钮，点开弹赞助窗：USDT 收款二维码 + 爱发电入口。
 *
 * 2026-11-21：USDT 那块下面并列加「爱发电」，一颗链接按钮开系统浏览器到主页
 * （`AFDIAN_URL`），用户过去自己选档位付；面板不接 API、不绑订单、不给权益，与官网口径一致。
 * 与 App 那版赞助页不同，这里不给爱发电做地区判断：面板跑在桌面壳里，没有 App 商店的
 * 国家字段可用，硬做只会误伤。
 *
 * 与「加入交流群」「给个 Star」同一排：2026-11-17 从页面悬浮挪进控制台顶栏左侧，
 * 三颗横排，由 `FloatingActions` 统一编排，这里只管自己这颗按钮与那扇窗。
 *
 * 收款地址是 Polygon 上的 USDT：`0x` 开头是 EVM 地址，收不了 TRC20 那种 `T` 开头的。
 * 二维码里编的是**纯地址**，不带 EIP-681 的链前缀 —— 带链的写法只有部分钱包认，认不出
 * 的扫了等于没反应；纯地址任何钱包都填得进去，网络这一层靠窗里的文案写死。
 * 二维码是构建时预生成的静态图（`assets/sponsor-usdt-qr.png`），由 vite 内联进单文件
 * 产物，运行时没有任何二维码依赖。
 *
 * 地址一旦公开就收不回（链上余额与流水全部可查），所以这里只做「展示 / 复制」，
 * 不做任何「一键跳转钱包」的链接 —— 那类链接中途被替换成别的地址，钱就追不回来了。
 *
 * 版面按「一眼看完三步」排，而不是把每样东西都摊开：标题与一句说明在表头，中间是二维码
 * 与两枚币种 / 网络标签，下面一行地址自带复制钮（复制就地给回执，不再另起一颗大按钮），
 * 最底下一句「感谢！」垫住（2026-11-10 用户要求：提醒语整条删掉，收尾不说免责只说谢谢）。
 *
 * 触发件是图标加文字的 ghost 按钮：不带胶囊外形，文字与图标都走主题 token，日夜间自动跟着变。
 */

import { Button, buttonVariants } from '@appica/ui-react/button'
import { Chip } from '@appica/ui-react/chip'
import { CopyButton } from '@appica/ui-react/copy-button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@appica/ui-react/dialog'
import { useState } from 'react'

import sponsorQr from '../assets/sponsor-usdt-qr.png'
import { t } from '../lib/i18n/index.ts'
import { AFDIAN_URL } from '../lib/links.ts'

/** 收款地址：全小写、不带任何链前缀。改地址时连同二维码一起换（那张图是按这个串生成的）。 */
const SPONSOR_ADDRESS = '0x62744c084c272ddba4680920edc3239cb7180718'

function HeartIcon() {
  // Material Icons 的心形（Apache 2.0，单条实心 path）。按钮基类会给没带 `stroke-`
  // 的 svg 描 1.85 的边，实心标不需要，所以显式带 `stroke-0` 挡掉。
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className="stroke-0"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
    </svg>
  )
}

export function SponsorButton({ compact = false }: { compact?: boolean } = {}) {
  const [open, setOpen] = useState(false)
  // 复制失败是唯一要留下的话：成功由复制钮自己换成「已复制」，失败得说清为什么。
  const [copyFailed, setCopyFailed] = useState(false)

  return (
    <>
      {/* 三颗的横排编排归 `FloatingActions`；这里只管自己那颗按钮。 */}
      <Button
        variant="ghost"
        size={compact ? 'sm' : 'lg'}
        className="pointer-events-auto"
        onClick={() => {
          setCopyFailed(false)
          setOpen(true)
        }}
      >
        <HeartIcon />
        {t('panel.links.sponsor')}
      </Button>
      <SponsorDialog open={open} onOpenChange={setOpen} copyFailed={copyFailed} setCopyFailed={setCopyFailed} />
    </>
  )
}

/** 两种触发件共用的那一扇窗（内容一字不改，见文件头）。 */
function SponsorDialog({
  open,
  onOpenChange,
  copyFailed,
  setCopyFailed,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  copyFailed: boolean
  setCopyFailed: (value: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-sm">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-xl">{t('panel.links.sponsorTitle')}</DialogTitle>
            <DialogDescription>{t('panel.links.sponsorIntro')}</DialogDescription>
          </DialogHeader>

          <DialogBody className="flex flex-col gap-4">
            {/* 二维码：收到 180 以内，留白给下面的地址与提醒；底色必须是白的，深色主题下
                半透明白底会让码的对比度掉下来。 */}
            <div className="flex justify-center">
              <img
                src={sponsorQr}
                alt={t('panel.links.sponsorQrAlt')}
                className="size-44 rounded-lg border border-border-muted bg-white p-2"
              />
            </div>

            {/* 币种与网络两枚标签：比一整块「网络：Polygon」省一半高度，读起来也更快。 */}
            <div className="flex justify-center gap-2">
              <Chip variant="soft" size="sm">
                USDT
              </Chip>
              <Chip variant="soft" size="sm">
                Polygon
              </Chip>
            </div>

            <div className="flex flex-col gap-2 rounded-lg border border-border-muted bg-background-muted p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-foreground-muted">
                  {t('panel.links.sponsorAddress')}
                </span>
                <CopyButton
                  value={SPONSOR_ADDRESS}
                  label={t('panel.links.sponsorCopy')}
                  copiedLabel={t('panel.links.sponsorCopied')}
                  size="sm"
                  variant="outline"
                  onCopyError={() => setCopyFailed(true)}
                  onCopy={() => setCopyFailed(false)}
                >
                  {t('panel.links.sponsorCopy')}
                </CopyButton>
              </div>
              <code className="block select-all break-all font-mono text-[11px] leading-4 text-foreground-strong">
                {SPONSOR_ADDRESS}
              </code>
              {copyFailed ? (
                <p className="text-[11px] leading-4 text-foreground-strong">
                  {t('panel.links.sponsorCopyFailed')}
                </p>
              ) : null}
            </div>

            {/* 爱发电：与 USDT 并列的第二种方式。链接按钮开系统浏览器到主页（见 links.ts），
                带人过去自己选档位；面板里不收钱、不接 API、不带下单参数。用 `<a>` 而不是
                `window.open`：桌面壳只把 http(s) 交给系统浏览器，新标签页由浏览器自己开。 */}
            <div className="flex flex-col items-center gap-2 border-t border-border-muted pt-4">
              <p className="text-sm font-medium text-foreground-strong">
                {t('panel.links.sponsorAfdianTitle')}
              </p>
              <p className="text-center text-xs leading-5 text-foreground-muted">
                {t('panel.links.sponsorAfdianIntro')}
              </p>
              <a
                href={AFDIAN_URL}
                target="_blank"
                rel="noreferrer noopener"
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                {t('panel.links.sponsorAfdianAction')}
              </a>
            </div>
          </DialogBody>

          {/* 收尾那句单独垫在最底下，不与地址框挤在一起。 */}
          <div className="px-6 pt-4 pb-6">
            <p className="text-center text-sm text-foreground-muted">
              {t('panel.links.sponsorNote')}
            </p>
          </div>
        </DialogContent>
    </Dialog>
  )
}

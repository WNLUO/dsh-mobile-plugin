// 2026-11-28：爱发电只对中文用户显示，与微信群按钮同一口径。
/**
 * 「赞助」按钮，点开弹赞助窗：USDT 收款二维码 + 爱发电入口。
 *
 * 2026-11-21：赞助窗加入「爱发电」，一颗链接按钮开系统浏览器到主页
 * （`AFDIAN_URL`），用户过去自己选档位付；面板不接 API、不绑订单、不给权益，与官网口径一致。
 * 与 App 那版赞助页不同，这里不给爱发电做地区判断：面板跑在桌面壳里，没有 App 商店的
 * 国家字段可用，硬做只会误伤。
 *
 * 2026-11-26：爱发电整块挪到二维码上方，标题旁加官方 Simple Icons 标（`afdian`，CC0，
 * 与 GitHub 标同为内联实心 path）；「去爱发电」从描边小按钮改成整行主色按钮，末尾带
 * 外链箭头。先让人看见另一种支持方式，再往下看收款码。文案沿用原有翻译键。
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
 * 版面按「一眼看完」排，而不是把每样东西都摊开：表头一句说明之后先亮爱发电，中间是二维码
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
import { usePanelLanguage } from '../lib/i18n/use-language.ts'
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

/**
 * 爱发电官方标（Simple Icons `afdian`，CC0，24×24 单条实心 path），与 StarButton 的
 * GitHub 标一样内联，不引图标依赖。品牌紫在日夜间都读得清，所以不走 currentColor；
 * 实心标照旧带 `stroke-0` 挡掉按钮基类的描边规则。
 */
function AfdianMark() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className="size-5 stroke-0"
      fill="#946CE6"
      aria-hidden="true"
    >
      <path d="M9 14.234a.567.567 0 1 0 0 1.134.567.567 0 0 0 0-1.134m5.351 1.705a.567.567 0 1 0 0 1.135.567.567 0 0 0 0-1.135m8.401 1.436c-.189.095-.461.1-.713.013-.169-.06-.352-.116-.534-.172-.339-.104-.904-.276-1.011-.407a.533.533 0 1 0-.853.643c.059.08.139.146.22.209-.816 1.131-4.398 3.382-9.464 2.273-2.283-.5-3.819-1.413-4.444-2.639-.451-.885-.348-1.797-.133-2.293.62-1.29 5.097-4.261 7.955-5.943a.537.537 0 0 0 .188-.733c-.149-.254-.49-.356-.73-.189-.231.135-1.015.601-2.015 1.236-.338-.227-.923-.508-1.86-.6-1.486-.148-4.92-.805-6.029-1.275C2.535 7.162.731 6.27 1.131 5.267c.092-.234.527-.613 1.47-.974a8.5 8.5 0 0 1 1.995-.492l-.212.103c-.642.312-1.343.662-1.813 1.075-.034-.022-.07-.044-.094-.069a.527.527 0 0 0-.754-.017.533.533 0 0 0-.017.756c.19.2.471.35.829.465l.039.014c1.245.383 3.458.336 6.578.211 1.345-.052 2.615-.102 3.674-.082 3.512.07 6.152 1.469 8.07 4.279 1.178 1.725.753 3.426.079 4.903a1.4 1.4 0 0 1-.231-.222.54.54 0 0 0-.75-.085.535.535 0 0 0-.086.751c.109.137.665.778 1.355.724l.037-.002c.021-.003.042.001.064-.003.472-.086.768-.063 1.045.111.367.232.547.37.511.485-.021.073-.076.125-.168.177M8.19 11.418l-.315.231a1.6 1.6 0 0 1-.243-.32c.123-.038.33.007.558.089m14.733 4.356a1.9 1.9 0 0 0-.81-.27c.632-1.544 1.034-3.565-.336-5.572-2.096-3.072-5.101-4.668-8.93-4.744-1.091-.022-2.377.029-3.737.083-1.58.063-3.683.145-5.112.027.285-.155.588-.304.851-.431 1.006-.49 1.797-.872 1.535-1.548-.137-.396-.547-.603-1.219-.618C3.748 2.669.688 3.489.138 4.872c-.31.779-.361 2.282 2.775 3.61 1.29.548 4.934 1.216 6.341 1.355.397.039.701.119.931.205a75 75 0 0 0-.986.664c-.577-.329-1.521-.718-2.226-.237a.94.94 0 0 0-.435.768c-.01.385.224.763.486 1.066-1.038.83-1.877 1.634-2.175 2.253-.332.762-.467 2.008.153 3.224.786 1.544 2.524 2.62 5.166 3.199 3.454.755 6.437.075 8.411-.966 1.099-.579 1.878-1.27 2.257-1.887l.356.113c.169.051.338.103.496.159.522.181 1.1.157 1.545-.068l.025-.013c.336-.177.577-.46.683-.803.285-.922-.528-1.432-1.018-1.74" />
    </svg>
  )
}

/** 外链箭头：按钮点了会开系统浏览器，不在面板里跳转，箭头把这件事说在前面。 */
function ExternalLinkIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4 stroke-2"
      aria-hidden="true"
    >
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
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
  // 爱发电走微信 / 支付宝，只对中文用户有意义；微信群那颗按钮也是同一条规矩。
  // USDT 是全球通的，所以只藏这一块，赞助按钮本身各门语言都在。
  const language = usePanelLanguage()
  const showAfdian = language === 'zh-Hans' || language === 'zh-Hant'
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-sm">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-xl">{t('panel.links.sponsorTitle')}</DialogTitle>
            <DialogDescription>{t('panel.links.sponsorIntro')}</DialogDescription>
          </DialogHeader>

          <DialogBody className="flex flex-col gap-4">
            {showAfdian ? (
              /* 爱发电在最上面：进窗第一眼就看到还有这种支持方式，不用等看完收款码。
                 开系统浏览器由 `<a>` 交给壳处理（见 links.ts / StarButton）。 */
              <div className="flex flex-col gap-2 rounded-lg border border-border-muted bg-background-muted p-3">
                <div className="flex items-center justify-center gap-2">
                  <AfdianMark />
                  <p className="text-sm font-medium text-foreground-strong">
                    {t('panel.links.sponsorAfdianTitle')}
                  </p>
                </div>
                <p className="text-center text-xs leading-5 text-foreground-muted">
                  {t('panel.links.sponsorAfdianIntro')}
                </p>
                <a
                  href={AFDIAN_URL}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={buttonVariants({ variant: 'primary', className: 'w-full' })}
                >
                  {t('panel.links.sponsorAfdianAction')}
                  <ExternalLinkIcon />
                </a>
              </div>
            ) : null}

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

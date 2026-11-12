/**
 * 页面右下角那颗「给个 Star」的悬浮按钮，点一下直接开 GitHub 仓库页。
 *
 * 与「加入交流群」「赞助」同一串：都落在 `bottom`/`end-6` 那条竖线上，从下往上依次是
 * 交流群（`bottom-6`）、赞助（`bottom-24`）、这颗（`bottom-[10.5rem]`）。三颗的间距是
 * 24px（上一颗 96px + 按钮自身 48px + 24px），加一颗新的就按这个式子往上挪一格。
 *
 * **点开就是外链，不开弹窗**：求 star 这件事一句话说完就够，弹窗只会让人多点一下；
 * 而站点链接必须是绝对 http(s)，面板在桌面壳里挂在 `dsh-app://app/` 下，相对地址会被
 * 解析成 `dsh-app://` 而壳只把 http(s) 交给系统浏览器（表现是「点了没反应」，见 A3-37）。
 * 用 `<a>` 而不是 `onClick` 里 `window.open`：新标签页由浏览器自己开，脚本被拦也不影响。
 *
 * 图标是 Simple Icons 的 `github`（CC0，24×24 实心标）；与「下载 APP」弹窗里那颗同一份
 * 路径，那边没导出，这里各存一份 —— 单文件内联产物引不到仓外，也不值得为一条路径加模块。
 * 实心标靠 `fill` 上色，所以要显式带 `stroke-0` 挡掉按钮基类给没带 `stroke-` 的 svg
 * 描的那一道边。
 */

import { buttonVariants } from '@appica/ui-react/button'

import { PLUGIN_REPO_URL } from '../lib/links.ts'
import { t } from '../lib/i18n/index.ts'

function GithubMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-[18px] stroke-0" fill="currentColor" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

export function StarButton({ compact = false }: { compact?: boolean } = {}) {
  return (
    // `compact` = 控制台那一窗用的小号（见 `JoinGroupButton` 里那段说明）。
    <div className={`pointer-events-none fixed end-5 z-40 ${compact ? 'bottom-24' : 'bottom-[10.5rem]'}`}>
      <a
        href={PLUGIN_REPO_URL}
        target="_blank"
        rel="noreferrer noopener"
        className={`${buttonVariants({ variant: 'secondary', size: compact ? 'sm' : 'lg' })} pointer-events-auto rounded-full shadow-lg`}
      >
        <GithubMark />
        {t('panel.links.star')}
      </a>
    </div>
  )
}

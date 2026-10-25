/**
 * 页面右上角的界面语言按钮：点开是「跟随浏览器 + 五门语言」的清单，当前那一门打勾。
 *
 * 为什么在面板里自己选一门（而不是只跟浏览器走）：海外的用户系统可能是俄、阿、西，
 * 而他想把面板当英文用；反过来，中文系统里想试一下英文排版的人也很多。手机上 App 一直
 * 有这颗按钮（设置 → 偏好 → 语言），电脑这边缺它，同一件事两处口径就不一样了。
 *
 * 语言是**按来源存的**（`dsh-mobile-panel-language`，见 `lib/i18n/core.ts`）：开发地址
 * （5273）与宿主那三条正式入口是两个来源，各记各的 —— 与右上角那颗日夜切换同一个规矩。
 * 存不住（隐私模式、盘满）不影响这一次：选完当场就换。
 *
 * 图标手画（一颗地球）：库里只有组件、没有图标集，这一页既有的几颗图标也都是手写 SVG。
 * 描边宽度不用自己写 —— `Button` 基类那条 `[&_svg:not([class*='stroke-'])]:stroke-[1.85]`
 * 会补上。语言名一律用**该语言自己的写法**（简体中文 / English / 日本語…），那层不翻。
 */
import { Button } from '@appica/ui-react/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@appica/ui-react/dropdown-menu'

import {
  LANGUAGE_LABELS,
  PANEL_LANGUAGES,
  panelLanguagePreference,
  setPanelLanguagePreference,
  t,
  type LanguagePreference,
} from '../lib/i18n/index.ts'
import { usePanelLanguage } from '../lib/i18n/use-language.ts'

function GlobeIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3.6 9h16.8M3.6 15h16.8" />
      <path d="M12 3c2.4 2.4 3.6 5.4 3.6 9s-1.2 6.6-3.6 9c-2.4-2.4-3.6-5.4-3.6-9S9.6 5.4 12 3Z" />
    </svg>
  )
}

export function LanguageMenu() {
  // 订阅语言状态：选完这一门，按钮的 `title` 与整页文案一起换（页面的重绘在 `Shell` 那一层）。
  const language = usePanelLanguage()
  const label = t('panel.language.open')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="soft" size="icon-md" className="pointer-events-auto rounded-full shadow-sm" />}
        aria-label={label}
        title={`${label} · ${LANGUAGE_LABELS[language]}`}
      >
        <GlobeIcon />
      </DropdownMenuTrigger>
      {/* 弹层默认贴着触发元素那么宽（一个图标按钮 ≈ 40px），这里改成按内容撑开。 */}
      <DropdownMenuContent align="end" style={{ width: 'auto', minWidth: '11rem' }}>
        <DropdownMenuRadioGroup
          value={panelLanguagePreference()}
          onValueChange={(value) => setPanelLanguagePreference(value as LanguagePreference)}
        >
          <DropdownMenuRadioItem value="system">{t('panel.language.system')}</DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {PANEL_LANGUAGES.map((item) => (
            <DropdownMenuRadioItem key={item} value={item}>
              {LANGUAGE_LABELS[item]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

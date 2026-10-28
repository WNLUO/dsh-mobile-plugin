/**
 * 页面右上角的界面语言按钮：点开是「跟随浏览器 + 各门语言」的清单，当前那一门打勾。
 *
 * 为什么在面板里自己选一门（而不是只跟浏览器走）：海外的用户系统可能是俄、阿、西，
 * 而他想把面板当英文用；反过来，中文系统里想试一下英文排版的人也很多。手机上 App 一直
 * 有这颗按钮（设置 → 偏好 → 语言），电脑这边缺它，同一件事两处口径就不一样了。
 *
 * 语言是**按来源存的**（`dsh-mobile-panel-language`，见 `lib/i18n/core.ts`）：开发地址
 * （5273）与宿主那三条正式入口是两个来源，各记各的 —— 与右上角那颗日夜切换同一个规矩。
 * 存不住（隐私模式、盘满）不影响这一次：选完当场就换。
 *
 * **宽窄两套形态**（2026-10-29 用户截图报这一块铺满一整屏）：这是一颗图标按钮，下拉只能
 * 从它下面往左展开，按内容撑开在窄屏上就顶到接近满宽、看着像个半成品，缩窄又会让「语言名
 * 在左、勾在右」中间空掉一大片 —— 两样都不像市面上的控件。所以窄屏（不足 768）换成**底部
 * 弹层**：标题一行、十一项一行一门、勾贴在行尾、选完即收，就是手机上挑语言的常规形态；宽屏
 * 仍是下拉。清单来源、选中态、存盘的规矩两边一模一样，只有壳不同。
 *
 * 图标手画（一颗地球）：库里只有组件、没有图标集，这一页既有的几颗图标也都是手写 SVG。
 * 描边宽度不用自己写 —— `Button` 基类那条 `[&_svg:not([class*='stroke-'])]:stroke-[1.85]`
 * 会补上。语言名一律用**该语言自己的写法**（简体中文 / English / 日本語…），那层不翻。
 */
import { useEffect, useState } from 'react'

import { Button } from '@appica/ui-react/button'
import { Drawer, DrawerBody, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from '@appica/ui-react/drawer'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@appica/ui-react/dropdown-menu'

import { cn } from '../lib/format.ts'
import {
  LANGUAGE_LABELS,
  PANEL_LANGUAGES,
  panelLanguagePreference,
  setPanelLanguagePreference,
  t,
  type LanguagePreference,
} from '../lib/i18n/index.ts'
import { usePanelLanguage } from '../lib/i18n/use-language.ts'

/** 窄屏口径：与这一页别处的 `md:` 同一档，平板与电脑仍用下拉。 */
const NARROW_QUERY = '(max-width: 767px)'

/**
 * 当前是不是窄屏。拿不到 `matchMedia`（服务端渲染、老浏览器）一律按宽屏算 ——
 * 那正是这一块从来的样子，退回它不会多出一层没人点得开的壳。
 */
function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(NARROW_QUERY)
    const sync = () => setNarrow(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  return narrow
}

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

/** 与下拉里那一颗同一套画法：勾只在选中的那一行出现，别的位置留着空位不挪字。 */
function CheckIcon({ checked }: { checked: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn('size-4.5 shrink-0 stroke-2', checked ? 'visible' : 'invisible')}
    >
      <path d="M4.3 12.55 L9.25 17.5 L19.7 6.5" />
    </svg>
  )
}

export function LanguageMenu() {
  // 订阅语言状态：选完这一门，按钮的 `title` 与整页文案一起换（页面的重绘在 `Shell` 那一层）。
  const language = usePanelLanguage()
  const label = t('panel.language.open')
  const narrow = useNarrowViewport()
  const [open, setOpen] = useState(false)
  // 当前选的是哪一档。每次换语言都通知订阅者，所以这里渲染时现读一遍就够，不必另存一份。
  const preference = panelLanguagePreference()

  const trigger = (
    <Button
      variant="soft"
      size="icon-md"
      className="pointer-events-auto rounded-full shadow-sm"
      aria-label={label}
      title={`${label} · ${LANGUAGE_LABELS[language]}`}
    >
      <GlobeIcon />
    </Button>
  )

  /** 窄屏那一套：底部弹层，一行一门、选完即收。 */
  if (narrow) {
    const row = (value: LanguagePreference, text: string) => {
      const picked = preference === value
      return (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={picked}
          onClick={() => {
            setPanelLanguagePreference(value)
            setOpen(false)
          }}
          className={cn(
            'flex w-full cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors hover:bg-background-muted',
            picked ? 'text-foreground-intense' : 'text-foreground',
          )}
        >
          <span className="min-w-0 truncate">{text}</span>
          <CheckIcon checked={picked} />
        </button>
      )
    }

    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger render={trigger} />
        <DrawerContent closeLabel={t('panel.common.close')}>
          <DrawerHeader>
            <DrawerTitle>{label}</DrawerTitle>
          </DrawerHeader>
          <DrawerBody className="px-3 pb-3">
            <div role="radiogroup" aria-label={label} className="flex flex-col gap-0.5">
              {row('system', t('panel.language.system'))}
              <div className="my-1 h-px shrink-0 bg-border" />
              {PANEL_LANGUAGES.map((item) => row(item, LANGUAGE_LABELS[item]))}
            </div>
          </DrawerBody>
        </DrawerContent>
      </Drawer>
    )
  }

  /** 宽屏那一套：贴着那颗图标展开的下拉。 */
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      {/* 弹层默认贴着触发元素那么宽（一个图标按钮 ≈ 40px），这里改成按内容撑开。 */}
      <DropdownMenuContent align="end" style={{ width: 'auto', minWidth: '11rem' }}>
        <DropdownMenuRadioGroup
          value={preference}
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

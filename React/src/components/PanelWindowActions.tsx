/**
 * 内嵌窗顶栏那两颗窗口按钮：在浏览器里打开 / 关闭。
 *
 * 它们操作的是**外面那层窗**，不是页面里的内容，所以按钮画在页面里（跟语言、日夜、
 * 收件那一排放一起，风格统一），动作却交回父窗口执行 —— 外壳掌握 iframe 与弹窗的
 * 生命周期，页面自己既关不掉窗，也不该知道系统浏览器那条路怎么走。
 *
 * 只在被嵌（父窗口不是自己）时渲染：从浏览器直接打开这一页时没有"外面那层窗"，
 * 摆两颗点了没反应的按钮没有意义。消息只发给父窗口，且用固定类型，与已有的
 * `panel-state` / `panel-visibility` 同一套约定。
 */
import { Button } from '@appica/ui-react/button'

import { t } from '../lib/i18n/index.ts'

const MESSAGE_TYPE = 'dsh-mobile-plugin:panel-action'

/** 是不是被嵌在 DSH 那一窗里（顶层页面不是）。 */
function embedded(): boolean {
  return typeof window !== 'undefined' && window.parent !== window
}

/** 请父窗口做一件窗外的事：`open-browser` 或 `close`。 */
export function requestPanelAction(action: 'open-browser' | 'close'): void {
  if (!embedded()) return
  window.parent.postMessage({ type: MESSAGE_TYPE, action }, '*')
}

/** 方框加外指箭头：在浏览器里打开。 */
function BrowserIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13 5H5.8A1.8 1.8 0 0 0 4 6.8v11.4A1.8 1.8 0 0 0 5.8 20h11.4a1.8 1.8 0 0 0 1.8-1.8V11" />
      <path d="M14 4h6v6" />
      <path d="M20 4l-8.5 8.5" />
    </svg>
  )
}

/** 一个叉：关闭这一窗。 */
function CloseIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </svg>
  )
}

/** 顶栏那两颗按钮：单独成组，调用方挂在顶栏按钮区里。 */
export function PanelWindowActions() {
  if (!embedded()) return null
  return (
    <>
      <Button
        variant="ghost"
        size="icon-md"
        aria-label={t('panel.console.openBrowser')}
        title={t('panel.console.openBrowser')}
        onClick={() => requestPanelAction('open-browser')}
      >
        <BrowserIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-md"
        aria-label={t('panel.common.close')}
        title={t('panel.common.close')}
        onClick={() => requestPanelAction('close')}
      >
        <CloseIcon />
      </Button>
    </>
  )
}

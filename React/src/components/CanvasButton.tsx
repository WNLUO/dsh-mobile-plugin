/**
 * 面板右上角的「打开画布」入口。
 *
 * 桌面端画布由插件在 `/api/relay/canvas` 整页吐出来（与面板同源），点开即用；它的库与手机
 * 共用电脑上那一份（`mobile/canvas-store.js`），所以桌面和手机看到的是同一个画布库。
 *
 * 与语言 / 主题同一处落脚（`TopRightActions`），坐标别在这里再套 `fixed`。图标手画：库里
 * 没有图标集，`Button` 基类会补描边宽度，所以 `fill="none"`。
 */
import { Button } from '@appica/ui-react/button'

import { t } from '../lib/i18n/index.ts'

function CanvasIcon() {
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
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M9 21V9" />
    </svg>
  )
}

export function CanvasButton() {
  const label = t('panel.canvas.open')
  return (
    <Button
      variant="soft"
      size="icon-md"
      className="pointer-events-auto rounded-full shadow-sm"
      aria-label={label}
      title={label}
      onClick={() => window.open('/api/relay/canvas', '_blank', 'noopener')}
    >
      <CanvasIcon />
    </Button>
  )
}

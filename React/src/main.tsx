/**
 * 面板的正式入口：挂全局的胶囊提示，再把整页交给 `Shell`。主题跟着 DSH 父窗口走。
 *
 * 页面本体（引导页 / 主页二选一）与右上角那组按钮都在 `Shell` 里，所以这一屏与录屏用的
 * 那一份假宿主页面共用同一套外壳（见 A3-45）。
 */
// Android 内嵌页先隔离绘制层；React 启动失败时回传可见错误。
import { ToastProvider, Toaster } from '@appica/ui-react/toast'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { Shell } from './Shell.tsx'
import { errorText } from './lib/api.ts'
import { reportPanelState } from './lib/panel-load.ts'
import { prepareEmbeddedRendering } from './lib/embedded-rendering.ts'

prepareEmbeddedRendering()

// 面板所有地址都是控制台这一版（2026-11-15 收成一套，2026-11-17 删掉唯一的例外调试页）。
// 配色跟着 DSH 的同源父窗口走（见 `lib/shell-theme.ts`），不挂 ThemeProvider —— 它会自己往
// `<html>` 写 light/dark，跑在跟随 effect 之后，把「跟着父窗口」那套白写。这一窗也不摆日夜
// 按钮，不需要 Provider 管自己的主题。原先调试页是唯一例外，那页删了之后不再有分支。
function Page() {
  return (
    <>
      <Shell />
      <Toaster position="top-right" />
    </>
  )
}

// 结果提示一律走右上角的胶囊（见 `lib/notify.ts`）。`Toaster` 与页面本身都挂在
// `ToastProvider` 里面：`ToastProvider` 要在最外层，页面里任何地方才 useToastManager 得到。
// 页面本体（含右上角那组按钮）整个在 `Shell` 里：引导页与主页共用同一份外壳。
createRoot(document.getElementById('root')!, {
  onUncaughtError: (error) => reportPanelState('error', errorText(error)),
}).render(
  <StrictMode>
    <ToastProvider>
      <Page />
    </ToastProvider>
  </StrictMode>,
)

/**
 * 演示版的入口：与正式入口（`src/main.tsx`）逐行对应，唯一多出来的一件事是**先把假宿主装上**。
 *
 * 顺序不能反：`installDemoHost()` 必须在任何模块发出第一个请求之前跑完，所以它放在
 * 全部 import 之后的第一句（ESM 的 import 只做模块求值，真正的请求都发生在 React 挂载之后）。
 * 这一页只由开发服务器加载（`React/demo.html`），正式产物不含它。
 */
import { ToastProvider, Toaster } from '@appica/ui-react/toast'
import { ThemeProvider, getThemeScript } from '@appica/ui-react/providers/theme-provider'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { Console } from '../Console.tsx'
import { Onboarding } from '../Onboarding.tsx'
import { Shell } from '../Shell.tsx'
import { installDemoHost } from './host.ts'
import { StatusPreview } from './StatusPreview.tsx'

installDemoHost()

/**
 * 主题键与正式面板刻意分开：演示页与正式开发页在同一个来源下（`127.0.0.1:5273`），
 * 共用那个键的话，录屏时拧一下会把正在用的那一页的主题一起改掉。
 */
const THEME_KEY = 'dsh-mobile-demo-theme'

const bootTheme = document.createElement('script')
bootTheme.textContent = getThemeScript({ storageKey: THEME_KEY })
document.head.appendChild(bootTheme)

/**
 * `?scene=status` 是「这块怎么留」的对照稿（见 `StatusPreview.tsx`）：它不画引导页，
 * 只把同一块内容的几种留法并排摆出来，数据也是本地写死的，所以跟 `Shell` 二选一。
 *
 * `?scene=console` / `?scene=onboarding` 是给控制台那一窗看的对照：两者都**绕开 `/console`
 * 那条地址**（演示页的地址是 `/demo.html`，按后缀分不到控制台），直接把组件摆上来：
 *   - `onboarding`：新用户第一次装的样子（假宿主初始状态就是「还没配过」）；
 *   - `console`：配过之后点手机图标进来的样子，数据与真机同形（假宿主 `?scene=settings` 那份）。
 */
const scene = new URLSearchParams(window.location.search).get('scene')

function Scene() {
  if (scene === 'status') return <StatusPreview />
  if (scene === 'onboarding') return <Onboarding />
  if (scene === 'console') return <Console />
  return <Shell />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <ThemeProvider storageKey={THEME_KEY}>
        <Scene />
        <Toaster position="top-right" />
      </ThemeProvider>
    </ToastProvider>
  </StrictMode>,
)

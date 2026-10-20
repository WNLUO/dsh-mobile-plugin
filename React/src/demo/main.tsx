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
import { Root } from '../Root.tsx'
import { ThemeToggle } from '../components/ThemeToggle.tsx'
import { installDemoHost } from './host.ts'

installDemoHost()

/**
 * 主题键与正式面板刻意分开：演示页与正式开发页在同一个来源下（`127.0.0.1:5273`），
 * 共用那个键的话，录屏时拧一下会把正在用的那一页的主题一起改掉。
 */
const THEME_KEY = 'dsh-mobile-demo-theme'

const bootTheme = document.createElement('script')
bootTheme.textContent = getThemeScript({ storageKey: THEME_KEY })
document.head.appendChild(bootTheme)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <ThemeProvider storageKey={THEME_KEY}>
        <Root />
        <ThemeToggle />
        <Toaster position="top-right" />
      </ThemeProvider>
    </ToastProvider>
  </StrictMode>,
)

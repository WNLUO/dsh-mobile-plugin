/**
 * 面板的正式入口：起主题、挂全局的胶囊提示，再把整页交给 `Shell`。
 *
 * 页面本体（引导页 / 主页二选一）与右上角那组按钮都在 `Shell` 里，所以这一屏与录屏用的
 * 那一份假宿主页面共用同一套外壳（见 A3-45）。
 */
import { ToastProvider, Toaster } from '@appica/ui-react/toast'
import { ThemeProvider, getThemeScript } from '@appica/ui-react/providers/theme-provider'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { Shell } from './Shell.tsx'

/**
 * 面板的主题存在这个键里。
 *
 * 自己起一个、不用库的缺省键 `theme`：这一页与 DSH 网页版主界面**同源**（同一个
 * `127.0.0.1:<端口>`），共用那个键的话，面板上拧一下会把主界面的主题一起改掉，反过来也一样。
 * 面板的主题是面板自己的事。
 */
const THEME_KEY = 'dsh-mobile-panel-theme'

// 首屏的主题类得自己先挂上，不能等 React。
//
// `ThemeProvider` 在树里渲染的那个 `<script>` 是给 SSR 用的：它的文本经 `innerHTML`
// 落到 DOM 上，而浏览器**不执行**这样写入的内联脚本（节点在、内容对，就是没人跑）。
// 于是正式构建里首屏永远挂不上主题类，页面停在缺省的浅色皮肤上；开发时之所以看得到深色，
// 是 StrictMode 把 effect 跑了两遍、第二轮顺手补上的假象。这里用库自己的生成器造一个
// **真的会跑**的脚本（自己 createElement + 文本 + append），赶在 React 渲染之前挂上类；
// 之后切换由 ThemeProvider 接管（它换类时会先清掉 light/dark，跟我们挂的不冲突）。
const bootTheme = document.createElement('script')
bootTheme.textContent = getThemeScript({ storageKey: THEME_KEY })
document.head.appendChild(bootTheme)

// 结果提示一律走右上角的胶囊（见 `lib/notify.ts`）。`Toaster` 挂在 ThemeProvider 里面，
// 这样它拿得到主题 token；`ToastProvider` 要在最外层，页面里任何地方才 useToastManager 得到。
// 页面本身（含右上角那组按钮）整个在 `Shell` 里：引导页与主页共用同一份外壳。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <ThemeProvider storageKey={THEME_KEY}>
        <Shell />
        <Toaster position="top-right" />
      </ThemeProvider>
    </ToastProvider>
  </StrictMode>,
)

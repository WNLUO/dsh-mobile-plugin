import { ToastProvider, Toaster } from '@appica/ui-react/toast'
import { ThemeProvider } from '@appica/ui-react/providers/theme-provider'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { Root } from './Root.tsx'

// 结果提示一律走右上角的胶囊（见 `lib/notify.ts`）。`Toaster` 挂在 ThemeProvider 里面，
// 这样它拿得到主题 token；`ToastProvider` 要在最外层，页面里任何地方才 useToastManager 得到。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <ThemeProvider>
        <Root />
        <Toaster position="top-right" />
      </ThemeProvider>
    </ToastProvider>
  </StrictMode>,
)

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 开发时把 /api 转发给本机 DSH 网页端（控制面只认本机来源）。
// 真实端口由 dsh web 决定，默认 19387，可用 DSH_WEB_URL 覆盖。
const DSH_WEB_URL = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // 产物直接落到插件目录里，宿主按一条 HTML 路由吐出去，不需要静态资源目录
    outDir: '../lib/panel',
    emptyOutDir: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': { target: DSH_WEB_URL },
    },
  },
})

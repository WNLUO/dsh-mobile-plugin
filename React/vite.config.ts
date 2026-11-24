// 面板使用与移动 App 一致的低版本内核目标，现代样式在构建时转换；开发代理只连显式指定的宿主。
import cascadeLayers from '@csstools/postcss-cascade-layers'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * 开发代理只连**显式指定**的宿主：`DSH_WEB_URL` 一刀切；没设就用 `dsh web` 的默认 19387。
 *
 * 刻意**不再扫本机监听端口自动挑宿主**。桌面版 DSH 用的是系统随机端口，扫端口会把它误当成
 * 「本机 DSH 网页端」连上去——于是随手在开发页面上点几下（比如把引导走一遍），就把这台机器
 * 正在用的真实配置改掉了。前端只用来预览界面时不该有这条写穿通道：要看真实数据，用
 * `DSH_WEB_URL=http://127.0.0.1:<端口> pnpm dev` 明确点名；纯演示用 `pnpm demo`（假宿主，不连任何宿主）。
 */
function findHostUrl() {
  return process.env.DSH_WEB_URL || 'http://127.0.0.1:19387'
}

export async function createConfig() {
  const target = await findHostUrl()
  return {
    plugins: [react(), tailwindcss()],
    css: { postcss: { plugins: [cascadeLayers()] } },
    build: {
      target: ['ios15.1', 'chrome99'],
      cssTarget: ['ios15.1', 'chrome99'],
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
        '/api': { target },
      },
    },
  }
}

export default defineConfig(createConfig)

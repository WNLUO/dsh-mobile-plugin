/**
 * 演示页专用配置：在 `vite.config.ts` 之上**拆掉 `/api` 代理**。
 *
 * 为什么非要拆：开发配置里 `/api` 是指向本机 DSH 网页端的，而演示页的隔离靠覆写
 * `window.fetch`。两层叠加时，假宿主万一漏了一条路由，请求就会顺着代理打到**正在用的
 * 那台宿主**上——那正是这一页要防的事。代理一拆，即使真漏了，也只会在 5274 上拿到 404，
 * 连本机宿主都摸不到。
 *
 * 构建仍然只走 `vite.config.ts`（产物是 `lib/panel/index.html`），本文件只给 `pnpm demo` 用。
 */
import { defineConfig } from 'vite'

import base from './vite.config.ts'

export default defineConfig({
  ...base,
  server: {
    ...base.server,
    port: 5274,
    strictPort: true,
    proxy: {},
  },
})

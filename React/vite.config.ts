// 面板使用与移动 App 一致的低版本内核目标，现代样式在构建时转换；开发代理自己找宿主端口。
import { execFileSync } from 'node:child_process'
import cascadeLayers from '@csstools/postcss-cascade-layers'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * 开发时把 /api 转发给本机 DSH 宿主（控制面只认本机来源）。桌面版默认用系统分配的
 * 端口、每次启动都可能变，所以先认显式配置，再扫监听端口探状态接口自己找。
 */
async function findHostUrl() {
  const configured = process.env.DSH_WEB_URL
  if (configured) return configured

  const ports = new Set([3080, 19387])
  try {
    const raw = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    for (const line of raw.split('\n')) {
      const match = /:(\d+) \(LISTEN\)$/.exec(line.trim())
      if (!match) continue
      const port = Number(match[1])
      if (port > 1024 && port < 65536) ports.add(port)
    }
  } catch {
    // 没有 lsof 就只探默认端口。
  }

  for (const port of ports) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/relay/status`, {
        signal: AbortSignal.timeout(800),
      })
      if (!response.ok) continue
      const status: unknown = await response.json()
      // 只认本插件答的那一份：别的本地服务也可能 200 回一段 JSON。
      if (status && typeof status === 'object' && 'localPort' in status
        && typeof status.localPort === 'number') return `http://127.0.0.1:${port}`
    } catch {
      // 连不上就换下一个。
    }
  }
  // 宿主还没起来时留个默认值，页面照开，只是 /api 会失败。
  return 'http://127.0.0.1:19387'
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
